// ---------------------------------------------------------------------------
// A-6, A-8 and A-9 — the credit-note register and the return-ready views.
//
// A-8 and A-9 are not new data. They are the SAME figures A-1 produced,
// arranged the way the government form expects, so the accountant checks a
// screen that looks like the return instead of assembling it in a spreadsheet.
//
// Both carry a reconciliation against A-1 and say plainly when it does not
// agree. A return view that quietly disagrees with the register behind it is
// worse than no return view: the accountant files the number on the screen.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import {
  getSalesRegister,
  getExemptTurnover,
  totalOf,
  type SalesReportQuery,
  type TaxTotals,
} from './gst-reports.sales';

const n = (v: unknown) => r2(Number(v ?? 0));

/**
 * A-6 — Credit and Debit Note Register.
 *
 * Every note, with the invoice it reverses. GSTR-1 Table 9B reports them
 * against the original document, so a note whose bill was never issued a
 * number is flagged: it cannot be reported, and somebody has to know.
 */
export async function getCreditNoteRegister(tenantId: string, query: SalesReportQuery = {}) {
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;

  const notes = await prisma.creditNote.findMany({
    where: {
      tenantId,
      ...(from || to ? { issueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { issueDate: 'asc' },
    include: {
      items: true,
      bill: {
        select: {
          billNumber: true, invoiceNumber: true, gstDocumentType: true, billDate: true,
          status: true,
          // Whether the invoice this note reverses still has lines. Cancelling
          // a counter sale removes them, and a supply that is no longer in the
          // register cannot be taken out of it a second time.
          _count: { select: { billItems: true } },
        },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      issuer: { select: { firstName: true, lastName: true } },
    },
  });

  const rows = notes.map((c) => ({
    id: c.id,
    creditNoteNumber: c.creditNoteNumber,
    /**
     * 'credit' or 'debit'. This register is called the Credit AND Debit Note
     * Register and showed only one of them — and the reason it showed only one
     * is that the system could not raise the other. GSTR-1 Table 9B reports
     * them in the same block but distinguishes them, and an auditor reading a
     * register that silently omits a document type will not know it is missing.
     */
    noteType: String(c.noteType ?? 'credit'),
    issueDate: c.issueDate,
    financialYear: c.financialYear,
    reason: c.reason,
    reasonNote: c.reasonNote,
    // The document being reversed. Table 9B keys on the ORIGINAL invoice.
    againstInvoiceNumber: c.bill?.invoiceNumber ?? null,
    againstBillNumber: c.bill?.billNumber ?? null,
    againstBillDate: c.bill?.billDate ?? null,
    againstDocumentType: c.bill?.gstDocumentType ?? null,
    patientId: c.patientId,
    patientName: c.patient ? fullName(c.patient) : null,
    mrn: c.patient?.mrn ?? null,
    recipientGstin: c.recipientGstin,
    placeOfSupplyStateCode: c.placeOfSupplyStateCode,
    taxableValue: n(c.taxableValue),
    cgstAmount: n(c.cgstAmount),
    sgstAmount: n(c.sgstAmount),
    igstAmount: n(c.igstAmount),
    cessAmount: n(c.cessAmount),
    taxAmount: n(c.taxAmount),
    totalAmount: n(c.totalAmount),
    issuedBy: c.issuer ? fullName(c.issuer) : null,
    /**
     * Section 34 gives until 30 November following the end of the financial
     * year. A note issued after that reverses the money but NOT the tax, so it
     * must not be netted off in the return.
     */
    withinTimeLimit: c.withinTimeLimit,
    lineCount: c.items.length,
    /**
     * The line detail A-6's own column list asks for — "description, HSN/SAC,
     * quantity, taxable value reversed" — and which the GSTR-1 builder needs to
     * declare a real rate per line. The register loaded the items and read only
     * their count, so the JSON had to hardcode 0% on every note.
     */
    items: c.items.map((i) => ({
      description: i.description,
      hsnSacCode: i.hsnSacCode,
      quantity: i.quantity,
      taxPercent: n(i.taxPercent),
      taxableValue: n(i.taxableValue),
      cgstAmount: n(i.cgstAmount),
      sgstAmount: n(i.sgstAmount),
      igstAmount: n(i.igstAmount),
      cessAmount: n(i.cessAmount),
      taxAmount: n(i.taxAmount),
    })),
    /** No number on the original means Table 9B has nothing to key on. */
    reportable: !!c.bill?.invoiceNumber,
    /**
     * Whether the supply being reversed is still in the outward register.
     *
     * Voiding a counter sale deletes the invoice's bill items and zeroes its
     * totals, so the sale drops out of A-1 and A-7 on its own. Its credit note
     * still exists — correctly, because a cancelled invoice is credited, never
     * erased — but netting that note off the outward figure as well would
     * subtract the same supply twice.
     */
    originalInRegister: !(
      c.bill && String(c.bill.status) === 'cancelled' && c.bill._count.billItems === 0
    ),
  }));

  const sum = (list: typeof rows, k: keyof (typeof rows)[number]) =>
    r2(list.reduce((t, x) => t + Number(x[k] ?? 0), 0));

  const b2b = rows.filter((r) => !!r.recipientGstin);
  const b2c = rows.filter((r) => !r.recipientGstin);
  const creditRows = rows.filter((r) => r.noteType !== 'debit');
  const debitRows = rows.filter((r) => r.noteType === 'debit');

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows,
    summary: {
      count: rows.length,
      taxableValue: sum(rows, 'taxableValue'),
      cgstAmount: sum(rows, 'cgstAmount'),
      sgstAmount: sum(rows, 'sgstAmount'),
      igstAmount: sum(rows, 'igstAmount'),
      taxAmount: sum(rows, 'taxAmount'),
      totalAmount: sum(rows, 'totalAmount'),
      /** Table 9B splits registered from unregistered recipients. */
      b2b: { count: b2b.length, taxableValue: sum(b2b, 'taxableValue'), taxAmount: sum(b2b, 'taxAmount') },
      b2c: { count: b2c.length, taxableValue: sum(b2c, 'taxableValue'), taxAmount: sum(b2c, 'taxAmount') },
      /** Issued past the section 34 deadline: money back, tax not reversed. */
      outsideTimeLimit: rows.filter((r) => !r.withinTimeLimit).length,
      /** Against a bill that was never issued a number — cannot be filed. */
      notReportable: rows.filter((r) => !r.reportable).length,
      /** Against a voided invoice whose lines are gone — already out of A-1. */
      originalNotInRegister: rows.filter((r) => !r.originalInRegister).length,
      /**
       * The two document types, separately — which is what makes this a Credit
       * AND Debit Note Register rather than a credit note register wearing the
       * wrong title. A credit note's figures are negative and a debit note's
       * positive, so summing them together would net two opposite corrections
       * into one meaningless number.
       */
      credit: {
        count: creditRows.length,
        taxableValue: sum(creditRows, 'taxableValue'),
        cgstAmount: sum(creditRows, 'cgstAmount'),
        sgstAmount: sum(creditRows, 'sgstAmount'),
        igstAmount: sum(creditRows, 'igstAmount'),
        taxAmount: sum(creditRows, 'taxAmount'),
        totalAmount: sum(creditRows, 'totalAmount'),
      },
      debit: {
        count: debitRows.length,
        taxableValue: sum(debitRows, 'taxableValue'),
        cgstAmount: sum(debitRows, 'cgstAmount'),
        sgstAmount: sum(debitRows, 'sgstAmount'),
        igstAmount: sum(debitRows, 'igstAmount'),
        taxAmount: sum(debitRows, 'taxAmount'),
        totalAmount: sum(debitRows, 'totalAmount'),
      },
    },
  };
}

// ── The return-ready views ─────────────────────────────────────────────────

/** Sum of the parts against the whole, so a view can say when it does not tie. */
function reconcile(parts: TaxTotals[], whole: TaxTotals) {
  const add = (k: keyof TaxTotals) => r2(parts.reduce((t, p) => t + Number(p[k]), 0));
  const diff = {
    taxableValue: r2(add('taxableValue') - whole.taxableValue),
    taxAmount: r2(add('taxAmount') - whole.taxAmount),
  };
  return {
    ...diff,
    // Anything at all. A rupee out is still a return that does not tie, and the
    // accountant has to see it BEFORE filing rather than hear it from a notice.
    agrees: Math.abs(diff.taxableValue) < 0.01 && Math.abs(diff.taxAmount) < 0.01,
  };
}

/**
 * A-8 — GSTR-1, every table filled in and ready to check.
 *
 * Tables 4 (B2B), 5 and 7 (B2C), 8 (exempt / nil / non-GST), 9B (credit notes),
 * 11 (advances) and 12 (HSN). Built by folding A-1 the way each table asks for
 * it, then reconciled back against A-1 in full.
 */
export async function getGstr1Summary(
  tenantId: string,
  query: SalesReportQuery & { sixDigit?: boolean } = {},
) {
  const { getAdvancesReport } = await import('./gst-reports.service');
  const { getHsnSummary } = await import('./gst-reports.sales');
  const [{ period, rows }, exempt, notes, advances, hsn] = await Promise.all([
    getSalesRegister(tenantId, query),
    getExemptTurnover(tenantId, query),
    getCreditNoteRegister(tenantId, query),
    getAdvancesReport(tenantId, { from: query.from, to: query.to }),
    getHsnSummary(tenantId, query),
  ]);

  const taxableRows = rows.filter((l) => l.gstTreatment === 'taxable');
  const b2bRows = taxableRows.filter((l) => !!l.recipientGstin);
  const b2cRows = taxableRows.filter((l) => !l.recipientGstin);

  const table4 = totalOf(b2bRows);
  const table5and7 = totalOf(b2cRows);
  const table8 = {
    exempt: exempt.exempt.taxableValue,
    nilRated: exempt.nilRated.taxableValue,
    nonGst: exempt.nonGst.taxableValue,
    total: exempt.exemptTurnover,
  };

  return {
    period,
    tables: {
      /** 4 — supplies to registered persons. */
      b2b: table4,
      /** 5 and 7 — supplies to unregistered persons. */
      b2c: table5and7,
      /** 8 — nil-rated, exempt and non-GST outward supplies. */
      exemptTurnover: table8,
      /** 9B — credit and debit notes. */
      creditNotes: notes.summary,
      /** 11A/11B — tax on advances received, and advances adjusted. */
      advances: {
        received: advances.summary.taxDueOnAdvances,
        adjusted: advances.summary.adjustedAgainstInvoices,
      },
      /** 12 — HSN-wise summary, at the digit length the turnover obliges. */
      hsn: hsn.byCode,
      hsnUnclassified: hsn.unclassified,
    },
    /**
     * Whether the tables add back up to the register. Both halves of the
     * taxable supply plus the exempt turnover must equal A-1 — if they do not,
     * a line has a treatment nothing accounts for.
     */
    reconciliation: {
      taxable: reconcile([table4, table5and7], totalOf(taxableRows)),
      register: reconcile(
        [
          totalOf(taxableRows),
          exempt.exempt, exempt.nilRated, exempt.nonGst, exempt.zeroRated,
          exempt.unclassified,
        ],
        totalOf(rows),
      ),
      unclassifiedLines: exempt.unclassified.count,
    },
  };
}

/**
 * A-9 — GSTR-3B: outward liability, input credit, and the net payable.
 *
 * 3.1(a) is the taxable outward supply and its tax; 3.1(c) and (e) are the
 * exempt and non-GST supplies. Table 4 is the input credit — which is the
 * purchase side, so it is taken from B-2 and reduced by the Rule 42/43
 * reversal from B-3 rather than assumed to be fully available.
 */
export async function getGstr3bSummary(tenantId: string, query: SalesReportQuery = {}) {
  const [exempt, notes, itc] = await Promise.all([
    getExemptTurnover(tenantId, query),
    getCreditNoteRegister(tenantId, query),
    (await import('./gst-reports.purchase')).getItcReversalWorking(tenantId, query),
  ]);

  // A credit note reduces the month's outward liability. Two filters decide
  // which ones actually do:
  //
  //   withinTimeLimit    — section 34 gives until 30 November following the end
  //                        of the financial year. Past it the money goes back
  //                        and the tax does not.
  //   originalInRegister — the note may only take a supply OUT of the outward
  //                        figures if that supply is IN them. Cancelling a
  //                        counter sale deletes the invoice's lines, so the
  //                        supply has already left A-1; netting the note off as
  //                        well would remove it twice.
  const reversible = notes.rows.filter((r) => r.withinTimeLimit && r.originalInRegister);

  // A note's figures are stored NEGATIVE — it mirrors the bill's lines with the
  // sign flipped, which is what Table 9B and the ledger both want. So the
  // reversal is ADDED to the outward figure. Subtracting it, as this did, moved
  // the liability the wrong way by twice the value of every note: this
  // hospital's year read ₹10,790.60 taxable where ₹9,860.90 was the honest
  // figure, and the error grows with every credit note raised.
  const add = (k: 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'taxAmount') =>
    r2(exempt.taxable[k] + r2(reversible.reduce((t, r) => t + r[k], 0)));

  const outward = {
    taxableValue: add('taxableValue'),
    cgstAmount: add('cgstAmount'),
    sgstAmount: add('sgstAmount'),
    igstAmount: add('igstAmount'),
    taxAmount: add('taxAmount'),
  };

  const netItc = itc.netCreditAvailable;

  // ── The set-off, head by head ────────────────────────────────────────────
  //
  // GSTR-3B is not one subtraction. The electronic credit ledger holds three
  // separate balances and the law fixes the order they may be used in: IGST
  // credit first against IGST, then against CGST, then against SGST; CGST
  // credit only against CGST; SGST credit only against SGST. Netting the three
  // together, as this did, can show nothing payable while the hospital in fact
  // owes SGST it has no SGST credit for.
  const ledger = { ...itc.netCreditByHead };
  const due = {
    igst: outward.igstAmount,
    cgst: outward.cgstAmount,
    sgst: outward.sgstAmount,
  };
  const use = (from: 'igst' | 'cgst' | 'sgst', against: 'igst' | 'cgst' | 'sgst') => {
    const amount = r2(Math.min(ledger[from], due[against]));
    if (amount <= 0) return 0;
    ledger[from] = r2(ledger[from] - amount);
    due[against] = r2(due[against] - amount);
    return amount;
  };
  const setOff = {
    igstFromIgst: use('igst', 'igst'),
    cgstFromIgst: use('igst', 'cgst'),
    sgstFromIgst: use('igst', 'sgst'),
    cgstFromCgst: use('cgst', 'cgst'),
    sgstFromSgst: use('sgst', 'sgst'),
  };
  const payableByHead = { igst: due.igst, cgst: due.cgst, sgst: due.sgst };
  const cashPayable = r2(payableByHead.igst + payableByHead.cgst + payableByHead.sgst);
  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    /** 3.1(a) — outward taxable supplies, net of credit notes. */
    outwardTaxable: outward,
    /** 3.1(c) — other exempt and nil-rated outward supplies. */
    outwardExempt: r2(exempt.exempt.taxableValue + exempt.nilRated.taxableValue),
    /** 3.1(e) — non-GST outward supplies. */
    outwardNonGst: exempt.nonGst.taxableValue,
    /** 4 — input tax credit, after the Rule 42/43 reversal. */
    inputTaxCredit: {
      available: itc.creditAvailable,
      reversed: itc.reversal.total,
      net: netItc,
    },
    /**
     * What is actually payable in cash once credit is set off — head by head,
     * in the statutory order.
     *
     * This used to be one subtraction of one total from another, which can show
     * nothing payable while the hospital owes SGST it has no SGST credit for.
     */
    setOff,
    payableByHead,
    creditCarriedForwardByHead: ledger,
    netTaxPayable: cashPayable,
    creditCarriedForward: r2(ledger.igst + ledger.cgst + ledger.sgst),
    /** Notes that did NOT reduce the liability, and why. */
    creditNotesExcluded: notes.rows.length - reversible.length,
    creditNotesOutsideTimeLimit: notes.rows.filter((r) => !r.withinTimeLimit).length,
    creditNotesOriginalNotInRegister: notes.rows.filter((r) => !r.originalInRegister).length,
  };
}
