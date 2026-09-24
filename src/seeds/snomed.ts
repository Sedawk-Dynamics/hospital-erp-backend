import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  SAMPLE_SNOMED_DESCRIPTIONS,
  SAMPLE_SNOMED_ICD_MAPS,
} from './data/snomed-sample';

/**
 * Seeds the SNOMED CT sample data — the search vocabulary (SnomedDescription)
 * and the SNOMED→ICD cross-map (SnomedIcdMap). Idempotent: rows are matched by
 * their RF2 source id and updated in place, so re-running (or the real RF2
 * import later) never duplicates.
 *
 *   npm run db:seed:snomed
 */
let prisma!: PrismaClient;

function buildSearchTokens(term: string, conceptId: string): string {
  return `${term} ${conceptId}`.toLowerCase();
}

async function main() {
  console.log(
    `Seeding SNOMED sample: ${SAMPLE_SNOMED_DESCRIPTIONS.length} descriptions, ${SAMPLE_SNOMED_ICD_MAPS.length} map rows...`,
  );

  let descCreated = 0;
  let descUpdated = 0;
  for (const d of SAMPLE_SNOMED_DESCRIPTIONS) {
    const data = {
      conceptId: d.conceptId,
      term: d.term,
      typeId: d.typeId,
      active: d.active ?? true,
      searchTokens: buildSearchTokens(d.term, d.conceptId),
    };
    const existing = await prisma.snomedDescription.findUnique({
      where: { descriptionId: d.descriptionId },
    });
    if (existing) {
      await prisma.snomedDescription.update({ where: { id: existing.id }, data });
      descUpdated++;
    } else {
      await prisma.snomedDescription.create({
        data: { descriptionId: d.descriptionId, ...data },
      });
      descCreated++;
    }
  }

  let mapCreated = 0;
  let mapUpdated = 0;
  for (const m of SAMPLE_SNOMED_ICD_MAPS) {
    const data = {
      referencedComponentId: m.referencedComponentId,
      mapGroup: m.mapGroup,
      mapPriority: m.mapPriority,
      mapRule: m.mapRule,
      mapAdvice: m.mapAdvice,
      mapTarget: m.mapTarget,
      active: m.active ?? true,
    };
    const existing = await prisma.snomedIcdMap.findUnique({
      where: { refsetMemberId: m.refsetMemberId },
    });
    if (existing) {
      await prisma.snomedIcdMap.update({ where: { id: existing.id }, data });
      mapUpdated++;
    } else {
      await prisma.snomedIcdMap.create({
        data: { refsetMemberId: m.refsetMemberId, ...data },
      });
      mapCreated++;
    }
  }

  console.log(
    `SNOMED seed complete — descriptions: ${descCreated} created / ${descUpdated} updated; maps: ${mapCreated} created / ${mapUpdated} updated.`,
  );
}

export async function seedSnomed(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedSnomed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
