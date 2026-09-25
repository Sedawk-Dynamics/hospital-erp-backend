import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SAMPLE_LOINC_CATALOG } from './data/loinc-sample';

/**
 * Seeds the LOINC catalog sample data (the search dictionary the /loinc/search
 * endpoint reads). Idempotent: rows are matched by their loincCode and updated
 * in place, so re-running — or the real LOINC release import later — never
 * duplicates.
 *
 *   npm run db:seed:loinc
 */
let prisma!: PrismaClient;

async function main() {
  console.log(`Seeding LOINC sample: ${SAMPLE_LOINC_CATALOG.length} catalog rows...`);

  let created = 0;
  let updated = 0;
  for (const l of SAMPLE_LOINC_CATALOG) {
    const data = {
      displayName: l.displayName,
      component: l.component,
      property: l.property,
      timeAspect: l.timeAspect,
      system: l.system,
      scaleType: l.scaleType,
      method: l.method,
      status: l.status ?? 'ACTIVE',
      synonyms: l.synonyms ?? [],
      keywords: l.keywords ?? [],
    };
    const existing = await prisma.loincCatalog.findUnique({
      where: { loincCode: l.loincCode },
    });
    if (existing) {
      await prisma.loincCatalog.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.loincCatalog.create({
        data: { loincCode: l.loincCode, ...data },
      });
      created++;
    }
  }

  console.log(`LOINC seed complete — ${created} created / ${updated} updated.`);
}

export async function seedLoinc(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedLoinc().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
