import { Response } from 'express';
import { tintHex, type HospitalBranding } from '../../services/pdf-branding';
import { createBrandedDocument, finalizeBrandedDocument } from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';

// A fully-detailed, hospital-branded OP prescription / consultation document.
// Page setup, letterhead, fonts, colours, watermark and footer come from the
// `prescription` template in the PDF Builder, and it includes the patient's contact +
// allergies, the visit's chief complaint, diagnoses and latest vitals, the
// medications and the doctor's advice + follow-up — the complete visit record.

interface RxItem {
  drugName: string;
  dosage?: string | null;
  frequency?: string | null;
  duration?: string | null;
  route?: string | null;
  quantity?: number | null;
  instructions?: string | null;
  isPrn?: boolean | null;
  drug?: { genericName?: string | null; dosageForm?: string | null } | null;
}
interface RxAllergy { allergen: string; reaction?: string | null; severity?: string | null; allergyType?: string | null }
interface RxDiagnosis { diagnosisName: string; diagnosisType?: string | null; icdCode?: string | null; notes?: string | null }
interface RxVital {
  bloodPressureSystolic?: number | null; bloodPressureDiastolic?: number | null; pulseRate?: number | null;
  temperature?: unknown; respiratoryRate?: number | null; oxygenSaturation?: unknown;
  weightKg?: unknown; heightCm?: unknown; bmi?: unknown; bloodSugar?: unknown; recordedAt?: Date | string | null;
}
interface RxData {
  id: string;
  createdAt: Date | string;
  status: string;
  notes?: string | null;
  prescriptionType?: string | null;
  followUpDate?: Date | string | null;
  patient?: {
    mrn?: string | null; firstName?: string | null; lastName?: string | null; dateOfBirth?: Date | string | null;
    gender?: string | null; bloodGroup?: string | null; phone?: string | null;
    addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
    allergies?: RxAllergy[] | null;
  } | null;
  doctor?: {
    specialization?: string | null; qualifications?: string | null; licenseNumber?: string | null;
    user?: { firstName?: string | null; lastName?: string | null } | null;
    department?: { name?: string | null } | null;
  } | null;
  visit?: {
    visitDate?: Date | string | null; visitType?: string | null; chiefComplaint?: string | null;
    diagnoses?: RxDiagnosis[] | null; vitals?: RxVital[] | null;
  } | null;
  prescriptionItems?: RxItem[];
}

const INK = '#1a2332';
const MUTED = '#5b6472';
const LINE = '#c9ced6';
const LIGHT = '#eef2f5';

