import 'dotenv/config';
import { PrismaClient, PhysicalObservationSystem } from '@prisma/client';

let prisma!: PrismaClient;

type Seed = { system: PhysicalObservationSystem; name: string; description?: string };

const OBSERVATIONS: Seed[] = [
  // General
  { system: 'general', name: 'Alert and oriented, no acute distress' },
  { system: 'general', name: 'Cachectic appearance' },
  { system: 'general', name: 'Pallor' },
  { system: 'general', name: 'Icterus / jaundice' },
  { system: 'general', name: 'Cyanosis' },

  // Cardiovascular
  { system: 'cardiovascular', name: 'Normal S1/S2, no murmurs' },
  { system: 'cardiovascular', name: 'Systolic murmur' },
  { system: 'cardiovascular', name: 'Tachycardia' },
  { system: 'cardiovascular', name: 'Pedal edema' },

  // Respiratory
  { system: 'respiratory', name: 'Bilateral air entry equal, clear' },
  { system: 'respiratory', name: 'Wheezing on chest auscultation' },
  { system: 'respiratory', name: 'Crepitations / crackles' },
  { system: 'respiratory', name: 'Reduced breath sounds' },
  { system: 'respiratory', name: 'Tachypnea' },

  // Gastrointestinal
  { system: 'gastrointestinal', name: 'Abdomen soft, non-tender' },
  { system: 'gastrointestinal', name: 'Abdominal tenderness' },
  { system: 'gastrointestinal', name: 'Hepatomegaly' },
  { system: 'gastrointestinal', name: 'Ascites' },

  // Neurological
  { system: 'neurological', name: 'GCS 15, no focal deficits' },
  { system: 'neurological', name: 'Altered sensorium' },
  { system: 'neurological', name: 'Hemiparesis' },
  { system: 'neurological', name: 'Slurred speech' },

  // Musculoskeletal
  { system: 'musculoskeletal', name: 'Full range of motion, no deformity' },
  { system: 'musculoskeletal', name: 'Joint swelling and tenderness' },

  // Skin
  { system: 'skin', name: 'Skin intact, no rashes' },
  { system: 'skin', name: 'Pressure ulcer noted' },

  // ENT
  { system: 'ent', name: 'Throat congestion' },

  // Eye
  { system: 'eye', name: 'Pupils equal and reactive to light' },

  // Genitourinary
  { system: 'genitourinary', name: 'Costovertebral angle tenderness' },

  // Psychiatric
  { system: 'psychiatric', name: 'Anxious affect' },
];

async function main() {
  console.log(`Seeding ${OBSERVATIONS.length} global physical observation catalog entries...`);
  let created = 0;
  let skipped = 0;
  for (const o of OBSERVATIONS) {
    const existing = await prisma.physicalObservationCatalog.findFirst({
      where: { tenantId: null, system: o.system, name: o.name },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.physicalObservationCatalog.create({
      data: {
        tenantId: null,
        system: o.system,
        name: o.name,
        description: o.description,
        isGlobal: true,
        isActive: true,
      },
    });
    created++;
  }
  console.log(`  ✓ ${created} created, ${skipped} already present`);
}

export async function seedPhysicalObservations(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedPhysicalObservations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
