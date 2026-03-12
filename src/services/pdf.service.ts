import PDFDocument from 'pdfkit';
import { logger } from '../config/logger';

// Hospital header info interface
interface HospitalInfo {
  name: string;
  address: string;
  phone: string;
  email: string;
  website?: string;
  logoPath?: string;
}

// Patient info interface
interface PatientInfo {
  name: string;
  mrn: string;
  age?: number;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
}

// Invoice item
interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  tax?: number;
  total: number;
}

// Invoice data
interface InvoiceData {
  hospital: HospitalInfo;
  patient: PatientInfo;
  billNumber: string;
  billDate: string;
  dueDate?: string;
  items: InvoiceItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  balanceDue: number;
  notes?: string;
}

// Lab report test result
interface LabTestResult {
  testName: string;
  result: string;
  unit: string;
  referenceRange: string;
  flag?: 'normal' | 'high' | 'low' | 'critical';
}

// Lab report data
interface LabReportData {
  hospital: HospitalInfo;
  patient: PatientInfo;
  reportNumber: string;
  reportDate: string;
  collectionDate: string;
  referringDoctor: string;
  sampleType?: string;
  tests: LabTestResult[];
  remarks?: string;
  verifiedBy?: string;
}

// Discharge summary data
interface DischargeSummaryData {
  hospital: HospitalInfo;
  patient: PatientInfo;
  admissionDate: string;
  dischargeDate: string;
  attendingDoctor: string;
  department: string;
  ward: string;
  diagnosis: string[];
  treatmentSummary: string;
  procedures?: string[];
  medications?: { name: string; dosage: string; frequency: string; duration: string }[];
  followUpInstructions?: string;
  dietaryAdvice?: string;
  nextAppointment?: string;
}

// Prescription data
interface PrescriptionData {
  hospital: HospitalInfo;
  patient: PatientInfo;
  prescriptionDate: string;
  doctor: {
    name: string;
    specialization: string;
    licenseNumber: string;
  };
  diagnosis?: string;
  medications: {
    name: string;
    dosage: string;
    frequency: string;
    duration: string;
    route?: string;
    instructions?: string;
  }[];
  advice?: string;
  followUp?: string;
}

/**
 * Helper: Convert a PDFDocument stream to a Buffer.
 */
function streamToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/**
 * Helper: Draw hospital header at the top of the document.
 */
function drawHospitalHeader(doc: PDFKit.PDFDocument, hospital: HospitalInfo): void {
  doc
    .fontSize(18)
    .font('Helvetica-Bold')
    .text(hospital.name, { align: 'center' });

  doc
    .fontSize(9)
    .font('Helvetica')
    .text(hospital.address, { align: 'center' })
    .text(`Phone: ${hospital.phone} | Email: ${hospital.email}`, { align: 'center' });

  if (hospital.website) {
    doc.text(`Website: ${hospital.website}`, { align: 'center' });
  }

  doc.moveDown(0.5);

  // Draw separator line
  const lineY = doc.y;
  doc
    .strokeColor('#2563eb')
    .lineWidth(2)
    .moveTo(50, lineY)
    .lineTo(545, lineY)
    .stroke();

  doc.moveDown(0.5);
}

/**
 * Helper: Draw patient information section.
 */
function drawPatientInfo(doc: PDFKit.PDFDocument, patient: PatientInfo): void {
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('Patient Information', 50);

  doc.moveDown(0.3);

  doc.fontSize(9).font('Helvetica');

  const startX = 50;
  const midX = 300;
  const startY = doc.y;

  doc.text(`Name: ${patient.name}`, startX, startY);
  doc.text(`MRN: ${patient.mrn}`, midX, startY);

  if (patient.age || patient.gender) {
    const details = [
      patient.age ? `Age: ${patient.age}` : '',
      patient.gender ? `Gender: ${patient.gender}` : '',
    ].filter(Boolean).join('  |  ');
    doc.text(details, startX);
  }

  if (patient.phone) {
    doc.text(`Phone: ${patient.phone}`, startX);
  }

  if (patient.address) {
    doc.text(`Address: ${patient.address}`, startX);
  }

  doc.moveDown(0.5);

  // Separator
  const lineY = doc.y;
  doc
    .strokeColor('#e5e7eb')
    .lineWidth(1)
    .moveTo(50, lineY)
    .lineTo(545, lineY)
    .stroke();

  doc.moveDown(0.5);
}

/**
 * Helper: Draw a simple table.
 */
