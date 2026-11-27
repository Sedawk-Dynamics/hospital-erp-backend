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
 * The kind of supply a credit/debit note line reverses.
 *
 * A note must reduce the SAME kind of supply as the invoice it reverses. A note
 * against an exempt bill (tax ₹0) used to be netted off TAXABLE outward supplies,
 * which pushed GSTR-3B 3.1(a) and GSTR-1 Table 9B negative on a hospital whose
 * sales are almost all exempt (gap item 261 / GST bug G-N1).
 *
 * Order of evidence: the treatment stored on the note line, then the treatment
 * of the bill line it points at, then the tax on the line itself.
 */
export type NoteTreatment = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst' | 'zero_rated';
const NOTE_TREATMENTS: readonly NoteTreatment[] = ['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated'];

function noteLineTreatment(
  stored: string | null | undefined,
  fromBillLine: string | null | undefined,
  taxPercent: unknown,
  taxAmount: unknown,
): NoteTreatment {
  for (const t of [stored, fromBillLine]) {
    if (t && (NOTE_TREATMENTS as readonly string[]).includes(t)) return t as NoteTreatment;
  }
  return Number(taxPercent ?? 0) !== 0 || Number(taxAmount ?? 0) !== 0 ? 'taxable' : 'exempt';
}

interface NoteBucket {
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
  totalAmount: number;
}
const emptyBucket = (): NoteBucket => ({
  taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0, taxAmount: 0, totalAmount: 0,
});
const BUCKET_KEYS = Object.keys(emptyBucket()) as (keyof NoteBucket)[];
const addBucket = (a: NoteBucket, b: Partial<Record<keyof NoteBucket, unknown>>): NoteBucket => {
  const out = { ...a };
  for (const k of BUCKET_KEYS) out[k] = r2(out[k] + Number(b[k] ?? 0));
  return out;
};

/** Whether a bucket carries any value at all. */
export const bucketHasValue = (b: NoteBucket) => BUCKET_KEYS.some((k) => b[k] !== 0);

/** Supplies whose notes belong in 3.1(a), Table 9B and GSTR-9 4I/4J. */
export const isTaxableSide = (t: NoteTreatment) => t === 'taxable' || t === 'zero_rated';

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
      items: { include: { billItem: { select: { gstTreatment: true } } } },
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

  const rows = notes.map((c) => {
    // Split the note's value by the kind of supply each line reverses. A legacy
    // note with no lines is classed as a whole from its own header tax.
    const byTreatment = Object.fromEntries(
      NOTE_TREATMENTS.map((t) => [t, emptyBucket()]),
    ) as Record<NoteTreatment, NoteBucket>;
    if (c.items.length) {
      for (const i of c.items) {
        const t = noteLineTreatment(i.gstTreatment, i.billItem?.gstTreatment, i.taxPercent, i.taxAmount);
        byTreatment[t] = addBucket(byTreatment[t], i);
      }
    } else {
      const t = noteLineTreatment(null, null, null, c.taxAmount);
      byTreatment[t] = addBucket(byTreatment[t], c);
    }
    return { c, byTreatment };
  }).map(({ c, byTreatment }) => ({
    id: c.id,
    /** The note's value split by the treatment of the supply it reverses. */
    byTreatment,
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
      gstTreatment: noteLineTreatment(i.gstTreatment, i.billItem?.gstTreatment, i.taxPercent, i.taxAmount),
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
      /**
       * Credit and debit notes split by the kind of supply they reverse. Only
       * the taxable side reduces taxable outward supplies (3.1(a), Table 9B,
       * GSTR-9 4I/4J); exempt and nil-rated notes reduce Table 8 / 3.1(c) /
       * GSTR-9 5H instead.
       */
      byTreatment: {
        credit: treatmentTotals(creditRows),
        debit: treatmentTotals(debitRows),
      },
      taxableSide: {
        credit: taxableSideTotals(creditRows),
        debit: taxableSideTotals(debitRows),
      },
    },
  };
}

type NoteRow = { byTreatment: Record<NoteTreatment, NoteBucket> };

