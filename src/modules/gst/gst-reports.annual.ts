// ---------------------------------------------------------------------------
// The annual return — GSTR-9, and the data GSTR-9C needs.
//
// The review document asks for both, and neither existed anywhere: a grep for
// "gstr9", "annual return" or "9C" across this codebase returned nothing.
// GSTR-9 is the annual return every normal taxpayer files, typically by 31
// December, and GSTR-9C is the reconciliation statement that goes with it where
// turnover crosses the threshold.
//
// WHAT THIS IS AND IS NOT. It is not a new set of figures. Everything here is
// the monthly reports run once over a whole financial year — the same folds of
// the same register, so the annual return cannot disagree with the twelve
// returns it summarises. That is the entire point: an annual figure derived
// independently is an annual figure that will not tie, and reconciling it is
// what costs an accountant their December.
//
// It does NOT file anything, and it does not pretend to be a 9C. Section 6 of
// the review is explicit: "This does not mean the HMS has to file GSTR-9C
// itself. It means the system should provide the data the accountant needs."
// So 9C here is a reconciliation WORKING — books against returns, with the
// differences named — and not a certified statement.
//
// Two things it cannot produce and says so rather than guessing:
//   * tax actually PAID, which is entered on the portal in GSTR-3B and lives
//     in the electronic cash and credit ledgers, not here;
//   * ITC actually CLAIMED, for the same reason.
// Both are reported as null with an explanation. A zero would read as "nothing
// was paid", which is a different and much more alarming statement.
// ---------------------------------------------------------------------------

import { r2 } from '../../shared/gst';
import { financialYearFor } from './gst-document.service';
import {
  getSalesRegister,
  getRateWiseSummary,
  getHsnSummary,
  getB2bRegister,
  getB2cSummary,
  getExemptTurnover,
  totalOf,
} from './gst-reports.sales';
import { getCreditNoteRegister, getGstr3bSummary } from './gst-reports.returns';
import { getItcSummary, getItcReversalWorking, getPurchaseRegister } from './gst-reports.purchase';
import { getAdvancesReport } from './gst-reports.service';

/**
 * The 1 April – 31 March window for a financial year written as "2026-27".
 *
 * Defaults to the year the current date falls in, which is almost always the
 * one being worked on: an annual return is filed nine months after the year
 * ends, so "this year" is the right default for most of the time it is open.
 */
export function financialYearWindow(financialYear?: string): {
  financialYear: string;
  from: string;
  to: string;
} {
  const fy = financialYear && /^\d{4}-\d{2}$/.test(financialYear)
    ? financialYear
    : financialYearFor(new Date());
  const startYear = Number(fy.slice(0, 4));
  return {
    financialYear: fy,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
  };
}

/**
 * GSTR-9 — the annual return summary.
 *
 * Laid out in the portal's own table order so the accountant checks a screen
 * that looks like the form rather than assembling it in a spreadsheet, which is
 * the same principle A-8 and A-9 follow for the monthly returns.
 */
