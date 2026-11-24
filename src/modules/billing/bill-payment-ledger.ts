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

/**
 * What a bill's balance is made of. This is the ONE formula every screen and
 * every write path settles by (gap item 286):
 *
 *   balance = lines - concessions - payments - advance applied - insurer share + refunds
 *
 * `lines - concessions` is the bill total. On a bill with an insurer split the
 * balance is the PATIENT's share still unpaid; the insurer's own outstanding is
 * reported beside it, never folded into what the desk may collect. A total of
 * 25,500 with 25,000 covered and nothing paid therefore reads "balance 500",
 * and the breakdown says why.
 */
export interface BillBalanceFacts {
  /** Bill total after concessions and round-off (bill.totalAmount). */
  total: number;
  /** Sum of line totals before bill-level concessions. Defaults to the total. */
  lines?: number;
  /** Insurer-covered share (bill.insuranceCoveredAmount, repaired if needed). */
  insurerShare?: number;
  /** Patient share where a split exists (bill.patientPayableAmount). */
  patientShare?: number;
  /** Patient / front-desk tender, excluding advance applied. */
  payments?: number;
  /** Deposit or advance moved onto this bill. */
  advanceApplied?: number;
  /** Insurer remittances. */
  insurerPaid?: number;
  /** Approved / processed refunds of patient money. */
  refunds?: number;
  /** Approved / processed refunds of insurer money. */
  insurerRefunds?: number;
  /**
   * The part of `refunds` that reversed an advance APPLICATION (a deposit set
   * against the bill and later handed back). Reported so receivables can net it
   * off "adjusted" rather than show it as negative cash received (gap item 287).
   */
  advanceRefunds?: number;
}

