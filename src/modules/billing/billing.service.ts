import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { isAdvanceBucket } from '../../shared/charge-bill';
import { nextBillNumberInSeries } from '../../shared/bill-number';
import { getPaginationParams } from '../../shared/pagination';
import { fullName } from '../../shared/person-name';
import { notStartingWith } from '../../shared/prisma-where';
import {
  getISTDateStr,
  formatDateTimeIST,
  istDayNumber,
  istDayRange,
  istDayStart,
  istDayEnd,
} from '../../shared/date.utils';
import { normalizeAdmissionType, type AdmissionType } from '../../shared/admission-type';
import { writeAudit } from '../../shared/audit';
import { supplyKindForCategory } from '../../shared/gst-determination';
import { roundOffTotal } from '../../shared/gst';
import { taxResolverFor, billItemTaxFields } from '../gst/gst-resolver.service';
import { issueDocumentForBill } from '../gst/gst-document.service';
import { issueCreditNoteBestEffort } from '../gst/credit-note.service';
import {
  advancePaymentTaxFields,
  issueRefundVoucherBestEffort,
  type AdvancePurpose,
} from '../gst/advance-gst.service';
import { getGstProfile } from '../hospital-settings/hospital-settings.service';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  discountNeedsApproval,
  mergeDiscountApproval,
  type DiscountApprovalSettings,
} from '../../shared/discount-approval';
import {
  ACTIVE_ADMISSION_STATUS,
  ACTIVE_ADMISSION_STATUSES,
  isActiveAdmission,
} from '../../shared/admission-status';
import type {
  CreateServiceTariffInput,
  UpdateServiceTariffInput,
  CreateBillInput,
  AddBillItemInput,
  UpdateBillItemInput,
  CreatePaymentInput,
  CreateRefundInput,
  ApplyDiscountInput,
  GetBillsQuery,
  GetPaymentsQuery,
} from './billing.validation';

/**
 * Map validation category values to ServiceTariffCategory enum values.
 * Validation has 'imaging' which maps to 'radiology' in the schema,
 * and 'nursing' which doesn't exist in schema enum (maps to 'other').
 */
function mapToServiceTariffCategory(cat: string): string {
  const mapping: Record<string, string> = {
    consultation: 'consultation',
    surgery: 'surgery',
    room: 'room',
    lab: 'lab',
    imaging: 'radiology',
    pharmacy: 'pharmacy',
    procedure: 'procedure',
    nursing: 'other',
    other: 'other',
  };
  return mapping[cat] ?? 'other';
}

/**
 * Best-effort map an imaging modality/service name to the ImagingType enum so
 * radiology admins can add a modality by name (e.g. "MRI", "PET-CT") without
 * picking an enum. Falls back to 'other' for anything unrecognized.
 */
function deriveImagingModality(name: string): string {
  const n = (name || '').toLowerCase();
  if (/\becg\b|electrocardiogram/.test(n)) return 'ecg';
  if (/\becho\b|echocardiogram|2d ?echo/.test(n)) return 'echo';
  if (/\bmri\b|magnetic resonance/.test(n)) return 'mri';
  if (/\bct\b|cat scan|computed tomograph/.test(n)) return 'ct_scan';
  if (/x-?ray|radiograph/.test(n)) return 'xray';
  if (/ultrasound|\busg\b|sonograph|doppler/.test(n)) return 'ultrasound';
  return 'other';
}

/**
 * Map validation payment method to PaymentMethod enum.
 * Validation allows 'bank_transfer' and 'wallet' which don't exist in schema.
 */
function mapPaymentMethod(method: string): string {
  const mapping: Record<string, string> = {
    cash: 'cash',
    credit_card: 'credit_card',
    debit_card: 'debit_card',
    bank_transfer: 'net_banking',
    // `net_banking` is the enum's own value and what every client actually
    // sends — only the legacy `bank_transfer` alias was listed, so a net-banking
    // payment fell through to `other` and was reported as such on the day-end
    // sheet and in every payment-mode breakdown.
    net_banking: 'net_banking',
    upi: 'upi',
    cheque: 'cheque',
    insurance: 'insurance',
    wallet: 'other',
    other: 'other',
  };
  return mapping[method] ?? 'other';
}

/**
 * Convert Decimal to number for arithmetic.
 */
function toNumber(val: Decimal | number | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  return val.toNumber();
}

/**
 * Round to paise. A dozen functions in this file declare this locally; those
 * shadow this one with an identical implementation, so nothing changes for them
 * — this exists so code outside those bodies has it too.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The next `BILL-YYYYMMDD-XXXX`.
 *
 * Delegates to the shared allocator, which reads the maximum ACROSS ALL
 * TENANTS. This used to scope both the maximum and its duplicate re-check to
 * one tenant — and `bill_number` is unique globally, so two hospitals billing
 * on the same day both computed `…-0001` and the second insert violated the
 * index. The tenant-scoped re-check could never catch it either: it was looking
 * in the one place the clash could not be.
 */
async function generateBillNumber(_tenantId: string): Promise<string> {
  return nextBillNumberInSeries(prisma, 'BILL');
}

/**
 * Generate a unique receipt number.
 * Format: RCP-YYYYMMDD-XXXX
 *
 * `db` lets callers pass the active transaction client. This MATTERS for split
 * payments: multiple receipts are created inside one $transaction, so the number
 * generator must read the transaction's own uncommitted rows — reading the
 * global (committed) state would hand every split the same number and violate
 * the `Receipt.receiptNumber` unique constraint on the 2nd split.
 */
async function generateReceiptNumber(
  _tenantId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<string> {
  const prefix = `RCP-${getISTDateStr()}-`;

  // Read the day's highest number ACROSS ALL TENANTS, because that is the scope
  // `Receipt.receiptNumber`'s unique index actually has. Reading it per tenant
  // handed a second hospital a number a first one already held: the insert
  // violated the global index, and in Postgres that ABORTS the transaction, so
  // a split payment lost every leg rather than just misnaming one receipt.
  // Reproduced with two real tenants — `npm run db:check-split-payment`.
  //
  // Same bug and same fix as `shared/bill-number.ts`, which this deliberately
  // mirrors; bills were corrected when it was found on the ward charge paths
  // and receipts were missed.
  //
  // Ordering by the string is numeric ordering because the sequence is padded
  // to a fixed width.
  const latestReceipt = await db.receipt.findFirst({
    where: { receiptNumber: { startsWith: prefix } },
    orderBy: { receiptNumber: 'desc' },
    select: { receiptNumber: true },
  });

  const lastNumber = latestReceipt?.receiptNumber
    ? parseInt(latestReceipt.receiptNumber.split('-').pop() || '0', 10) || 0
    : 0;

  // No re-check against the number just computed: it came from the maximum, so
  // it cannot already exist. The check that used to sit here was scoped to one
  // tenant, could therefore never fire, and would have recursed for ever if it
  // had — it recomputed the same number from the same rows.
  return `${prefix}${String(lastNumber + 1).padStart(4, '0')}`;
}

/**
 * Recalculate bill totals from items.
 */
async function recalculateBillTotals(billId: string) {
  const items = await prisma.billItem.findMany({
    where: { billId },
  });

  let subtotal = 0;
  let totalTax = 0;
  let totalDiscount = 0;
  // The same tax, broken out the way every GST return asks for it. Summed from
  // the lines for the same reason the total is: the lines are where the tax was
  // actually decided, and a header figure that is maintained separately drifts.
  let taxableValue = 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;
  let cessAmount = 0;
  // The authoritative figure. Each line already knows what it comes to — the
  // per-line maths is where a tax-exclusive service (tax added on top) and a
  // tax-inclusive medicine price (tax embedded in the MRP) differ. Summing the
  // line totals is the one formula that is right for both, and it is the same
  // rule the IP bill document prints by: Σ item.totalAmount − header discount,
  // never re-adding tax.
  let lineTotals = 0;

  for (const item of items) {
    const itemSubtotal = item.quantity * toNumber(item.unitPrice);
    const itemDiscount = toNumber(item.discountAmount);
    const itemTax = toNumber(item.taxAmount);

    subtotal += itemSubtotal;
    totalDiscount += itemDiscount;
    totalTax += itemTax;
    lineTotals += toNumber(item.totalAmount);
    taxableValue += toNumber(item.taxableValue);
    cgstAmount += toNumber(item.cgstAmount);
    sgstAmount += toNumber(item.sgstAmount);
    igstAmount += toNumber(item.igstAmount);
    cessAmount += toNumber(item.cessAmount);
  }

  // A concession granted at the counter is a BILL-LEVEL discount: it lives as a
  // `Discount` row, not on any line item. Recomputing from the items alone
  // silently erased it — and this runs on every charge added or removed, every
  // deposit applied, every doctor visit recorded. On an IP stay, where charges
  // accrue daily, a concession given on day one was guaranteed to vanish and
  // the patient got billed the full amount again.
  // Only an APPROVED concession reduces what the patient owes. A pending one is
  // a request awaiting a second pair of eyes and must change no figure until
  // somebody decides on it — otherwise the gate would be decorative, the money
  // already off the bill before anyone looked.
  const billLevel = await prisma.discount.aggregate({
    where: { billId, status: 'approved' },
    _sum: { value: true },
  });
  const billLevelDiscount = toNumber(billLevel._sum.value);
  totalDiscount += billLevelDiscount;

  // For an all-exclusive bill this is arithmetically identical to the old
  // `subtotal − discount + tax`, because each line total IS its net plus its
  // tax. It only diverges where a line carries its tax inside the price.
  const exact = Math.max(0, r2(lineTotals - billLevelDiscount));

  // Section 6.9: round the grand total to the nearest rupee and store the
  // difference as a visible round-off line. `roundOffTotal` has existed in
  // shared/gst.ts since this work started and nothing called it — `round_off`
  // was 0 on all 180 bills in this database while ten of them carried a
  // non-whole-rupee total.
  //
  // The round-off never touches the tax figures: those are what get reported,
  // and moving them to make a total look tidy is how a return stops tying back
  // to the register.
  let roundOff = 0;
  let total = exact;
  try {
    // The bill knows its own tenant — this function is called from a dozen
    // places and several of them do not have one in hand.
    const owner = await prisma.bill.findUnique({
      where: { id: billId },
      select: { tenantId: true },
    });
    const profile = await getGstProfile(owner!.tenantId);
    if (profile.registered && profile.roundOffToRupee) {
      const r = roundOffTotal(exact);
      total = r.rounded;
      roundOff = r.roundOff;
    }
  } catch {
    // No profile, no rounding. The exact figure is always a safe answer.
  }

  // Through the same ledger definition every other path settles by. Summing
  // completed payments raw counted a REFUND payout as money coming in — a
  // ₹1,000 bill refunded ₹400 read as ₹1,400 paid the next time any charge was
  // posted to it — and counted advance-bucket rows that belong to no bill.
  // Refunds net off what a bill has been paid, but they cannot drive it below
  // zero. A returned deposit was attached to a bill holding no payment of its
  // own, so this read -120, and `total - totalPaid` below then presented an
  // EMPTY bill as 120 owed — a refund cannot create a debt. The clamp makes a
  // stray refund harmless instead of billable.
  const totalPaid = Math.max(0, await computeBillPaid(prisma, billId));

  // Determine status based on payment. draft / cancelled / refunded are states
  // a recalculation does not move a bill out of; the rest mirror
  // applyPaymentToBill exactly, so the two can never disagree about a bill.
  const bill = await prisma.bill.findUnique({ where: { id: billId }, select: { status: true } });
  const settled: string[] = ['draft', 'cancelled', 'refunded'];
  const status =
    bill && !settled.includes(bill.status)
      ? totalPaid >= total && total > 0
        ? 'paid'
        : totalPaid > 0
          ? 'partially_paid'
          : 'pending'
      : undefined;

  const updateData: any = {
    subtotal,
    taxAmount: totalTax,
    discountAmount: totalDiscount,
    totalAmount: total,
    amountPaid: totalPaid,
    balanceDue: Math.max(0, r2(total - totalPaid)),
    taxableValue: r2(taxableValue),
    cgstAmount: r2(cgstAmount),
    sgstAmount: r2(sgstAmount),
    igstAmount: r2(igstAmount),
    cessAmount: r2(cessAmount),
    roundOff,
  };

  if (status) {
    updateData.status = status;
  }

  await prisma.bill.update({
    where: { id: billId },
    data: updateData,
  });
}

/**
 * Re-total a bill from its own line items, for callers outside this module.
 *
 * Any module that writes BillItem rows directly (the OT kit reconciliation, for
 * one) must settle the header through this rather than adding to the stored
 * figures by hand — incrementing ignores bill-level concessions and re-inflates
 * a bill that has already been part-paid.
 */
export async function recalculateBillTotalsPublic(billId: string): Promise<void> {
  await recalculateBillTotals(billId);
}

/**
 * A patient's advance money lives on a sentinel `ADV-…` bill so it can reuse the
 * Payment/Receipt machinery. It is a holding bucket, not something anyone was
 * ever billed for, so it must be kept out of every bill list and revenue total —
 * left in, it showed up in the Pending List as a phantom bill and inflated the
 * day-end "Bills Generated" count and "Total Billed" figure.
 */
const NOT_ADVANCE_BUCKET = {
  billNumber: { not: { startsWith: 'ADV-' } },
} as const;

/**
 * What a bill has actually been paid, read from its own ledger.
 *
 * Collected = completed payments, EXCLUDING `refund`-type rows (those record
 * cash leaving the drawer, not money coming in) and `advance`-type rows (those
 * belong to the patient's advance bucket, not to a bill). Minus refunds that
 * have been approved, which is money handed back.
 *
 * Deriving this instead of incrementing a stored figure is what makes
 * settlement safe under concurrency — see {@link applyPaymentToBill}.
 */
async function computeBillPaid(
  db: Prisma.TransactionClient | typeof prisma,
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

  return toNumber(collected._sum.amount) - toNumber(refunded._sum.amount);
}

/**
 * Re-settle a bill from its own payment ledger, inside a transaction.
 *
 * Every caller used to compute `amountPaid = <figure read before the
 * transaction opened> + amount`. Two cashiers collecting against the same bill
 * in the same moment both read the same starting figure, and the second write
 * silently discarded the first — a receipt went across the counter for money
 * the bill never recorded. A double-clicked Collect button did the same thing.
 *
 * Summing the ledger *inside* the transaction is self-correcting: whatever
 * payment rows exist at commit time are exactly what the bill reflects, however
 * the requests interleaved.
 *
 * Not for the `ADV-` advance bucket, whose `amountPaid` is a running balance
 * that `adjustAdvanceToBill` draws down on purpose rather than a sum of its
 * payments.
 */
async function applyPaymentToBill(tx: Prisma.TransactionClient, billId: string) {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: { totalAmount: true, status: true },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const paid = await computeBillPaid(tx, billId);
  const total = toNumber(bill.totalAmount);
  const balance = total - paid;

  // draft / cancelled / refunded are states a payment does not move a bill out
  // of — leave them exactly as they are.
  const settled: string[] = ['draft', 'cancelled', 'refunded'];
  const status = settled.includes(bill.status)
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

/**
 * Issue the receipt for a payment, inside the caller's transaction.
 *
 * Idempotent: `Receipt.paymentId` is unique, so a second call for the same
 * payment returns the receipt that already exists rather than blowing up. That
 * matters for the gateway paths, which can be driven twice by a webhook retry.
 */
async function issueReceiptForPayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentId: string,
  amount: number,
) {
  const existing = await tx.receipt.findUnique({ where: { paymentId } });
  if (existing) return existing;

  const receiptNumber = await generateReceiptNumber(tenantId, tx);
  return tx.receipt.create({
    data: { tenantId, receiptNumber, paymentId, receiptDate: new Date(), amount },
  });
}

/**
 * Settle a payment that an online gateway has confirmed.
 *
 * The single entry point for every gateway callback — the Razorpay webhook, the
 * checkout `handler` callback, and the patient portal's own verify route. They
 * all used to settle by hand, and the webhook version was wrong twice over:
 *
 *  1. It never checked whether the payment was already `completed`. Razorpay
 *     retries a webhook until it gets a 2xx and re-sends on replay, so one
 *     payment could be credited to the bill two or three times.
 *  2. It computed `balance = totalAmount − discountAmount − paid`, but
 *     `totalAmount` is already net of discount, so every discounted bill paid
 *     online was marked `paid` while the concession amount was still owed.
 *
 * Returning `alreadySettled` lets the caller log a replay instead of treating it
 * as new money. Callers must still respond 2xx — a replay is not an error.
 */
export async function settleGatewayPayment(
  paymentId: string,
  gatewayPaymentId?: string,
  webhookPayload?: unknown,
): Promise<{ alreadySettled: boolean; billId: string | null }> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { alreadySettled: false, billId: null };

    if (payment.status === 'completed') {
      // Keep the gateway reference fresh, but touch no money.
      if (gatewayPaymentId && payment.transactionId !== gatewayPaymentId) {
        await tx.payment.update({
          where: { id: paymentId },
          data: { transactionId: gatewayPaymentId },
        });
      }
      return { alreadySettled: true, billId: payment.billId };
    }

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'completed',
        ...(gatewayPaymentId ? { transactionId: gatewayPaymentId } : {}),
      },
    });

    // Every counter payment gets a receipt; the gateway paths never did, so a
    // patient who paid online had nothing in the Receipts tab to download.
    await issueReceiptForPayment(tx, payment.tenantId, paymentId, toNumber(payment.amount));

    await applyPaymentToBill(tx, payment.billId);

    if (webhookPayload !== undefined) {
      await tx.paymentTransfer.updateMany({
        where: { paymentId },
        data: { webhookPayload: webhookPayload as any },
      });
    }

    return { alreadySettled: false, billId: payment.billId };
  });
}

// --- Collection Summary ---

export async function getCollectionSummary(
  tenantId: string,
  query: { startDate?: string; endDate?: string },
) {
  const where: any = { tenantId, status: 'completed' };

  // IST calendar-day bounds. Passing the bare date string to `new Date()` gave
  // midnight UTC for BOTH ends, so a single-day query (startDate === endDate,
  // which is what the Cash Counter sends every time it loads) asked for a
  // one-millisecond window and reported zero collection all day.
  if (query.startDate) {
    where.paymentDate = { ...where.paymentDate, gte: istDayStart(query.startDate) };
  }
  if (query.endDate) {
    where.paymentDate = { ...where.paymentDate, lte: istDayEnd(query.endDate) };
  }

  const payments = await prisma.payment.findMany({ where });

  let totalCollection = 0;
  let cash = 0;
  let card = 0;
  let upi = 0;
  let bankTransfer = 0;
  let cheque = 0;

  const emptyMethods = () => ({
    total: 0,
    cash: 0,
    card: 0,
    upi: 0,
    bankTransfer: 0,
    cheque: 0,
    insurance: 0,
    other: 0,
  });
  const bySource = {
    online: emptyMethods(),
    frontdesk: emptyMethods(),
    unknown: emptyMethods(),
  };

  const addToBucket = (
    bucket: ReturnType<typeof emptyMethods>,
    method: string,
    amt: number,
  ) => {
    bucket.total += amt;
    switch (method) {
      case 'cash': bucket.cash += amt; break;
      case 'credit_card':
      case 'debit_card': bucket.card += amt; break;
      case 'upi': bucket.upi += amt; break;
      case 'net_banking': bucket.bankTransfer += amt; break;
      case 'cheque': bucket.cheque += amt; break;
      case 'insurance': bucket.insurance += amt; break;
      default: bucket.other += amt; break;
    }
  };

  // Money handed back is not takings. Refund payouts are completed payments
  // like any other, so counting them here would inflate the day's collection by
  // the very amount that left the drawer.
  let refunds = 0;

  for (const p of payments) {
    const amt = toNumber(p.amount);
    if (p.paymentType === 'refund') {
      refunds += amt;
      continue;
    }
    totalCollection += amt;
    switch (p.paymentMethod) {
      case 'cash': cash += amt; break;
      case 'credit_card':
      case 'debit_card': card += amt; break;
      case 'upi': upi += amt; break;
      case 'net_banking': bankTransfer += amt; break;
      case 'cheque': cheque += amt; break;
    }

    const sourceKey: 'online' | 'frontdesk' | 'unknown' =
      p.paymentSource === 'online' ? 'online' : p.paymentSource === 'frontdesk' ? 'frontdesk' : 'unknown';
    addToBucket(bySource[sourceKey], p.paymentMethod, amt);
  }

  // Bill-level aggregation
  const billWhere: any = { tenantId };
  if (query.startDate) {
    billWhere.createdAt = { ...billWhere.createdAt, gte: istDayStart(query.startDate) };
  }
  if (query.endDate) {
    billWhere.createdAt = { ...billWhere.createdAt, lte: istDayEnd(query.endDate) };
  }

  const bills = await prisma.bill.findMany({
    where: { ...billWhere, ...NOT_ADVANCE_BUCKET, status: { not: 'draft' } },
    select: { totalAmount: true, amountPaid: true, balanceDue: true },
  });

  const totalBill = bills.reduce((s, b) => s + toNumber(b.totalAmount), 0);
  const totalPaid = bills.reduce((s, b) => s + toNumber(b.amountPaid), 0);
  const totalCredit = bills.reduce((s, b) => s + toNumber(b.balanceDue), 0);

  return {
    totalCollection,
    cash,
    card,
    upi,
    bankTransfer,
    cheque,
    // What went back out, and what the counter is actually holding once it has.
    refunds,
    netCollection: r2(totalCollection - refunds),
    totalBill,
    totalPaid,
    totalCredit,
    netAdvanceAdjusted: 0,
    bySource,
  };
}

// --- Credit Settlements ---

/**
 * Aggregates open A/R into three buckets:
 *   • insurance — bill has an InsuranceClaim; group by Insurer.name.
 *   • corporate — bill's claim links to a TpaProvider; group by TPA.name.
 *     (We treat TPA as the corporate counterparty since the schema has no
 *     dedicated Corporate table.)
 *   • patient — no claim; one row per patient with outstanding self-pay.
 */
export async function getCreditSettlements(
  tenantId: string,
  query: {
    type?: 'insurance' | 'corporate' | 'patient';
    status?: string;
    page?: number;
    limit?: number;
    search?: string;
  },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  const unpaidBills = await prisma.bill.findMany({
    where: {
      tenantId,
      balanceDue: { gt: 0 },
      status: { in: ['pending', 'partially_paid'] },
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
      insuranceClaims: {
        include: {
          policy: {
            include: {
              insurer: { select: { id: true, name: true } },
              tpa: { select: { id: true, name: true } },
            },
          },
        },
        take: 1,
      },
    },
  });

  type Row = {
    id: string;
    providerType: 'insurance' | 'corporate' | 'patient';
    providerName: string;
    providerContact?: string;
    totalAdmissions: number;
    claimAmount: number;
    receivedAmount: number;
    outstandingAmount: number;
    oldestBillDate?: Date;
  };
  const grouped: Record<string, Row> = {};

  const addToGroup = (key: string, row: Omit<Row, 'totalAdmissions' | 'claimAmount' | 'receivedAmount' | 'outstandingAmount'> & { bill: typeof unpaidBills[number] }) => {
    if (!grouped[key]) {
      grouped[key] = {
        id: row.id,
        providerType: row.providerType,
        providerName: row.providerName,
        providerContact: row.providerContact,
        totalAdmissions: 0,
        claimAmount: 0,
        receivedAmount: 0,
        outstandingAmount: 0,
        oldestBillDate: row.bill.createdAt,
      };
    }
    grouped[key].totalAdmissions += 1;
    grouped[key].claimAmount += toNumber(row.bill.totalAmount);
    grouped[key].receivedAmount += toNumber(row.bill.amountPaid);
    grouped[key].outstandingAmount += toNumber(row.bill.balanceDue);
    if (row.bill.createdAt < (grouped[key].oldestBillDate ?? new Date())) {
      grouped[key].oldestBillDate = row.bill.createdAt;
    }
  };

  for (const bill of unpaidBills) {
    const claim = bill.insuranceClaims?.[0];
    if (claim?.policy?.tpa) {
      // Corporate via TPA
      const tpa = claim.policy.tpa;
      addToGroup(`tpa:${tpa.id}`, {
        id: `tpa:${tpa.id}`,
        providerType: 'corporate',
        providerName: tpa.name,
        bill,
      });
    } else if (claim?.policy?.insurer) {
      const ins = claim.policy.insurer;
      addToGroup(`ins:${ins.id}`, {
        id: `ins:${ins.id}`,
        providerType: 'insurance',
        providerName: ins.name,
        bill,
      });
    } else {
      const p = bill.patient;
      // A temporary patient has only a first name by design, and the template
      // literal stringified the missing surname: this row read "Walkin null".
      const name = fullName(p, 'Patient');
      addToGroup(`pat:${bill.patientId}`, {
        id: `pat:${bill.patientId}`,
        providerType: 'patient',
        providerName: name,
        providerContact: p?.phone ?? undefined,
        bill,
      });
    }
  }

  let settlements = Object.values(grouped).map((r) => {
    const ageDays = r.oldestBillDate
      ? Math.floor((Date.now() - r.oldestBillDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    return {
      ...r,
      ageDays,
      tenantId,
      createdAt: formatDateTimeIST(r.oldestBillDate ?? new Date()),
      updatedAt: formatDateTimeIST(new Date()),
    };
  });

  if (query.type) settlements = settlements.filter((s) => s.providerType === query.type);
  if (query.search) {
    const q = query.search.toLowerCase();
    settlements = settlements.filter((s) => s.providerName.toLowerCase().includes(q));
  }

  settlements.sort((a, b) => b.outstandingAmount - a.outstandingAmount);

  const total = settlements.length;
  const paginated = settlements.slice(skip, skip + take);

  const stats = {
    totalProviders: total,
    totalClaim: settlements.reduce((s, r) => s + r.claimAmount, 0),
    totalReceived: settlements.reduce((s, r) => s + r.receivedAmount, 0),
    totalOutstanding: settlements.reduce((s, r) => s + r.outstandingAmount, 0),
  };

  return { settlements: paginated, total, page, limit, stats };
}

/**
 * Bills behind a single provider/patient bucket — used by the credit
 * settlement drill-down so the cashier can pick which invoices to clear.
 */
/**
 * The open bills belonging to ONE payer.
 *
 * `providerId` is `ins:<insurerId>` | `tpa:<tpaId>` | `pat:<patientId>` — the
 * key the receivables list hands back. Extracted so that reading a payer's
 * bills and settling against them can never disagree about which bills are
 * theirs; settleCredit used to build no filter at all.
 */
function creditProviderBillWhere(tenantId: string, providerId: string) {
  const [kind, id] = providerId.split(':');
  if (!id) throw AppError.badRequest('Invalid provider key');

  const base: any = {
    tenantId,
    balanceDue: { gt: 0 },
    status: { in: ['pending', 'partially_paid'] },
  };

  if (kind === 'ins') return { ...base, insuranceClaims: { some: { policy: { insurerId: id } } } };
  if (kind === 'tpa') return { ...base, insuranceClaims: { some: { policy: { tpaId: id } } } };
  if (kind === 'pat') return { ...base, patientId: id, insuranceClaims: { none: {} } };
  throw AppError.badRequest('Unknown provider kind');
}

export async function getCreditSettlementBills(
  tenantId: string,
  providerId: string,
) {
  const where = creditProviderBillWhere(tenantId, providerId);

  const bills = await prisma.bill.findMany({
    where,
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
      insuranceClaims: {
        take: 1,
        include: { policy: { include: { insurer: true, tpa: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return bills.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    patient: b.patient,
    totalAmount: toNumber(b.totalAmount),
    amountPaid: toNumber(b.amountPaid),
    balanceDue: toNumber(b.balanceDue),
    createdAt: b.createdAt,
    ageDays: Math.floor((Date.now() - b.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
    insurer: b.insuranceClaims[0]?.policy?.insurer?.name ?? null,
    tpa: b.insuranceClaims[0]?.policy?.tpa?.name ?? null,
  }));
}

export async function settleCredit(
  tenantId: string,
  userId: string,
  providerId: string,
  data: { amount: number; method?: string; notes?: string },
) {
  if (!(data.amount > 0)) throw AppError.badRequest('Settlement amount must be greater than zero');

  // Only THIS payer's bills. The provider key was accepted and then thrown
  // away: the query filtered on nothing but "unpaid", so recording that an
  // insurer had paid ₹50,000 spread that money over the oldest open bills in
  // the whole hospital — including self-pay patients who owe it themselves and
  // other insurers' claims. Money landed on the wrong accounts entirely.
  const bills = await prisma.bill.findMany({
    where: creditProviderBillWhere(tenantId, providerId),
    orderBy: { createdAt: 'asc' },
  });

  const totalOutstanding = bills.reduce((s, b) => s + toNumber(b.balanceDue), 0);
  if (data.amount > totalOutstanding) {
    throw AppError.badRequest(
      `This payer owes ${totalOutstanding}; cannot settle ${data.amount} against them.`,
    );
  }

  let remaining = data.amount;

  for (const bill of bills) {
    if (remaining <= 0) break;
    const balance = toNumber(bill.balanceDue);
    const payAmount = Math.min(remaining, balance);

    const receiptNumber = await generateReceiptNumber(tenantId);

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          billId: bill.id,
          patientId: bill.patientId,
          amount: payAmount,
          paymentMethod: mapPaymentMethod(data.method || 'bank_transfer') as any,
          notes: data.notes || `Credit settlement for ${providerId}`,
          status: 'completed',
          paymentDate: new Date(),
          processedBy: userId,
        },
      });

      await tx.receipt.create({
        data: {
          tenantId,
          receiptNumber,
          paymentId: payment.id,
          receiptDate: new Date(),
          amount: payAmount,
        },
      });

      // Settle from the ledger the payment above just joined, not from the
      // figure read before this loop started — same stale-read class as the
      // counter payment path.
      await applyPaymentToBill(tx, bill.id);
    });

    remaining -= payAmount;
  }

  const settledAmount = r2(data.amount - remaining);
  logger.info({ tenantId, providerId, settledAmount }, 'Credit settled against payer');
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'payment',
    entityId: providerId,
    description: `Credit settlement of ₹${settledAmount} recorded against ${providerId} across ${bills.length} open bill(s)`,
    reason: data.notes,
    newValues: { providerId, amount: settledAmount, method: data.method ?? 'bank_transfer' },
  });

  return { settledAmount, provider: providerId };
}

// --- Service Tariffs ---

