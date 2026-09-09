// ---------------------------------------------------------------------------
// What makes a printed bill a GST DOCUMENT — one definition, every renderer.
//
// Three of them read this: the IP bill PDF, the OP / counter bill PDF, and the
// bill dialog in the browser (which reads the assembled block off the API
// rather than deriving it again). They have to reach the same answer for the
// same bill: whether this paper carries tax columns at all is not a styling
// choice, it is what kind of document the law says this is.
//
//   - Not registered, or nothing classified → exactly what printed before.
//     A hospital outside GST must not have its paperwork moved by this.
//   - Classified but untaxed → a BILL OF SUPPLY. It carries HSN/SAC (Rule 49)
//     and must NOT carry tax columns: a table of zeroes claims the hospital
//     charged tax it never did.
//   - Anything taxed → the taxable value and the split against each LINE,
//     because Rule 46 wants the rate and the amount of each component against
//     the line it belongs to, not only in a total at the bottom.
//
// CGST/SGST and IGST are mutually exclusive — a supply is either within the
// state or across it — so the inter-State layout spends the freed column on the
// description rather than printing a column of dashes.
// ---------------------------------------------------------------------------

import {
  DOCUMENT_TYPE_LABELS,
  GST_TREATMENT_LABELS,
  stateNameForCode,
  type GstDocumentType,
  type GstTreatment,
} from '../../shared/gst';
import {
  drawSectionHeading,
  drawTable,
  ensureSpace,
  type PdfTheme,
  type TableColumn,
  type TableRow,
} from '../../services/pdf-doc';

import { amountInWords } from '../../shared/amount-in-words';

import QRCode from 'qrcode';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The part of a charge line this module needs. Both bill shapes satisfy it. */
export interface GstLine {
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  /** 'pending' marks a charge accrued but not yet billed. */
  status?: string;
  hsnSac: string | null;
  gstTreatment: string | null;
  /** 'Exempt' / 'Nil rated' / 'Taxable' — the word printed where a rate goes. */
  treatmentLabel: string | null;
  taxRatePercent: number;
  taxableValue: number;
  taxAmount: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  cessAmount: number;
}

/**
 * The taxable value of a line — which an exempt line does not have.
 *
 * Rule 46 asks a tax invoice to state "the taxable value of the supply". An
 * exempt supply has none: it has a VALUE, and that value belongs in the exempt
 * block of the rate-wise summary and in table 8 of the return, not in the
 * column the tax was worked out from.
 *
 * The store keeps `taxableValue` on every line, exempt ones included, and that
 * is deliberate — it is the value of the supply, and the reports partition it
 * by treatment to fill the taxable tables and the exempt table from the one
 * figure. What must not happen is printing it under a heading that says
 * "Taxable" beside a cell that says "Exempt": the document then contradicts
 * itself, and the column no longer sums to the tax below it.
 *
 * Null, not zero, so a caller renders a dash rather than a figure that reads as
 * "this supply was worth nothing".
 */
export function taxableValueOf(l: GstLine): number | null {
  return l.gstTreatment === 'taxable' ? l.taxableValue : null;
}

/** One rate's worth of the bill, for the rate-wise summary Rule 46 asks for. */
export interface BillTaxSummaryRow {
  label: string;
  treatment: string;
  ratePercent: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
}

export interface BillDocumentGst {
  /** False for a hospital not registered under GST: no tax columns at all. */
  registered: boolean;
  /** Read off the bill at finalisation; null while the bill is still a draft. */
  documentType: GstDocumentType | null;
  documentLabel: string | null;
  /** The consecutive numbers allotted for the financial year. */
  invoiceNumbers: string[];
  /**
   * Rule 46A's SECOND document.
   *
   * The combined Invoice-cum-Bill of Supply is allowed only for an
   * unregistered recipient. A registered one with both taxable and exempt lines
   * is owed two documents, and both numbers belong on the paper.
   */
  billOfSupplyNumbers: string[];
  financialYear: string | null;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  supplierStateName: string | null;
  recipientGstin: string | null;
  placeOfSupplyStateCode: string | null;
  placeOfSupplyStateName: string | null;
  isInterState: boolean;
  hasTax: boolean;
  hasClassifiedLines: boolean;
  taxSummary: BillTaxSummaryRow[];
  /** Rule 46(o)'s reverse-charge line and the exemption the rest relies on. */
  notes: string[];
  totals: {
    taxableValue: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    taxAmount: number;
  };
  /**
   * The total tax written out — section 10.1 item 8, which nothing could
   * produce. An amount in words is what stops a printed invoice being altered
   * after it is handed over, which is why every Indian invoice carries one.
   *
   * The grand total's words are NOT here: this block describes the tax, and a
   * document's grand total is its own (an IP stay's is not any one bill's). Each
   * renderer writes its own with the same helper.
   */
  taxAmountInWords: string;
  /**
   * Rule 46 requires a tax invoice for GOODS to be marked ORIGINAL FOR
   * RECIPIENT / DUPLICATE FOR TRANSPORTER / TRIPLICATE FOR SUPPLIER, and for
   * services ORIGINAL / DUPLICATE. Section 10.2's title band asks for it and no
   * document printed one.
   *
   * The copy actually handed to the patient is always the original; the phrase
   * is what changes with the document type.
   */
  copyMarking: string | null;