export async function getGstr9Summary(tenantId: string, query: { financialYear?: string } = {}) {
  const window = financialYearWindow(query.financialYear);
  const q = { from: window.from, to: window.to };

  const [register, rateWise, hsn, b2b, b2c, exempt, notes, advances, itc, reversal, purchases, gstr3b] =
    await Promise.all([
      getSalesRegister(tenantId, q),
      getRateWiseSummary(tenantId, q),
      getHsnSummary(tenantId, q),
      getB2bRegister(tenantId, q),
      getB2cSummary(tenantId, q),
      getExemptTurnover(tenantId, q),
      getCreditNoteRegister(tenantId, q),
      getAdvancesReport(tenantId, q),
      getItcSummary(tenantId, q),
      getItcReversalWorking(tenantId, q),
      getPurchaseRegister(tenantId, q),
      getGstr3bSummary(tenantId, q),
    ]);

  const registerTotals = totalOf(register.rows);

  // Table 4 — outward supplies on which tax IS payable.
  const table4 = {
    label: 'Table 4 — Outward supplies on which tax is payable',
    rows: [
      {
        ref: '4A',
        label: 'Supplies to unregistered persons (B2C)',
        taxableValue: b2c.totals.taxableValue,
        cgstAmount: b2c.totals.cgstAmount,
        sgstAmount: b2c.totals.sgstAmount,
        igstAmount: b2c.totals.igstAmount,
        cessAmount: b2c.totals.cessAmount,
        source: 'A-5 B2C Summary',
      },
      {
        ref: '4B',
        label: 'Supplies to registered persons (B2B)',
        taxableValue: b2b.totals.taxableValue,
        cgstAmount: b2b.totals.cgstAmount,
        sgstAmount: b2b.totals.sgstAmount,
        igstAmount: b2b.totals.igstAmount,
        cessAmount: b2b.totals.cessAmount,
        source: 'A-4 B2B Invoice Register',
      },
      {
        ref: '4F',
        label: 'Advances on which tax was paid but invoice not issued',
        taxableValue: advances.summary.taxDueOnAdvances.taxableValue,
        cgstAmount: advances.summary.taxDueOnAdvances.cgstAmount,
        sgstAmount: advances.summary.taxDueOnAdvances.sgstAmount,
        igstAmount: advances.summary.taxDueOnAdvances.igstAmount,
        cessAmount: 0,
        source: 'A-10 Advances & Advance Adjustments',
      },
      {
        ref: '4I',
        label: 'Credit notes issued against 4A–4F',
        taxableValue: notes.summary.credit.taxableValue,
        cgstAmount: notes.summary.credit.cgstAmount,
        sgstAmount: notes.summary.credit.sgstAmount,
        igstAmount: notes.summary.credit.igstAmount,
        cessAmount: 0,
        source: 'A-6 Credit and Debit Note Register (figures are negative)',
      },
      {
        ref: '4J',
        label: 'Debit notes issued against 4A–4F',
        taxableValue: notes.summary.debit.taxableValue,
        cgstAmount: notes.summary.debit.cgstAmount,
        sgstAmount: notes.summary.debit.sgstAmount,
        igstAmount: notes.summary.debit.igstAmount,
        cessAmount: 0,
        source: 'A-6 Credit and Debit Note Register',
      },
    ],
  };

  // Table 5 — outward supplies on which tax is NOT payable. For a hospital this
  // is the large number: treatment is exempt, and it drives the Rule 42
  // reversal that decides how much input credit the hospital keeps.
  const table5 = {
    label: 'Table 5 — Outward supplies on which tax is not payable',
    rows: [
      {
        ref: '5D',
        label: 'Exempted',
        taxableValue: exempt.exempt.taxableValue,
        source: 'A-7 Exempt, Nil-rated and Non-GST Turnover',
      },
      {
        ref: '5E',
        label: 'Nil rated',
        taxableValue: exempt.nilRated.taxableValue,
        source: 'A-7 Exempt, Nil-rated and Non-GST Turnover',
      },
      {
        ref: '5F',
        label: 'Non-GST supply',
        taxableValue: exempt.nonGst.taxableValue,
        source: 'A-7 Exempt, Nil-rated and Non-GST Turnover',
      },
    ],
    total: r2(
      exempt.exempt.taxableValue + exempt.nilRated.taxableValue + exempt.nonGst.taxableValue,
    ),
  };

  // Table 6 — ITC availed. Table 7 — ITC reversed.
  const table6 = {
    label: 'Table 6 — Input tax credit availed',
    rows: [
      {
        ref: '6A',
        label: 'Total ITC as per the purchase register',
        amount: itc.totals.taxAmount,
        cgstAmount: itc.totals.cgstAmount,
        sgstAmount: itc.totals.sgstAmount,
        igstAmount: itc.totals.igstAmount,
        source: 'B-1 GST Purchase Register',
      },
      {
        ref: '6B',
        label: 'ITC on inward supplies (other than imports and reverse charge)',
        amount: itc.totals.taxAmount,
        source: 'B-2 Input Tax Credit Summary — gross',
      },
    ],
    /** What the hospital actually kept, from the same ladder B-2 prints. */
    ladder: itc.ladder,
  };

  const table7 = {
    label: 'Table 7 — Input tax credit reversed',
    rows: [
      {
        ref: '7C',
        label: 'Rule 42 — inputs attributable to exempt supplies',
        amount: reversal.reversal.d1,
        source: 'B-3 Rule 42/43 Working, step D1',
      },
      {
        ref: '7D',
        label: 'Rule 43 — capital goods attributable to exempt supplies',
        amount: 0,
        source:
          'B-3 does not compute a Rule 43 schedule — capital goods are not recorded as such in this system',
      },
      {
        ref: '7E',
        label: 'Deemed 5% for non-business use',
        amount: reversal.reversal.d2,
        source: 'B-3 Rule 42/43 Working, step D2',
      },
    ],
    total: reversal.reversal.total,
  };

  const table9 = {
    label: 'Table 9 — Tax paid as declared in returns filed during the year',
    /**
     * Null, not zero. What was actually PAID is entered on the portal in
     * GSTR-3B and settled out of the electronic cash and credit ledgers —
     * neither of which exists in this system. Reporting a zero would read as
     * "nothing was paid", which is a different and much more alarming
     * statement than "we do not hold this figure".
     */
    taxPayable: gstr3b.outwardTaxable,
    taxPaid: null as null,
    note:
      'Tax actually paid is not held here — it is declared and settled on the portal in GSTR-3B. ' +
      'The payable column is this system’s own computation for the year, for the accountant to ' +
      'check the twelve filed returns against.',
  };

  const table17 = {
    label: 'Table 17 — HSN-wise summary of outward supplies',
    rows: hsn.byCode,
    unclassified: hsn.unclassified,
    reportingDigits: hsn.reportingDigits,
  };

  return {
    financialYear: window.financialYear,
    period: { from: window.from, to: window.to },
    tables: { table4, table5, table6, table7, table9, table17 },
    turnover: {
      grossOutward: r2(registerTotals.taxableValue + registerTotals.taxAmount),
      taxableTurnover: exempt.taxable.taxableValue,
      exemptTurnover: exempt.exemptTurnover,
      totalTurnover: exempt.totalTurnover,
      exemptRatioPercent: exempt.exemptRatio,
    },
    documents: {
      invoices: new Set(register.rows.map((l) => l.billId)).size,
      lines: register.rows.length,
      creditNotes: notes.rows.length,
      purchases: purchases.rows.length,
    },
    rateWise: rateWise.byRate,
    /** A-1 is the register everything folds; the annual view must tie to it. */
    reconciliation: {
      registerTaxableValue: registerTotals.taxableValue,
      registerTaxAmount: registerTotals.taxAmount,
      /**
       * The annual view against the register it is folded from.
       *
       * Summed by TREATMENT, which partitions the register exactly once —
       * taxable, exempt, nil-rated, non-GST, zero-rated and unclassified are
       * mutually exclusive. The B2B/B2C cut does not partition it: both cover
       * only the taxable slice, so adding them to the exempt total left every
       * unclassified line out and the check never agreed.
       */
      partsTaxableValue: r2(
        exempt.taxable.taxableValue +
          table5.total +
          exempt.zeroRated.taxableValue +
          exempt.unclassified.taxableValue,
      ),
      agrees:
        Math.abs(
          r2(
            exempt.taxable.taxableValue +
              table5.total +
              exempt.zeroRated.taxableValue +
              exempt.unclassified.taxableValue,
          ) - registerTotals.taxableValue,
        ) < 0.01,
    },
    notes: [
      'Every figure here is the monthly report run once over the whole financial year — the same folds of the same register — so the annual return cannot disagree with the twelve returns it summarises.',
      'Tax paid and ITC claimed are entered on the portal and are not held in this system. They are shown as blank rather than as zero.',
      'This is a working for the accountant to file from. It does not file anything.',
    ],
  };
}

