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

import { PrismaClient } from '@prisma/client';
import {
  buildRuleIndex,
  classify,
  parseSalts,
  formatSalt,
  CLASSIFIER_VERSION,
  type RuleIndex,
  type ScheduleRuleLike,
  type ClassificationResult,
} from '../modules/drug-master/drug-schedule.classifier';

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
 * The obvious approach — cursor pagination over `classifierVersion != current`
 * — is wrong here, and silently so: each page's cursor row is classified before
 * the next page is fetched, so it no longer matches the filter and cannot
 * anchor the next window. Rows get skipped, scattered across the whole id
 * range. On this database that quietly left 126 of 253,987 catalog rows behind
 * on every run.
 *
 * When the filter is being consumed, take the FIRST chunk each time instead:
 * processed rows drop out of the set, so the window advances by itself. The
 * guard catches the one way that can fail — a chunk that changes nothing,
 * which would otherwise spin forever.
 *
 * With `force` the filter is empty and nothing leaves the set, so a cursor is
 * the correct tool there and is used instead.
 */
async function forEachPending<T extends { id: string }>(
  fetch: (cursor?: string) => Promise<T[]>,
  handle: (row: T) => Promise<void>,
  useCursor: boolean,
): Promise<void> {
  let cursor: string | undefined;
  let lastFirstId: string | undefined;
  for (;;) {
    const rows = await fetch(useCursor ? cursor : undefined);
    if (!rows.length) return;

    if (!useCursor && rows[0].id === lastFirstId) {
      // The same page came back untouched — every row in it failed to leave the
      // set. Stop rather than spin; the next run will retry them.
      // eslint-disable-next-line no-console
      console.warn(`  stopped early: ${rows.length} row(s) did not progress (first ${rows[0].id})`);
      return;
    }
    lastFirstId = rows[0].id;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) await handle(row);
  }
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

  const staleOnly = opts.force
    ? {}
    : { OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] };

  // ── platform catalog ─────────────────────────────────────────────────────
  if (opts.only !== 'formulary') {
    await forEachPending(
      (cursor) => prisma.drugMaster.findMany({
        where: staleOnly as never,
        select: {
          id: true, name: true, genericName: true, saltComposition: true, dosageForm: true,
          scheduleResolved: true, controlledClass: true, vaultControlled: true,
          requiresQrScan: true, classifierVersion: true,
        },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      }),
      async (row) => {
        const r = classify(
          {
            brandName: row.name, genericName: row.genericName,
            composition: row.saltComposition, dosageForm: row.dosageForm,
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
        await prisma.drugMaster.update({
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
        });
      },
      // A dry run writes nothing, so the filter never shrinks — the cursor is
      // the only thing that can advance it.
      Boolean(opts.force || opts.dryRun),
    );
  }

  // ── hospital formularies ─────────────────────────────────────────────────
  if (opts.only !== 'master') {
    await forEachPending(
      (cursor) => prisma.drugFormulary.findMany({
        where: {
          ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
          AND: [
            { OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }] },
            ...(opts.force ? [] : [staleOnly]),
          ],
        } as never,
        select: {
          id: true, drugName: true, genericName: true, composition: true, dosageForm: true,
          drugMasterId: true, schedule: true, controlledClass: true, vaultControlled: true,
          requiresQrScan: true, classifierVersion: true,
          drugMaster: {
            select: {
              scheduleResolved: true, scheduleReason: true, controlledClass: true,
              vaultControlled: true, requiresQrScan: true, saltsJson: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: CHUNK,
      }),
      async (row) => {
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

        await prisma.drugFormulary.update({
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
        });
      },
      Boolean(opts.force || opts.dryRun),
    );
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
