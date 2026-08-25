/**
 * Remove the five illustrative numeric codes from the TRMS CDSS Level document
 * (`100 Fever`, `101 Fever with Chills`, `102 Diarrhea`, `103 Malaria`,
 * `104 Skin Allergy`) from the platform ICD catalogue.
 *
 * They were seeded so the document's worked example resolved, and were
 * harmless while the catalogue was 76 curated rows. Once the full WHO release
 * landed they stopped being harmless: each carries a curated keyword, and the
 * search ranks an exact keyword highly, so `100 Fever` became the FIRST result
 * for "fever" and `103 Malaria` the first for "malaria" — ahead of R50.9 and
 * B54. They are not ICD-10 codes; no claim or morbidity return would accept
 * one.
 *
 * Deleting them from `icd.data.ts` is not enough on its own. That seed only
 * creates and updates, and it is guarded on an empty catalogue, so a database
 * that already has them would keep them for ever. Hence this step, which runs
 * on boot and is a permanent no-op once it has done its work.
 *
 * SAFETY. Only platform rows (`tenantId: null`) carrying the `TRMS demo`
 * category are touched, so a hospital's own custom codes cannot be caught by
 * it. Nothing has a foreign key to `IcdCode`, and `Diagnosis` snapshots both
 * `icdCode` and `diagnosisName`, so a diagnosis already recorded against one of
 * these keeps its name and goes on displaying exactly as before — it simply
 * carries a code that is no longer offered, which was already true of a code
 * that was never real ICD-10. Those rows are counted and logged rather than
 * rewritten: re-coding a recorded diagnosis is a clinical decision, not a
 * seed's.
 */

import { PrismaClient } from '@prisma/client';

/** The category the demo rows were seeded under — the whole of their identity. */
const DEMO_CATEGORY = 'TRMS demo';

export async function retireDemoIcdCodes(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();

  try {
    const doomed = await prisma.icdCode.findMany({
      where: { tenantId: null, category: DEMO_CATEGORY },
      select: { code: true },
    });
    if (!doomed.length) return;

    const codes = doomed.map((c) => c.code);
    const stillReferenced = await prisma.diagnosis.count({ where: { icdCode: { in: codes } } });

    await prisma.icdCode.deleteMany({ where: { tenantId: null, category: DEMO_CATEGORY } });

    console.log(`Retired ${codes.length} TRMS demo ICD codes: ${codes.join(', ')}.`);
    if (stillReferenced) {
      // Worth saying out loud once: these diagnoses keep their recorded name
      // and are unaffected, but their code no longer resolves to anything.
      console.log(
        `  ${stillReferenced} recorded diagnoses still reference one. They keep their diagnosis name; ` +
          're-coding them to real ICD-10 is a clinical call and is deliberately not done here.',
      );
    }
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
