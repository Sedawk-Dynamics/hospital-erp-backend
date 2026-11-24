/**
 * One-off repair for deposit returns hung on the APPLIED deposit (gap items
 * 335 / 340 / 286 / 283).
 *
 * `refundDeposit` used to attach the Refund for an UNUSED deposit to the
 * `IPDEP:` row that had already been applied to the final bill. Every later
 * re-total then subtracted it from that bill: a ₹900 bill settled from a ₹1,000
 * deposit read paid ₹800 / due ₹100 after the unused ₹100 was handed back,
 * while the ledger said ₹0 and Receivables showed −₹100 received.
 *
 * The fix moves such a refund onto the deposit RECEIPT (`IPDEPRCPT:`, on the
 * patient's ADV- holding bill) and re-totals the bill. A refund is left alone
 * when the bill would be OVERPAID without it — that one really did come off
 * the bill (an insurer later covered what the deposit paid) — and so are the
 * "recorded for refund" pairs the legacy path wrote, which net to zero.
 *
 * Idempotent: a moved refund no longer points at an `IPDEP:` row, so a second
 * run finds nothing.
 *
 *   npx tsx prisma/scripts/repair-deposit-refunds.ts            # dry run
 *   npx tsx prisma/scripts/repair-deposit-refunds.ts --apply
 */
import { PrismaClient } from '@prisma/client';
import { getBillBalanceBreakdowns } from '../../src/modules/billing/bill-payment-ledger';
import { patientOverpayment, recalculateBillTotalsPublic } from '../../src/modules/billing/billing.service';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN — nothing will be written ===\n');

  const refunds = await prisma.refund.findMany({
    where: {
      status: { in: ['requested', 'approved', 'processed'] },
      payment: { transactionId: { startsWith: 'IPDEP:' } },
    },
    select: {
      id: true, tenantId: true, amount: true, billId: true, patientId: true, reason: true,
      bill: { select: { id: true, billNumber: true, totalAmount: true, insuranceCoveredAmount: true, patientPayableAmount: true } },
      payment: { select: { id: true, transactionId: true, notes: true, sourceAdvancePaymentId: true } },
    },
  });

  const touched = new Set<string>();
  let moved = 0;
  for (const r of refunds) {
    const amount = Number(r.amount);
    if (r.payment.notes === 'Admission deposit recorded for refund') continue;
    const admissionId = String(r.payment.transactionId).slice('IPDEP:'.length);

    // Would the bill still be overpaid by at least this refund without it?
    // Then the refund rightly came off the bill — leave it.
    const bd = (await getBillBalanceBreakdowns(prisma, [r.bill])).get(r.bill.id);
    if (!bd) continue;
    const withoutIt = { ...bd, refunds: r2(bd.refunds - amount), paid: r2(bd.paid + amount) };
    if (patientOverpayment(withoutIt, r.bill.patientPayableAmount) + 0.009 >= amount) {
      console.log(`keep  refund ${amount.toFixed(2)} on ${r.bill.billNumber} — the bill was overpaid by it`);
      continue;
    }

    // The receipt the deposit came in on: the applied row's own source first.
    const receipt =
      (r.payment.sourceAdvancePaymentId
        ? await prisma.payment.findFirst({
            where: { id: r.payment.sourceAdvancePaymentId, transactionId: `IPDEPRCPT:${admissionId}` },
            select: { id: true, billId: true },
          })
        : null) ??
      (await prisma.payment.findFirst({
        where: { tenantId: r.tenantId, patientId: r.patientId, transactionId: `IPDEPRCPT:${admissionId}`, status: 'completed' },
        orderBy: { paymentDate: 'asc' },
        select: { id: true, billId: true },
      }));
    if (!receipt) {
      console.log(`skip  refund ${amount.toFixed(2)} on ${r.bill.billNumber} — no deposit receipt to move it to`);
      continue;
    }

    console.log(
      `move  refund ${r.id} ${amount.toFixed(2)}  ${r.bill.billNumber} (paid ${bd.paid}, due ${bd.balance}) ` +
        `-> deposit receipt ${receipt.id}  (${r.reason ?? ''})`,
    );
    if (APPLY) {
      await prisma.refund.update({ where: { id: r.id }, data: { paymentId: receipt.id, billId: receipt.billId } });
    }
    touched.add(r.bill.id);
    moved++;
  }

  if (APPLY) {
    for (const id of touched) await recalculateBillTotalsPublic(id);
    console.log(`\n${moved} refund(s) moved, ${touched.size} bill(s) re-totalled.`);
  } else {
    console.log(`\n${moved} refund(s) would move, ${touched.size} bill(s) would be re-totalled.\nRe-run with --apply to write these changes.`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
