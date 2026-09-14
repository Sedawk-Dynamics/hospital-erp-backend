/**
 * Seed the platform-wide HSN → GST reference (the tax master) and tag a handful
 * of common medicines in the drug catalog with their HSN code + GST rate.
 *
 * Why this exists: in India the GST rate on a medicine is legally decided by its
 * HSN code. This table is the single source of truth that turns an HSN code into
 * a rate, so that at stock inward the operator can just enter/scan the HSN and
 * the correct GST auto-fills (longest-prefix match — an 8-digit tariff item wins
 * over its 4-digit chapter heading).
 *
 * Rates below follow the GST 2.0 rationalisation effective 22 September 2025:
 * most medicaments (Chapter 30) moved from 12% to 5%, notified life-saving drugs
 * Named notification exemptions are stored on the medicine itself; a few
 * items (nutraceuticals, nicotine gum) sit at 18%.
 * They are a sensible, editable starting point — a hospital can override any row
 * (the reference is platform data, like the ICD/drug catalogs).
 *
 * Idempotent — upserts every row by its HSN code, so re-running only refreshes
 * rates and never duplicates. Run with `npm run db:seed:hsn-gst`.
 */

import { PrismaClient } from '@prisma/client';

let prisma!: PrismaClient;

// Strip everything but digits so "3004.90.99" / "3004 9099" all normalise the
// same way (matches the lookup helper in drug-master.service.ts).
const normHsn = (s: string) => s.replace(/\D/g, '');

interface HsnSeed {
  hsn: string;
  gst: number;
  desc: string;
  category: 'medicine' | 'consumable' | 'device' | 'supplement';
  /**
   * What kind of zero a zero is. Omitted means 'taxable' — the rate carries it.
   * A zero-rated row has to say whether it is nil by tariff or exempt by
   * notification, because GSTR-1 and GSTR-3B report those on separate lines.
   */
  treatment?: 'taxable' | 'nil_rated' | 'exempt';
}

// 4-digit headings are chapter-wide defaults; 6/8-digit entries override them for
// specific tariff items may override their chapter heading.
const HSN_RATES: HsnSeed[] = [
  // ── Chapter 30 — pharmaceutical products (heading-level defaults) ──
  { hsn: '3001', gst: 5, desc: 'Glands & organs, heparin (organo-therapeutic uses)', category: 'medicine' },
  { hsn: '3002', gst: 5, desc: 'Human/animal blood, antisera, vaccines, cultures of micro-organisms', category: 'medicine' },
  { hsn: '3003', gst: 5, desc: 'Medicaments of two or more constituents, not in measured doses / not for retail', category: 'medicine' },
  { hsn: '3004', gst: 5, desc: 'Medicaments (mixed or unmixed) in measured doses or retail packing', category: 'medicine' },
  { hsn: '3005', gst: 5, desc: 'Wadding, gauze, bandages & similar dressings', category: 'consumable' },
  { hsn: '3006', gst: 5, desc: 'Pharmaceutical goods — surgical catgut, blood-grouping reagents, etc.', category: 'consumable' },
  // ── Specific tariff items that override the heading default ──
  { hsn: '30049010', gst: 5, desc: 'Oral Rehydration Salts (ORS)', category: 'medicine', treatment: 'taxable' },
  { hsn: '30043110', gst: 5, desc: 'Insulin injections', category: 'medicine' },
  // ── Medical devices / diagnostics / consumables. GST 2.0 cut virtually all of
  //    Chapter 90 (and surgical gloves / diagnostic kits) from 12/18% to 5%. ──
  { hsn: '9018', gst: 5, desc: 'Medical/surgical/dental instruments — syringes, needles, catheters', category: 'device' },
  { hsn: '9021', gst: 5, desc: 'Orthopaedic appliances, splints, implants, hearing aids', category: 'device' },
  { hsn: '9022', gst: 5, desc: 'X-ray / imaging apparatus & tubes', category: 'device' },
  { hsn: '3822', gst: 5, desc: 'Diagnostic / laboratory reagents & in-vitro test kits', category: 'device' },
  { hsn: '4015', gst: 5, desc: 'Surgical / examination gloves (vulcanised rubber)', category: 'consumable' },
  // ── 18% slab — nutraceuticals & nicotine replacement (not "medicaments") ──
  { hsn: '2106', gst: 18, desc: 'Food preparations / dietary supplements (nutraceuticals)', category: 'supplement' },
  { hsn: '21069099', gst: 18, desc: 'Nutraceuticals / health supplements — other', category: 'supplement' },
  { hsn: '24039990', gst: 18, desc: 'Nicotine polacrilex (nicotine replacement gum)', category: 'supplement' },
];

// Common medicines to tag in the platform DrugMaster catalog with a real HSN +
// GST, so a catalog pick at inward carries both. Matched to an existing brand by
// generic name where possible; a canonical row is created only on a database
// with no vendor catalogue (see main).
// Only the DosageForm enum values the schema allows (no 'powder' — ORS maps to 'other').
type DosageFormValue = 'tablet' | 'capsule' | 'syrup' | 'injection' | 'cream' | 'drops' | 'inhaler' | 'other';