  /**
   * What the government portal gave back — section 10's "once e-invoicing
   * applies: the IRN and the signed QR code".
   *
   * All null until an Invoice Registration Portal has actually answered. The
   * document simply does not carry the block then, which is correct: an
   * invoice printed with an empty IRN field claims to be an e-invoice and is
   * not one.
   */
  irn: string | null;
  irnAckNo: string | null;
  irnAckDate: Date | null;
  /**
   * The signed QR string, printed as the portal returned it and never
   * re-encoded — the signature is over these exact bytes.
   */
  irnQrPayload: string | null;
}

/** A document with nothing to declare — and what a legacy one falls back to. */
export const NO_GST: BillDocumentGst = {
  registered: false,
  documentType: null,
  documentLabel: null,
  invoiceNumbers: [],
  billOfSupplyNumbers: [],
  financialYear: null,
  supplierGstin: null,
  supplierStateCode: null,
  supplierStateName: null,
  recipientGstin: null,
  placeOfSupplyStateCode: null,
  placeOfSupplyStateName: null,
  isInterState: false,
  hasTax: false,
  taxAmountInWords: '',
  copyMarking: null,
  irn: null,
  irnAckNo: null,
  irnAckDate: null,
  irnQrPayload: null,
  hasClassifiedLines: false,
  taxSummary: [],
  notes: [],
  totals: { taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0, taxAmount: 0 },
};

/** The word a document prints for a treatment, or nothing if it has none. */
export function treatmentLabelFor(treatment: string | null | undefined): string | null {
  if (!treatment) return null;
  return GST_TREATMENT_LABELS[treatment as GstTreatment] ?? treatment;
}

/**
 * Collapse the lines into one row per rate — the rate-wise summary a GST
 * document carries under its charges.
 *
 * Grouped by treatment AND rate, because "exempt" and "taxable at 0%" are
 * different answers that happen to carry the same number, and a return reports
 * them in different boxes. A pending line has no position at all and is left
 * out: it has not been billed, so there is nothing to declare for it yet.
 */
export function buildTaxSummary(lines: GstLine[]): BillTaxSummaryRow[] {
  const rows = new Map<string, BillTaxSummaryRow>();
  for (const l of lines) {
    if (!l.gstTreatment) continue;
    const rate = r2(l.taxRatePercent);
    const key = `${l.gstTreatment}:${rate}`;
    const row = rows.get(key) ?? {
      label: treatmentLabelFor(l.gstTreatment) ?? l.gstTreatment,
      treatment: l.gstTreatment,
      ratePercent: rate,
      taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0,
      cessAmount: 0, taxAmount: 0,
    };
    row.taxableValue = r2(row.taxableValue + l.taxableValue);
    row.cgstAmount = r2(row.cgstAmount + l.cgstAmount);
    row.sgstAmount = r2(row.sgstAmount + l.sgstAmount);
    row.igstAmount = r2(row.igstAmount + l.igstAmount);
    row.cessAmount = r2(row.cessAmount + l.cessAmount);
    row.taxAmount = r2(row.taxAmount + l.taxAmount);
    rows.set(key, row);
  }
  // Highest rate first, so the taxed rows lead and the exempt block closes.
  return [...rows.values()].sort(
    (a, b) => b.ratePercent - a.ratePercent || a.treatment.localeCompare(b.treatment),
  );
}

