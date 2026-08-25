/**
 * Retire the five illustrative numeric codes from the TRMS CDSS Level document
 * (`100 Fever`, `101 Fever with Chills`, `102 Diarrhea`, `103 Malaria`,
 * `104 Skin Allergy`): re-code the diagnoses recorded against them, then remove
 * them from the platform ICD catalogue.
 *
 * They were seeded so the document's worked example resolved, and were
 * harmless while the catalogue was 76 curated rows. Once the full WHO release
 * landed they stopped being harmless: each carries a curated keyword, and the
 * search ranks an exact keyword highly, so `100 Fever` became the FIRST result
 * for "fever" and `103 Malaria` the first for "malaria" — ahead of R50.9 and
 * B54. They are not ICD-10 codes; no claim or morbidity return would accept
 * one, and none of them matched a CDSS rule either, since those key on real
 * prefixes (`I21`, `E11`, `J18`).
 *
 * Deleting them from `icd.data.ts` is not enough on its own. That seed only
 * creates and updates, and it is guarded on an empty catalogue, so a database
 * that already has them would keep them for ever. Hence this step, which runs
 * on boot and is a permanent no-op once it has done its work. It exists to be
 * deleted once every deployment has run it.
 *
 * WHAT IS AND IS NOT REWRITTEN. A diagnosis recorded against one of these
 * carries two things: `icdCode`, which was never valid, and `diagnosisName`,
 * which is what the clinician actually wrote and what every screen displays.
 * Only the code is corrected. "Fever with Chills" is a real observation and
 * says more than "Fever, unspecified" — overwriting it would trade a clinical
 * record for a classification label, so the recorded wording is left exactly as
 * it is. Nothing has a foreign key to `IcdCode`, so the two are independent.
 */

import { PrismaClient } from '@prisma/client';

/** The category the demo rows were seeded under — the whole of their identity. */
const DEMO_CATEGORY = 'TRMS demo';

/**
 * Demo code → the ICD-10 code a diagnosis recorded against it should carry.
 *
 * Both fever codes go to R50.9 "Fever, unspecified". WHO ICD-10 has no distinct
 * code for fever with chills — the nearest, R68.8, is a catch-all for other
 * general signs — and fever is the presenting finding in both, so R50.9 is the
 * right classification for each. The chills stay recorded in `diagnosisName`.
 *
 * `102`, `103` and `104` are deliberately absent. Diarrhoea splits by whether
 * it is infectious (A09 against R19.7) and "Skin Allergy" could be any of
 * several codes; guessing on someone's record is not this step's job. Rows
 * still on those codes are reported instead.
 */
const REMAP: Record<string, string> = {
  '100': 'R50.9',
  '101': 'R50.9',
};

export async function retireDemoIcdCodes(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();

  try {
    for (const [from, to] of Object.entries(REMAP)) {
      // Never point a record at a code that is not in the catalogue.
      const target = await prisma.icdCode.findFirst({
        where: { tenantId: null, code: to },
        select: { code: true },
      });
      if (!target) {
        console.log(`Skipped re-coding ${from} → ${to}: ${to} is not in the platform catalogue.`);
        continue;
      }

      const { count } = await prisma.diagnosis.updateMany({
        where: { icdCode: from },
        // `diagnosisName` is deliberately untouched — see the note above.
        data: { icdCode: to },
      });
      if (count) console.log(`Re-coded ${count} diagnoses from ${from} to ${to}.`);
    }

    const doomed = await prisma.icdCode.findMany({
      where: { tenantId: null, category: DEMO_CATEGORY },
      select: { code: true },
    });

    // Anything left on a demo code has no agreed mapping. Say so rather than
    // let it sit unnoticed behind a code that no longer exists.
    const unmapped = Object.keys(REMAP).length
      ? await prisma.diagnosis.groupBy({
          by: ['icdCode'],
          where: { icdCode: { in: ['100', '101', '102', '103', '104'] } },
          _count: { _all: true },
        })
      : [];
    for (const row of unmapped) {
      console.log(
        `${row._count._all} diagnoses still carry demo code ${row.icdCode}, which has no agreed ` +
          'ICD-10 mapping. They keep their diagnosis name and display normally.',
      );
    }

    if (!doomed.length) return;

    const codes = doomed.map((c) => c.code);
    await prisma.icdCode.deleteMany({ where: { tenantId: null, category: DEMO_CATEGORY } });
    console.log(`Retired ${codes.length} TRMS demo ICD codes: ${codes.join(', ')}.`);
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  retireDemoIcdCodes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
