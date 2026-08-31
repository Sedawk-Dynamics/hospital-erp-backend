import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';

/**
 * Typo-tolerant lookup for the disorder picker.
 *
 * The literal windows match letter for letter, so "asthama" — a common
 * misspelling — returned nothing at all from a 7,200-row list. An empty picker
 * is the worst failure here, because there is nothing on screen to correct
 * from.
 *
 * The same shape as `icd-fuzzy.ts`, and the same two reasons for it:
 * `word_similarity` rather than `similarity`, because `search_tokens` holds the
 * name plus every inherited ICD keyword and Jaccard over the whole string
 * collapses as the target grows; and the threshold set inside an explicit
 * transaction, because `<%` reads it from a session GUC and a bare `SET LOCAL`
 * would land on an arbitrary pooled connection and silently do nothing.
 */

const WORD_SIMILARITY_THRESHOLD = 0.45;
const MIN_QUERY_LEN = 4;

let ready: Promise<void> | null = null;
let disabled = false;

export function ensureDisorderTrgmReady(): Promise<void> {
  if (disabled) return Promise.reject(new Error('pg_trgm unavailable'));
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      // `search_tokens` is written lowercase, so the raw-column index that
      // `search-indexes.ts` builds already serves it; only `name` is mixed case
      // and needs a lowercased one of its own.
      try {
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS idx_trgm_disorders_name ON disorders USING gin (lower(name) gin_trgm_ops)`,
        );
      } catch (err) {
        console.warn('[disorder-fuzzy] index setup skipped:', (err as Error).message);
      }
    })().catch((err) => {
      ready = null;
      disabled = true;
      console.warn('[disorder-fuzzy] pg_trgm disabled:', (err as Error).message);
      throw err;
    });
  }
  return ready;
}

export async function fuzzyDisorderMatchIds(opts: {
  query: string;
  tenantId: string;
  limit?: number;
}): Promise<string[]> {
  const q = (opts.query ?? '').trim().toLowerCase();
  if (q.length < MIN_QUERY_LEN) return [];

  try {
    await ensureDisorderTrgmReady();
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL pg_trgm.word_similarity_threshold = ${WORD_SIMILARITY_THRESHOLD}`,
      );
      return tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM disorders
        WHERE is_active = true
          AND (tenant_id IS NULL OR tenant_id = ${opts.tenantId})
          AND (${q} <% lower(name) OR ${q} <% search_tokens)
        ORDER BY GREATEST(
          word_similarity(${q}, lower(name)),
          word_similarity(${q}, coalesce(search_tokens, ''))
        ) DESC
        LIMIT ${opts.limit ?? 40}
      `);
    });
    return (rows ?? []).map((r) => r.id);
  } catch (err) {
    // Fuzzy must never break the literal search that already ran.
    console.warn('[disorder-fuzzy] lookup skipped:', (err as Error).message);
    return [];
  }
}
