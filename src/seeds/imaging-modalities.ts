/**
 * Seed the standard imaging modalities for every tenant as ServiceTariff rows
 * in the radiology category. These are the studies a doctor can pick from when
 * ordering imaging (and what the radiology admin manages in Settings).
 *
 * Idempotent — skips a modality if the tenant already has an active radiology
 * tariff with the same modality enum (so re-running won't create duplicates and
 * won't clobber prices the admin has since edited).
 *
 * Run with: npx tsx prisma/scripts/seed-imaging-modalities.ts
 *          (or via `npm run db:seed:imaging-modalities`)
 */

import { PrismaClient } from '@prisma/client';

let prisma!: PrismaClient;

// modality enum → default catalog entry. Prices are sensible starting points;
// the admin overrides them in Settings.
const MODALITIES: Array<{
  modality: 'xray' | 'ct_scan' | 'mri' | 'ultrasound' | 'ecg' | 'echo' | 'other';
  name: string;
  code: string;
  basePrice: number;
  gst: number;
}> = [
  { modality: 'xray', name: 'X-Ray', code: 'xray', basePrice: 300, gst: 0 },
  { modality: 'ct_scan', name: 'CT Scan', code: 'ct_scan', basePrice: 3000, gst: 0 },
  { modality: 'mri', name: 'MRI', code: 'mri', basePrice: 5000, gst: 0 },
  { modality: 'ultrasound', name: 'Ultrasound', code: 'ultrasound', basePrice: 800, gst: 0 },
  { modality: 'ecg', name: 'ECG', code: 'ecg', basePrice: 200, gst: 0 },
  { modality: 'echo', name: 'Echo', code: 'echo', basePrice: 1500, gst: 0 },
  { modality: 'other', name: 'Other Imaging', code: 'other-imaging', basePrice: 500, gst: 0 },
];

async function main() {
  console.log('=== Seed imaging modalities (radiology service tariffs) ===');

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`Found ${tenants.length} tenant(s)`);

  let created = 0;
  for (const tenant of tenants) {
    // What modalities does this tenant already have a radiology tariff for?
    const existing = await prisma.serviceTariff.findMany({
      where: { tenantId: tenant.id, category: 'radiology' as any },
      select: { modality: true, serviceCode: true },
    });
    const haveModality = new Set(existing.map((e) => e.modality).filter(Boolean) as string[]);
    const haveCode = new Set(existing.map((e) => (e.serviceCode ?? '').toLowerCase()).filter(Boolean));

    for (const m of MODALITIES) {
      if (haveModality.has(m.modality)) continue; // already offered
      // Avoid serviceCode collision (unique per tenant).
      const code = haveCode.has(m.code) ? `${m.code}-${Math.floor(Date.now() % 100000)}` : m.code;
      await prisma.serviceTariff.create({
        data: {
          tenantId: tenant.id,
          serviceName: m.name,
          serviceCode: code,
          category: 'radiology' as any,
          basePrice: m.basePrice,
          gstRatePercent: m.gst,
          modality: m.modality as any,
          isActive: true,
        },
      });
      created += 1;
      console.log(`  ${tenant.name ?? tenant.id}: + ${m.name}`);
    }
  }

  console.log(`=== done — created ${created} modality tariff row(s) ===`);
}

export async function seedImagingModalities(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedImagingModalities()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
