/**
 * Backfill the drug schedule classification across the platform catalog and
 * every tenant formulary.
 *
 * Usage:
 *   npm run db:classify-schedules -- --dry-run          report only, writes nothing
 *   npm run db:classify-schedules                       apply
 *   npm run db:classify-schedules -- --only=formulary   skip the 254K catalog
 *   npm run db:classify-schedules -- --tenant=<id>      one hospital only
 *   npm run db:classify-schedules -- --force            re-do already-classified rows
 *
 * Safety properties, in order of importance:
 *
 *  1. It NEVER touches drug_master.schedule. That legacy column is read by
 *     checkSaleCompliance(), which is already wired into createPharmacySale, so
 *     writing it would silently switch counter enforcement on. Results go to
 *     schedule_resolved / schedule instead.
 *  2. It NEVER overwrites a row whose scheduleSource is 'manual'. A pharmacist's
 *     override outranks the classifier for good.
 *  3. It NEVER writes isNarcotic. Five dispensing paths throw on that flag; the
 *     classifier's opinion is recorded in controlledClass / vaultControlled,
 *     which nothing reads yet.
 *  4. Chunked and resumable — re-running only re-does what changed, so a
 *     half-finished run is safe to repeat.
 */

import 'dotenv/config';
import { prisma } from '../../src/config/database';
import {
  buildRuleIndex,
  classify,
  parseSalts,
  CLASSIFIER_VERSION,
  type RuleIndex,
  type ScheduleRuleLike,
  type ClassificationResult,
} from '../../src/modules/drug-master/drug-schedule.classifier';

/** The cleaned "Salt + Salt" string for the composition column, or null. */
const classifySalts = (generic: string): string | null => {
  const salts = parseSalts(generic);
  return salts.length ? salts.map((s) => s.raw).join(' + ') : null;
};

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => args.find((a) => a.startsWith(`${f}=`))?.split('=')[1];

const DRY = has('--dry-run');
const FORCE = has('--force');
const ONLY = val('--only');
const TENANT = val('--tenant');
const CHUNK = 2000;

interface Tally {
  total: number;
  schedule: Record<string, number>;
  controlled: Record<string, number>;
  needsReview: number;
  changed: number;
  skippedManual: number;
  samples: Record<string, string[]>;
}

const newTally = (): Tally => ({
  total: 0, schedule: {}, controlled: {}, needsReview: 0,
  changed: 0, skippedManual: 0, samples: {},
});

function record(t: Tally, r: ClassificationResult, label: string) {
  t.total += 1;
  t.schedule[r.schedule] = (t.schedule[r.schedule] ?? 0) + 1;
  if (r.controlledClass) {
    const key = `${r.controlledClass}${r.vaultControlled ? ' (vault)' : ''}`;
    t.controlled[key] = (t.controlled[key] ?? 0) + 1;
  }
  if (r.needsReview) t.needsReview += 1;
  const bucket = (t.samples[r.schedule] ??= []);
  if (bucket.length < 5) bucket.push(`${label} → ${r.reason}`);
}

function print(t: Tally, title: string) {
  console.log(`\n===== ${title} — ${t.total} rows =====`);
  if (!t.total) return;
  const order = ['X', 'H1', 'H', 'H2', 'G', 'OTC'];
  for (const k of order) {
    const n = t.schedule[k];
    if (!n) continue;
    console.log(`  ${k.padEnd(4)} ${String(n).padStart(7)}  ${((n / t.total) * 100).toFixed(1)}%`);
  }
  const ctrl = Object.entries(t.controlled);
  console.log(`  controlled: ${ctrl.length ? ctrl.map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`);
  if (t.needsReview) console.log(`  ⚠ needs review: ${t.needsReview} (unreadable strength on a controlled molecule)`);
  console.log(`  ${DRY ? 'would change' : 'changed'}: ${t.changed}${t.skippedManual ? `, skipped (manual override): ${t.skippedManual}` : ''}`);
  for (const k of order) {
    if (!t.samples[k]?.length) continue;
    console.log(`  --- ${k} ---`);
    for (const s of t.samples[k]) console.log(`      ${s.slice(0, 150)}`);
  }
}

/** Has anything the classifier controls actually changed on this row? */
function isSame(row: any, r: ClassificationResult, scheduleField: 'schedule' | 'scheduleResolved') {
  return (
    row[scheduleField] === r.schedule &&
    (row.controlledClass ?? null) === (r.controlledClass ?? null) &&
    Boolean(row.vaultControlled) === r.vaultControlled &&
    Boolean(row.requiresQrScan) === r.requiresQrScan &&
    row.classifierVersion === CLASSIFIER_VERSION
  );
}

