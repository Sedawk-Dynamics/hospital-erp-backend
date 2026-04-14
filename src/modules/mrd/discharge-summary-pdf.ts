import PDFDocument from 'pdfkit';
import { Response } from 'express';

interface SummaryLike {
  id: string;
  headerSummary?: string | null;
  diagnosesSummary?: string | null;
  proceduresSummary?: string | null;
  keyLabsSummary?: string | null;
  labResultsSummary?: string | null;
  medicationReconciliation?: string | null;
  dischargeInstructions?: string | null;
  followUpDate?: Date | null;
  followUpInstructions?: string | null;
  signedAt?: Date | null;
  status: string;
  patient?: { firstName?: string; lastName?: string; mrn?: string; tenant?: { name?: string | null } | null } | null;
  doctor?: { user?: { firstName: string; lastName: string } | null } | null;
}

function section(doc: PDFKit.PDFDocument, title: string, body?: string | null) {
  if (!body) return;
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a').text(title);
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(10).fillColor('#2a2a2a').text(body, { align: 'left' });
}

export function streamDischargeSummaryPdf(res: Response, summary: SummaryLike) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = `discharge-summary-${summary.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  const hospitalName = summary.patient?.tenant?.name || 'Hospital';
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text(hospitalName, { align: 'center' });
  doc.font('Helvetica').fontSize(12).fillColor('#333').text('Discharge Summary', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#bbb').stroke();

  section(doc, 'Patient & Admission Details', summary.headerSummary);
  section(doc, 'Diagnoses', summary.diagnosesSummary);
  section(doc, 'Clinical Course / Procedures', summary.proceduresSummary);
  section(doc, 'Key Labs / Imaging (Significant Findings)', summary.keyLabsSummary);
  section(doc, 'All Lab Results', summary.labResultsSummary);
  section(doc, 'Medications', summary.medicationReconciliation);
  section(doc, 'Discharge Instructions', summary.dischargeInstructions);

  if (summary.followUpDate || summary.followUpInstructions) {
    const parts: string[] = [];
    if (summary.followUpDate) parts.push(`Date: ${new Date(summary.followUpDate).toLocaleDateString('en-IN')}`);
    if (summary.followUpInstructions) parts.push(summary.followUpInstructions);
    section(doc, 'Follow-up', parts.join('\n'));
  }

  doc.moveDown(1.5);
  const doctorName = summary.doctor?.user ? `Dr. ${summary.doctor.user.firstName} ${summary.doctor.user.lastName}` : 'Attending Physician';
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(doctorName, { align: 'right' });
  if (summary.signedAt) {
    doc.font('Helvetica').fontSize(9).fillColor('#555')
      .text(`Signed: ${new Date(summary.signedAt).toLocaleString('en-IN')}`, { align: 'right' });
  }
  doc.font('Helvetica').fontSize(8).fillColor('#888')
    .text(`Status: ${summary.status.toUpperCase()}`, { align: 'right' });

  doc.end();
}
