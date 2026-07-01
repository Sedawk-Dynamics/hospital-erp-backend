import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

let prisma!: PrismaClient;

// ─────────────────────────────────────────────────────────────
// Lab Unit Groups + Units (platform-global)
// ─────────────────────────────────────────────────────────────
// Two-tier hierarchy finalised in the 2026-05-23 meeting. Seeded as
// `isSystem: true` so the hospital admin UI can disable destructive actions
// on them (rename/sort allowed, delete blocked). Hospital-local groups +
// units sit alongside these and are freely editable.
//
// Stable `code` field is what `ParameterSpec.unitGroupCode` references.
// Within each group, the first entry is `isBase: true` and gets
// `conversionFactor: 1`. Other linear-conversion pairs ship a factor
// where it is well-defined (e.g. g/dL → mg/dL × 1000). When the SI ↔
// conventional conversion depends on molecular weight (most biochem
// analytes), we leave `conversionFactor` null — per the meeting the
// system does NOT perform automated unit conversion yet; the data
// hierarchy just sets up the next iteration.
//
// Idempotent: matched by (tenantId=null, code) for groups and
// (unitGroupId, symbol) for units, so re-runs pick up edits made here.
// ─────────────────────────────────────────────────────────────

type UnitSeed = {
  symbol: string;
  name?: string;
  conversionFactor?: number;
  isBase?: boolean;
};

type GroupSeed = {
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
  units: UnitSeed[];
};

const GROUPS: GroupSeed[] = [
  {
    code: 'concentration_mass',
    name: 'Concentration (mass)',
    description: 'Mass per volume — biochem analytes reported in conventional units.',
    sortOrder: 10,
    units: [
      { symbol: 'mg/dL', name: 'milligram per decilitre', isBase: true, conversionFactor: 1 },
      { symbol: 'g/dL', name: 'gram per decilitre', conversionFactor: 1000 },
      { symbol: 'µg/dL', name: 'microgram per decilitre', conversionFactor: 0.001 },
      { symbol: 'ng/dL', name: 'nanogram per decilitre', conversionFactor: 0.000001 },
      { symbol: 'mg/L', name: 'milligram per litre', conversionFactor: 0.1 },
      { symbol: 'g/L', name: 'gram per litre', conversionFactor: 100 },
      { symbol: 'µg/L', name: 'microgram per litre' },
      { symbol: 'ng/mL', name: 'nanogram per millilitre' },
      { symbol: 'pg/mL', name: 'picogram per millilitre' },
      { symbol: 'mg%', name: 'mg per 100 mL', conversionFactor: 1 },
    ],
  },
  {
    code: 'concentration_molar',
    name: 'Concentration (molar)',
    description: 'SI units (millimoles, micromoles) for biochem analytes.',
    sortOrder: 20,
    units: [
      { symbol: 'mmol/L', name: 'millimole per litre', isBase: true, conversionFactor: 1 },
      { symbol: 'µmol/L', name: 'micromole per litre', conversionFactor: 0.001 },
      { symbol: 'nmol/L', name: 'nanomole per litre', conversionFactor: 0.000001 },
      { symbol: 'pmol/L', name: 'picomole per litre', conversionFactor: 0.000000001 },
      { symbol: 'mEq/L', name: 'milliequivalent per litre' },
    ],
  },
  {
    code: 'hematology_counts',
    name: 'Hematology counts',
    description: 'Cell counts per volume (RBC, WBC, platelets, absolute differentials).',
    sortOrder: 30,
    units: [
      { symbol: '10^3/µL', name: 'thousand per microlitre', isBase: true, conversionFactor: 1 },
      { symbol: '10^6/µL', name: 'million per microlitre', conversionFactor: 1000 },
      { symbol: '10^9/L', name: '10⁹ per litre', conversionFactor: 1 },
      { symbol: '10^12/L', name: '10¹² per litre', conversionFactor: 1000 },
      { symbol: 'cells/µL', name: 'cells per microlitre', conversionFactor: 0.001 },
      { symbol: 'cells/HPF', name: 'cells per high-power field' },
      { symbol: 'cells/LPF', name: 'cells per low-power field' },
      { symbol: '/cumm', name: 'per cubic millimetre' },
    ],
  },
  {
    code: 'rbc_indices',
    name: 'RBC indices',
    description: 'Mean corpuscular volume (MCV) and mass (MCH).',
    sortOrder: 40,
    units: [
      { symbol: 'fL', name: 'femtolitre (MCV)', isBase: true, conversionFactor: 1 },
      { symbol: 'pg', name: 'picogram (MCH)' },
    ],
  },
  {
    code: 'percentages_ratios',
    name: 'Percentages & ratios',
    description: 'Dimensionless quantities — differentials, ratios, indices.',
    sortOrder: 50,
    units: [
      { symbol: '%', name: 'percent', isBase: true, conversionFactor: 1 },
      { symbol: 'ratio', name: 'ratio' },
      { symbol: 'index', name: 'index' },
    ],
  },
  {
    code: 'enzymes_activity',
    name: 'Enzymes & activity',
    description: 'Enzymatic activity (ALT, AST, ALP, GGT, LDH, amylase, lipase).',
    sortOrder: 60,
    units: [
      { symbol: 'U/L', name: 'units per litre', isBase: true, conversionFactor: 1 },
      { symbol: 'IU/L', name: 'international units per litre', conversionFactor: 1 },
      { symbol: 'IU/mL', name: 'international units per millilitre' },
      { symbol: 'mIU/L', name: 'milli-IU per litre' },
      { symbol: 'µIU/mL', name: 'micro-IU per millilitre' },
      { symbol: 'kU/L', name: 'kilo-units per litre', conversionFactor: 1000 },
    ],
  },
  {
    code: 'coagulation_rates',
    name: 'Coagulation & rates',
    description: 'PT/APTT (seconds), ESR, D-Dimer.',
    sortOrder: 70,
    units: [
      { symbol: 'seconds', name: 'seconds (PT/APTT/BT/CT)', isBase: true, conversionFactor: 1 },
      { symbol: 'mm/hr', name: 'mm per hour (ESR)' },
      { symbol: 'ng/mL FEU', name: 'ng/mL FEU (D-Dimer)' },
      { symbol: 'µg/mL FEU', name: 'µg/mL FEU' },
    ],
  },
  {
    code: 'renal_egfr',
    name: 'Renal / eGFR',
    description: 'Glomerular filtration rate units.',
    sortOrder: 80,
    units: [
      { symbol: 'mL/min', name: 'mL per minute', isBase: true, conversionFactor: 1 },
      { symbol: 'mL/min/1.73m²', name: 'mL/min normalised (eGFR)' },
    ],
  },
  {
    code: 'sg_ph',
    name: 'Specific gravity & pH',
    description: 'Urine SG, blood/urine pH.',
    sortOrder: 90,
    units: [
      { symbol: 'SG', name: 'specific gravity', isBase: true, conversionFactor: 1 },
      { symbol: 'pH', name: 'pH' },
    ],
  },
  {
    code: 'pressure_gas',
    name: 'Pressure / gas',
    description: 'ABG partial pressures.',
    sortOrder: 100,
    units: [
      { symbol: 'mmHg', name: 'millimetres of mercury', isBase: true, conversionFactor: 1 },
      { symbol: 'kPa', name: 'kilopascal', conversionFactor: 7.50062 },
    ],
  },
  {
    code: 'volume',
    name: 'Volume',
    description: 'Sample volumes, 24-hour urine volumes.',
    sortOrder: 110,
    units: [
      { symbol: 'mL', name: 'millilitre', isBase: true, conversionFactor: 1 },
      { symbol: 'L', name: 'litre', conversionFactor: 1000 },
      { symbol: 'mL/24h', name: 'mL per 24 hours' },
    ],
  },
  {
    code: 'titres_serology',
    name: 'Titres / serology',
    description: 'Serological titres and cut-off indices.',
    sortOrder: 120,
    units: [
      { symbol: 'titre', name: 'titre (e.g. 1:80)', isBase: true, conversionFactor: 1 },
      { symbol: 'COI', name: 'cut-off index' },
      { symbol: 'S/CO', name: 'signal-to-cutoff' },
      { symbol: 'AU/mL', name: 'arbitrary units per millilitre' },
    ],
  },
];

