/**
 * Backfill: give every legacy InventoryItem a formulary product so it works
 * exactly like a medicine — searchable by the doctor, sellable at the pharmacy
 * counter, batch/expiry/GST tracked.
 *
 * Background: stock used to be split in two. Type = Medicine went to
 * DrugFormulary (+ DrugBatch → billable, because the sale engine needs a batch);
 * every other Type went to InventoryItem, which has no batches — so those items
 * could never be found in the drug search or billed. All types now stock into
 * DrugFormulary with a `category`, and this backfill brings the pre-existing
 * InventoryItem rows across.
 *
 * Safe + idempotent:
 *  - skips any item that already has a linked formulary product;
 *  - links the new row via DrugFormulary.inventoryItemId, which is exactly what
 *    the Storage union uses to de-duplicate, so nothing shows twice;
 *  - never deletes or deactivates the InventoryItem (its stock transactions and
 *    history stay intact) — this is additive only;
 *  - opening stock becomes ONE batch so the quantity is billable. Inventory
 *    items carry no expiry, so the batch gets a far-future date.
 *
 * Runs automatically on boot (see bootstrap/auto-seed.ts) and can be run
 * manually with `npm run db:seed:inventory-to-formulary`.
 */

import { PrismaClient } from '@prisma/client';

let prisma!: PrismaClient;

// Inventory items have no expiry; a batch row requires one.
const NO_EXPIRY = new Date('2099-12-31');

async function main() {
  // Only items with no linked formulary product yet.
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, formularyDrugs: { none: {} } },
    select: {
      id: true, tenantId: true, itemName: true, itemCode: true, category: true,
      description: true, unitOfMeasurement: true, minimumStockThreshold: true,
      currentStock: true, costPerUnit: true, sellingPricePerUnit: true,
    },
  });

  if (!items.length) {
    console.log('[inventory→formulary] nothing to migrate');
    return;
  }
  console.log(`[inventory→formulary] migrating ${items.length} item(s)…`);

  let created = 0;
  let batched = 0;
  for (const it of items) {
    // Don't create a second product when one already exists by name for this
    // tenant — link the existing row instead (re-run safety / manual overlap).
    const existing = await prisma.drugFormulary.findFirst({
      where: { tenantId: it.tenantId, drugName: { equals: it.itemName, mode: 'insensitive' } },
      select: { id: true, inventoryItemId: true },
    });

    if (existing) {
      if (!existing.inventoryItemId) {
        await prisma.drugFormulary.update({
          where: { id: existing.id },
          data: { inventoryItemId: it.id, category: it.category },
        });
        console.log(`  linked existing product "${it.itemName}" (${it.category})`);
      }
      continue;
    }

    const drug = await prisma.drugFormulary.create({
      data: {
        tenantId: it.tenantId,
        drugName: it.itemName,
        category: it.category,
        looseUnitLabel: it.unitOfMeasurement,
        unitOfMeasurement: it.unitOfMeasurement,
        price: it.sellingPricePerUnit,
        minStock: it.minimumStockThreshold,
        indications: it.description,
        inventoryItemId: it.id, // Storage de-dupes on this link.
        isActive: true,
      },
      select: { id: true },
    });
    created += 1;

    // Carry opening stock over as one batch so the quantity is actually sellable.
    if (it.currentStock > 0) {
      await prisma.drugBatch.create({
        data: {
          tenantId: it.tenantId,
          drugId: drug.id,
          batchNumber: 'OPENING',
          expiryDate: NO_EXPIRY,
          quantityReceived: it.currentStock,
          quantityInStock: it.currentStock,
          purchasePrice: it.costPerUnit,
          sellingPrice: it.sellingPricePerUnit,
        },
      });
      batched += 1;
    }
    console.log(`  migrated "${it.itemName}" (${it.category}) · stock ${it.currentStock}`);
  }

  console.log(`[inventory→formulary] done — ${created} product(s) created, ${batched} opening batch(es)`);
}

export async function migrateInventoryToFormulary(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  migrateInventoryToFormulary()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