/** The GST columns of a bill header, however that bill was read. */
export interface GstBillHeader {
  gstDocumentType?: string | null;
  invoiceNumber?: string | null;
  /** Rule 46A's second document, where a registered recipient was owed one. */
  billOfSupplyNumber?: string | null;
  financialYear?: string | null;
  supplierGstin?: string | null;
  supplierStateCode?: string | null;
  recipientGstin?: string | null;
  placeOfSupplyStateCode?: string | null;
  isInterState?: boolean | null;
  irn?: string | null;
  irnAckNo?: string | null;
  irnAckDate?: Date | null;
  irnQrPayload?: string | null;
}

/**
 * Assemble the document's GST identity from the bills it consolidates.
 *
 * A stay can span more than one bill, and each carries its own allotted number.
 * The identity fields come from the first bill that has been ISSUED — they
 * agree across a stay, because they all describe the same supplier and the same
 * patient — while the numbers are listed in full, so the paper names every
 * document it consolidates.
 */
export function buildGstBlock(
  profile: { registered: boolean; gstin?: string | null; stateCode?: string | null },
  headers: GstBillHeader[],
  lines: GstLine[],
): BillDocumentGst {
  const issued = headers.filter((b) => b.invoiceNumber);
  // The second document, where a registered recipient was owed one. Both
  // numbers belong on the paper: the taxable lines are reported under the
  // invoice and the exempt ones under the bill of supply, and a reader has to
  // be able to see which is which.
  const billsOfSupply = headers
    .map((b) => (b as { billOfSupplyNumber?: string | null }).billOfSupplyNumber)
    .filter((n): n is string => !!n);
  const primary = issued[0] ?? headers[0] ?? null;
  const taxSummary = buildTaxSummary(lines);
  const totals = lines.reduce(
    (acc, l) => ({
      taxableValue: r2(acc.taxableValue + l.taxableValue),
      cgstAmount: r2(acc.cgstAmount + l.cgstAmount),
      sgstAmount: r2(acc.sgstAmount + l.sgstAmount),
      igstAmount: r2(acc.igstAmount + l.igstAmount),
      cessAmount: r2(acc.cessAmount + l.cessAmount),
      taxAmount: r2(acc.taxAmount + l.taxAmount),
    }),
    { taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0, taxAmount: 0 },
  );

  const documentType = (primary?.gstDocumentType as GstDocumentType | null) ?? null;
  const hasTax = profile.registered && totals.taxAmount > 0;

  const notes: string[] = [];
  if (hasTax && (documentType === 'tax_invoice' || documentType === 'invoice_cum_bill_of_supply')) {
    // Rule 46(o) — a tax invoice must say whether the tax is payable on reverse
    // charge. Billing a patient it never is, and an auditor still looks for the
    // sentence.
    notes.push('Tax is not payable on reverse charge basis.');
  }
  if (profile.registered && taxSummary.some((r) => r.treatment !== 'taxable')) {
    notes.push(
      'Exempt lines are healthcare services exempt under Notification 12/2017-Central Tax (Rate).',
    );
  }

  return {
    registered: profile.registered,
    documentType,
    documentLabel: documentType ? (DOCUMENT_TYPE_LABELS[documentType] ?? null) : null,
    invoiceNumbers: issued.map((b) => b.invoiceNumber!),
    /** Rule 46A's second document, for a registered recipient with mixed lines. */
    billOfSupplyNumbers: billsOfSupply,
    financialYear: primary?.financialYear ?? null,
    supplierGstin: primary?.supplierGstin ?? profile.gstin ?? null,
    supplierStateCode: primary?.supplierStateCode ?? profile.stateCode ?? null,
    supplierStateName: stateNameForCode(primary?.supplierStateCode ?? profile.stateCode),
    recipientGstin: primary?.recipientGstin ?? null,
    placeOfSupplyStateCode: primary?.placeOfSupplyStateCode ?? null,
    placeOfSupplyStateName: stateNameForCode(primary?.placeOfSupplyStateCode),
    isInterState: primary?.isInterState ?? false,
    hasTax,
    hasClassifiedLines: lines.some((l) => !!l.gstTreatment || !!l.hsnSac),
    taxSummary,
    notes,
    totals,
    taxAmountInWords: totals.taxAmount > 0 ? amountInWords(totals.taxAmount) : '',
    // A bill of supply carries no tax and is a services document, so it is
    // marked ORIGINAL rather than ORIGINAL FOR RECIPIENT. Nothing at all where
    // no document has been issued: an unissued draft is not a copy of anything.
    copyMarking: documentType
      ? documentType === 'bill_of_supply'
        ? 'ORIGINAL'
        : 'ORIGINAL FOR RECIPIENT'
      : null,
    // From the first bill that actually carries one rather than from `primary`.
    // A stay spanning several bills registers each separately, and the one the
    // identity fields came from is not necessarily the one that came back with
    // an IRN first.
    ...irnOf(headers),
  };
}

