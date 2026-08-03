import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { drawBrandedHeader, drawBrandedFooters, type HospitalBranding } from '../../services/pdf-branding';
import type { AdmissionBillDocument } from './billing.bill-document';

// Final IP bill PDF — the hospital admin's PDF Builder letterhead/footer (same
// look as the receipt and discharge summary), then patient + stay details, the
// itemised charges grouped by head, the money summary and the payment history.

const MARGIN = 42;

const fmt = (n: number) =>
  `${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

export function streamAdmissionBillPdf(
  res: Response,
  doc: AdmissionBillDocument,
  branding: HospitalBranding,
) {
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const contentWidth = pdf.page.width - MARGIN * 2;
  const right = MARGIN + contentWidth;
  const filename = `bill-${doc.admission.ipNumber ?? doc.admissionId.slice(0, 8)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  pdf.pipe(res);

  drawBrandedHeader(pdf, branding, {
    title: `${doc.admissionTypeLabel} · ${doc.documentTitle}`,
    margin: MARGIN,
    contentWidth,
    subtitle: doc.bills.length ? doc.bills.map((b) => b.billNumber).join(', ') : undefined,
    meta: [
      { label: 'IP No', value: doc.admission.ipNumber ?? '—' },
      { label: 'Date', value: dateOnly(doc.generatedAt) },
    ],
  });

  // ── Patient / stay blocks ────────────────────────────────────────────────
  const colGap = 12;
  const colW = (contentWidth - colGap) / 2;
  const blockTop = pdf.y;

  const kv = (label: string, value: string | null, x: number, width: number) => {
    const y = pdf.y;
    pdf.font('Helvetica').fontSize(8.5).fillColor('#6b7280').text(label, x, y, { width: 70 });
    pdf
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#111827')
      .text(value ?? '—', x + 74, y, { width: width - 74 });
    pdf.moveDown(0.25);
  };

  pdf.y = blockTop;
  pdf.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text('PATIENT', MARGIN, pdf.y);
  pdf.moveDown(0.3);
  kv('Name', doc.patient.name, MARGIN, colW);
  kv('MRN', doc.patient.mrn, MARGIN, colW);
  kv('Age / Sex', [doc.patient.age, doc.patient.gender].filter(Boolean).join(' / ') || null, MARGIN, colW);
  kv('Phone', doc.patient.phone, MARGIN, colW);
  if (doc.patient.address) kv('Address', doc.patient.address, MARGIN, colW);
  const leftEnd = pdf.y;

  const rx = MARGIN + colW + colGap;
  pdf.y = blockTop;
  pdf.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text('ADMISSION', rx, pdf.y);
  pdf.moveDown(0.3);
  kv('Type', doc.admissionTypeLabel, rx, colW);
  kv('Admitted', dateTime(doc.admission.admittedOn), rx, colW);
  kv('Discharged', doc.admission.dischargedOn ? dateTime(doc.admission.dischargedOn) : 'Still admitted', rx, colW);
  kv('Stay', `${doc.admission.lengthOfStayDays} day${doc.admission.lengthOfStayDays === 1 ? '' : 's'}`, rx, colW);
  kv('Ward / Bed', [doc.admission.ward, doc.admission.bed].filter(Boolean).join(' / ') || null, rx, colW);
  if (doc.admission.doctor) kv('Consultant', doc.admission.doctor, rx, colW);
  kv('Payment', doc.admission.billingCategory.toUpperCase(), rx, colW);

  pdf.y = Math.max(leftEnd, pdf.y) + 8;
  pdf.moveTo(MARGIN, pdf.y).lineTo(right, pdf.y).strokeColor('#e5e7eb').lineWidth(1).stroke();
  pdf.moveDown(0.8);

  // ── Charges ──────────────────────────────────────────────────────────────
  // Column layout: description | qty | rate | amount
  const cQty = MARGIN + contentWidth - 210;
  const cRate = MARGIN + contentWidth - 150;
  const cAmt = MARGIN + contentWidth - 80;

  const tableHeader = () => {
    const y = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#6b7280');
    pdf.text('PARTICULARS', MARGIN, y, { width: cQty - MARGIN - 8 });
    pdf.text('QTY', cQty, y, { width: 50, align: 'right' });
    pdf.text('RATE', cRate, y, { width: 62, align: 'right' });
    pdf.text('AMOUNT', cAmt, y, { width: 80, align: 'right' });
    pdf.moveDown(0.3);
    pdf.moveTo(MARGIN, pdf.y).lineTo(right, pdf.y).strokeColor('#e5e7eb').stroke();
    pdf.moveDown(0.3);
  };

  // Break to a new page when the next block will not fit. `repeatHeader` redraws
  // the column captions — wanted mid-itemisation, but NOT before the summary or
  // the payments table, which would otherwise land under a stray "PARTICULARS".
  const ensureSpace = (needed: number, repeatHeader = true) => {
    if (pdf.y + needed > pdf.page.height - 90) {
      pdf.addPage();
      pdf.y = MARGIN;
      if (repeatHeader) tableHeader();
    }
  };

  pdf.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Bill of Charges', MARGIN, pdf.y);
  pdf.moveDown(0.4);
  tableHeader();

  if (doc.groups.length === 0) {
    pdf.font('Helvetica-Oblique').fontSize(9).fillColor('#6b7280')
      .text('No charges recorded for this stay.', MARGIN, pdf.y);
    pdf.moveDown(0.5);
  }

  for (const g of doc.groups) {
    ensureSpace(40);
    pdf.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text(g.label, MARGIN, pdf.y);
    pdf.moveDown(0.25);

    pdf.font('Helvetica').fontSize(8.5).fillColor('#374151');
    for (const l of g.lines) {
      ensureSpace(18);
      const y = pdf.y;
      // A charge that has accrued but is not yet posted onto a bill is marked,
      // so an interim bill never looks like it is hiding anything.
      const label = l.status === 'pending' ? `${l.description}  (unbilled)` : l.description;
      pdf.text(label, MARGIN + 8, y, { width: cQty - MARGIN - 16 });
      const rowBottom = pdf.y;
      pdf.text(String(l.quantity), cQty, y, { width: 50, align: 'right' });
      pdf.text(fmt(l.unitPrice), cRate, y, { width: 62, align: 'right' });
      pdf.text(fmt(l.totalAmount), cAmt, y, { width: 80, align: 'right' });
      pdf.y = Math.max(rowBottom, y + 11);
    }

    ensureSpace(20);
    const gy = pdf.y + 1;
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827');
    pdf.text(`${g.label} total`, cRate - 120, gy, { width: 180, align: 'right' });
    pdf.text(fmt(g.total), cAmt, gy, { width: 80, align: 'right' });
    pdf.moveDown(0.9);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  ensureSpace(180, false);
  pdf.moveTo(MARGIN, pdf.y).lineTo(right, pdf.y).strokeColor('#e5e7eb').stroke();
  pdf.moveDown(0.6);

  const sLabel = MARGIN + contentWidth - 280;
  const row = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
    const y = pdf.y;
    pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(opts.color ?? '#374151');
    pdf.text(label, sLabel, y, { width: 190, align: 'right' });
    pdf.text(value, cAmt, y, { width: 80, align: 'right' });
    pdf.moveDown(0.35);
  };

  const t = doc.totals;
  row('Gross charges', fmt(t.grossCharges));
  if (t.discount > 0) row('Discount', `- ${fmt(t.discount)}`);
  // Tax is already inside the line amounts — shown for information, not added.
  if (t.tax > 0) row('(of which tax)', fmt(t.tax));
  if (t.insuranceCovered > 0) row('Covered by insurer / TPA', `- ${fmt(t.insuranceCovered)}`);
  pdf.moveTo(sLabel, pdf.y).lineTo(right, pdf.y).strokeColor('#d1d5db').stroke();
  pdf.moveDown(0.3);
  row('Net payable', fmt(t.netPayable), { bold: true });
  if (t.deposit > 0) row('Deposit received', `- ${fmt(t.deposit)}`);
  if (t.cashPaid > 0) row('Paid at counter', `- ${fmt(t.cashPaid)}`);
  if (t.depositRefunded > 0) row('Deposit refunded', fmt(t.depositRefunded));
  pdf.moveTo(sLabel, pdf.y).lineTo(right, pdf.y).strokeColor('#d1d5db').stroke();
  pdf.moveDown(0.3);

  if (t.balanceDue > 0) {
    row('BALANCE DUE', fmt(t.balanceDue), { bold: true, color: '#b91c1c' });
  } else {
    row('BALANCE DUE', fmt(0), { bold: true, color: '#047857' });
    if (t.refundable > 0) row('Refundable to patient', fmt(t.refundable), { color: '#047857' });
  }

  // PAID stamp — the whole point of reprinting a settled bill is that it says so.
  if (doc.isPaid) {
    pdf.moveDown(0.4);
    const sy = pdf.y;
    pdf.roundedRect(MARGIN, sy, 132, 26, 4).lineWidth(1.4).strokeColor('#047857').stroke();
    pdf.font('Helvetica-Bold').fontSize(13).fillColor('#047857')
      .text('PAID IN FULL', MARGIN, sy + 7, { width: 132, align: 'center' });
    pdf.y = sy + 32;
  }

  // ── Payments ─────────────────────────────────────────────────────────────
  if (doc.payments.length > 0) {
    ensureSpace(60, false);
    pdf.moveDown(0.4);
    pdf.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Payments Received', MARGIN, pdf.y);
    pdf.moveDown(0.35);
    const py = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#6b7280');
    pdf.text('DATE', MARGIN, py, { width: 110 });
    pdf.text('MODE', MARGIN + 115, py, { width: 90 });
    pdf.text('RECEIPT', MARGIN + 210, py, { width: 130 });
    pdf.text('AMOUNT', cAmt, py, { width: 80, align: 'right' });
    pdf.moveDown(0.3);
    pdf.moveTo(MARGIN, pdf.y).lineTo(right, pdf.y).strokeColor('#e5e7eb').stroke();
    pdf.moveDown(0.3);

    pdf.font('Helvetica').fontSize(8.5).fillColor('#374151');
    for (const p of doc.payments) {
      ensureSpace(16);
      const y = pdf.y;
      pdf.text(dateTime(p.date), MARGIN, y, { width: 110 });
      pdf.text(p.method.replace(/_/g, ' ').toUpperCase(), MARGIN + 115, y, { width: 90 });
      pdf.text(p.receiptNumber ?? p.reference ?? '—', MARGIN + 210, y, { width: 130 });
      pdf.text(fmt(p.amount), cAmt, y, { width: 80, align: 'right' });
      pdf.moveDown(0.4);
    }
  }

  drawBrandedFooters(pdf, branding, { margin: MARGIN, contentWidth });
  pdf.end();
}
