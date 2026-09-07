import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  drawCustomBlocks,
  drawKeyValueCard,
  drawSectionHeading,
  drawTable,
  ensureSpace,
  type PdfTheme,
  type TableColumn,
  type TableRow,
} from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';
import type {
  AdmissionBillDocument,
  BillDocumentGst,
  BillDocumentLine,
} from './billing.bill-document';

// ---------------------------------------------------------------------------
// The IP / Emergency / Day Care bill, as a PDF.
//
// This prints what the bill dialog shows — same sections in the same order,
// same labels, same wording, same money. The two used to drift: the dialog had
// a fourteen-field patient card and the PDF had two columns of key/values under
// PATIENT and ADMISSION headings; the dialog's tables were styled by the
// template and the PDF's were hand-drawn in grey; the dialog warned that an
// interim bill was still accruing and the PDF did not; the dialog printed
// rupees and the PDF printed bare numbers.
//
// So the body is built from the SHARED template-driven pieces — drawKeyValueCard,
// drawSectionHeading, drawTable — which are the same primitives the print view
// mirrors in HTML. Page setup, letterhead, fonts, colours, watermark, signature
// and footer all come from the `ip_bill` template.
//
// Order below is the order in the dialog. If you change one, change the other:
// `frontend/src/components/hospital/billing/admission-bill-document.tsx`.
// ---------------------------------------------------------------------------

/** Matches the dialog exactly, including the ₹ (see services/pdf-fonts). */
const money = (n: number) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateOnly = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : String(v);

/**
 * The rate ABOVE the amount, which is what Rule 46 wants against each line:
 * "2.5%" then "238.10".
 *
 * Deliberately two lines. Side by side the pair is about 52pt of text in a 48pt
 * column, and a cell that does not fit is cut without a word — so it is stacked
 * on purpose rather than left to break wherever the column runs out.
 */
const taxCell = (ratePercent: number, amount: number, treatmentLabel: string | null) => {
  if (amount > 0 || ratePercent > 0) return `${ratePercent}%
${money(amount)}`;
  return treatmentLabel ?? '—';
};

/**
 * The document's GST block, or the answer for a document that has none.
 *
 * A bill built before this existed — a cached response, an older caller —
 * still has to print, and what it prints is the layout it always had. Reading
 * `doc.gst.registered` straight off would throw instead.
 */
const NO_GST: BillDocumentGst = {
  registered: false,
  documentType: null, documentLabel: null, invoiceNumbers: [], financialYear: null,
  supplierGstin: null, supplierStateCode: null, supplierStateName: null,
  recipientGstin: null, placeOfSupplyStateCode: null, placeOfSupplyStateName: null,
  isInterState: false, hasTax: false, hasClassifiedLines: false,
  taxSummary: [], notes: [],
  totals: { taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0, taxAmount: 0 },
};

const gstOf = (doc: AdmissionBillDocument): BillDocumentGst => doc.gst ?? NO_GST;

