/**
 * Trigram indexes for the ordinary "contains" searches — the ones a person
 * types into a picker.
 *
 * WHY THIS IS SEPARATE FROM THE FUZZY INDEXES, which is the whole point of the
 * file. Prisma's `{ contains: q, mode: 'insensitive' }` emits
 *
 *     name ILIKE '%dolo%'
 *
 * while the fuzzy lookups in `medicine-fuzzy.ts` and `icd-fuzzy.ts` write their
 * own SQL against `lower(name)`. A `gin (lower(name) gin_trgm_ops)` index only
 * matches a query containing that exact expression, so it cannot serve the
 * ILIKE — Postgres does not rewrite one into the other. Measured on
 * drug_master, 253,987 rows:
 *
 *     lower(name) LIKE '%dolo%'   Bitmap Heap Scan     cost  6,713
 *     name ILIKE '%dolo%'         Parallel Seq Scan    cost 44,296
 *
 * So the everyday medicine search — not the typo fallback, the main one — was
 * scanning the whole catalogue on every query. It looked fine for a common term
 * because LIMIT 50 fills early and the scan stops; a term with FEW matches has
 * to read everything, which is exactly what a pharmacist types when hunting an
 * unusual drug. Measured, name only: "zolmitript" 352ms, "qqzz" 277ms,
 * "vortioxet" 264ms — against 1-3ms once indexed.
 *
 * The same trap is why two hand-made `lower(first_name)` indexes sat on a dev
 * database doing nothing at all: no query could ever use them.
 *
 * These index the RAW column, which is what pg_trgm needs to accelerate
 * `LIKE`/`ILIKE`. Both flavours have to exist — the `lower(...)` ones for
 * similarity matching, these for `contains`.
 *
 * WHAT IS AND IS NOT INDEXED. Only tables that grow and are searched by a
 * person typing free text. Most `contains` sites in the codebase are already
 * narrowed by tenant and date to a small set first, or search short identifiers
 * (bill number, MRN) where a prefix index serves better; a trigram index there
 * costs write throughput and returns nothing.
 */

import { prisma } from '../config/database';
import { logger } from '../config/logger';

/**
 * table → columns searched with `contains`.
 *
 * Costs measured on a real catalogue, one-off per database:
 *   drug_master        26s + 25s + 62s, 71 + 36 + 119 MB — the one that matters.
 *                      (744K vendor products, built CONCURRENTLY under write
 *                      load; a rare-term search went 1.1s → 3.6ms)
 *   icd_codes          ~1.3s, 3.9 MB        — 12k rows; 11→4ms, 20→7ms
 *   drug_formulary     ~35ms, 208 kB        — per tenant, grows
 *   inventory_items    ~5ms, 16 kB          — per tenant, grows
 *   patients           ~16ms, 32 kB         — tiny now, the fastest-growing
 *                                             table in any hospital, and
 *                                             searched at every front desk
 *   disorders          small                 — the existing-disorder picker
 */
const SEARCH_COLUMNS: Record<string, string[]> = {
  // search_tokens is what the catalogue's multi-word search ANDs over ("para
  // 500" → every term must appear). Unindexed it was a sequential scan on every
  // search — tolerable at a quarter of a million rows, ~1.1s at the vendor
  // catalogue's 744K, and the search waits for its slowest query.
  drug_master: ['name', 'generic_name', 'search_tokens'],
  drug_formulary: ['drug_name', 'generic_name'],
  inventory_items: ['item_name'],
  patients: ['first_name', 'last_name'],
  // `code` is here so the ICD search's `code OR title OR search_tokens` can
  // become a single bitmap OR. One un-indexed branch sends the whole thing back
  // to a sequential scan, so leaving it out would waste the other two.
  icd_codes: ['title', 'search_tokens', 'code'],
  // The disorder pick-list a patient and a clinician both search, ~7,200 rows.
  disorders: ['name', 'search_tokens'],
};

/** Deterministic, and short enough for Postgres's 63-character identifier cap. */
function indexName(table: string, column: string): string {
  return `idx_trgm_ilike_${table}_${column}`;
}

/**
 * Create the extension and every `contains` index. Idempotent — `IF NOT EXISTS`
 * throughout, so re-running on a provisioned database costs one catalogue
 * lookup per index.
 *
 * Throws only if the extension itself cannot be created, which is the failure
 * worth surfacing: on a managed Postgres the application role is often refused
 * CREATE EXTENSION, and auto-seed reports that as a failed step rather than
 * letting every search quietly stay slow.
 */
export async function ensureSearchIndexes(): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  for (const [table, columns] of Object.entries(SEARCH_COLUMNS)) {
    for (const column of columns) {
      const name = indexName(table, column);
      try {
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING gin (${column} gin_trgm_ops)`,
        );
      } catch (err) {
        // A missing index only makes that one search slow, never wrong.
        logger.warn(`[search-indexes] ${name} skipped: ${(err as Error).message}`);
      }
    }
  }
}
