/**
 * Turn every catalog composition into structured DrugSalt rows.
 *
 * This is where the parsing goes. Text is read ONCE here, at ingestion, and the
 * result is stored as data — a salt row, a numeric strength, a unit. Nothing
 * downstream re-parses it, which is what makes the whole rebuild worthwhile:
 * the classifier's job becomes a join, and the strengths can no longer be
 * destroyed by a lossy round-trip through a text column.
 *
 * Idempotent. A drug that already has its salts is skipped, so a re-run costs
 * one count per chunk. `force` re-syncs a drug whose composition has changed by
 * replacing its rows.
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';
import { parseSalts, saltLookupKeys } from '../modules/drug-master/drug-schedule.classifier';

const CHUNK = 2000;

export interface DrugSaltTotals {
  scanned: number;
  drugsLinked: number;
  rowsWritten: number;
  unresolved: number;
  unresolvedNames: string[];
}

/**
 * Every spelling that resolves to a salt row: the canonical norm, plus every
 * synonym. Small enough (about 2,000 keys) to hold in memory for the whole run.
 */
async function buildSaltIndex(prisma: PrismaClient): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const salts = await prisma.salt.findMany({ select: { id: true, norm: true } });
  for (const s of salts) index.set(s.norm, s.id);
  const syns = await prisma.saltSynonym.findMany({ select: { saltId: true, norm: true } });
  // Canonical norms win: a synonym must never shadow a molecule's own row.
  for (const s of syns) if (!index.has(s.norm)) index.set(s.norm, s.saltId);
  return index;
}

/** Resolve one parsed molecule to a salt id, allowing the base-molecule fallback. */
function resolve(norm: string, index: Map<string, string>): string | null {
  for (const key of saltLookupKeys(norm)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

export async function runDrugSaltSync(
  prisma: PrismaClient,
  opts: { force?: boolean; onProgress?: (done: number) => void } = {},
): Promise<DrugSaltTotals> {
  const totals: DrugSaltTotals = {
    scanned: 0, drugsLinked: 0, rowsWritten: 0, unresolved: 0, unresolvedNames: [],
  };

  const index = await buildSaltIndex(prisma);
  if (!index.size) {
    logger.warn('DrugSalt sync skipped — the salt master is empty');
    return totals;
  }

  const unresolved = new Map<string, number>();
  let cursor: string | null = null;

  for (;;) {
    // Walk the WHOLE table by cursor and filter in memory, rather than querying
    // "drugs with no salts" and paginating that. The full table does not shrink
    // as we write; that filtered set does, and paginating a set you are
    // consuming is what silently skipped 126 rows in the classification
    // backfill — the cursor row leaves the set and can no longer anchor the
    // next page.
    const drugs: {
      id: string;
      saltComposition: string | null;
      genericName: string | null;
    }[] = await prisma.drugMaster.findMany({
      select: { id: true, saltComposition: true, genericName: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: CHUNK,
    });
    if (!drugs.length) break;
    cursor = drugs[drugs.length - 1].id;

    // Skip drugs already linked, unless we are deliberately re-syncing.
    let todo = drugs;
    if (!opts.force) {
      const already = await prisma.drugSalt.findMany({
        where: { drugMasterId: { in: drugs.map((d) => d.id) } },
        select: { drugMasterId: true },
        distinct: ['drugMasterId'],
      });
      const done = new Set(already.map((a) => a.drugMasterId));
      todo = drugs.filter((d) => !done.has(d.id));
    }

    const rows: {
      drugMasterId: string;
      saltId: string;
      strengthValue: number | null;
      strengthUnit: string | null;
      perVolumeValue: number | null;
      perVolumeUnit: string | null;
      position: number;
    }[] = [];
    const touched: string[] = [];

    for (const drug of todo) {
      totals.scanned += 1;
      const parsed = parseSalts(drug.saltComposition || drug.genericName || '');
      if (!parsed.length) continue;

      const seen = new Set<string>();
      let position = 0;
      let linked = false;
      for (const salt of parsed) {
        const saltId = resolve(salt.norm, index);
        if (!saltId) {
          unresolved.set(salt.raw, (unresolved.get(salt.raw) ?? 0) + 1);
          totals.unresolved += 1;
          continue;
        }
        // The same molecule twice in one product (it happens in the data) would
        // violate the unique key, so the first occurrence wins.
        if (seen.has(saltId)) continue;
        seen.add(saltId);
        rows.push({
          drugMasterId: drug.id,
          saltId,
          strengthValue: salt.strengthValue,
          strengthUnit: salt.strengthUnit,
          perVolumeValue: salt.perVolumeMl,
          perVolumeUnit: salt.perVolumeMl ? 'ml' : null,
          position,
        });
        position += 1;
        linked = true;
      }
      if (linked) {
        touched.push(drug.id);
        totals.drugsLinked += 1;
      }
    }

    if (rows.length) {
      if (opts.force && touched.length) {
        await prisma.drugSalt.deleteMany({ where: { drugMasterId: { in: touched } } });
      }
      const written = await prisma.drugSalt.createMany({ data: rows as never, skipDuplicates: true });
      totals.rowsWritten += written.count;
    }

    opts.onProgress?.(totals.scanned);
    if (drugs.length < CHUNK) break;
  }

  totals.unresolvedNames = [...unresolved.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name, n]) => `${name} (${n})`);

  logger.info(
    { ...totals, unresolvedNames: totals.unresolvedNames.slice(0, 8) },
    'Drug compositions linked to the salt master',
  );
  return totals;
}

/** Auto-seed entry point. */
export async function seedDrugSalts(prisma: PrismaClient): Promise<void> {
  await runDrugSaltSync(prisma);
}