async function upsertGroup(seed: GroupSeed) {
  const existing = await prisma.labUnitGroup.findFirst({
    where: { tenantId: null, code: seed.code },
  });
  const group = existing
    ? await prisma.labUnitGroup.update({
        where: { id: existing.id },
        data: {
          name: seed.name,
          description: seed.description ?? null,
          sortOrder: seed.sortOrder,
          isSystem: true,
        },
      })
    : await prisma.labUnitGroup.create({
        data: {
          tenantId: null,
          code: seed.code,
          name: seed.name,
          description: seed.description ?? null,
          sortOrder: seed.sortOrder,
          isSystem: true,
        },
      });

  let order = 0;
  for (const u of seed.units) {
    order += 1;
    const existingUnit = await prisma.labUnit.findFirst({
      where: { unitGroupId: group.id, symbol: u.symbol },
    });
    const data = {
      symbol: u.symbol,
      name: u.name ?? null,
      conversionFactor: u.conversionFactor != null ? new Prisma.Decimal(u.conversionFactor) : null,
      isBase: !!u.isBase,
      sortOrder: order,
      isSystem: true,
    } as const;
    if (existingUnit) {
      await prisma.labUnit.update({ where: { id: existingUnit.id }, data });
    } else {
      await prisma.labUnit.create({
        data: {
          tenantId: null,
          unitGroupId: group.id,
          ...data,
        },
      });
    }
  }

  // Guarantee exactly one base unit per group (in case isBase was edited).
  const bases = await prisma.labUnit.findMany({
    where: { unitGroupId: group.id, isBase: true },
    select: { id: true },
  });
  if (bases.length > 1) {
    await prisma.labUnit.updateMany({
      where: { unitGroupId: group.id, isBase: true, id: { not: bases[0].id } },
      data: { isBase: false },
    });
  }
  return group;
}

async function main() {
  console.log('🌱  Seeding lab unit groups + units (global)…');
  let groupCount = 0;
  let unitCount = 0;
  for (const g of GROUPS) {
    await upsertGroup(g);
    groupCount += 1;
    unitCount += g.units.length;
  }
  console.log(`✅  Seeded ${groupCount} unit groups, ${unitCount} units total.`);
}

export async function seedLabUnits(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedLabUnits()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
