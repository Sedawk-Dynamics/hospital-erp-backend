import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import {
  runClassification,
  pendingClassificationCount,
} from '../../../src/seeds/drug-schedule-classification';
import { CLASSIFIER_VERSION } from '../../../src/modules/drug-master/drug-schedule.classifier';

/**
 * The classification backfill runs unattended on every deploy, so the property
 * that matters most is that it FINISHES — that no drug is quietly left behind.
 *
 * It used to walk the work with cursor pagination over `classifierVersion !=
 * current`, which is wrong in a way that produces no error: each page's cursor
 * row is classified before the next page is fetched, so it no longer matches
 * the filter and cannot anchor the next window. On the real catalog that left
 * 126 of 253,987 rows unclassified on every run, scattered across the whole id
 * range. These tests pin the walk, not the classifier (which has its own suite).
 */

const RULES = [
  { scheduleCode: 'H1', matchType: 'salt', matchValue: 'Tramadol', matchNorm: 'tramadol', aliases: [] },
];

/** A fake table whose rows leave the filtered set as they are classified. */
function fakeCatalog(size: number) {
  const rows = Array.from({ length: size }, (_, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    name: `Drug ${i}`,
    genericName: 'Tramadol (50mg)',
    saltComposition: null,
    dosageForm: 'tablet',
    scheduleResolved: null,
    controlledClass: null,
    vaultControlled: false,
    requiresQrScan: false,
    classifierVersion: null as number | null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const findMany = vi.fn(async (args: any) => {
    let pool = rows.filter((r) => r.classifierVersion !== CLASSIFIER_VERSION);
    if (args?.cursor?.id) {
      // Prisma anchors on the cursor row WITHIN the filtered set. Once that row
      // has been classified it is not in the pool, and the page silently starts
      // from nowhere — this models exactly that.
      const at = pool.findIndex((r) => r.id === args.cursor.id);
      pool = at === -1 ? [] : pool.slice(at + (args.skip ?? 0));
    }
    return pool.slice(0, args.take ?? pool.length);
  });
  const update = vi.fn(async ({ where, data }: any) => {
    const row = byId.get(where.id);
    if (row) Object.assign(row, data);
    return row;
  });
  return {
    rows,
    findMany,
    update,
    classified: () => rows.filter((r) => r.classifierVersion === CLASSIFIER_VERSION).length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.drugScheduleRule.findMany as any).mockResolvedValue(RULES);
  (prisma.drugFormulary.findMany as any).mockResolvedValue([]);
  (prisma.drugFormulary.count as any).mockResolvedValue(0);
});

describe('the backfill finishes', () => {
  it('classifies EVERY row, over many pages, leaving none behind', async () => {
    // 5 full pages plus a partial one — the shape that exposed the bug.
    const cat = fakeCatalog(5 * 2000 + 137);
    (prisma.drugMaster.findMany as any).mockImplementation(cat.findMany);
    (prisma.drugMaster.update as any).mockImplementation(cat.update);

    const t = await runClassification(prisma, { only: 'master' });

    expect(t.masterScanned).toBe(cat.rows.length);
    expect(cat.classified()).toBe(cat.rows.length);
  });

  it('does not use a cursor while the filter is being consumed', async () => {
    const cat = fakeCatalog(4000);
    (prisma.drugMaster.findMany as any).mockImplementation(cat.findMany);
    (prisma.drugMaster.update as any).mockImplementation(cat.update);

    await runClassification(prisma, { only: 'master' });

    // Every page must be the FIRST page of the shrinking set. A cursor here is
    // what skipped rows before.
    for (const call of cat.findMany.mock.calls) {
      expect(call[0].cursor, 'a write pass must not paginate by cursor').toBeUndefined();
    }
  });

  it('DOES use a cursor for a dry run, where nothing leaves the set', async () => {
    // Without a cursor a dry run would re-fetch the same first page forever.
    const cat = fakeCatalog(4000);
    (prisma.drugMaster.findMany as any).mockImplementation(cat.findMany);
    (prisma.drugMaster.update as any).mockImplementation(cat.update);

    const t = await runClassification(prisma, { only: 'master', dryRun: true });

    expect(t.masterScanned).toBe(4000);
    expect(cat.classified()).toBe(0);
    expect(cat.findMany.mock.calls.some((c) => c[0].cursor)).toBe(true);
  });

  it('stops instead of spinning when a page refuses to progress', async () => {
    // A row that never leaves the set would loop forever without the guard.
    const stuck = [{ id: 'stuck-1', name: 'X', genericName: 'Tramadol (50mg)', saltComposition: null,
      dosageForm: 'tablet', scheduleResolved: null, controlledClass: null, vaultControlled: false,
      requiresQrScan: false, classifierVersion: null }];
    (prisma.drugMaster.findMany as any).mockResolvedValue(stuck);
    (prisma.drugMaster.update as any).mockResolvedValue(stuck[0]); // never clears the flag

    const t = await runClassification(prisma, { only: 'master' });
    expect(t.masterScanned).toBeGreaterThan(0);
  }, 10_000);
});

describe('composition repair', () => {
  /**
   * An earlier version wrote the composition column without the strengths, and
   * the classifier reads that column in preference to the generic name — so the
   * strengths were invisible from then on. Repairing them has to survive the
   * `unchanged` early-return, or it is unreachable the moment the schedule
   * fields already agree, which on a re-run is every row.
   */
  const row = {
    id: 'm1', name: 'Xibmax 90 Tablet', genericName: 'Etoricoxib (90mg)',
    saltComposition: 'Etoricoxib', dosageForm: 'tablet',
    scheduleResolved: 'H', controlledClass: null, vaultControlled: false,
    requiresQrScan: false, classifierVersion: CLASSIFIER_VERSION,
  };

  beforeEach(() => {
    (prisma.drugScheduleRule.findMany as any).mockResolvedValue([
      { scheduleCode: 'H', matchType: 'salt', matchValue: 'Etoricoxib', matchNorm: 'etoricoxib', aliases: [] },
    ]);
  });

  it('rewrites a stripped composition even when the schedule has not changed', async () => {
    let served = false;
    (prisma.drugMaster.findMany as any).mockImplementation(async () => {
      if (served) return [];
      served = true;
      return [{ ...row }];
    });
    (prisma.drugMaster.update as any).mockResolvedValue(row);

    await runClassification(prisma, { only: 'master', force: true });

    const calls = (prisma.drugMaster.update as any).mock.calls;
    expect(calls.length, 'the row must not be skipped as unchanged').toBe(1);
    expect(calls[0][0].data.saltComposition).toBe('Etoricoxib (90mg)');
  });

  it('leaves a composition that already carries strengths alone', async () => {
    let served = false;
    (prisma.drugMaster.findMany as any).mockImplementation(async () => {
      if (served) return [];
      served = true;
      return [{ ...row, saltComposition: 'Etoricoxib (90mg)' }];
    });
    (prisma.drugMaster.update as any).mockResolvedValue(row);

    await runClassification(prisma, { only: 'master', force: true });
    expect((prisma.drugMaster.update as any).mock.calls.length).toBe(0);
  });
});

describe('pendingClassificationCount', () => {
  it('counts unclassified rows on both tables', async () => {
    (prisma.drugMaster.count as any).mockResolvedValue(7);
    (prisma.drugFormulary.count as any).mockResolvedValue(3);
    expect(await pendingClassificationCount(prisma)).toBe(10);
  });

  it('never counts a schedule a pharmacist set by hand', async () => {
    (prisma.drugMaster.count as any).mockResolvedValue(0);
    (prisma.drugFormulary.count as any).mockResolvedValue(0);
    await pendingClassificationCount(prisma);
    const where = (prisma.drugFormulary.count as any).mock.calls[0][0].where;
    // Spelled as an explicit OR — `not: 'manual'` alone drops NULL rows in SQL,
    // which are precisely the ones that still need classifying.
    expect(JSON.stringify(where)).toContain('scheduleSource');
    expect(JSON.stringify(where)).toContain('null');
  });
});
