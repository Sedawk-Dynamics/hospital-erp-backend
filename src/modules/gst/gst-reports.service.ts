// ---------------------------------------------------------------------------
// GST reports.
//
// A-10 — Advances & Advance Adjustments.
//
// An advance is the one place tax can fall due before an invoice exists, so the
// return asks about it separately: GSTR-1 table 11A reports advances received on
// which tax is due, and 11B reports advances adjusted against invoices later.
// Neither figure can be assembled from a bill.
//
// The three events this stitches together are all Payment rows, distinguished
// by what they carry:
//
//   received   paymentType 'advance', not an IPDEP: application
//   adjusted   paymentType 'regular', pointing at the advance it drew down
//   returned   paymentType 'refund', carrying a refund voucher
//
// Legacy rows — advances taken before any of this existed — have no voucher and
// no link back. They are still shown, because they are still advances and the
// money is still real, but the report says so rather than quietly reporting
// them as fully unadjusted.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import { notStartingWith } from '../../shared/prisma-where';

/** Deposit money moving ONTO a bill. Not a receipt, so never a report row. */
const APPLIED_DEPOSIT_PREFIX = 'IPDEP:';
/** The receipt of an admission deposit. IS a report row. */
const DEPOSIT_RECEIPT_PREFIX = 'IPDEPRCPT:';

export interface AdvanceReportQuery {
  from?: string;
  to?: string;
  patientId?: string;
  /** 'taxable' shows only advances on which tax fell due — GSTR-1 table 11A. */
  treatment?: string;
}

const money = (v: unknown) => r2(Number(v ?? 0));