export function streamAdmissionBillPdf(
  res: Response,
  doc: AdmissionBillDocument,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: `${doc.admissionTypeLabel} · ${doc.documentTitle}`,
    // The allotted document number is what the law identifies this paper by, so
    // it leads. `billNumber` is the internal reference staff search on and stays
    // on the card below.
    subtitle: gstOf(doc).invoiceNumbers.length
      ? gstOf(doc).invoiceNumbers.join(', ')
      : doc.bills.length
        ? doc.bills.map((b) => b.billNumber).join(', ')
        : undefined,
    meta: [
      { label: 'IP No', value: dash(doc.admission.ipNumber) },
      { label: 'Date', value: dateOnly(doc.generatedAt) },
    ],
    filename: `bill-${doc.admission.ipNumber ?? doc.admissionId.slice(0, 8)}.pdf`,
    // The interim warning belongs directly under the title, above anything the
    // hospital has configured — same as the dialog. So the blocks are placed
    // here rather than by createBrandedDocument.
    skipBlocks: true,
  });

  const a = doc.admission;
  const p = doc.patient;
  const t = doc.totals;

  // ── Interim warning ──────────────────────────────────────────────────────
  // An undischarged stay is still accruing; never let an interim bill read as
  // if it were the final one.
  if (!doc.isDischarged) {
    pdf
      .font(theme.font.bold)
      .fontSize(theme.size.tiny)
      .fillColor('#b45309')
      .text('PATIENT STILL ADMITTED — CHARGES MAY STILL BE ADDED', theme.margin, pdf.y, {
        width: theme.contentWidth,
        align: 'center',
        characterSpacing: 0.4,
      });
    pdf.moveDown(0.5);
    pdf.fillColor(theme.ink);
  }

  drawCustomBlocks(pdf, theme, 'before_body');

  // ── Patient / admission card ─────────────────────────────────────────────
  const info: Array<[string, string]> = [
    ['Patient Name', p.name],
    ['MRN / UHID', dash(p.mrn)],
    ['Age / Gender', `${dash(p.age)}${p.gender ? ' / ' + p.gender : ''}`],
    ['Phone', dash(p.phone)],
    ['IP No.', dash(a.ipNumber)],
    ['Care Type', doc.admissionTypeLabel],
    ['Admitted', dateTime(a.admittedOn)],
    ['Discharged', a.dischargedOn ? dateTime(a.dischargedOn) : 'Still admitted'],
    ['Length of Stay', `${a.lengthOfStayDays} day(s)`],
    ['Ward / Bed', `${dash(a.ward)} / ${dash(a.bed)}`],
    ['Consultant', dash(a.doctor)],
    ['Payment Mode', a.billingCategory.toUpperCase()],
  ];
  if (p.address) info.push(['Address', p.address]);
  if (doc.bills.length) info.push(['Bill No.', doc.bills.map((b) => b.billNumber).join(', ')]);
  // ── What Rule 46 wants identified on the face of the document ────────────
  // Only for a registered hospital: an unregistered one has no GSTIN, issues no
  // numbered document and has no place of supply to declare, and printing the
  // fields empty would suggest it was supposed to.
  const gst = gstOf(doc);
  if (gst.registered) {
    if (gst.invoiceNumbers.length) {
      info.push([`${gst.documentLabel ?? 'Invoice'} No.`, gst.invoiceNumbers.join(', ')]);
    }
    if (gst.supplierGstin) info.push(['GSTIN (Hospital)', gst.supplierGstin]);
    // A patient with a GSTIN is being billed as a business — it is what lets
    // them claim the credit, so it belongs on the paper.
    if (gst.recipientGstin) info.push(['GSTIN (Patient)', gst.recipientGstin]);
    if (gst.placeOfSupplyStateName) {
      info.push(['Place of Supply', `${gst.placeOfSupplyStateName} (${gst.placeOfSupplyStateCode})`]);
    }
  }
  drawKeyValueCard(pdf, theme, info, 2);

  // ── Charges ──────────────────────────────────────────────────────────────
  drawSectionHeading(pdf, theme, 'Bill of Charges');

  if (doc.groups.length === 0) {
    pdf
      .font(theme.font.italic)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text('No charges recorded for this stay.', theme.margin, pdf.y, { width: theme.contentWidth });
    pdf.moveDown(0.6);
    pdf.fillColor(theme.ink);
  } else {
    const rows: TableRow[] = [];
    for (const g of doc.groups) {
      rows.push({ cells: [g.label], kind: 'group' });
      g.lines.forEach((l, i) => {
        // Striped within the group, as on screen — not down the whole table.
        rows.push({ cells: chargeCells(doc, l), zebra: i % 2 === 1 });
      });
      rows.push({ cells: groupTotalCells(doc, g), kind: 'total' });
    }
    drawTable(pdf, theme, chargeColumns(doc), rows);
  }

  // ── Rate-wise tax summary ────────────────────────────────────────────────
  drawTaxSummary(pdf, theme, doc);

  // ── Summary ──────────────────────────────────────────────────────────────
  drawSummary(pdf, theme, doc);

  // ── Payments ─────────────────────────────────────────────────────────────
  if (doc.payments.length > 0) {
    ensureSpace(pdf, theme, 70);
    pdf.moveDown(0.6);
    drawSectionHeading(pdf, theme, 'Payments Received');
    drawTable(
      pdf,
      theme,
      [
        { header: 'Date', width: 0.3 },
        { header: 'Mode', width: 0.2 },
        { header: 'Receipt / Ref', width: 0.32 },
        { header: 'Amount', width: 0.18, align: 'right' },
      ],
      doc.payments.map((pay, i) => ({
        cells: [
          dateTime(pay.date),
          pay.method.replace(/_/g, ' ').toUpperCase(),
          dash(pay.receiptNumber ?? pay.reference),
          money(pay.amount),
        ],
        zebra: i % 2 === 1,
      })),
    );
  }

  finalizeBrandedDocument({ pdf, branding, theme, generatedAt: new Date(doc.generatedAt) });
}