/** Sum each treatment's bucket across a set of note rows. */
export function treatmentTotals(list: NoteRow[]): Record<NoteTreatment, NoteBucket> {
  return Object.fromEntries(
    NOTE_TREATMENTS.map((t) => [t, list.reduce((acc, r) => addBucket(acc, r.byTreatment[t]), emptyBucket())]),
  ) as Record<NoteTreatment, NoteBucket>;
}

/** The taxable-side portion (taxable + zero-rated) of a set of note rows. */
export function taxableSideTotals(list: NoteRow[]): NoteBucket & { count: number } {
  const t = treatmentTotals(list);
  const bucket = NOTE_TREATMENTS.filter(isTaxableSide).reduce((acc, k) => addBucket(acc, t[k]), emptyBucket());
  const count = list.filter((r) =>
    NOTE_TREATMENTS.some((k) => isTaxableSide(k) && bucketHasValue(r.byTreatment[k])),
  ).length;
  return { ...bucket, count };
}

/**
 * The notes that may reduce the outward figures — ONE selection, used by
 * GSTR-1, GSTR-3B, GSTR-9 and the C-1 liability report alike.
 *
 *   withinTimeLimit    — section 34: past 30 November after the year end the
 *                        money goes back and the tax does not.
 *   originalInRegister — a voided counter sale has already left A-1; netting
 *                        its cancellation note off as well removes it twice.
 *
 * GSTR-1 used to apply neither, so it subtracted every cancelled invoice twice
 * and disagreed with GSTR-3B (gap items 274 / 275).
 */
export function notesThatReduceOutward<T extends { withinTimeLimit: boolean; originalInRegister: boolean }>(
  rows: T[],
): T[] {
  return rows.filter((r) => r.withinTimeLimit && r.originalInRegister);
}