export interface BillBalanceBreakdown {
  lines: number;
  concessions: number;
  total: number;
  payments: number;
  advanceApplied: number;
  insurerShare: number;
  insurerPaid: number;
  refunds: number;
  /** Subset of `refunds` that reversed an advance application. */
  advanceRefunds: number;
  /** What the patient still owes: the figure every bill list shows. */
  balance: number;
  /** What the insurer still owes on its share. */
  insurerOutstanding: number;
  /** Everything still unpaid on the bill, whoever owes it. Drives status. */
  totalOutstanding: number;
  /** Net received on the bill (stored as bill.amountPaid). */
  paid: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeBillBalance(f: BillBalanceFacts): BillBalanceBreakdown {
  const total = r2(f.total);
  const lines = r2(f.lines ?? total);
  const payments = r2(f.payments ?? 0);
  const advanceApplied = r2(f.advanceApplied ?? 0);
  const insurerPaid = r2(f.insurerPaid ?? 0);
  const refunds = r2(f.refunds ?? 0);
  const insurerRefunds = r2(f.insurerRefunds ?? 0);
  const advanceRefunds = r2(Math.min(refunds, f.advanceRefunds ?? 0));
  const insurerShare = r2(Math.max(0, f.insurerShare ?? 0));
  const hasSplit = insurerShare > 0;

  const patientNet = r2(payments + advanceApplied - refunds);
  const insurerNet = r2(insurerPaid - insurerRefunds);
  const paid = r2(patientNet + insurerNet);

  // With a split the patient owes their share; without one, insurer money
  // simply counts toward the bill like every other receipt.
  const patientDue = hasSplit ? r2(f.patientShare ?? Math.max(0, total - insurerShare)) : total;
  const balance = r2(Math.max(0, patientDue - patientNet - (hasSplit ? 0 : insurerNet)));
  const insurerOutstanding = hasSplit ? r2(Math.max(0, insurerShare - insurerNet)) : 0;

  return {
    lines,
    concessions: r2(Math.max(0, lines - total)),
    total,
    payments,
    advanceApplied,
    insurerShare,
    insurerPaid,
    refunds,
    advanceRefunds,
    balance,
    insurerOutstanding,
    totalOutstanding: r2(Math.max(0, total - paid)),
    paid,
  };
}

/**
 * True for a payment row that MOVES money already held (a stay deposit or a
 * desk advance) onto a bill, rather than bringing new money in. Collection
 * reports and the dashboard must not count these as takings (gap items 360,
 * 361); bill balances count them as "advance applied" (gap item 286).
 */
export function isAdvanceApplication(p: {
  paymentType?: string | null;
  paymentMethod?: string | null;
  sourceAdvancePaymentId?: string | null;
  transactionId?: string | null;
  notes?: string | null;
}): boolean {
  // A refund voucher also points at its advance, but it is money going out.
  if (p.paymentType === 'refund') return false;
  if (p.sourceAdvancePaymentId) return true;
  if (p.paymentType === 'advance' && String(p.transactionId ?? '').startsWith('IPDEP:')) return true;
  if (p.paymentType === 'advance' && p.paymentMethod === 'advance') return true;
  // Legacy desk-advance adjustments carried only this note.
  return p.paymentType === 'regular' && p.notes === 'Adjusted from advance';
}

/**
 * The document number a collection row is known by (gap item 361). An advance
 * receipt and a refund voucher carry their own voucher number from the GST
 * series (…/RV/…, …/RFV/…); every other payment has its receipt. The bill
 * number is the last resort only — two deposits share one ADV- holding bill,
 * so it repeated across both rows of the Collection report.
 */
export function collectionDocumentNumber(p: {
  paymentType?: string | null;
  voucherNumber?: string | null;
  receipt?: { receiptNumber?: string | null } | null;
  bill?: { billNumber?: string | null } | null;
}): string | null {
  if ((p.paymentType === 'advance' || p.paymentType === 'refund') && p.voucherNumber) return p.voucherNumber;
  return p.receipt?.receiptNumber ?? p.voucherNumber ?? p.bill?.billNumber ?? null;
}

/**
 * The balance breakdown for many bills at once, read from the immutable ledger.
 * Used by every list (OP List, Overall Bills, Pending List, IP Payment Due and
 * Credit Settlement) so they cannot disagree with each other or with the bill.
 */
export async function getBillBalanceBreakdowns(
  db: BillingLedgerClient,
  bills: Array<{
    id: string;
    totalAmount: Prisma.Decimal | number | string | null;
    insuranceCoveredAmount?: Prisma.Decimal | number | string | null;
    patientPayableAmount?: Prisma.Decimal | number | string | null;
  }>,
): Promise<Map<string, BillBalanceBreakdown>> {
  const out = new Map<string, BillBalanceBreakdown>();
  if (bills.length === 0) return out;
  const ids = bills.map((b) => b.id);

  const [lineSums, payments, refunds] = await Promise.all([
    db.billItem.groupBy({ by: ['billId'], where: { billId: { in: ids } }, _sum: { totalAmount: true } }),
    db.payment.findMany({
      where: { billId: { in: ids }, status: 'completed', paymentType: { not: 'refund' as any } },
      select: {
        billId: true, amount: true, paymentType: true, paymentMethod: true,
        sourceAdvancePaymentId: true, transactionId: true, notes: true,
      },
    }),
    db.refund.findMany({
      where: { billId: { in: ids }, status: { in: ['approved', 'processed'] as any } },
      select: {
        billId: true, amount: true,
        payment: {
          select: {
            paymentMethod: true, paymentType: true, sourceAdvancePaymentId: true, transactionId: true, notes: true,
          },
        },
      },
    }),
  ]);

  const linesBy = new Map<string, number>();
  for (const l of (lineSums ?? []) as Array<{ billId: string; _sum: { totalAmount: unknown } }>) {
    linesBy.set(l.billId, money(l._sum.totalAmount as never));
  }
  type Acc = { payments: number; advanceApplied: number; insurerPaid: number; refunds: number; insurerRefunds: number; advanceRefunds: number };
  const acc = new Map<string, Acc>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = { payments: 0, advanceApplied: 0, insurerPaid: 0, refunds: 0, insurerRefunds: 0, advanceRefunds: 0 };
      acc.set(id, a);
    }
    return a;
  };
  for (const p of payments ?? []) {
    const a = get(p.billId);
    const amt = money(p.amount);
    if (p.paymentMethod === 'insurance') a.insurerPaid += amt;
    else if (isAdvanceApplication(p as never)) a.advanceApplied += amt;
    else a.payments += amt;
  }
  for (const r of refunds ?? []) {
    const a = get(r.billId);
    if (r.payment?.paymentMethod === 'insurance') a.insurerRefunds += money(r.amount);
    else {
      a.refunds += money(r.amount);
      if (r.payment && isAdvanceApplication(r.payment as never)) a.advanceRefunds += money(r.amount);
    }
  }

  for (const b of bills) {
    const a = acc.get(b.id);
    const insurerShare = money(b.insuranceCoveredAmount);
    out.set(
      b.id,
      computeBillBalance({
        total: money(b.totalAmount),
        lines: linesBy.get(b.id),
        insurerShare,
        patientShare: insurerShare > 0 && b.patientPayableAmount != null ? money(b.patientPayableAmount) : undefined,
        ...(a ?? {}),
      }),
    );
  }
  return out;
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

  // A stray refund cannot drive a bill below zero paid, or an empty bill would
  // read as owed (same clamp recalculateBillTotals always applied).
  const paid = Math.max(0, await computeBillPaid(tx, billId));
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
  // Same arithmetic every list reads (computeBillBalance, gap item 286).
  const balance = computeBillBalance(
    hasInsuranceSplit
      ? {
          total,
          insurerShare: insuranceCovered,
          patientShare: patientPayable,
          payments: patientPaid,
          insurerPaid: r2(paid - patientPaid),
        }
      : { total, payments: paid },
  ).balance;
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
