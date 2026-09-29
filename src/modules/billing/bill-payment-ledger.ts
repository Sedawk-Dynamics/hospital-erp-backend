import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

type BillingLedgerClient = Prisma.TransactionClient | typeof prisma;

function money(value: Prisma.Decimal | number | string | null | undefined): number {
  return Number(value ?? 0);
}

/**
 * Calculate the net amount collected against a bill from its immutable ledger.
 * An advance row on a real bill is an admission deposit that has actually been
 * applied to that bill, so it is a collection. Advance receipts themselves sit
 * on the separate ADV-* holding bill and therefore never enter this billId.
 * Approved/processed refunds reduce the amount paid.
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
        paymentType: { not: 'refund' as any },
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

/** Net patient/front-desk collections, excluding insurer remittances. */
export async function computePatientPaidForBills(
  db: BillingLedgerClient,
  billIds: string[],
): Promise<number> {
  if (billIds.length === 0) return 0;

  const [collected, refunded] = await Promise.all([
    db.payment.aggregate({
      where: {
        billId: { in: billIds },
        status: 'completed',
        paymentMethod: { not: 'insurance' },
        // An applied admission deposit is paymentType=advance on the real bill
        // and is still money paid by the patient. Only payout/refund rows are
        // excluded here.
        paymentType: { not: 'refund' as any },
      },
      _sum: { amount: true },
    }),
    db.refund.aggregate({
      where: {
        billId: { in: billIds },
        status: { in: ['approved', 'processed'] as any },
        payment: { paymentMethod: { not: 'insurance' } },
      },
      _sum: { amount: true },
    }),
  ]);

  return money(collected._sum.amount) - money(refunded._sum.amount);
}

/** Net patient/front-desk collections for one bill. */
export async function computePatientPaid(
  db: BillingLedgerClient,
  billId: string,
): Promise<number> {
  return computePatientPaidForBills(db, [billId]);
}

/** Recalculate the stored bill balance and status from the payment ledger. */
export async function applyPaymentToBill(
  tx: Prisma.TransactionClient,
  billId: string,
) {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: {
      totalAmount: true,
      insuranceCoveredAmount: true,
      patientPayableAmount: true,
      status: true,
      insuranceClaims: {
        where: {
          status: { in: ['approved', 'partially_approved', 'partially_settled', 'settled'] },
        },
        select: { approvedAmount: true, coveredAmount: true, claimAmount: true },
      },
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const paid = await computeBillPaid(tx, billId);
  const total = money(bill.totalAmount);
  const inferredInsuranceCovered = Math.min(
    total,
    (bill.insuranceClaims ?? []).reduce(
      (sum, claim) => sum + money(claim.approvedAmount ?? claim.coveredAmount ?? claim.claimAmount),
      0,
    ),
  );
  // Some historical workflow settlements did not write the bill split. Infer
  // it from active approved claims, while preserving an explicit larger split.
  const storedInsuranceCovered = money(bill.insuranceCoveredAmount);
  const insuranceCovered = Math.max(storedInsuranceCovered, inferredInsuranceCovered);
  const splitNeedsRepair = insuranceCovered > storedInsuranceCovered + 0.009;
  const patientPayable = splitNeedsRepair
    ? Math.max(0, total - insuranceCovered)
    : money(bill.patientPayableAmount);
  const hasInsuranceSplit = insuranceCovered > 0;
  const patientPaid = hasInsuranceSplit ? await computePatientPaid(tx, billId) : 0;
  // On a TPA bill, `balanceDue` is deliberately the amount the front desk may
  // collect from the patient. The payer's outstanding claim remains visible in
  // Insurance; it must never be presented to the patient as their due.
  const balance = hasInsuranceSplit
    ? patientPayable - patientPaid
    : total - paid;
  const totalBalance = total - paid;

  // Payments must not move a bill out of these terminal/manual states.
  const preservedStatuses: string[] = ['draft', 'cancelled', 'refunded'];
  const status = preservedStatuses.includes(bill.status)
    ? bill.status
    // A zero PATIENT balance does not mean a split bill is fully paid: the TPA
    // may still owe its share. Only the complete immutable ledger can close it.
    : totalBalance <= 0 && total > 0
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
      ...(splitNeedsRepair
        ? { insuranceCoveredAmount: insuranceCovered, patientPayableAmount: patientPayable }
        : {}),
    },
  });
}