/** Why each note that does NOT reduce the outward figures was left out. */
export function noteExclusions(rows: Array<{ withinTimeLimit: boolean; originalInRegister: boolean }>) {
  return {
    /** Every note left out, for any reason. */
    total: rows.filter((r) => !(r.withinTimeLimit && r.originalInRegister)).length,
    /** Past the section 34 deadline — the only reason that is a warning. */
    outsideTimeLimit: rows.filter((r) => !r.withinTimeLimit).length,
    /** Cancellation of a voided sale already gone from the register — not an error. */
    originalNotInRegister: rows.filter((r) => r.withinTimeLimit && !r.originalInRegister).length,
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

  // Notes split by what they reverse (gap item 261). Taxable-side notes go in
  // Table 9B; notes against exempt / nil-rated / non-GST supplies reduce Table 8.
  // Only the notes that may reduce the outward figures, chosen exactly as
  // GSTR-3B chooses them (gap items 274 / 275).
  const applied = notesThatReduceOutward(notes.rows);
  const appliedCredit = applied.filter((r) => r.noteType !== 'debit');
  const appliedDebit = applied.filter((r) => r.noteType === 'debit');
  const ts = { credit: taxableSideTotals(appliedCredit), debit: taxableSideTotals(appliedDebit) };
  const nt = { credit: treatmentTotals(appliedCredit), debit: treatmentTotals(appliedDebit) };
  const noteOn = (t: NoteTreatment) => r2(nt.credit[t].taxableValue + nt.debit[t].taxableValue);
  const table8 = {
    exempt: r2(exempt.exempt.taxableValue + noteOn('exempt')),
    nilRated: r2(exempt.nilRated.taxableValue + noteOn('nil_rated')),
    nonGst: r2(exempt.nonGst.taxableValue + noteOn('non_gst')),
    total: r2(exempt.exemptTurnover + noteOn('exempt') + noteOn('nil_rated') + noteOn('non_gst')),
    /** Value of credit/debit notes against these supplies, already netted above (negative = reduction). */
    notesNetted: r2(noteOn('exempt') + noteOn('nil_rated') + noteOn('non_gst')),
  };
  const table9b = {
    ...notes.summary,
    count: ts.credit.count + ts.debit.count,
    taxableValue: r2(ts.credit.taxableValue + ts.debit.taxableValue),
    cgstAmount: r2(ts.credit.cgstAmount + ts.debit.cgstAmount),
    sgstAmount: r2(ts.credit.sgstAmount + ts.debit.sgstAmount),
    igstAmount: r2(ts.credit.igstAmount + ts.debit.igstAmount),
    taxAmount: r2(ts.credit.taxAmount + ts.debit.taxAmount),
    totalAmount: r2(ts.credit.totalAmount + ts.debit.totalAmount),
    /** Notes in the register that 9B does NOT carry, and why. */
    excluded: noteExclusions(notes.rows),
  };

  // GSTR-1 against GSTR-3B 3.1(a). Built from the GSTR-1 side — Tables 4, 5/7
  // and the taxable part of 9B — and compared to the 3B figure computed the
  // way 3B computes it. The two returns must declare the same outward taxable
  // supply; when they do not, the accountant sees it here first (gap item 274).
  const g1Taxable = r2(table4.taxableValue + table5and7.taxableValue
    + nt.credit.taxable.taxableValue + nt.debit.taxable.taxableValue);
  const g1Tax = r2(table4.taxAmount + table5and7.taxAmount
    + nt.credit.taxable.taxAmount + nt.debit.taxable.taxAmount);
  const g3b = outwardTaxableNet(exempt.taxable, applied);
  const vs3b = {
    gstr1TaxableValue: g1Taxable,
    gstr1TaxAmount: g1Tax,
    gstr3bTaxableValue: g3b.taxableValue,
    gstr3bTaxAmount: g3b.taxAmount,
    taxableValue: r2(g1Taxable - g3b.taxableValue),
    taxAmount: r2(g1Tax - g3b.taxAmount),
    agrees: Math.abs(g1Taxable - g3b.taxableValue) < 0.01 && Math.abs(g1Tax - g3b.taxAmount) < 0.01,
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
      /** 9B — credit and debit notes against TAXABLE supplies only. */
      creditNotes: table9b,
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
      /** GSTR-1 (4 + 5/7 + 9B) against GSTR-3B 3.1(a). */
      gstr3b: vs3b,
    },
    /** The notes netted into 9B / Table 8, for drill-down from those totals. */
    creditNotesApplied: applied.map((r) => ({
      id: r.id, creditNoteNumber: r.creditNoteNumber, noteType: r.noteType, issueDate: r.issueDate,
      againstInvoiceNumber: r.againstInvoiceNumber, patientName: r.patientName,
      taxableValue: r.taxableValue, taxAmount: r.taxAmount, totalAmount: r.totalAmount,
      taxableSide: r2(r.byTreatment.taxable.taxableValue + r.byTreatment.zero_rated.taxableValue),
    })),
  };
}

/**
 * GSTR-3B 3.1(a): taxable outward supplies net of the notes that reduce them.
 *
 * One function for 3B, the GSTR-1 tie-back and the GSTR-9 monthly check, so
 * the three cannot compute "outward taxable" three different ways.
 */
export function outwardTaxableNet(
  taxable: Pick<TaxTotals, 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'taxAmount'>,
  appliedNotes: NoteRow[],
) {
  const reversed = treatmentTotals(appliedNotes);
  const add = (k: 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'taxAmount') =>
    r2(taxable[k] + reversed.taxable[k]);
  return {
    taxableValue: add('taxableValue'),
    cgstAmount: add('cgstAmount'),
    sgstAmount: add('sgstAmount'),
    igstAmount: add('igstAmount'),
    taxAmount: add('taxAmount'),
  };
}

/**
 * GSTR-3B 3.2 — inter-State taxable supplies to unregistered persons, per place
 * of supply, net of the notes against them. Since #265 the only bills that can
 * be here are goods shipped out of the state (and any issued before it).
 */