export async function createServiceTariff(tenantId: string, data: CreateServiceTariffInput) {
  // Check for duplicate serviceCode within tenant
  if (data.code) {
    const existing = await prisma.serviceTariff.findFirst({
      where: { tenantId, serviceCode: data.code },
    });

    if (existing) {
      throw AppError.conflict('A service tariff with this code already exists');
    }
  }

  const tariff = await prisma.serviceTariff.create({
    data: {
      tenantId,
      serviceName: data.name,
      serviceCode: data.code,
      category: mapToServiceTariffCategory(data.category) as any,
      basePrice: data.basePrice,
      gstRatePercent: data.taxRate ?? 0,
      modality:
        (data as any).modality ??
        (mapToServiceTariffCategory(data.category) === 'radiology'
          ? deriveImagingModality(data.name)
          : null),
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, tariffId: tariff.id }, 'Service tariff created');
  return tariff;
}

export async function getServiceTariffs(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.category) where.category = mapToServiceTariffCategory(query.category);
  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [
      { serviceName: { contains: query.search, mode: 'insensitive' } },
      { serviceCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tariffs, total] = await Promise.all([
    prisma.serviceTariff.findMany({
      where,
      skip,
      take,
      orderBy: { serviceName: 'asc' },
    }),
    prisma.serviceTariff.count({ where }),
  ]);

  return { tariffs, total, page, limit };
}

export async function updateServiceTariff(
  tenantId: string,
  id: string,
  data: UpdateServiceTariffInput,
) {
  const existing = await prisma.serviceTariff.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Service tariff not found');
  }

  // Check for duplicate code if code is being changed
  if (data.code && data.code !== existing.serviceCode) {
    const duplicate = await prisma.serviceTariff.findFirst({
      where: { tenantId, serviceCode: data.code, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A service tariff with this code already exists');
    }
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.serviceName = data.name;
  if (data.code !== undefined) updateData.serviceCode = data.code;
  if (data.category !== undefined) updateData.category = mapToServiceTariffCategory(data.category);
  if (data.basePrice !== undefined) updateData.basePrice = data.basePrice;
  if (data.taxRate !== undefined) updateData.gstRatePercent = data.taxRate;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if ((data as any).modality !== undefined) {
    updateData.modality = (data as any).modality;
  } else if (data.name !== undefined && existing.category === ('radiology' as any)) {
    // Re-derive the modality when a radiology service is renamed.
    updateData.modality = deriveImagingModality(data.name) as any;
  }

  const tariff = await prisma.serviceTariff.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, tariffId: id }, 'Service tariff updated');
  return tariff;
}

export async function deleteServiceTariff(tenantId: string, id: string) {
  const existing = await prisma.serviceTariff.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Service tariff not found');
  }

  // The BillItem → ServiceTariff relation is optional (onDelete: SetNull), so
  // removing a tariff keeps historical bill lines intact (they just lose the
  // catalog link). Hard-delete so it disappears from the modality catalog.
  await prisma.serviceTariff.delete({ where: { id } });

  logger.info({ tenantId, tariffId: id }, 'Service tariff deleted');
  return { id };
}

// --- Bills ---

export async function createBill(tenantId: string, userId: string, data: CreateBillInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const billNumber = await generateBillNumber(tenantId);

  const bill = await prisma.bill.create({
    data: {
      tenantId,
      billNumber,
      patientId: data.patientId,
      visitId: data.visitId,
      admissionId: data.admissionId,
      billDate: new Date(),
      status: 'draft',
      // The IP running bill already stamped this; the OP counter bill did not,
      // so "who raised this bill" was unanswerable for most of the bills in the
      // system.
      generatedBy: userId,
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount: 0,
      insuranceCoveredAmount: 0,
      patientPayableAmount: 0,
      amountPaid: 0,
      balanceDue: 0,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info({ tenantId, billId: bill.id, billNumber }, 'Bill created');
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'bill',
    entityId: bill.id,
    description: `Bill ${billNumber} raised for ${fullName(patient)} (${patient.mrn ?? 'no MRN'})`,
    newValues: { billNumber, patientId: data.patientId, status: 'draft' },
  });
  return bill;
}

export async function getBills(tenantId: string, query: GetBillsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId, ...NOT_ADVANCE_BUCKET };

  if (query.patientId) where.patientId = query.patientId;
  if (query.status) where.status = query.status;
  // IP vs OP: IP bills are admission-scoped (admissionId set); OP are not.
  if (query.billType === 'ip') where.admissionId = { not: null };
  else if (query.billType === 'op') where.admissionId = null;

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: istDayEnd(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { billNumber: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [bills, total] = await Promise.all([
    prisma.bill.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        // IP context + insurance category so the billing counter knows an IP
        // patient is "insurance"/"corporate" and can offer Transfer-to-TPA.
        admission: {
          select: {
            id: true, billingCategory: true, status: true, depositAmount: true,
            ward: { select: { name: true } },
            bed: { select: { bedNumber: true } },
          },
        },
        // Latest claim (if transferred to TPA) → covered / paid / outstanding.
        insuranceClaims: {
          select: {
            id: true, claimNumber: true, status: true, claimAmount: true,
            approvedAmount: true, coveredAmount: true, patientShare: true,
            paidAmount: true, outstandingAmount: true,
            policy: { select: { id: true, policyNumber: true, insurer: { select: { name: true } }, tpa: { select: { name: true } } } },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.bill.count({ where }),
  ]);

  return { bills, total, page, limit };
}

export async function getBillById(tenantId: string, id: string) {
  const bill = await prisma.bill.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          addressLine1: true,
          city: true,
        },
      },
      billItems: {
        include: {
          serviceTariff: {
            select: { id: true, serviceName: true, serviceCode: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  return bill;
}

export async function addBillItem(tenantId: string, billId: string, data: AddBillItemInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only add items to draft bills');
  }

  // If service tariff is provided, verify it exists
  let tariff: Awaited<ReturnType<typeof prisma.serviceTariff.findFirst>> = null;
  if (data.serviceTariffId) {
    tariff = await prisma.serviceTariff.findFirst({
      where: { id: data.serviceTariffId, tenantId },
    });
    if (!tariff) {
      throw AppError.notFound('Service tariff not found');
    }
  }

  const unitPrice = data.unitPrice;
  const quantity = data.quantity;
  const discountAmount = data.discount ?? 0;
  const discountPercent = unitPrice > 0 ? (discountAmount / (quantity * unitPrice)) * 100 : 0;

  // The rate comes from the tariff the line is for, not from the request.
  // A rate typed at the counter is how this hospital ended up with
  // registration fees at 10%, procedures at 2% and "other" at 2% — none of
  // which are rates that exist in law. `data.taxRate` is still accepted for a
  // free-text line with no tariff behind it, but such a line is flagged for
  // resolution rather than quietly billed.
  const resolver = await taxResolverFor(tenantId, bill.billDate ?? new Date());
  const priced = resolver.price(
    {
      kind: tariff ? supplyKindForCategory(String(tariff.category)) : 'other',
      sacCode: (tariff as any)?.sacCode ?? null,
      itemRatePercent: (tariff as any)?.gstApproved
        ? toNumber(tariff!.gstRatePercent)
        : (data.taxRate ?? null),
      itemTreatment: (tariff as any)?.gstTreatment ?? null,
      itemApproved: (tariff as any)?.gstApproved ?? false,
      isCosmetic: (tariff as any)?.isCosmetic ?? false,
    },
    { unitPrice, quantity, discountAmount },
  );

  const item = await prisma.billItem.create({
    data: {
      billId,
      serviceTariffId: data.serviceTariffId,
      description: data.description,
      category: tariff ? (String(tariff.category) as any) : 'other',
      quantity,
      unitPrice,
      discountPercent,
      discountAmount,
      ...billItemTaxFields(priced),
    },
  });

  // Recalculate bill totals
  await recalculateBillTotals(billId);

  logger.info({ tenantId, billId, itemId: item.id }, 'Bill item added');
  return item;
}

// Front-desk edit of a draft bill's line — change any of description / qty /
// unit price / discount / tax, then recompute the line and the bill totals.
export async function updateBillItem(
  tenantId: string,
  billId: string,
  itemId: string,
  data: UpdateBillItemInput,
) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft') throw AppError.badRequest('Can only edit items on draft bills');

  const item = await prisma.billItem.findFirst({ where: { id: itemId, billId } });
  if (!item) throw AppError.notFound('Bill item not found');

  const quantity = data.quantity ?? item.quantity;
  const unitPrice = data.unitPrice ?? Number(item.unitPrice);
  const discountAmount = data.discount ?? Number(item.discountAmount);
  const discountPercent = unitPrice > 0 ? (discountAmount / (quantity * unitPrice)) * 100 : 0;

  // Editing quantity or price re-prices the line, and the tax has to follow it.
  // The classification the line was WRITTEN with is kept — its code, treatment
  // and the rule that decided them — so an edit changes the money without
  // silently re-classifying the supply.
  const resolver = await taxResolverFor(tenantId, bill.billDate ?? new Date());
  const priced = resolver.price(
    {
      kind: supplyKindForCategory(String(item.category)),
      hsnCode: item.hsnSacCode,
      itemRatePercent: data.taxRate ?? Number(item.taxPercent),
      itemTreatment: (item.gstTreatment as any) ?? (Number(item.taxPercent) > 0 ? 'taxable' : null),
      itemApproved: true,
      taxInclusive: item.taxInclusive,
    },
    { unitPrice, quantity, discountAmount },
  );

  const updated = await prisma.billItem.update({
    where: { id: itemId },
    data: {
      description: data.description ?? item.description,
      quantity,
      unitPrice,
      discountPercent,
      discountAmount,
      ...billItemTaxFields(priced),
    },
  });

  await recalculateBillTotals(billId);
  logger.info({ tenantId, billId, itemId }, 'Bill item updated');
  return updated;
}

export async function removeBillItem(tenantId: string, billId: string, itemId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only remove items from draft bills');
  }

  const item = await prisma.billItem.findFirst({
    where: { id: itemId, billId },
  });

  if (!item) {
    throw AppError.notFound('Bill item not found');
  }

  await prisma.billItem.delete({ where: { id: itemId } });

  // Recalculate bill totals
  await recalculateBillTotals(billId);

  logger.info({ tenantId, billId, itemId }, 'Bill item removed');
}

/**
 * Refuse a bill whose taxable lines carry a rate the law does not recognise.
 *
 * Shared by the two paths that issue a document: `finalizeBill` for everything
 * the front desk and the ward raise, and the pharmacy counter sale, which
 * writes a paid bill directly and never passes through here.
 *
 * Silent when the slab master is empty — a check that cannot be made must not
 * start refusing every bill in the hospital.
 */
export async function assertRatesAreLegalSlabs(billId: string, billDate: Date): Promise<void> {
  const { loadGstSlabs, isLegalSlabRate, slabsOn, describeSlabs } = await import(
    '../../shared/gst-slabs'
  );
  let slabs;
  try {
    slabs = await loadGstSlabs();
  } catch (err) {
    logger.warn({ err, billId }, 'GST slab master unreadable — the rate check is skipped');
    return;
  }
  const legal = slabsOn(slabs, billDate);
  if (legal.length === 0) return;

  const taxed = await prisma.billItem.findMany({
    where: { billId, gstTreatment: 'taxable' },
    select: { description: true, taxPercent: true },
  });

  const offending = new Map<number, string[]>();
  for (const it of taxed) {
    const rate = Number(it.taxPercent ?? 0);
    if (rate <= 0) continue;
    if (isLegalSlabRate(slabs, rate, billDate)) continue;
    const names = offending.get(rate) ?? [];
    if (names.length < 3) names.push(it.description);
    offending.set(rate, names);
  }
  if (offending.size === 0) return;

  const listed = [...offending.entries()]
    .map(([rate, names]) => `${rate}% (${names.join(', ')})`)
    .join('; ');
  throw AppError.badRequest(
    `This bill carries a GST rate that is not a legal slab on ${billDate
      .toISOString()
      .slice(0, 10)}: ${listed}. Legal rates on that date are ${describeSlabs(legal)}. ` +
      "Correct the item's classification before finalizing.",
  );
}

/**
 * Name and number a bill that was created already-payable.
 *
 * `finalizeBill` is the front door: draft in, numbered document out. Three
 * high-volume paths never use it — the front-desk consultation bill, and the
 * patient portal's two — because they create the bill at `status: 'pending'`
 * with its lines already on it and nothing left to finalise. So they issued no
 * document type and no invoice number at all: forty-eight `BILL-` rows in this
 * database are non-draft and unnumbered, which is forty-eight supplies the
 * hospital cannot put in a return.
 *
 * BEST EFFORT, deliberately, and this is the one place that judgement differs
 * from `finalizeBill`. There the refusals come BEFORE money is demanded, so
 * refusing is the safe answer. Here the bill already exists and the patient may
 * already be paying; failing the consultation because a registration fee is
 * configured at a retired slab would take the busiest desk in the hospital down
 * over a settings row. So a bill that cannot be issued cleanly is left
 * unnumbered and logged — and an unnumbered non-draft bill is exactly what C-3
 * and C-4 exist to surface.
 */
export async function issueDocumentForExistingBill(
  tenantId: string,
  billId: string,
): Promise<{ documentType: string; invoiceNumber: string | null } | null> {
  try {
    const bill = await prisma.bill.findFirst({
      where: { id: billId, tenantId },
      select: {
        id: true, billDate: true, invoiceNumber: true, status: true,
        recipientGstin: true,
        billItems: { select: { taxAmount: true, gstTreatment: true, taxPercent: true, description: true } },
      },
    });
    // Already numbered, gone, or still a draft that finalizeBill will handle.
    if (!bill || bill.invoiceNumber || bill.status === 'draft' || bill.status === 'cancelled') return null;

    const profile = await getGstProfile(tenantId);
    if (!profile.registered) return null;

    await assertRatesAreLegalSlabs(billId, bill.billDate);

    return await prisma.$transaction((tx) =>
      issueDocumentForBill(
        tx,
        tenantId,
        {
          id: bill.id,
          billDate: bill.billDate,
          recipientGstin: bill.recipientGstin,
          invoiceNumber: bill.invoiceNumber,
        },
        bill.billItems,
        { registered: profile.registered },
      ),
    );
  } catch (err) {
    logger.warn({ err, tenantId, billId }, 'Could not issue a GST document for this bill');
    return null;
  }
}

export async function finalizeBill(tenantId: string, userId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { billItems: true },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Only draft bills can be finalized');
  }

  if (bill.billItems.length === 0) {
    throw AppError.badRequest('Cannot finalize a bill with no items');
  }

  // A concession still awaiting approval is not yet off the bill. Finalising
  // now would present the patient a figure that is about to change the moment
  // somebody approves it — and collecting against it would then leave the bill
  // over-paid.
  const undecided = await prisma.discount.count({ where: { billId, status: 'pending' } });
  if (undecided > 0) {
    throw AppError.badRequest(
      'A concession on this bill is awaiting approval. Get it approved or rejected before finalizing.',
    );
  }

  // A taxable line that only a category default made taxable is a GUESSED
  // rate. Finalising is the moment a draft becomes a demand for money, and a
  // guessed tax rate is not something to demand money against — the item needs
  // classifying first. Exempt fallbacks pass, because exempt is the correct
  // default for healthcare rather than a guess.
  const unresolvedCount = await prisma.billItem.count({
    where: { billId, requiresTaxResolution: true },
  });
  if (unresolvedCount > 0) {
    // Only fetched to name them — the counter needs to know WHICH lines to fix,
    // not just that some exist.
    const unresolved = await prisma.billItem.findMany({
      where: { billId, requiresTaxResolution: true },
      select: { description: true },
      take: 3,
    });
    const names = unresolved.map((u) => u.description).join(', ');
    throw AppError.badRequest(
      `${unresolvedCount} line(s) on this bill have no GST classification: ${names}${
        unresolvedCount > 3 ? '…' : ''
      }. Set an HSN or SAC code on the item, or have the rate approved, before finalizing.`,
    );
  }

  // A rate that is not a slab is an invoice the portal will reject.
  //
  // Deciding WHICH rate applies and deciding whether that rate EXISTS are
  // different questions, and only the second catches a rate typed onto a
  // master years ago and never revisited. This database carries pharmacy lines
  // at 10% and 12%; 12% was retired on 22 September 2025 and 10% has never been
  // a GST slab at all. Nothing refused them, because nothing knew what the
  // slabs were.
  //
  // Checked AS AT the bill's own date, so a bill corrected from before the
  // cut-over is still judged by the rates that applied when it was raised. A
  // line carrying no tax is not checked: zero is the absence of a rate, not a
  // rate charged, and exempt lines sit there legitimately in every period.
  await assertRatesAreLegalSlabs(billId, bill.billDate);

  // Recalculate final totals
  await recalculateBillTotals(billId);

  const profile = await getGstProfile(tenantId);

  const updatedBill = await prisma.$transaction(async (tx) => {
    const items = await tx.billItem.findMany({
      where: { billId },
      select: { taxAmount: true, gstTreatment: true },
    });
    // Name and number the document. What it is called follows from its lines;
    // the number comes from the hospital's own series for this financial year.
    await issueDocumentForBill(
      tx,
      tenantId,
      {
        id: billId,
        billDate: bill.billDate,
        recipientGstin: (bill as any).recipientGstin ?? null,
        invoiceNumber: (bill as any).invoiceNumber ?? null,
      },
      items,
      { registered: profile.registered },
    );

    return tx.bill.update({
    where: { id: billId },
    data: {
      status: 'pending',
      // Finalising is the moment a draft becomes a demand for money — record
      // who did it, which the column exists for and nothing was setting.
      approvedBy: userId,
      // Snapshot the hospital's own identity onto the document. It was raised
      // under this registration, and an old bill has to stay explainable even
      // after the hospital's details change.
      supplierGstin: profile.gstin,
      supplierStateCode: profile.stateCode,
      placeOfSupplyStateCode: (bill as any).placeOfSupplyStateCode ?? profile.stateCode,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      billItems: true,
    },
    });
  });

  logger.info(
    {
      tenantId,
      billId,
      totalAmount: updatedBill.totalAmount,
      documentType: (updatedBill as any).gstDocumentType,
      invoiceNumber: (updatedBill as any).invoiceNumber,
    },
    'Bill finalized',
  );
  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description: `Bill ${updatedBill.billNumber} finalized — ₹${toNumber(updatedBill.totalAmount)} payable across ${updatedBill.billItems.length} line(s)`,
    oldValues: { status: 'draft' },
    newValues: {
      status: 'pending',
      totalAmount: toNumber(updatedBill.totalAmount),
      itemCount: updatedBill.billItems.length,
    },
  });
  return updatedBill;
}

/**
 * Undo an accidental finalize: `pending` → `draft` so the counter can keep
 * adding items to the same bill instead of abandoning it and starting a new
 * one. Only safe while nothing has been collected against it — once a payment
 * (or an insurance claim) exists the bill has left the counter's hands and must
 * be adjusted/cancelled through the normal routes instead.
 */
export async function reopenBill(tenantId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: {
      _count: { select: { payments: true, insuranceClaims: true } },
    },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status === 'draft') {
    return bill; // already editable — idempotent
  }

  if (bill.status !== 'pending') {
    throw AppError.badRequest(
      `Cannot reopen a ${bill.status.replace(/_/g, ' ')} bill`,
    );
  }

  if (Number(bill.amountPaid) > 0 || bill._count.payments > 0) {
    throw AppError.badRequest(
      'Cannot reopen a bill that already has payments. Reverse the payment first.',
    );
  }

  if (bill._count.insuranceClaims > 0) {
    throw AppError.badRequest(
      'Cannot reopen a bill that has been transferred to insurance/TPA.',
    );
  }

  const updated = await prisma.bill.update({
    where: { id: billId },
    data: { status: 'draft' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      billItems: true,
    },
  });

  logger.info({ tenantId, billId }, 'Bill reopened for editing');
  void writeAudit({
    tenantId,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description: `Bill ${updated.billNumber} reopened for editing — pulled back from pending to draft`,
    oldValues: { status: 'pending' },
    newValues: { status: 'draft' },
  });
  return updated;
}

// --- Payments ---

export async function createPayment(
  tenantId: string,
  userId: string,
  data: CreatePaymentInput,
) {
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status === 'draft') {
    throw AppError.badRequest(
      'This bill is still open for charges. Generate / refresh the bill first — that pulls the pending charges on and finalizes it for payment.',
    );
  }

  if (bill.status === 'paid') {
    throw AppError.badRequest('Bill is already fully paid');
  }

  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Cannot pay a cancelled bill');
  }

  const balanceDue = toNumber(bill.balanceDue);
  if (data.amount > balanceDue) {
    throw AppError.badRequest(
      `Payment amount (${data.amount}) exceeds the balance due (${balanceDue})`,
    );
  }

  const receiptNumber = await generateReceiptNumber(tenantId);
  const mappedPaymentMethod = mapPaymentMethod(data.paymentMethod) as any;

  // Create payment and receipt in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: data.billId,
        patientId: bill.patientId,
        amount: data.amount,
        paymentMethod: mappedPaymentMethod,
        paymentSource: 'frontdesk',
        transactionId: data.referenceNumber,
        notes: data.notes,
        status: 'completed',
        paymentDate: new Date(),
        // Who took the money. Every other payment path already recorded this;
        // the main counter path — by far the highest volume — did not, so the
        // busiest cash records had no cashier attached to them.
        processedBy: userId,
      },
    });

    // Create receipt
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    await applyPaymentToBill(tx, data.billId);

    return { payment, receipt };
  });

  logger.info(
    { tenantId, billId: data.billId, paymentId: result.payment.id, amount: data.amount },
    'Payment recorded',
  );
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'payment',
    entityId: result.payment.id,
    description:
      `₹${data.amount} collected on bill ${bill.billNumber} by ${mappedPaymentMethod.replace(/_/g, ' ')}` +
      ` — receipt ${result.receipt.receiptNumber}`,
    newValues: {
      billId: data.billId,
      amount: data.amount,
      paymentMethod: mappedPaymentMethod,
      referenceNumber: data.referenceNumber ?? null,
      receiptNumber: result.receipt.receiptNumber,
    },
  });
  return result;
}

export async function getPayments(tenantId: string, query: GetPaymentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.billId) where.billId = query.billId;
  if (query.paymentMethod) where.paymentMethod = mapPaymentMethod(query.paymentMethod);

  if (query.fromDate) {
    where.paymentDate = { ...where.paymentDate, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.paymentDate = { ...where.paymentDate, lte: istDayEnd(query.toDate) };
  }

  // The Cash Counter has a search box and it did nothing at all. `search` is
  // part of the shared pagination schema so it reached the service, and the
  // service simply never looked at it — no client-side filter either, so the
  // list came back whole and typing a bill number changed nothing on screen.
  //
  // Matched against what a cashier actually has in front of them: the bill
  // number, the patient's name or MRN, and the payment's own reference — a UPI
  // or card reference is often the only thing on the slip they are holding.
  if (query.search?.trim()) {
    const q = query.search.trim();
    where.OR = [
      { bill: { billNumber: { contains: q, mode: 'insensitive' } } },
      { transactionId: { contains: q, mode: 'insensitive' } },
      { gatewayReference: { contains: q, mode: 'insensitive' } },
      { receipt: { receiptNumber: { contains: q, mode: 'insensitive' } } },
      { patient: { mrn: { contains: q, mode: 'insensitive' } } },
      { patient: { firstName: { contains: q, mode: 'insensitive' } } },
      { patient: { lastName: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take,
      include: {
        bill: {
          select: { id: true, billNumber: true, totalAmount: true },
        },
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        // The Cash Counter lists who took each payment — with manual entry that
        // attribution is the control, so it belongs on the row itself.
        processor: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.count({ where }),
  ]);

  return { payments, total, page, limit };
}

// --- Refunds ---

export async function createRefund(
  tenantId: string,
  userId: string,
  data: CreateRefundInput,
) {
  const payment = await prisma.payment.findFirst({
    where: { id: data.paymentId, tenantId, status: 'completed' },
    include: { bill: true },
  });

  if (!payment) {
    throw AppError.notFound('Payment not found or not completed');
  }

  const paymentAmount = toNumber(payment.amount);
  if (data.amount > paymentAmount) {
    throw AppError.badRequest('Refund amount cannot exceed the payment amount');
  }

  // Check for existing refunds on this payment
  const existingRefunds = await prisma.refund.findMany({
    where: { paymentId: data.paymentId, status: { in: ['requested', 'approved'] } },
  });

  const totalRefunded = existingRefunds.reduce((sum: number, r: { amount: Decimal }) => sum + toNumber(r.amount), 0);
  if (totalRefunded + data.amount > paymentAmount) {
    throw AppError.badRequest(
      'Total refund amount cannot exceed the payment amount. Already refunded: ' + totalRefunded,
    );
  }

  const refund = await prisma.refund.create({
    data: {
      tenantId,
      paymentId: data.paymentId,
      billId: payment.billId,
      patientId: payment.patientId,
      amount: data.amount,
      reason: data.reason,
      status: 'requested',
      // Populates the Refunds tab's requester column, which was permanently
      // blank because nothing ever wrote this.
      requestedBy: userId,
    },
  });

  logger.info(
    { tenantId, refundId: refund.id, paymentId: data.paymentId, amount: data.amount },
    'Refund request created',
  );
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'refund',
    entityId: refund.id,
    description:
      `Refund of ₹${data.amount} requested against a ₹${paymentAmount} payment` +
      (payment.bill ? ` on bill ${payment.bill.billNumber}` : ''),
    reason: data.reason,
    newValues: {
      amount: data.amount,
      paymentId: data.paymentId,
      billId: payment.billId,
      status: 'requested',
    },
  });
  return refund;
}

export async function approveRefund(tenantId: string, refundId: string, approvedBy: string) {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, tenantId, status: 'requested' },
    include: { bill: true, payment: true },
  });

  if (!refund) {
    throw AppError.notFound('Refund not found or not in pending status');
  }

  // The other order of the same mistake: a refund requested while the payment
  // was live, then approved after it was reversed. Paying out against money the
  // ledger no longer counts as collected drives the bill negative just the same.
  if (refund.payment?.status === 'reversed') {
    throw AppError.badRequest(
      'The payment behind this refund has been reversed, so there is nothing to refund.',
    );
  }

  const refundAmount = toNumber(refund.amount);
  // Hand the money back the way it came in, so the drawer and the card/UPI
  // settlement each reconcile against their own line.
  const refundMethod = (refund.payment?.paymentMethod ?? 'cash') as any;

  const result = await prisma.$transaction(async (tx) => {
    const updatedRefund = await tx.refund.update({
      where: { id: refundId },
      data: {
        status: 'approved',
        approvedBy,
        processedAt: new Date(),
      },
    });

    // Cash actually leaving the counter. Approving a refund used to adjust the
    // bill and nothing else, so a ₹500 note handed back across the counter left
    // no record anywhere — Day End's refund line was structurally always ₹0 and
    // the drawer could never be tallied against the system.
    //
    // `paymentType: 'refund'` keeps it out of `computeBillPaid`'s collected sum
    // and out of Collected on the reports; the bill's own reduction comes from
    // the Refund row, so the money is counted once, not twice.
    const payout = await tx.payment.create({
      data: {
        tenantId,
        billId: refund.billId,
        patientId: refund.patientId,
        amount: refundAmount,
        paymentMethod: refundMethod,
        paymentSource: 'frontdesk',
        paymentType: 'refund',
        status: 'completed',
        paymentDate: new Date(),
        processedBy: approvedBy,
        notes: `Refund against payment ${refund.paymentId} — ${refund.reason}`,
      },
    });

    // The patient signs for money going out just as they do for money coming in.
    const payoutReceipt = await issueReceiptForPayment(tx, tenantId, payout.id, refundAmount);

    // Settle from the ledger rather than from the figure read before the
    // transaction opened. The status rules are the ones this function has
    // always applied: nothing left paid means the bill is refunded, an open
    // balance means partially paid, and anything else is left alone.
    const bill = refund.bill!;
    const newPaidAmount = await computeBillPaid(tx, bill.id);
    const totalAmount = toNumber(bill.totalAmount);
    const newBalanceDue = totalAmount - newPaidAmount;

    let newStatus = bill.status;
    if (newPaidAmount <= 0) {
      newStatus = 'refunded';
    } else if (newBalanceDue > 0) {
      newStatus = 'partially_paid';
    }

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        amountPaid: newPaidAmount,
        balanceDue: newBalanceDue,
        status: newStatus,
      },
    });

    // The money has gone back; the tax on it has to go back too, or the
    // hospital keeps owing the department output tax on a supply it reversed.
    //
    // A refund here is a rupee amount with no link to any line — that is what
    // the Refund model records — so the share it represents of the whole bill
    // is the only thing that can be known. A full refund credits everything; a
    // part refund credits that proportion of every line, which keeps each
    // line's own rate and split intact rather than guessing a blended one.
    const refundedAmount = toNumber(refund.amount);
    const share = totalAmount > 0 ? Math.min(1, refundedAmount / totalAmount) : 0;
    if (share > 0) {
      const lines = await tx.billItem.findMany({
        where: { billId: bill.id },
        select: { id: true },
      });
      await issueCreditNoteBestEffort(tx, tenantId, {
        billId: bill.id,
        reason: 'sales_return',
        reasonNote: refund.reason,
        refundId: refund.id,
        issuedBy: approvedBy,
        lines: lines.map((l: { id: string }) => ({ billItemId: l.id, share })),
      });
    }

    return { updatedRefund, payout, payoutReceipt, newPaidAmount, newStatus };
  });

  logger.info(
    { tenantId, refundId, approvedBy, amount: refund.amount, payoutId: result.payout.id },
    'Refund approved and paid out',
  );
  void writeAudit({
    tenantId,
    userId: approvedBy,
    action: 'update',
    entityType: 'refund',
    entityId: refundId,
    description:
      `Refund of ₹${refundAmount} approved and paid out by ${String(refundMethod).replace(/_/g, ' ')}` +
      (refund.bill ? ` on bill ${refund.bill.billNumber}` : '') +
      ` — receipt ${result.payoutReceipt.receiptNumber}`,
    oldValues: { status: 'requested', billAmountPaid: toNumber(refund.bill?.amountPaid) },
    newValues: {
      status: 'approved',
      payoutPaymentId: result.payout.id,
      payoutReceiptNumber: result.payoutReceipt.receiptNumber,
      billAmountPaid: result.newPaidAmount,
      billStatus: result.newStatus,
    },
  });

  // Callers (and the Refunds tab) expect the refund row itself.
  return result.updatedRefund;
}

// --- Discounts ---

/**
 * Raise the credit note a concession on an ISSUED bill owes.
 *
 * A discount on a DRAFT is pricing: no document exists yet, and the invoice is
 * eventually issued for the net. A discount after the invoice has been issued
 * is something else entirely — the supply was declared at one value and the
 * patient is being charged another, and section 34 says the difference travels
 * on a credit note. Without one the hospital declares tax on money it never
 * collected, with nothing on paper to explain the gap.
 *
 * Two things this does NOT do, both deliberate:
 *
 *   - it does not touch the frozen line tax. The invoice said what it said, and
 *     restating it would rewrite a document already with the patient. The
 *     credit note carries the reversal instead, which is the instrument for it.
 *   - it does not act on a PENDING concession. The figure below comes from
 *     approved `Discount` rows only, so a concession awaiting a second pair of
 *     eyes raises nothing until somebody decides on it — the same rule that
 *     keeps it off the patient's total.
 *
 * Credited in INCREMENTS. A concession raised from 1,000 to 1,500 owes a note
 * for 500, not a second one for 1,500, so the amount already credited is
 * subtracted first. That also makes this safe to call from every writer after
 * every recalculation: with nothing new to credit it does nothing.
 */
