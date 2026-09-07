/**
 * One-off repair for refunds parked on the wrong bill.
 *
 * `refundDeposit` attached the Refund to whatever bill was "running" rather
 * than to the bill holding the payment being refunded. Once a stay's bill is
 * fully paid it is no longer reused, so a deposit return opened a fresh bill
 * and hung the refund there with no payment behind it: the bill read
 * amountPaid = -120 and presented 120 as owed on an empty draft.
 *
 * Also re-totals bills that were cancelled by the merge repair — their items
 * moved away but their headers kept the old figures.
 *
 *   npm run db:repair-orphan-refunds            # dry run
 *   npm run db:repair-orphan-refunds -- --apply
 */
import { PrismaClient } from '@prisma/client';
import { recalculateBillTotalsPublic } from '../../src/modules/billing/billing.service';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN — nothing will be written ===\n');
  const touched = new Set<string>();

  const refunds = await prisma.refund.findMany({
    select: { id: true, amount: true, billId: true, reason: true,
              bill: { select: { billNumber: true } },
              payment: { select: { billId: true, bill: { select: { billNumber: true } } } } },
  });

  let moved = 0;
  for (const r of refunds) {
    const should = r.payment?.billId;
    if (!should || should === r.billId) continue;
    console.log(`refund ${Number(r.amount).toFixed(2)}  ${r.bill?.billNumber} -> ${r.payment?.bill?.billNumber}  (${r.reason ?? ''})`);
    if (APPLY) await prisma.refund.update({ where: { id: r.id }, data: { billId: should } });
    touched.add(r.billId); touched.add(should);
    moved++;
  }
  console.log(`\n${moved} refund(s) ${APPLY ? 'moved' : 'would move'}.\n`);

  // Cancelled bills whose headers still carry figures their items no longer back.
  // ONLY the bills the merge repair emptied. A voided pharmacy sale or a recall
  // credit is also `cancelled` and also carries figures, but those are its own
  // record of what was voided — not stale data, and not ours to zero.
  const stale = await prisma.bill.findMany({
    where: {
      status: 'cancelled',
      cancellationReason: { startsWith: 'Merged into' },
      OR: [{ totalAmount: { gt: 0 } }, { balanceDue: { gt: 0 } }],
    },
    select: { id: true, billNumber: true, totalAmount: true, balanceDue: true,
              _count: { select: { billItems: true } } },
  });
  for (const b of stale) {
    if (b._count.billItems > 0) {
      console.log(`skip  ${b.billNumber} — cancelled but still holds ${b._count.billItems} item(s)`);
      continue;
    }
    console.log(`stale ${b.billNumber}  total=${b.totalAmount} balance=${b.balanceDue} with 0 items -> re-total to 0`);
    touched.add(b.id);
  }

  if (APPLY) {
    for (const id of touched) await recalculateBillTotalsPublic(id);
    console.log(`\n${touched.size} bill(s) re-totalled.`);
  } else {
    console.log(`\n${touched.size} bill(s) would be re-totalled.\nRe-run with --apply to write these changes.`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