function drawTable(
  doc: PDFKit.PDFDocument,
  headers: { label: string; width: number; align?: 'left' | 'center' | 'right' }[],
  rows: string[][],
): void {
  const startX = 50;
  const rowHeight = 20;
  let y = doc.y;

  // Draw header background
  doc
    .rect(startX, y, 495, rowHeight)
    .fill('#2563eb');

  // Draw header text
  let x = startX;
  for (const header of headers) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text(header.label, x + 5, y + 5, {
        width: header.width - 10,
        align: header.align || 'left',
      });
    x += header.width;
  }

  y += rowHeight;
  doc.fillColor('#000000');

  // Draw rows
  for (let i = 0; i < rows.length; i++) {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    // Alternate row background
    if (i % 2 === 0) {
      doc
        .rect(startX, y, 495, rowHeight)
        .fill('#f9fafb');
      doc.fillColor('#000000');
    }

    x = startX;
    for (let j = 0; j < headers.length; j++) {
      doc
        .fontSize(8)
        .font('Helvetica')
        .text(rows[i][j] || '', x + 5, y + 5, {
          width: headers[j].width - 10,
          align: headers[j].align || 'left',
        });
      x += headers[j].width;
    }

    y += rowHeight;
  }

  doc.y = y;
}

/**
 * Generate an invoice PDF.
 * @returns Buffer containing the PDF data.
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  logger.info({ billNumber: data.billNumber }, 'Generating invoice PDF');

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = streamToBuffer(doc);

  // Hospital header
  drawHospitalHeader(doc, data.hospital);

  // Invoice title
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('INVOICE', { align: 'center' });
  doc.moveDown(0.3);

  // Bill details
  doc.fontSize(9).font('Helvetica');
  const detailsY = doc.y;
  doc.text(`Bill Number: ${data.billNumber}`, 50, detailsY);
  doc.text(`Bill Date: ${data.billDate}`, 350, detailsY);
  if (data.dueDate) {
    doc.text(`Due Date: ${data.dueDate}`, 350);
  }
  doc.moveDown(0.5);

  // Patient info
  drawPatientInfo(doc, data.patient);

  // Items table
  const headers = [
    { label: 'Description', width: 180, align: 'left' as const },
    { label: 'Qty', width: 50, align: 'center' as const },
    { label: 'Unit Price', width: 80, align: 'right' as const },
    { label: 'Discount', width: 70, align: 'right' as const },
    { label: 'Tax', width: 55, align: 'right' as const },
    { label: 'Total', width: 60, align: 'right' as const },
  ];

  const rows = data.items.map((item) => [
    item.description,
    item.quantity.toString(),
    item.unitPrice.toFixed(2),
    (item.discount || 0).toFixed(2),
    (item.tax || 0).toFixed(2),
    item.total.toFixed(2),
  ]);

  drawTable(doc, headers, rows);

  // Totals section
  doc.moveDown(0.5);
  const totalsX = 370;
  const totalsValueX = 470;

  doc.fontSize(9).font('Helvetica');
  doc.text('Subtotal:', totalsX, doc.y, { continued: false });
  doc.text(data.subtotal.toFixed(2), totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });

  if (data.discountTotal > 0) {
    doc.text('Discount:', totalsX);
    doc.text(`-${data.discountTotal.toFixed(2)}`, totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });
  }

  if (data.taxTotal > 0) {
    doc.text('Tax:', totalsX);
    doc.text(data.taxTotal.toFixed(2), totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });
  }

  doc.moveDown(0.3);
  doc
    .strokeColor('#000000')
    .lineWidth(1)
    .moveTo(totalsX, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Grand Total:', totalsX);
  doc.text(data.grandTotal.toFixed(2), totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });

  doc.font('Helvetica').fontSize(9);
  doc.text('Amount Paid:', totalsX);
  doc.text(data.amountPaid.toFixed(2), totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });

  doc.font('Helvetica-Bold');
  doc.text('Balance Due:', totalsX);
  doc.text(data.balanceDue.toFixed(2), totalsValueX, doc.y - doc.currentLineHeight(), { align: 'right', width: 75 });

  // Notes
  if (data.notes) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(10).text('Notes:', 50);
    doc.font('Helvetica').fontSize(9).text(data.notes, 50);
  }

  // Footer
  doc.moveDown(2);
  doc
    .fontSize(8)
    .fillColor('#6b7280')
    .text('This is a computer-generated invoice.', { align: 'center' });

  doc.end();
  return bufferPromise;
}

/**
 * Generate a lab report PDF.
 * @returns Buffer containing the PDF data.
 */
