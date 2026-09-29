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
  // Canonical UCUM code (http://unitsofmeasure.org) for this display symbol.
  // null when the symbol has no valid UCUM equivalent.
  ucumCode?: string | null;
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
      { symbol: 'mg/dL', name: 'milligram per decilitre', ucumCode: 'mg/dL', isBase: true, conversionFactor: 1 },
      { symbol: 'g/dL', name: 'gram per decilitre', ucumCode: 'g/dL', conversionFactor: 1000 },
      { symbol: 'µg/dL', name: 'microgram per decilitre', ucumCode: 'ug/dL', conversionFactor: 0.001 },
      { symbol: 'ng/dL', name: 'nanogram per decilitre', ucumCode: 'ng/dL', conversionFactor: 0.000001 },
      { symbol: 'mg/L', name: 'milligram per litre', ucumCode: 'mg/L', conversionFactor: 0.1 },
      { symbol: 'g/L', name: 'gram per litre', ucumCode: 'g/L', conversionFactor: 100 },
      { symbol: 'µg/L', name: 'microgram per litre', ucumCode: 'ug/L' },
      { symbol: 'ng/mL', name: 'nanogram per millilitre', ucumCode: 'ng/mL' },
      { symbol: 'pg/mL', name: 'picogram per millilitre', ucumCode: 'pg/mL' },
      { symbol: 'mg%', name: 'mg per 100 mL', ucumCode: 'mg/dL', conversionFactor: 1 },
    ],
  },
  {
    code: 'concentration_molar',
    name: 'Concentration (molar)',
    description: 'SI units (millimoles, micromoles) for biochem analytes.',
    sortOrder: 20,
    units: [
      { symbol: 'mmol/L', name: 'millimole per litre', ucumCode: 'mmol/L', isBase: true, conversionFactor: 1 },
      { symbol: 'µmol/L', name: 'micromole per litre', ucumCode: 'umol/L', conversionFactor: 0.001 },
      { symbol: 'nmol/L', name: 'nanomole per litre', ucumCode: 'nmol/L', conversionFactor: 0.000001 },
      { symbol: 'pmol/L', name: 'picomole per litre', ucumCode: 'pmol/L', conversionFactor: 0.000000001 },
      { symbol: 'mEq/L', name: 'milliequivalent per litre', ucumCode: 'meq/L' },
    ],
  },
  {
    code: 'hematology_counts',
    name: 'Hematology counts',
    description: 'Cell counts per volume (RBC, WBC, platelets, absolute differentials).',
    sortOrder: 30,
    units: [
      { symbol: '10^3/µL', name: 'thousand per microlitre', ucumCode: '10*3/uL', isBase: true, conversionFactor: 1 },
      { symbol: '10^6/µL', name: 'million per microlitre', ucumCode: '10*6/uL', conversionFactor: 1000 },
      { symbol: '10^9/L', name: '10⁹ per litre', ucumCode: '10*9/L', conversionFactor: 1 },
      { symbol: '10^12/L', name: '10¹² per litre', ucumCode: '10*12/L', conversionFactor: 1000 },
      { symbol: 'cells/µL', name: 'cells per microlitre', ucumCode: '/uL', conversionFactor: 0.001 },
      { symbol: 'cells/HPF', name: 'cells per high-power field', ucumCode: '/[HPF]' },
      { symbol: 'cells/LPF', name: 'cells per low-power field', ucumCode: '/[LPF]' },
      { symbol: '/cumm', name: 'per cubic millimetre', ucumCode: '/mm3' },
    ],
  },
  {
    code: 'rbc_indices',
    name: 'RBC indices',
    description: 'Mean corpuscular volume (MCV) and mass (MCH).',
    sortOrder: 40,
    units: [
      { symbol: 'fL', name: 'femtolitre (MCV)', ucumCode: 'fL', isBase: true, conversionFactor: 1 },
      { symbol: 'pg', name: 'picogram (MCH)', ucumCode: 'pg' },
    ],
  },
  {
    code: 'percentages_ratios',
    name: 'Percentages & ratios',
    description: 'Dimensionless quantities — differentials, ratios, indices.',
    sortOrder: 50,
    units: [
      { symbol: '%', name: 'percent', ucumCode: '%', isBase: true, conversionFactor: 1 },
      { symbol: 'ratio', name: 'ratio', ucumCode: '{ratio}' },
      { symbol: 'index', name: 'index', ucumCode: '{index}' },
    ],
  },
  {
    code: 'enzymes_activity',
    name: 'Enzymes & activity',
    description: 'Enzymatic activity (ALT, AST, ALP, GGT, LDH, amylase, lipase).',
    sortOrder: 60,
    units: [
      { symbol: 'U/L', name: 'units per litre', ucumCode: 'U/L', isBase: true, conversionFactor: 1 },
      { symbol: 'IU/L', name: 'international units per litre', ucumCode: '[IU]/L', conversionFactor: 1 },
      { symbol: 'IU/mL', name: 'international units per millilitre', ucumCode: '[IU]/mL' },
      { symbol: 'mIU/L', name: 'milli-IU per litre', ucumCode: 'm[IU]/L' },
      { symbol: 'µIU/mL', name: 'micro-IU per millilitre', ucumCode: 'u[IU]/mL' },
      { symbol: 'kU/L', name: 'kilo-units per litre', ucumCode: 'kU/L', conversionFactor: 1000 },
    ],
  },
  {
    code: 'coagulation_rates',
    name: 'Coagulation & rates',
    description: 'PT/APTT (seconds), ESR, D-Dimer.',
    sortOrder: 70,
    units: [
      { symbol: 'seconds', name: 'seconds (PT/APTT/BT/CT)', ucumCode: 's', isBase: true, conversionFactor: 1 },
      { symbol: 'mm/hr', name: 'mm per hour (ESR)', ucumCode: 'mm/h' },
      { symbol: 'ng/mL FEU', name: 'ng/mL FEU (D-Dimer)', ucumCode: 'ng/mL{FEU}' },
      { symbol: 'µg/mL FEU', name: 'µg/mL FEU', ucumCode: 'ug/mL{FEU}' },
    ],
  },
  {
    code: 'renal_egfr',
    name: 'Renal / eGFR',
    description: 'Glomerular filtration rate units.',
    sortOrder: 80,
    units: [
      { symbol: 'mL/min', name: 'mL per minute', ucumCode: 'mL/min', isBase: true, conversionFactor: 1 },
      { symbol: 'mL/min/1.73m²', name: 'mL/min normalised (eGFR)', ucumCode: 'mL/min/{1.73_m2}' },
    ],
  },
  {
    code: 'sg_ph',
    name: 'Specific gravity & pH',
    description: 'Urine SG, blood/urine pH.',
    sortOrder: 90,
    units: [
      { symbol: 'SG', name: 'specific gravity', ucumCode: '{SG}', isBase: true, conversionFactor: 1 },
      { symbol: 'pH', name: 'pH', ucumCode: '[pH]' },
    ],
  },
  {
    code: 'pressure_gas',
    name: 'Pressure / gas',
    description: 'ABG partial pressures.',
    sortOrder: 100,
    units: [
      { symbol: 'mmHg', name: 'millimetres of mercury', ucumCode: 'mm[Hg]', isBase: true, conversionFactor: 1 },
      { symbol: 'kPa', name: 'kilopascal', ucumCode: 'kPa', conversionFactor: 7.50062 },
    ],
  },
  {
    code: 'volume',
    name: 'Volume',
    description: 'Sample volumes, 24-hour urine volumes.',
    sortOrder: 110,
    units: [
      { symbol: 'mL', name: 'millilitre', ucumCode: 'mL', isBase: true, conversionFactor: 1 },
      { symbol: 'L', name: 'litre', ucumCode: 'L', conversionFactor: 1000 },
      { symbol: 'mL/24h', name: 'mL per 24 hours', ucumCode: 'mL/(24.h)' },
    ],
  },
  {
    code: 'titres_serology',
    name: 'Titres / serology',
    description: 'Serological titres and cut-off indices.',
    sortOrder: 120,
    units: [
      { symbol: 'titre', name: 'titre (e.g. 1:80)', ucumCode: '{titre}', isBase: true, conversionFactor: 1 },
      { symbol: 'COI', name: 'cut-off index', ucumCode: '{COI}' },
      { symbol: 'S/CO', name: 'signal-to-cutoff', ucumCode: '{S_CO}' },
      { symbol: 'AU/mL', name: 'arbitrary units per millilitre', ucumCode: "[arb'U]/mL" },
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
      ucumCode: u.ucumCode ?? null,
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