async function classifyDrugMaster(index: RuleIndex) {
  const t = newTally();
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.drugMaster.findMany({
      where: FORCE ? {} : { OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] },
      select: {
        id: true, name: true, genericName: true, saltComposition: true, dosageForm: true,
        scheduleResolved: true, controlledClass: true, vaultControlled: true,
        requiresQrScan: true, classifierVersion: true,
      },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: CHUNK,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const r = classify(
        {
          brandName: row.name,
          genericName: row.genericName,
          composition: row.saltComposition,
          dosageForm: row.dosageForm,
        },
        index,
      );
      record(t, r, row.name);
      if (isSame(row, r, 'scheduleResolved')) continue;
      t.changed += 1;
      if (DRY) continue;
      await prisma.drugMaster.update({
        where: { id: row.id },
        data: {
          scheduleResolved: r.schedule,
          scheduleReason: r.reason,
          controlledClass: r.controlledClass,
          vaultControlled: r.vaultControlled,
          requiresQrScan: r.requiresQrScan,
          saltsJson: r.salts as any,
          classifiedAt: new Date(),
          classifierVersion: CLASSIFIER_VERSION,
          // saltComposition is reference data we can safely enrich when blank.
          ...(row.saltComposition ? {} : r.composition ? { saltComposition: r.composition } : {}),
        },
      });
    }
    if (!DRY) process.stdout.write(`\r  drug_master: ${t.total} processed…`);
  }
  if (!DRY && t.total) process.stdout.write('\n');
  return t;
}

async function classifyFormulary(index: RuleIndex) {
  const t = newTally();
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.drugFormulary.findMany({
      where: {
        ...(TENANT ? { tenantId: TENANT } : {}),
        AND: [
          // A pharmacist's manual override always outranks the classifier.
          // Spelled as an explicit OR because `not: 'manual'` alone would also
          // drop every unclassified row — in SQL, NULL <> 'manual' is NULL,
          // not true, so the rows we most need would silently never be picked up.
          { OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }] },
          ...(FORCE
            ? []
            : [{ OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] }]),
        ],
      },
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
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      // A catalog-linked drug inherits the platform decision so the same product
      // never carries two different schedules in two hospitals. An
      // own-formulary drug is classified from its own composition.
      const inherited = row.drugMasterId && row.drugMaster?.scheduleResolved;
      const r: ClassificationResult = inherited
        ? {
            schedule: row.drugMaster!.scheduleResolved as ClassificationResult['schedule'],
            reason: row.drugMaster!.scheduleReason ?? 'Inherited from the platform drug catalog.',
            matchedRule: null,
            controlledClass: (row.drugMaster!.controlledClass as any) ?? null,
            narcoticClass: null,
            vaultControlled: row.drugMaster!.vaultControlled,
            requiresQrScan: row.drugMaster!.requiresQrScan,
            salts: (row.drugMaster!.saltsJson as any) ?? [],
            composition: null,
            needsReview: false,
          }
        : classify(
            {
              brandName: row.drugName,
              genericName: row.genericName,
              composition: row.composition,
              dosageForm: row.dosageForm,
            },
            index,
          );
      record(t, r, row.drugName);

      // The composition column is empty across the board, and it is the field
      // the register report's "API & Strength" column reads. Derive it from this
      // row's OWN genericName regardless of where the schedule came from —
      // inheriting a platform schedule says nothing about the local salt text.
      // Never overwrite a value the pharmacist typed.
      const derived = !row.composition && row.genericName ? classifySalts(row.genericName) : null;
      const derivedComposition = derived ? { composition: derived } : {};

      // A row is worth writing when the classification moved OR when we can fill
      // a blank composition — checking only the former would leave the column
      // empty forever on rows whose schedule was already correct.
      if (isSame(row, r, 'schedule') && !derived) continue;
      t.changed += 1;
      if (DRY) continue;
      await prisma.drugFormulary.update({
        where: { id: row.id },
        data: {
          schedule: r.schedule,
          scheduleSource: inherited ? 'inherited' : 'auto',
          scheduleReason: r.reason,
          controlledClass: r.controlledClass,
          vaultControlled: r.vaultControlled,
          requiresQrScan: r.requiresQrScan,
          saltsJson: r.salts as any,
          classifiedAt: new Date(),
          classifierVersion: CLASSIFIER_VERSION,
          ...derivedComposition,
        },
      });
    }
  }

  const manual = await prisma.drugFormulary.count({
    where: { ...(TENANT ? { tenantId: TENANT } : {}), scheduleSource: 'manual' },
  });
  t.skippedManual = manual;
  return t;
}

async function main() {
  const rules = (await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
  })) as unknown as ScheduleRuleLike[];

  if (!rules.length) {
    console.error('No active drug schedule rules found. Run `npm run db:seed:drug-schedules` first.');
    process.exitCode = 1;
    return;
  }
  const index = buildRuleIndex(rules);
  console.log(
    `Loaded ${rules.length} rules — ${index.bySalt.size} salt keys, ${index.byBrand.size} brands, ` +
      `${index.classes.length} class rules, ${index.ndps.size} NDPS keys.`,
  );
  console.log(DRY ? '*** DRY RUN — nothing will be written ***' : '*** APPLYING ***');

  if (ONLY !== 'formulary') print(await classifyDrugMaster(index), 'DRUG MASTER (platform catalog)');
  if (ONLY !== 'master') print(await classifyFormulary(index), 'DRUG FORMULARY (hospital stock)');

  console.log(
    '\nNote: drug_master.schedule is intentionally left untouched — the counter ' +
      'compliance gate still reads it, and enforcement is switched on separately.',
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
