import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  resolvePackSize,
  inferLooseUnitLabel,
} from '../modules/drug-master/drug-master.dataset';

/**
 * Backfill numeric pack sizes.
 *
 *   npm run db:seed:pack-sizes
 *
 * 1. DrugMaster.packSize — fill every catalog row that predates the column,
 *    resolved from its free-text pack label (with a typical strip fallback for
 *    countable solids). Liquids / injections / creams stay null.
 * 2. DrugFormulary.packSize + looseUnitLabel — fill imported hospital rows that
 *    came in before the pack-size logic, preferring the linked catalog row's
 *    numeric size. This is what makes the POS bill prescriptions as loose
 *    tablets instead of as a single "pack".
 */

let prisma!: PrismaClient;
const PAGE = 10_000;
const ID_CHUNK = 5_000;

async function backfillDrugMaster() {
  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows = await prisma.drugMaster.findMany({
      where: { packSize: null },
      select: { id: true, dosageForm: true, packSizeLabel: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    // Bucket this page's ids by their resolved pack size so we can apply each
    // distinct value in one updateMany. Rows that resolve to null (liquids etc.)
    // are skipped — they stay null and the id cursor moves past them.
    const buckets = new Map<number, string[]>();
    for (const r of rows) {
      const ps = resolvePackSize(r.dosageForm, r.packSizeLabel);
      if (ps == null) continue;
      const arr = buckets.get(ps);
      if (arr) arr.push(r.id);
      else buckets.set(ps, [r.id]);
    }
    for (const [ps, ids] of buckets) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const res = await prisma.drugMaster.updateMany({
          where: { id: { in: ids.slice(i, i + ID_CHUNK) } },
          data: { packSize: ps },
        });
        updated += res.count;
      }
    }
    process.stdout.write(`\rDrugMaster: scanned ${scanned}, set ${updated} ...`);
  }
  process.stdout.write('\n');
  return { scanned, updated };
}

async function backfillFormulary() {
  // Hospital formulary rows missing a numeric pack size. Small set, do per-row.
  const rows = await prisma.drugFormulary.findMany({
    where: { packSize: null },
    select: {
      id: true,
      drugName: true,
      dosageForm: true,
      unitOfMeasurement: true,
      looseUnitLabel: true,
      drugMaster: { select: { packSize: true, packSizeLabel: true, dosageForm: true } },
    },
  });

  let updated = 0;
  for (const r of rows) {
    const form = r.dosageForm ?? r.drugMaster?.dosageForm ?? null;
    // unitOfMeasurement holds the original (clamped) pack label on imported rows.
    const label = r.drugMaster?.packSizeLabel ?? r.unitOfMeasurement ?? null;
    const packSize = r.drugMaster?.packSize ?? resolvePackSize(form, label);
    if (packSize == null) continue;

    const looseUnitLabel =
      r.looseUnitLabel ?? (packSize > 1 ? inferLooseUnitLabel(form, r.drugName) : null);

    await prisma.drugFormulary.update({
      where: { id: r.id },
      data: {
        packSize,
        ...(looseUnitLabel ? { looseUnitLabel } : {}),
      },
    });
    updated += 1;
  }
  return { scanned: rows.length, updated };
}

async function main() {
  console.log('Backfilling DrugMaster.packSize ...');
  const master = await backfillDrugMaster();
  console.log(`DrugMaster done: ${JSON.stringify(master)}`);

  console.log('Backfilling DrugFormulary.packSize + looseUnitLabel ...');
  const formulary = await backfillFormulary();
  console.log(`DrugFormulary done: ${JSON.stringify(formulary)}`);
}

export async function seedPackSizes(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedPackSizes()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