/** The registered document's IRN, from whichever of a stay's bills has one. */
function irnOf(headers: GstBillHeader[]) {
  const withIrn = headers.find((h) => h.irn);
  return {
    irn: withIrn?.irn ?? null,
    irnAckNo: withIrn?.irnAckNo ?? null,
    irnAckDate: withIrn?.irnAckDate ?? null,
    irnQrPayload: withIrn?.irnQrPayload ?? null,
  };
}

// ── Drawing ────────────────────────────────────────────────────────────────

/** Matches the dialog exactly, including the ₹ (see services/pdf-fonts). */
export const gstMoney = (n: number) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DASH = '—';
const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? DASH : String(v);

/**
 * The rate ABOVE the amount, which is what Rule 46 wants against each line:
 * "2.5%" then "₹238.10".
 *
 * Deliberately two lines. Side by side the pair is about 52pt of text in a 48pt
 * column, and a cell that does not fit is cut without a word — so it is stacked
 * on purpose rather than left to break wherever the column runs out.
 */
export const gstTaxCell = (
  ratePercent: number,
  amount: number,
  treatmentLabel: string | null,
): string => {
  if (amount > 0 || ratePercent > 0) return `${ratePercent}%\n${gstMoney(amount)}`;
  return treatmentLabel ?? DASH;
};

/**
 * The charge table's columns for this document.
 *
 * `descriptionHeader` differs between the two bills only because they always
 * have — the IP bill says "Particulars", the counter bill "Description".
 *
 * The description column WRAPS. Cells are ellipsized by default, and at these
 * widths a ward-indent line ("… (Batch B-…, exp 07/07/2027) — ward indent
 * IND-20260707-0001, 2 pack(s)", 128 characters) would lose its second half.
 */
export function gstChargeColumns(
  gst: BillDocumentGst,
  descriptionHeader = 'Particulars',
): TableColumn[] {
  if (!gst.registered || !gst.hasClassifiedLines) {
    return [
      { header: descriptionHeader, width: 0.56, wrap: true },
      { header: 'Qty', width: 0.1, align: 'right' },
      { header: 'Rate', width: 0.16, align: 'right' },
      { header: 'Amount', width: 0.18, align: 'right' },
    ];
  }
  if (!gst.hasTax) {
    return [
      { header: descriptionHeader, width: 0.46, wrap: true },
      { header: 'HSN / SAC', width: 0.12 },
      { header: 'Qty', width: 0.08, align: 'right' },
      { header: 'Rate', width: 0.16, align: 'right' },
      { header: 'Amount', width: 0.18, align: 'right' },
    ];
  }
  const base: TableColumn[] = [
    { header: descriptionHeader, width: gst.isInterState ? 0.34 : 0.26, wrap: true },
    { header: 'HSN / SAC', width: 0.09 },
    { header: 'Qty', width: 0.05, align: 'right' },
    { header: 'Rate', width: 0.11, align: 'right' },
    { header: 'Taxable', width: 0.12, align: 'right' },
  ];
  const tax: TableColumn[] = gst.isInterState
    ? [{ header: 'IGST', width: 0.14, align: 'right', wrap: true }]
    : [
        { header: 'CGST', width: 0.11, align: 'right', wrap: true },
        { header: 'SGST', width: 0.11, align: 'right', wrap: true },
      ];
  return [...base, ...tax, { header: 'Amount', width: 0.15, align: 'right' }];
}

