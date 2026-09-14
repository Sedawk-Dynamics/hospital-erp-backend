/**
 * Classify every drug's schedule from its composition.
 *
 * This is the step that makes the schedule reference visible: without it every
 * drug carries a NULL schedule, so no badge renders, the controlled register is
 * empty and the dispensing gate has nothing to act on. The rules themselves are
 * seeded separately (drug-schedule-rules) — this applies them.
 *
 * Runs on boot as part of the auto-seed pipeline, which is invoked AFTER the
 * server is already listening and is not awaited, so a long first pass never
 * blocks startup or a container health check.
 *
 * Safe to run on every boot:
 *  - a cheap count decides whether there is anything to do at all, so a
 *    steady-state boot costs one query and returns
 *  - rows already classified at the current classifier version are skipped
 *  - a schedule a pharmacist set by hand (scheduleSource 'manual') is never
 *    overwritten
 *  - drug_master.schedule — the legacy column the old compliance check read —
 *    is deliberately left alone, so classifying can never switch enforcement on
 *    by itself
 *
 * The operator-facing CLI (prisma/scripts/classify-drug-schedules.ts) calls the
 * same function with --dry-run / --force / reporting, so there is one
 * implementation rather than two that can drift.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import {
  buildRuleIndex,
  classify,
  parseSalts,
  formatSalt,
  normaliseBrand,
  CLASSIFIER_VERSION,
  type RuleIndex,
  type ScheduleRuleLike,
  type ClassificationResult,
} from '../modules/drug-master/drug-schedule.classifier';
import { classifyFromSalts, type SaltRow } from '../modules/drug-master/salt-classifier';

const CHUNK = 2000;

export interface ClassificationOptions {
  /** Report what would change without writing. */
  dryRun?: boolean;
  /** Re-do rows already classified at the current version. */
  force?: boolean;
  /** Restrict the formulary pass to one hospital. */
  tenantId?: string;
  /** 'master' | 'formulary' — default is both. */
  only?: 'master' | 'formulary';
  /** Per-row callback, used by the CLI to build its distribution report. */
  onRow?: (r: ClassificationResult, label: string, table: 'master' | 'formulary') => void;
  log?: (msg: string) => void;
}

export interface ClassificationTotals {
  masterScanned: number;
  masterChanged: number;
  formularyScanned: number;
  formularyChanged: number;
}

/** The cleaned "Salt (strength) + Salt (strength)" string, or null. */
function compositionFrom(generic: string | null | undefined): string | null {
  if (!generic) return null;
  const salts = parseSalts(generic);
  return salts.length ? salts.map(formatSalt).join(' + ') : null;
}

/**
 * Should the composition column be written?
 *
 * Blank is the obvious case. The second case is a repair: earlier versions
 * wrote the molecule names without their strengths, and since the classifier
 * reads this column in preference to the generic name, those rows lost the only
 * data the codeine exemption needs. Where the new value carries a strength and
 * the stored one does not, the stored one is replaced. A value that already has
 * strengths is never touched.
 */
function shouldWriteComposition(stored: string | null, derived: string | null): boolean {
  if (!derived) return false;
  if (!stored) return true;
  return derived.includes('(') && !stored.includes('(');
}

/** Has anything the classifier owns actually changed on this row? */
function unchanged(
  row: Record<string, unknown>,
  r: ClassificationResult,
  scheduleField: 'schedule' | 'scheduleResolved',
): boolean {
  return (
    row[scheduleField] === r.schedule &&
    ((row.controlledClass as string | null) ?? null) === (r.controlledClass ?? null) &&
    Boolean(row.vaultControlled) === r.vaultControlled &&
    Boolean(row.requiresQrScan) === r.requiresQrScan &&
    row.classifierVersion === CLASSIFIER_VERSION
  );
}


/**
 * Walk a set of rows that SHRINKS as we write to it.
 *
 * Paginating the filtered set itself goes wrong both ways it can be done. By
 * cursor, silently: each page's cursor row is classified before the next page
 * is fetched, so it no longer matches the filter and cannot anchor the next
 * window — that quietly left 126 of 253,987 catalog rows behind on every run.
 * By always taking the FIRST page, slowly: every row already done still sits in
 * front of the next page in id order, so each query walks past all of them
 * again, and the pass turns quadratic. Measured on the 744K vendor catalogue,
 * one page query with nothing left to find walked every row — 35s — and a
 * page near the end of a pass walks nearly as far.
 *
 * So the ids are read ONCE, up front, and handled a chunk at a time by primary
 * key. Each chunk re-applies the filter, so a row another writer settled in the
 * meantime is skipped; one that became pending meanwhile waits for the next run.
 *
 * With `force` or a dry run nothing leaves the set, so a cursor is the correct
 * tool there — the only one a dry run has, since it writes nothing.
 */
