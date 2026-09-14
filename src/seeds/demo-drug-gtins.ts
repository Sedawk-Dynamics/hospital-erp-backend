/**
 * Seed a set of well-known medicines into the platform DrugMaster catalog with a
 * VALID GTIN (EAN-13, India "890" prefix, correct GS1 check digit), full product
 * identity, HSN and GST — so barcode/GTIN resolution can be tested end to end.
 *
 * Honest note: these GTINs are structurally valid and India-prefixed, but they
 * are DEMO codes generated deterministically here — not scraped from real packs
 * (there is no free, authoritative brand→GTIN dataset). Swap in a real GTIN any
 * time by editing the row in Super-admin → Drug Master.
 *
 * A GTIN identifies the PRODUCT (brand + strength + pack), so it is set once on
 * the drug — NOT per batch. Batch number / expiry / serial vary per batch and are
 * read from the pack's GS1 2D barcode, never from the GTIN itself. A few rows
 * also carry a case-pack GTIN-14 (outer carton) + unitsPerCase to demo that one
 * medicine legitimately has more than one barcode (consumer strip vs outer case).
 *
 * Idempotent — upserts by exact name. Run with `npm run db:seed:demo-gtins`.
 */

import { PrismaClient } from '@prisma/client';

let prisma!: PrismaClient;

// Universal GS1 mod-10 check digit (works for EAN-13 over 12 data digits and
// GTIN-14 over 13). Weights alternate 3,1,3,1… from the RIGHTMOST data digit.
function gs1Check(data: string): string {
  let sum = 0;
  for (let j = 0; j < data.length; j++) {
    const d = data.charCodeAt(data.length - 1 - j) - 48;
    sum += j % 2 === 0 ? d * 3 : d;
  }
  return String((10 - (sum % 10)) % 10);
}
const ean13 = (base12: string) => base12 + gs1Check(base12);
const gtin14 = (base13: string) => base13 + gs1Check(base13);

type Form = 'tablet' | 'capsule' | 'syrup' | 'injection' | 'cream' | 'drops' | 'inhaler' | 'other';

interface DemoDrug {
  name: string;
  generic: string;
  manufacturer: string;
  strength: string;
  form: Form;
  packLabel: string;
  packSize: number | null;
  hsn: string;
  gst: number;
  // true → also give it an outer-case GTIN-14 + unitsPerCase.
  casePack?: number;
}

