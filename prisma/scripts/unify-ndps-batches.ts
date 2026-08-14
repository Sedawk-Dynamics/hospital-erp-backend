/**
 * Bring narcotic stock onto DrugBatch, where every other medicine already lives.
 *
 *   npm run db:unify-ndps -- --dry-run     report only, writes nothing
 *   npm run db:unify-ndps                  apply
 *   npm run db:unify-ndps -- --tenant=<id> one hospital only
 *   npm run db:unify-ndps -- --reverse     undo (deletes only the batches this made)
 *
 * WHY
 * Narcotic quantity used to live in NdpsStockBalance, a ledger of its own with
 * no batch, no expiry and no link to anything. That made narcotics invisible to
 * stock valuation, expiry alerts, recalls, the GST report and the stock ledger,
 * and it meant Form 3C's batch number and expiry were free-typed strings that
 * nothing checked. After this, DrugBatch owns the quantity and NdpsStockBalance
 * describes only WHERE that quantity physically sits.
 *
 * THE INVARIANT, once migrated, per (tenant, drug):
 *     Σ NdpsStockBalance.quantity  ==  Σ DrugBatch.quantityInStock
 *
 * THE HARD CASE
 * A drug can already hold stock in BOTH ledgers — they were independent and
 * never reconciled. This migration UNIONS them: the NDPS quantity becomes an
 * opening batch, and any pre-existing batch quantity is assigned a location.
 * It does not try to guess that the two were the same physical units, because
 * it cannot know that. Over-counting is fixable with a stock-take; destroying
 * stock is not, so the migration always errs towards keeping it. Every such
 * drug is listed explicitly in the report for a human to check afterwards.
 */

import 'dotenv/config';
import { prisma } from '../../src/config/database';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REVERSE = args.includes('--reverse');
const TENANT = args.find((a) => a.startsWith('--tenant='))?.split('=')[1];

/** Marks a batch this migration created, so --reverse can find exactly those. */
const OPENING_PREFIX = 'NDPS-OPENING-';

function openingBatchNumber(date = new Date()): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  return `${OPENING_PREFIX}${ymd}`;
}

interface DrugRow {
  id: string;
  tenant_id: string;
  drug_name: string;
  ndps_qty: number;
  batch_qty: number;
  batches: number;
}

async function loadState(): Promise<DrugRow[]> {
  return prisma.$queryRawUnsafe<DrugRow[]>(`
    SELECT df.id, df.tenant_id, df.drug_name,
           COALESCE(nb.ndps_qty, 0)::int  AS ndps_qty,
           COALESCE(b.batch_qty, 0)::int  AS batch_qty,
           COALESCE(b.batches, 0)::int    AS batches
    FROM drug_formulary df
    LEFT JOIN (SELECT drug_formulary_id, SUM(quantity) ndps_qty
                 FROM ndps_stock_balances GROUP BY 1) nb ON nb.drug_formulary_id = df.id
    LEFT JOIN (SELECT drug_id, SUM(quantity_in_stock) batch_qty, count(*) batches
                 FROM drug_batches GROUP BY 1) b ON b.drug_id = df.id
    WHERE (df.is_narcotic = true OR df.vault_controlled = true OR nb.ndps_qty IS NOT NULL)
      ${TENANT ? `AND df.tenant_id = '${TENANT}'` : ''}
    ORDER BY df.tenant_id, df.drug_name
  `);
}

/** The tenant's Central Vault, created on demand — narcotic stock belongs in it. */
async function vaultFor(tenantId: string, create: boolean): Promise<string | null> {
  const existing = await prisma.ndpsLocation.findFirst({
    where: { tenantId, type: 'main_vault' },
    select: { id: true },
  });
  if (existing) return existing.id;
  if (!create) return null;
  const made = await prisma.ndpsLocation.create({
    data: { tenantId, name: 'Central Vault', type: 'main_vault' },
  });
  return made.id;
}

async function reverse() {
  const batches = await prisma.drugBatch.findMany({
    where: {
      batchNumber: { startsWith: OPENING_PREFIX },
      ...(TENANT ? { tenantId: TENANT } : {}),
    },
    select: { id: true, batchNumber: true, drugId: true, quantityInStock: true },
  });
  console.log(`Found ${batches.length} opening batch(es) created by this migration.`);
  for (const b of batches) console.log(`  ${b.batchNumber}  drug ${b.drugId}  qty ${b.quantityInStock}`);
  if (DRY) {
    console.log('\n*** DRY RUN — nothing removed ***');
    return;
  }
  // Only ever removes batches this migration itself created, and only while they
  // still carry no movement — a batch that has since been dispensed from is real
  // stock history and is left alone.
  let removed = 0;
  for (const b of batches) {
    const used = await prisma.dispensingRecord.count({ where: { drugBatchId: b.id } });
    if (used > 0) {
      console.log(`  skipped ${b.batchNumber} — it has ${used} dispense(s) against it`);
      continue;
    }
    await prisma.drugBatch.delete({ where: { id: b.id } });
    removed += 1;
  }
  console.log(`Removed ${removed} opening batch(es).`);
}

