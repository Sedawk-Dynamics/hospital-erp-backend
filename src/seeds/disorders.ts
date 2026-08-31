/**
 * Seed the platform disorder list from the ICD-10 disease chapters.
 *
 * "Existing disorders" was free text on both the patient portal and the
 * clinician panel, so one person's "sugar" was another's "diabetes" and a
 * third's "DM", and nothing downstream could count or match them.
 *
 * WHY NOT JUST USE `IcdCode`. That table is the WHO classification — all 12,325
 * rows — and 5,135 of them are injuries (S, T), external causes (V-Y),
 * pregnancy states (O), perinatal conditions (P), symptoms (R) and "factors
 * influencing health status" (Z). None of those is a disorder somebody lives
 * with, and offering them in a "what conditions do you have?" box is noise.
 * The disease chapters — A-N and Q — are 7,190 rows, and that is what seeds
 * this list.
 *
 * After that the list belongs to the super admin, so this seed only ever ADDS
 * names it has never seen. It does not update, and above all it does not
 * reactivate: deleting a disorder deactivates the row, and a seed that flipped
 * it back on every boot would make deletion pointless.
 *
 * Run with `npm run db:seed:disorders`.
 */

import { PrismaClient } from '@prisma/client';

/**
 * ICD chapters that describe a disease or condition.
 *
 * A-B infectious · C-D neoplasms and blood · E endocrine · F mental ·
 * G nervous · H eye and ear · I circulatory · J respiratory · K digestive ·
 * L skin · M musculoskeletal · N genitourinary · Q congenital.
 */
const DISEASE_CHAPTERS = /^[A-NQ]/;

function buildSearchTokens(name: string, code: string | null, keywords: string[]): string {
  return [name, code ?? '', ...keywords].filter(Boolean).join(' ').toLowerCase();
}

export async function seedDisorders(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();

  try {
    const [icd, existing] = await Promise.all([
      prisma.icdCode.findMany({
        where: { tenantId: null, isActive: true },
        select: { code: true, title: true, category: true, keywords: true },
        orderBy: { code: 'asc' },
      }),
      prisma.disorder.findMany({ where: { tenantId: null }, select: { name: true } }),
    ]);

    const source = icd.filter((c) => DISEASE_CHAPTERS.test(c.code));

    // 137 titles repeat across the neoplasm chapters — "Bladder" is a row under
    // malignant, benign AND uncertain neoplasms. On its own it is not a
    // disorder at all, so a repeated title is qualified with the block it
    // belongs to. Unique names are left exactly as ICD writes them.
    const titleCounts = new Map<string, number>();
    for (const c of source) titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);

    const seen = new Set(existing.map((d) => d.name));
    const rows: {
      tenantId: null;
      name: string;
      icdCode: string;
      category: string | null;
      keywords: string[];
      searchTokens: string;
      isCustom: boolean;
      isActive: boolean;
    }[] = [];

    for (const c of source) {
      const ambiguous = (titleCounts.get(c.title) ?? 0) > 1;
      const name = ambiguous && c.category ? `${c.title} — ${c.category}` : c.title;
      // Never added twice, and never re-added once the super admin has it.
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        tenantId: null,
        name,
        icdCode: c.code,
        category: c.category,
        keywords: c.keywords,
        searchTokens: buildSearchTokens(name, c.code, c.keywords),
        isCustom: false,
        isActive: true,
      });
    }

    if (!rows.length) {
      console.log(`Disorder list already current — ${existing.length} platform disorders.`);
      return;
    }

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await prisma.disorder.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    }
    console.log(
      `Disorders seeded — ${rows.length} added from ${source.length} ICD disease-chapter codes.`,
    );
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedDisorders()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