export async function getAdvancesReport(tenantId: string, query: AdvanceReportQuery = {}) {
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  // Inclusive of the closing day, which is what a person means by "to".
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;

  const receipts = await prisma.payment.findMany({
    where: {
      tenantId,
      status: 'completed',
      paymentType: 'advance' as never,
      // An applied deposit is money moving onto a bill, not money arriving.
      // Null-safe: most advances carry no reference number at all, and the
      // obvious spelling of this exclusion drops every one of them.
      ...notStartingWith('transactionId', APPLIED_DEPOSIT_PREFIX),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(from || to ? { paymentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(query.treatment ? { gstTreatment: query.treatment } : {}),
    },
    orderBy: { paymentDate: 'asc' },
    select: {
      id: true,
      paymentDate: true,
      amount: true,
      paymentMethod: true,
      transactionId: true,
      notes: true,
      gstTreatment: true,
      taxRatePercent: true,
      taxableValue: true,
      taxAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      voucherType: true,
      voucherNumber: true,
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  // Everything that drew down one of those advances, in one query rather than
  // one per row.
  const receiptIds = receipts.map((r) => r.id);
  const drawdowns = receiptIds.length
    ? await prisma.payment.findMany({
        where: { tenantId, status: 'completed', sourceAdvancePaymentId: { in: receiptIds } },
        select: {
          id: true,
          sourceAdvancePaymentId: true,
          paymentType: true,
          paymentDate: true,
          amount: true,
          taxAmount: true,
          voucherNumber: true,
          bill: { select: { billNumber: true, invoiceNumber: true, gstDocumentType: true } },
        },
      })
    : [];

  const byAdvance = new Map<string, typeof drawdowns>();
  for (const d of drawdowns) {
    const key = d.sourceAdvancePaymentId!;
    const list = byAdvance.get(key) ?? [];
    list.push(d);
    byAdvance.set(key, list);
  }

  const rows = receipts.map((rc) => {
    const linked = byAdvance.get(rc.id) ?? [];
    const adjustments = linked
      .filter((d) => d.paymentType !== 'refund')
      .map((d) => ({
        date: d.paymentDate,
        amount: money(d.amount),
        // What it was adjusted against. The invoice number is the one the
        // return reports; the bill number is what staff search by.
        invoiceNumber: d.bill?.invoiceNumber ?? null,
        billNumber: d.bill?.billNumber ?? null,
        documentType: d.bill?.gstDocumentType ?? null,
      }));
    const refunds = linked
      .filter((d) => d.paymentType === 'refund')
      .map((d) => ({
        date: d.paymentDate,
        amount: money(d.amount),
        voucherNumber: d.voucherNumber ?? null,
        // Stored negative on the refund voucher, so the sign is already right.
        taxReversed: money(d.taxAmount),
      }));

    const amount = money(rc.amount);
    const adjusted = r2(adjustments.reduce((s, a) => s + a.amount, 0));
    const refunded = r2(refunds.reduce((s, a) => s + a.amount, 0));

    return {
      advanceId: rc.id,
      voucherNumber: rc.voucherNumber,
      voucherType: rc.voucherType,
      date: rc.paymentDate,
      patientId: rc.patient?.id ?? null,
      // Never `first + ' ' + last` — a patient with no surname prints "null".
      patientName: rc.patient ? fullName(rc.patient) : null,
      mrn: rc.patient?.mrn ?? null,
      // Where the money came in. A deposit is taken at admission; a desk
      // advance is taken at the counter, and they report identically.
      source: String(rc.transactionId ?? '').startsWith(DEPOSIT_RECEIPT_PREFIX)
        ? ('admission_deposit' as const)
        : ('desk_advance' as const),
      paymentMethod: rc.paymentMethod,
      amount,
      gstTreatment: rc.gstTreatment,
      taxRatePercent: money(rc.taxRatePercent),
      taxableValue: money(rc.taxableValue),
      taxAmount: money(rc.taxAmount),
      cgstAmount: money(rc.cgstAmount),
      sgstAmount: money(rc.sgstAmount),
      igstAmount: money(rc.igstAmount),
      adjustments,
      adjusted,
      refunds,
      refunded,
      balance: r2(Math.max(0, amount - adjusted - refunded)),
      /**
       * Taken before advances carried a tax position at all. Its money is real
       * and is counted; its treatment is simply unknown, and saying so is
       * better than reporting it as exempt on no evidence.
       */
      unclassified: rc.gstTreatment == null,
    };
  });

  // ── GSTR-1 table 11 ──
  const taxable = rows.filter((r) => r.gstTreatment === 'taxable');
  const sum = (list: typeof rows, k: 'amount' | 'taxableValue' | 'taxAmount' | 'cgstAmount' | 'sgstAmount' | 'igstAmount') =>
    r2(list.reduce((s, x) => s + (x[k] as number), 0));

  const byTreatment = new Map<string, { count: number; amount: number; taxableValue: number; taxAmount: number }>();
  for (const r of rows) {
    const key = r.gstTreatment ?? 'unclassified';
    const acc = byTreatment.get(key) ?? { count: 0, amount: 0, taxableValue: 0, taxAmount: 0 };
    acc.count += 1;
    acc.amount = r2(acc.amount + r.amount);
    acc.taxableValue = r2(acc.taxableValue + r.taxableValue);
    acc.taxAmount = r2(acc.taxAmount + r.taxAmount);
    byTreatment.set(key, acc);
  }

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows,
    summary: {
      count: rows.length,
      amountReceived: sum(rows, 'amount'),
      amountAdjusted: r2(rows.reduce((s, r) => s + r.adjusted, 0)),
      amountRefunded: r2(rows.reduce((s, r) => s + r.refunded, 0)),
      balanceOutstanding: r2(rows.reduce((s, r) => s + r.balance, 0)),
      /**
       * Table 11A — advances RECEIVED on which tax is due. Only the taxable
       * ones: an exempt deposit is reported as exempt turnover, not here.
       */
      taxDueOnAdvances: {
        count: taxable.length,
        amount: sum(taxable, 'amount'),
        taxableValue: sum(taxable, 'taxableValue'),
        taxAmount: sum(taxable, 'taxAmount'),
        cgstAmount: sum(taxable, 'cgstAmount'),
        sgstAmount: sum(taxable, 'sgstAmount'),
        igstAmount: sum(taxable, 'igstAmount'),
      },
      /** Table 11B — advances adjusted against invoices in this period. */
      adjustedAgainstInvoices: {
        count: rows.reduce((s, r) => s + r.adjustments.length, 0),
        amount: r2(rows.reduce((s, r) => s + r.adjusted, 0)),
      },
      byTreatment: [...byTreatment.entries()].map(([treatment, v]) => ({ treatment, ...v })),
      /**
       * Advances with no recorded treatment. Counted in the money above but
       * excluded from the tax figures, because their position was never
       * established — the report says so rather than assuming one.
       */
      unclassifiedCount: rows.filter((r) => r.unclassified).length,
    },
  };
}
