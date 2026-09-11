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
 * range. Taking the first page of the set every time fixed that but re-read
 * every finished row for each new page — quadratic, 35s a query on the 744K
 * vendor catalogue. Now the pending ids are read once. These tests pin the
 * walk, not the classifier (which has its own suite).
 */

const RULES = [
  { scheduleCode: 'H1', matchType: 'salt', matchValue: 'Tramadol', matchNorm: 'tramadol', aliases: [] },
];

/** The ids a query is restricted to, if it names any. */
function idsIn(where: any): Set<string> | null {
  const hit = [where, ...(where?.AND ?? [])].find((c) => c?.id?.in);
  return hit ? new Set(hit.id.in) : null;
}

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
    const only = idsIn(args?.where);
    if (only) pool = pool.filter((r) => only.has(r.id));
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

  it('reads the pending set once, then fetches it by id — never by cursor', async () => {
    const cat = fakeCatalog(4000);
    (prisma.drugMaster.findMany as any).mockImplementation(cat.findMany);
    (prisma.drugMaster.update as any).mockImplementation(cat.update);

    await runClassification(prisma, { only: 'master' });

    const calls = cat.findMany.mock.calls.map((c) => c[0]);
    // A cursor anchored in a set that is shrinking is what skipped rows before.
    for (const call of calls) {
      expect(call.cursor, 'a write pass must not paginate by cursor').toBeUndefined();
    }
    // Re-reading the shrinking set for every page is what made it quadratic:
    // one read of the set, then one fetch per 2,000 ids.
    expect(calls.filter((c) => !idsIn(c.where))).toHaveLength(1);
    expect(calls.filter((c) => idsIn(c.where))).toHaveLength(2);
  });

  it('finds a handful of pending rows without re-reading the table', async () => {
    // A settled catalogue with four rows left, as a monthly release leaves it.
    const cat = fakeCatalog(10_000);
    cat.rows.forEach((r, i) => {
      if (i % 3000 !== 7) r.classifierVersion = CLASSIFIER_VERSION;
    });
    (prisma.drugMaster.findMany as any).mockImplementation(cat.findMany);
    (prisma.drugMaster.update as any).mockImplementation(cat.update);

    const t = await runClassification(prisma, { only: 'master' });

    expect(t.masterScanned).toBe(4);
    expect(cat.classified()).toBe(10_000);
    expect(cat.findMany).toHaveBeenCalledTimes(2);
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

  it('finishes even when a row refuses to leave the set', async () => {
    // Such a row spun the old first-page walk forever — it needed a guard.
    // Read once, it is handled once.
    const stuck = [{ id: 'stuck-1', name: 'X', genericName: 'Tramadol (50mg)', saltComposition: null,
      dosageForm: 'tablet', scheduleResolved: null, controlledClass: null, vaultControlled: false,
      requiresQrScan: false, classifierVersion: null }];
    (prisma.drugMaster.findMany as any).mockResolvedValue(stuck);
    (prisma.drugMaster.update as any).mockResolvedValue(stuck[0]); // never clears the flag

    const t = await runClassification(prisma, { only: 'master' });
    expect(t.masterScanned).toBeGreaterThan(0);
  }, 10_000);
});

describe('the prescription label', () => {
  it('is read by the backfill, so an undecided prescription-only drug is not OTC', async () => {
    const row = {
      id: 'b1', name: 'Brivastar 50mg Tablet', genericName: 'Brivaracetam (50mg)',
      saltComposition: null, dosageForm: 'tablet', scheduleResolved: 'OTC',
      controlledClass: null, vaultControlled: false, requiresQrScan: false,
      classifierVersion: null, rxRequired: true, salts: [],
    };
    (prisma.drugMaster.findMany as any).mockResolvedValue([row]);
    (prisma.drugMaster.update as any).mockResolvedValue(row);

    await runClassification(prisma, { only: 'master' });

    const data = (prisma.drugMaster.update as any).mock.calls[0][0].data;
    expect(data.scheduleResolved).toBe('H');
    expect(data.scheduleReason).toMatch(/prescription only/i);
  });
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