async function creditPostSupplyConcession(
  tenantId: string,
  billId: string,
  opts: { issuedBy?: string | null; note?: string | null } = {},
): Promise<void> {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    select: {
      id: true,
      invoiceNumber: true,
      billItems: { select: { id: true, totalAmount: true } },
      creditNotes: { select: { reason: true, totalAmount: true } },
    },
  });
  // Never issued, never a document. There is nothing to reverse.
  if (!bill?.invoiceNumber) return;

  const [approved, invoiced] = [
    await prisma.discount.aggregate({
      where: { billId, status: 'approved' },
      _sum: { value: true },
    }),
    bill.billItems.reduce((t, it) => t + toNumber(it.totalAmount), 0),
  ];
  const concession = toNumber(approved._sum.value);
  if (concession <= 0 || invoiced <= 0) return;

  // Credit note totals are stored NEGATIVE, so that summing a patient's
  // documents nets to their real position. Take the size of what has been
  // credited, not its sign.
  const alreadyCredited = bill.creditNotes
    .filter((c) => c.reason === 'post_supply_discount')
    .reduce((t, c) => t + Math.abs(toNumber(c.totalAmount)), 0);

  const increment = r2(concession - alreadyCredited);
  if (increment <= 0.005) {
    if (increment < -0.005) {
      // A concession that has been REDUCED after being credited. Putting the
      // money back on an issued invoice is a debit note, not a credit note,
      // and inventing one here would be the wrong document. Logged so the
      // accountant raises it rather than the system guessing.
      logger.warn(
        { tenantId, billId, concession, alreadyCredited },
        'A concession on an issued bill was reduced below what has been credited — that needs a debit note',
      );
    }
    return;
  }

  // Apportioned across every line by value, so each line's own rate and split
  // scale with it. A blended rate on a mixed bill — a taxable room beside an
  // exempt surgery — would reverse tax the exempt half never carried.
  const share = Math.min(1, increment / invoiced);
  await prisma.$transaction(async (tx) => {
    await issueCreditNoteBestEffort(tx, tenantId, {
      billId,
      reason: 'post_supply_discount',
      reasonNote: opts.note ?? 'Concession granted after the invoice was issued',
      issuedBy: opts.issuedBy ?? null,
      lines: bill.billItems.map((it) => ({ billItemId: it.id, share })),
    });
  });
}

export async function applyDiscount(
  tenantId: string,
  billId: string,
  data: ApplyDiscountInput,
  userId?: string,
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft' && bill.status !== 'pending') {
    throw AppError.badRequest('Can only apply discounts to draft or pending bills');
  }

  const subtotal = toNumber(bill.subtotal);
  let discountValue: number;
  if (data.discountType === 'percentage') {
    if (data.discountValue > 100) {
      throw AppError.badRequest('Percentage discount cannot exceed 100%');
    }
    discountValue = subtotal * (data.discountValue / 100);
  } else {
    discountValue = data.discountValue;
    if (discountValue > subtotal) {
      throw AppError.badRequest('Fixed discount cannot exceed the subtotal');
    }
  }

  // The same gate the counter's own concession field goes through. Without it
  // this endpoint was a second door into the same table: it took `billing:update`
  // rather than `billing:approve`, wrote the row at its default status of
  // `approved`, and the money came off at once however large the concession —
  // which makes the limit on the other path a matter of which endpoint you call.
  const approvalPolicy = await getDiscountApprovalSettings(tenantId);
  const needsApproval = discountNeedsApproval(approvalPolicy, discountValue, subtotal);

  const discount = await prisma.discount.create({
    data: {
      tenantId,
      billId,
      discountType: data.discountType as any,
      value: discountValue,
      reason: data.reason,
      status: needsApproval ? 'pending' : 'approved',
      requestedBy: userId,
      approvedBy: needsApproval ? null : userId,
      decidedAt: needsApproval ? null : new Date(),
    },
  });

  // One definition of what a bill comes to. This used to recompute the total
  // here as `subtotal − discount + tax`, which is only right when every line
  // adds its tax on top — a bill carrying a tax-INCLUSIVE medicine price had
  // the GST already inside the MRP added a second time. recalculateBillTotals
  // sums the line totals and folds in the bill-level Discount rows, so the
  // three places that used to hold this arithmetic can no longer drift apart.
  await recalculateBillTotals(billId);
  // A concession on an already-issued invoice owes a credit note. Safe to call
  // unconditionally: a concession still awaiting approval has moved no money,
  // so there is nothing yet to credit.
  await creditPostSupplyConcession(tenantId, billId, { issuedBy: userId, note: data.reason });

  logger.info(
    { tenantId, billId, discountValue, needsApproval },
    needsApproval ? 'Discount awaiting approval' : 'Discount applied',
  );
  // The caller needs to know whether the money actually came off, so it can say
  // "sent for approval" rather than implying it is done.
  return Object.assign(discount, { discountPendingApproval: needsApproval });
}

// --- Patient Charges (auto-pull from clinical sources) ---

export type ChargeSource =
  | 'consultation'
  | 'lab'
  | 'pharmacy'
  | 'imaging'
  | 'room'
  | 'ot'
  | 'all';

interface ChargeRow {
  source: 'consultation' | 'lab' | 'pharmacy' | 'imaging' | 'room' | 'ot';
  referenceType: string;
  referenceId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  taxRate: number;
  /**
   * True when `unitPrice` ALREADY contains the tax — pharmacy prices are MRP,
   * which is tax-inclusive by law. Such a line shows the embedded GST as a
   * breakup; it must never have tax added on top of it.
   */
  taxInclusive?: boolean;
  category: string;
  occurredAt: string;
  /** Raw ISO timestamp for chronological sorting (occurredAt is display-only). */
  occurredAtISO: string;
  status: string;
  alreadyBilled: boolean;
  billItemId?: string;
  billId?: string;
  /**
   * False when this counter may not bill the line itself. Lab and radiology
   * charges are the department's own: an OP patient pays at their counter, an
   * admitted one has it posted to the stay ledger when the department accepts.
   * The row stays VISIBLE — the front desk still needs the running picture of
   * what a patient has had — but it cannot be selected.
   */
  pullable?: boolean;
  /** Shown against a row that cannot be selected, so "why not" is answerable. */
  notPullableReason?: string;
  /**
   * What the room rule needs to decide, carried on the row.
   *
   * `pullChargesToBill` has always read `c.dailyRate`, `c.bedType` and
   * `c.wardType` — and nothing ever set them. So every room line reached
   * `determineTax` with a daily rate of ZERO, fell under the Rs 5,000
   * threshold, and came out exempt. A deluxe room at Rs 6,000 a day, which the
   * GST report's own worked example bills at 5% for Rs 900 of tax on a
   * three-day stay, was billed at nil.
   *
   * `unitPrice` IS the per-day rate on a room row (quantity is days), so
   * `dailyRate` mirrors it; the two are kept separate because only a room row
   * has a meaningful per-day figure.
   */
  dailyRate?: number;
  bedType?: string | null;
  wardType?: string | null;
}

/**
 * Healthcare in India is GST-EXEMPT by default.
 *
 * Treatment, consultation, diagnostics and therapeutic procedures by a clinical
 * establishment are exempt under Notification 12/2017-Central Tax (Rate) — a
 * hospital issues a BILL OF SUPPLY for them, not a tax invoice. So the honest
 * default for every service is zero, and tax is the exception a hospital opts
 * into on the specific tariff that carries it.
 *
 * The exceptions that do exist, and how each is handled here:
 *   • Non-ICU room rent above ₹5,000/day → 5% — see {@link roomTaxRate}.
 *   • Cosmetic (non-therapeutic) surgery → 18% — set on that tariff.
 *   • Medicines → 5/12/18% by HSN, and MRP is tax-INCLUSIVE — read off the
 *     dispensed batch, never guessed.
 *
 * This is deliberately not a "best guess". Inventing a rate would overcharge a
 * patient for tax the hospital never owed; showing none where a hospital has
 * configured none is both correct and what the law expects.
 */
const CHARGE_TAX_RATES: Record<string, number> = {
  consultation: 0,
  lab: 0,
  pharmacy: 0,
  imaging: 0,
  room: 0,
  ot: 0,
};

/** ChargeSource → the ServiceTariff category that prices (and taxes) it. */
const SOURCE_TARIFF_CATEGORY: Record<string, string> = {
  consultation: 'consultation',
  lab: 'lab',
  imaging: 'radiology',
  room: 'room',
  ot: 'surgery',
  pharmacy: 'pharmacy',
};

/**
 * Non-ICU room rent above this per-day figure attracts GST — and on the WHOLE
 * day's rent, not merely the part above the line. At or below it, and in ICU at
 * any rate, room rent is exempt.
 */
const ROOM_GST_THRESHOLD_PER_DAY = 5000;
const ROOM_GST_RATE_ABOVE_THRESHOLD = 5;

/** ICU/NICU/PICU rent is exempt whatever it costs. */
function isIcuAccommodation(bedType?: string | null, wardType?: string | null): boolean {
  const b = String(bedType ?? '').toLowerCase();
  const w = String(wardType ?? '').toLowerCase();
  return b === 'icu' || w === 'icu' || w === 'nicu' || w === 'picu';
}

/**
 * GST on a day of room rent, by the rule that actually applies in India rather
 * than by whatever the room category averages out to.
 *
 * Getting this from a category default was wrong in a way that costs patients
 * money: a hospital whose tariffs are mostly deluxe AC rooms at 5% would have
 * had that 5% applied to a ₹1,500 general-ward bed billed off the ward's own
 * daily charge — rent that is plainly exempt.
 */
function roomTaxRate(
  dailyRate: number,
  opts: { bedType?: string | null; wardType?: string | null; configuredRate?: number | null },
): number {
  if (isIcuAccommodation(opts.bedType, opts.wardType)) return 0;
  if (dailyRate <= ROOM_GST_THRESHOLD_PER_DAY) return 0;
  // Above the line: the hospital's own configured rate for that room if it set
  // one, else the statutory 5%.
  return opts.configuredRate != null && opts.configuredRate > 0
    ? opts.configuredRate
    : ROOM_GST_RATE_ABOVE_THRESHOLD;
}

/**
 * Per-category GST read from the tenant's ServiceTariff master.
 *
 * Only a category whose active tariffs ALL agree on one rate yields a default —
 * a mixed category (a surgery list holding both exempt therapeutic procedures
 * and taxable cosmetic ones) falls back to exempt rather than picking the
 * commoner of the two and taxing the wrong half. A charge that resolves to one
 * specific tariff always uses that tariff's own rate, which is the precise
 * answer and beats any default.
 */
async function buildServiceTaxRates(tenantId: string): Promise<Record<string, number>> {
  const tariffs = await prisma.serviceTariff.findMany({
    where: { tenantId, isActive: true },
    select: { category: true, gstRatePercent: true },
  });

  const seen = new Map<string, Set<number>>();
  for (const t of tariffs) {
    const cat = String(t.category);
    const set = seen.get(cat) ?? new Set<number>();
    set.add(toNumber(t.gstRatePercent));
    seen.set(cat, set);
  }

  const rates: Record<string, number> = {};
  for (const [source, category] of Object.entries(SOURCE_TARIFF_CATEGORY)) {
    const set = seen.get(category);
    rates[source] = set && set.size === 1 ? [...set][0]! : (CHARGE_TAX_RATES[source] ?? 0);
  }
  return rates;
}

/**
 * Lookup of bill_items already created against a (referenceType, referenceId)
 * tuple for this patient. Used to mark auto-pulled charges so the UI can
 * grey them out (and so we don't double-bill).
 */
async function indexBilledReferences(tenantId: string, patientId: string) {
  const items = await prisma.billItem.findMany({
    where: {
      bill: { tenantId, patientId, status: { not: 'cancelled' } },
      referenceType: { not: null },
      referenceId: { not: null },
    },
    select: {
      id: true,
      billId: true,
      referenceType: true,
      referenceId: true,
    },
  });
  const map = new Map<string, { billItemId: string; billId: string }>();
  for (const it of items) {
    if (it.referenceType && it.referenceId) {
      map.set(`${it.referenceType}:${it.referenceId}`, {
        billItemId: it.id,
        billId: it.billId,
      });
    }
  }
  return map;
}

/**
 * OT (surgery) charges — completed/scheduled surgeries with a billing amount
 * set. Mirrors the other charge sources so a surgery can be pulled onto the
 * patient's bill (idempotent via referenceType 'ot_request').
 */
