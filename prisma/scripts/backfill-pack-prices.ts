import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Convert pack-priced rows to PER-BASE-UNIT pricing.
 *
 *   npm run db:seed:pack-prices
 *
 * Imported formulary rows (and their stock batches) were seeded with the
 * catalog MRP, which is the price of the whole pack/strip (e.g. ₹30 for a strip
 * of 10). Stock + billing are per base unit, so loose-tablet sales were
 * over-charging by ~packSize×. This divides any still-pack-priced value by
 * packSize so a strip-of-10 @ ₹30 becomes ₹3.00 / tablet.
 *
 * Scope: only imported rows (drugMasterId set) with packSize > 1. A value is
 * treated as pack-priced only when it sits closer to the pack MRP than to the
 * per-unit MRP, so already-corrected or hand-edited per-unit prices are left
 * alone (safe to re-run).
 */

const prisma = new PrismaClient();
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Is `price` closer to the pack MRP than to the per-unit MRP? → pack-scaled. */
function isPackScaled(price: number, mrp: number, packSize: number): boolean {
  const perUnit = mrp / packSize;
  return Math.abs(price - mrp) <= Math.abs(price - perUnit);
}

async function main() {
  const rows = await prisma.drugFormulary.findMany({
    where: { drugMasterId: { not: null }, packSize: { gt: 1 } },
    select: {
      id: true,
      drugName: true,
      price: true,
      packSize: true,
      drugMaster: { select: { mrp: true } },
      drugBatches: { select: { id: true, sellingPrice: true, purchasePrice: true } },
    },
  });

  let formularyFixed = 0;
  let batchesFixed = 0;

  for (const r of rows) {
    const packSize = r.packSize ?? 1;
    const mrp = r.drugMaster?.mrp != null ? Number(r.drugMaster.mrp) : null;
    if (packSize <= 1 || mrp == null || mrp <= 0) continue;

    // 1. Formulary default price.
    if (r.price != null) {
      const price = Number(r.price);
      if (price > 0 && isPackScaled(price, mrp, packSize)) {
        await prisma.drugFormulary.update({
          where: { id: r.id },
          data: { price: round2(price / packSize) },
        });
        formularyFixed += 1;
      }
    }

    // 2. Each stock batch's selling + purchase price. Purchase is converted in
    //    lock-step only when the selling price was pack-scaled (entered at the
    //    same scale), so margins stay coherent.
    for (const b of r.drugBatches) {
      const sell = b.sellingPrice != null ? Number(b.sellingPrice) : null;
      if (sell == null || sell <= 0 || !isPackScaled(sell, mrp, packSize)) continue;
      const data: { sellingPrice: number; purchasePrice?: number } = {
        sellingPrice: round2(sell / packSize),
      };
      const purch = b.purchasePrice != null ? Number(b.purchasePrice) : null;
      if (purch != null && purch > 0) data.purchasePrice = round2(purch / packSize);
      await prisma.drugBatch.update({ where: { id: b.id }, data });
      batchesFixed += 1;
    }
  }

  console.log(
    `Done. Formulary prices fixed: ${formularyFixed} | batch prices fixed: ${batchesFixed} (of ${rows.length} imported multi-unit drugs).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