export function interStateToUnregistered(
  rows: Array<{
    isInterState: boolean; recipientGstin: string | null; gstTreatment: string | null;
    placeOfSupplyStateCode: string | null; taxableValue: number; igstAmount: number;
  }>,
  appliedNotes: Array<{
    recipientGstin: string | null; placeOfSupplyStateCode: string | null;
    byTreatment: Record<NoteTreatment, NoteBucket>;
  }>,
) {
  const byPos = new Map<string, { taxableValue: number; igstAmount: number }>();
  const add = (pos: string | null, taxableValue: number, igstAmount: number) => {
    const cur = byPos.get(pos ?? '') ?? { taxableValue: 0, igstAmount: 0 };
    cur.taxableValue = r2(cur.taxableValue + taxableValue);
    cur.igstAmount = r2(cur.igstAmount + igstAmount);
    byPos.set(pos ?? '', cur);
  };
  for (const l of rows) {
    if (l.isInterState && !l.recipientGstin && l.gstTreatment === 'taxable') {
      add(l.placeOfSupplyStateCode, l.taxableValue, l.igstAmount);
    }
  }
  for (const note of appliedNotes) {
    const t = note.byTreatment.taxable;
    // The note mirrors the document's split, so IGST on it IS the inter-State flag.
    if (!note.recipientGstin && t.igstAmount !== 0) add(note.placeOfSupplyStateCode, t.taxableValue, t.igstAmount);
  }
  return [...byPos]
    .map(([placeOfSupplyStateCode, v]) => ({ placeOfSupplyStateCode: placeOfSupplyStateCode || null, ...v }))
    .sort((a, b) => String(a.placeOfSupplyStateCode).localeCompare(String(b.placeOfSupplyStateCode)));
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
  const [exempt, notes, itc, register] = await Promise.all([
    getExemptTurnover(tenantId, query),
    getCreditNoteRegister(tenantId, query),
    (await import('./gst-reports.purchase')).getItcReversalWorking(tenantId, query),
    getSalesRegister(tenantId, query),
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
  const reversible = notesThatReduceOutward(notes.rows);

  // A note's figures are stored NEGATIVE — it mirrors the bill's lines with the
  // sign flipped, which is what Table 9B and the ledger both want. So the
  // reversal is ADDED to the outward figure. Subtracting it, as this did, moved
  // the liability the wrong way by twice the value of every note: this
  // hospital's year read ₹10,790.60 taxable where ₹9,860.90 was the honest
  // figure, and the error grows with every credit note raised.
  //
  // Each note reduces only the KIND of supply it reverses (gap item 261): the
  // taxable part of a note nets off 3.1(a); the part against exempt / nil-rated
  // bills nets off 3.1(c); the non-GST part nets off 3.1(e). A note against an
  // exempt bill used to come off 3.1(a) and drive taxable value negative.
  const reversed = treatmentTotals(reversible);
  const outward = outwardTaxableNet(exempt.taxable, reversible);
  const interStateUnregistered = interStateToUnregistered(register.rows, reversible);

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
    /** 3.2 — of the above, inter-State supplies to unregistered persons, by place of supply. */
    interStateUnregistered,
    /** 3.1(c) — other exempt and nil-rated outward supplies. */
    outwardExempt: r2(
      exempt.exempt.taxableValue + exempt.nilRated.taxableValue
      + reversed.exempt.taxableValue + reversed.nil_rated.taxableValue,
    ),
    /** 3.1(e) — non-GST outward supplies. */
    outwardNonGst: r2(exempt.nonGst.taxableValue + reversed.non_gst.taxableValue),
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
    /**
     * Notes that did NOT reduce the liability, and why. Only the section 34
     * count is a warning: a same-month cancellation of a voided sale is left
     * out because the sale already left the register, not because it was late
     * (gap item 275 — the screen used to call every exclusion "past deadline").
     */
    creditNotesExcluded: notes.rows.length - reversible.length,
    creditNotesOutsideTimeLimit: noteExclusions(notes.rows).outsideTimeLimit,
    creditNotesOriginalNotInRegister: noteExclusions(notes.rows).originalNotInRegister,
    /** The notes netted off, for drill-down from 3.1(a). */
    creditNotesApplied: reversible.map((r) => ({
      id: r.id, creditNoteNumber: r.creditNoteNumber, noteType: r.noteType, issueDate: r.issueDate,
      againstInvoiceNumber: r.againstInvoiceNumber, patientName: r.patientName,
      taxableValue: r.byTreatment.taxable.taxableValue, taxAmount: r.byTreatment.taxable.taxAmount,
      exemptValue: r2(r.byTreatment.exempt.taxableValue + r.byTreatment.nil_rated.taxableValue
        + r.byTreatment.non_gst.taxableValue),
    })),
  };
}