/**
 * The charge table's columns, which follow what KIND of document this is.
 *
 * Three layouts, and the difference is not cosmetic:
 *
 *  - Nothing classified — an unregistered hospital, or a bill raised before any
 *    of this existed — prints exactly what it always printed. No column moves.
 *  - Classified but untaxed is a BILL OF SUPPLY, and a bill of supply must not
 *    carry tax columns at all: it is the document for an exempt supply. It
 *    still carries HSN/SAC, which Rule 49 asks for.
 *  - Anything taxed carries the taxable value and the split per LINE, because
 *    Rule 46 wants the rate and the amount of each component against the line
 *    it belongs to, not only in a total at the bottom.
 *
 * CGST/SGST and IGST are mutually exclusive — a supply is either within the
 * state or across it — so the inter-State layout spends the freed column on the
 * description rather than printing a column of dashes.
 *
 * The description column WRAPS. Cells are ellipsized by default, and at these
 * widths a ward-indent line ("… (Batch B-…, exp 07/07/2027) — ward indent
 * IND-20260707-0001, 2 pack(s)", 128 characters) would lose its second half.
 */
function chargeColumns(doc: AdmissionBillDocument): TableColumn[] {
  const g = gstOf(doc);
  if (!g.registered || !g.hasClassifiedLines) {
    return [
      { header: 'Particulars', width: 0.56, wrap: true },
      { header: 'Qty', width: 0.1, align: 'right' },
      { header: 'Rate', width: 0.16, align: 'right' },
      { header: 'Amount', width: 0.18, align: 'right' },
    ];
  }
  if (!g.hasTax) {
    return [
      { header: 'Particulars', width: 0.46, wrap: true },
      { header: 'HSN / SAC', width: 0.12 },
      { header: 'Qty', width: 0.08, align: 'right' },
      { header: 'Rate', width: 0.16, align: 'right' },
      { header: 'Amount', width: 0.18, align: 'right' },
    ];
  }
  const base: TableColumn[] = [
    { header: 'Particulars', width: g.isInterState ? 0.34 : 0.26, wrap: true },
    { header: 'HSN / SAC', width: 0.09 },
    { header: 'Qty', width: 0.05, align: 'right' },
    { header: 'Rate', width: 0.11, align: 'right' },
    { header: 'Taxable', width: 0.12, align: 'right' },
  ];
  const tax: TableColumn[] = g.isInterState
    ? [{ header: 'IGST', width: 0.14, align: 'right', wrap: true }]
    : [
        { header: 'CGST', width: 0.11, align: 'right', wrap: true },
        { header: 'SGST', width: 0.11, align: 'right', wrap: true },
      ];
  return [...base, ...tax, { header: 'Amount', width: 0.15, align: 'right' }];
}

