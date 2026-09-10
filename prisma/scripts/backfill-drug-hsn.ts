/**
 * Give every medicine an HSN code, so GST can be worked out for it.
 *
 * WHY THIS IS THE WHOLE JOB. The rate masters were already right — 18 HSN rows
 * and 16 SAC rows, all with sane codes and rates. The determination engine was
 * already right. What was missing was the one fact that connects a medicine to
 * the master: its HSN. Without it a drug falls through `hsn_master` to the
 * category default, and the C-3 report lists the line as having no code —
 * which is also what keeps it out of GSTR-1's table 12.
 *
 * WHAT IT DOES NOT CHANGE. An in-patient's medicine stays EXEMPT whatever code
 * it carries: `inpatient_composite` is resolved BEFORE `hsn_master`, because
 * a medicine administered during a stay is part of the treatment and the
 * treatment is exempt. The code still matters there — table 12 reports exempt
 * supplies by HSN too — but it will not put tax on a ward bill, and it is not
 * supposed to. Where it changes the answer is the counter sale, the discharge
 * (take-home) pack, and any OP dispense.
 *
 * HOW A CODE IS CHOSEN. From the dosage form, which is the system's own
 * statement of what the thing is:
 *
 *   - a finished medicament in measured doses  → 3004, at 5%
 *   - oral rehydration salts                   → 30049010, which the master
 *     carries at 0% because ORS is nil-rated
 *   - anything that is not a medicine at all   → left alone and REPORTED
 *
 * That last rule is the important one. Section 13 makes the classification the
 * hospital's auditor's call, and a script that stamps 3004 onto a body lotion
 * to make a report go green has invented a tax position nobody approved. It is
 * better to leave those few named on screen than to bury them.
 *
 *   npx tsx prisma/scripts/backfill-drug-hsn.ts            # dry run
 *   npx tsx prisma/scripts/backfill-drug-hsn.ts --apply
 *   npx tsx prisma/scripts/backfill-drug-hsn.ts --apply --all-tenants
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';

const APPLY = process.argv.includes('--apply');
const ALL_TENANTS = process.argv.includes('--all-tenants');

/** Medicaments in measured doses. The master carries 3004 at 5%. */
const MEDICAMENT = '30049099';
/** Oral rehydration salts, which the master carries at 0% — ORS is nil-rated. */
const ORS = '30049010';

/**
 * Dosage forms that make something a finished medicament.
 *
 * Deliberately a list rather than "anything with a form": a form this does not
 * recognise is reported rather than guessed at.
 */
const MEDICAMENT_FORMS = new Set([
  'tablet', 'capsule', 'syrup', 'suspension', 'injection', 'infusion',
  'drops', 'inhaler', 'spray', 'ointment', 'cream', 'gel', 'lotion',
  'solution', 'granules', 'sachet', 'powder', 'patch', 'suppository',
]);

/**
 * Forms that can be read off the NAME when the form field is empty.
 *
 * Deliberately narrower than the list above: a tablet is a medicine whatever
 * else it is, but "lotion", "cream" and "powder" are equally the words for
 * cosmetics and toiletries, which are not 3004 and not 5%. Inferring those
 * from a name is how a body lotion ends up taxed as a medicament.
 */
const UNAMBIGUOUS_IN_NAME = [
  'tablet', 'capsule', 'syrup', 'suspension', 'injection', 'infusion',
];

/** ORS by name — the only nil-rated case common enough to be worth naming. */
function isOrs(name: string, generic: string | null): boolean {
  const t = `${name} ${generic ?? ''}`.toLowerCase();
  return /\bors\b|oral rehydration|electral|rehydration salt/.test(t);
}

function codeFor(d: {
  drugName: string;
  genericName: string | null;
  dosageForm: string | null;
}): { code: string; why: string } | null {
  if (isOrs(d.drugName, d.genericName)) {
    return { code: ORS, why: 'oral rehydration salts — nil-rated' };
  }
  const form = String(d.dosageForm ?? '').toLowerCase();
  if (MEDICAMENT_FORMS.has(form)) {
    return { code: MEDICAMENT, why: `${form} — medicament in measured doses` };
  }
  // No form recorded, but the name says what it is: "Crocin Advance 500 Tablet".
  if (!form) {
    const name = d.drugName.toLowerCase();
    const named = UNAMBIGUOUS_IN_NAME.find((f) => name.includes(f));
    if (named) return { code: MEDICAMENT, why: `named a ${named} — medicament in measured doses` };
  }
  // 'other' with a generic name is still a formulation; without one there is
  // nothing to go on and the auditor should look at it.
  if (form === 'other' && d.genericName) {
    return { code: MEDICAMENT, why: 'formulated medicine — medicament in measured doses' };
  }
  return null;
}

async function main(): Promise<void> {
  const tenants = ALL_TENANTS
    ? await prisma.tenant.findMany({ select: { id: true, name: true } })
    : await prisma.tenant.findMany({
        where: { name: { not: 'Platform' } },
        select: { id: true, name: true },
      });

  let planned = 0;
  const skipped: string[] = [];

  for (const t of tenants) {
    const drugs = await prisma.drugFormulary.findMany({
      where: { tenantId: t.id, hsnCode: null, isActive: true },
      select: { id: true, drugName: true, genericName: true, dosageForm: true },
      orderBy: { drugName: 'asc' },
    });
    if (drugs.length === 0) continue;

    console.log(`\n${t.name}: ${drugs.length} active medicine(s) with no HSN`);
    const byCode = new Map<string, number>();

    for (const d of drugs) {
      const hit = codeFor({
        drugName: d.drugName,
        genericName: d.genericName,
        dosageForm: d.dosageForm as string | null,
      });
      if (!hit) {
        skipped.push(`${t.name}: ${d.drugName} (form=${d.dosageForm ?? 'none'})`);
        continue;
      }
      byCode.set(hit.code, (byCode.get(hit.code) ?? 0) + 1);
      planned += 1;
      if (APPLY) {
        await prisma.drugFormulary.update({
          where: { id: d.id },
          data: { hsnCode: hit.code },
        });
      }
    }
    for (const [code, n] of byCode) console.log(`  ${code} → ${n} medicine(s)`);
  }

  if (skipped.length) {
    console.log(`\n${skipped.length} left for the auditor — not medicines, or no dosage form to go on:`);
    for (const s of skipped) console.log(`  ${s}`);
    console.log('  (classify these on Settings → GST classification)');
  }

  console.log(
    `\n${APPLY ? 'UPDATED' : 'WOULD UPDATE'} ${planned} medicine(s).` +
      (APPLY ? '' : '  Re-run with --apply to write.'),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