/** One charge line, in whichever layout `gstChargeColumns` chose. */
export function gstChargeCells(gst: BillDocumentGst, l: GstLine): string[] {
  // A charge that has accrued but is not yet posted onto a bill is marked, so
  // an interim bill never looks like it is hiding anything.
  const particulars = l.status === 'pending' ? `${l.description}  (unbilled)` : l.description;
  if (!gst.registered || !gst.hasClassifiedLines) {
    return [particulars, String(l.quantity), gstMoney(l.unitPrice), gstMoney(l.totalAmount)];
  }
  if (!gst.hasTax) {
    return [
      particulars, dash(l.hsnSac), String(l.quantity),
      gstMoney(l.unitPrice), gstMoney(l.totalAmount),
    ];
  }
  const taxableValue = taxableValueOf(l);
  const head = [
    particulars,
    dash(l.hsnSac),
    String(l.quantity),
    gstMoney(l.unitPrice),
    // A dash where there is no taxable value. The line's money is still on the
    // row, in Amount; what is withheld is the claim that it was taxed.
    taxableValue == null ? DASH : gstMoney(taxableValue),
  ];
  const taxed = l.cgstAmount > 0 || l.igstAmount > 0 || l.taxRatePercent > 0;
  const tax = gst.isInterState
    ? [gstTaxCell(l.igstRate, l.igstAmount, l.treatmentLabel)]
    : [
        gstTaxCell(l.cgstRate, l.cgstAmount, l.treatmentLabel),
        // The exemption label belongs on ONE of the two cells. Repeated, it
        // reads as two separate exemptions rather than one untaxed line.
        taxed ? gstTaxCell(l.sgstRate, l.sgstAmount, null) : DASH,
      ];
  return [...head, ...tax, gstMoney(l.totalAmount)];
}

/** The subtotal under a head of charges, adding up every money column shown. */
export function gstGroupTotalCells(
  gst: BillDocumentGst,
  label: string,
  lines: GstLine[],
  total: number,
): string[] {
  if (!gst.registered || !gst.hasClassifiedLines) return [label, '', '', gstMoney(total)];
  if (!gst.hasTax) return [label, '', '', '', gstMoney(total)];
  const sum = (pick: (l: GstLine) => number) => r2(lines.reduce((s, l) => s + pick(l), 0));
  const tax = gst.isInterState
    ? [gstMoney(sum((l) => l.igstAmount))]
    : [gstMoney(sum((l) => l.cgstAmount)), gstMoney(sum((l) => l.sgstAmount))];
  // Sums the SAME thing the column above it shows, or the group total would
  // not foot — the whole point of putting a total under a column.
  return [label, '', '', '', gstMoney(sum((l) => taxableValueOf(l) ?? 0)), ...tax, gstMoney(total)];
}

/** The identity fields that go on the face of the document, Rule 46. */
export function gstIdentityFields(gst: BillDocumentGst): Array<[string, string]> {
  // Only for a registered hospital: an unregistered one has no GSTIN, issues no
  // numbered document and has no place of supply to declare, and printing the
  // fields empty would suggest it was supposed to.
  if (!gst.registered) return [];
  const out: Array<[string, string]> = [];
  if (gst.invoiceNumbers.length) {
    out.push([`${gst.documentLabel ?? 'Invoice'} No.`, gst.invoiceNumbers.join(', ')]);
  }
  if (gst.supplierGstin) out.push(['GSTIN (Hospital)', gst.supplierGstin]);
  // A patient with a GSTIN is being billed as a business — it is what lets them
  // claim the credit, so it belongs on the paper.
  if (gst.recipientGstin) out.push(['GSTIN (Patient)', gst.recipientGstin]);
  if (gst.placeOfSupplyStateName) {
    out.push(['Place of Supply', `${gst.placeOfSupplyStateName} (${gst.placeOfSupplyStateCode})`]);
  }
  // Section 10: once e-invoicing applies, the IRN and the acknowledgement go on
  // the face of the document. Printed only when the portal has actually
  // answered — an empty IRN field on an invoice claims it is an e-invoice.
  if (gst.irn) out.push(['IRN', gst.irn]);
  if (gst.irnAckNo) {
    out.push([
      'Ack No. / Date',
      gst.irnAckDate
        ? `${gst.irnAckNo} / ${gst.irnAckDate.toLocaleDateString('en-IN')}`
        : gst.irnAckNo,
    ]);
  }
  return out;
}