export async function generateLabReportPDF(data: LabReportData): Promise<Buffer> {
  logger.info({ reportNumber: data.reportNumber }, 'Generating lab report PDF');

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = streamToBuffer(doc);

  // Hospital header
  drawHospitalHeader(doc, data.hospital);

  // Report title
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('LABORATORY REPORT', { align: 'center' });
  doc.moveDown(0.3);

  // Report details
  doc.fontSize(9).font('Helvetica');
  const detailsY = doc.y;
  doc.text(`Report No: ${data.reportNumber}`, 50, detailsY);
  doc.text(`Report Date: ${data.reportDate}`, 350, detailsY);
  doc.text(`Collection Date: ${data.collectionDate}`, 50);
  doc.text(`Referring Doctor: Dr. ${data.referringDoctor}`, 350, doc.y - doc.currentLineHeight());
  if (data.sampleType) {
    doc.text(`Sample Type: ${data.sampleType}`, 50);
  }
  doc.moveDown(0.5);

  // Patient info
  drawPatientInfo(doc, data.patient);

  // Test results table
  const headers = [
    { label: 'Test Name', width: 160, align: 'left' as const },
    { label: 'Result', width: 90, align: 'center' as const },
    { label: 'Unit', width: 70, align: 'center' as const },
    { label: 'Reference Range', width: 120, align: 'center' as const },
    { label: 'Flag', width: 55, align: 'center' as const },
  ];

  const rows = data.tests.map((test) => [
    test.testName,
    test.result,
    test.unit,
    test.referenceRange,
    test.flag ? test.flag.toUpperCase() : 'Normal',
  ]);

  drawTable(doc, headers, rows);

  // Remarks
  if (data.remarks) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(10).text('Remarks:', 50);
    doc.font('Helvetica').fontSize(9).text(data.remarks, 50);
  }

  // Verification
  if (data.verifiedBy) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Verified by: ${data.verifiedBy}`, 350);
  }

  // Footer
  doc.moveDown(2);
  doc
    .fontSize(8)
    .fillColor('#6b7280')
    .text('This report is electronically generated and verified.', { align: 'center' })
    .text('Please consult your doctor for interpretation of results.', { align: 'center' });

  doc.end();
  return bufferPromise;
}

/**
 * Generate a discharge summary PDF.
 * @returns Buffer containing the PDF data.
 */
export async function generateDischargeSummaryPDF(data: DischargeSummaryData): Promise<Buffer> {
  logger.info({ patient: data.patient.mrn }, 'Generating discharge summary PDF');

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = streamToBuffer(doc);

  // Hospital header
  drawHospitalHeader(doc, data.hospital);

  // Title
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('DISCHARGE SUMMARY', { align: 'center' });
  doc.moveDown(0.3);

  // Patient info
  drawPatientInfo(doc, data.patient);

  // Admission details
  doc.font('Helvetica-Bold').fontSize(11).text('Admission Details', 50);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  doc.text(`Admission Date: ${data.admissionDate}`, 50);
  doc.text(`Discharge Date: ${data.dischargeDate}`, 300, doc.y - doc.currentLineHeight());
  doc.text(`Attending Doctor: Dr. ${data.attendingDoctor}`, 50);
  doc.text(`Department: ${data.department}`, 300, doc.y - doc.currentLineHeight());
  doc.text(`Ward: ${data.ward}`, 50);
  doc.moveDown(0.5);

  // Diagnosis
  doc.font('Helvetica-Bold').fontSize(11).text('Diagnosis', 50);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  for (const diag of data.diagnosis) {
    doc.text(`  \u2022  ${diag}`, 50);
  }
  doc.moveDown(0.5);

  // Treatment summary
  doc.font('Helvetica-Bold').fontSize(11).text('Treatment Summary', 50);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').text(data.treatmentSummary, 50);
  doc.moveDown(0.5);

  // Procedures
  if (data.procedures && data.procedures.length > 0) {
    doc.font('Helvetica-Bold').fontSize(11).text('Procedures Performed', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica');
    for (const proc of data.procedures) {
      doc.text(`  \u2022  ${proc}`, 50);
    }
    doc.moveDown(0.5);
  }

  // Discharge medications
  if (data.medications && data.medications.length > 0) {
    doc.font('Helvetica-Bold').fontSize(11).text('Discharge Medications', 50);
    doc.moveDown(0.3);

    const medHeaders = [
      { label: 'Medication', width: 160, align: 'left' as const },
      { label: 'Dosage', width: 100, align: 'center' as const },
      { label: 'Frequency', width: 115, align: 'center' as const },
      { label: 'Duration', width: 120, align: 'center' as const },
    ];

    const medRows = data.medications.map((med) => [
      med.name,
      med.dosage,
      med.frequency,
      med.duration,
    ]);

    drawTable(doc, medHeaders, medRows);
    doc.moveDown(0.5);
  }

  // Follow-up instructions
  if (data.followUpInstructions) {
    doc.font('Helvetica-Bold').fontSize(11).text('Follow-Up Instructions', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text(data.followUpInstructions, 50);
    doc.moveDown(0.5);
  }

  // Dietary advice
  if (data.dietaryAdvice) {
    doc.font('Helvetica-Bold').fontSize(11).text('Dietary Advice', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text(data.dietaryAdvice, 50);
    doc.moveDown(0.5);
  }

  // Next appointment
  if (data.nextAppointment) {
    doc.font('Helvetica-Bold').fontSize(11).text('Next Appointment', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text(data.nextAppointment, 50);
    doc.moveDown(0.5);
  }

  // Signature line
  doc.moveDown(2);
  doc
    .strokeColor('#000000')
    .lineWidth(1)
    .moveTo(350, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').text(`Dr. ${data.attendingDoctor}`, 350);
  doc.text('Attending Physician', 350);

  // Footer
  doc.moveDown(2);
  doc
    .fontSize(8)
    .fillColor('#6b7280')
    .text('This is a computer-generated discharge summary.', { align: 'center' });

  doc.end();
  return bufferPromise;
}

/**
 * Generate a prescription PDF.
 * @returns Buffer containing the PDF data.
 */
export async function generatePrescriptionPDF(data: PrescriptionData): Promise<Buffer> {
  logger.info({ patient: data.patient.mrn }, 'Generating prescription PDF');

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = streamToBuffer(doc);

  // Hospital header
  drawHospitalHeader(doc, data.hospital);

  // Title
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('PRESCRIPTION', { align: 'center' });
  doc.moveDown(0.3);

  // Doctor info
  doc.fontSize(9).font('Helvetica');
  doc.text(`Doctor: Dr. ${data.doctor.name}`, 50);
  doc.text(`Specialization: ${data.doctor.specialization}`, 300, doc.y - doc.currentLineHeight());
  doc.text(`License No: ${data.doctor.licenseNumber}`, 50);
  doc.text(`Date: ${data.prescriptionDate}`, 300, doc.y - doc.currentLineHeight());
  doc.moveDown(0.5);

  // Patient info
  drawPatientInfo(doc, data.patient);

  // Diagnosis
  if (data.diagnosis) {
    doc.font('Helvetica-Bold').fontSize(11).text('Diagnosis', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text(data.diagnosis, 50);
    doc.moveDown(0.5);
  }

  // Rx symbol
  doc
    .fontSize(24)
    .font('Helvetica-Bold')
    .fillColor('#2563eb')
    .text('Rx', 50);
  doc.fillColor('#000000');
  doc.moveDown(0.3);

  // Medications table
  const medHeaders = [
    { label: 'Medication', width: 130, align: 'left' as const },
    { label: 'Dosage', width: 80, align: 'center' as const },
    { label: 'Route', width: 60, align: 'center' as const },
    { label: 'Frequency', width: 100, align: 'center' as const },
    { label: 'Duration', width: 65, align: 'center' as const },
    { label: 'Instructions', width: 60, align: 'left' as const },
  ];

  const medRows = data.medications.map((med) => [
    med.name,
    med.dosage,
    med.route || 'Oral',
    med.frequency,
    med.duration,
    med.instructions || '-',
  ]);

  drawTable(doc, medHeaders, medRows);

  // Advice
  if (data.advice) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Advice', 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').text(data.advice, 50);
  }

  // Follow-up
  if (data.followUp) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text(`Follow-up: ${data.followUp}`, 50);
  }

  // Signature line
  doc.moveDown(3);
  doc
    .strokeColor('#000000')
    .lineWidth(1)
    .moveTo(350, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').text(`Dr. ${data.doctor.name}`, 350);
  doc.text(`${data.doctor.specialization}`, 350);
  doc.text(`Reg. No: ${data.doctor.licenseNumber}`, 350);

  doc.end();
  return bufferPromise;
}
