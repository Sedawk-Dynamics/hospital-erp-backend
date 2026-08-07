import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import { createBrandedDocument, finalizeBrandedDocument } from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';

// ---------------------------------------------------------------------------
// Shared shape for a fully-detailed IP discharge document. Assembled in
// mrd.service.buildDischargeDocument and rendered here (PDF) and on the
// frontend (print view) from the same structure.
// ---------------------------------------------------------------------------

export interface DischargeVitalRow {
  at: string | null;
  bp: string | null;
  pulse: number | null;
  temp: number | null;
  rr: number | null;
  spo2: number | null;
  weight: number | null;
  height: number | null;
  bmi: number | null;
  sugar: number | null;
}

export interface DischargeDocument {
  // The hospital's configured PDF/print branding (letterhead, logo, colours).
  hospital: HospitalBranding;
  meta: {
    id: string;
    status: string;
    signedAt: string | null;
    signerName: string | null;
    attestation: string | null;
    generatedAt: string;
  };
  patient: {
    name: string;
    mrn: string | null;
    age: number | null;
    gender: string | null;
    dob: string | null;
    bloodGroup: string | null;
    phone: string | null;
    address: string | null;
    maritalStatus: string | null;
    nationality: string | null;
  };
  emergencyContact: { name: string; relationship: string; phone: string } | null;
  admission: {
    admissionDate: string | null;
    dischargeDate: string | null;
    lengthOfStayDays: number | null;
    ward: string | null;
    bed: string | null;
    reason: string | null;
    chiefComplaint: string | null;
    attendingDoctor: string;
    specialization: string | null;
  };
  allergies: Array<{ allergen: string; reaction: string | null }>;
  diagnoses: Array<{ name: string; type: string; icdCode: string | null }>;
  vitals: { admission: DischargeVitalRow | null; discharge: DischargeVitalRow | null };
  procedures: Array<{ name: string; type: string | null; date: string | null; status: string; surgeon: string | null }>;
  imaging: Array<{ study: string; indication: string | null; impression: string | null; date: string | null }>;
  sections: {
    /** Free text the doctor added to the header column (incl. "general" pins). */
    headerNotes: string | null;
    diagnosesText: string | null;
    hospitalCourse: string | null;
    keyLabs: string | null;
    labResults: string | null;
    medicationsText: string | null;
    dischargeInstructions: string | null;
    followUpDate: string | null;
    followUpInstructions: string | null;
  };
  medications: Array<{ drug: string; dosage: string; frequency: string; duration: string | null; route: string; instructions: string | null }>;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const INK = '#1a2332';
const MUTED = '#5b6472';
const LINE = '#c9ced6';
const LIGHT = '#eef2f5';

const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const dash = (v?: string | number | null) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function streamDischargeSummaryPdf(
  res: Response,
  doc: DischargeDocument,
  template?: PdfTemplate,
) {
  const { pdf, theme } = createBrandedDocument({
    res,
    branding: doc.hospital,
    template,
    title: 'Discharge Summary',
    subtitle: doc.meta.status !== 'published' ? `${doc.meta.status.toUpperCase()} — PREVIEW` : 'Inpatient (IP)',
    meta: [
      { label: 'MRN', value: doc.patient.mrn ?? '—' },
      { label: 'Doc No', value: doc.meta.id.slice(0, 8).toUpperCase() },
    ],
    filename: `discharge-summary-${doc.meta.id}.pdf`,
  });
  // Page geometry comes from the template now, not a module constant.
  const PAGE = { width: pdf.page.width, height: pdf.page.height, margin: theme.margin };
  const CONTENT_W = theme.contentWidth;
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const accent = theme.accent;

  // Guard: if a block won't fit, start a new page.
  const ensure = (needed: number) => {
    if (pdf.y + needed > PAGE.height - PAGE.margin - 24) pdf.addPage();
  };

  // ---- Patient / admission info card ----
  const info: Array<[string, string]> = [
    ['Patient Name', doc.patient.name],
    ['MRN / UHID', dash(doc.patient.mrn)],
    ['Age / Gender', `${dash(doc.patient.age)} ${doc.patient.gender ? '/ ' + doc.patient.gender : ''}`.trim()],
    ['Blood Group', dash(doc.patient.bloodGroup)],
    ['Phone', dash(doc.patient.phone)],
    ['Address', dash(doc.patient.address)],
    ['Admitted', fmtDateTime(doc.admission.admissionDate)],
    ['Discharged', fmtDateTime(doc.admission.dischargeDate)],
    ['Length of Stay', doc.admission.lengthOfStayDays != null ? `${doc.admission.lengthOfStayDays} day(s)` : '—'],
    ['Ward / Bed', `${dash(doc.admission.ward)} / ${dash(doc.admission.bed)}`],
    ['Attending Doctor', `${doc.admission.attendingDoctor}${doc.admission.specialization ? ' (' + doc.admission.specialization + ')' : ''}`],
    ['Emergency Contact', doc.emergencyContact ? `${doc.emergencyContact.name} (${doc.emergencyContact.relationship}) ${doc.emergencyContact.phone}` : '—'],
  ];
  const colW = CONTENT_W / 2;
  const rowH = 26;
  const rows = Math.ceil(info.length / 2);
  const cardTop = pdf.y;
  pdf.rect(left, cardTop, CONTENT_W, rows * rowH).fillAndStroke(LIGHT, LINE);
  info.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = left + col * colW + 8;
    const y = cardTop + row * rowH + 5;
    pdf.font(theme.font.bold).fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colW - 16 });
    pdf.font(theme.font.regular).fontSize(9).fillColor(INK).text(value, x, y + 9, { width: colW - 16, ellipsis: true, height: 12 });
  });
  pdf.y = cardTop + rows * rowH + 10;

  // ---- Section helpers ----
  const heading = (title: string) => {
    ensure(34);
    pdf.moveDown(0.3);
    const y = pdf.y;
    pdf.rect(left, y, 3, 12).fill(accent);
    pdf.font(theme.font.bold).fontSize(10.5).fillColor(INK).text(title.toUpperCase(), left + 8, y, { width: CONTENT_W - 8 });
    pdf.moveTo(left, pdf.y + 2).lineTo(right, pdf.y + 2).strokeColor(LINE).lineWidth(0.5).stroke();
    pdf.moveDown(0.35);
  };
  const paragraph = (text?: string | null) => {
    if (!text || !text.trim()) return;
    ensure(18);
    pdf.font(theme.font.regular).fontSize(9).fillColor('#2a3240').text(text.trim(), left, pdf.y, { width: CONTENT_W, align: 'left', lineGap: 1.5 });
    pdf.moveDown(0.2);
  };
  const emptyNote = (text: string) => {
    pdf.font(theme.font.italic).fontSize(8.5).fillColor(MUTED).text(text, left, pdf.y, { width: CONTENT_W });
    pdf.moveDown(0.2);
  };

  // Generic table: headers + rows with fractional column widths.
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
      if (pdf.y + h > PAGE.height - PAGE.margin - 24) { pdf.addPage(); drawHead(); }
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

  // ---- Doctor's own notes on the header ----
  // The "general" pin bucket and anything typed into the header column. Never
  // used to reach the document at all.
  if (doc.sections.headerNotes?.trim()) {
    heading('Summary');
    paragraph(doc.sections.headerNotes);
  }

  // ---- Diagnoses ----
  heading('Diagnosis');
  if (doc.sections.diagnosesText && doc.sections.diagnosesText.trim()) {
    paragraph(doc.sections.diagnosesText);
  } else if (doc.diagnoses.length) {
    table(['Diagnosis', 'Type', 'ICD-10'], doc.diagnoses.map((d) => [d.name, d.type, d.icdCode ?? '—']), [6, 2, 2]);
  } else emptyNote('No diagnoses recorded.');

  // ---- Allergies ----
  if (doc.allergies.length) {
    heading('Allergies');
    table(['Allergen', 'Reaction'], doc.allergies.map((a) => [a.allergen, a.reaction ?? '—']), [1, 1]);
  }

  // ---- Presenting complaint / reason ----
  if (doc.admission.chiefComplaint || doc.admission.reason) {
    heading('Presenting Complaint / Reason for Admission');
    paragraph([doc.admission.chiefComplaint, doc.admission.reason].filter(Boolean).join('\n'));
  }

  // ---- Vitals ----
  if (doc.vitals.admission || doc.vitals.discharge) {
    heading('Vital Signs');
    const vr = (v: DischargeVitalRow | null, label: string): string[] => [
      label,
      v?.bp ?? '—',
      dash(v?.pulse),
      v?.temp != null ? `${v.temp}°C` : '—',
      dash(v?.rr),
      v?.spo2 != null ? `${v.spo2}%` : '—',
      v?.weight != null ? `${v.weight} kg` : '—',
    ];
    table(['At', 'BP', 'Pulse', 'Temp', 'RR', 'SpO₂', 'Weight'],
      [vr(doc.vitals.admission, 'On admission'), vr(doc.vitals.discharge, 'At discharge')],
      [2.2, 1.4, 1, 1, 0.8, 1, 1.2]);
  }

  // ---- Procedures / surgeries ----
  if (doc.procedures.length) {
    heading('Procedures / Surgeries');
    table(['Procedure', 'Type', 'Surgeon', 'Date', 'Status'],
      doc.procedures.map((p) => [p.name, p.type ?? '—', p.surgeon ?? '—', fmtDate(p.date), p.status]),
      [3, 1.4, 2, 1.6, 1.2]);
  }

  // ---- Hospital course ----
  if (doc.sections.hospitalCourse) {
    heading('Hospital Course & Treatment');
    paragraph(doc.sections.hospitalCourse);
  }

  // ---- Investigations ----
  if (doc.sections.keyLabs || doc.sections.labResults || doc.imaging.length) {
    heading('Investigations');
    if (doc.sections.keyLabs) {
      pdf.font(theme.font.bold).fontSize(8.5).fillColor(accent).text('Significant / Abnormal Labs', left, pdf.y, { width: CONTENT_W });
      pdf.moveDown(0.1);
      paragraph(doc.sections.keyLabs);
    }
    if (doc.sections.labResults) {
      pdf.font(theme.font.bold).fontSize(8.5).fillColor(accent).text('All Lab Results', left, pdf.y, { width: CONTENT_W });
      pdf.moveDown(0.1);
      paragraph(doc.sections.labResults);
    }
    if (doc.imaging.length) {
      pdf.font(theme.font.bold).fontSize(8.5).fillColor(accent).text('Imaging', left, pdf.y, { width: CONTENT_W });
      pdf.moveDown(0.1);
      table(['Study', 'Indication', 'Impression', 'Date'],
        doc.imaging.map((im) => [im.study, im.indication ?? '—', im.impression ?? '—', fmtDate(im.date)]),
        [1.6, 2, 3, 1.4]);
    }
  }

  // ---- Medications on discharge ----
  // Print BOTH the prescribed table and whatever the doctor typed. These used
  // to be either/or, so any medication note written by hand vanished the moment
  // a prescription existed on the stay — which is almost always.
  heading('Medications on Discharge');
  if (doc.medications.length) {
    table(['Medication', 'Dose', 'Frequency', 'Duration', 'Route', 'Instructions'],
      doc.medications.map((m) => [m.drug, m.dosage, m.frequency, m.duration ?? 'ongoing', m.route, m.instructions ?? '—']),
      [2.4, 1.2, 1.6, 1.3, 1, 2]);
  }
  if (doc.sections.medicationsText?.trim()) {
    paragraph(doc.sections.medicationsText);
  }
  if (!doc.medications.length && !doc.sections.medicationsText?.trim()) {
    emptyNote('No discharge medications prescribed.');
  }

  // ---- Discharge instructions ----
  if (doc.sections.dischargeInstructions) {
    heading('Discharge Instructions / Advice');
    paragraph(doc.sections.dischargeInstructions);
  }

  // ---- Follow-up ----
  if (doc.sections.followUpDate || doc.sections.followUpInstructions) {
    heading('Follow-up');
    if (doc.sections.followUpDate) {
      pdf.font(theme.font.bold).fontSize(9).fillColor(INK).text(`Next review: ${fmtDate(doc.sections.followUpDate)}`, left, pdf.y, { width: CONTENT_W });
      pdf.moveDown(0.15);
    }
    paragraph(doc.sections.followUpInstructions);
  }

  // ---- Signature block ----
  ensure(70);
  pdf.moveDown(1.2);
  const sy = pdf.y;
  pdf.moveTo(right - 200, sy + 26).lineTo(right, sy + 26).strokeColor(INK).lineWidth(0.6).stroke();
  pdf.font(theme.font.bold).fontSize(9.5).fillColor(INK).text(doc.admission.attendingDoctor, right - 200, sy + 30, { width: 200, align: 'right' });
  if (doc.admission.specialization) pdf.font(theme.font.regular).fontSize(8).fillColor(MUTED).text(doc.admission.specialization, right - 200, pdf.y, { width: 200, align: 'right' });
  if (doc.meta.signedAt) pdf.font(theme.font.regular).fontSize(8).fillColor(MUTED).text(`Electronically signed on ${fmtDateTime(doc.meta.signedAt)}`, right - 260, pdf.y + 2, { width: 260, align: 'right' });
  if (doc.meta.attestation) pdf.font(theme.font.italic).fontSize(8).fillColor(MUTED).text(`Attested as “${doc.meta.attestation}”`, right - 260, pdf.y, { width: 260, align: 'right' });

  // ---- Branded footers (hospital name • page X of Y • disclaimer) ----
  finalizeBrandedDocument({
    pdf,
    branding: doc.hospital,
    theme,
    generatedAt: doc.meta.generatedAt ? new Date(doc.meta.generatedAt) : undefined,
  });
}
