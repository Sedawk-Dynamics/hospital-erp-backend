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
import type { AdmissionBillDocument } from './billing.bill-document';
import {
  drawGstTaxSummary,
  gstChargeCells,
  gstChargeColumns,
  gstGroupTotalCells,
  gstIdentityFields,
  NO_GST,
  type BillDocumentGst,
} from './billing.gst-layout';

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
 * The document's GST block, or the answer for a document that has none.
 *
 * A bill built before this existed — a cached response, an older caller —
 * still has to print, and what it prints is the layout it always had. Reading
 * `doc.gst.registered` straight off would throw instead.
 */
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
  const gst = gstOf(doc);

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
  info.push(...gstIdentityFields(gst));
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
        rows.push({ cells: gstChargeCells(gst, l), zebra: i % 2 === 1 });
      });
      rows.push({ cells: gstGroupTotalCells(gst, `${g.label} total`, g.lines, g.total), kind: 'total' });
    }
    drawTable(pdf, theme, gstChargeColumns(gst), rows);
  }

  // ── Rate-wise tax summary ────────────────────────────────────────────────
  drawGstTaxSummary(pdf, theme, gst);

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