async function getOtCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const requests = await prisma.otRequest.findMany({
    where: {
      tenantId,
      patientId,
      status: { notIn: ['cancelled'] as any },
      billingAmount: { gt: 0 },
    },
    include: {
      surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return requests.map((r) => {
    const amount = toNumber(r.billingAmount ?? 0);
    const sUser = r.surgeon?.user ?? r.doctor?.user;
    const surgeon = sUser ? `Dr. ${fullName(sUser)}` : null;
    const billed = billedIndex.get(`ot_request:${r.id}`);
    return {
      source: 'ot' as const,
      referenceType: 'ot_request',
      referenceId: r.id,
      description: `Surgery — ${r.procedureName}${surgeon ? ` (${surgeon})` : ''}`,
      quantity: 1,
      unitPrice: amount,
      totalAmount: amount,
      taxRate: taxRates.ot ?? CHARGE_TAX_RATES.ot,
      category: 'surgery',
      occurredAt: formatDateTimeIST(r.scheduledDate ?? r.createdAt),
      occurredAtISO: new Date(r.scheduledDate ?? r.createdAt).toISOString(),
      status: r.status,
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
}

async function getConsultationCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const visits = await prisma.visit.findMany({
    where: { tenantId, patientId },
    include: {
      doctor: {
        select: {
          consultationFee: true,
          user: { select: { firstName: true, lastName: true } },
          specialization: true,
        },
      },
      appointment: { select: { id: true, appointmentDate: true } },
      // Does this visit back an admission? Used to skip the admission's own
      // anchor visit below.
      admission: { select: { id: true } },
    },
    orderBy: { visitDate: 'desc' },
    take: 50,
  });

  return visits
    .filter((v) => v.visitType === 'op' || v.visitType === 'ip')
    // An admission creates a Visit purely to anchor the stay — nobody has
    // consulted at that point. Charging a consultation for it put a phantom
    // "Consultation — Doctor" line on the ledger the instant an IP / Emergency
    // / Day Care patient was admitted, and would have double-charged once the
    // doctor actually recorded a round (recordDoctorVisit posts its own fee).
    //
    // The OP→IP flow REUSES the OP visit and flips it to `ip`, and that one is
    // a real consultation — it is told apart by having an appointment behind
    // it, which an admission-created visit never does.
    .filter((v) => !(v.admission && !v.appointmentId))
    .map((v) => {
      const fee = toNumber(v.doctor?.consultationFee ?? 0);
      const doctorName = v.doctor?.user
        ? `Dr. ${fullName(v.doctor.user)}`
        : 'Doctor';
      const billed = billedIndex.get(`visit:${v.id}`);
      return {
        source: 'consultation' as const,
        referenceType: 'visit',
        referenceId: v.id,
        description: `Consultation — ${doctorName} (${formatDateTimeIST(v.visitDate)})`,
        quantity: 1,
        unitPrice: fee,
        totalAmount: fee,
        taxRate: taxRates.consultation ?? CHARGE_TAX_RATES.consultation,
        category: 'consultation',
        occurredAt: formatDateTimeIST(v.visitDate),
        occurredAtISO: new Date(v.visitDate).toISOString(),
        status: v.status,
        alreadyBilled: !!billed,
        billItemId: billed?.billItemId,
        billId: billed?.billId,
      };
    })
    // A zero-rupee consultation is not a charge — it means the doctor has no
    // fee configured, or none is attached yet. Listing it as a pending charge
    // is noise on the ledger and prints a ₹0.00 line on the patient's bill.
    // (The old condition `unitPrice > 0 || !alreadyBilled` kept exactly those.)
    .filter((r) => r.totalAmount > 0);
}

async function getLabCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const orders = await prisma.labOrder.findMany({
    where: {
      tenantId,
      patientId,
      status: { notIn: ['cancelled'] as any },
    },
    include: {
      labOrderItems: {
        include: {
          test: { select: { id: true, testName: true, testCode: true, price: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const rows: ChargeRow[] = [];
  for (const order of orders) {
    for (const item of order.labOrderItems) {
      if (!item.test) continue;
      const price = toNumber(item.test.price);
      const billed = billedIndex.get(`lab_order_item:${item.id}`);
      rows.push({
        source: 'lab',
        referenceType: 'lab_order_item',
        referenceId: item.id,
        description: `Lab: ${item.test.testName}${item.test.testCode ? ` (${item.test.testCode})` : ''}`,
        quantity: 1,
        unitPrice: price,
        totalAmount: price,
        taxRate: taxRates.lab ?? CHARGE_TAX_RATES.lab,
        category: 'lab',
        occurredAt: formatDateTimeIST(order.createdAt),
        occurredAtISO: new Date(order.createdAt).toISOString(),
        status: item.status,
        alreadyBilled: !!billed,
        billItemId: billed?.billItemId,
        billId: billed?.billId,
        pullable: false,
        notPullableReason: billed
          ? 'Billed by the laboratory'
          : 'The laboratory bills this when it accepts the order',
      });
    }
  }
  return rows;
}

async function getPharmacyCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const records = await prisma.dispensingRecord.findMany({
    // A voided sale is not a charge.
    where: { tenantId, patientId, cancelledAt: null },
    include: {
      drugBatch: {
        select: {
          batchNumber: true,
          sellingPrice: true,
          purchasePrice: true,
          // The batch's own GST, derived from the drug's HSN code at inward.
          gstPercent: true,
          drug: { select: { drugName: true, price: true, taxPercent: true } },
        },
      },
    },
    orderBy: { dispensedAt: 'desc' },
    take: 200,
  });

  return records.map((r) => {
    const unit =
      toNumber((r.drugBatch as any)?.sellingPrice) ||
      toNumber((r.drugBatch as any)?.drug?.price) ||
      toNumber((r.drugBatch as any)?.purchasePrice);
    const total = unit * r.quantityDispensed;
    const drugName = (r.drugBatch as any)?.drug?.drugName ?? 'Medication';
    const batchTag = (r.drugBatch as any)?.batchNumber ? ` (Batch ${(r.drugBatch as any).batchNumber})` : '';
    const billed = billedIndex.get(`dispensing_record:${r.id}`);
    // The drug's real GST — set from its HSN code at inward — not a blanket
    // 12%. The batch's rate is the one the stock was actually received under;
    // the formulary's is the drug-level default.
    const batchGst = (r.drugBatch as any)?.gstPercent;
    const drugGst = (r.drugBatch as any)?.drug?.taxPercent;
    const taxRate =
      batchGst != null
        ? toNumber(batchGst)
        : drugGst != null
          ? toNumber(drugGst)
          : (taxRates.pharmacy ?? CHARGE_TAX_RATES.pharmacy);
    return {
      source: 'pharmacy' as const,
      referenceType: 'dispensing_record',
      referenceId: r.id,
      description: `${drugName}${batchTag}`,
      quantity: r.quantityDispensed,
      unitPrice: unit,
      totalAmount: total,
      taxRate,
      // Medicine prices are MRP. The pharmacy counter already treats them as
      // tax-inclusive and shows the embedded GST as a breakup; the hospital
      // bill used to add the rate ON TOP of the same MRP, so a ₹100 strip cost
      // ₹100 at the counter and ₹112 on an IP bill for the identical item.
      taxInclusive: true,
      category: 'pharmacy',
      occurredAt: formatDateTimeIST(r.dispensedAt),
      occurredAtISO: new Date(r.dispensedAt).toISOString(),
      status: 'dispensed',
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
}

async function getImagingCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const requests = await prisma.imagingRequest.findMany({
    where: { tenantId, patientId, status: { not: 'cancelled' as any } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // Pricing for imaging: lookup tariff by category=radiology and try to match
  // by imagingType. Fallback to a configurable baseline.
  const tariffs = await prisma.serviceTariff.findMany({
    where: { tenantId, category: 'radiology', isActive: true },
    select: { id: true, serviceName: true, serviceCode: true, basePrice: true, gstRatePercent: true },
  });

  const tariffByCode = new Map<string, (typeof tariffs)[number]>();
  for (const t of tariffs) {
    if (t.serviceCode) tariffByCode.set(t.serviceCode.toLowerCase(), t);
    tariffByCode.set(t.serviceName.toLowerCase(), t);
  }

  return requests.map((req) => {
    const typeLabel = `${req.imagingType}${req.bodyPart ? ` — ${req.bodyPart}` : ''}`;
    const tariff =
      tariffByCode.get(req.imagingType.toLowerCase()) ||
      tariffByCode.get(typeLabel.toLowerCase());
    const price = toNumber(tariff?.basePrice ?? 0);
    // The matched study's own rate is the most specific answer; where no tariff
    // matched, fall back to what the radiology category is configured at rather
    // than silently assuming zero.
    const taxRate = tariff
      ? toNumber(tariff.gstRatePercent)
      : (taxRates.imaging ?? CHARGE_TAX_RATES.imaging);
    const billed = billedIndex.get(`imaging_request:${req.id}`);
    return {
      source: 'imaging' as const,
      referenceType: 'imaging_request',
      referenceId: req.id,
      description: `Imaging: ${typeLabel}`,
      quantity: 1,
      unitPrice: price,
      totalAmount: price,
      taxRate,
      category: 'radiology',
      occurredAt: formatDateTimeIST(req.createdAt),
      occurredAtISO: new Date(req.createdAt).toISOString(),
      status: req.status,
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
      pullable: false,
      notPullableReason: billed
        ? 'Billed by radiology'
        : 'Radiology bills this when it accepts the request',
    };
  });
}

async function getRoomCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
  taxRates: Record<string, number>,
): Promise<ChargeRow[]> {
  const admissions = await prisma.admission.findMany({
    where: { tenantId, patientId },
    select: {
      id: true,
      visitId: true,
      admissionDate: true,
      dischargeDate: true,
      status: true,
      bedId: true,
      wardId: true,
    },
    orderBy: { admissionDate: 'desc' },
    take: 20,
  });
  if (admissions.length === 0) return [];

  // Bed-occupancy history: every approved bed/ward move for these stays. Each
  // transfer is a boundary between one bed's charges and the next, so a patient
  // who moves beds mid-stay is billed each bed for the days it was actually
  // occupied — NOT the current bed's rate applied retroactively to the whole stay.
  const transfers = await prisma.patientTransfer.findMany({
    where: {
      tenantId,
      visitId: { in: admissions.map((a) => a.visitId) },
      status: { in: ['approved', 'completed'] as any },
      transferType: { in: ['bed_to_bed', 'ward_to_ward'] as any },
    },
    select: {
      id: true,
      visitId: true,
      fromBedId: true,
      toBedId: true,
      fromWardId: true,
      toWardId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const transfersByVisit = new Map<string, typeof transfers>();
  for (const t of transfers) {
    const list = transfersByVisit.get(t.visitId) ?? [];
    list.push(t);
    transfersByVisit.set(t.visitId, list);
  }

  // Resolve bed/ward details for every bed/ward that appears anywhere in the
  // timeline (current + historical) — a past bed may differ from the current one.
  const bedIds = new Set<string>();
  const wardIds = new Set<string>();
  for (const a of admissions) {
    if (a.bedId) bedIds.add(a.bedId);
    if (a.wardId) wardIds.add(a.wardId);
  }
  for (const t of transfers) {
    for (const b of [t.fromBedId, t.toBedId]) if (b) bedIds.add(b);
    for (const w of [t.fromWardId, t.toWardId]) if (w) wardIds.add(w);
  }
  const [beds, wards, roomTariffs] = await Promise.all([
    bedIds.size
      ? prisma.bed.findMany({ where: { id: { in: [...bedIds] } }, select: { id: true, bedNumber: true, bedType: true } })
      : Promise.resolve([]),
    wardIds.size
      ? prisma.ward.findMany({ where: { id: { in: [...wardIds] } }, select: { id: true, name: true, wardType: true, dailyCharge: true } })
      : Promise.resolve([]),
    // Per-day room rate from ServiceTariff (category=room), matched by bedType.
    prisma.serviceTariff.findMany({ where: { tenantId, category: 'room', isActive: true } }),
  ]);
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const wardById = new Map(wards.map((w) => [w.id, w]));

  // The ward's admin-set per-day charge wins; otherwise the room ServiceTariff
  // matched by the bed's type (fallback: first active room tariff).
  //
  // Returns the tax alongside the rate: when a specific room tariff prices the
  // bed, that same tariff also says what GST it carries. A ward's own daily
  // charge has no tariff behind it, so it falls back to the room category rate.
  const rateFor = (
    bedId: string | null,
    wardId: string | null,
  ): { price: number; taxRate: number; bedType: string | null; wardType: string | null } => {
    const bedType = bedId ? bedById.get(bedId)?.bedType ?? null : null;
    const wardType = wardId ? wardById.get(wardId)?.wardType ?? null : null;
    const wardRate = toNumber((wardId ? wardById.get(wardId)?.dailyCharge : null) ?? 0);
    if (wardRate > 0) {
      return {
        price: wardRate,
        taxRate: roomTaxRate(wardRate, { bedType, wardType }),
        bedType,
        wardType,
      };
    }
    const tariff =
      roomTariffs.find((t) => (t.serviceCode ?? '').toLowerCase() === String(bedType ?? '').toLowerCase()) ||
      roomTariffs[0];
    const price = toNumber(tariff?.basePrice ?? 0);
    return {
      price,
      taxRate: roomTaxRate(price, {
        bedType,
        wardType,
        configuredRate: tariff ? toNumber(tariff.gstRatePercent) : null,
      }),
      bedType,
      wardType,
    };
  };

  type Seg = { bedId: string | null; wardId: string | null; startDay: number; startAt: Date; refId: string };
  const rows: ChargeRow[] = [];

  for (const adm of admissions) {
    const tlist = transfersByVisit.get(adm.visitId) ?? [];
    const end = adm.dischargeDate ? new Date(adm.dischargeDate) : new Date();
    const endDay = istDayNumber(end);
    const admDay = istDayNumber(adm.admissionDate);

    // Ordered occupancy segments. Segment 0 = the bed held at admission (the
    // first transfer's `from`, or the current bed when there were no moves).
    // Each subsequent transfer opens a new segment at its timestamp; its own
    // id keys the charge so it bills — and marks billed — independently.
    const segs: Seg[] = [];
    if (tlist.length === 0) {
      segs.push({ bedId: adm.bedId, wardId: adm.wardId, startDay: admDay, startAt: adm.admissionDate, refId: adm.id });
    } else {
      segs.push({ bedId: tlist[0].fromBedId, wardId: tlist[0].fromWardId, startDay: admDay, startAt: adm.admissionDate, refId: adm.id });
      for (const t of tlist) {
        segs.push({ bedId: t.toBedId, wardId: t.toWardId, startDay: istDayNumber(t.createdAt), startAt: t.createdAt, refId: `${adm.id}:${t.id}` });
      }
    }

    segs.forEach((seg, i) => {
      // Calendar-day allocation at IST midnight: a segment owns the days from its
      // start up to (but not including) the next segment's start — so the day of a
      // transfer belongs to the new bed. The last segment runs inclusively to
      // discharge/now. Days with no bed assigned aren't billable → skipped.
      const nextStart = i < segs.length - 1 ? segs[i + 1].startDay : null;
      const days = nextStart !== null ? nextStart - seg.startDay : endDay - seg.startDay + 1;
      if (days <= 0 || !seg.bedId) return;

      const { price: unit, taxRate, bedType, wardType } = rateFor(seg.bedId, seg.wardId);
      const wardName = (seg.wardId ? wardById.get(seg.wardId)?.name : null) ?? 'Ward';
      const bedNumber = (seg.bedId ? bedById.get(seg.bedId)?.bedNumber : null) ?? '-';
      const billed = billedIndex.get(`admission:${seg.refId}`);
      rows.push({
        source: 'room' as const,
        referenceType: 'admission',
        referenceId: seg.refId,
        description: `Room (${wardName} / Bed ${bedNumber}) — ${days} day${days === 1 ? '' : 's'}`,
        quantity: days,
        unitPrice: unit,
        totalAmount: unit * days,
        taxRate,
        // The room rule decides from the DAILY rate, the bed and the ward — not
        // from the line total, and not from a rate somebody worked out here.
        // Without these three the engine saw a daily rate of zero and made every
        // room exempt.
        dailyRate: unit,
        bedType,
        wardType,
        category: 'room',
        occurredAt: formatDateTimeIST(seg.startAt),
        occurredAtISO: new Date(seg.startAt).toISOString(),
        status: adm.status,
        alreadyBilled: !!billed,
        billItemId: billed?.billItemId,
        billId: billed?.billId,
      });
    });
  }

  return rows;
}

/**
 * Unified "what hasn't been billed yet" feed for a patient. Front-desk uses
 * this on the Billing tab to auto-pull line items across modules into a
 * single bill, and to flag charges that are already on a bill.
 */
export async function getPatientCharges(
  tenantId: string,
  query: { patientId: string; source?: ChargeSource; includeBilled?: boolean },
) {
  const patient = await prisma.patient.findFirst({
    where: { id: query.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const source = query.source ?? 'all';
  const billedIndex = await indexBilledReferences(tenantId, query.patientId);
  // Per-category GST from the tenant's ServiceTariff master, resolved once for
  // the whole feed rather than per charge.
  const taxRates = await buildServiceTaxRates(tenantId);

  let rows: ChargeRow[] = [];
  if (source === 'consultation' || source === 'all') {
    rows = rows.concat(await getConsultationCharges(tenantId, query.patientId, billedIndex, taxRates));
  }
  if (source === 'lab' || source === 'all') {
    rows = rows.concat(await getLabCharges(tenantId, query.patientId, billedIndex, taxRates));
  }
  if (source === 'pharmacy' || source === 'all') {
    rows = rows.concat(await getPharmacyCharges(tenantId, query.patientId, billedIndex, taxRates));
  }
  if (source === 'imaging' || source === 'all') {
    rows = rows.concat(await getImagingCharges(tenantId, query.patientId, billedIndex, taxRates));
  }
  if (source === 'room' || source === 'all') {
    rows = rows.concat(await getRoomCharges(tenantId, query.patientId, billedIndex, taxRates));
  }
  if (source === 'ot' || source === 'all') {
    rows = rows.concat(await getOtCharges(tenantId, query.patientId, billedIndex, taxRates));
  }

  if (!query.includeBilled) {
    rows = rows.filter((r) => !r.alreadyBilled);
  }

  // Totals by source for the auto-pull UI summary strip.
  const summary = {
    consultation: 0,
    lab: 0,
    pharmacy: 0,
    imaging: 0,
    room: 0,
    ot: 0,
    grandTotal: 0,
    count: rows.length,
  };
  for (const r of rows) {
    summary[r.source] += r.totalAmount;
    summary.grandTotal += r.totalAmount;
  }

  return { charges: rows, summary };
}

/**
 * Push an OT surgery's charge onto a hospital bill for the patient, optionally
 * collecting full payment. Creates a dedicated, finalized surgery invoice and
 * is idempotent — if the surgery was already billed (a bill_item with
 * referenceType 'ot_request' exists on a non-cancelled bill) that bill is
 * reused instead of creating a duplicate. Keeps OtRequest.billingStatus in sync.
 */
/** One unbilled order on the counter worklist. */
export interface PendingOrderRow {
  key: string;
  source: 'lab' | 'imaging' | 'ot';
  referenceType: string;
  referenceId: string;
  description: string;
  amount: number;
  taxRate: number;
  orderedAt: string;
  orderedAtISO: string;
  status: string;
  patient: { id: string; firstName: string; lastName: string | null; mrn: string } | null;
}

/**
 * Everything the hospital has done that nobody has billed yet, across all
 * patients — the counter's "what still needs a bill" worklist.
 *
 * The Order List panel used to fake this by pulling the last 30 lab orders and
 * the last 30 imaging requests straight from those modules with no billing
 * filter at all, under a heading that read "Pending Orders Awaiting Billing".
 * Already-billed work therefore sat in the list inviting the desk to bill it
 * again; the charges feed then correctly refused, so it read as a broken button.
 *
 * Same idea as `getPatientCharges` but tenant-wide rather than per patient, and
 * only the sources that represent a discrete order somebody raised: lab,
 * imaging and OT. Room and consultation accrue automatically and pharmacy is
 * dispensed at its own counter, so none of them belong on a "chase this" list.
 */
export async function getPendingOrders(
  tenantId: string,
  query: { source?: 'lab' | 'imaging' | 'ot' | 'all'; search?: string; limit?: number } = {},
) {
  const source = query.source ?? 'all';
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 300);
  const want = (s: string) => source === 'all' || source === s;

  const [labItems, imagingReqs, otReqs] = await Promise.all([
    want('lab')
      ? prisma.labOrderItem.findMany({
          where: {
            labOrder: { tenantId, status: { notIn: ['cancelled'] as any } },
            status: { notIn: ['cancelled'] as any },
          },
          include: {
            test: { select: { testName: true, testCode: true, price: true } },
            labOrder: {
              select: {
                createdAt: true,
                patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
              },
            },
          },
          orderBy: { id: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
    want('imaging')
      ? prisma.imagingRequest.findMany({
          where: { tenantId, status: { not: 'cancelled' as any } },
          include: { patient: { select: { id: true, firstName: true, lastName: true, mrn: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
    want('ot')
      ? prisma.otRequest.findMany({
          where: {
            tenantId,
            status: { notIn: ['cancelled'] as any },
            billingAmount: { gt: 0 },
          },
          include: { patient: { select: { id: true, firstName: true, lastName: true, mrn: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
  ]);

  // One lookup for every reference we are about to consider, so "already
  // billed" is decided by the same (referenceType, referenceId) tuple the
  // charges feed and the auto-pull dedupe use.
  const refIds = [
    ...labItems.map((i) => i.id),
    ...imagingReqs.map((r) => r.id),
    ...otReqs.map((r) => r.id),
  ];
  const billed = refIds.length
    ? await prisma.billItem.findMany({
        where: {
          bill: { tenantId, status: { not: 'cancelled' } },
          referenceId: { in: refIds },
          referenceType: { in: ['lab_order_item', 'imaging_request', 'ot_request'] },
        },
        select: { referenceType: true, referenceId: true },
      })
    : [];
  const billedKeys = new Set(billed.map((b) => `${b.referenceType}:${b.referenceId}`));

  const taxRates = await buildServiceTaxRates(tenantId);


  const rows: PendingOrderRow[] = [];

  for (const item of labItems) {
    if (billedKeys.has(`lab_order_item:${item.id}`)) continue;
    const p = item.labOrder?.patient;
    const at = item.labOrder?.createdAt ?? new Date();
    rows.push({
      key: `lab:${item.id}`,
      source: 'lab',
      referenceType: 'lab_order_item',
      referenceId: item.id,
      description: `Lab: ${item.test?.testName ?? 'Test'}${item.test?.testCode ? ` (${item.test.testCode})` : ''}`,
      amount: toNumber(item.test?.price),
      taxRate: taxRates.lab ?? CHARGE_TAX_RATES.lab,
      orderedAt: formatDateTimeIST(at),
      orderedAtISO: new Date(at).toISOString(),
      status: String(item.status),
      patient: p ? { id: p.id, firstName: p.firstName, lastName: p.lastName, mrn: p.mrn } : null,
    });
  }

  for (const req of imagingReqs) {
    if (billedKeys.has(`imaging_request:${req.id}`)) continue;
    const p = req.patient;
    rows.push({
      key: `imaging:${req.id}`,
      source: 'imaging',
      referenceType: 'imaging_request',
      referenceId: req.id,
      description: `Imaging: ${req.imagingType}${req.bodyPart ? ` — ${req.bodyPart}` : ''}`,
      amount: 0, // priced from the radiology tariff when it is pulled onto a bill
      taxRate: taxRates.imaging ?? CHARGE_TAX_RATES.imaging,
      orderedAt: formatDateTimeIST(req.createdAt),
      orderedAtISO: new Date(req.createdAt).toISOString(),
      status: String(req.status),
      patient: p ? { id: p.id, firstName: p.firstName, lastName: p.lastName, mrn: p.mrn } : null,
    });
  }

  for (const req of otReqs) {
    if (billedKeys.has(`ot_request:${req.id}`)) continue;
    const p = req.patient;
    rows.push({
      key: `ot:${req.id}`,
      source: 'ot',
      referenceType: 'ot_request',
      referenceId: req.id,
      description: `Surgery — ${req.procedureName}`,
      amount: toNumber(req.billingAmount),
      taxRate: taxRates.ot ?? CHARGE_TAX_RATES.ot,
      orderedAt: formatDateTimeIST(req.createdAt),
      orderedAtISO: new Date(req.createdAt).toISOString(),
      status: String(req.status),
      patient: p ? { id: p.id, firstName: p.firstName, lastName: p.lastName, mrn: p.mrn } : null,
    });
  }

  const search = query.search?.trim().toLowerCase();
  const filtered = search
    ? rows.filter((r) => {
        const name = fullName(r.patient).toLowerCase();
        return (
          name.includes(search) ||
          (r.patient?.mrn ?? '').toLowerCase().includes(search) ||
          r.description.toLowerCase().includes(search)
        );
      })
    : rows;

  filtered.sort((a, b) => b.orderedAtISO.localeCompare(a.orderedAtISO));

  return {
    orders: filtered,
    summary: {
      count: filtered.length,
      lab: filtered.filter((r) => r.source === 'lab').length,
      imaging: filtered.filter((r) => r.source === 'imaging').length,
      ot: filtered.filter((r) => r.source === 'ot').length,
      totalAmount: r2(filtered.reduce((s, r) => s + r.amount, 0)),
    },
  };
}

export async function billOtRequest(
  tenantId: string,
  otRequestId: string,
  userId: string,
  opts: { collectPayment?: boolean; paymentMethod?: string } = {},
) {
  const req = await prisma.otRequest.findFirst({
    where: { id: otRequestId, tenantId },
    include: {
      surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!req) throw AppError.notFound('OT request not found');
  const amount = toNumber(req.billingAmount ?? 0);
  if (amount <= 0) {
    throw AppError.badRequest('Set a billing amount on the surgery before billing it');
  }

  // Idempotency: reuse the bill if this surgery was already billed.
  const existingItem = await prisma.billItem.findFirst({
    where: {
      referenceType: 'ot_request',
      referenceId: otRequestId,
      bill: { tenantId, status: { not: 'cancelled' } },
    },
    select: { billId: true },
  });

  // If the patient is currently admitted, the surgery belongs on the admission's
  // running IP bill (one consolidated bill, settled at discharge) — NOT a
  // standalone OP invoice — so it appears on the IP ledger alongside every other
  // charge for the stay.
  const activeAdmission = await prisma.admission.findFirst({
    where: { tenantId, patientId: req.patientId, status: ACTIVE_ADMISSION_STATUS },
    orderBy: { admissionDate: 'desc' },
    select: { id: true },
  });

  const sUser = req.surgeon?.user ?? req.doctor?.user;
  const surgeon = sUser ? `Dr. ${fullName(sUser)}` : null;
  const otTaxRates = await buildServiceTaxRates(tenantId);
  const otCharge = {
    referenceType: 'ot_request',
    referenceId: otRequestId,
    description: `Surgery — ${req.procedureName}${surgeon ? ` (${surgeon})` : ''}`,
    quantity: 1,
    unitPrice: amount,
    taxRate: otTaxRates.ot ?? CHARGE_TAX_RATES.ot,
    category: 'surgery',
  };

  let billId: string;
  if (existingItem) {
    billId = existingItem.billId;
  } else if (activeAdmission) {
    // IP: add onto the running (draft) IP bill and leave it running — payment is
    // taken with the consolidated bill at discharge, so no finalize / no charge here.
    const ipBill = await getOrCreateRunningIpBill(tenantId, activeAdmission.id, userId);
    await pullChargesToBill(tenantId, ipBill.id, [otCharge]);
    billId = ipBill.id;
  } else {
    // OP: a dedicated, finalized surgery invoice (optionally collect payment below).
    const bill = await createBill(tenantId, userId, { patientId: req.patientId, visitId: req.visitId ?? undefined });
    await pullChargesToBill(tenantId, bill.id, [otCharge]);
    await finalizeBill(tenantId, userId, bill.id);
    billId = bill.id;
  }

  // Optionally collect full payment of the outstanding balance.
  let paid = false;
  const billBefore = await prisma.bill.findUnique({ where: { id: billId } });
  if (opts.collectPayment && billBefore && billBefore.status !== 'paid' && billBefore.status !== 'draft') {
    const due = toNumber(billBefore.balanceDue);
    if (due > 0) {
      await createPayment(tenantId, userId, {
        billId,
        amount: due,
        paymentMethod: (opts.paymentMethod ?? 'cash') as any,
      });
      paid = true;
    }
  }

  const finalBill = await prisma.bill.findUnique({ where: { id: billId } });
  const billingStatus =
    finalBill?.status === 'paid'
      ? 'paid'
      : finalBill?.status === 'partially_paid'
        ? 'partially_paid'
        : 'pending';
  await prisma.otRequest.update({ where: { id: otRequestId }, data: { billingStatus } });

  logger.info({ tenantId, otRequestId, billId, paid }, 'OT surgery pushed to bill');
  return {
    billId,
    billNumber: finalBill?.billNumber ?? null,
    billStatus: finalBill?.status ?? null,
    totalAmount: toNumber(finalBill?.totalAmount ?? amount),
    amountPaid: toNumber(finalBill?.amountPaid ?? 0),
    balanceDue: toNumber(finalBill?.balanceDue ?? 0),
    paid,
  };
}

// ============================================================
// Diagnostic order billing — lab + radiology, one rule for both
// ============================================================
//
// A lab order and an imaging request are the same commercial event: the doctor
// asks for something, the department admits it, and the money is settled one of
// two ways depending on where the patient is.
//
//   OP  — the department is its own counter. A dedicated, finalized bill holding
//         only this order's lines, collected and receipted at the lab/radiology
//         desk, and printed from there.
//   IP / Emergency / Day Care — there is no counter. The charge is posted to the
//         admission's running IP ledger and settles once, on the consolidated
//         bill at discharge.
//
// This used to fire the moment the DOCTOR placed the order, which put a charge
// on the patient before anybody had agreed to do the work — an order the lab
// then declined still left a line on the bill. It now runs when the department
// ACCEPTS, which is also the point the patient is standing at the counter.

export interface DiagnosticChargeInput {
  referenceType: 'lab_order_item' | 'imaging_request';
  referenceId: string;
  description: string;
  quantity?: number;
  unitPrice: number;
  serviceTariffId?: string | null;
  /**
   * The test's or study's own SAC. A lab order can hold six different tests,
   * so the code travels per LINE — one rate stamped across a whole order is
   * only ever right by luck.
   */
  sacCode?: string | null;
  gstTreatment?: string | null;
}

export interface DiagnosticBillSummary {
  /** Which settlement route applied. */
  mode: 'ip' | 'op';
  admissionId: string | null;
  admissionType: AdmissionType | null;
  billId: string;
  billNumber: string;
  billStatus: string;
  /** What THIS order contributes to the bill (the rest may be other charges). */
  chargeAmount: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  /** True when every line was already on a bill and nothing new was posted. */
  alreadyBilled: boolean;
}

/**
 * Where a diagnostic order settles. An active admission — of ANY type: ip,
 * emergency or daycare, they all run the one IP flow — means the ledger.
 * Matched on the order's own visit first, then on any active admission for the
 * patient, because a ward lab order is often raised against the OP visit that
 * preceded the admission.
 */
export async function resolveDiagnosticPayer(
  tenantId: string,
  patientId: string,
  visitId?: string | null,
): Promise<{ mode: 'ip' | 'op'; admissionId: string | null; admissionType: AdmissionType | null }> {
  const byVisit = visitId
    ? await prisma.admission.findFirst({
        where: { tenantId, visitId, status: ACTIVE_ADMISSION_STATUS },
        orderBy: { admissionDate: 'desc' },
        select: { id: true },
      })
    : null;
  const admission =
    byVisit ??
    (await prisma.admission.findFirst({
      where: { tenantId, patientId, status: ACTIVE_ADMISSION_STATUS },
      orderBy: { admissionDate: 'desc' },
      select: { id: true },
    }));

  if (!admission) return { mode: 'op', admissionId: null, admissionType: null };

  // admission_type is a raw VarChar column (migration-free), so it is read out
  // of band rather than through the generated client.
  let admissionType: AdmissionType = 'ip';
  try {
    const rows = await prisma.$queryRaw<Array<{ admission_type: string | null }>>`
      SELECT admission_type FROM admissions WHERE id = ${admission.id}::uuid LIMIT 1
    `;
    admissionType = normalizeAdmissionType(rows[0]?.admission_type);
  } catch (err) {
    logger.warn({ err, admissionId: admission.id }, 'Could not read admission_type — defaulting to ip');
  }

  return { mode: 'ip', admissionId: admission.id, admissionType };
}

/**
 * Resolve the payer mode for a whole page of patients at once.
 *
 * The lab / radiology worklist has to say, on the row, whether a patient is
 * admitted — that is what tells the admin whether accepting will ask for money
 * or post to the stay ledger, and they need it before they open anything. Doing
 * it per row would be an N+1 on every list paint, so both admission lookups run
 * once for the page.
 */
export async function resolveDiagnosticPayers(
  tenantId: string,
  patientIds: string[],
): Promise<Map<string, { mode: 'ip' | 'op'; admissionId: string; admissionType: AdmissionType }>> {
  const out = new Map<
    string,
    { mode: 'ip' | 'op'; admissionId: string; admissionType: AdmissionType }
  >();
  const ids = [...new Set(patientIds.filter(Boolean))];
  if (!ids.length) return out;

  const admissions = await prisma.admission.findMany({
    where: { tenantId, patientId: { in: ids }, status: ACTIVE_ADMISSION_STATUS },
    orderBy: { admissionDate: 'desc' },
    select: { id: true, patientId: true },
  });
  if (!admissions.length) return out;

  // admission_type is a raw VarChar column (migration-free).
  let typeById = new Map<string, AdmissionType>();
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; admission_type: string | null }>>`
      SELECT id, admission_type FROM admissions
       WHERE id = ANY(${admissions.map((a) => a.id)}::uuid[])
    `;
    typeById = new Map(rows.map((r) => [r.id, normalizeAdmissionType(r.admission_type)]));
  } catch (err) {
    logger.warn({ err, tenantId }, 'Could not read admission_type for the page — defaulting to ip');
  }

  for (const a of admissions) {
    // findMany returns newest first, so the first hit per patient wins.
    if (out.has(a.patientId)) continue;
    out.set(a.patientId, {
      mode: 'ip',
      admissionId: a.id,
      admissionType: typeById.get(a.id) ?? 'ip',
    });
  }
  return out;
}

/**
 * Post a diagnostic order's charges and hand back the bill the department will
 * collect against (OP) or that the stay will settle (IP).
 *
 * Idempotent across the WHOLE tenant, not just per bill: a reference already
 * sitting on any non-cancelled bill is skipped. `pullChargesToBill` only dedupes
 * within one bill, so without this the same test could be charged twice on two
 * different bills — once by the front desk pulling pending orders, once here.
 */
export async function billDiagnosticOrder(
  tenantId: string,
  userId: string,
  opts: {
    source: 'lab' | 'imaging';
    patientId: string;
    visitId?: string | null;
    charges: DiagnosticChargeInput[];
  },
): Promise<DiagnosticBillSummary | null> {
  const charges = opts.charges.filter((c) => c.referenceId);
  if (!charges.length) return null;

  const taxRates = await buildServiceTaxRates(tenantId);
  const category = opts.source === 'lab' ? 'lab' : 'radiology';
  // The department-wide rate, kept only as the FALLBACK for a test that has no
  // code of its own. It used to be stamped identically onto every line of an
  // order, so a six-test panel could not carry six answers.
  const fallbackRate =
    opts.source === 'lab'
      ? (taxRates.lab ?? CHARGE_TAX_RATES.lab)
      : (taxRates.imaging ?? CHARGE_TAX_RATES.imaging);
  /** Medical laboratory and diagnostic-imaging services — exempt. */
  const DIAGNOSTIC_SAC = '999316';

  // What is already on a bill somewhere in this tenant.
  const existing = await prisma.billItem.findMany({
    where: {
      referenceType: charges[0]!.referenceType,
      referenceId: { in: charges.map((c) => c.referenceId) },
      bill: { tenantId, status: { not: 'cancelled' } },
    },
    select: { referenceId: true, billId: true, totalAmount: true },
  });
  const billedRefs = new Set(existing.map((e) => e.referenceId!));
  const fresh = charges.filter((c) => !billedRefs.has(c.referenceId));

  const payer = await resolveDiagnosticPayer(tenantId, opts.patientId, opts.visitId);

  let billId: string | null = existing[0]?.billId ?? null;

  if (fresh.length) {
    const lines = fresh.map((c) => ({
      referenceType: c.referenceType,
      referenceId: c.referenceId,
      description: c.description,
      quantity: c.quantity ?? 1,
      unitPrice: c.unitPrice,
      // Per line: the test's own code first, the diagnostics code second, and
      // the department fallback only where neither exists.
      sacCode: c.sacCode ?? DIAGNOSTIC_SAC,
      taxRate: fallbackRate,
      category,
      patientAdmitted: payer.mode === 'ip',
      issuedForTreatment: payer.mode === 'ip',
    }));

    if (payer.mode === 'ip') {
      // The stay's running draft bill — no finalize, no counter payment. It is
      // settled once at discharge with everything else.
      const ipBill = await getOrCreateRunningIpBill(tenantId, payer.admissionId!, userId);
      await pullChargesToBill(tenantId, ipBill.id, lines, { fromDiagnostics: true });
      billId = ipBill.id;
    } else {
      // OP: keep adding to the order's own bill while it is still a draft;
      // otherwise raise the department's dedicated invoice and finalize it so
      // the counter can collect and print against it.
      const reusable = billId
        ? await prisma.bill.findFirst({ where: { id: billId, tenantId, status: 'draft' }, select: { id: true } })
        : null;
      if (reusable) {
        await pullChargesToBill(tenantId, reusable.id, lines, { fromDiagnostics: true });
        billId = reusable.id;
      } else {
        const bill = await createBill(tenantId, userId, {
          patientId: opts.patientId,
          visitId: opts.visitId ?? undefined,
        } as CreateBillInput);
        await pullChargesToBill(tenantId, bill.id, lines, { fromDiagnostics: true });
        // A zero-value order (unpriced catalog entry) cannot be finalized —
        // finalizeBill rejects an empty bill and there is nothing to collect.
        const posted = await prisma.billItem.count({ where: { billId: bill.id } });
        if (posted > 0) await finalizeBill(tenantId, userId, bill.id);
        billId = bill.id;
      }
    }
  }

  if (!billId) return null;

  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) return null;

  const orderLines = await prisma.billItem.findMany({
    where: {
      billId,
      referenceType: charges[0]!.referenceType,
      referenceId: { in: charges.map((c) => c.referenceId) },
    },
    select: { totalAmount: true },
  });

  return {
    mode: payer.mode,
    admissionId: payer.admissionId,
    admissionType: payer.admissionType,
    billId: bill.id,
    billNumber: bill.billNumber,
    billStatus: bill.status,
    chargeAmount: r2(orderLines.reduce((s, l) => s + toNumber(l.totalAmount), 0)),
    totalAmount: toNumber(bill.totalAmount),
    amountPaid: toNumber(bill.amountPaid),
    balanceDue: toNumber(bill.balanceDue),
    alreadyBilled: fresh.length === 0,
  };
}

/**
 * Bulk-add unbilled charges to a bill (creates one BillItem per row with
 * referenceType/referenceId set so future pulls won't duplicate). Used by
 * the "Auto-Pull Selected" button on the Billing tab.
 */
export async function pullChargesToBill(
  tenantId: string,
  billId: string,
  charges: Array<{
    referenceType: string;
    referenceId: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate?: number;
    taxInclusive?: boolean;
    category?: string;
    // ── What the tax rules need to know about this supply ──
    // Passed through rather than guessed at. A charge that supplies none of it
    // still resolves — through its category default and, failing that, to
    // exempt, which is the correct answer for healthcare.
    hsnCode?: string | null;
    sacCode?: string | null;
    /** The patient has an active admission — IP, emergency or day care. */
    patientAdmitted?: boolean;
    /** Used ON the patient during the stay, rather than sold to them. */
    issuedForTreatment?: boolean;
    /** Discharge medicine, which the patient carries out. */
    isTakeHome?: boolean;
    isCosmetic?: boolean;
    /** Room lines: what decides whether the rent crosses the threshold. */
    dailyRate?: number;
    bedType?: string | null;
    wardType?: string | null;
  }>,
  opts: { fromDiagnostics?: boolean } = {},
) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only auto-pull into draft bills');
  }

  // Lab and radiology charges belong to those departments alone.
  //
  // An OP patient pays at the lab / radiology counter, which raises its own
  // bill and hands over its own receipt — the front desk never collects for a
  // test. An admitted patient's charge is posted to the stay ledger by the
  // department when it ACCEPTS the order, and the front desk collects that
  // ledger at discharge; it still does not pull the individual line.
  //
  // So the only thing allowed to bill one of these references is the diagnostic
  // biller. Without this, `consolidateAdmissionBill` re-billed at discharge
  // whatever the department had already charged, and — worse — billed orders
  // the department had never accepted, which is precisely the decision the
  // accept step exists to make.
  const isDiagnosticRef = (t: string) => t === 'lab_order_item' || t === 'imaging_request';

  // A charge already on ANY live bill in this tenant is not pullable, whichever
  // bill it landed on. The per-bill check below cannot see that, so the same
  // real-world charge could be billed twice on two different bills:
  //
  //   - consolidateAdmissionBill feeds it EVERY charge for the patient with an
  //     `alreadyBilled` flag it does not act on, so a test the lab already
  //     billed at its own counter was re-billed onto the stay at discharge;
  //   - the front desk's pull route takes the charge list from the request body,
  //     so a stale page (or any direct call) bypassed the disabled checkbox that
  //     is the only thing stopping it in the UI.
  //
  // The patient pays once for one test. Whoever billed it first owns it, and
  // moving it belongs to the bill-item routes, not to a bulk pull.
  const refs = charges.filter((c) => c.referenceType && c.referenceId);
  const billedElsewhere = refs.length
    ? await prisma.billItem.findMany({
        where: {
          bill: { tenantId, status: { not: 'cancelled' } },
          OR: refs.map((c) => ({ referenceType: c.referenceType, referenceId: c.referenceId })),
        },
        select: { referenceType: true, referenceId: true, billId: true },
      })
    : [];
  // Same-bill hits are the ordinary idempotent re-pull, not a conflict.
  const blocked = new Set(
    billedElsewhere
      .filter((b) => b.billId !== billId)
      .map((b) => `${b.referenceType}:${b.referenceId}`),
  );

  const created: any[] = [];
  const skipped: string[] = [];
  // One resolver for the whole pull: the masters load once rather than once per
  // line, and every line on this bill is resolved under the bill's own date.
  const resolver = await taxResolverFor(tenantId, bill.billDate ?? new Date());
  await prisma.$transaction(async (tx) => {
    for (const c of charges) {
      if (!opts.fromDiagnostics && isDiagnosticRef(c.referenceType)) {
        skipped.push(c.description);
        continue;
      }
      if (blocked.has(`${c.referenceType}:${c.referenceId}`)) {
        skipped.push(c.description);
        continue;
      }
      // Idempotency: skip if a bill item with the same reference already
      // exists on this bill.
      const exists = await tx.billItem.findFirst({
        where: { billId, referenceType: c.referenceType, referenceId: c.referenceId },
      });
      if (exists) continue;

      // The rules decide, from what the supply IS and the context it is in.
      // A rate the caller already worked out is offered as the item's own
      // classification, which the engine uses unless a context rule outranks
      // it — an inpatient's medicine being the case that does.
      const priced = resolver.price(
        {
          kind: supplyKindForCategory(c.category),
          hsnCode: c.hsnCode ?? null,
          sacCode: c.sacCode ?? null,
          itemRatePercent: c.taxRate ?? null,
          itemTreatment: c.taxRate == null ? null : c.taxRate > 0 ? 'taxable' : null,
          taxInclusive: c.taxInclusive ?? false,
          patientAdmitted: c.patientAdmitted,
          issuedForTreatment: c.issuedForTreatment,
          isTakeHome: c.isTakeHome,
          isCosmetic: c.isCosmetic,
          dailyRate: c.dailyRate,
          bedType: c.bedType,
          wardType: c.wardType,
        },
        { unitPrice: c.unitPrice, quantity: c.quantity },
      );
      const item = await tx.billItem.create({
        data: {
          billId,
          description: c.description,
          category: (c.category as any) ?? 'other',
          quantity: c.quantity,
          unitPrice: c.unitPrice,
          discountAmount: 0,
          discountPercent: 0,
          ...billItemTaxFields(priced),
          referenceType: c.referenceType,
          referenceId: c.referenceId,
          isAutoPulled: true,
        },
      });
      created.push(item);
    }
  });

  await recalculateBillTotals(billId);
  // Say what was dropped. A silent skip reads as "everything was pulled" to the
  // counter, and then the total is short and nobody knows why.
  if (skipped.length) {
    logger.warn(
      { tenantId, billId, skipped },
      'Skipped charges already billed on another bill',
    );
  }
  logger.info({ tenantId, billId, count: created.length, skipped: skipped.length }, 'Charges auto-pulled to bill');
  return { added: created.length, skipped, billId };
}

/**
 * Consolidate an IP admission onto its SINGLE running bill: pull every charge not
 * yet on a bill (room/bed, consultation, lab, imaging, OT, pharmacy) onto the one
 * running "IPW-" bill (which already holds the manual / nurse / doctor / pharmacy
 * charges), so the admission has ONE bill with all costs — no separate "FIN-"
 * bill. Idempotent (pullChargesToBill dedupes by referenceType:referenceId).
 * Optionally finalizes the bill (draft → pending) once it has items.
 */
/**
 * The admission's SINGLE bill for billing operations: a live draft if one exists
 * (keep accumulating), else the latest already-finalized bill (don't mint a new
 * one — that would break "IP = one bill"), else create the running draft.
 */
async function getAdmissionBillForBilling(tenantId: string, admissionId: string, userId: string) {
  const draft = await prisma.bill.findFirst({ where: { tenantId, admissionId, status: 'draft', ...NOT_ADVANCE_BUCKET }, orderBy: { createdAt: 'desc' } });
  if (draft) return draft;
  const finalized = await prisma.bill.findFirst({
    where: { tenantId, admissionId, status: { notIn: ['cancelled', 'refunded'] }, ...NOT_ADVANCE_BUCKET },
    orderBy: { createdAt: 'desc' },
  });
  if (finalized) return finalized;
  return getOrCreateRunningIpBill(tenantId, admissionId, userId);
}

export async function consolidateAdmissionBill(
  tenantId: string,
  userId: string,
  admissionId: string,
  opts: { finalize?: boolean } = {},
) {
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  let bill = await getAdmissionBillForBilling(tenantId, admissionId, userId);

  // The running bill is now reused across finalizations rather than replaced,
  // so "Generate / refresh bill" has to be able to pull the next batch of
  // charges onto a bill it already finalized — otherwise the bed days accrued
  // since the last refresh would have nowhere to go. Reopen it, let the pull
  // below run, and finalizeBill closes it again. Payments survive: totals are
  // recomputed from the Payment rows, and a document that already carries an
  // invoice number is never renumbered.
  //
  // A bill under a live insurance claim is left alone — the claim was raised
  // against these lines, so it is not ours to reopen behind the insurer.
  //
  // Only reopen when this call will also close it again (`finalize`). A draft
  // bill is NOT payable — createPayment answers "This bill is still open for
  // charges" — so leaving one reopened would strand the counter.
  let reopenedFrom: string | null = null;
  if (opts.finalize && (bill.status === 'pending' || bill.status === 'partially_paid')) {
    const claims = await prisma.insuranceClaim.count({ where: { billId: bill.id } });
    if (claims === 0) {
      reopenedFrom = bill.status;
      bill = await prisma.bill.update({ where: { id: bill.id }, data: { status: 'draft' } });
    }
  }

  try {
  // Only a draft can still accept charges / be finalized. A bill already
  // finalized (e.g. transferred to TPA earlier) is left as-is.
  if (bill.status === 'draft') {
    const { charges } = await getPatientCharges(tenantId, { patientId: admission.patientId });
    if (charges.length > 0) {
      await pullChargesToBill(
        tenantId,
        bill.id,
        // Spread the whole charge rather than picking fields off it. Picking is
        // how `taxInclusive` came to be silently dropped here: getPharmacyCharges
        // sets it, this map did not copy it, and the validator strips anything
        // not in its schema — so a medicine at MRP arrived at the writer looking
        // tax-exclusive and had its GST added a second time on top of the price.
        // Anything the rules need travels with the charge from now on.
        charges.map((c) => ({
          ...c,
          // This IS the admission's own bill, so everything on it was supplied
          // to a patient who is admitted, in the course of their treatment.
          patientAdmitted: true,
          issuedForTreatment: true,
        })),
      );
    }
    await recalculateBillTotals(bill.id);
    const draftItems = await prisma.billItem.count({ where: { billId: bill.id } });
    if (opts.finalize && draftItems > 0) {
      await finalizeBill(tenantId, userId, bill.id);
    }
  }
  } catch (err) {
    // finalizeBill refuses a bill with an unclassified line or an undecided
    // concession. Put a reopened bill back the way we found it rather than
    // leaving it a draft nobody can pay.
    if (reopenedFrom) {
      await prisma.bill.update({ where: { id: bill.id }, data: { status: reopenedFrom as never } });
    }
    throw err;
  }

  // A reopen that pulled nothing on has nothing to finalize, so close it back
  // by hand — otherwise the bill stays a draft and the counter cannot take
  // money against it.
  const stillDraft = await prisma.bill.findFirst({ where: { id: bill.id, tenantId }, select: { status: true } });
  if (reopenedFrom && stillDraft?.status === 'draft') {
    await prisma.bill.update({ where: { id: bill.id }, data: { status: reopenedFrom as never } });
    await recalculateBillTotals(bill.id);
  }

  // Money the patient has ALREADY handed over comes off the bill before anyone
  // is asked for the rest. A deposit taken at admission used to sit untouched
  // until somebody remembered to press "Apply to bill", so the counter was
  // shown — and could collect — the full amount while the hospital was already
  // holding part of it.
  //
  // This runs only when the bill is being prepared for payment (`finalize`),
  // which is both "Generate / refresh bill" and the automatic step behind
  // "Collect payment". It never applies more than the balance, so it cannot
  // overpay, and it is idempotent. Best-effort: a stay must still be billable
  // if the deposit cannot be set against it, and the manual button remains.
  let depositApplied = 0;
  if (opts.finalize) {
    try {
      const res = await applyHeldMoneyToBill(tenantId, userId, admissionId, admission.patientId, bill.id);
      depositApplied = res.applied;
      if (res.applied > 0) {
        logger.info(
          { tenantId, admissionId, billId: bill.id, fromDeposit: res.fromDeposit, fromAdvance: res.fromAdvance },
          'Deposit/advance applied automatically while preparing the bill',
        );
      }
    } catch (err) {
      logger.warn({ tenantId, admissionId, billId: bill.id, err }, 'Could not auto-apply the deposit to the IP bill');
    }
  }

  const fresh = await prisma.bill.findFirst({ where: { id: bill.id, tenantId } });
  const itemCount = await prisma.billItem.count({ where: { billId: bill.id } });
  return { bill: fresh!, itemCount, depositApplied, finalized: fresh!.status !== 'draft' };
}

/**
 * Billing-counter action: transfer an IP admission's consolidated bill to the
 * TPA / insurer. Consolidates + finalizes the single IP bill, finds the patient's
 * active policy, raises an insurance claim against the bill (via the insurance
 * module) and reflects the insurer / patient split on the bill. From here the
 * insurance / TPA team processes the claim (approve → settle, paid/remaining) and
 * the billing admin can see the claim status against the bill.
 *
 * Gated at the route by billing permission — so a billing admin / cashier can
 * trigger it even though they only have insurance:read (the claim is created via
 * the service layer, not the permission-gated insurance HTTP route).
 */
export interface TransferToTpaOptions {
  policyId?: string;
  // Create a policy on the fly at transfer time (billing desk has no insurance:create).
  newPolicy?: {
    insurerName: string;
    tpaName?: string;
    policyNumber?: string;
    coverageAmount?: number;
    coPayPercent?: number;
    deductibleAmount?: number;
  };
}

/** Resolve which policy to claim against: explicit id, inline new policy, or the patient's active one. */
async function resolveTransferPolicy(tenantId: string, patientId: string, opts: TransferToTpaOptions) {
  const insurance = await import('../insurance/insurance.service');
  if (opts.policyId) {
    return prisma.insurancePolicy.findFirst({
      where: { id: opts.policyId, tenantId },
      include: { insurer: { select: { id: true, name: true } }, tpa: { select: { id: true, name: true } } },
    });
  }
  if (opts.newPolicy?.insurerName?.trim()) {
    const np = opts.newPolicy;
    const insurer =
      (await prisma.insurer.findFirst({ where: { tenantId, name: np.insurerName.trim() } })) ??
      (await prisma.insurer.create({ data: { tenantId, name: np.insurerName.trim() } }));
    let tpaId: string | null = null;
    if (np.tpaName?.trim()) {
      const tpa =
        (await prisma.tpaProvider.findFirst({ where: { tenantId, name: np.tpaName.trim() } })) ??
        (await prisma.tpaProvider.create({ data: { tenantId, name: np.tpaName.trim() } }));
      tpaId = tpa.id;
    }
    const now = new Date();
    return prisma.insurancePolicy.create({
      data: {
        tenantId, patientId, insurerId: insurer.id, tpaId,
        policyNumber: np.policyNumber?.trim() || `POL-${Date.now()}`,
        coverageAmount: np.coverageAmount ?? null,
        coPayPercent: np.coPayPercent ?? 0,
        deductibleAmount: np.deductibleAmount ?? 0,
        validFrom: now,
        validTo: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        status: 'active',
      },
      include: { insurer: { select: { id: true, name: true } }, tpa: { select: { id: true, name: true } } },
    });
  }
  // Default (one-click handoff): use the patient's active policy if the insurance
  // team already registered one; otherwise raise the claim against a PENDING
  // placeholder policy that the TPA / insurance team fills in (insurer, TPA,
  // coverage) and processes. The billing admin doesn't enter any details.
  const active = await insurance.findActivePolicyForPatient(tenantId, patientId);
  if (active) return active;

  const policyInclude = { insurer: { select: { id: true, name: true } }, tpa: { select: { id: true, name: true } } };
  const existingPending = await prisma.insurancePolicy.findFirst({
    where: { tenantId, patientId, status: 'active', policyNumber: { startsWith: 'PENDING-' } },
    include: policyInclude,
  });
  if (existingPending) return existingPending;

  const pendingName = 'Pending TPA Assignment';
  const insurer =
    (await prisma.insurer.findFirst({ where: { tenantId, name: pendingName } })) ??
    (await prisma.insurer.create({ data: { tenantId, name: pendingName } }));
  const now = new Date();
  return prisma.insurancePolicy.create({
    data: {
      tenantId, patientId, insurerId: insurer.id, tpaId: null,
      policyNumber: `PENDING-${Date.now()}`,
      coPayPercent: 0, deductibleAmount: 0,
      validFrom: now, validTo: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      status: 'active',
    },
    include: policyInclude,
  });
}

export async function transferAdmissionToTpa(tenantId: string, userId: string, admissionId: string, opts: TransferToTpaOptions = {}) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, billingCategory: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // 1. Consolidate all charges onto the SINGLE IP bill and finalize it.
  const { bill, itemCount } = await consolidateAdmissionBill(tenantId, userId, admissionId, { finalize: true });
  if (itemCount === 0) throw AppError.badRequest('No charges to bill yet — nothing to transfer to TPA.');
  const claimAmount = Number(bill.totalAmount);
  if (!(claimAmount > 0)) throw AppError.badRequest('Bill total is zero — nothing to claim.');

  // 2. Block a duplicate transfer (a live claim already exists for this bill).
  const existing = await prisma.insuranceClaim.findFirst({
    where: { billId: bill.id, status: { notIn: ['cancelled', 'rejected'] } },
    select: { id: true, claimNumber: true, status: true },
  });
  if (existing) {
    throw AppError.badRequest(`This bill is already with the TPA (claim ${existing.claimNumber ?? existing.id}, ${existing.status}).`);
  }

  // 3. Resolve the policy (explicit / inline-new / patient's active) + raise + split.
  const insurance = await import('../insurance/insurance.service');
  const policy = await resolveTransferPolicy(tenantId, admission.patientId, opts);
  if (!policy) {
    throw AppError.badRequest('No insurance policy for this patient. Enter the insurer / TPA + policy details when transferring, or add a policy in the Insurance module.');
  }

  // Line-level split: only the INSURANCE-ELIGIBLE lines go to the TPA. A line is
  // claimed unless it's explicitly marked non-reimbursable (patient-only). The
  // patient always owes the non-reimbursable lines + whatever the insurer doesn't
  // cover (copay / deductible / over-limit) on the claimed portion.
  const items = await prisma.billItem.findMany({ where: { billId: bill.id }, select: { totalAmount: true, isReimbursable: true } });
  const reimbursable = r2(items.filter((it) => it.isReimbursable !== false).reduce((s, it) => s + Number(it.totalAmount), 0));
  const claimAmountToTpa = reimbursable > 0 ? reimbursable : claimAmount;

  const claim = await insurance.createClaim(tenantId, userId, {
    policyId: policy.id,
    patientId: admission.patientId,
    billId: bill.id,
    claimAmount: claimAmountToTpa,
  });
  // Reflect the insurer-covered vs patient-payable split on the WHOLE bill:
  // insurer covers the covered portion of the claimed lines; the patient owes
  // everything else (non-reimbursable lines + uncovered part of the claim).
  const covered = Number(claim.coveredAmount ?? 0);
  await insurance.applyBillSplit(tenantId, bill.id, covered, r2(claimAmount - covered));

  const updatedBill = await prisma.bill.findFirst({
    where: { id: bill.id, tenantId },
    select: {
      id: true, billNumber: true, status: true, totalAmount: true,
      insuranceCoveredAmount: true, patientPayableAmount: true, amountPaid: true, balanceDue: true,
    },
  });
  logger.info({ tenantId, admissionId, billId: bill.id, claimId: claim.id, policyId: policy.id }, 'IP bill transferred to TPA');
  return {
    claim,
    bill: updatedBill,
    policy: { id: policy.id, policyNumber: policy.policyNumber, insurer: policy.insurer, tpa: policy.tpa },
  };
}

/**
 * Billing-counter action: record a TPA payment against an IP admission's claim
 * (how much the TPA paid → paid / remaining tracked on the claim). If the claim
 * hasn't been marked approved yet, approve it at the computed covered amount so
 * the billing desk can settle in one place. Gated by billing permission — runs
 * the insurance lifecycle via the service layer.
 */
export async function recordTpaSettlement(
  tenantId: string,
  userId: string,
  admissionId: string,
  data: { paidAmount: number; notes?: string },
) {
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { id: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  const claim = await prisma.insuranceClaim.findFirst({
    where: { tenantId, bill: { admissionId }, status: { notIn: ['cancelled', 'rejected', 'settled'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, coveredAmount: true, claimAmount: true },
  });
  if (!claim) throw AppError.badRequest('No open TPA claim for this admission. Transfer the bill to the TPA first.');

  const insurance = await import('../insurance/insurance.service');
  // If the TPA response hasn't been recorded as approved yet, approve at the
  // computed covered amount so a payment can be recorded here in one step.
  if (['submitted', 'under_review', 'resubmitted'].includes(String(claim.status))) {
    const approvedAmount = Number(claim.coveredAmount ?? claim.claimAmount);
    await insurance.approveClaim(tenantId, claim.id, userId, { approvedAmount } as any);
  }
  const settled = await insurance.settleClaim(tenantId, claim.id, userId, { paidAmount: data.paidAmount, notes: data.notes } as any);
  logger.info({ tenantId, admissionId, claimId: claim.id, paidAmount: data.paidAmount }, 'TPA settlement recorded from billing');
  return settled;
}

/**
 * G5 (2.1) — Discharge final-bill assembly. On discharge, consolidate every charge
 * onto the admission's SINGLE running IP bill and finalize it, then optionally
 * apply the patient's advance balance. Pharmacy/indent charges already billed on
 * the running IP bill are NOT duplicated (getPatientCharges only surfaces unbilled
 * references). Returns an admission-wide financial summary (deposit is surfaced,
 * not auto-moved — its settlement stays the biller's explicit step).
 */
export async function assembleDischargeBill(
  tenantId: string,
  userId: string,
  admissionId: string,
  opts: { applyAdvance?: boolean } = {},
) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, depositAmount: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  const patientId = admission.patientId;

  // 1. Consolidate every charge onto the admission's SINGLE running IP bill and
  //    finalize it — IP = one bill with all costs (no separate FIN- bill).
  const consolidated = await consolidateAdmissionBill(tenantId, userId, admissionId, { finalize: true });
  const finalBillId: string | null = consolidated.itemCount > 0 ? consolidated.bill.id : null;

  // 1b. Insurance/corporate: make sure the TPA claim reflects the final bill (auto —
  //     no manual "Transfer to TPA"). Runs after finalize so the split sticks.
  try { await ensureAdmissionTpaLink(tenantId, userId, admissionId); } catch (err) {
    logger.warn({ tenantId, admissionId, err }, 'Auto TPA link at discharge failed (non-fatal)');
  }

  // 2. Optionally apply the patient's advance balance to the finalized bill.
  let advanceApplied = 0;
  if (opts.applyAdvance && finalBillId) {
    const adv = await getPatientAdvanceBalance(tenantId, patientId);
    const fb = await prisma.bill.findFirst({ where: { id: finalBillId, tenantId }, select: { balanceDue: true } });
    const toApply = r2(Math.min(Number(adv.balance ?? 0), Number(fb?.balanceDue ?? 0)));
    if (toApply > 0) {
      await adjustAdvanceToBill(tenantId, userId, { patientId, billId: finalBillId, amount: toApply });
      advanceApplied = toApply;
    }
  }

  // 3. Admission-wide financial summary across all non-cancelled bills.
  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    select: { id: true, billNumber: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true },
  });
  const totalBilled = r2(bills.reduce((s, b) => s + Number(b.totalAmount), 0));
  const totalPaid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const totalBalanceDue = r2(bills.reduce((s, b) => s + Number(b.balanceDue), 0));
  const deposit = Number(admission.depositAmount ?? 0);

  logger.info({ tenantId, admissionId, finalBillId, totalBilled, totalBalanceDue }, 'Discharge bill assembled');
  return {
    admissionId,
    patientId,
    finalBillId,
    bills,
    totalBilled,
    totalPaid,
    totalBalanceDue,
    depositAmount: deposit,
    advanceApplied,
    // Informational net after the deposit is settled by the biller.
    netAfterDeposit: r2(Math.max(0, totalBalanceDue - deposit)),
    refundDue: r2(Math.max(0, deposit - totalBalanceDue)),
  };
}

// ============================================================
// IP running ledger (nurse/doctor-addable charges + live view)
// ============================================================

/**
 * The single running IP bill for an admission — the ledger everything posts to.
 * Prefers an open DRAFT bill scoped to the admission (so new lines can be added),
 * else the patient's open draft (backfilling admissionId), else opens a fresh IPW-
 * draft. Stays draft for the whole stay; finalized at discharge.
 */
export async function getOrCreateRunningIpBill(tenantId: string, admissionId: string, userId: string) {
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { id: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  let bill = await prisma.bill.findFirst({ where: { tenantId, admissionId, status: 'draft', ...NOT_ADVANCE_BUCKET }, orderBy: { createdAt: 'desc' } });

  // A stay's bill does not stop being the stay's bill the moment it is
  // finalized. This used to look for a DRAFT and nothing else, so every
  // "Generate / refresh bill" — which finalizes to `pending` — orphaned the
  // running bill, and the next worklist load (this runs for every active
  // admission) opened a brand-new empty one. Charges then landed on the new
  // bill, and one stay ended up spread over four: 1958.50 here, 121.80 there,
  // 280700.00 of bed days on a third. The worklist row adds them all up while
  // naming only the first, so the counter was shown a total that the payment
  // endpoint could only reject. An IP stay is ONE bill.
  //
  // A `paid` bill is deliberately NOT reused: it is a settled document, and
  // charges arriving after an interim settlement belong on a fresh one.
  if (!bill) {
    bill = await prisma.bill.findFirst({
      where: {
        tenantId,
        admissionId,
        status: { in: ['pending', 'partially_paid'] },
        billNumber: { startsWith: 'IPW-' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!bill) {
    const patientDraft = await prisma.bill.findFirst({ where: { tenantId, patientId: admission.patientId, status: 'draft', ...NOT_ADVANCE_BUCKET }, orderBy: { createdAt: 'desc' } });
    if (patientDraft) {
      bill = patientDraft.admissionId ? patientDraft : await prisma.bill.update({ where: { id: patientDraft.id }, data: { admissionId } });
    }
  }
  if (!bill) {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix = `IPW-${ymd}-`;
    // Derive the next sequence from the MAX existing number (not count — a deleted
    // bill would make count collide with a surviving higher number). bill_number is
    // GLOBALLY unique, so the max must be taken across ALL tenants (not tenant-scoped)
    // — otherwise a tenant whose max lags the global max collides. Retry on the race.
    for (let attempt = 0; attempt < 10 && !bill; attempt++) {
      const last = await prisma.bill.findFirst({
        where: { billNumber: { startsWith: prefix } },
        orderBy: { billNumber: 'desc' },
        select: { billNumber: true },
      });
      const lastSeq = last ? parseInt(last.billNumber.slice(prefix.length), 10) || 0 : 0;
      const billNumber = `${prefix}${String(lastSeq + 1 + attempt).padStart(4, '0')}`;
      try {
        bill = await prisma.bill.create({
          data: { tenantId, billNumber, patientId: admission.patientId, admissionId, billDate: new Date(), status: 'draft', generatedBy: userId },
        });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err; // only retry on billNumber collision
      }
    }
    if (!bill) throw AppError.badRequest('Could not allocate a bill number. Please retry.');
  }
  return bill;
}

const IP_CHARGE_CATEGORIES = new Set(['consultation', 'surgery', 'room', 'lab', 'radiology', 'pharmacy', 'procedure', 'consumable', 'other']);

// Billing / hospital-admin roles that get full access to any IP ledger.
const IP_LEDGER_FULL_ROLES = new Set(['super_admin', 'admin', 'billing_admin', 'front_desk', 'cashier']);
// Nurse roles get READ-only access to any IP ledger + activity log (they need
// the running clinical/financial picture for the patients they care for).
const IP_LEDGER_NURSE_ROLES = new Set(['nurse', 'nurse_admin']);

/**
 * Access to an admission's IP ledger:
 *  - full: billing / hospital-admin roles (super_admin, admin, billing_admin, …);
 *  - full (read + post charge): ANY doctor — every IP patient is shared across all
 *    doctors, so any doctor has the same ledger power as the admission's main doctor;
 *  - read + post charge: the actively-assigned nurse; read only: any nurse + the patient;
 *  - everyone else: denied.
 * (Deposits / refunds are additionally route-gated by billing:update, which doctors
 *  and nurses lack — so those stay front-desk/billing regardless.)
 */
async function assertIpLedgerAccess(
  tenantId: string,
  admissionId: string,
  actor: { userId: string; roles: string[] },
  opts: { write: boolean; nurseWrite?: boolean },
) {
  if ((actor.roles ?? []).some((r) => IP_LEDGER_FULL_ROLES.has(r))) return;
  // Nurses may VIEW any IP patient's ledger + activity, and — when the caller
  // sets nurseWrite (addIpCharge / removeIpCharge) — post charges too. Removal is
  // further restricted to the nurse's OWN charges by removeIpCharge. Calls WITHOUT
  // nurseWrite (e.g. recordDoctorVisit) stay doctor/assigned-nurse/billing-only.
  if (
    (actor.roles ?? []).some((r) => IP_LEDGER_NURSE_ROLES.has(r)) &&
    (!opts.write || opts.nurseWrite)
  ) {
    return;
  }

  // ANY doctor (identified by holding a DoctorProfile in this tenant) gets the
  // same read + write access as the admission's main doctor — IP patients are
  // shared across all doctors. Checked before loading the admission so a doctor
  // passes regardless of who the main doctor is.
  const actorDoctor = await prisma.doctorProfile.findFirst({
    where: { userId: actor.userId, tenantId },
    select: { id: true },
  });
  if (actorDoctor) return;

  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { doctorId: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  // The actively-assigned nurse for this admission.
  const nurse = await prisma.nurseAssignment.findFirst({ where: { tenantId, admissionId, status: 'active', nurseId: actor.userId }, select: { id: true } });
  if (nurse) return;
  // The patient — read only (their own ledger).
  if (!opts.write) {
    const patient = await prisma.patient.findFirst({ where: { id: admission.patientId, tenantId }, select: { userId: true } });
    if (patient?.userId && patient.userId === actor.userId) return;
  }
  throw AppError.forbidden('You do not have access to this IP patient\'s ledger.');
}

/**
 * A clinician (doctor / nurse) posts a charge onto the admission's running IP
 * ledger — a doctor visit / professional fee, a nursing procedure, a consumable,
 * bed extras, etc. Resolves/opens the running draft bill and appends a
 * categorised line (tagged manual_clinical so it never collides with auto-pull).
 */
export async function addIpCharge(
  tenantId: string,
  userId: string,
  admissionId: string,
  data: { category: string; description: string; quantity?: number; unitPrice: number; taxRate?: number; serviceTariffId?: string; notes?: string },
  roles: string[] = [],
) {
  await assertIpLedgerAccess(tenantId, admissionId, { userId, roles }, { write: true, nurseWrite: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const category = IP_CHARGE_CATEGORIES.has(data.category) ? data.category : 'other';
  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const qty = Math.max(1, Math.trunc(data.quantity ?? 1));
  const unitPrice = r2(Math.max(0, data.unitPrice));

  const tariff = data.serviceTariffId
    ? await prisma.serviceTariff.findFirst({ where: { id: data.serviceTariffId, tenantId } })
    : null;

  // A nurse or doctor posting a charge at the bedside is not the person who
  // should be deciding its GST rate. The tariff decides where there is one;
  // otherwise the category does, and everything on an admission's ledger is
  // supplied to an admitted patient in the course of their treatment.
  const resolver = await taxResolverFor(tenantId, bill.billDate ?? new Date());
  const priced = resolver.price(
    {
      kind: supplyKindForCategory(category),
      sacCode: (tariff as any)?.sacCode ?? null,
      itemRatePercent: (tariff as any)?.gstApproved
        ? toNumber(tariff!.gstRatePercent)
        : (data.taxRate ?? null),
      itemTreatment: (tariff as any)?.gstTreatment ?? null,
      itemApproved: (tariff as any)?.gstApproved ?? false,
      isCosmetic: (tariff as any)?.isCosmetic ?? false,
      patientAdmitted: true,
      issuedForTreatment: true,
    },
    { unitPrice, quantity: qty },
  );
  const totalAmount = priced.money.totalAmount;

  const item = await prisma.billItem.create({
    data: {
      billId: bill.id,
      serviceTariffId: data.serviceTariffId ?? null,
      description: data.description.trim(),
      category: category as any,
      quantity: qty,
      unitPrice,
      ...billItemTaxFields(priced),
      referenceType: 'manual_clinical',
      referenceId: `${userId}:${Date.now()}`,
      isAutoPulled: false,
    },
  });
  await recalculateBillTotals(bill.id);
  logger.info({ tenantId, admissionId, billId: bill.id, category, totalAmount }, 'IP clinical charge added to ledger');
  return { billId: bill.id, item };
}

/**
 * Remove a manually-posted charge from the running IP ledger — the care team
 * (assigned nurse / the patient's doctor) or billing staff can delete a manual
 * charge or doctor-visit line they added. Guards: only MANUAL lines
 * (isAutoPulled = false) can be removed here — auto-pulled charges come from real
 * orders (lab / pharmacy / room / imaging / OT) and must be handled at source —
 * and only while the bill is still a draft.
 */
export async function removeIpCharge(
  tenantId: string,
  userId: string,
  admissionId: string,
  itemId: string,
  roles: string[] = [],
) {
  await assertIpLedgerAccess(tenantId, admissionId, { userId, roles }, { write: true, nurseWrite: true });

  const item = await prisma.billItem.findFirst({
    where: { id: itemId, bill: { tenantId, admissionId } },
    select: { id: true, billId: true, isAutoPulled: true, referenceType: true, referenceId: true, bill: { select: { status: true } } },
  });
  if (!item) throw AppError.notFound('Ledger charge not found');
  if (item.isAutoPulled) {
    throw AppError.badRequest('Auto-pulled charges cannot be removed here — they come from orders (lab, pharmacy, room, imaging, OT).');
  }
  if (item.bill.status !== 'draft') {
    throw AppError.badRequest('This charge is on a finalized bill and can no longer be removed.');
  }

  // A nurse (without a billing/admin role) may only remove a manual charge THEY
  // added — addIpCharge stamps referenceId as `<userId>:<ts>`. Doctor visits and
  // other users' charges are off-limits.
  const isPrivileged = (roles ?? []).some((r) => IP_LEDGER_FULL_ROLES.has(r));
  const isNurse = (roles ?? []).some((r) => IP_LEDGER_NURSE_ROLES.has(r));
  if (isNurse && !isPrivileged) {
    const creatorId = (item.referenceId ?? '').split(':')[0];
    if (item.referenceType !== 'manual_clinical' || creatorId !== userId) {
      throw AppError.forbidden('You can only remove charges you added yourself.');
    }
  }

  await prisma.billItem.delete({ where: { id: itemId } });
  await recalculateBillTotals(item.billId);
  logger.info({ tenantId, admissionId, billId: item.billId, itemId }, 'IP ledger charge removed');
  return { billId: item.billId, removed: itemId };
}

/**
 * Mark a bill line as insurance-eligible (reimbursable) or patient-only. This is
 * the line-level split — some charges the insurer covers, some the patient always
 * pays. If the bill already has a live TPA claim, the insurer / patient split on
 * the bill is recomputed so the balances stay correct.
 */
export async function setBillItemReimbursable(tenantId: string, itemId: string, isReimbursable: boolean | null) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const item = await prisma.billItem.findFirst({
    where: { id: itemId, bill: { tenantId } },
    select: { id: true, billId: true, bill: { select: { id: true, admissionId: true, totalAmount: true } } },
  });
  if (!item) throw AppError.notFound('Bill line not found');

  await prisma.billItem.update({ where: { id: itemId }, data: { isReimbursable } });

  // If a live claim exists, re-split the bill against the new reimbursable set.
  const claim = await prisma.insuranceClaim.findFirst({
    where: { tenantId, billId: item.billId, status: { notIn: ['cancelled', 'rejected'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, policyId: true },
  });
  if (claim) {
    const insurance = await import('../insurance/insurance.service');
    const items = await prisma.billItem.findMany({ where: { billId: item.billId }, select: { totalAmount: true, isReimbursable: true } });
    const reimbursable = r2(items.filter((it) => it.isReimbursable !== false).reduce((s, it) => s + Number(it.totalAmount), 0));
    const total = Number(item.bill.totalAmount);
    const policy = await prisma.insurancePolicy.findFirst({ where: { id: claim.policyId, tenantId }, select: { coPayPercent: true, deductibleAmount: true, coverageAmount: true } });
    const split = insurance.computeResponsibility(reimbursable, Number(policy?.coPayPercent ?? 0), Number(policy?.deductibleAmount ?? 0), Number(policy?.coverageAmount ?? 0));
    await insurance.applyBillSplit(tenantId, item.billId, split.coveredAmount, r2(total - split.coveredAmount));
  }

  logger.info({ tenantId, billId: item.billId, itemId, isReimbursable }, 'Bill line reimbursable flag set');
  return { billId: item.billId, itemId, isReimbursable };
}

/**
 * Admission-scoped running ledger for the IP workspace: every posted BillItem
 * across the admission's bills PLUS the still-unbilled auto-charges (room days,
 * doctor fee, lab, imaging, OT) so the care team sees the true running total,
 * grouped by category, with deposit and the reimbursable / patient split.
 */
// A deposit that's been moved onto the running IP bill is recorded as an
// `advance` Payment tagged with this prefix (so we can tell the deposit apart
// from cash the patient pays at the counter, and refund it later).
const DEPOSIT_TXN_PREFIX = 'IPDEP:';

/**
 * Marks the RECEIPT of an admission deposit, as distinct from its APPLICATION.
 *
 * `IPDEP:` above means deposit money moving ONTO a bill. This one means deposit
 * money arriving from the patient. Keeping them apart is what lets the receipt
 * record exist without disturbing a single existing figure: the deposit pool is
 * still `Admission.depositAmount`, and `availableToApply` is still that pool
 * less the `IPDEP:` rows.
 */
const DEPOSIT_RECEIPT_TXN_PREFIX = 'IPDEPRCPT:';

/**
 * Record that a patient handed over an admission deposit.
 *
 * Money was being taken and written to `Admission.depositAmount` as a bare
 * number. No Payment, no Receipt, nothing anywhere in the clinical module —
 * so there was no date, no tender, no receipt number, nobody named, and
 * nothing to hand the patient. It was the largest sum a hospital takes before
 * treatment and the only one with no documentary trace at all.
 *
 * Deliberately additive. `Admission.depositAmount` stays the authoritative
 * pool and every existing calculation reads exactly what it read before; this
 * row is the RECEIPT, marked so that nothing counts it as money applied to a
 * bill or as a desk advance. It does not lift the advance bucket's balance,
 * because the deposit is already counted once on the admission.
 *
 * Runs inside the caller's transaction, so the deposit and its receipt commit
 * together — money recorded with no receipt is the very gap this closes.
 */
export async function recordAdmissionDepositReceipt(
  tx: any,
  tenantId: string,
  userId: string,
  data: {
    patientId: string;
    admissionId: string;
    amount: number;
    paymentMethod?: string;
    notes?: string;
  },
): Promise<{ paymentId: string; receiptNumber: string; voucherNumber: string | null } | null> {
  const amount = r2(Math.max(0, data.amount));
  if (amount <= 0) return null;

  const bucket = await ensureAdvanceBucketBill(tx, tenantId, data.patientId);
  const receiptNumber = await generateReceiptNumber(tenantId, tx);
  const profile = await getGstProfile(tenantId);

  // A deposit is money against treatment, and treatment is exempt — the same
  // reasoning as a desk advance, and recorded rather than assumed for the same
  // reason: it is what an advances report and GSTR-1 table 11 read.
  const advanceTax = await advancePaymentTaxFields(tx, tenantId, profile, {
    amount,
    purpose: 'treatment',
  });

  const payment = await tx.payment.create({
    data: {
      tenantId,
      billId: bucket.id,
      patientId: data.patientId,
      amount,
      paymentMethod: mapPaymentMethod(data.paymentMethod ?? 'cash') as any,
      paymentSource: 'frontdesk',
      paymentType: 'advance',
      // The marker that keeps this out of every existing sum.
      transactionId: `${DEPOSIT_RECEIPT_TXN_PREFIX}${data.admissionId}`,
      notes: data.notes ?? 'Admission deposit received',
      status: 'completed',
      paymentDate: new Date(),
      processedBy: userId,
      ...advanceTax,
    },
  });

  await tx.receipt.create({
    data: {
      tenantId,
      receiptNumber,
      paymentId: payment.id,
      receiptDate: new Date(),
      amount,
    },
  });

  logger.info(
    { tenantId, admissionId: data.admissionId, amount, receiptNumber },
    'Admission deposit receipt recorded',
  );
  return {
    paymentId: payment.id,
    receiptNumber,
    voucherNumber: (advanceTax.voucherNumber as string | null) ?? null,
  };
}

/**
 * The deposit "position" for an admission: how much was collected at admission
 * (on file), how much has been applied onto the bill, and how much of that was
 * refunded back to the patient. Derived entirely from Payment/Refund markers so
 * no schema change is needed.
 */
/**
 * Money the hospital is holding from the patient for a stay, net of anything
 * already given back.
 *
 * `paid` — a bill's `amountPaid` — ALREADY nets refunds off, because
 * computeBillPaid subtracts them. The old form here was
 * `cashPaid + deposit - dep.refunded`, which subtracted a returned deposit a
 * SECOND time: a stay owing 120 was shown as owing 240.
 *
 * Deleting that term alone would have broken the case it was there for — a
 * deposit taken back in full must leave the charges owing — because
 * `cashPaid = max(0, paid - applied)` clamps at zero and loses the refund
 * again. So the rule is stated the other way round: everything actually
 * received (net of returns) plus whatever deposit is still held and has not
 * been posted to a bill.
 *
 * Three call sites had their own copy of this. They must not diverge — the
 * discharge counter gates on the number the ledger shows.
 */
function moneyHeldFromPatient(paid: number, depositPool: number, applied: number) {
  const r2n = (n: number) => Math.round(n * 100) / 100;
  return r2n(paid + Math.max(0, r2n(depositPool - applied)));
}

async function getAdmissionDepositState(tenantId: string, admissionId: string) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { depositAmount: true },
  });
  const onFile = r2(Number(admission?.depositAmount ?? 0));

  const depositPayments = await prisma.payment.findMany({
    where: { tenantId, status: 'completed', transactionId: { startsWith: DEPOSIT_TXN_PREFIX }, bill: { admissionId } },
    select: { id: true, amount: true },
  });
  const applied = r2(depositPayments.reduce((s, p) => s + Number(p.amount), 0));

  const paymentIds = depositPayments.map((p) => p.id);
  const refunds = paymentIds.length
    ? await prisma.refund.findMany({
        where: { tenantId, paymentId: { in: paymentIds }, status: { in: ['requested', 'approved', 'processed'] } },
        select: { amount: true },
      })
    : [];
  const refunded = r2(refunds.reduce((s, r) => s + Number(r.amount), 0));

  return {
    onFile,
    applied,
    refunded,
    // Deposit still sitting on file that could be applied to the bill.
    availableToApply: r2(Math.max(0, onFile - applied)),
    paymentIds,
  };
}

/**
 * Deposit-adjusted money the patient still owes for a stay — the same number the
 * IP ledger shows as `balanceAfterDeposit`, extracted so the discharge counter
 * can gate on it without pulling the whole ledger payload.
 *
 * Money rule (identical to `getAdmissionLedger`, do not diverge):
 *   - `billItem.totalAmount` ALREADY includes that line's tax — never re-add it.
 *   - A counter concession is written on the BILL HEADER (`bill.discountAmount`)
 *     and never onto the items, so it must be subtracted or a fully-settled stay
 *     reads as still owing.
 *   - Charges not yet posted to a bill (room days, doctor fee, lab, imaging, OT)
 *     still count — the patient owes them whether or not billing has pulled them.
 */
export async function getAdmissionOutstanding(tenantId: string, admissionId: string) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, visitId: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // Charges for this stay live on the admission's own IP bills AND on orphan
  // bills auto-created against the admission's VISIT (where lab / imaging land).
  const bills = await prisma.bill.findMany({
    where: {
      tenantId,
      status: { not: 'cancelled' },
      OR: [
        { admissionId },
        ...(admission.visitId ? [{ visitId: admission.visitId, admissionId: null }] : []),
      ],
    },
    select: {
      // `id` and the line `description` are what let the dedupe below tell a
      // cross-bill duplicate from two separate lines of one OT kit.
      id: true,
      amountPaid: true,
      discountAmount: true,
      insuranceCoveredAmount: true,
      billItems: { select: { totalAmount: true, referenceType: true, referenceId: true, description: true } },
    },
  });

  // Dedupe by charge reference so a charge sitting on both an IP bill and a
  // visit bill is only counted once.
  // The key has to identify a LINE, not the event a line came from, and it must
  // only collapse rows across DIFFERENT bills. One OT kit issue stamps the same
  // referenceId on every medicine in the kit, so keying on the reference alone
  // hid every line of that kit but the first — a real 120.00 A-Art Injection
  // vanished from the ledger while staying on the bill. The stay then looked
  // 120 overpaid, the desk returned that 120 as surplus deposit, and the bill
  // was left owing 120 again.
  const seenRef = new Map<string, string>();
  let totalPosted = 0;
  for (const b of bills) {
    for (const it of b.billItems) {
      const refKey = it.referenceType && it.referenceId
        ? `${it.referenceType}:${it.referenceId}::${it.description}::${Number(it.totalAmount)}`
        : null;
      if (refKey) {
        const firstBill = seenRef.get(refKey);
        // Already counted from ANOTHER bill — that is the duplicate this guard
        // is for. A repeat within the same bill is a separate line.
        if (firstBill && firstBill !== b.id) continue;
        if (!firstBill) seenRef.set(refKey, b.id);
      }
      totalPosted = r2(totalPosted + Number(it.totalAmount));
    }
  }

  let totalPending = 0;
  try {
    const { charges } = await getPatientCharges(tenantId, { patientId: admission.patientId });
    totalPending = r2(charges.reduce((s, c) => s + c.totalAmount, 0));
  } catch {
    /* patient missing → nothing pending */
  }

  const paid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const insuranceCovered = r2(bills.reduce((s, b) => s + Number(b.insuranceCoveredAmount ?? 0), 0));
  const billDiscount = r2(bills.reduce((s, b) => s + Number(b.discountAmount ?? 0), 0));
  const grandTotal = r2(Math.max(0, totalPosted + totalPending - billDiscount));

  const dep = await getAdmissionDepositState(tenantId, admissionId);
  // Reported for display; the balance is not derived from it.
  const cashPaid = r2(Math.max(0, paid - dep.applied));
  const netPatientObligation = r2(Math.max(0, grandTotal - insuranceCovered));
  const moneyFromPatient = moneyHeldFromPatient(paid, dep.onFile, dep.applied);
  const balanceAfterDeposit = r2(Math.max(0, netPatientObligation - moneyFromPatient));

  return {
    grandTotal,
    totalPosted,
    totalPending,
    billDiscount,
    insuranceCovered,
    depositOnFile: dep.onFile,
    cashPaid,
    /** Deposit-adjusted amount still payable. Zero means the stay is settled. */
    balanceAfterDeposit,
    /** Sub-rupee residue is rounding noise, not an unpaid bill. */
    isCleared: balanceAfterDeposit < 0.01,
  };
}

export async function getAdmissionLedger(tenantId: string, admissionId: string, actor: { userId: string; roles: string[] }) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: false });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, depositAmount: true, billingCategory: true, admissionDate: true, visitId: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // Charges for this stay live on two kinds of bill: the admission's own IP
  // bills (admissionId set), AND orphan bills auto-created for the admission's
  // VISIT with no admissionId — this is where lab (autoLinkLabOrderToBill) and
  // imaging charges land. Without the visit branch those never appear here.
  //
  // The `ADV-` advance bucket is excluded even when it carries this
  // admissionId. Ward charge paths used to be able to pick the bucket as "the
  // patient's open bill" and then stamp the admission onto it; any row left
  // that way would be summed here as a bill, and its `amountPaid` IS the
  // advance balance — so `paid` below would count the advance a second time,
  // on top of `advanceOnFile`. That understates what the patient still owes
  // and overstates what is refundable to them.
  const allBills = await prisma.bill.findMany({
    where: {
      tenantId,
      ...NOT_ADVANCE_BUCKET,
      status: { not: 'cancelled' },
      OR: [
        { admissionId },
        ...(admission.visitId ? [{ visitId: admission.visitId, admissionId: null }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
    include: { billItems: { orderBy: { createdAt: 'asc' } } },
  });
  // Belt and braces on a money invariant: the filter above keeps the bucket out
  // in SQL, and this keeps it out of the sums no matter how the rows arrived.
  const bills = allBills.filter((b) => !isAdvanceBucket(b.billNumber));

  // Dedupe by charge reference so a charge that somehow sits on both an IP bill
  // and a visit bill is only counted once.
  // The key has to identify a LINE, not the event a line came from, and it must
  // only collapse rows across DIFFERENT bills. One OT kit issue stamps the same
  // referenceId on every medicine in the kit, so keying on the reference alone
  // hid every line of that kit but the first — a real 120.00 A-Art Injection
  // vanished from the ledger while staying on the bill. The stay then looked
  // 120 overpaid, the desk returned that 120 as surplus deposit, and the bill
  // was left owing 120 again.
  const seenRef = new Map<string, string>();
  const posted: Array<{
    id: string; billId: string; billNumber: string;
    description: string; category: string;
    quantity: number; unitPrice: number; totalAmount: number;
    isReimbursable: boolean | null; isAutoPulled: boolean;
    addedByMe: boolean; status: 'posted'; at: string;
    // The line's frozen tax position, carried so the printed bill can show
    // what the law wants per line — HSN/SAC, taxable value, rate, and the
    // split — without going back to the bill items a second way and risking a
    // document that disagrees with the ledger it was built from.
    hsnSac: string | null; gstTreatment: string | null; taxRatePercent: number;
    taxableValue: number; taxAmount: number;
    cgstRate: number; cgstAmount: number;
    sgstRate: number; sgstAmount: number;
    igstRate: number; igstAmount: number; cessAmount: number;
  }> = [];
  for (const b of bills) {
    for (const it of b.billItems) {
      const refKey = it.referenceType && it.referenceId
        ? `${it.referenceType}:${it.referenceId}::${it.description}::${Number(it.totalAmount)}`
        : null;
      if (refKey) {
        const firstBill = seenRef.get(refKey);
        // Already counted from ANOTHER bill — that is the duplicate this guard
        // is for. A repeat within the same bill is a separate line.
        if (firstBill && firstBill !== b.id) continue;
        if (!firstBill) seenRef.set(refKey, b.id);
      }
      posted.push({
        id: it.id, billId: b.id, billNumber: b.billNumber,
        description: it.description, category: String(it.category),
        quantity: it.quantity, unitPrice: Number(it.unitPrice), totalAmount: Number(it.totalAmount),
        isReimbursable: it.isReimbursable, isAutoPulled: it.isAutoPulled,
        // Was this manual charge added by the current user? Lets the UI show a
        // remove button only for one's own charges (nurses can delete only theirs).
        addedByMe: it.referenceType === 'manual_clinical' && (it.referenceId ?? '').split(':')[0] === actor.userId,
        status: 'posted' as const, at: it.createdAt.toISOString(),
        hsnSac: it.hsnSacCode ?? null,
        gstTreatment: it.gstTreatment ?? null,
        taxRatePercent: Number(it.taxPercent ?? 0),
        taxableValue: Number(it.taxableValue ?? 0),
        taxAmount: Number(it.taxAmount ?? 0),
        cgstRate: Number(it.cgstRate ?? 0), cgstAmount: Number(it.cgstAmount ?? 0),
        sgstRate: Number(it.sgstRate ?? 0), sgstAmount: Number(it.sgstAmount ?? 0),
        igstRate: Number(it.igstRate ?? 0), igstAmount: Number(it.igstAmount ?? 0),
        cessAmount: Number(it.cessAmount ?? 0),
      });
    }
  }

  // Pending auto-charges not yet on any bill (room days, doctor fee, lab, imaging, OT).
  let pending: typeof posted = [];
  try {
    const { charges } = await getPatientCharges(tenantId, { patientId: admission.patientId });
    pending = charges.map((c) => ({
      id: `${c.referenceType}:${c.referenceId}`, billId: null as any, billNumber: null as any,
      description: c.description, category: String(c.category),
      quantity: c.quantity, unitPrice: c.unitPrice, totalAmount: c.totalAmount,
      isReimbursable: null as any, isAutoPulled: true,
      addedByMe: false,
      // A pending charge has not been priced onto a bill yet, so it has no tax
      // position at all. Left null rather than defaulted to exempt: an interim
      // bill must not claim a classification nothing has made.
      hsnSac: null, gstTreatment: null, taxRatePercent: 0,
      taxableValue: c.totalAmount, taxAmount: 0,
      cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0,
      igstRate: 0, igstAmount: 0, cessAmount: 0,
      // Sort on the raw ISO timestamp — c.occurredAt is a display string
      // (dd/MM/yyyy HH:mm) that Date can't parse, which scrambled the order.
      status: 'pending' as any, at: c.occurredAtISO,
    }));
  } catch { /* patient missing → no pending */ }

  const lines = [...posted, ...pending].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const byCat = new Map<string, { posted: number; pending: number }>();
  for (const l of lines) {
    const cur = byCat.get(l.category) ?? { posted: 0, pending: 0 };
    if (l.status === 'posted') cur.posted = r2(cur.posted + l.totalAmount); else cur.pending = r2(cur.pending + l.totalAmount);
    byCat.set(l.category, cur);
  }
  const categoryTotals = [...byCat.entries()].map(([category, v]) => ({ category, posted: v.posted, pending: v.pending, total: r2(v.posted + v.pending) }));

  const totalPosted = r2(posted.reduce((s, l) => s + l.totalAmount, 0));
  const totalPending = r2(pending.reduce((s, l) => s + l.totalAmount, 0));
  const paid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const insuranceCovered = r2(bills.reduce((s, b) => s + Number(b.insuranceCoveredAmount ?? 0), 0));

  // A concession granted at the counter (PATCH /billing/:id/discount) is recorded
  // on the BILL HEADER — `applyDiscount` writes bill.discountAmount and reduces
  // bill.totalAmount, and never touches the line items. Summing item totals alone
  // therefore ignored it completely: a stay billed 3,500 with a 500 concession and
  // paid 3,000 in full still showed 500 outstanding here, blocked the deposit
  // refund (which is capped by `refundable` below) and printed a wrong bill.
  // Item-level tax is already inside item.totalAmount, so tax is NOT re-added.
  const billDiscount = r2(bills.reduce((s, b) => s + Number(b.discountAmount ?? 0), 0));
  const grandTotal = r2(Math.max(0, totalPosted + totalPending - billDiscount));
  const reimbursable = r2(posted.filter((l) => l.isReimbursable === true).reduce((s, l) => s + l.totalAmount, 0));
  const nonReimbursable = r2(posted.filter((l) => l.isReimbursable === false).reduce((s, l) => s + l.totalAmount, 0));

  // Money the patient has put down sits in TWO places and only one of them was
  // read here:
  //
  //   • Admission.depositAmount — a deposit taken against this stay.
  //   • the patient's ADV- bucket — an advance taken at the front desk, which
  //     is what the desk actually uses.
  //
  // So the ledger showed "Deposit ₹0.00" for a patient who had handed over
  // ₹10,000 minutes earlier, the Deposit panel (rendered only when deposit > 0)
  // never appeared at all, and there was no way to see the balance or return
  // it. Both pools are now counted as what they are: money the hospital is
  // holding for this patient.
  const dep = await getAdmissionDepositState(tenantId, admissionId);
  const advance = await getPatientAdvanceBalance(tenantId, admission.patientId);
  const advanceOnFile = r2(Number(advance.balance ?? 0));
  const depositOnFile = dep.onFile;
  // What the desk should see as "held for this patient", whichever counter took it.
  const deposit = r2(depositOnFile + advanceOnFile);
  // Real cash the patient paid at the counter (excludes deposit moved onto the
  // bill). Reported as `cashPaid`; not what the balance is derived from.
  const cashPaid = r2(Math.max(0, paid - dep.applied));
  // What the patient must ultimately pay = charges minus the insurer-covered part.
  const netPatientObligation = r2(Math.max(0, grandTotal - insuranceCovered));
  const moneyFromPatient = moneyHeldFromPatient(paid, deposit, dep.applied);
  // Deposit-adjusted balance still owed by the patient.
  const balanceAfterDeposit = r2(Math.max(0, netPatientObligation - moneyFromPatient));
  // Surplus the patient overpaid (e.g. insurance covered the charges) —
  // refundable from whatever is still held and not already returned.
  const surplus = r2(Math.max(0, moneyFromPatient - netPatientObligation));
  const refundable = r2(Math.min(surplus, r2(Math.max(0, deposit - dep.refunded))));

  return {
    admissionId,
    patientId: admission.patientId,
    billingCategory: (admission.billingCategory ?? 'cash').toLowerCase(),
    lines,
    categoryTotals,
    bills: bills.map((b) => ({ id: b.id, billNumber: b.billNumber, status: b.status, totalAmount: Number(b.totalAmount), amountPaid: Number(b.amountPaid), balanceDue: Number(b.balanceDue) })),
    totals: {
      posted: totalPosted,
      pending: totalPending,
      /** Bill-header concession already deducted from `grandTotal`. */
      discount: billDiscount,
      grandTotal,
      paid,
      cashPaid,
      insuranceCovered,
      /** Everything held for this patient — stay deposit plus front-desk advance. */
      deposit,
      /** The two pools separately, so the desk can see where the money sits. */
      depositOnFile,
      advanceOnFile,
      depositApplied: dep.applied,
      depositRefunded: dep.refunded,
      // Applyable = the stay deposit not yet used, plus the whole advance
      // balance. Both can be cut from the bill; they just live in different
      // places.
      depositAvailable: r2(dep.availableToApply + advanceOnFile),
      balanceAfterDeposit,
      refundable,
      reimbursable,
      nonReimbursable,
    },
  };
}

/**
 * Billing-counter action: "cut the deposit from the bill" — move (part of) the
 * admission's deposit onto the running IP bill as an `advance` payment, reducing
 * the patient's balance due. Applied against the current outstanding balance; the
 * deposit stays on file until there's a charge to set it against.
 */
/**
 * Set the money a patient has already handed over against a bill.
 *
 * Two pools hold it — the stay deposit and the patient's front-desk advance —
 * and the stay deposit is spent first because it belongs to this admission.
 * Never applies more than the bill actually owes, so it cannot overpay a bill,
 * and it is naturally idempotent: once applied, `availableToApply` is 0 and a
 * second call does nothing.
 *
 * Shared by the counter's "Apply to bill" button and the automatic application
 * that runs when a bill is prepared for payment.
 */
async function applyHeldMoneyToBill(
  tenantId: string,
  userId: string,
  admissionId: string,
  patientId: string,
  billId: string,
  cap?: number,
): Promise<{ fromDeposit: number; fromAdvance: number; applied: number; available: number; balance: number }> {
  const r2n = (n: number) => Math.round(n * 100) / 100;
  const dep = await getAdmissionDepositState(tenantId, admissionId);
  const advance = await getPatientAdvanceBalance(tenantId, patientId);
  const available = r2n(dep.availableToApply + r2n(Number(advance.balance ?? 0)));

  const fresh = await prisma.bill.findFirst({ where: { id: billId, tenantId }, select: { balanceDue: true } });
  const balance = r2n(Number(fresh?.balanceDue ?? 0));

  const requested = cap != null ? r2n(Math.max(0, cap)) : available;
  const target = r2n(Math.min(requested, available, balance));
  if (target <= 0) return { fromDeposit: 0, fromAdvance: 0, applied: 0, available, balance };

  const fromDeposit = r2n(Math.min(target, dep.availableToApply));
  const fromAdvance = r2n(target - fromDeposit);

  // The advance half goes through the advance machinery so its bucket balance
  // falls and the money is not counted twice.
  if (fromAdvance > 0) {
    await adjustAdvanceToBill(tenantId, userId, { patientId, billId, amount: fromAdvance });
  }
  if (fromDeposit > 0) {
    await prisma.payment.create({
      data: {
        tenantId,
        billId,
        patientId,
        paymentDate: new Date(),
        amount: fromDeposit,
        paymentMethod: 'advance',
        paymentType: 'advance',
        transactionId: `${DEPOSIT_TXN_PREFIX}${admissionId}`,
        status: 'completed',
        processedBy: userId,
        notes: 'Admission deposit applied to IP bill',
      },
    });
  }
  await recalculateBillTotals(billId);
  return { fromDeposit, fromAdvance, applied: target, available, balance };
}

export async function applyDepositToBill(
  tenantId: string,
  userId: string,
  admissionId: string,
  actor: { userId: string; roles: string[] },
  opts: { amount?: number } = {},
) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { id: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  // Two pools hold this patient's money: the stay deposit, and the front-desk
  // advance. The desk collects into the advance, so applying "the deposit" had
  // nothing to work with and the button was disabled on a patient who had paid.
  // Spend the stay deposit first (it belongs to this admission), then the
  // general advance.
  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const res = await applyHeldMoneyToBill(
    tenantId, userId, admissionId, admission.patientId, bill.id, opts.amount,
  );

  // The button is manual, so it explains itself when there is nothing to do.
  // The automatic application on the way to the counter stays silent instead.
  if (res.available <= 0) {
    throw AppError.badRequest(
      'Nothing left to apply — the deposit and advance have both been used against the bill.',
    );
  }
  if (res.balance <= 0) {
    throw AppError.badRequest('No outstanding balance to set the deposit against yet — charges are still building up.');
  }
  if (res.applied <= 0) throw AppError.badRequest('Nothing to apply.');

  logger.info(
    { tenantId, admissionId, billId: bill.id, fromDeposit: res.fromDeposit, fromAdvance: res.fromAdvance },
    'Deposit applied to IP bill',
  );
  return getAdmissionLedger(tenantId, admissionId, actor);
}

/**
 * Billing-counter action: "return the deposit" — refund the unused part of the
 * deposit to the patient (typically when insurance covered the charges in full,
 * so the deposit was never needed). Records the deposit as received on the bill
 * (if it wasn't already) and raises a processed Refund against it.
 */
export async function refundDeposit(
  tenantId: string,
  userId: string,
  admissionId: string,
  actor: { userId: string; roles: string[] },
  opts: { amount?: number; reason?: string } = {},
) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { id: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  const ledger = await getAdmissionLedger(tenantId, admissionId, actor);
  const refundableNow = Number(ledger.totals.refundable ?? 0);
  const requested = opts.amount != null ? r2(Math.max(0, opts.amount)) : refundableNow;
  const toRefund = r2(Math.min(requested, refundableNow));
  if (toRefund <= 0) {
    throw AppError.badRequest('No deposit to return — the charges (after insurance) still use up the deposit.');
  }

  // The refundable figure now spans BOTH pools — the stay deposit and the
  // patient's front-desk advance. Return the advance half out of its own
  // bucket: minting a fresh deposit payment for money that is already sitting
  // in the advance would hand it back while still showing it as held.
  const dep = await getAdmissionDepositState(tenantId, admissionId);
  const depositHeld = r2(Math.max(0, dep.onFile - dep.refunded));
  const fromDeposit = r2(Math.min(toRefund, depositHeld));
  const fromAdvance = r2(toRefund - fromDeposit);

  if (fromAdvance > 0) {
    const bucket = await prisma.bill.findFirst({
      where: { tenantId, patientId: admission.patientId, billNumber: { startsWith: 'ADV-' } },
    });
    const available = bucket ? toNumber(bucket.amountPaid) : 0;
    if (available + 0.001 < fromAdvance) {
      throw AppError.badRequest(
        `Only ₹${available} is left on the patient's advance — cannot return ₹${fromAdvance} from it.`,
      );
    }
    await prisma.$transaction(async (tx) => {
      // Draw the bucket down, and record the payout against the advance payment
      // it came from so the money has a receipt trail on the way out as well as in.
      await tx.bill.update({
        where: { id: bucket!.id },
        data: {
          amountPaid: Math.max(0, toNumber(bucket!.amountPaid) - fromAdvance),
          totalAmount: Math.max(0, toNumber(bucket!.totalAmount) - fromAdvance),
        },
      });
      const advPayment = await tx.payment.findFirst({
        where: { tenantId, billId: bucket!.id, paymentType: 'advance' as never, status: 'completed' },
        orderBy: { paymentDate: 'desc' },
        select: { id: true },
      });
      if (advPayment) {
        await tx.refund.create({
          data: {
            tenantId,
            billId: bucket!.id,
            paymentId: advPayment.id,
            patientId: admission.patientId,
            amount: fromAdvance,
            reason: opts.reason?.trim() || 'Advance returned to patient',
            status: 'processed',
            requestedBy: userId,
            approvedBy: userId,
            processedAt: new Date(),
          },
        });
        // An advance taken and handed back without a supply ever happening is
        // a REFUND VOUCHER, not a credit note — there is no invoice to credit.
        // It mirrors the receipt voucher's own tax so the pair nets to zero.
        await issueRefundVoucherBestEffort(tx, tenantId, {
          sourceAdvancePaymentId: advPayment.id,
          patientId: admission.patientId,
          billId: bucket!.id,
          amount: fromAdvance,
          reason: opts.reason?.trim() || 'Advance returned to patient',
          issuedBy: userId,
        });
      }
    });
    logger.info({ tenantId, admissionId, fromAdvance }, 'Patient advance returned');
  }

  if (fromDeposit <= 0) {
    // Nothing was held against the stay itself — the whole return came out of
    // the advance and is already done.
    const summaryOnly = await getAdmissionLedger(tenantId, admissionId, actor);
    return { refund: null, ledger: summaryOnly };
  }

  // We need a completed Payment to attach the Refund to. Reuse an existing deposit
  // payment with enough headroom, else record the deposit onto the running bill now.
  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const depositPayments = await prisma.payment.findMany({
    where: { tenantId, status: 'completed', transactionId: { startsWith: DEPOSIT_TXN_PREFIX }, bill: { admissionId } },
    select: { id: true, amount: true, billId: true, refunds: { where: { status: { in: ['requested', 'approved', 'processed'] } }, select: { amount: true } } },
  });
  let target = depositPayments.find((p) => {
    const already = p.refunds.reduce((s, r) => s + Number(r.amount), 0);
    return r2(Number(p.amount) - already) >= fromDeposit;
  });
  if (!target) {
    const created = await prisma.payment.create({
      data: {
        tenantId,
        billId: bill.id,
        patientId: admission.patientId,
        paymentDate: new Date(),
        amount: fromDeposit,
        paymentMethod: 'advance',
        paymentType: 'advance',
        transactionId: `${DEPOSIT_TXN_PREFIX}${admissionId}`,
        status: 'completed',
        processedBy: userId,
        notes: 'Admission deposit recorded for refund',
      },
    });
    await recalculateBillTotals(bill.id);
    target = { id: created.id, amount: created.amount as any, billId: bill.id, refunds: [] };
  }

  // Put the refund on the bill that holds the payment it is refunding, NOT on
  // whatever bill is running today. Once the stay's bill is fully paid it is no
  // longer reused, so this opened a brand-new bill, hung a 120 refund on it
  // with no payment behind it, and the counter was shown 120 due on an empty
  // draft — which it then refused to take, because a draft is not payable:
  // "This bill is still open for charges."
  const refundBillId = target.billId ?? bill.id;

  const refund = await prisma.refund.create({
    data: {
      tenantId,
      billId: refundBillId,
      paymentId: target.id,
      patientId: admission.patientId,
      amount: fromDeposit,
      reason: opts.reason?.trim() || 'Deposit returned — charges covered (insurance / no balance)',
      status: 'processed',
      requestedBy: userId,
      approvedBy: userId,
      processedAt: new Date(),
    },
  });
  // The refund changes what that bill counts as paid — settle its header.
  await recalculateBillTotals(refundBillId);

  // The voucher is issued against the RECEIPT of the deposit, not against the
  // row the refund is hung on. Rule 51 asks for the receipt voucher's number,
  // and the row above is an APPLIED deposit (IPDEP:) — the money moving onto a
  // bill — which is a different event from the patient handing it over.
  const depositReceipt = await prisma.payment.findFirst({
    where: {
      tenantId,
      patientId: admission.patientId,
      transactionId: `${DEPOSIT_RECEIPT_TXN_PREFIX}${admissionId}`,
      status: 'completed',
    },
    orderBy: { paymentDate: 'asc' },
    select: { id: true, billId: true },
  });
  if (depositReceipt) {
    await prisma.$transaction(async (tx) =>
      issueRefundVoucherBestEffort(tx, tenantId, {
        sourceAdvancePaymentId: depositReceipt.id,
        patientId: admission.patientId,
        billId: depositReceipt.billId,
        amount: fromDeposit,
        reason: opts.reason?.trim() || 'Deposit returned to patient',
        issuedBy: userId,
      }),
    );
  }

  logger.info({ tenantId, admissionId, billId: refundBillId, refundId: refund.id, fromDeposit, fromAdvance }, 'IP deposit returned to patient');
  const summary = await getAdmissionLedger(tenantId, admissionId, actor);
  return { refund, ledger: summary };
}

// Billing categories that settle through insurance / a TPA.
const INSURANCE_CATEGORIES = new Set(['insurance', 'corporate']);

/**
 * Auto-connect an IP admission to its TPA — there is NO billing-admin "Transfer to
 * TPA" step. Because the patient chose insurance at booking, this (1) links the
 * patient to a TPA policy (the connection, from admission) and (2) once there are
 * reimbursable charges, raises the insurance claim against the admission's running
 * (draft) bill and keeps its amount + insurer/patient split in sync as charges
 * grow. The bill is never finalized here (charges keep accruing) — it finalizes at
 * discharge, by which point the claim already reflects the full amount. The claim
 * is only auto-adjusted while it is still pre-processing (submitted / resubmitted);
 * once the TPA team picks it up it is left alone. Idempotent + meant to be non-fatal.
 */
export async function ensureAdmissionTpaLink(tenantId: string, userId: string, admissionId: string) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, billingCategory: true },
  });
  if (!admission) return null;
  const cat = (admission.billingCategory ?? '').toLowerCase();
  if (!INSURANCE_CATEGORIES.has(cat)) return null;

  const insurance = await import('../insurance/insurance.service');

  // 1) The connection: ensure the patient is linked to a TPA policy (from booking).
  const policy = await resolveTransferPolicy(tenantId, admission.patientId, {});
  if (!policy) return { policy: null, claim: null, connected: false };

  // 2) The admission's bills — do NOT create one here; the connection stands even
  //    before any bill/charges exist.
  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, status: true, totalAmount: true, discountAmount: true,
      billItems: { select: { totalAmount: true, isReimbursable: true } },
    },
  });

  const existingClaim = await prisma.insuranceClaim.findFirst({
    where: { tenantId, bill: { admissionId }, status: { notIn: ['cancelled', 'rejected'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, billId: true, status: true, claimAmount: true, coveredAmount: true },
  });

  // The bill the claim is / should sit on: the claim's own bill, else the bill that
  // actually has charges, else the latest bill.
  const claimBill = existingClaim
    ? bills.find((b) => b.id === existingClaim.billId) ?? null
    : bills.find((b) => b.billItems.some((it) => Number(it.totalAmount) !== 0)) ?? bills[bills.length - 1] ?? null;
  if (!claimBill) return { policy, claim: existingClaim, connected: true };

  // Reimbursable line items — but never more than the bill actually came to.
  // A concession is recorded on the bill HEADER (applyDiscount), not on the
  // lines, so summing lines alone would raise a claim for the pre-discount
  // amount and ask the insurer for more than the hospital billed. Capping at
  // bill.totalAmount is the one allocation that is unarguable; how a concession
  // should otherwise be split between insurer and patient is a policy call, not
  // something to invent here.
  const reimbursableTotal = r2(
    claimBill.billItems.filter((it) => it.isReimbursable !== false).reduce((s, it) => s + Number(it.totalAmount), 0),
  );
  const billCeiling = r2(Number(claimBill.totalAmount ?? 0));
  const claimAmount =
    billCeiling > 0 ? r2(Math.min(reimbursableTotal, billCeiling)) : reimbursableTotal;
  if (reimbursableTotal > claimAmount) {
    logger.info(
      { tenantId, admissionId, billId: claimBill.id, reimbursableTotal, claimAmount },
      'Claim capped at the bill total — a bill-level concession is in play',
    );
  }

  if (!existingClaim) {
    if (claimAmount <= 0) return { policy, claim: null, connected: true }; // linked, awaiting charges
    const claim = await insurance.createClaim(tenantId, userId, {
      policyId: policy.id, patientId: admission.patientId, billId: claimBill.id, claimAmount,
    } as any);
    const covered = Number(claim.coveredAmount ?? 0);
    await insurance.applyBillSplit(tenantId, claimBill.id, covered, r2(claimAmount - covered));
    logger.info({ tenantId, admissionId, claimId: claim.id, claimAmount }, 'IP admission auto-connected to TPA (claim raised)');
    return { policy, claim, connected: true };
  }

  // Keep a still-pre-processing claim in step with the charges.
  if (
    (existingClaim.status === 'submitted' || existingClaim.status === 'resubmitted') &&
    claimAmount > 0 &&
    r2(Number(existingClaim.claimAmount)) !== claimAmount
  ) {
    const synced = await insurance.resyncClaimAmount(tenantId, existingClaim.id, claimAmount);
    const covered = Number(synced?.coveredAmount ?? 0);
    await insurance.applyBillSplit(tenantId, existingClaim.billId, covered, r2(claimAmount - covered));
    return { policy, claim: synced, connected: true };
  }
  return { policy, claim: existingClaim, connected: true };
}

/**
 * The IP billing worklist — ONE row per admission, shown from the moment the
 * patient is admitted (not only once a bill exists). Every active admission gets
 * its running IP bill ensured, its charges rolled up (deposit-adjusted), and its
 * TPA/insurance claim surfaced. This is what the Hospital Billing → IP section lists.
 */
export async function getIpAdmissionsForBilling(
  tenantId: string,
  userId: string,
  query: { search?: string; includeDischarged?: boolean; limit?: number } = {},
) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const limit = Math.min(Math.max(Number(query.limit ?? 60), 1), 200);
  const search = query.search?.trim();

  const patientFilter = search
    ? {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { mrn: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : undefined;

  // A stay waiting on the counter (`ready_to_discharge`) is exactly what this
  // worklist exists for, so it always belongs in the active set.
  const statusIn = query.includeDischarged
    ? [...ACTIVE_ADMISSION_STATUSES, 'discharged']
    : [...ACTIVE_ADMISSION_STATUSES];
  const admissions = await prisma.admission.findMany({
    where: {
      tenantId,
      status: { in: statusIn as any },
      ...(patientFilter ? { patient: patientFilter } : {}),
    },
    orderBy: [{ status: 'asc' }, { admissionDate: 'desc' }],
    take: limit,
    select: {
      id: true, status: true, admissionDate: true, dischargeDate: true,
      depositAmount: true, billingCategory: true, patientId: true,
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
    },
  });

  const admissionIds = admissions.map((a) => a.id);

  // Care type (ip | emergency | daycare). All three run the same IP flow and
  // land in this one worklist, so without the tag the counter can't tell a
  // Day Care row from an Emergency one. `admission_type` is a raw column, hence
  // the raw SELECT (same pattern as billing.bill-document.ts).
  const typeRows = admissionIds.length
    ? await prisma.$queryRaw<{ id: string; admission_type: string | null }[]>`
        SELECT id, admission_type FROM admissions WHERE id IN (${Prisma.join(admissionIds)})
      `
    : [];
  const typeById = new Map(typeRows.map((r) => [r.id, normalizeAdmissionType(r.admission_type)]));

  // Advance balances for every patient on this page, in ONE query.
  //
  // The per-row version called getPatientAdvanceBalance inside the loop, which
  // is two more round-trips per admission on a list that already does several.
  // At 16 rows that is measurable; at a few hundred it is the reason the page
  // stops loading. The balance is just the ADV- bucket's amountPaid, so the
  // whole page's worth can be fetched at once and read from a map.
  const advanceByPatient = new Map<string, number>();
  const patientIds = Array.from(new Set(admissions.map((a) => a.patientId)));
  if (patientIds.length > 0) {
    const buckets = await prisma.bill.findMany({
      where: { tenantId, patientId: { in: patientIds }, billNumber: { startsWith: 'ADV-' } },
      select: { patientId: true, amountPaid: true },
    });
    for (const b of buckets) {
      advanceByPatient.set(b.patientId, r2(toNumber(b.amountPaid)));
    }
  }

  const rows = [];
  for (const a of admissions) {
    // Every ACTIVE admission gets a running bill so it appears here from day one
    // and charges have somewhere to post. Discharged keeps whatever bills it has.
    if (isActiveAdmission(a.status)) {
      try { await getOrCreateRunningIpBill(tenantId, a.id, userId); } catch { /* non-fatal */ }
    }
    // Insurance/corporate patients auto-connect to the TPA (no manual transfer) —
    // link the policy and raise/keep the claim in sync as charges accrue.
    if (INSURANCE_CATEGORIES.has((a.billingCategory ?? '').toLowerCase())) {
      try { await ensureAdmissionTpaLink(tenantId, userId, a.id); } catch { /* non-fatal */ }
    }
    const bills = await prisma.bill.findMany({
      where: { tenantId, admissionId: a.id, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, billNumber: true, status: true,
        totalAmount: true, amountPaid: true, balanceDue: true, discountAmount: true,
        insuranceCoveredAmount: true, patientPayableAmount: true,
        insuranceClaims: {
          select: {
            id: true, claimNumber: true, status: true, claimAmount: true, approvedAmount: true,
            coveredAmount: true, patientShare: true, paidAmount: true, outstandingAmount: true,
            policy: { select: { policyNumber: true, insurer: { select: { name: true } }, tpa: { select: { name: true } } } },
          },
          orderBy: { createdAt: 'desc' }, take: 1,
        },
      },
    });
    // The row stands for the STAY, so it must name the stay's own bill. Picking
    // the first open bill of any kind handed one admission a `RUN-CM-` counter
    // bill instead — the desk was then shown the stay's balance against a
    // pharmacy-counter document. Prefer the IP bill; fall back only if there
    // genuinely is not one.
    const isOpen = (b: (typeof bills)[number]) => ['draft', 'pending', 'partially_paid'].includes(b.status);
    const primary =
      bills.find((b) => isOpen(b) && b.billNumber.startsWith('IPW-')) ??
      bills.find(isOpen) ??
      bills[bills.length - 1] ??
      null;
    const claim = bills.map((b) => b.insuranceClaims?.[0]).find(Boolean) ?? null;
    const totalAmount = r2(bills.reduce((s, b) => s + Number(b.totalAmount), 0));
    const amountPaid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
    const balanceDue = r2(bills.reduce((s, b) => s + Number(b.balanceDue), 0));
    const insuranceCovered = r2(bills.reduce((s, b) => s + Number(b.insuranceCoveredAmount ?? 0), 0));
    const patientPayable = r2(bills.reduce((s, b) => s + Number(b.patientPayableAmount ?? 0), 0));
    const discountAmount = r2(bills.reduce((s, b) => s + Number(b.discountAmount ?? 0), 0));

    // Same two pools as the ledger. The IP billing list showed ₹0 deposit for a
    // patient the desk had just taken ₹10,000 from, because the advance the
    // desk collects into was not counted here either.
    const dep = await getAdmissionDepositState(tenantId, a.id);
    const deposit = r2(dep.onFile + (advanceByPatient.get(a.patientId) ?? 0));
    const netPatientObligation = r2(Math.max(0, totalAmount - insuranceCovered));
    const moneyFromPatient = moneyHeldFromPatient(amountPaid, deposit, dep.applied);
    const balanceAfterDeposit = r2(Math.max(0, netPatientObligation - moneyFromPatient));
    const refundable = r2(Math.min(Math.max(0, moneyFromPatient - netPatientObligation), Math.max(0, deposit - dep.refunded)));

    rows.push({
      id: primary?.id ?? a.id,
      billNumber: primary?.billNumber ?? '—',
      status: primary?.status ?? 'draft',
      admissionId: a.id,
      totalAmount,
      amountPaid,
      balanceDue,
      // What the counter can actually collect against the bill this row NAMES.
      //
      // The figures above are the whole stay, summed over every bill on the
      // admission, while `id` is only the primary one — so handing `balanceDue`
      // to the collect dialog asked the payment endpoint to take 282780.30
      // against a bill holding 1958.50, and it refused. The stay is one IP bill
      // again, but a pharmacy or counter bill can still sit on the same
      // admission, so the payable figure is stated explicitly rather than left
      // to coincide.
      payableNow: r2(Number(primary?.balanceDue ?? 0)),
      insuranceCoveredAmount: insuranceCovered,
      patientPayableAmount: patientPayable,
      discountAmount,
      patient: a.patient,
      admission: {
        id: a.id,
        billingCategory: a.billingCategory,
        status: a.status,
        ward: a.ward,
        bed: a.bed,
        depositAmount: deposit,
        admissionDate: a.admissionDate ? a.admissionDate.toISOString() : null,
        dischargeDate: a.dischargeDate ? a.dischargeDate.toISOString() : null,
        admissionType: typeById.get(a.id) ?? 'ip',
        // Doctor has signed off; the patient is still in the bed and the counter
        // owes them a bill clearance + discharge.
        dischargeReady: a.status === 'ready_to_discharge',
      },
      insuranceClaims: claim ? [claim] : [],
      deposit: {
        onFile: deposit,
        applied: dep.applied,
        refunded: dep.refunded,
        available: dep.availableToApply,
        refundable,
        balanceAfterDeposit,
      },
    });
  }
  return rows;
}

/**
 * A doctor records a visit / review round on the admission. This is BOTH a
 * ledger event (a consultation charge — the visit fee, which may be 0 for a
 * no-charge review) AND a timeline entry: the review/situation note is kept in
 * the line description and the item is tagged `doctor_visit` so the activity log
 * renders it as a visit rather than a generic charge.
 */
export async function recordDoctorVisit(
  tenantId: string,
  userId: string,
  admissionId: string,
  data: { review?: string },
  roles: string[] = [],
) {
  await assertIpLedgerAccess(tenantId, admissionId, { userId, roles }, { write: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // The visit fee is decided by the hospital admin (the doctor's configured
  // consultationFee) — NOT entered at visit time. Prefer the visiting doctor's
  // fee; fall back to the admission's treating doctor's; else 0 (visit still
  // logged, no charge).
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { doctorId: true } });
  const actorDoc = await prisma.doctorProfile.findFirst({ where: { userId, tenantId }, select: { consultationFee: true } });
  let fee = Number(actorDoc?.consultationFee ?? 0);
  if (!(fee > 0) && admission?.doctorId) {
    const admDoc = await prisma.doctorProfile.findFirst({ where: { id: admission.doctorId, tenantId }, select: { consultationFee: true } });
    fee = Number(admDoc?.consultationFee ?? 0);
  }
  fee = r2(Math.max(0, fee));

  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const review = (data.review ?? '').trim();
  const visitResolver = await taxResolverFor(tenantId, bill.billDate ?? new Date());
  const visitTax = visitResolver.price(
    { kind: 'consultation', sacCode: '999312', patientAdmitted: true, issuedForTreatment: true },
    { unitPrice: fee, quantity: 1 },
  );

  const item = await prisma.billItem.create({
    data: {
      billId: bill.id,
      description: review ? `Doctor visit — ${review}` : 'Doctor visit',
      category: 'consultation' as any,
      quantity: 1,
      unitPrice: fee,
      // Exempt because a doctor's visit is a healthcare service, not because a
      // zero was typed here. Same answer, but now it carries its code and lands
      // in the exempt-turnover figure.
      ...billItemTaxFields(visitTax),
      referenceType: 'doctor_visit',
      referenceId: `${userId}:${Date.now()}`,
      isAutoPulled: false,
    },
  });
  await recalculateBillTotals(bill.id);
  logger.info({ tenantId, admissionId, billId: bill.id, fee }, 'IP doctor visit recorded');
  return { billId: bill.id, item, fee };
}

/**
 * A detailed chronological log of everything that happens on an admission —
 * from admit to discharge — for the same care team that can see the ledger.
 * Aggregates admission/discharge, nurse assignments, doctor visits, ledger
 * charges, lab orders, imaging requests and prescriptions into one timeline.
 */
export async function getAdmissionActivity(tenantId: string, admissionId: string, actor: { userId: string; roles: string[] }) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: false });

  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: {
      id: true, patientId: true, admissionDate: true, dischargeDate: true, status: true,
      admissionReason: true, depositAmount: true, billingCategory: true,
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
    },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const start = admission.admissionDate;
  const end = admission.dischargeDate ?? new Date();
  const patientWindow = { patientId: admission.patientId, tenantId, createdAt: { gte: start, lte: end } };
  const money = (n: number) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;
  const drName = (u?: { firstName: string; lastName: string | null } | null) => (u ? `Dr. ${u.firstName} ${u.lastName ?? ''}`.trim() : undefined);
  const name = (u?: { firstName: string; lastName: string | null } | null) => (u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : undefined);

  type Event = { at: string; type: string; title: string; detail?: string; actor?: string; amount?: number; status?: string; meta?: Record<string, string> };
  const events: Event[] = [];

  // --- Admission ---
  events.push({
    at: admission.admissionDate.toISOString(), type: 'admission', title: 'Patient admitted',
    detail: admission.admissionReason || undefined,
    actor: drName(admission.doctor?.user),
    meta: {
      ...(admission.ward?.name ? { Ward: admission.ward.name } : {}),
      ...(admission.bed?.bedNumber ? { Bed: admission.bed.bedNumber } : {}),
      Billing: (admission.billingCategory ?? 'cash').toLowerCase(),
      ...(Number(admission.depositAmount) > 0 ? { Deposit: money(Number(admission.depositAmount)) } : {}),
    },
  });

  // --- Nurse assignments ---
  const assignments = await prisma.nurseAssignment.findMany({
    where: { tenantId, admissionId },
    select: { assignedAt: true, shiftType: true, status: true, nurse: { select: { firstName: true, lastName: true } } },
    orderBy: { assignedAt: 'asc' },
  });
  for (const a of assignments) {
    events.push({
      at: a.assignedAt.toISOString(), type: 'nurse_assignment',
      title: a.status === 'active' ? 'Nurse assigned' : 'Nurse assignment ended',
      actor: name(a.nurse),
      meta: { Shift: String(a.shiftType), Status: String(a.status) },
    });
  }

  // --- Vitals recorded (nurse) ---
  const vitals = await prisma.vital.findMany({
    where: { patientId: admission.patientId, recordedAt: { gte: start, lte: end } },
    select: {
      recordedAt: true, bloodPressureSystolic: true, bloodPressureDiastolic: true, pulseRate: true,
      temperature: true, respiratoryRate: true, oxygenSaturation: true, recorder: { select: { firstName: true, lastName: true } },
    },
    orderBy: { recordedAt: 'asc' },
  }).catch(() => []);
  for (const v of vitals as any[]) {
    const parts = [
      v.bloodPressureSystolic && v.bloodPressureDiastolic ? `BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}` : null,
      v.pulseRate ? `Pulse ${v.pulseRate}` : null,
      v.temperature != null ? `Temp ${Number(v.temperature)}°` : null,
      v.respiratoryRate ? `RR ${v.respiratoryRate}` : null,
      v.oxygenSaturation ? `SpO₂ ${v.oxygenSaturation}%` : null,
    ].filter(Boolean);
    events.push({
      at: v.recordedAt.toISOString(), type: 'vitals', title: 'Vitals recorded',
      detail: parts.length ? parts.join(' · ') : undefined,
      actor: name(v.recorder),
    });
  }

  // --- Progress notes (doctor) ---
  const notes = await prisma.progressNote.findMany({
    where: { admissionId },
    select: { createdAt: true, noteType: true, content: true, doctor: { select: { user: { select: { firstName: true, lastName: true } } } } },
    orderBy: { createdAt: 'asc' },
  }).catch(() => []);
  for (const n of notes as any[]) {
    const snip = (n.content ?? '').replace(/\s+/g, ' ').trim();
    events.push({
      at: n.createdAt.toISOString(), type: 'progress_note', title: 'Progress note',
      detail: snip ? (snip.length > 180 ? `${snip.slice(0, 180)}…` : snip) : undefined,
      actor: drName(n.doctor?.user),
      ...(n.noteType ? { meta: { Type: String(n.noteType) } } : {}),
    });
  }

  // --- Ledger charges + doctor visits (from the admission's bills) ---
  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    select: { billItems: { select: { description: true, category: true, quantity: true, unitPrice: true, totalAmount: true, referenceType: true, referenceId: true, createdAt: true } } },
  });
  const items = bills.flatMap((b) => b.billItems);
  const clinicianIds = [...new Set(
    items.filter((it) => it.referenceType === 'doctor_visit' || it.referenceType === 'manual_clinical')
      .map((it) => it.referenceId?.split(':')[0]).filter(Boolean) as string[],
  )];
  const clinicians = clinicianIds.length
    ? await prisma.user.findMany({ where: { id: { in: clinicianIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const clinicianName = new Map(clinicians.map((u) => [u.id, fullName(u)]));
  for (const it of items) {
    if (it.referenceType === 'doctor_visit') {
      const who = clinicianName.get(it.referenceId?.split(':')[0] ?? '');
      events.push({
        at: it.createdAt.toISOString(), type: 'doctor_visit', title: 'Doctor visit',
        detail: it.description.replace(/^Doctor visit\s*—\s*/, '') || 'Reviewed patient',
        actor: who ? `Dr. ${who}` : undefined,
        amount: Number(it.totalAmount) || undefined,
      });
    } else if (it.referenceType === 'manual_clinical') {
      events.push({
        at: it.createdAt.toISOString(), type: 'charge', title: 'Charge added',
        detail: it.description,
        actor: clinicianName.get(it.referenceId?.split(':')[0] ?? '') || undefined,
        amount: Number(it.totalAmount),
        meta: { Category: String(it.category), Qty: String(it.quantity), 'Unit price': money(Number(it.unitPrice)) },
      });
    }
  }

  // --- Lab orders ---
  const labs = await prisma.labOrder.findMany({
    where: patientWindow,
    select: {
      status: true, urgency: true, createdAt: true,
      labOrderItems: { select: { test: { select: { testName: true } } } },
      orderer: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const l of labs) {
    const names = l.labOrderItems.map((i) => i.test?.testName).filter(Boolean) as string[];
    events.push({
      at: l.createdAt.toISOString(), type: 'lab_order', title: `Lab ordered (${names.length} test${names.length === 1 ? '' : 's'})`,
      detail: names.length ? names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6} more` : '') : undefined,
      actor: drName(l.orderer),
      status: String(l.status),
      meta: { Urgency: String(l.urgency) },
    });
  }

  // --- Imaging requests ---
  const imaging = await prisma.imagingRequest.findMany({
    where: patientWindow,
    select: { imagingType: true, bodyPart: true, urgency: true, status: true, createdAt: true, orderer: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const im of imaging) {
    events.push({
      at: im.createdAt.toISOString(), type: 'imaging_request', title: 'Imaging requested',
      detail: [String(im.imagingType), im.bodyPart].filter(Boolean).join(' — '),
      actor: drName(im.orderer),
      status: String(im.status),
      meta: { Urgency: String(im.urgency) },
    });
  }

  // --- Prescriptions ---
  const scripts = await prisma.prescription.findMany({
    where: patientWindow,
    select: {
      prescriptionType: true, status: true, createdAt: true,
      prescriptionItems: { select: { drugName: true } },
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const s of scripts) {
    const drugs = s.prescriptionItems.map((i) => i.drugName).filter(Boolean);
    events.push({
      at: s.createdAt.toISOString(), type: 'prescription',
      title: `Prescription written (${drugs.length} medicine${drugs.length === 1 ? '' : 's'})`,
      detail: drugs.length ? drugs.slice(0, 6).join(', ') + (drugs.length > 6 ? ` +${drugs.length - 6} more` : '') : undefined,
      actor: drName(s.doctor?.user),
      status: String(s.status),
      meta: { Type: String(s.prescriptionType) },
    });
  }

  // --- Payments / deposits ---
  const payments = await prisma.payment.findMany({
    where: { patientId: admission.patientId, tenantId, paymentDate: { gte: start, lte: end }, status: { not: 'failed' } },
    select: { paymentDate: true, amount: true, paymentMethod: true, paymentType: true, status: true, processor: { select: { firstName: true, lastName: true } } },
    orderBy: { paymentDate: 'asc' },
  }).catch(() => []);
  for (const p of payments as any[]) {
    events.push({
      at: p.paymentDate.toISOString(), type: 'payment',
      title: p.paymentType === 'advance' ? 'Advance / deposit paid' : 'Payment received',
      actor: name(p.processor),
      amount: Number(p.amount),
      status: String(p.status),
      meta: { Method: String(p.paymentMethod), Type: String(p.paymentType) },
    });
  }

  // --- Discharge ---
  if (admission.dischargeDate) {
    events.push({
      at: admission.dischargeDate.toISOString(), type: 'discharge', title: 'Patient discharged',
      meta: { Status: String(admission.status) },
    });
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return {
    admissionId, status: admission.status, discharged: !!admission.dischargeDate,
    admittedAt: admission.admissionDate.toISOString(),
    dischargedAt: admission.dischargeDate?.toISOString() ?? null,
    count: events.length,
    events,
  };
}

// --- Bill-level discount (single value, editable) ---

export async function setBillDiscount(
  tenantId: string,
  billId: string,
  data: {
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    reason?: string;
    approvedBy?: string;
  },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { billItems: true },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft' && bill.status !== 'pending' && bill.status !== 'partially_paid') {
    throw AppError.badRequest('Discount can only be applied to draft, pending or partially-paid bills');
  }

  const subtotal = bill.billItems.reduce(
    (sum, it) => sum + it.quantity * toNumber(it.unitPrice),
    0,
  );
  const itemDiscounts = bill.billItems.reduce(
    (sum, it) => sum + toNumber(it.discountAmount),
    0,
  );
  let billDiscountAmt = 0;
  if (data.discountType === 'percentage') {
    if (data.discountValue < 0 || data.discountValue > 100) {
      throw AppError.badRequest('Percentage discount must be between 0 and 100');
    }
    billDiscountAmt = (subtotal - itemDiscounts) * (data.discountValue / 100);
  } else {
    if (data.discountValue < 0) throw AppError.badRequest('Discount cannot be negative');
    billDiscountAmt = Math.min(data.discountValue, subtotal - itemDiscounts);
  }

  const totalDiscount = itemDiscounts + billDiscountAmt;

  // Does this concession need a second pair of eyes? Measured against the bill's
  // net before it, so a percentage limit means what a person would expect.
  const approvalPolicy = await getDiscountApprovalSettings(tenantId);
  const needsApproval = discountNeedsApproval(
    approvalPolicy,
    billDiscountAmt,
    subtotal - itemDiscounts,
  );

  // Remove any prior bill-level discount rows (keep an audit row).
  await prisma.discount.deleteMany({ where: { billId } });
  if (data.discountValue > 0) {
    await prisma.discount.create({
      data: {
        tenantId,
        billId,
        discountType: data.discountType as any,
        value: billDiscountAmt,
        reason: data.reason,
        // A concession over the limit is a REQUEST: it is recorded, it is
        // visible, and it changes nothing the patient owes until someone with
        // billing:approve decides on it. Under the limit — or with the gate
        // switched off — it applies immediately, as it always has.
        status: needsApproval ? 'pending' : 'approved',
        requestedBy: data.approvedBy,
        approvedBy: needsApproval ? null : data.approvedBy,
        decidedAt: needsApproval ? null : new Date(),
      },
    });
  }

  // Totals come from the one definition rather than being recomputed here. The
  // old arithmetic — `subtotal − discount + tax` — is only right when every
  // line adds its tax on top, so discounting a bill that carried a
  // tax-INCLUSIVE medicine price re-added the GST already inside the MRP.
  await recalculateBillTotals(billId);
  await creditPostSupplyConcession(tenantId, billId, {
    issuedBy: data.approvedBy,
    note: data.reason,
  });
  const updated = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
  const totalAmount = toNumber(updated.totalAmount);

  logger.info(
    { tenantId, billId, billDiscountAmt, needsApproval },
    needsApproval ? 'Bill-level discount awaiting approval' : 'Bill-level discount applied',
  );
  void writeAudit({
    tenantId,
    userId: data.approvedBy,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description:
      `Concession on bill ${bill.billNumber}: ` +
      `${data.discountType === 'percentage' ? `${data.discountValue}%` : `₹${data.discountValue}`} ` +
      `(₹${r2(billDiscountAmt)} off)` +
      (needsApproval ? ' — over the limit, awaiting approval' : ''),
    reason: data.reason,
    oldValues: {
      discountAmount: toNumber(bill.discountAmount),
      totalAmount: toNumber(bill.totalAmount),
    },
    newValues: {
      discountAmount: r2(totalDiscount),
      totalAmount: r2(totalAmount),
      discountType: data.discountType,
      discountValue: data.discountValue,
      status: needsApproval ? 'pending' : 'approved',
    },
  });
  // The caller needs to know whether the money actually came off, so the
  // counter can say "sent for approval" rather than implying it is done.
  return Object.assign(updated, { discountPendingApproval: needsApproval });
}

// --- Split Payment (multiple modes against one bill) ---

export async function createSplitPayment(
  tenantId: string,
  userId: string,
  data: {
    billId: string;
    splits: Array<{
      amount: number;
      paymentMethod: string;
      referenceNumber?: string;
      notes?: string;
    }>;
  },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'draft') {
    throw AppError.badRequest('Cannot pay a draft bill — finalize first');
  }
  if (bill.status === 'paid') {
    throw AppError.badRequest('Bill is already fully paid');
  }
  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Cannot pay a cancelled bill');
  }

  const totalSplit = data.splits.reduce((s, x) => s + x.amount, 0);
  const balanceDue = toNumber(bill.balanceDue);
  if (totalSplit <= 0) throw AppError.badRequest('Split total must be > 0');
  if (totalSplit > balanceDue) {
    throw AppError.badRequest(
      `Split total (${totalSplit}) exceeds balance due (${balanceDue})`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const payments = [] as { id: string; receiptId: string; amount: number; method: string }[];
    for (const split of data.splits) {
      // Pass `tx` so each split's number reflects the ones created earlier in
      // THIS transaction (otherwise every split collides on the same number).
      const receiptNumber = await generateReceiptNumber(tenantId, tx);
      const payment = await tx.payment.create({
        data: {
          tenantId,
          billId: data.billId,
          patientId: bill.patientId,
          amount: split.amount,
          paymentMethod: mapPaymentMethod(split.paymentMethod) as any,
          paymentSource: 'frontdesk',
          paymentType: 'regular',
          transactionId: split.referenceNumber,
          notes: split.notes,
          status: 'completed',
          paymentDate: new Date(),
          processedBy: userId,
        },
      });
      const receipt = await tx.receipt.create({
        data: {
          tenantId,
          receiptNumber,
          paymentId: payment.id,
          receiptDate: new Date(),
          amount: split.amount,
        },
      });
      payments.push({ id: payment.id, receiptId: receipt.id, amount: split.amount, method: split.paymentMethod });
    }

    const settled = await applyPaymentToBill(tx, data.billId);

    return {
      payments,
      totalCollected: totalSplit,
      newBalance: toNumber(settled.balanceDue),
    };
  });

  logger.info({ tenantId, billId: data.billId, totalCollected: totalSplit }, 'Split payment recorded');
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'payment',
    entityId: result.payments[0]?.id ?? data.billId,
    description:
      `₹${totalSplit} collected on bill ${bill.billNumber} across ${data.splits.length} modes ` +
      `(${data.splits.map((s) => `${s.paymentMethod.replace(/_/g, ' ')} ₹${s.amount}`).join(', ')})`,
    newValues: {
      billId: data.billId,
      totalCollected: totalSplit,
      splits: data.splits.map((s) => ({ amount: s.amount, paymentMethod: s.paymentMethod })),
      paymentIds: result.payments.map((p) => p.id),
    },
  });
  return result;
}

// --- Advance Payment + Running Balance ---

/**
 * Advance: collect money from a patient *before* a bill exists. Stored as a
 * Payment row with paymentType='advance' against a sentinel "advance" bill
 * per-tenant so we can use the existing Bill/Receipt machinery for audit.
 *
 * The running balance is "advances minus advances-already-adjusted" — we
 * don't materialize that as a column on the patient; we compute it on the
 * fly from the Payment ledger.
 */
async function ensureAdvanceBucketBill(
  tx: typeof prisma,
  tenantId: string,
  patientId: string,
) {
  let bucket = await tx.bill.findFirst({
    where: {
      tenantId,
      patientId,
      billNumber: { startsWith: 'ADV-' },
    },
  });
  if (!bucket) {
    const billNumber = `ADV-${patientId.slice(0, 8)}-${Date.now()}`;
    bucket = await tx.bill.create({
      data: {
        tenantId,
        billNumber,
        patientId,
        billDate: new Date(),
        status: 'pending',
        subtotal: 0,
        totalAmount: 0,
        balanceDue: 0,
        amountPaid: 0,
      },
    });
  }
  return bucket;
}

export async function createAdvancePayment(
  tenantId: string,
  userId: string,
  data: {
    patientId: string;
    amount: number;
    paymentMethod: string;
    referenceNumber?: string;
    notes?: string;
    /**
     * What the money is against. Decides whether any tax is due AT RECEIPT —
     * for a service the time of supply is the earlier of invoice or payment.
     * Defaults to treatment, which is the ordinary hospital deposit and exempt.
     */
    purpose?: AdvancePurpose;
    /** Only consulted when the purpose is a taxable one. */
    taxRatePercent?: number;
  },
) {
  if (data.amount <= 0) throw AppError.badRequest('Amount must be > 0');
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const receiptNumber = await generateReceiptNumber(tenantId);
  const gstProfile = await getGstProfile(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const bucket = await ensureAdvanceBucketBill(tx as any, tenantId, data.patientId);
    // An advance is the one place tax can be due before an invoice exists.
    // Usually exempt for a hospital — a deposit is against treatment — but the
    // position is RECORDED rather than assumed, because it is what the advances
    // report and GSTR-1 table 11 read.
    const advanceTax = await advancePaymentTaxFields(tx, tenantId, gstProfile, {
      amount: data.amount,
      purpose: data.purpose,
      ratePercent: data.taxRatePercent ?? null,
    });
    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: bucket.id,
        patientId: data.patientId,
        amount: data.amount,
        paymentMethod: mapPaymentMethod(data.paymentMethod) as any,
        paymentSource: 'frontdesk',
        paymentType: 'advance',
        transactionId: data.referenceNumber,
        notes: data.notes ?? 'Advance payment',
        status: 'completed',
        paymentDate: new Date(),
        processedBy: userId,
        ...advanceTax,
      },
    });
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    // Lift the bucket totals so subsequent advance reads can compute the
    // running balance from the same row.
    await tx.bill.update({
      where: { id: bucket.id },
      data: {
        totalAmount: toNumber(bucket.totalAmount) + data.amount,
        amountPaid: toNumber(bucket.amountPaid) + data.amount,
      },
    });

    return { paymentId: payment.id, receiptId: receipt.id, receiptNumber };
  });

  logger.info({ tenantId, patientId: data.patientId, amount: data.amount }, 'Advance payment recorded');
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'payment',
    entityId: result.paymentId,
    description:
      `Advance of ₹${data.amount} collected from ${fullName(patient)} ` +
      `by ${data.paymentMethod.replace(/_/g, ' ')} — receipt ${result.receiptNumber}`,
    newValues: {
      patientId: data.patientId,
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      paymentType: 'advance',
      receiptNumber: result.receiptNumber,
    },
  });
  return result;
}

/**
 * Adjust an advance against a specific bill — moves money from the advance
 * bucket to the target bill. Used by the cashier when collecting a new bill
 * and the patient already has advance on file.
 */
export async function adjustAdvanceToBill(
  tenantId: string,
  userId: string,
  data: { patientId: string; billId: string; amount: number },
) {
  if (data.amount <= 0) throw AppError.badRequest('Amount must be > 0');
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId, patientId: data.patientId },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'draft') {
    // The running IP bill is a draft for the whole stay while charges accrue —
    // it has to be consolidated and finalized before money can be set against
    // it. "Bill cannot accept payment (status: draft)" told the desk nothing
    // they could act on, and this is the 400 QA hit on every "From advance".
    throw AppError.badRequest(
      'This bill is still open for charges. Generate / refresh the bill first — that pulls the pending charges on and finalizes it for payment.',
    );
  }
  if (bill.status === 'cancelled' || bill.status === 'paid') {
    throw AppError.badRequest(`Bill cannot accept payment (status: ${bill.status})`);
  }

  // Never let more be taken off the advance than the bill actually owes. The
  // bill's balance is floored at zero below, so an over-sized adjustment used
  // to mark the bill paid, drain the full amount from the advance bucket, and
  // silently lose the difference — ₹2000 against a ₹500 bill cost the patient
  // ₹1500 of their own money.
  const billBalance = toNumber(bill.balanceDue);
  if (data.amount > billBalance) {
    throw AppError.badRequest(`Bill balance is ${billBalance}, cannot adjust ${data.amount}`);
  }

  const advance = await getPatientAdvanceBalance(tenantId, data.patientId);
  if (data.amount > advance.balance) {
    throw AppError.badRequest(`Advance balance is ${advance.balance}, cannot adjust ${data.amount}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    // Re-read the bucket inside the transaction and check it again. The
    // balance above is read outside, so two counters adjusting the same
    // advance at once could both pass it and between them draw out more than
    // the patient ever deposited.
    const bucket = await tx.bill.findFirst({
      where: { tenantId, patientId: data.patientId, billNumber: { startsWith: 'ADV-' } },
    });
    const available = bucket ? toNumber(bucket.amountPaid) : 0;
    if (data.amount > available) {
      throw AppError.badRequest(`Advance balance is ${available}, cannot adjust ${data.amount}`);
    }

    // Mark a "regular" payment on the bill, source=advance via notes, and
    // contra-entry on the advance bucket as a refund row so the running
    // balance falls correctly.
    const receiptNumber = await generateReceiptNumber(tenantId);

    // Which advance receipt this draws down. GSTR-1 table 11B reports the
    // adjustment of advances against invoices, and until now the only thing
    // connecting the two was the note "Adjusted from advance" — a string, which
    // no report can follow back to the money it came out of.
    //
    // Oldest first, matching how the bucket is drawn down everywhere else.
    const sourceAdvance = await tx.payment.findFirst({
      where: {
        tenantId,
        billId: bucket!.id,
        patientId: data.patientId,
        paymentType: 'advance' as never,
        status: 'completed',
      },
      orderBy: { paymentDate: 'asc' },
      select: { id: true },
    });

    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: data.billId,
        patientId: data.patientId,
        amount: data.amount,
        paymentMethod: 'other',
        paymentSource: 'frontdesk',
        paymentType: 'regular',
        notes: 'Adjusted from advance',
        status: 'completed',
        paymentDate: new Date(),
        processedBy: userId,
        sourceAdvancePaymentId: sourceAdvance?.id ?? null,
      },
    });
    await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    // Lift bill totals from the ledger the payment above just joined.
    const settled = await applyPaymentToBill(tx, data.billId);
    const newBalance = toNumber(settled.balanceDue);

    // Reduce advance bucket
    if (bucket) {
      await tx.bill.update({
        where: { id: bucket.id },
        data: {
          amountPaid: Math.max(0, toNumber(bucket.amountPaid) - data.amount),
          totalAmount: Math.max(0, toNumber(bucket.totalAmount) - data.amount),
        },
      });
    }

    return { paymentId: payment.id, receiptNumber, newBalance: Math.max(0, newBalance) };
  });

  logger.info({ tenantId, patientId: data.patientId, billId: data.billId, amount: data.amount }, 'Advance adjusted to bill');
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'payment',
    entityId: result.paymentId,
    description:
      `₹${data.amount} moved from the patient's advance onto bill ${bill.billNumber} ` +
      `— receipt ${result.receiptNumber}`,
    newValues: {
      billId: data.billId,
      patientId: data.patientId,
      amount: data.amount,
      source: 'advance',
      receiptNumber: result.receiptNumber,
      billBalanceAfter: result.newBalance,
    },
  });
  return result;
}

export async function getPatientAdvanceBalance(tenantId: string, patientId: string) {
  // The bucket first, because it is what scopes everything below.
  const bucket = await prisma.bill.findFirst({
    where: { tenantId, patientId, billNumber: { startsWith: 'ADV-' } },
  });

  // Advance RECEIPTS only — the rows that sit on the ADV- bucket.
  //
  // `paymentType: 'advance'` is not enough on its own to identify one. Applying
  // a stay deposit to an IP bill writes an advance-typed row onto THAT BILL,
  // and so does reversing one, so a patient whose Rs 20,000 admission deposit
  // had been applied read back as having advanced Rs 20,000 at the desk on top
  // of whatever they actually handed over. The balance itself was always right
  // — it is read from the bucket — but "collected" and "adjusted" were not, and
  // those are the two figures an advances report prints.
  const advances = bucket
    ? await prisma.payment.findMany({
        where: {
          tenantId,
          patientId,
          billId: bucket.id,
          paymentType: 'advance' as any,
          status: 'completed',
          // An admission deposit's RECEIPT also lives on this bucket, but it is
          // counted on the admission, not here. Left in, a stay deposit would
          // be reported as desk advance money as well — the same double count
          // this query was just fixed for, arriving from the other direction.
          //
          // Null-safe: a cash advance taken without a reference number has no
          // transactionId at all, and `NOT (col LIKE ...)` is NULL rather than
          // true for those rows — so the plain spelling dropped every ordinary
          // desk advance, leaving `collected` at 0 and `adjusted` negative.
          ...notStartingWith('transactionId', DEPOSIT_RECEIPT_TXN_PREFIX),
        },
      })
    : [];
  const collected = advances.reduce((s, p) => s + toNumber(p.amount), 0);

  const remaining = bucket ? toNumber(bucket.amountPaid) : 0;

  return {
    totalAdvanceCollected: collected,
    totalAdvanceAdjusted: collected - remaining,
    balance: remaining,
    history: advances.map((p) => ({
      id: p.id,
      amount: toNumber(p.amount),
      method: p.paymentMethod,
      paymentDate: p.paymentDate,
      notes: p.notes,
    })),
  };
}

// --- Payment Reversal ---

export async function reversePayment(
  tenantId: string,
  userId: string,
  data: { paymentId: string; reason: string },
) {
  const payment = await prisma.payment.findFirst({
    where: { id: data.paymentId, tenantId },
    include: { bill: true, receipt: true },
  });
  if (!payment) throw AppError.notFound('Payment not found');
  if (payment.status === 'reversed') {
    throw AppError.badRequest('Payment already reversed');
  }
  if (payment.status !== 'completed') {
    throw AppError.badRequest('Only completed payments can be reversed');
  }

  // A payment that has already been refunded in part cannot also be reversed.
  //
  // Reversal says the payment never happened, but a refund means money
  // physically went back across the counter — both at once is incoherent, and
  // the arithmetic showed it: reversal drops the payment out of the collected
  // sum while the approved Refund is still subtracted, so the same money comes
  // off twice. A ₹2,000 bill refunded ₹500 and then reversed read as ₹500
  // COLLECTED and ₹2,500 due on a ₹2,000 bill.
  const refunded = await prisma.refund.aggregate({
    where: { paymentId: data.paymentId, status: { in: ['approved', 'processed'] as any } },
    _sum: { amount: true },
  });
  const refundedAmount = toNumber(refunded._sum.amount);
  if (refundedAmount > 0) {
    throw AppError.badRequest(
      `₹${refundedAmount} has already been refunded against this payment, so it cannot also be ` +
        `reversed. Refund the remainder instead.`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: data.paymentId },
      data: {
        status: 'reversed',
        notes: payment.notes
          ? `${payment.notes}\n[REVERSED ${new Date().toISOString()} by ${userId}: ${data.reason}]`
          : `[REVERSED by ${userId}: ${data.reason}]`,
      },
    });

    // Adjust the bill back from its own ledger. This was the last place still
    // subtracting from a figure read before the transaction opened — the same
    // stale-read that let two concurrent counter payments lose one of them.
    // The payment is now `reversed`, so it drops out of the completed sum on
    // its own and the recompute lands exactly where the hand arithmetic did:
    // nothing left paid reads as pending, an open balance as partially paid.
    if (payment.bill) {
      await applyPaymentToBill(tx, payment.bill.id);
    }

    return { reversed: true, paymentId: payment.id };
  });

  logger.info({ tenantId, paymentId: data.paymentId, by: userId }, 'Payment reversed');
  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'payment',
    entityId: payment.id,
    description:
      `Payment of ₹${toNumber(payment.amount)} reversed` +
      (payment.bill ? ` on bill ${payment.bill.billNumber}` : ''),
    reason: data.reason,
    oldValues: { status: 'completed', amount: toNumber(payment.amount) },
    newValues: { status: 'reversed' },
  });
  return result;
}

// --- Bill Cancellation ---

/**
 * Settle the consultation charge behind an appointment that is being cancelled.
 *
 * Cancelling an appointment used to be a pure status change: the fee bill it
 * had raised was left standing. Rebooking then minted a SECOND bill, because
 * `ensureAppointmentBill` keys off the appointment id and the new appointment
 * is a new row — so a patient who paid ₹600, cancelled and rebooked showed
 * ₹1,200 at the Cash Counter for one consultation.
 *
 * An appointment can only be cancelled before `in_consultation`, so the
 * consultation demonstrably never happened and the money cannot be earned:
 *
 *   - nothing collected → cancel the bill. There is no charge to answer for.
 *   - money collected  → reverse the payment off the bill and put the same sum
 *     on the patient's advance, then cancel the bill. No cash moves (the two
 *     rows net to zero in the drawer) and the patient keeps their money as a
 *     credit, which the counter's existing "From advance" option settles the
 *     rebooked consultation from.
 *
 * Best-effort by design — the caller treats a failure as non-fatal. A booking
 * that cannot be cancelled because its money could not be tidied up would be a
 * worse outcome than a bill needing a manual look.
 */
export async function settleCancelledAppointmentCharge(
  tenantId: string,
  userId: string,
  appointmentId: string,
  reason: string,
): Promise<{ cancelledBillId: string | null; creditedToAdvance: number }> {
  const bill = await prisma.bill.findFirst({
    where: {
      tenantId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointmentId } },
      status: { notIn: ['cancelled', 'refunded'] },
    },
    include: { payments: { where: { status: 'completed' } } },
  });
  if (!bill) return { cancelledBillId: null, creditedToAdvance: 0 };

  // Only rows that actually brought money in. A refund payout or an advance
  // adjustment is not something to hand back again.
  const collected = bill.payments.filter((p) => p.paymentType !== 'refund');
  const collectedTotal = r2(collected.reduce((sum, p) => sum + toNumber(p.amount), 0));

  for (const payment of collected) {
    await reversePayment(tenantId, userId, {
      paymentId: payment.id,
      reason: `Appointment cancelled — ${reason}`,
    });
  }

  if (collectedTotal > 0) {
    await createAdvancePayment(tenantId, userId, {
      patientId: bill.patientId,
      amount: collectedTotal,
      // Not a fresh collection — the money is already in the drawer. Mirrors
      // the method so the day-end split is not distorted.
      paymentMethod: collected[0]?.paymentMethod ?? 'cash',
      notes:
        `Consultation fee carried forward from cancelled appointment ` +
        `(bill ${bill.billNumber}) — available against the next booking`,
    });
  }

  await cancelBill(tenantId, userId, bill.id, {
    reason: `Appointment cancelled — ${reason}`,
  });

  logger.info(
    { tenantId, appointmentId, billId: bill.id, creditedToAdvance: collectedTotal },
    'Cancelled appointment charge settled',
  );
  return { cancelledBillId: bill.id, creditedToAdvance: collectedTotal };
}

export async function cancelBill(
  tenantId: string,
  userId: string,
  billId: string,
  data: { reason: string },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { payments: { where: { status: 'completed' } } },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Bill already cancelled');
  }
  if (bill.status === 'refunded') {
    throw AppError.badRequest('Bill already refunded');
  }

  // If there are completed payments, the caller must refund them first.
  const completedPayments = bill.payments.length;
  if (completedPayments > 0) {
    throw AppError.badRequest(
      `Bill has ${completedPayments} completed payment(s) — refund or reverse them first`,
    );
  }

  const receiptNumber = await generateReceiptNumber(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.bill.update({
      where: { id: billId },
      data: {
        status: 'cancelled',
        cancelledBy: userId,
        cancellationReason: data.reason,
      },
    });

    // A cancelled bill's tax used to survive the cancellation: the header kept
    // its taxAmount and the lines kept theirs, so the hospital went on
    // declaring output tax on a supply that had been called off. Only a bill
    // that was actually ISSUED needs a credit note — a draft was never a
    // document and has nothing to reverse.
    if ((bill as any).invoiceNumber) {
      await issueCreditNoteBestEffort(tx, tenantId, {
        billId,
        reason: 'cancellation',
        reasonNote: data.reason,
        issuedBy: userId,
      });
    }

    // Cancellation receipt — zero amount, just an audit row tied to the bill
    // via a sentinel payment so downstream receipt listings can show it.
    const auditPayment = await tx.payment.create({
      data: {
        tenantId,
        billId,
        patientId: bill.patientId,
        amount: 0,
        paymentMethod: 'other',
        paymentSource: 'frontdesk',
        paymentType: 'regular',
        status: 'reversed',
        paymentDate: new Date(),
        processedBy: userId,
        notes: `Bill cancellation receipt — ${data.reason}`,
      },
    });
    await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: auditPayment.id,
        receiptDate: new Date(),
        amount: 0,
      },
    });

    return { cancelled: true, billId: cancelled.id, cancellationReceiptNumber: receiptNumber };
  });

  logger.info({ tenantId, billId, by: userId }, 'Bill cancelled');
  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description: `Bill ${bill.billNumber} cancelled (₹${toNumber(bill.totalAmount)}) — cancellation receipt ${receiptNumber}`,
    reason: data.reason,
    oldValues: { status: bill.status, totalAmount: toNumber(bill.totalAmount) },
    newValues: { status: 'cancelled', cancellationReceiptNumber: receiptNumber },
  });
  return result;
}

// --- Refund Reject + List + One ---

export async function rejectRefund(
  tenantId: string,
  refundId: string,
  rejectedBy: string,
  reason: string,
) {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, tenantId, status: 'requested' },
  });
  if (!refund) throw AppError.notFound('Refund not found or not in pending status');

  const updated = await prisma.refund.update({
    where: { id: refundId },
    data: {
      status: 'rejected',
      approvedBy: rejectedBy,
      processedAt: new Date(),
      reason: `${refund.reason}\n[REJECTED by ${rejectedBy}: ${reason}]`,
    },
  });
  logger.info({ tenantId, refundId, by: rejectedBy }, 'Refund rejected');
  void writeAudit({
    tenantId,
    userId: rejectedBy,
    action: 'update',
    entityType: 'refund',
    entityId: refundId,
    description: `Refund of ₹${toNumber(refund.amount)} rejected — no money paid out`,
    reason,
    oldValues: { status: 'requested' },
    newValues: { status: 'rejected' },
  });
  return updated;
}

export async function getRefunds(
  tenantId: string,
  query: { status?: string; patientId?: string; billId?: string; page?: number; limit?: number },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.billId) where.billId = query.billId;

  const [refunds, total] = await Promise.all([
    prisma.refund.findMany({
      where,
      skip,
      take,
      include: {
        bill: { select: { id: true, billNumber: true, totalAmount: true } },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        payment: { select: { id: true, paymentMethod: true, paymentDate: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.refund.count({ where }),
  ]);

  return { refunds, total, page, limit };
}

// --- Receipts (list + by-id for PDF) ---

export async function listReceipts(
  tenantId: string,
  query: { patientId?: string; billId?: string; fromDate?: string; toDate?: string; page?: number; limit?: number; search?: string },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);
  const where: any = { tenantId };
  if (query.fromDate) where.receiptDate = { ...where.receiptDate, gte: istDayStart(query.fromDate) };
  if (query.toDate) where.receiptDate = { ...where.receiptDate, lte: istDayEnd(query.toDate) };

  // Patient/bill filters require joining via payment
  const paymentFilter: any = {};
  if (query.patientId) paymentFilter.patientId = query.patientId;
  if (query.billId) paymentFilter.billId = query.billId;
  if (Object.keys(paymentFilter).length) where.payment = paymentFilter;

  if (query.search) {
    where.OR = [
      { receiptNumber: { contains: query.search, mode: 'insensitive' } },
      { payment: { bill: { billNumber: { contains: query.search, mode: 'insensitive' } } } },
    ];
  }

  const [receipts, total] = await Promise.all([
    prisma.receipt.findMany({
      where,
      skip,
      take,
      include: {
        payment: {
          include: {
            bill: { select: { id: true, billNumber: true, totalAmount: true } },
            patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
          },
        },
      },
      orderBy: { receiptDate: 'desc' },
    }),
    prisma.receipt.count({ where }),
  ]);

  return { receipts, total, page, limit };
}

export async function getReceiptById(tenantId: string, receiptId: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, tenantId },
    include: {
      payment: {
        include: {
          bill: {
            include: {
              patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
              billItems: true,
            },
          },
        },
      },
      tenant: { select: { name: true, address: true, city: true, phone: true, email: true, licenseNumber: true } },
    },
  });
  if (!receipt) throw AppError.notFound('Receipt not found');
  return receipt;
}

// --- Day-end snapshot ---

export async function getDayEndReport(tenantId: string, query: { date?: string }) {
  // `getISTDateStr()` returns the compact YYYYMMDD used for bill numbers, which
  // is not a parseable date literal — building the bounds by hand made the
  // no-argument call (a cron day-end job, a report, the mobile client) produce
  // an Invalid Date. istDayRange normalises both shapes.
  const dateStr = query.date ?? getISTDateStr();
  const { start, end } = istDayRange(dateStr);

  const payments = await prisma.payment.findMany({
    where: {
      tenantId,
      paymentDate: { gte: start, lte: end },
    },
    include: {
      bill: { select: { billNumber: true, patient: { select: { firstName: true, lastName: true } } } },
      // Who took (or handed back) the money — the counter runs on manual entry,
      // so the cashier is part of the record, not metadata.
      processor: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { paymentDate: 'asc' },
  });

  const billsToday = await prisma.bill.findMany({
    where: { tenantId, ...NOT_ADVANCE_BUCKET, createdAt: { gte: start, lte: end } },
    select: { id: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true },
  });

  const byStatusBills = { generated: 0, paid: 0, pending: 0, cancelled: 0 };
  let billed = 0;
  for (const b of billsToday) {
    billed += toNumber(b.totalAmount);
    byStatusBills.generated += 1;
    if (b.status === 'paid') byStatusBills.paid += 1;
    else if (b.status === 'cancelled') byStatusBills.cancelled += 1;
    else byStatusBills.pending += 1;
  }

  const byMethod: Record<string, number> = {};
  const refundsByMethod: Record<string, number> = {};
  const byType: Record<string, number> = { regular: 0, advance: 0, refund: 0 };
  const byCashier: Record<string, { name: string; collected: number; refunded: number }> = {};
  let collected = 0;
  let refunded = 0;
  let reversed = 0;
  for (const p of payments) {
    const amt = toNumber(p.amount);
    if (p.status === 'completed') {
      byType[p.paymentType] = (byType[p.paymentType] ?? 0) + amt;

      // A refund is cash going the other way. Counting it in `collected` — or in
      // `byMethod`, which is what a cashier tallies the drawer against — would
      // credit the counter with money it just handed back.
      const isRefund = p.paymentType === 'refund';
      if (isRefund) {
        refunded += amt;
        refundsByMethod[p.paymentMethod] = (refundsByMethod[p.paymentMethod] ?? 0) + amt;
      } else {
        collected += amt;
        byMethod[p.paymentMethod] = (byMethod[p.paymentMethod] ?? 0) + amt;
      }

      // Per-cashier tally. With payments marked by hand this is the unit a
      // shift actually reconciles on — whose drawer holds what.
      if (p.processedBy) {
        const who = byCashier[p.processedBy] ?? {
          name: p.processor
            ? fullName(p.processor)
            : 'Unknown',
          collected: 0,
          refunded: 0,
        };
        if (isRefund) who.refunded += amt;
        else who.collected += amt;
        byCashier[p.processedBy] = who;
      }
    } else if (p.status === 'reversed') {
      reversed += amt;
    }
  }

  return {
    date: dateStr,
    collected,
    refunded,
    // What the counter should actually be holding at close of day.
    netCollection: r2(collected - refunded),
    reversed,
    billed,
    byMethod,
    refundsByMethod,
    byType,
    byCashier: Object.entries(byCashier).map(([userId, v]) => ({ userId, ...v })),
    byStatusBills,
    payments: payments.map((p) => ({
      id: p.id,
      billNumber: p.bill?.billNumber,
      patientName: p.bill?.patient
        ? fullName(p.bill.patient)
        : null,
      amount: toNumber(p.amount),
      method: p.paymentMethod,
      type: p.paymentType,
      status: p.status,
      paymentDate: p.paymentDate,
      transactionId: p.transactionId,
      cashier: p.processor
        ? fullName(p.processor)
        : null,
    })),
  };
}

/**
 * The printable OP / counter bill.
 *
 * Everything on it was already being rendered — but only inside the payment
 * receipt, which exists per PAYMENT. A bill nobody has paid yet had no
 * printable form, so a patient leaving with a pending or partly-paid bill could
 * not be handed a copy of what they owe. Read-only, so it can be produced at
 * any point in the bill's life and reprinted whenever a copy is asked for.
 *
 * Draft bills are refused: a draft is still being assembled at the counter and
 * handing one over would put a figure in the patient's hands that is about to
 * change.
 */
export async function getBillDocument(tenantId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true, mrn: true, phone: true },
      },
      billItems: { orderBy: { createdAt: 'asc' } },
      payments: { orderBy: { paymentDate: 'asc' } },
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'draft') {
    throw AppError.badRequest('This bill is still a draft — finalize it before printing.');
  }
  return bill;
}

// --- Discount approval ---

/**
 * The tenant's discount policy, from the same migration-free `themeConfig` JSON
 * the registration fee and PDF templates use. A read failure must never block a
 * concession, so it degrades to the default — which is the gate switched OFF.
 */
export async function getDiscountApprovalSettings(
  tenantId: string,
): Promise<DiscountApprovalSettings> {
  try {
    const t = await prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { themeConfig: true },
    });
    const cfg =
      t?.themeConfig && typeof t.themeConfig === 'object'
        ? (t.themeConfig as Record<string, unknown>)
        : {};
    return mergeDiscountApproval(DEFAULT_DISCOUNT_APPROVAL, cfg.discountApproval);
  } catch {
    return DEFAULT_DISCOUNT_APPROVAL;
  }
}

export async function updateDiscountApprovalSettings(
  tenantId: string,
  userId: string,
  patch: unknown,
): Promise<DiscountApprovalSettings> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { themeConfig: true },
  });
  if (!t) throw AppError.notFound('Hospital not found');
  const cfg =
    t.themeConfig && typeof t.themeConfig === 'object'
      ? (t.themeConfig as Record<string, unknown>)
      : {};

  const before = mergeDiscountApproval(DEFAULT_DISCOUNT_APPROVAL, cfg.discountApproval);
  const merged = mergeDiscountApproval(before, patch);

  await prisma.tenant.update({
    where: { id: tenantId },
    // Write only our own key back and preserve the rest — the letterhead, the
    // PDF templates and the registration fee all live in this same column.
    data: { themeConfig: { ...cfg, discountApproval: merged } as object },
  });

  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'discount_policy',
    entityId: tenantId,
    description: merged.enabled
      ? `Discount approval ON — above ₹${merged.maxAmountWithoutApproval || '∞'} or ${merged.maxPercentWithoutApproval || '∞'}% needs approval`
      : 'Discount approval OFF — concessions apply immediately',
    oldValues: before,
    newValues: merged,
  });

  return merged;
}