// 20 recognisable Indian brands spanning the GST slabs (5% most, 0% ORS, 18%
// nutraceutical). Order is stable — the GTIN is derived from the index.
const DRUGS: DemoDrug[] = [
  { name: 'Crocin Advance 500 Tablet', generic: 'Paracetamol', manufacturer: 'GSK', strength: '500mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5, casePack: 300 },
  { name: 'Dolo 650 Tablet', generic: 'Paracetamol', manufacturer: 'Micro Labs', strength: '650mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Calpol 500 Tablet', generic: 'Paracetamol', manufacturer: 'GSK', strength: '500mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Mox 500 Capsule', generic: 'Amoxicillin', manufacturer: 'Sun Pharma', strength: '500mg', form: 'capsule', packLabel: 'Strip of 10 capsules', packSize: 10, hsn: '30041020', gst: 5, casePack: 200 },
  { name: 'Augmentin 625 Duo Tablet', generic: 'Amoxicillin + Clavulanic Acid', manufacturer: 'GSK', strength: '625mg', form: 'tablet', packLabel: 'Strip of 10 tablets', packSize: 10, hsn: '30041020', gst: 5 },
  { name: 'Azithral 500 Tablet', generic: 'Azithromycin', manufacturer: 'Alembic', strength: '500mg', form: 'tablet', packLabel: 'Strip of 5 tablets', packSize: 5, hsn: '30042099', gst: 5 },
  { name: 'Azee 500 Tablet', generic: 'Azithromycin', manufacturer: 'Cipla', strength: '500mg', form: 'tablet', packLabel: 'Strip of 3 tablets', packSize: 3, hsn: '30042099', gst: 5 },
  { name: 'Pan 40 Tablet', generic: 'Pantoprazole', manufacturer: 'Alkem', strength: '40mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Pan-D Capsule', generic: 'Pantoprazole + Domperidone', manufacturer: 'Alkem', strength: '40mg', form: 'capsule', packLabel: 'Strip of 15 capsules', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Glycomet 500 Tablet', generic: 'Metformin', manufacturer: 'USV', strength: '500mg', form: 'tablet', packLabel: 'Strip of 20 tablets', packSize: 20, hsn: '30049099', gst: 5, casePack: 400 },
  { name: 'Amlong 5 Tablet', generic: 'Amlodipine', manufacturer: 'Micro Labs', strength: '5mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Telma 40 Tablet', generic: 'Telmisartan', manufacturer: 'Glenmark', strength: '40mg', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '30049099', gst: 5 },
  { name: 'Ecosprin 75 Tablet', generic: 'Aspirin', manufacturer: 'USV', strength: '75mg', form: 'tablet', packLabel: 'Strip of 14 tablets', packSize: 14, hsn: '30049099', gst: 5 },
  { name: 'Cetzine 10 Tablet', generic: 'Cetirizine', manufacturer: "Dr Reddy's", strength: '10mg', form: 'tablet', packLabel: 'Strip of 10 tablets', packSize: 10, hsn: '30049099', gst: 5 },
  { name: 'Allegra 120 Tablet', generic: 'Fexofenadine', manufacturer: 'Sanofi', strength: '120mg', form: 'tablet', packLabel: 'Strip of 10 tablets', packSize: 10, hsn: '30049099', gst: 5 },
  { name: 'Huminsulin R 40IU Injection', generic: 'Human Insulin', manufacturer: 'Eli Lilly', strength: '40IU/ml', form: 'injection', packLabel: 'Vial of 10ml', packSize: null, hsn: '30043110', gst: 5 },
  { name: 'Electral ORS Powder', generic: 'Oral Rehydration Salts', manufacturer: 'FDC', strength: '21.8g', form: 'other', packLabel: 'Sachet of 21.8g', packSize: null, hsn: '30049010', gst: 5 },
  { name: 'Ascoril LS Syrup', generic: 'Ambroxol + Levosalbutamol + Guaifenesin', manufacturer: 'Glenmark', strength: '100ml', form: 'syrup', packLabel: 'Bottle of 100ml', packSize: null, hsn: '30049099', gst: 5 },
  { name: 'Volini Gel', generic: 'Diclofenac Diethylamine', manufacturer: 'Sun Pharma', strength: '30g', form: 'cream', packLabel: 'Tube of 30g', packSize: null, hsn: '30049099', gst: 5 },
  { name: 'Supradyn Daily Tablet', generic: 'Multivitamin + Multimineral', manufacturer: 'Bayer', strength: 'Once daily', form: 'tablet', packLabel: 'Strip of 15 tablets', packSize: 15, hsn: '21069099', gst: 18 },
];

// Deterministic 12-digit base per drug → valid EAN-13. India GS1 prefix "890".
const baseFor = (i: number) => `890101${String(200001 + i).padStart(6, '0')}`;

async function main() {
  console.log('=== Seed demo medicines with valid GTINs ===');
  const emitted: Array<Record<string, unknown>> = [];
  let created = 0;
  let updated = 0;

  for (let i = 0; i < DRUGS.length; i++) {
    const d = DRUGS[i];
    const base = baseFor(i);
    const gtin = ean13(base);
    const casePackGtin = d.casePack ? gtin14('1' + base) : null;
    const searchTokens = `${d.name} ${d.generic} ${d.manufacturer}`.toLowerCase();

    const data = {
      genericName: d.generic,
      manufacturer: d.manufacturer,
      dosageForm: d.form as never,
      strength: d.strength,
      packSizeLabel: d.packLabel,
      packSize: d.packSize,
      hsnCode: d.hsn,
      gstRate: d.gst,
      gtin,
      casePackGtin,
      unitsPerCase: d.casePack ?? null,
      isPublished: true,
      searchTokens,
    };

    const existing = await prisma.drugMaster.findFirst({
      where: { name: { equals: d.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      await prisma.drugMaster.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.drugMaster.create({ data: { name: d.name, ...data } });
      created += 1;
    }

    emitted.push({
      name: d.name, generic: d.generic, manufacturer: d.manufacturer, strength: d.strength,
      form: d.form, packLabel: d.packLabel, packSize: d.packSize, hsn: d.hsn, gst: d.gst,
      gtin, casePackGtin, unitsPerCase: d.casePack ?? null,
    });
    console.log(`  ${gtin}${casePackGtin ? ` (case ${casePackGtin})` : ''}  ${d.name} — HSN ${d.hsn} ${d.gst}%`);
  }

  console.log(`=== done — ${created} created, ${updated} updated ===`);
  // Machine-readable dump so the test-sheet generator can reuse the exact GTINs.
  console.log('__DEMO_GTINS_JSON__' + JSON.stringify(emitted));
}

export async function seedDemoDrugGtins(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedDemoDrugGtins()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