async function forEachPending<T extends { id: string }>(walk: {
  /** Every pending id, read once. */
  readIds: () => Promise<string[]>;
  /** The rows for a chunk of those ids, filter re-applied. */
  fetchIds: (ids: string[]) => Promise<T[]>;
  /** The page after `cursor`, for a set that does not shrink. */
  fetchAfter: (cursor?: string) => Promise<T[]>;
  useCursor: boolean;
  handle: (row: T) => Promise<void>;
  // Runs after each page, before the next fetch: the page's writes are
  // committed together (see writeQueue).
  afterPage?: () => Promise<void>;
}): Promise<void> {
  const { handle, afterPage } = walk;
  if (walk.useCursor) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await walk.fetchAfter(cursor);
      if (!rows.length) return;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) await handle(row);
      if (afterPage) await afterPage();
    }
  }

  const ids = await walk.readIds();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await walk.fetchIds(ids.slice(i, i + CHUNK));
    for (const row of rows) await handle(row);
    if (afterPage) await afterPage();
  }
}

/**
 * One commit per page instead of one per row. The statements are exactly the
 * ones the per-row version ran; only the commits are batched, and every commit
 * waits for the WAL to be flushed — cheap on a local disk, not on the network
 * storage of a managed database, where a vendor release means classifying
 * three-quarters of a million rows in one pass. Prisma queries are lazy until
 * awaited, so the handlers queue them here and the page's `afterPage` sends
 * them together, before the next page is fetched.
 */
function writeQueue(prisma: PrismaClient) {
  const queue: Prisma.PrismaPromise<unknown>[] = [];
  return {
    push: (q: Prisma.PrismaPromise<unknown>) => {
      queue.push(q);
    },
    flush: async () => {
      if (!queue.length) return;
      await prisma.$transaction(queue.splice(0));
    },
  };
}

/** How much work is outstanding — one cheap query, so a settled boot is free. */
export async function pendingClassificationCount(
  prisma: PrismaClient,
  opts: ClassificationOptions = {},
): Promise<number> {
  const stale = { OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] };
  const [master, formulary] = await Promise.all([
    opts.only === 'formulary' ? 0 : prisma.drugMaster.count({ where: stale as never }),
    opts.only === 'master'
      ? 0
      : prisma.drugFormulary.count({
          where: {
            ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
            AND: [
              { category: { not: 'product' } },
              // Spelled as an explicit OR because `not: 'manual'` alone would
              // also drop every NULL row — in SQL, NULL <> 'manual' is NULL,
              // not true, so the unclassified rows would never be counted.
              { OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }] },
              stale,
            ],
          } as never,
        }),
  ]);
  return master + formulary;
}

/**
 * The salt reference, held in memory for the whole run — 1,858 molecules. The
 * backfill classifies by join like every other path now, so it needs the same
 * facts the live service caches.
 */
type SaltFacts = Omit<SaltRow, 'strengthValue' | 'strengthUnit' | 'perVolumeValue'>;

async function loadSaltIndex(prisma: PrismaClient): Promise<Map<string, SaltFacts> | null> {
  const salts = await prisma.salt.findMany({ include: { classes: { include: { class: true } } } });
  if (!salts.length) return null;
  return new Map(
    salts.map((s) => [
      s.id,
      {
        name: s.name,
        scheduleCode: s.scheduleCode,
        controlledClass: s.controlledClass,
        narcoticClass: s.narcoticClass,
        vaultControlled: s.vaultControlled,
        exemptIfCombination: s.exemptIfCombination,
        maxPerUnitMg: s.maxPerUnitMg === null ? null : Number(s.maxPerUnitMg),
        maxConcentrationPercent:
          s.maxConcentrationPercent === null ? null : Number(s.maxConcentrationPercent),
        fallbackSchedule: s.fallbackSchedule,
        topicalExempt: s.topicalExempt,
        classes: s.classes.map((c) => ({ name: c.class.name, scheduleCode: c.class.scheduleCode })),
      },
    ]),
  );
}

/**
 * Turn a drug's stored links into classifier input. Returns null when the drug
 * has none, or names a molecule the index does not know — the caller then falls
 * back to parsing the text, which is safer than classifying a composition with
 * an ingredient silently missing.
 */