/** One charge line, in whichever layout `chargeColumns` chose. */
function chargeCells(doc: AdmissionBillDocument, l: BillDocumentLine): string[] {
  const g = gstOf(doc);
  // A charge that has accrued but is not yet posted onto a bill is marked, so
  // an interim bill never looks like it is hiding anything.
  const particulars = l.status === 'pending' ? `${l.description}  (unbilled)` : l.description;
  if (!g.registered || !g.hasClassifiedLines) {
    return [particulars, String(l.quantity), money(l.unitPrice), money(l.totalAmount)];
  }
  if (!g.hasTax) {
    return [particulars, dash(l.hsnSac), String(l.quantity), money(l.unitPrice), money(l.totalAmount)];
  }
  const head = [
    particulars,
    dash(l.hsnSac),
    String(l.quantity),
    money(l.unitPrice),
    money(l.taxableValue),
  ];
  const taxed = l.cgstAmount > 0 || l.igstAmount > 0 || l.taxRatePercent > 0;
  const tax = g.isInterState
    ? [taxCell(l.igstRate, l.igstAmount, l.treatmentLabel)]
    : [
        taxCell(l.cgstRate, l.cgstAmount, l.treatmentLabel),
        // The exemption label belongs on ONE of the two cells. Repeated, it
        // reads as two separate exemptions rather than one untaxed line.
        taxed ? taxCell(l.sgstRate, l.sgstAmount, null) : '—',
      ];
  return [...head, ...tax, money(l.totalAmount)];
}

/** The subtotal under a head of charges, adding up every money column shown. */
function groupTotalCells(
  doc: AdmissionBillDocument,
  group: AdmissionBillDocument['groups'][number],
): string[] {
  const g = gstOf(doc);
  const label = `${group.label} total`;
  if (!g.registered || !g.hasClassifiedLines) return [label, '', '', money(group.total)];
  if (!g.hasTax) return [label, '', '', '', money(group.total)];
  const sum = (pick: (l: BillDocumentLine) => number) =>
    Math.round(group.lines.reduce((s, l) => s + pick(l), 0) * 100) / 100;
  const tax = g.isInterState
    ? [money(sum((l) => l.igstAmount))]
    : [money(sum((l) => l.cgstAmount)), money(sum((l) => l.sgstAmount))];
  return [label, '', '', '', money(sum((l) => l.taxableValue)), ...tax, money(group.total)];
}

/**
 * The rate-wise summary — one row per rate, which is how a return reads a bill.
 *
 * Printed only where there is tax to summarise. On a bill of supply it would be
 * a table of zeroes claiming the hospital charged tax it never did.
 */
function drawTaxSummary(pdf: PDFKit.PDFDocument, theme: PdfTheme, doc: AdmissionBillDocument): void {
  const g = gstOf(doc);
  if (!g.hasTax || g.taxSummary.length === 0) return;

  ensureSpace(pdf, theme, 90);
  pdf.moveDown(0.6);
  drawSectionHeading(pdf, theme, 'Tax Summary');

  const columns: TableColumn[] = [
    { header: 'Rate', width: 0.2 },
    { header: 'Taxable Value', width: 0.2, align: 'right' },
    ...(g.isInterState
      ? [{ header: 'IGST', width: 0.2, align: 'right' as const }]
      : [
          { header: 'CGST', width: 0.2, align: 'right' as const },
          { header: 'SGST', width: 0.2, align: 'right' as const },
        ]),
    { header: 'Total Tax', width: 0.2, align: 'right' },
  ];

  const rows: TableRow[] = g.taxSummary.map((r, i) => ({
    cells: [
      // An exempt row has no rate to state, so it states what it is instead.
      r.treatment === 'taxable' ? `${r.ratePercent}%` : r.label,
      money(r.taxableValue),
      ...(g.isInterState ? [money(r.igstAmount)] : [money(r.cgstAmount), money(r.sgstAmount)]),
      money(r.taxAmount),
    ],
    zebra: i % 2 === 1,
  }));
  rows.push({
    cells: [
      'Total',
      money(g.totals.taxableValue),
      ...(g.isInterState
        ? [money(g.totals.igstAmount)]
        : [money(g.totals.cgstAmount), money(g.totals.sgstAmount)]),
      money(g.totals.taxAmount),
    ],
    kind: 'total',
  });
  drawTable(pdf, theme, columns, rows);

  const notes = g.notes;
  if (notes.length) {
    pdf.moveDown(0.3);
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.tiny)
      .fillColor(theme.muted)
      .text(notes.join('  '), theme.margin, pdf.y, { width: theme.contentWidth });
    pdf.fillColor(theme.ink);
  }
}

