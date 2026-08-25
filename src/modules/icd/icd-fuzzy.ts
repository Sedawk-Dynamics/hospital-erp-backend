/**
 * Typo-tolerant candidate lookup for ICD search (Postgres `pg_trgm`).
 *
 * Everything else in the ICD search matches literally. Miss a letter and the
 * catalogue vanishes: "diabtes" contains-matches nothing, so the doctor sees
 * "No matching ICD codes" for a word they are one keystroke away from. That is
 * a worse failure than a bad ordering, because there is nothing on screen to
 * correct from.
 *
 * PURELY ADDITIVE, and only where the alternative is an empty screen. The
 * service fires this after the literal windows and the drop-a-word fallback
 * have both come back with nothing, and the ranker scores what comes back in a
 * tier below every literal match. A search that already works is untouched.
 *
 * WORD SIMILARITY, NOT SIMILARITY. This is the difference from
 * `shared/medicine-fuzzy.ts`, which matches on short name columns with `%`.
 * `search_tokens` here holds the code, the title, the curated keywords and
 * every WHO inclusion term — often a few hundred characters. `similarity()` is
 * Jaccard over the whole string, so it collapses as the target grows:
 * "diabtes" against E11.9's tokens scores about 0.05, far under any usable
 * threshold. `word_similarity()` (`<%`) scores the query against the best
 * continuous extent of words instead, which is the question actually being
 * asked — "does this row contain a word like the one I typed?"
 *
 * Fuzzy is a progressive enhancement. If `pg_trgm` cannot be enabled — the role
 * lacks CREATE EXTENSION, say — every function here degrades to returning
 * nothing and the literal search carries on exactly as before.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';

/**
 * Below this length a query is served fine by prefix matching, and fuzzy is
 * only noise — three letters are trigram-similar to a large part of any
 * catalogue. Kept in step with the fuzzy gate in `icd-search-rank.ts`.
 */
export const ICD_FUZZY_MIN_QUERY_LEN = 4;

/**
 * How close a word has to be to count.
 *
 * Postgres defaults `pg_trgm.word_similarity_threshold` to 0.6, and measured
 * against the real catalogue that is too strict to be useful: "diabtes" scores
 * 0.545 against E11.9, "asthama" 0.500, "anemia" 0.500 and "maleria" 0.455 —
 * every one of them missed. 0.45 admits all four. Going lower starts pulling in
 * words that merely share a stem, and the ranker cannot tell those apart.
 *
 * A literal, because a GUC cannot take a bind parameter. It is a constant in
 * this file and never user input.
 */
const WORD_SIMILARITY_THRESHOLD = 0.45;

// One-time setup, cached so it runs at most once per process. `IF NOT EXISTS`
// throughout, so calling it on every fuzzy search is free after the first.
let trgmReady: Promise<void> | null = null;
// Latched once the extension cannot be created, so we stop attempting DDL on
// every search and simply leave fuzzy off for the process.
let trgmDisabled = false;

export function ensureIcdTrgmReady(): Promise<void> {
  if (trgmDisabled) return Promise.reject(new Error('pg_trgm unavailable'));
  if (!trgmReady) {
    trgmReady = (async () => {
      await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const statements = [
        `CREATE INDEX IF NOT EXISTS idx_trgm_icd_codes_title ON icd_codes USING gin (lower(title) gin_trgm_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_trgm_icd_codes_tokens ON icd_codes USING gin (lower(coalesce(search_tokens, '')) gin_trgm_ops)`,
      ];
      for (const sql of statements) {
        try {
          await prisma.$executeRawUnsafe(sql);
        } catch (err) {
          // A missing index makes fuzzy slower, never wrong — carry on.
          console.warn('[icd-fuzzy] index setup skipped:', (err as Error).message);
        }
      }
    })().catch((err) => {
      trgmReady = null;
      trgmDisabled = true;
      console.warn('[icd-fuzzy] pg_trgm disabled:', (err as Error).message);
      throw err;
    });
  }
  return trgmReady;
}

/**
 * Ids of active codes visible to `tenantId` holding a word close to `query`,
 * closest first. Empty for a short query, or whenever fuzzy is unavailable.
 */
export async function fuzzyIcdMatchIds(opts: {
  query: string;
  tenantId: string;
  limit?: number;
}): Promise<string[]> {
  const q = (opts.query ?? '').trim().toLowerCase();
  if (q.length < ICD_FUZZY_MIN_QUERY_LEN) return [];

  try {
    await ensureIcdTrgmReady();

    // `<%` is what makes this fast: it reads the GIN trigram indexes, where
    // comparing word_similarity() directly is a sequential scan — measured at
    // 230-490ms against 3-27ms. But `<%` takes its threshold from a session
    // GUC, so the SET and the SELECT have to run on the SAME connection.
    // A `SET LOCAL` on its own would land on an arbitrary pooled connection and
    // silently do nothing (it is also a no-op outside a transaction), leaving
    // the strict 0.6 default in force. Hence the explicit transaction, which
    // also reverts the setting on commit so no other query inherits it.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL pg_trgm.word_similarity_threshold = ${WORD_SIMILARITY_THRESHOLD}`,
      );
      return tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM icd_codes
        WHERE is_active = true
          AND (tenant_id IS NULL OR tenant_id = ${opts.tenantId})
          AND (${q} <% lower(title) OR ${q} <% lower(coalesce(search_tokens, '')))
        ORDER BY GREATEST(
          word_similarity(${q}, lower(title)),
          word_similarity(${q}, lower(coalesce(search_tokens, '')))
        ) DESC
        LIMIT ${opts.limit ?? 40}
      `);
    });
    // The database picks the candidates; it does not decide the order. Ordering
    // by word_similarity over the whole token blob puts "Myasthenic syndromes in
    // endocrine diseases" above E11 for "diabtes", because the inclusion terms
    // mention diabetes. `icd-search-rank` re-scores these against the TITLE.
    return (rows ?? []).map((r) => r.id);
  } catch (err) {
    // Fuzzy must never break the literal search that already ran.
    console.warn('[icd-fuzzy] lookup skipped:', (err as Error).message);
    return [];
  }
}