function toSaltRows(
  links: { saltId: string; strengthValue: unknown; strengthUnit: string | null; perVolumeValue: unknown }[],
  index: Map<string, SaltFacts>,
): SaltRow[] | null {
  if (!links.length) return null;
  const rows: SaltRow[] = [];
  for (const l of links) {
    const facts = index.get(l.saltId);
    if (!facts) return null;
    rows.push({
      ...facts,
      strengthValue: l.strengthValue === null ? null : Number(l.strengthValue),
      strengthUnit: l.strengthUnit,
      perVolumeValue: l.perVolumeValue === null ? null : Number(l.perVolumeValue),
    });
  }
  return rows;
}

async function loadIndex(prisma: PrismaClient): Promise<RuleIndex | null> {
  const rules = (await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
  })) as unknown as ScheduleRuleLike[];
  return rules.length ? buildRuleIndex(rules) : null;
}

export async function runClassification(
  prisma: PrismaClient,
  opts: ClassificationOptions = {},
): Promise<ClassificationTotals> {
  const log = opts.log ?? (() => {});
  const totals: ClassificationTotals = {
    masterScanned: 0, masterChanged: 0, formularyScanned: 0, formularyChanged: 0,
  };

  const index = await loadIndex(prisma);
  if (!index) {
    log('  no active schedule rules — run the drug-schedule-rules seed first');
    return totals;
  }
  const saltIndex = await loadSaltIndex(prisma);
  if (!saltIndex) log('  salt master not seeded — falling back to composition text');

  const staleOnly = opts.force
    ? {}
    : { OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] };

  // ── platform catalog ─────────────────────────────────────────────────────
  if (opts.only !== 'formulary') {
    const writes = writeQueue(prisma);
    const select = {
      id: true, name: true, genericName: true, saltComposition: true, dosageForm: true,
      scheduleResolved: true, controlledClass: true, vaultControlled: true,
      requiresQrScan: true, classifierVersion: true, rxRequired: true,
      // The structured molecules, so the backfill classifies by join like
      // every other path. Loading them here keeps it to one query per page
      // instead of one per drug.
      salts: {
        select: { saltId: true, strengthValue: true, strengthUnit: true, perVolumeValue: true },
        orderBy: { position: 'asc' },
      },
    } satisfies Prisma.DrugMasterSelect;
    await forEachPending({
      readIds: async () =>
        (await prisma.drugMaster.findMany({ where: staleOnly as never, select: { id: true } })).map((r) => r.id),
      fetchIds: (ids: string[]) => prisma.drugMaster.findMany({
        where: { AND: [staleOnly, { id: { in: ids } }] } as never,
        select,
        orderBy: { id: 'asc' },
      }),
      fetchAfter: (cursor?: string) => prisma.drugMaster.findMany({
        where: staleOnly as never,
        select,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      }),
      // A dry run writes nothing, so the filter never shrinks — the cursor is
      // the only thing that can advance it.
      useCursor: Boolean(opts.force || opts.dryRun),
      handle: async (row) => {
        // Prefer the salt join; fall back to parsing the text only when this
        // drug has no structured molecules yet (a fresh import, or a molecule
        // the salt master does not cover).
        const saltRows = saltIndex ? toSaltRows(row.salts, saltIndex) : null;
        const brandRule = index.byBrand.get(normaliseBrand(row.name));
        const r = saltRows
          ? classifyFromSalts(
              {
                brandName: row.name, dosageForm: row.dosageForm, salts: saltRows,
                prescriptionOnly: row.rxRequired,
              },
              { requiresQrScan: Boolean(brandRule), qrFormulation: brandRule?.matchValue ?? null },
            )
          : classify(
              {
                brandName: row.name, genericName: row.genericName,
                composition: row.saltComposition, dosageForm: row.dosageForm,
                prescriptionOnly: row.rxRequired,
              },
              index,
            );
        totals.masterScanned += 1;
        opts.onRow?.(r, row.name, 'master');
        // The composition counts as a change in its own right. Without this the
        // repair below is unreachable on a re-run: once the schedule fields
        // match, `unchanged` returns early and the stripped composition stays
        // stripped for good. The formulary path below has always done this.
        const repairComposition = shouldWriteComposition(row.saltComposition, r.composition);
        if (unchanged(row as never, r, 'scheduleResolved') && !repairComposition) return;
        totals.masterChanged += 1;
        if (opts.dryRun) return;
        writes.push(prisma.drugMaster.update({
          where: { id: row.id },
          data: {
            scheduleResolved: r.schedule,
            scheduleReason: r.reason,
            controlledClass: r.controlledClass,
            vaultControlled: r.vaultControlled,
            requiresQrScan: r.requiresQrScan,
            saltsJson: r.salts as never,
            classifiedAt: new Date(),
            classifierVersion: CLASSIFIER_VERSION,
            // Enriched when blank, and repaired when an earlier run wrote it
            // without the strengths. Never overwritten otherwise.
            ...(repairComposition ? { saltComposition: r.composition } : {}),
          },
        }));
      },
      afterPage: writes.flush,
    });
  }

  // ── hospital formularies ─────────────────────────────────────────────────
  if (opts.only !== 'master') {
    const writes = writeQueue(prisma);
    const where = {
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      AND: [
        { category: { not: 'product' } },
        { OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }] },
        ...(opts.force ? [] : [staleOnly]),
      ],
    };
    const select = {
      id: true, drugName: true, genericName: true, composition: true, dosageForm: true,
      drugMasterId: true, schedule: true, controlledClass: true, vaultControlled: true,
      requiresQrScan: true, classifierVersion: true,
      drugMaster: {
        select: {
          scheduleResolved: true, scheduleReason: true, controlledClass: true,
          vaultControlled: true, requiresQrScan: true, saltsJson: true,
        },
      },
    } satisfies Prisma.DrugFormularySelect;
    await forEachPending({
      readIds: async () =>
        (await prisma.drugFormulary.findMany({ where: where as never, select: { id: true } })).map((r) => r.id),
      fetchIds: (ids: string[]) => prisma.drugFormulary.findMany({
        where: { AND: [where, { id: { in: ids } }] } as never,
        select,
        orderBy: { id: 'asc' },
      }),
      fetchAfter: (cursor?: string) => prisma.drugFormulary.findMany({
        where: where as never,
        select,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      }),
      useCursor: Boolean(opts.force || opts.dryRun),
      handle: async (row) => {
        // A catalog-linked drug inherits the platform decision, so the same
        // product never carries two different schedules in two hospitals.
        const inherited = row.drugMasterId && row.drugMaster?.scheduleResolved;
        const r: ClassificationResult = inherited
          ? {
              schedule: row.drugMaster!.scheduleResolved as ClassificationResult['schedule'],
              reason: row.drugMaster!.scheduleReason ?? 'Inherited from the platform drug catalog.',
              matchedRule: null,
              controlledClass: (row.drugMaster!.controlledClass as never) ?? null,
              narcoticClass: null,
              vaultControlled: row.drugMaster!.vaultControlled,
              requiresQrScan: row.drugMaster!.requiresQrScan,
              salts: (row.drugMaster!.saltsJson as never) ?? [],
              composition: null,
              needsReview: false,
            }
          : classify(
              {
                brandName: row.drugName, genericName: row.genericName,
                composition: row.composition, dosageForm: row.dosageForm,
              },
              index,
            );

        totals.formularyScanned += 1;
        opts.onRow?.(r, row.drugName, 'formulary');

        // Inheriting a platform schedule says nothing about the local salt
        // text, so the composition is derived from this row's own generic name.
        const candidate = compositionFrom(row.genericName);
        const derived = shouldWriteComposition(row.composition, candidate) ? candidate : null;
        if (unchanged(row as never, r, 'schedule') && !derived) return;
        totals.formularyChanged += 1;
        if (opts.dryRun) return;

        writes.push(prisma.drugFormulary.update({
          where: { id: row.id },
          data: {
            schedule: r.schedule,
            scheduleSource: inherited ? 'inherited' : 'auto',
            scheduleReason: r.reason,
            controlledClass: r.controlledClass,
            vaultControlled: r.vaultControlled,
            requiresQrScan: r.requiresQrScan,
            saltsJson: r.salts as never,
            classifiedAt: new Date(),
            classifierVersion: CLASSIFIER_VERSION,
            ...(derived ? { composition: derived } : {}),
          },
        }));
      },
      afterPage: writes.flush,
    });
  }

  return totals;
}

/**
 * The auto-seed entry point. Returns immediately when nothing is outstanding,
 * so this costs one count on a settled deployment.
 */
export async function seedDrugScheduleClassification(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();
  try {
    const pending = await pendingClassificationCount(prisma);
    if (pending === 0) return;

    // eslint-disable-next-line no-console
    console.log(`  classifying ${pending} unclassified drug(s)…`);
    const t = await runClassification(prisma, {
      log: (m) => console.log(m), // eslint-disable-line no-console
    });
    // eslint-disable-next-line no-console
    console.log(
      `  classified: catalog ${t.masterChanged}/${t.masterScanned}, ` +
        `formulary ${t.formularyChanged}/${t.formularyScanned}`,
    );
  } finally {
    if (owns) await prisma.$disconnect();
  }
}
