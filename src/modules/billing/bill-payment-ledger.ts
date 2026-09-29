import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

type BillingLedgerClient = Prisma.TransactionClient | typeof prisma;

function money(value: Prisma.Decimal | number | string | null | undefined): number {
  return Number(value ?? 0);
}

/**
 * Calculate the net amount collected against a bill from its immutable ledger.
 * Refund and advance rows are excluded from collections; approved/processed
 * refunds reduce the amount paid.
 */
export async function computeBillPaid(
  db: BillingLedgerClient,
  billId: string,
): Promise<number> {
  const [collected, refunded] = await Promise.all([
    db.payment.aggregate({
      where: {
        billId,
        status: 'completed',
        paymentType: { notIn: ['refund', 'advance'] as any },
      },
      _sum: { amount: true },
    }),
    db.refund.aggregate({
      where: { billId, status: { in: ['approved', 'processed'] as any } },
      _sum: { amount: true },
    }),
  ]);

  return money(collected._sum.amount) - money(refunded._sum.amount);
}

/** Recalculate the stored bill balance and status from the payment ledger. */
export async function applyPaymentToBill(
  tx: Prisma.TransactionClient,
  billId: string,
) {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: { totalAmount: true, status: true },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const paid = await computeBillPaid(tx, billId);
  const total = money(bill.totalAmount);
  const balance = total - paid;

  // Payments must not move a bill out of these terminal/manual states.
  const preservedStatuses: string[] = ['draft', 'cancelled', 'refunded'];
  const status = preservedStatuses.includes(bill.status)
    ? bill.status
    : balance <= 0 && total > 0
      ? 'paid'
      : paid > 0
        ? 'partially_paid'
        : 'pending';

  return tx.bill.update({
    where: { id: billId },
    data: {
      amountPaid: paid,
      balanceDue: Math.max(0, balance),
      status: status as any,
    },
  });
}