/**
 * GSTR-9C — the reconciliation the accountant needs, not a certified statement.
 *
 * 9C reconciles the turnover in the audited accounts against the turnover
 * declared in the annual return. This system holds one side of that: what it
 * billed. The other side — the audited financial statements — lives with the
 * hospital's accountant, so what is useful here is the books side laid out in
 * 9C's own order with every difference this system CAN see already named.
 *
 * Anything it cannot see is listed as an unreconciled item for the accountant
 * to fill, rather than silently omitted.
 */
export async function getGstr9cReconciliation(
  tenantId: string,
  query: { financialYear?: string; auditedTurnover?: number } = {},
) {
  const window = financialYearWindow(query.financialYear);
  const q = { from: window.from, to: window.to };

  const [exempt, notes, advances, register, itc] = await Promise.all([
    getExemptTurnover(tenantId, q),
    getCreditNoteRegister(tenantId, q),
    getAdvancesReport(tenantId, q),
    getSalesRegister(tenantId, q),
    getItcSummary(tenantId, q),
  ]);

  const billedTurnover = exempt.totalTurnover;
  const creditNoteValue = notes.summary.credit.taxableValue; // stored negative
  const unbilledAdvances = advances.summary.balanceOutstanding;

  const audited = Number.isFinite(Number(query.auditedTurnover))
    ? r2(Number(query.auditedTurnover))
    : null;

  const declared = r2(billedTurnover);
  const difference = audited == null ? null : r2(audited - declared);

  return {
    financialYear: window.financialYear,
    period: { from: window.from, to: window.to },
    /** Table 5 — reconciliation of gross turnover. */
    turnover: {
      auditedTurnover: audited,
      auditedTurnoverSource:
        audited == null
          ? 'Not supplied. This comes from the audited financial statements, which are not held in this system — pass it in to complete the reconciliation.'
          : 'Supplied by the accountant',
      declaredTurnover: declared,
      declaredTurnoverSource: 'A-7 Exempt, Nil-rated and Non-GST Turnover — total turnover for the year',
      adjustments: [
        {
          label: 'Credit notes issued during the year',
          amount: creditNoteValue,
          source: 'A-6 Credit and Debit Note Register',
        },
        {
          label: 'Advances received but not yet invoiced at year end',
          amount: unbilledAdvances,
          source: 'A-10 Advances & Advance Adjustments — balance outstanding',
        },
      ],
      unreconciledDifference: difference,
    },
    /** Table 7 — reconciliation of taxable turnover. */
    taxableTurnover: {
      exempt: exempt.exempt.taxableValue,
      nilRated: exempt.nilRated.taxableValue,
      nonGst: exempt.nonGst.taxableValue,
      zeroRated: exempt.zeroRated.taxableValue,
      taxable: exempt.taxable.taxableValue,
      unclassified: exempt.unclassified.taxableValue,
    },
    /** Table 12 — reconciliation of input tax credit. */
    inputTaxCredit: {
      perBooks: itc.totals.taxAmount,
      perBooksSource: 'B-1 GST Purchase Register',
      ladder: itc.ladder,
      claimedInReturns: null as null,
      claimedInReturnsSource:
        'Entered on the portal in GSTR-3B, not held here. Supply it to complete Table 12.',
    },
    /** What this system cannot see, said plainly rather than left blank. */
    unreconciled: [
      'Income that never became a hospital bill — grants, interest, other income in the financial statements.',
      'Purchases that do not arrive as a stock batch — equipment, rent, utilities, professional services. See the coverage note on every B report.',
      'Tax and input credit actually paid or claimed on the portal.',
      'Capital goods and the Rule 43 schedule, which this system does not record as such.',
    ],
    lines: register.rows.length,
    notes: [
      'This is the books side of a 9C reconciliation, laid out in the form’s own order. It is a working for the accountant, not a certified statement, and it certifies nothing.',
    ],
  };
}
