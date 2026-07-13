import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { drawBrandedHeader, drawBrandedFooters, DEFAULT_ACCENT, type HospitalBranding } from '../../services/pdf-branding';

// A branded prescription PDF — uses the hospital-admin's PDF Builder letterhead,
// accent colour and footer (the same look as every other document in the app).

interface RxItem {
  drugName: string;
  genericName?: string | null;
  dosage?: string | null;
  frequency?: string | null;
  duration?: string | null;
  route?: string | null;
  quantity?: number | null;
  instructions?: string | null;
  isPrn?: boolean | null;
}
interface RxData {
  id: string;
  createdAt: Date | string;
  status: string;
  notes?: string | null;
  prescriptionType?: string | null;
  patient?: { mrn?: string | null; firstName?: string | null; lastName?: string | null; dateOfBirth?: Date | string | null; gender?: string | null } | null;
  doctor?: { specialization?: string | null; qualifications?: string | null; licenseNumber?: string | null; user?: { firstName?: string | null; lastName?: string | null } | null; department?: { name?: string | null } | null } | null;
  prescriptionItems?: RxItem[];
}

const INK = '#1a2332';
const MUTED = '#5b6472';
const LINE = '#c9ced6';
const LIGHT = '#eef2f5';
const PAGE = { margin: 42 } as const;

const dash = (v?: string | number | null) => (v === null || v === undefined || v === '' ? '—' : String(v));
const fmtDate = (v?: Date | string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const ageOf = (dob?: Date | string | null): number | null =>
  dob ? Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null;

export function streamPrescriptionPdf(res: Response, rx: RxData, branding: HospitalBranding) {
  const pdf = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });
  const contentWidth = pdf.page.width - PAGE.margin * 2;
  const left = PAGE.margin;
  const accent = /^#[0-9a-fA-F]{6}$/.test(branding.accentColor) ? branding.accentColor : DEFAULT_ACCENT;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="prescription-${rx.id}.pdf"`);
  pdf.pipe(res);

  drawBrandedHeader(pdf, branding, { title: 'Prescription', margin: PAGE.margin, contentWidth });

  // ---- Patient + doctor card ----
  const p = rx.patient;
  const patientName = `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim() || 'Unknown';
  const age = ageOf(p?.dateOfBirth);
  const drName = rx.doctor?.user ? `Dr. ${rx.doctor.user.firstName ?? ''} ${rx.doctor.user.lastName ?? ''}`.trim() : 'Attending Physician';
  const info: Array<[string, string]> = [
    ['Patient', patientName],
    ['MRN / UHID', dash(p?.mrn)],
    ['Age / Gender', `${dash(age)}${p?.gender ? ' / ' + p.gender : ''}`],
    ['Date', fmtDate(rx.createdAt)],
    ['Doctor', `${drName}${rx.doctor?.specialization ? ' (' + rx.doctor.specialization + ')' : ''}`],
    ['Type', (rx.prescriptionType ?? 'op').toUpperCase()],
  ];
  const colW = contentWidth / 2;
  const rowH = 26;
  const rows = Math.ceil(info.length / 2);
  const top = pdf.y;
  pdf.rect(left, top, contentWidth, rows * rowH).fillAndStroke(LIGHT, LINE);
  info.forEach(([label, value], i) => {
    const x = left + (i % 2) * colW + 8;
    const y = top + Math.floor(i / 2) * rowH + 5;
    pdf.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colW - 16 });
    pdf.font('Helvetica').fontSize(9).fillColor(INK).text(value, x, y + 9, { width: colW - 16, ellipsis: true, height: 12 });
  });
  pdf.y = top + rows * rowH + 12;

  // ---- Rx symbol + medications table ----
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(accent).text('℞', left, pdf.y);
  pdf.y -= 6;
  pdf.fillColor(INK);
  pdf.moveDown(0.4);

  const items = rx.prescriptionItems ?? [];
  const head = ['#', 'Medication', 'Dosage', 'Frequency', 'Duration', 'Route', 'Instructions'];
  const fr = [0.5, 2.6, 1.3, 1.6, 1.3, 1, 2.2];
  const widths = fr.map((f) => (f / fr.reduce((a, b) => a + b, 0)) * contentWidth);

  const drawHead = () => {
    const y = pdf.y;
    pdf.rect(left, y, contentWidth, 16).fill(accent);
    let x = left;
    head.forEach((h, i) => {
      pdf.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff').text(h.toUpperCase(), x + 4, y + 4.5, { width: widths[i] - 8, ellipsis: true });
      x += widths[i];
    });
    pdf.y = y + 16;
  };

  if (items.length === 0) {
    pdf.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('No medications on this prescription.', left, pdf.y, { width: contentWidth });
  } else {
    drawHead();
    items.forEach((it, idx) => {
      const med = it.drugName + (it.genericName ? ` (${it.genericName})` : '');
      const qty = it.quantity != null ? `  · Qty ${it.quantity}` : '';
      const cells = [
        String(idx + 1),
        med,
        dash(it.dosage),
        it.isPrn ? `${it.frequency ?? 'PRN'} (PRN)` : dash(it.frequency),
        dash(it.duration),
        dash(it.route),
        (it.instructions ?? '') + qty || '—',
      ];
      const heights = cells.map((c, i) => pdf.font('Helvetica').fontSize(8).heightOfString(c || '—', { width: widths[i] - 8 }));
      const h = Math.max(16, Math.max(...heights) + 6);
      if (pdf.y + h > pdf.page.height - PAGE.margin - 60) { pdf.addPage(); drawHead(); }
      const y = pdf.y;
      if (idx % 2 === 1) pdf.rect(left, y, contentWidth, h).fill(LIGHT);
      let x = left;
      cells.forEach((c, i) => {
        pdf.font('Helvetica').fontSize(8).fillColor(INK).text(c || '—', x + 4, y + 3.5, { width: widths[i] - 8 });
        x += widths[i];
      });
      pdf.moveTo(left, y + h).lineTo(left + contentWidth, y + h).strokeColor(LINE).lineWidth(0.4).stroke();
      pdf.y = y + h;
    });
  }

  // ---- Notes / advice ----
  if (rx.notes && rx.notes.trim()) {
    pdf.moveDown(0.6);
    pdf.rect(left, pdf.y, 3, 12).fill(accent);
    pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('ADVICE / NOTES', left + 8, pdf.y, { width: contentWidth - 8 });
    pdf.moveDown(0.3);
    pdf.font('Helvetica').fontSize(9).fillColor('#2a3240').text(rx.notes.trim(), left, pdf.y, { width: contentWidth, lineGap: 1.5 });
  }

  // ---- Signature ----
  pdf.moveDown(2);
  const right = left + contentWidth;
  const sy = pdf.y;
  pdf.moveTo(right - 200, sy + 24).lineTo(right, sy + 24).strokeColor(INK).lineWidth(0.6).stroke();
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(drName, right - 200, sy + 28, { width: 200, align: 'right' });
  const drSub = [rx.doctor?.specialization, rx.doctor?.qualifications].filter(Boolean).join(', ');
  if (drSub) pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text(drSub, right - 220, pdf.y, { width: 220, align: 'right' });
  if (rx.doctor?.licenseNumber) pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Reg. No: ${rx.doctor.licenseNumber}`, right - 220, pdf.y, { width: 220, align: 'right' });

  drawBrandedFooters(pdf, branding, { margin: PAGE.margin, contentWidth });
  pdf.end();
}