/**
 * The right-aligned money summary, and the PAID stamp under it.
 *
 * Same rows, same wording and same order as the dialog — including the true
 * minus sign on the deductions and "of which tax", which is reported rather
 * than added because it is already inside each line amount.
 */
function drawSummary(pdf: PDFKit.PDFDocument, theme: PdfTheme, doc: AdmissionBillDocument): void {
  const t = doc.totals;
  const width = Math.min(240, theme.contentWidth);
  const left = theme.margin + theme.contentWidth - width;
  const valueW = 90;
  const labelW = width - valueW - 6;

  const lines: Array<{ label: string; value: string; bold?: boolean; border?: boolean; color?: string }> = [
    { label: 'Gross charges', value: money(t.grossCharges) },
  ];
  if (t.discount > 0) lines.push({ label: 'Discount', value: `− ${money(t.discount)}` });
  if (t.tax > 0) lines.push({ label: '(of which tax)', value: money(t.tax) });
  if (t.insuranceCovered > 0) {
    lines.push({ label: 'Covered by insurer / TPA', value: `− ${money(t.insuranceCovered)}` });
  }
  lines.push({ label: 'Net payable', value: money(t.netPayable), bold: true, border: true });
  if (t.deposit > 0) lines.push({ label: 'Deposit received', value: `− ${money(t.deposit)}` });
  if (t.cashPaid > 0) lines.push({ label: 'Paid at counter', value: `− ${money(t.cashPaid)}` });
  if (t.depositRefunded > 0) {
    lines.push({ label: 'Deposit refunded', value: money(t.depositRefunded) });
  }
  lines.push({
    label: 'Balance due',
    value: money(t.balanceDue),
    bold: true,
    border: true,
    color: t.balanceDue > 0 ? '#b91c1c' : '#047857',
  });
  if (t.balanceDue <= 0 && t.refundable > 0) {
    lines.push({ label: 'Refundable to patient', value: money(t.refundable), color: '#047857' });
  }

  const rowH = theme.size.body + 5;
  ensureSpace(pdf, theme, lines.length * rowH + 40);
  pdf.moveDown(0.8);

  for (const l of lines) {
    const y = pdf.y;
    if (l.border) {
      pdf.moveTo(left, y).lineTo(left + width, y).strokeColor(theme.hairline).lineWidth(0.5).stroke();
    }
    const ty = y + 2;
    pdf
      .font(l.bold ? theme.font.bold : theme.font.regular)
      .fontSize(theme.size.body)
      .fillColor(l.color ?? theme.ink)
      .text(l.label, left, ty, { width: labelW, align: 'right', lineBreak: false });
    pdf.text(l.value, left + labelW + 6, ty, { width: valueW, align: 'right', lineBreak: false });
    pdf.y = y + rowH;
  }

  // The whole point of reprinting a settled bill is that it says so.
  if (doc.isPaid) {
    pdf.moveDown(0.5);
    const boxW = 132;
    const boxH = theme.size.heading + 14;
    const y = pdf.y;
    ensureSpace(pdf, theme, boxH + 8);
    // Right-aligned, under the totals it refers to — as on screen.
    const x = theme.margin + theme.contentWidth - boxW;
    pdf.roundedRect(x, y, boxW, boxH, 2).lineWidth(1.5).strokeColor('#047857').stroke();
    pdf
      .font(theme.font.bold)
      .fontSize(theme.size.heading)
      .fillColor('#047857')
      .text('PAID IN FULL', x, y + (boxH - theme.size.heading) / 2 - 0.5, {
        width: boxW,
        align: 'center',
        characterSpacing: 1,
        lineBreak: false,
      });
    pdf.y = y + boxH + 4;
  }
  pdf.fillColor(theme.ink);
}
