/**
 * Run both classifiers over the whole catalog and report every disagreement.
 *
 * This is the gate for switching classification from string matching to the salt
 * join. The new path is a PORT, so the only acceptable result is agreement — a
 * diff is a bug in the new path, not an improvement to accept quietly. The three
 * exceptions that survived review are listed in ACCEPTED below; anything else
 * exits non-zero.
 *
 *   npm run db:diff-salt-classifier
 *   npm run db:diff-salt-classifier -- --limit 5000     sample instead of all
 *   npm run db:diff-salt-classifier -- --show 40        more example rows
 */

import 'dotenv/config';
import { prisma } from '../../src/config/database';
import {
  buildRuleIndex,
  classify,
  normaliseBrand,
  type ScheduleRuleLike,
} from '../../src/modules/drug-master/drug-schedule.classifier';
import { classifyFromSalts, type SaltRow } from '../../src/modules/drug-master/salt-classifier';

const args = process.argv.slice(2);
const numArg = (flag: string, fallback: number) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const LIMIT = numArg('--limit', 0);
const SHOW = numArg('--show', 15);
const CHUNK = 2000;

/**
 * Differences that have been looked at and accepted, so this stays a gate that
 * only fires on something NEW.
 *
 * All three are sulphacetamide + chlorpheniramine eye drops. Chlorpheniramine is
 * named in Schedule G; sulphacetamide is covered by Schedule H's "Para-Amino
 * Benzene Sulphonamide" class entry. The string classifier consulted the class
 * entries only when nothing else in the product had matched, so the Schedule G
 * hit suppressed the Schedule H one. The salt path gives every molecule its own
 * schedule, so the stricter one wins — which is right: a sulphacetamide eye drop
 * needs a prescription.
 */
const ACCEPTED = new Set([
  'Zinbro-S Eye Drop|schedule|"G"|"H"',
  'Takmide Eye Drop|schedule|"G"|"H"',
  'Trachol Eye Drop|schedule|"G"|"H"',
]);

interface Mismatch {
  name: string;
  field: string;
  old: unknown;
  neu: unknown;
  composition: string | null;
}

async function main() {
  const rules = (await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
  })) as unknown as ScheduleRuleLike[];
  const index = buildRuleIndex(rules);

  // Salt reference, held in memory — 1,858 rows.
  const salts = await prisma.salt.findMany({
    include: { classes: { include: { class: true } } },
  });
  const saltById = new Map(salts.map((s) => [s.id, s]));

  const totals = { scanned: 0, agreed: 0, differed: 0, accepted: 0 };
  const byField = new Map<string, number>();
  const examples: Mismatch[] = [];

  let cursor: string | null = null;
  for (;;) {
    const drugs = await prisma.drugMaster.findMany({
      select: {
        id: true, name: true, genericName: true, saltComposition: true, dosageForm: true,
        salts: {
          select: {
            saltId: true, strengthValue: true, strengthUnit: true,
            perVolumeValue: true, position: true,
          },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: CHUNK,
    });
    if (!drugs.length) break;
    cursor = drugs[drugs.length - 1].id;

    for (const drug of drugs) {
      if (LIMIT && totals.scanned >= LIMIT) break;
      totals.scanned += 1;

      const oldResult = classify(
        {
          brandName: drug.name,
          genericName: drug.genericName,
          composition: drug.saltComposition,
          dosageForm: drug.dosageForm,
        },
        index,
      );

      const brandRule = index.byBrand.get(normaliseBrand(drug.name));
      const rows: SaltRow[] = drug.salts.map((ds) => {
        const s = saltById.get(ds.saltId)!;
        return {
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
          strengthValue: ds.strengthValue === null ? null : Number(ds.strengthValue),
          strengthUnit: ds.strengthUnit,
          perVolumeValue: ds.perVolumeValue === null ? null : Number(ds.perVolumeValue),
        };
      });

      const newResult = classifyFromSalts(
        { brandName: drug.name, dosageForm: drug.dosageForm, salts: rows },
        { requiresQrScan: Boolean(brandRule), qrFormulation: brandRule?.matchValue ?? null },
      );

      // Compare only what the rest of the system stores and acts on. The reason
      // sentence is prose and is checked separately, by eye.
      const fields: [string, unknown, unknown][] = [
        ['schedule', oldResult.schedule, newResult.schedule],
        ['controlledClass', oldResult.controlledClass, newResult.controlledClass],
        ['vaultControlled', oldResult.vaultControlled, newResult.vaultControlled],
        ['requiresQrScan', oldResult.requiresQrScan, newResult.requiresQrScan],
        ['needsReview', oldResult.needsReview, newResult.needsReview],
      ];

      let differed = false;
      for (const [field, a, b] of fields) {
        if ((a ?? null) === (b ?? null)) continue;
        const key = `${drug.name}|${field}|${JSON.stringify(a)}|${JSON.stringify(b)}`;
        if (ACCEPTED.has(key)) {
          totals.accepted += 1;
          continue;
        }
        differed = true;
        byField.set(field, (byField.get(field) ?? 0) + 1);
        if (examples.length < SHOW) {
          examples.push({
            name: drug.name, field, old: a, neu: b,
            composition: drug.saltComposition ?? drug.genericName,
          });
        }
      }
      if (differed) totals.differed += 1;
      else totals.agreed += 1;
    }

    if (LIMIT && totals.scanned >= LIMIT) break;
    if (drugs.length < CHUNK) break;
    if (totals.scanned % 40000 === 0) console.log(`  ...${totals.scanned} compared`);
  }

  console.log('\n══ classifier diff ══');
  console.log(`  compared : ${totals.scanned}`);
  console.log(`  agreed   : ${totals.agreed}`);
  console.log(`  accepted : ${totals.accepted}  (known, reviewed — see ACCEPTED)`);
  console.log(`  differed : ${totals.differed}`);
  if (byField.size) {
    console.log('\n  by field:');
    for (const [f, n] of [...byField.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${f.padEnd(18)} ${n}`);
    }
    console.log('\n  examples:');
    for (const e of examples) {
      console.log(`    ${e.name}`);
      console.log(`      ${e.composition}`);
      console.log(`      ${e.field}: string=${JSON.stringify(e.old)}  salt=${JSON.stringify(e.neu)}`);
    }
    console.log('\n  UNREVIEWED difference. The salt path is a port, so anything not in');
    console.log('  ACCEPTED is a bug in it, not an improvement to wave through.');
  } else {
    console.log('\n  No unreviewed disagreements — the salt join reproduces the string');
    console.log('  classifier everywhere except the accepted cases documented above.');
  }

  await prisma.$disconnect();
  process.exit(totals.differed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
