/**
 * Fuzzy (typo-tolerant) candidate lookup for medicine / drug / inventory search.
 *
 * The existing search everywhere fetches EXACT / PREFIX / SUBSTRING candidates
 * with `ILIKE '%q%'` and re-ranks them in JS (see `medicine-search-rank.ts`).
 * That never surfaces a misspelling: typing "parcetamol" contains-matches
 * nothing, so "Paracetamol" is invisible.
 *
 * This module is a PURELY ADDITIVE layer: given a search term it returns the ids
 * of rows whose name/generic are trigram-similar to the query (Postgres
 * `pg_trgm`). Callers fetch those rows with their normal Prisma select and merge
 * them into the candidate pool AFTER the strict matches, so:
 *   - exact / prefix / substring results are unchanged and still rank first, and
 *   - fuzzy near-misses only fill the remaining slots (the JS ranker scores them
 *     in a tier below every real substring match — see `medicineSearchScore`).
 *
 * Fuzzy is a progressive enhancement — if `pg_trgm` can't be enabled (e.g. the
 * DB role lacks CREATE EXTENSION) every function here degrades to a no-op and
 * the old search keeps working exactly as before.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Below this length a query is handled fine by prefix/substring and fuzzy is
 * just noise ("ca" is trigram-similar to half the catalog). Kept in sync with
 * the fuzzy tier gate in `medicine-search-rank.ts`.
 */
export const FUZZY_MIN_QUERY_LEN = 4;

/** Tables we fuzzy-search, with their name/generic columns (snake_case, as mapped by Prisma). */
type FuzzyTable = 'drug_master' | 'drug_formulary' | 'inventory_items';
const NAME_COL: Record<FuzzyTable, string> = {
  drug_master: 'name',
  drug_formulary: 'drug_name',
  inventory_items: 'item_name',
};
const GENERIC_COL: Partial<Record<FuzzyTable, string>> = {
  drug_master: 'generic_name',
  drug_formulary: 'generic_name',
};

// One-time setup: enable pg_trgm and create the GIN trigram indexes the fuzzy
// queries ride on. Cached so it runs at most once per process; `IF NOT EXISTS`
// keeps it idempotent and safe to call on every fuzzy search.
//
// Normally this has already happened: auto-seed calls it as the `medicine-trgm`
// step, last in the pipeline so the drug_master indexes are built AFTER the
// quarter-million-row import rather than during it, and so a CREATE EXTENSION
// the database role is not allowed shows up in the deploy log instead of
// silently switching typo tolerance off. The call below stays as the fallback
// for when auto-seed is disabled.
let trgmReady: Promise<void> | null = null;
// Latched once CREATE EXTENSION fails (e.g. the DB role lacks the privilege) so
// we don't attempt DDL on every subsequent search — fuzzy simply stays off.
let trgmDisabled = false;

export function ensureTrgmReady(): Promise<void> {
  if (trgmDisabled) return Promise.reject(new Error('pg_trgm unavailable'));
  if (!trgmReady) {
    trgmReady = (async () => {
      await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const statements = [
        `CREATE INDEX IF NOT EXISTS idx_trgm_drug_master_name ON drug_master USING gin (lower(name) gin_trgm_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_trgm_drug_master_generic ON drug_master USING gin (lower(coalesce(generic_name, '')) gin_trgm_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_trgm_drug_formulary_name ON drug_formulary USING gin (lower(drug_name) gin_trgm_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_trgm_drug_formulary_generic ON drug_formulary USING gin (lower(coalesce(generic_name, '')) gin_trgm_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_trgm_inventory_items_name ON inventory_items USING gin (lower(item_name) gin_trgm_ops)`,
      ];
      for (const sql of statements) {
        try {
          await prisma.$executeRawUnsafe(sql);
        } catch (err) {
          // A missing index only makes fuzzy slower, never wrong — keep going.
          console.warn('[medicine-fuzzy] index setup skipped:', (err as Error).message);
        }
      }
    })().catch((err) => {
      // Can't enable the extension → give up on fuzzy for this process rather
      // than retry DDL on every search. Strict search keeps working regardless.
      trgmReady = null;
      trgmDisabled = true;
      console.warn('[medicine-fuzzy] pg_trgm disabled:', (err as Error).message);
      throw err;
    });
  }
  return trgmReady;
}

/**
 * Return the ids of rows in `table` whose name (or generic name) are trigram-
 * similar to `query`, best match first. Empty for short queries or when fuzzy
 * is unavailable.
 *
 * @param where  Optional extra predicate ANDed into the lookup (e.g. tenant /
 *               published filters). Use bound params — it is spliced as SQL.
 */
export async function fuzzyMatchIds(opts: {
  table: FuzzyTable;
  query: string;
  where?: Prisma.Sql;
  limit?: number;
}): Promise<string[]> {
  const q = (opts.query ?? '').trim().toLowerCase();
  if (q.length < FUZZY_MIN_QUERY_LEN) return [];

  try {
    await ensureTrgmReady();

    const nameCol = NAME_COL[opts.table];
    const genCol = GENERIC_COL[opts.table];
    // Column / table names are fixed constants here (never user input), so
    // Prisma.raw is safe; the query term stays a bound parameter.
    const nameExpr = Prisma.raw(`lower(${nameCol})`);
    const genExpr = genCol ? Prisma.raw(`lower(coalesce(${genCol}, ''))`) : null;
    const tableSql = Prisma.raw(opts.table);

    const matchExpr = genExpr
      ? Prisma.sql`(${nameExpr} % ${q} OR ${genExpr} % ${q})`
      : Prisma.sql`(${nameExpr} % ${q})`;
    const simExpr = genExpr
      ? Prisma.sql`GREATEST(similarity(${nameExpr}, ${q}), similarity(${genExpr}, ${q}))`
      : Prisma.sql`similarity(${nameExpr}, ${q})`;
    const extra = opts.where ? Prisma.sql`AND (${opts.where})` : Prisma.empty;

    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM ${tableSql}
      WHERE ${matchExpr} ${extra}
      ORDER BY ${simExpr} DESC
      LIMIT ${opts.limit ?? 40}
    `);
    return rows.map((r) => r.id);
  } catch (err) {
    // Never let fuzzy break the primary (strict) search.
    console.warn('[medicine-fuzzy] fuzzy lookup skipped:', (err as Error).message);
    return [];
  }
}