const dash = (v?: string | number | null) => (v === null || v === undefined || v === '' ? '—' : String(v));
const num = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const fmtDate = (v?: Date | string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const ageOf = (dob?: Date | string | null): number | null =>
  dob ? Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null;

export function streamPrescriptionPdf(
  res: Response,
  rx: RxData,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const isIp = (rx.prescriptionType ?? 'op').toLowerCase() === 'ip';
  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: 'Prescription',
    subtitle: isIp ? 'Inpatient (IP)' : 'Outpatient (OP)',
    meta: [
      { label: 'Date', value: fmtDate(rx.createdAt) },
      { label: 'Rx No', value: rx.id.slice(0, 8).toUpperCase() },
    ],
    filename: `prescription-${rx.id}.pdf`,
  });
  // Page geometry now comes from the template, not a module constant.
  const PAGE = { width: pdf.page.width, height: pdf.page.height, margin: theme.margin };
  const CONTENT_W = theme.contentWidth;
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const accent = theme.accent;

  const ensure = (needed: number) => {
    if (pdf.y + needed > PAGE.height - PAGE.margin - 26) pdf.addPage();
  };

  // ---- Patient + doctor card ----
  const p = rx.patient;
  const patientName = `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim() || 'Unknown';
  const age = ageOf(p?.dateOfBirth);
  const drName = rx.doctor?.user ? `Dr. ${rx.doctor.user.firstName ?? ''} ${rx.doctor.user.lastName ?? ''}`.trim() : 'Attending Physician';
  const address = [p?.addressLine1, p?.addressLine2, [p?.city, p?.state].filter(Boolean).join(', '), p?.postalCode].filter(Boolean).join(', ');
  const info: Array<[string, string]> = [
    ['Patient', patientName],
    ['MRN / UHID', dash(p?.mrn)],
    ['Age / Gender', `${dash(age)}${p?.gender ? ' / ' + p.gender : ''}`],
    ['Blood Group', dash(p?.bloodGroup)],
    ['Phone', dash(p?.phone)],
    ['Address', address || '—'],
    ['Doctor', `${drName}${rx.doctor?.specialization ? ' (' + rx.doctor.specialization + ')' : ''}`],
    ['Department', dash(rx.doctor?.department?.name)],
    ['Visit Date', fmtDate(rx.visit?.visitDate ?? rx.createdAt)],
    ['Status', (rx.status ?? '—').toUpperCase()],
  ];
  const colW = CONTENT_W / 2;
  const rowH = 26;
  const rows = Math.ceil(info.length / 2);
  const top = pdf.y;
  pdf.rect(left, top, CONTENT_W, rows * rowH).fillAndStroke(LIGHT, LINE);
  info.forEach(([label, value], i) => {
    const x = left + (i % 2) * colW + 8;
    const y = top + Math.floor(i / 2) * rowH + 5;
    pdf.font(theme.font.bold).fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colW - 16 });
    pdf.font(theme.font.regular).fontSize(9).fillColor(INK).text(value, x, y + 9, { width: colW - 16, ellipsis: true, height: 12 });
  });
  pdf.y = top + rows * rowH + 10;

  // ---- Section + table helpers (shared visual language with the discharge doc) ----
  const heading = (title: string) => {
    ensure(30);
    pdf.moveDown(0.25);
    const y = pdf.y;
    pdf.rect(left, y, 3, 12).fill(accent);
    pdf.font(theme.font.bold).fontSize(10).fillColor(INK).text(title.toUpperCase(), left + 8, y, { width: CONTENT_W - 8 });
    pdf.moveTo(left, pdf.y + 2).lineTo(right, pdf.y + 2).strokeColor(LINE).lineWidth(0.5).stroke();
    pdf.moveDown(0.3);
  };
  const paragraph = (text?: string | null) => {
    if (!text || !text.trim()) return;
    ensure(16);
    pdf.font(theme.font.regular).fontSize(9).fillColor('#2a3240').text(text.trim(), left, pdf.y, { width: CONTENT_W, align: 'left', lineGap: 1.5 });
    pdf.moveDown(0.2);
  };
  const table = (headers: string[], data: string[][], fr: number[]) => {
    const widths = fr.map((f) => (f / fr.reduce((a, b) => a + b, 0)) * CONTENT_W);
    const drawHead = () => {
      const y = pdf.y;
      pdf.rect(left, y, CONTENT_W, 16).fill(accent);
      let x = left;
      headers.forEach((h, i) => {
        pdf.font(theme.font.bold).fontSize(7.5).fillColor('#ffffff').text(h.toUpperCase(), x + 4, y + 4.5, { width: widths[i] - 8, ellipsis: true });
        x += widths[i];
      });
      pdf.y = y + 16;
    };
    ensure(30);
    drawHead();
    data.forEach((r, idx) => {
      const cellHeights = r.map((c, i) => pdf.font(theme.font.regular).fontSize(8).heightOfString(c || '—', { width: widths[i] - 8 }));
      const h = Math.max(16, Math.max(...cellHeights) + 6);
      if (pdf.y + h > PAGE.height - PAGE.margin - 26) { pdf.addPage(); drawHead(); }
      const y = pdf.y;
      if (idx % 2 === 1) pdf.rect(left, y, CONTENT_W, h).fill(LIGHT);
      let x = left;
      r.forEach((c, i) => {
        pdf.font(theme.font.regular).fontSize(8).fillColor(INK).text(c || '—', x + 4, y + 3.5, { width: widths[i] - 8 });
        x += widths[i];
      });
      pdf.moveTo(left, y + h).lineTo(right, y + h).strokeColor(LINE).lineWidth(0.4).stroke();
      pdf.y = y + h;
    });
    pdf.moveDown(0.3);
  };

  // ---- Allergies banner (patient safety — always prominent) ----
  const allergies = (p?.allergies ?? []).filter((a) => a.allergen);
  if (allergies.length) {
    ensure(30);
    const txt = 'ALLERGIES:  ' + allergies.map((a) => a.allergen + (a.reaction ? ` (${a.reaction})` : '')).join(',   ');
    const bh = Math.max(20, pdf.font(theme.font.bold).fontSize(8.5).heightOfString(txt, { width: CONTENT_W - 16 }) + 10);
    const y = pdf.y;
    pdf.rect(left, y, CONTENT_W, bh).fillAndStroke('#fdecec', '#f0b4b4');
    pdf.font(theme.font.bold).fontSize(8.5).fillColor('#b42318').text(txt, left + 8, y + 5, { width: CONTENT_W - 16 });
    pdf.y = y + bh + 6;
    pdf.fillColor(INK);
  }

  // ---- Chief complaint ----
  if (rx.visit?.chiefComplaint && rx.visit.chiefComplaint.trim()) {
    heading('Chief Complaint');
    paragraph(rx.visit.chiefComplaint);
  }

  // ---- Diagnosis ----
  const diagnoses = (rx.visit?.diagnoses ?? []).filter((d) => d.diagnosisName);
  if (diagnoses.length) {
    heading('Diagnosis');
    table(['Diagnosis', 'Type', 'ICD-10'], diagnoses.map((d) => [d.diagnosisName, d.diagnosisType ?? '—', d.icdCode ?? '—']), [6, 2, 2]);
  }

  // ---- Vitals (latest recorded on the visit) ----
  const vital = rx.visit?.vitals?.[0];
  if (vital) {
    const bp = vital.bloodPressureSystolic != null && vital.bloodPressureDiastolic != null
      ? `${vital.bloodPressureSystolic}/${vital.bloodPressureDiastolic}` : null;
    const vitalCells: Array<[string, string | null]> = [
      ['BP', bp ? `${bp} mmHg` : null],
      ['Pulse', vital.pulseRate != null ? `${vital.pulseRate} bpm` : null],
      ['Temp', num(vital.temperature) ? `${num(vital.temperature)}°C` : null],
      ['RR', vital.respiratoryRate != null ? `${vital.respiratoryRate}/min` : null],
      ['SpO₂', num(vital.oxygenSaturation) ? `${num(vital.oxygenSaturation)}%` : null],
      ['Weight', num(vital.weightKg) ? `${num(vital.weightKg)} kg` : null],
      ['Height', num(vital.heightCm) ? `${num(vital.heightCm)} cm` : null],
      ['BMI', num(vital.bmi)],
      ['Sugar', num(vital.bloodSugar) ? `${num(vital.bloodSugar)} mg/dL` : null],
    ];
    const cells = vitalCells.filter((c): c is [string, string] => c[1] != null);
    if (cells.length) {
      heading('Vital Signs');
      table(cells.map((c) => c[0]), [cells.map((c) => c[1])], cells.map(() => 1));
    }
  }

  // ---- Rx medications ----
  heading('℞  Medications');
  const items = rx.prescriptionItems ?? [];
  if (items.length === 0) {
    pdf.font(theme.font.italic).fontSize(9).fillColor(MUTED).text('No medications on this prescription.', left, pdf.y, { width: CONTENT_W });
    pdf.moveDown(0.3);
  } else {
    table(
      ['#', 'Medication', 'Dosage', 'Frequency', 'Duration', 'Route', 'Qty', 'Instructions'],
      items.map((it, idx) => {
        const generic = it.drug?.genericName ? ` (${it.drug.genericName})` : '';
        return [
          String(idx + 1),
          it.drugName + generic,
          dash(it.dosage),
          it.isPrn ? `${it.frequency ?? 'PRN'} (PRN)` : dash(it.frequency),
          dash(it.duration),
          dash(it.route),
          it.quantity != null ? String(it.quantity) : '—',
          dash(it.instructions),
        ];
      }),
      [0.5, 2.6, 1.2, 1.6, 1.2, 1, 0.7, 2.2],
    );
  }

  // ---- Advice / notes ----
  if (rx.notes && rx.notes.trim()) {
    heading('Advice / Notes');
    paragraph(rx.notes);
  }

  // ---- Follow-up ----
  if (rx.followUpDate) {
    ensure(24);
    const y = pdf.y;
    pdf.roundedRect(left, y, CONTENT_W, 20, 3).fill(tintHex(accent, 0.88));
    pdf.font(theme.font.bold).fontSize(9).fillColor(INK).text(`Follow-up / Next review:  ${fmtDate(rx.followUpDate)}`, left + 10, y + 6, { width: CONTENT_W - 20 });
    pdf.y = y + 20 + 6;
  }

  // ---- Signature ----
  ensure(64);
  pdf.moveDown(1.4);
  const sy = pdf.y;
  pdf.moveTo(right - 200, sy + 24).lineTo(right, sy + 24).strokeColor(INK).lineWidth(0.6).stroke();
  pdf.font(theme.font.bold).fontSize(9.5).fillColor(INK).text(drName, right - 200, sy + 28, { width: 200, align: 'right' });
  const drSub = [rx.doctor?.specialization, rx.doctor?.qualifications].filter(Boolean).join(', ');
  if (drSub) pdf.font(theme.font.regular).fontSize(8).fillColor(MUTED).text(drSub, right - 220, pdf.y, { width: 220, align: 'right' });
  if (rx.doctor?.licenseNumber) pdf.font(theme.font.regular).fontSize(8).fillColor(MUTED).text(`Reg. No: ${rx.doctor.licenseNumber}`, right - 220, pdf.y, { width: 220, align: 'right' });

  finalizeBrandedDocument({ pdf, branding, theme });
}
