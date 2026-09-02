/**
 * Seed the platform-wide SAC → GST reference (the tax master for SERVICES).
 *
 * The mirror of `hsn-gst-rates.ts`. HSN classifies goods; SAC classifies
 * services, and a hospital sells far more services than goods.
 *
 * Almost everything here is EXEMPT rather than zero-percent-taxable, which is
 * the distinction that matters: healthcare services supplied by a clinical
 * establishment are exempt under Notification 12/2017-Central Tax (Rate), and
 * exempt turnover is reported on its own return line and drives the monthly
 * input-credit reversal. Recording these as "0% taxable" would lose that.
 *
 * Matched by LONGEST PREFIX, so the 4-digit headings act as chapter-wide
 * defaults and the 6-digit entries override them for a specific service.
 *
 * Idempotent — upserts every row by its code, so re-running only refreshes
 * rates and never duplicates. Run with `npm run db:seed:sac-codes`.
 */

import { PrismaClient } from '@prisma/client';

let prisma!: PrismaClient;

/** Digits only, so "9993.12" and "9993 12" normalise the same way. */
const normSac = (s: string) => s.replace(/\D/g, '');

interface SacSeed {
  sac: string;
  gst: number;
  treatment: 'taxable' | 'exempt' | 'nil_rated';
  desc: string;
  category: 'healthcare' | 'accommodation' | 'food' | 'rental' | 'other';
}

const SAC_CODES: SacSeed[] = [
  // ── 9993 — Human health and social care services ──
  // The heading is the safe default for anything clinical that has not been
  // classified more precisely: exempt, because that is what healthcare is.
  { sac: '9993', gst: 0, treatment: 'exempt', desc: 'Human health and social care services', category: 'healthcare' },
  { sac: '999311', gst: 0, treatment: 'exempt', desc: 'Inpatient services', category: 'healthcare' },
  { sac: '999312', gst: 0, treatment: 'exempt', desc: 'Medical and dental services — consultation, OPD', category: 'healthcare' },
  { sac: '999313', gst: 0, treatment: 'exempt', desc: 'Childbirth and related services', category: 'healthcare' },
  { sac: '999314', gst: 0, treatment: 'exempt', desc: 'Nursing and physiotherapeutic services', category: 'healthcare' },
  { sac: '999315', gst: 0, treatment: 'exempt', desc: 'Ambulance services', category: 'healthcare' },
  { sac: '999316', gst: 0, treatment: 'exempt', desc: 'Medical laboratory and diagnostic-imaging services', category: 'healthcare' },
  { sac: '999317', gst: 0, treatment: 'exempt', desc: 'Blood, sperm and organ bank services', category: 'healthcare' },
  // The one healthcare code that is NOT automatically exempt. Cosmetic and
  // other non-therapeutic work sits here and is taxable; a hospital that does
  // any must flag the tariff, because the code alone cannot tell the two apart.
  { sac: '999319', gst: 18, treatment: 'taxable', desc: 'Other human health services — incl. cosmetic / non-therapeutic', category: 'healthcare' },

  // ── 9963 — Accommodation, food and beverage services ──
  // Room rent is exempt or 5% depending on the per-day rate and whether the bed
  // is critical care. The rule decides, not this row — the row exists so the
  // invoice can print a code against the line.
  { sac: '9963', gst: 0, treatment: 'exempt', desc: 'Accommodation, food and beverage services', category: 'accommodation' },
  { sac: '996311', gst: 0, treatment: 'exempt', desc: 'Room or unit accommodation services', category: 'accommodation' },
  { sac: '996332', gst: 5, treatment: 'taxable', desc: 'Canteen, cafeteria and restaurant services', category: 'food' },

  // ── Non-medical income a hospital commonly has ──
  { sac: '997212', gst: 18, treatment: 'taxable', desc: 'Renting of immovable property — shop or space rent', category: 'rental' },
  { sac: '997313', gst: 18, treatment: 'taxable', desc: 'Leasing or rental of medical equipment', category: 'rental' },
  { sac: '998729', gst: 18, treatment: 'taxable', desc: 'Maintenance and repair of medical equipment', category: 'other' },
  { sac: '996749', gst: 18, treatment: 'taxable', desc: 'Parking and other supporting transport services', category: 'other' },
];

async function main() {
  console.log('=== Seed SAC → GST reference (services tax master) ===');

  let upserts = 0;
  for (const r of SAC_CODES) {
    const sacCode = normSac(r.sac);
    await prisma.sacCode.upsert({
      where: { sacCode },
      create: {
        sacCode,
        gstRate: r.gst,
        treatment: r.treatment,
        description: r.desc,
        category: r.category,
        isActive: true,
      },
      update: {
        gstRate: r.gst,
        treatment: r.treatment,
        description: r.desc,
        category: r.category,
        isActive: true,
      },
    });
    upserts += 1;
  }

  console.log(`  SAC reference rows upserted: ${upserts}`);
}

export async function seedSacCodes(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedSacCodes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