/**
 * The signed QR code, drawn as vectors.
 *
 * Section 10 puts "the IRN and the signed QR code" on the face of the document
 * once e-invoicing applies. The QR is not decoration: a GST officer at the
 * roadside or a recipient checking an invoice scans it, and what it must
 * encode is the portal's signed payload EXACTLY as returned — the signature is
 * over those bytes, so a re-encoded or reformatted string verifies as false.
 *
 * Drawn module by module rather than as a PNG for two reasons: it stays crisp
 * at any print size because it is vector, and `QRCode.create` is synchronous,
 * so it fits a PDF that is streamed rather than awaited.
 *
 * Nothing is drawn when there is no payload. A blank square where the QR
 * belongs is worse than no square: it looks like a code that failed to scan.
 */
export function drawEInvoiceQr(
  pdf: PDFKit.PDFDocument,
  theme: PdfTheme,
  gst: BillDocumentGst,
  opts: { size?: number; x?: number; y?: number } = {},
): void {
  if (!gst.irnQrPayload) return;

  const size = opts.size ?? 96;
  let matrix: { size: number; data: Uint8Array };
  try {
    // Error correction M is what the e-invoice schema specifies; the payload is
    // long, and a higher level would push the module count past legibility at
    // this print size.
    matrix = QRCode.create(gst.irnQrPayload, { errorCorrectionLevel: 'M' }).modules;
  } catch {
    // A payload the encoder cannot represent is a data problem, not a reason to
    // fail the whole document — the IRN is still printed as text above.
    return;
  }

  const x = opts.x ?? theme.margin + theme.contentWidth - size;
  const y = opts.y ?? pdf.y;
  const cell = size / matrix.size;

  pdf.save();
  // White behind it: a QR on a tinted band does not scan reliably.
  pdf.rect(x - 2, y - 2, size + 4, size + 4).fill('#FFFFFF');
  pdf.fillColor('#000000');
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.data[r * matrix.size + c]) {
        // +0.2 on the span closes the hairline seams PDF viewers render
        // between abutting rects, which break a scan at small sizes.
        pdf.rect(x + c * cell, y + r * cell, cell + 0.2, cell + 0.2).fill();
      }
    }
  }
  pdf.restore();
  pdf.fillColor(theme.ink);
}

/**
 * The rate-wise summary — one row per rate, which is how a return reads a bill.
 *
 * Printed only where there is tax to summarise. On a bill of supply it would be
 * a table of zeroes claiming the hospital charged tax it never did.
 */
export function drawGstTaxSummary(
  pdf: PDFKit.PDFDocument,
  theme: PdfTheme,
  gst: BillDocumentGst,
): void {
  if (!gst.hasTax || gst.taxSummary.length === 0) return;

  ensureSpace(pdf, theme, 90);
  pdf.moveDown(0.6);
  drawSectionHeading(pdf, theme, 'Tax Summary');

  const columns: TableColumn[] = [
    { header: 'Rate', width: 0.2 },
{ header: 'Taxable Value', width: 0.2, align: 'right' },
    ...(gst.isInterState
      ? [{ header: 'IGST', width: 0.2, align: 'right' as const }]
      : [
          { header: 'CGST', width: 0.2, align: 'right' as const },
          { header: 'SGST', width: 0.2, align: 'right' as const },
        ]),
    { header: 'Total Tax', width: 0.2, align: 'right' },
  ];

  const rows: TableRow[] = gst.taxSummary.map((r, i) => ({
    cells: [
      // An exempt row has no rate to state, so it states what it is instead.
      r.treatment === 'taxable' ? `${r.ratePercent}%` : r.label,
      gstMoney(r.taxableValue),
      ...(gst.isInterState ? [gstMoney(r.igstAmount)] : [gstMoney(r.cgstAmount), gstMoney(r.sgstAmount)]),
      gstMoney(r.taxAmount),
    ],
    zebra: i % 2 === 1,
  }));
  rows.push({
    cells: [
      'Total',
      gstMoney(gst.totals.taxableValue),
      ...(gst.isInterState
        ? [gstMoney(gst.totals.igstAmount)]
        : [gstMoney(gst.totals.cgstAmount), gstMoney(gst.totals.sgstAmount)]),
      gstMoney(gst.totals.taxAmount),
    ],
    kind: 'total',
  });
  drawTable(pdf, theme, columns, rows);

  if (gst.notes.length) {
    pdf.moveDown(0.3);
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.tiny)
      .fillColor(theme.muted)
      .text(gst.notes.join('  '), theme.margin, pdf.y, { width: theme.contentWidth });
    pdf.fillColor(theme.ink);
  }
}
