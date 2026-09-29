import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { applyPaymentToBill, computeBillPaid } from '../modules/billing/bill-payment-ledger';

const LEGACY_KEY_PREFIX = 'insurance-claim-legacy:';
const SETTLEMENT_KEY_PREFIX = 'insurance-claim-settlement:';

function money(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Repair insurer payments recorded before claim settlement was connected to
 * the bill ledger. Idempotency keys make this safe on every deployment/start.
 * Existing collections are never pushed past the bill total, which prevents a
 * historical manual counter entry from being duplicated as insurance money.
 */
export async function reconcileInsuranceSettlementLedger() {
  const claims = await prisma.insuranceClaim.findMany({
    where: {
      status: { in: ['partially_settled', 'settled'] },
      paidAmount: { gt: 0 },
    },
    select: {
      id: true,
      tenantId: true,
      patientId: true,
      billId: true,
      claimNumber: true,
      paidAmount: true,
      settlementDate: true,
      reviewedBy: true,
      updatedAt: true,
      bill: { select: { totalAmount: true } },
      settlements: {
        select: {
          id: true,
          grossPaidAmount: true,
          settlementDate: true,
          paymentReference: true,
          bankReference: true,
          recordedBy: true,
          notes: true,
        },
        orderBy: { settlementDate: 'asc' },
      },
    },
  });

  let paymentsCreated = 0;
  let amountReconciled = 0;
  const bills = new Set<string>();

  for (const claim of claims) {
    const result = await prisma.$transaction(async (tx) => {
      let available = Math.max(0, money(claim.bill.totalAmount) - await computeBillPaid(tx, claim.billId));
      let created = 0;
      let amount = 0;

      const postIfMissing = async (params: {
        idempotencyKey: string;
        amount: number;
        paymentDate: Date;
        transactionId?: string | null;
        processedBy?: string | null;
        notes: string;
      }) => {
        if (available <= 0.009 || params.amount <= 0.009) return;
        const existing = await tx.payment.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
          select: { id: true },
        });
        if (existing) return;

        const amountToPost = Math.min(params.amount, available);
        await tx.payment.create({
          data: {
            tenantId: claim.tenantId,
            billId: claim.billId,
            patientId: claim.patientId,
            paymentDate: params.paymentDate,
            amount: amountToPost,
            paymentMethod: 'insurance',
            paymentType: 'regular',
            transactionId: params.transactionId ?? null,
            idempotencyKey: params.idempotencyKey,
            status: 'completed',
            processedBy: params.processedBy ?? null,
            notes: params.notes,
          },
        });
        available -= amountToPost;
        created += 1;
        amount += amountToPost;
      };

      let settlementTotal = 0;
      for (const settlement of claim.settlements) {
        const settlementAmount = money(settlement.grossPaidAmount);
        settlementTotal += settlementAmount;
        await postIfMissing({
          idempotencyKey: `${SETTLEMENT_KEY_PREFIX}${settlement.id}`,
          amount: settlementAmount,
          paymentDate: settlement.settlementDate,
          transactionId: settlement.paymentReference ?? settlement.bankReference,
          processedBy: settlement.recordedBy,
          notes: settlement.notes ?? `Reconciled TPA settlement for claim ${claim.claimNumber ?? claim.id}`,
        });
      }

      const legacyAmount = Math.max(0, money(claim.paidAmount) - settlementTotal);
      await postIfMissing({
        idempotencyKey: `${LEGACY_KEY_PREFIX}${claim.id}`,
        amount: legacyAmount,
        paymentDate: claim.settlementDate ?? claim.updatedAt,
        processedBy: claim.reviewedBy,
        notes: `Reconciled legacy TPA payment for claim ${claim.claimNumber ?? claim.id}`,
      });

      // Also repairs stale stored totals when the ledger already contained all
      // money (for example, a historical manually-entered counter payment).
      await applyPaymentToBill(tx, claim.billId);
      return { created, amount };
    });

    paymentsCreated += result.created;
    amountReconciled += result.amount;
    bills.add(claim.billId);
  }

  if (claims.length > 0) {
    logger.info(
      { claimsChecked: claims.length, billsChecked: bills.size, paymentsCreated, amountReconciled },
      'Insurance settlement bill ledger reconciliation complete',
    );
  }

  return { claimsChecked: claims.length, billsChecked: bills.size, paymentsCreated, amountReconciled };
}
