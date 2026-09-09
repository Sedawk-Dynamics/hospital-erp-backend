// ---------------------------------------------------------------------------
// The sales-side GST reports (Group A).
//
// A-1 is the backbone: one row per bill line, with the tax position frozen onto
// it at billing. **Every other sales report in this file is a fold of A-1** —
// not a second query with its own idea of what counts. That is deliberate and
// it is the whole design: the return has to tie back, and a summary assembled
// independently WILL eventually disagree with the register it claims to
// summarise. When it does, nobody can tell which one is wrong.
//
// So `salesLines()` is the only place that decides what is in the period, and
// A-2, A-3, A-4, A-5, A-7 and A-8 all take its output.
//
// What counts as a supply: a bill that has left draft. A draft is a basket, not
// a document. A CANCELLED bill still counts, because cancelling an issued bill
// raises a credit note (see credit-note.service) — the invoice stays declared
// and the note reverses it, which is what section 34 requires. Dropping the
// invoice instead would leave a hole in the series and a credit note reversing
// something the return never mentioned.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { loadGstSlabs, isLegalSlabRate } from '../../shared/gst-slabs';
import { uqcForLine, UQC_CODES } from '../../shared/gst-uqc';
import { r2, hsnForReturn } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import { treatmentLabelFor } from '../billing/billing.gst-layout';

/** The advance bucket is a holding account, not a bill. It is never turnover. */
const ADVANCE_BUCKET_PREFIX = 'ADV-';

export interface SalesReportQuery {
  from?: string;
  to?: string;
  /** A bill item category — pharmacy, lab, room … */
  department?: string;
  documentType?: string;
  treatment?: string;
  /** 'b2b' = a recipient with a GSTIN; 'b2c' = everyone else. */
  customerType?: 'b2b' | 'b2c';
}

export interface SalesLine {
  billId: string;
  billNumber: string;
  invoiceNumber: string | null;
  documentType: string | null;
  billDate: Date;
  billStatus: string;
  financialYear: string | null;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  /** OP / IP — an admitted patient's supply follows different rules. */
  patientType: 'ip' | 'op';
  recipientGstin: string | null;
  placeOfSupplyStateCode: string | null;
  isInterState: boolean;
  itemId: string;
  description: string;
  department: string;
  hsnSac: string | null;
  gstTreatment: string | null;
  treatmentLabel: string | null;
  rateSource: string | null;
  requiresTaxResolution: boolean;
  /**
   * Who raised the document this line sits on.
   *
   * NOT strictly "who typed the rate" — a bill line carries no author of its
   * own. On a counter bill they are the same person, and on a ward ledger they
   * are the person accountable for the bill. C-5 says which it is rather than
   * implying a precision the data does not have.
   */
  raisedBy: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRatePercent: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
  totalAmount: number;
  /**
   * The rate on this line is not one the law recognised on the day it was
   * billed.
   *
   * Twenty-two of the twenty-three taxable lines in this hospital's register
   * are in that state: rates of 2%, 10% and 12% that reached invoices before
   * anything knew what a slab was. The finalisation gate stops new ones; this
   * is how the ones already issued become visible, because a return filed from
   * a register carrying them will be rejected and nothing was saying so.
   */
  illegalRate: boolean;
}

const n = (v: unknown) => r2(Number(v ?? 0));

function dateRange(query: SalesReportQuery) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    // Inclusive of the closing day, which is what a person means by "to".
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

/**
 * A-1 — GST Sales Register. One row per bill line.
 *
 * Read straight off the frozen columns rather than recomputed: the rate that
 * applied on the day the bill was raised is the rate that must be declared, and
 * re-deriving it from today's masters would silently restate a filed period
 * every time somebody edits a tax master.
 */
