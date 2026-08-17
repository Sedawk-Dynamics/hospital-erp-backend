/**
 * Operator front-end for bringing narcotic stock onto DrugBatch.
 *
 *   npm run db:unify-ndps -- --dry-run      report only, writes nothing
 *   npm run db:unify-ndps                   apply, INCLUDING the ambiguous drugs
 *   npm run db:unify-ndps -- --tenant=<id>  one hospital only
 *   npm run db:unify-ndps -- --reverse      remove the opening batches this made
 *
 * The unambiguous half runs automatically on every deploy (auto-seed step
 * `ndps-batch-unification`). This exists for the half that cannot be automated:
 * a drug holding stock in BOTH the NDPS ledger and in batches, where nothing
 * can tell whether those are the same physical units counted twice or two
 * separate lots. Run without --dry-run here and the two sides are UNIONED —
 * which is the safe direction, because over-counting is fixable by a stock-take
 * and destroying stock is not — but you should read the list first.
 *
 * Both paths share one implementation (src/seeds/ndps-batch-unification.ts).
 */

import 'dotenv/config';
import { prisma } from '../../src/config/database';
import {
  planUnification,
  applyUnification,
  OPENING_PREFIX,
  type UnifyRow,
} from '../../src/seeds/ndps-batch-unification';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => args.find((a) => a.startsWith(`${f}=`))?.split('=')[1];

const DRY = has('--dry-run');
const TENANT = val('--tenant');

const line = (r: UnifyRow) =>
  `    ${r.drug_name.padEnd(34)} NDPS ${String(r.ndps_qty).padStart(5)}   batches ${String(
    r.batch_qty,
  ).padStart(5)}`;

async function reverse() {
  const batches = await prisma.drugBatch.findMany({
    where: { batchNumber: { startsWith: OPENING_PREFIX }, ...(TENANT ? { tenantId: TENANT } : {}) },
    select: { id: true, batchNumber: true, drugId: true, quantityInStock: true },
  });
  console.log(`Found ${batches.length} opening batch(es) created by this migration.`);
  for (const b of batches) console.log(`  ${b.batchNumber}  drug ${b.drugId}  qty ${b.quantityInStock}`);
  if (DRY) return console.log('\n*** DRY RUN — nothing removed ***');

  let removed = 0;
  for (const b of batches) {
    // A batch that has been dispensed from is real stock history, not a
    // migration artefact, and is left alone.
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
  if (has('--reverse')) return reverse();

  const plan = await planUnification(prisma, TENANT);
  console.log(DRY ? '*** DRY RUN — nothing will be written ***' : '*** APPLYING ***');

  console.log(`\n  NDPS ledger only — an opening batch will be created (${plan.ndpsOnly.length}):`);
  plan.ndpsOnly.forEach((r) => console.log(line(r)));
  console.log(`\n  Batch stock only — a vault location will be assigned (${plan.batchOnly.length}):`);
  plan.batchOnly.forEach((r) => console.log(line(r)));
  console.log(`\n  Already reconciled or empty — skipped (${plan.settled.length})`);

  if (plan.ambiguous.length) {
    console.log(`\n  ⚠ STOCK IN BOTH LEDGERS (${plan.ambiguous.length}) — these are TOTALLED, not reconciled.`);
    console.log('    The two ledgers were independent, so nothing can tell whether these are the');
    console.log('    same physical units counted twice or two separate lots. Both are kept, because');
    console.log('    over-counting is fixable by a stock-take and destroying stock is not.');
    console.log('    The automatic deploy step SKIPS these — running this command settles them.');
    plan.ambiguous.forEach((r) => console.log(`${line(r)}   → combined ${r.ndps_qty + r.batch_qty}`));
  }

  if (DRY) return console.log('\nRe-run without --dry-run to apply. `--reverse` undoes it.');

  const r = await applyUnification(prisma, plan, true);
  console.log(
    `\n  Created ${r.openingBatchesCreated} opening batch(es); placed ${r.drugsLocated} drug(s) in the vault.`,
  );

  const after = await planUnification(prisma, TENANT);
  const drift = [...after.ndpsOnly, ...after.batchOnly, ...after.ambiguous];
  if (drift.length === 0) {
    console.log('  ✓ Reconciled: NDPS location totals now equal batch stock for every drug.');
  } else {
    console.log(`  ⚠ ${drift.length} drug(s) still differ — review:`);
    drift.forEach((d) => console.log(line(d)));
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