interface DrugSeed {
  name: string;
  generic: string;
  dosageForm: DosageFormValue;
  strength: string;
  hsn: string;
  gst: number;
}

const DRUG_TAGS: DrugSeed[] = [
  { name: 'Paracetamol 500mg Tablet', generic: 'Paracetamol', dosageForm: 'tablet', strength: '500mg', hsn: '30049099', gst: 5 },
  { name: 'Amoxicillin 500mg Capsule', generic: 'Amoxicillin', dosageForm: 'capsule', strength: '500mg', hsn: '30041020', gst: 5 },
  { name: 'Azithromycin 500mg Tablet', generic: 'Azithromycin', dosageForm: 'tablet', strength: '500mg', hsn: '30042099', gst: 5 },
  { name: 'Metformin 500mg Tablet', generic: 'Metformin', dosageForm: 'tablet', strength: '500mg', hsn: '30049099', gst: 5 },
  { name: 'Human Insulin 40IU/ml Injection', generic: 'Insulin', dosageForm: 'injection', strength: '40IU/ml', hsn: '30043110', gst: 5 },
  { name: 'ORS Powder (Oral Rehydration Salts)', generic: 'Oral Rehydration Salts', dosageForm: 'other', strength: '21.8g/L', hsn: '30049010', gst: 5 },
];

async function main() {
  console.log('=== Seed HSN → GST reference + tag common medicines ===');

  // 1) HSN → GST reference table (the tax master).
  let refUpserts = 0;
  for (const r of HSN_RATES) {
    const hsnCode = normHsn(r.hsn);
    await prisma.hsnGstRate.upsert({
      where: { hsnCode },
      create: {
        hsnCode,
        gstRate: r.gst,
        treatment: r.treatment ?? (r.gst > 0 ? 'taxable' : 'nil_rated'),
        description: r.desc,
        category: r.category,
        isActive: true,
      },
      update: {
        gstRate: r.gst,
        treatment: r.treatment ?? (r.gst > 0 ? 'taxable' : 'nil_rated'),
        description: r.desc,
        category: r.category,
        isActive: true,
      },
    });
    refUpserts += 1;
  }
  console.log(`  HSN reference: ${refUpserts} rate(s) upserted`);

  // 2) Tag common medicines in the DrugMaster catalog with HSN + GST.
  //
  // A canonical row is invented only where there is no vendor catalogue. Where
  // there is one, a row with no Product ID and no author is exactly how the
  // release recognises the old open dataset: an invented row would be retired
  // by the next release and re-created by the next boot, unlinking any
  // formulary row that had picked it in between. Two of the six never match —
  // the vendor spells it "Amoxycillin", and lists ORS only as branded OTC
  // products with no generic name.
  const vendorCatalogue = await prisma.drugMaster.findFirst({
    where: { sourceId: { not: null } },
    select: { id: true },
  });
  let tagged = 0;
  let kept = 0;
  let created = 0;
  let absent = 0;
  for (const d of DRUG_TAGS) {
    // The catalogue brand this medicine resolves to: its exact name, else the
    // first brand of the generic. Deterministic, so every boot lands on the
    // same row.
    const existing = await prisma.drugMaster.findFirst({
      where: {
        OR: [
          { name: { equals: d.name, mode: 'insensitive' } },
          { genericName: { contains: d.generic, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, hsnCode: true },
    });

    if (existing?.hsnCode) {
      // Filled only while blank. This used to overwrite the code on every
      // boot, so one a platform admin had corrected came back the next start.
      kept += 1;
    } else if (existing) {
      await prisma.drugMaster.update({
        where: { id: existing.id },
        data: { hsnCode: normHsn(d.hsn), gstRate: d.gst },
      });
      tagged += 1;
      console.log(`  tagged catalog drug: ${existing.name} → HSN ${d.hsn}, ${d.gst}% GST`);
    } else if (vendorCatalogue) {
      absent += 1;
      console.log(`  not in the catalogue, left untagged: ${d.name}`);
    } else {
      // No catalogue at all — create a canonical row so the data exists and the
      // feature is demoable on any DB.
      await prisma.drugMaster.create({
        data: {
          name: d.name,
          genericName: d.generic,
          dosageForm: d.dosageForm,
          strength: d.strength,
          hsnCode: normHsn(d.hsn),
          gstRate: d.gst,
          isPublished: true,
          searchTokens: `${d.name} ${d.generic}`.toLowerCase(),
        },
      });
      created += 1;
      console.log(`  created catalog drug: ${d.name} → HSN ${d.hsn}, ${d.gst}% GST`);
    }
  }
  console.log(`  Medicines: ${tagged} tagged, ${created} created, ${absent} not in the catalogue`);
  console.log('=== done ===');
}

export async function seedHsnGstRates(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedHsnGstRates()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