async function main() {
  if (REVERSE) return reverse();

  const rows = await loadState();
  console.log(DRY ? '*** DRY RUN — nothing will be written ***' : '*** APPLYING ***');
  console.log(`\n${rows.length} narcotic/controlled drug(s) in scope.\n`);

  const bothLedgers: DrugRow[] = [];
  const ndpsOnly: DrugRow[] = [];
  const batchOnly: DrugRow[] = [];
  const empty: DrugRow[] = [];

  const alreadyDone: DrugRow[] = [];

  for (const r of rows) {
    // Equal totals ARE the migrated steady state, so this is what makes the
    // script safe to re-run: once a drug reconciles, it is never touched again.
    // Without this a second run re-unions the now-matching sides and doubles
    // every quantity — which is exactly what happened the first time this was
    // written, and why the guard is a distinct branch rather than a condition
    // buried in the ones below.
    if (r.ndps_qty === r.batch_qty) {
      (r.ndps_qty === 0 ? empty : alreadyDone).push(r);
    } else if (r.ndps_qty > 0 && r.batch_qty > 0) bothLedgers.push(r);
    else if (r.ndps_qty > 0) ndpsOnly.push(r);
    else batchOnly.push(r);
  }

  const line = (r: DrugRow) =>
    `    ${r.drug_name.padEnd(34)} NDPS ${String(r.ndps_qty).padStart(5)}   batches ${String(
      r.batch_qty,
    ).padStart(5)} (${r.batches})`;

  console.log(`  NDPS ledger only — an opening batch will be created (${ndpsOnly.length}):`);
  ndpsOnly.forEach((r) => console.log(line(r)));
  console.log(`\n  Batch stock only — a vault location will be assigned (${batchOnly.length}):`);
  batchOnly.forEach((r) => console.log(line(r)));
  console.log(`\n  No stock either side — nothing to do (${empty.length}):`);
  empty.forEach((r) => console.log(line(r)));
  console.log(`\n  Already reconciled — skipped (${alreadyDone.length}):`);
  alreadyDone.forEach((r) => console.log(line(r)));

  if (bothLedgers.length) {
    console.log(
      `\n  ⚠ STOCK IN BOTH LEDGERS (${bothLedgers.length}) — these are TOTALLED, not reconciled.`,
    );
    console.log(
      '    The two ledgers were independent, so the migration cannot tell whether these are',
    );
    console.log(
      '    the same physical units recorded twice. It keeps both, because over-counting is',
    );
    console.log('    fixable by a stock-take and destroying stock is not. CHECK THESE BY HAND:');
    bothLedgers.forEach((r) =>
      console.log(`${line(r)}   → combined ${r.ndps_qty + r.batch_qty}`),
    );
  }

  const willCreate = [...ndpsOnly, ...bothLedgers];
  const willLocate = [...batchOnly, ...bothLedgers];
  console.log(
    `\n  Summary: ${willCreate.length} opening batch(es) to create ` +
      `(${willCreate.reduce((s, r) => s + r.ndps_qty, 0)} units), ` +
      `${willLocate.length} drug(s) whose existing batch stock gets a vault location ` +
      `(${willLocate.reduce((s, r) => s + r.batch_qty, 0)} units).`,
  );

  if (DRY) {
    console.log('\nRe-run without --dry-run to apply. `--reverse` undoes it.');
    return;
  }

  // ── apply ────────────────────────────────────────────────────────────────
  const batchNumber = openingBatchNumber();
  let created = 0;
  let located = 0;

  for (const r of willCreate) {
    const vault = await vaultFor(r.tenant_id, true);
    if (!vault) continue;
    // An opening batch carries no purchase history — it is stock the hospital
    // already holds. Expiry is set far out rather than left null (the column is
    // required) and is meant to be corrected at the next physical count.
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 2);
    const existing = await prisma.drugBatch.findFirst({
      where: { tenantId: r.tenant_id, drugId: r.id, batchNumber },
      select: { id: true },
    });
    if (existing) continue; // already migrated — safe to re-run
    await prisma.drugBatch.create({
      data: {
        tenantId: r.tenant_id,
        drugId: r.id,
        batchNumber,
        expiryDate: expiry,
        quantityInStock: r.ndps_qty,
        quantityReceived: r.ndps_qty,
      },
    });
    created += 1;
  }

  for (const r of willLocate) {
    const vault = await vaultFor(r.tenant_id, true);
    if (!vault) continue;
    // Existing batch stock had no location at all. It is a narcotic, so the
    // vault is where it belongs until someone transfers it out.
    const bal = await prisma.ndpsStockBalance.findFirst({
      where: { tenantId: r.tenant_id, drugFormularyId: r.id, locationId: vault },
    });
    if (bal) {
      await prisma.ndpsStockBalance.update({
        where: { id: bal.id },
        data: { quantity: bal.quantity + r.batch_qty },
      });
    } else {
      await prisma.ndpsStockBalance.create({
        data: {
          tenantId: r.tenant_id,
          drugFormularyId: r.id,
          locationId: vault,
          quantity: r.batch_qty,
        },
      });
    }
    located += 1;
  }

  console.log(`\n  Created ${created} opening batch(es); located ${located} drug(s) into the vault.`);

  // ── verify the invariant actually holds now ──────────────────────────────
  const after = await loadState();
  const drift = after.filter((r) => r.ndps_qty !== r.batch_qty);
  if (drift.length === 0) {
    console.log('  ✓ Reconciled: NDPS location totals now equal batch stock for every drug.');
  } else {
    console.log(`  ⚠ ${drift.length} drug(s) still differ — review:`);
    drift.forEach((r) => console.log(line(r)));
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
