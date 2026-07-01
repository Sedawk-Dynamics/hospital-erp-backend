import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SEED_ICD_CODES } from '../modules/icd/icd.data';

/**
 * Seeds the platform-wide ICD-10 catalog (tenantId = null). Idempotent: an
 * existing platform code is updated in place, new ones are inserted. Hospital
 * custom codes (tenantId set) are never touched.
 *
 *   npm run db:seed:icd
 */
let prisma!: PrismaClient;

function buildSearchTokens(code: string, title: string, keywords: string[] = []): string {
  return [code, title, ...keywords].join(' ').toLowerCase();
}

async function main() {
  console.log(`Seeding ${SEED_ICD_CODES.length} platform ICD codes...`);
  let created = 0;
  let updated = 0;

  for (const entry of SEED_ICD_CODES) {
    const existing = await prisma.icdCode.findFirst({
      where: { tenantId: null, code: entry.code },
    });
    const data = {
      title: entry.title,
      category: entry.category,
      chapter: entry.chapter ?? null,
      keywords: entry.keywords ?? [],
      searchTokens: buildSearchTokens(entry.code, entry.title, entry.keywords),
      isBillable: true,
      isCustom: false,
      isActive: true,
    };

    if (existing) {
      await prisma.icdCode.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.icdCode.create({ data: { tenantId: null, code: entry.code, ...data } });
      created++;
    }
  }

  console.log(`ICD seed complete — created ${created}, updated ${updated}.`);
}

export async function seedIcdCodes(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedIcdCodes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