export async function getSalesRegister(
  tenantId: string,
  query: SalesReportQuery = {},
): Promise<{ period: { from: string | null; to: string | null }; rows: SalesLine[] }> {
  const { from, to } = dateRange(query);

  const bills = await prisma.bill.findMany({
    where: {
      tenantId,
      status: { not: 'draft' },
      // Plain NOT, not the null-safe helper: `billNumber` is a required column,
      // and Prisma rejects a null check on one.
      NOT: { billNumber: { startsWith: ADVANCE_BUCKET_PREFIX } },
      ...(from || to ? { billDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(query.documentType ? { gstDocumentType: query.documentType } : {}),
      ...(query.customerType === 'b2b' ? { recipientGstin: { not: null } } : {}),
      ...(query.customerType === 'b2c' ? { recipientGstin: null } : {}),
    },
    orderBy: [{ billDate: 'asc' }, { billNumber: 'asc' }],
    select: {
      id: true, billNumber: true, invoiceNumber: true, gstDocumentType: true,
      billDate: true, status: true, financialYear: true, admissionId: true,
      recipientGstin: true, placeOfSupplyStateCode: true, isInterState: true,
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      generator: { select: { firstName: true, lastName: true } },
      billItems: {
        orderBy: { createdAt: 'asc' },
        where: {
          ...(query.department ? { category: query.department as never } : {}),
          ...(query.treatment ? { gstTreatment: query.treatment } : {}),
        },
      },
    },
  });

  // The slab windows, loaded once for the whole register rather than per line.
  // An unreadable or empty master means the check cannot be made, and
  // `isLegalSlabRate` answers true in that case by design — a report must not
  // start accusing every line because a reference table would not read.
  let slabs: Awaited<ReturnType<typeof loadGstSlabs>> = [];
  try {
    slabs = await loadGstSlabs();
  } catch {
    /* no slabs → nothing is flagged */
  }

  const rows: SalesLine[] = [];
  for (const b of bills) {
    for (const it of b.billItems) {
      rows.push({
        billId: b.id,
        billNumber: b.billNumber,
        invoiceNumber: b.invoiceNumber,
        documentType: b.gstDocumentType,
        billDate: b.billDate,
        billStatus: String(b.status),
        financialYear: b.financialYear,
        patientId: b.patient?.id ?? null,
        // Never `first + ' ' + last` — a patient with no surname prints "null".
        patientName: b.patient ? fullName(b.patient) : null,
        mrn: b.patient?.mrn ?? null,
        patientType: b.admissionId ? 'ip' : 'op',
        recipientGstin: b.recipientGstin,
        placeOfSupplyStateCode: b.placeOfSupplyStateCode,
        isInterState: b.isInterState,
        itemId: it.id,
        description: it.description,
        department: String(it.category),
        hsnSac: it.hsnSacCode,
        gstTreatment: it.gstTreatment,
        treatmentLabel: treatmentLabelFor(it.gstTreatment),
        rateSource: it.rateSource,
        requiresTaxResolution: it.requiresTaxResolution,
        raisedBy: b.generator ? fullName(b.generator) : null,
        quantity: it.quantity,
        unitPrice: n(it.unitPrice),
        discountAmount: n(it.discountAmount),
        taxRatePercent: n(it.taxPercent),
        taxableValue: n(it.taxableValue),
        cgstAmount: n(it.cgstAmount),
        sgstAmount: n(it.sgstAmount),
        igstAmount: n(it.igstAmount),
        cessAmount: n(it.cessAmount),
        taxAmount: n(it.taxAmount),
        totalAmount: n(it.totalAmount),
        // Judged as at the BILL's date: a 12% line from June 2025 was correct
        // then and is not an error now.
        illegalRate:
          n(it.taxAmount) > 0 &&
          n(it.taxPercent) > 0 &&
          !isLegalSlabRate(slabs, n(it.taxPercent), b.billDate),
      });
    }
  }

  return { period: { from: query.from ?? null, to: query.to ?? null }, rows };
}

// ── Folds of A-1 ───────────────────────────────────────────────────────────

export interface TaxTotals {
  count: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
  totalAmount: number;
}

const ZERO: TaxTotals = {
  count: 0, taxableValue: 0, cgstAmount: 0, sgstAmount: 0,
  igstAmount: 0, cessAmount: 0, taxAmount: 0, totalAmount: 0,
};

/** Add a line into a running total, rounding at every step so money does not drift. */
export function addLine(acc: TaxTotals, l: SalesLine): TaxTotals {
  return {
    count: acc.count + 1,
    taxableValue: r2(acc.taxableValue + l.taxableValue),
    cgstAmount: r2(acc.cgstAmount + l.cgstAmount),
    sgstAmount: r2(acc.sgstAmount + l.sgstAmount),
    igstAmount: r2(acc.igstAmount + l.igstAmount),
    cessAmount: r2(acc.cessAmount + l.cessAmount),
    taxAmount: r2(acc.taxAmount + l.taxAmount),
    totalAmount: r2(acc.totalAmount + l.totalAmount),
  };
}

export function totalOf(lines: SalesLine[]): TaxTotals {
  return lines.reduce(addLine, { ...ZERO });
}

/** Group lines by a key, keeping the running totals rounded. */
function groupBy(lines: SalesLine[], key: (l: SalesLine) => string) {
  const out = new Map<string, { lines: SalesLine[]; totals: TaxTotals }>();
  for (const l of lines) {
    const k = key(l);
    const cur = out.get(k) ?? { lines: [], totals: { ...ZERO } };
    cur.lines.push(l);
    cur.totals = addLine(cur.totals, l);
    out.set(k, cur);
  }
  return out;
}

/**
 * A-2 — Rate-wise GST Summary. "How much GST do we owe this month."
 *
 * One row per rate, plus the same figures cut by department so the hospital can
 * see where its taxable income comes from. Both views fold the SAME lines, so
 * they cannot disagree with each other or with A-1.
 *
 * Grouped by treatment AND rate: exempt and taxable-at-0% are different answers
 * that share a number, and GSTR-3B reports them in different boxes.
 */
export async function getRateWiseSummary(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, query);

  const byRate = [...groupBy(rows, (l) => `${l.gstTreatment ?? 'unclassified'}:${l.taxRatePercent}`)]
    .map(([, v]) => ({
      treatment: v.lines[0].gstTreatment ?? 'unclassified',
      label: v.lines[0].treatmentLabel ?? 'Unclassified',
      ratePercent: v.lines[0].taxRatePercent,
      ...v.totals,
    }))
    // Highest rate first, so the taxed rows lead and the exempt block closes.
    .sort((a, b) => b.ratePercent - a.ratePercent || a.treatment.localeCompare(b.treatment));

  const byDepartment = [...groupBy(rows, (l) => l.department)]
    .map(([department, v]) => ({
      department,
      ...v.totals,
      byRate: [...groupBy(v.lines, (l) => `${l.gstTreatment ?? 'unclassified'}:${l.taxRatePercent}`)]
        .map(([, g]) => ({
          treatment: g.lines[0].gstTreatment ?? 'unclassified',
          ratePercent: g.lines[0].taxRatePercent,
          ...g.totals,
        }))
        .sort((a, b) => b.ratePercent - a.ratePercent),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const illegal = rows.filter((l) => l.illegalRate);
  return {
    period,
    byRate,
    byDepartment,
    totals: totalOf(rows),
    /**
     * Rates in this period that the law did not recognise on the day they were
     * billed. Filing from a register that carries them gets the return
     * rejected, so it is stated on the summary rather than left to be found.
     */
    illegalRates: {
      lines: illegal.length,
      taxableValue: r2(illegal.reduce((t, l) => t + l.taxableValue, 0)),
      taxAmount: r2(illegal.reduce((t, l) => t + l.taxAmount, 0)),
      rates: [...new Set(illegal.map((l) => l.taxRatePercent))].sort((a, b) => a - b),
      bills: [...new Set(illegal.map((l) => l.invoiceNumber ?? l.billNumber))].slice(0, 20),
    },
  };
}

/**
 * A-3 — HSN / SAC Summary, the shape GSTR-1 Table 12 wants.
 *
 * Reported CODE-wise, not item-wise, and truncated to the number of digits the
 * hospital's turnover obliges it to report: 6 above ₹5 crore, 4 below. Lines
 * with no code are collected separately rather than folded into a blank row —
 * they are the ones the hospital still has to classify, and hiding them inside
 * the table is how they reach a return unnoticed.
 */
export async function getHsnSummary(
  tenantId: string,
  query: SalesReportQuery & { sixDigit?: boolean } = {},
) {
  const { period, rows } = await getSalesRegister(tenantId, query);
  const sixDigit = query.sixDigit === true;

  const coded = rows.filter((l) => !!hsnForReturn(l.hsnSac, sixDigit));
  const uncoded = rows.filter((l) => !hsnForReturn(l.hsnSac, sixDigit));

  // Grouped by code, rate AND unit. Table 12 reports a quantity against a UQC,
  // so a code sold in tablets and in bottles is two rows — summing them would
  // report a quantity in no unit at all, which is the state this report was in.
  const byCode = [...groupBy(
    coded,
    (l) => `${hsnForReturn(l.hsnSac, sixDigit)}:${l.taxRatePercent}:${uqcForLine(l)}`,
  )]
    .map(([, v]) => ({
      hsnSac: hsnForReturn(v.lines[0].hsnSac, sixDigit)!,
      description: v.lines[0].description,
      ratePercent: v.lines[0].taxRatePercent,
      /**
       * The government's own unit code — section 11.2's A-3 column list asks
       * for it by name, and the portal will not accept a Table 12 row without
       * one. A service has no physical unit and takes NOS, one of each.
       */
      uqc: uqcForLine(v.lines[0]),
      uqcLabel: UQC_CODES[uqcForLine(v.lines[0])] ?? 'Others',
      // Table 12 asks for quantity as well as value.
      quantity: v.lines.reduce((t, l) => t + l.quantity, 0),
      ...v.totals,
    }))
    .sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || b.ratePercent - a.ratePercent);

  return {
    period,
    /** 6 digits above ₹5 crore aggregate turnover, 4 below. */
    reportingDigits: sixDigit ? 6 : 4,
    byCode,
    totals: totalOf(coded),
    /** Billed with no code at all — these belong in C-3, not in a return. */
    unclassified: totalOf(uncoded),
  };
}

/**
 * A-4 — B2B Invoice Register. Invoice-wise, for recipients with a GSTIN.
 *
 * GSTR-1 Table 4 is invoice-level, not line-level: the counterparty claims
 * credit against the invoice, so the register has to add up to what they see.
 */
export async function getB2bRegister(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, { ...query, customerType: 'b2b' });

  const invoices = [...groupBy(rows, (l) => l.billId)].map(([billId, v]) => {
    const f = v.lines[0];
    return {
      billId,
      billNumber: f.billNumber,
      invoiceNumber: f.invoiceNumber,
      documentType: f.documentType,
      billDate: f.billDate,
      recipientGstin: f.recipientGstin,
      placeOfSupplyStateCode: f.placeOfSupplyStateCode,
      isInterState: f.isInterState,
      patientName: f.patientName,
      ...v.totals,
    };
  });

  return { period, invoices, totals: totalOf(rows) };
}

/**
 * A-5 — B2C Summary. Ordinary patients, by place of supply and rate.
 *
 * GSTR-1 reports small B2C supplies in summary (Table 7) and large inter-State
 * ones invoice-wise (Table 5), so the two are separated here rather than left
 * for the accountant to sort out.
 */
const B2CL_THRESHOLD = 250000;

export async function getB2cSummary(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, { ...query, customerType: 'b2c' });

  const byBill = [...groupBy(rows, (l) => l.billId)];
  const largeInterState = byBill
    .filter(([, v]) => v.lines[0].isInterState && v.totals.totalAmount > B2CL_THRESHOLD)
    .map(([billId, v]) => {
      const f = v.lines[0];
      return {
        billId, billNumber: f.billNumber, invoiceNumber: f.invoiceNumber,
        billDate: f.billDate, placeOfSupplyStateCode: f.placeOfSupplyStateCode,
        patientName: f.patientName, ...v.totals,
      };
    });
  const largeIds = new Set(largeInterState.map((i) => i.billId));

  const small = rows.filter((l) => !largeIds.has(l.billId));
  const summary = [...groupBy(small, (l) => `${l.placeOfSupplyStateCode ?? '-'}:${l.taxRatePercent}`)]
    .map(([, v]) => ({
      placeOfSupplyStateCode: v.lines[0].placeOfSupplyStateCode,
      ratePercent: v.lines[0].taxRatePercent,
      isInterState: v.lines[0].isInterState,
      ...v.totals,
    }))
    .sort((a, b) => b.ratePercent - a.ratePercent);

  return {
    period,
    /** Table 5 — inter-State B2C above the invoice-wise threshold. */
    largeInterState,
    /** Table 7 — everything else, summarised. */
    summary,
    threshold: B2CL_THRESHOLD,
    totals: totalOf(rows),
  };
}

/**
 * A-7 — Exempt, Nil-rated and Non-GST turnover.
 *
 * For a hospital this is the largest number on the sales side, and it is the
 * INPUT to the Rule 42/43 reversal in B-3 — get it wrong and the hospital
 * either over-claims input credit or gives away credit it was entitled to. It
 * must never be mixed up with taxable turnover, so the three are reported
 * separately rather than as one "not taxed" figure.
 */
export async function getExemptTurnover(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, query);

  const bucket = (t: string) => totalOf(rows.filter((l) => l.gstTreatment === t));
  const taxable = totalOf(rows.filter((l) => l.gstTreatment === 'taxable'));
  const exempt = bucket('exempt');
  const nilRated = bucket('nil_rated');
  const nonGst = bucket('non_gst');
  const zeroRated = bucket('zero_rated');
  const unclassified = totalOf(rows.filter((l) => !l.gstTreatment));

  // The ratio Rule 42 turns on. Exempt turnover over total turnover — the share
  // of input credit the hospital may not keep.
  const exemptTurnover = r2(
    exempt.taxableValue + nilRated.taxableValue + nonGst.taxableValue,
  );
  const totalTurnover = r2(exemptTurnover + taxable.taxableValue + zeroRated.taxableValue);

  return {
    period,
    taxable,
    exempt,
    nilRated,
    nonGst,
    zeroRated,
    unclassified,
    exemptTurnover,
    totalTurnover,
    /** Rule 42's E/F. Zero-rated supplies count as taxable for this purpose. */
    exemptRatio: totalTurnover > 0 ? r2((exemptTurnover / totalTurnover) * 100) : 0,
    byDepartment: [...groupBy(rows, (l) => l.department)]
      .map(([department, v]) => ({
        department,
        exempt: r2(
          v.lines
            .filter((l) => l.gstTreatment && l.gstTreatment !== 'taxable' && l.gstTreatment !== 'zero_rated')
            .reduce((t, l) => t + l.taxableValue, 0),
        ),
        taxable: r2(
          v.lines.filter((l) => l.gstTreatment === 'taxable').reduce((t, l) => t + l.taxableValue, 0),
        ),
      }))
      .sort((a, b) => b.exempt + b.taxable - (a.exempt + a.taxable)),
  };
}