/** Concessions typed at the counter that nobody has decided on yet. */
export async function getPendingDiscounts(tenantId: string) {
  const rows = await prisma.discount.findMany({
    where: { tenantId, status: 'pending' },
    include: {
      bill: {
        select: {
          id: true,
          billNumber: true,
          totalAmount: true,
          subtotal: true,
          status: true,
          patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        },
      },
      requester: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((d) => ({
    id: d.id,
    billId: d.billId,
    billNumber: d.bill?.billNumber ?? null,
    patientName: d.bill?.patient
      ? `${d.bill.patient.firstName} ${d.bill.patient.lastName ?? ''}`.trim()
      : null,
    patientMrn: d.bill?.patient?.mrn ?? null,
    // What the bill comes to WITHOUT this concession — the figure the approver
    // is being asked to reduce.
    billTotal: toNumber(d.bill?.totalAmount),
    discountType: String(d.discountType),
    amount: toNumber(d.value),
    percentOfBill: toNumber(d.bill?.subtotal)
      ? r2((toNumber(d.value) / toNumber(d.bill!.subtotal)) * 100)
      : 0,
    reason: d.reason,
    requestedBy: d.requester
      ? fullName(d.requester)
      : null,
    requestedAt: d.createdAt,
  }));
}

export async function decideDiscount(
  tenantId: string,
  userId: string,
  discountId: string,
  decision: { approve: boolean; reason?: string },
) {
  const discount = await prisma.discount.findFirst({
    where: { id: discountId, tenantId },
    include: { bill: { select: { id: true, billNumber: true } } },
  });
  if (!discount) throw AppError.notFound('Discount not found');
  if (discount.status !== 'pending') {
    throw AppError.badRequest(`This concession has already been ${discount.status}.`);
  }

  // Nobody signs off their own concession — that is the entire point of a gate.
  if (discount.requestedBy && discount.requestedBy === userId) {
    throw AppError.badRequest(
      'A concession cannot be approved by the person who requested it.',
    );
  }

  const updated = await prisma.discount.update({
    where: { id: discountId },
    data: decision.approve
      ? { status: 'approved', approvedBy: userId, decidedAt: new Date() }
      : {
          status: 'rejected',
          approvedBy: userId,
          decidedAt: new Date(),
          rejectionReason: decision.reason ?? null,
        },
  });

  // Only now does the money move — an approved concession starts counting, a
  // rejected one never does. And only now can it owe a credit note.
  await recalculateBillTotals(discount.billId);
  await creditPostSupplyConcession(tenantId, discount.billId, {
    issuedBy: userId,
    note: discount.reason,
  });

  logger.info(
    { tenantId, discountId, by: userId, approved: decision.approve },
    'Discount decided',
  );
  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: discount.billId,
    description:
      `Concession of ₹${toNumber(discount.value)} on bill ${discount.bill?.billNumber ?? discount.billId} ` +
      (decision.approve ? 'approved' : 'rejected'),
    reason: decision.reason,
    oldValues: { status: 'pending' },
    newValues: { status: decision.approve ? 'approved' : 'rejected', decidedBy: userId },
  });

  return updated;
}

// --- Cash drawer close ---

/**
 * What one cashier's drawer should hold at the end of a business day.
 *
 * ONLY cash. Card, UPI and bank transfers settle to the bank and never sit in a
 * till, so counting them here would guarantee a variance on every close.
 *
 * Expected = opening float + cash taken in − cash handed back. Both halves come
 * from the payment ledger, which now records who processed each one, so this is
 * derived per person rather than guessed for the counter as a whole.
 */
export async function getDrawerStatus(
  tenantId: string,
  cashierId: string,
  query: { date?: string; openingFloat?: number } = {},
) {
  const dateStr = query.date ?? getISTDateStr();
  const { start, end } = istDayRange(dateStr);

  const existing = await prisma.cashDrawerClosure.findFirst({
    where: { tenantId, cashierId, businessDate: istDayStart(dateStr) },
    include: {
      cashier: { select: { id: true, firstName: true, lastName: true } },
      closer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const payments = await prisma.payment.findMany({
    where: {
      tenantId,
      processedBy: cashierId,
      status: 'completed',
      paymentMethod: 'cash',
      paymentDate: { gte: start, lte: end },
    },
    select: { amount: true, paymentType: true },
  });

  let cashIn = 0;
  let cashOut = 0;
  for (const p of payments) {
    const amt = toNumber(p.amount);
    if (p.paymentType === 'refund') cashOut += amt;
    else cashIn += amt;
  }

  // A drawer already closed keeps the float it was closed with, so reopening
  // the screen shows the same figures it was reconciled against.
  const openingFloat = existing
    ? toNumber(existing.openingFloat)
    : (query.openingFloat ?? 0);
  const expectedCash = r2(openingFloat + cashIn - cashOut);

  return {
    date: dateStr,
    cashierId,
    openingFloat,
    cashIn: r2(cashIn),
    cashOut: r2(cashOut),
    expectedCash,
    transactionCount: payments.length,
    closure: existing
      ? {
          id: existing.id,
          openingFloat: toNumber(existing.openingFloat),
          expectedCash: toNumber(existing.expectedCash),
          countedCash: toNumber(existing.countedCash),
          variance: toNumber(existing.variance),
          denominations: existing.denominations as Record<string, number> | null,
          notes: existing.notes,
          closedAt: existing.closedAt,
          closedBy: existing.closer
            ? fullName(existing.closer)
            : null,
        }
      : null,
  };
}

export async function closeDrawer(
  tenantId: string,
  userId: string,
  data: {
    date?: string;
    cashierId?: string;
    openingFloat?: number;
    countedCash: number;
    denominations?: Record<string, number>;
    notes?: string;
  },
) {
  // A cashier closes their own drawer by default; a supervisor may close
  // someone else's (e.g. a nurse who has gone home mid-reconciliation).
  const cashierId = data.cashierId ?? userId;
  const dateStr = data.date ?? getISTDateStr();
  const businessDate = istDayStart(dateStr);

  const already = await prisma.cashDrawerClosure.findFirst({
    where: { tenantId, cashierId, businessDate },
  });
  if (already) {
    throw AppError.badRequest(
      'This drawer has already been closed for the day. Reopen it to recount.',
    );
  }

  const status = await getDrawerStatus(tenantId, cashierId, {
    date: dateStr,
    openingFloat: data.openingFloat,
  });

  // Recomputed here rather than trusted from the client — the whole point of
  // the exercise is that the system says what it expected, independently.
  const expectedCash = status.expectedCash;
  const countedCash = r2(data.countedCash);
  const variance = r2(countedCash - expectedCash);

  const closure = await prisma.cashDrawerClosure.create({
    data: {
      tenantId,
      businessDate,
      cashierId,
      openingFloat: status.openingFloat,
      expectedCash,
      countedCash,
      variance,
      denominations: (data.denominations ?? undefined) as any,
      notes: data.notes?.trim() || null,
      closedBy: userId,
    },
  });

  logger.info(
    { tenantId, cashierId, date: dateStr, expectedCash, countedCash, variance },
    'Cash drawer closed',
  );
  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'cash_drawer_closure',
    entityId: closure.id,
    description:
      `Drawer closed for ${dateStr} — expected ₹${expectedCash}, counted ₹${countedCash}` +
      (variance === 0
        ? ' (balanced)'
        : ` (${variance > 0 ? 'over' : 'short'} by ₹${Math.abs(variance)})`),
    reason: data.notes,
    newValues: {
      businessDate: dateStr,
      cashierId,
      openingFloat: status.openingFloat,
      expectedCash,
      countedCash,
      variance,
    },
  });

  return closure;
}

/** Every drawer closed on a day — the supervisor's view of the counter. */
export async function listDrawerClosures(tenantId: string, query: { date?: string } = {}) {
  const dateStr = query.date ?? getISTDateStr();
  const closures = await prisma.cashDrawerClosure.findMany({
    where: { tenantId, businessDate: istDayStart(dateStr) },
    include: {
      cashier: { select: { id: true, firstName: true, lastName: true } },
      closer: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { closedAt: 'asc' },
  });

  return {
    date: dateStr,
    closures: closures.map((c) => ({
      id: c.id,
      cashierId: c.cashierId,
      cashierName: c.cashier ? fullName(c.cashier) : '—',
      openingFloat: toNumber(c.openingFloat),
      expectedCash: toNumber(c.expectedCash),
      countedCash: toNumber(c.countedCash),
      variance: toNumber(c.variance),
      notes: c.notes,
      closedAt: c.closedAt,
      closedBy: c.closer ? fullName(c.closer) : '—',
    })),
    totals: {
      expectedCash: r2(closures.reduce((s, c) => s + toNumber(c.expectedCash), 0)),
      countedCash: r2(closures.reduce((s, c) => s + toNumber(c.countedCash), 0)),
      variance: r2(closures.reduce((s, c) => s + toNumber(c.variance), 0)),
    },
  };
}

/**
 * Undo a close so the cashier can recount. Deliberately gated at
 * `billing:approve` rather than letting anyone quietly redo their own variance.
 */
export async function reopenDrawer(tenantId: string, userId: string, closureId: string) {
  const closure = await prisma.cashDrawerClosure.findFirst({
    where: { id: closureId, tenantId },
  });
  if (!closure) throw AppError.notFound('Drawer closure not found');

  await prisma.cashDrawerClosure.delete({ where: { id: closureId } });

  logger.info({ tenantId, closureId, by: userId }, 'Cash drawer reopened');
  void writeAudit({
    tenantId,
    userId,
    action: 'delete',
    entityType: 'cash_drawer_closure',
    entityId: closureId,
    description: `Drawer closure reopened for recount — was counted ₹${toNumber(closure.countedCash)} against ₹${toNumber(closure.expectedCash)} expected`,
    oldValues: {
      expectedCash: toNumber(closure.expectedCash),
      countedCash: toNumber(closure.countedCash),
      variance: toNumber(closure.variance),
    },
  });

  return { reopened: true, closureId };
}

// --- Patient Bills ---

export async function getPatientBills(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const bills = await prisma.bill.findMany({
    where: { tenantId, patientId },
    include: {
      billItems: {
        select: { id: true, description: true, totalAmount: true },
      },
      payments: {
        select: { id: true, amount: true, paymentMethod: true, status: true, paymentDate: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return bills;
}
