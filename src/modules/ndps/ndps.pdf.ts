import PDFDocument from 'pdfkit';
import { Response } from 'express';

// ============================================================
// NDPS statutory register PDFs — Form 3C / 3E / 3H
// ============================================================
// Server-side PDFKit (matches billing.receipt-pdf.ts). The Inspector Dashboard
// exports clean, formatted registers a drug inspector can sign: Form 3C (inward
// consignments), Form 3E (patient-wise consumption) and Form 3H (daily account).

interface TenantInfo {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
}

type Column = { label: string; width: number; align?: 'left' | 'right' | 'center' };

// A4 landscape (842 × 595) with 40pt margins → usable width 762.
const CONTENT_LEFT = 40;
const CONTENT_RIGHT = 802;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT; // 762

const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  });

function drawHeader(doc: PDFKit.PDFDocument, tenant: TenantInfo | null, title: string, period: { from?: string; to?: string }) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#111').text(tenant?.name ?? 'Hospital', CONTENT_LEFT, 40, { align: 'center', width: CONTENT_WIDTH });
  const addr = [tenant?.address, tenant?.city, tenant?.state].filter(Boolean).join(', ');
  if (addr) doc.font('Helvetica').fontSize(9).fillColor('#444').text(addr, { align: 'center', width: CONTENT_WIDTH });
  const contact = [tenant?.phone, tenant?.email].filter(Boolean).join(' · ');
  if (contact) doc.font('Helvetica').fontSize(9).fillColor('#444').text(contact, { align: 'center', width: CONTENT_WIDTH });
  if (tenant?.licenseNumber) doc.font('Helvetica').fontSize(9).fillColor('#444').text(`Drug Licence: ${tenant.licenseNumber}`, { align: 'center', width: CONTENT_WIDTH });

  doc.moveDown(0.4);
  doc.moveTo(CONTENT_LEFT, doc.y).lineTo(CONTENT_RIGHT, doc.y).strokeColor('#bbb').stroke();
  doc.moveDown(0.4);

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(title, { align: 'center', width: CONTENT_WIDTH });
  const range = period.from || period.to
    ? `Period: ${period.from ? fmtDate(period.from) : '—'} to ${period.to ? fmtDate(period.to) : '—'}`
    : 'Period: all records';
  doc.font('Helvetica').fontSize(9).fillColor('#555').text(range, { align: 'center', width: CONTENT_WIDTH });
  doc.moveDown(0.6);
}

function drawTable(doc: PDFKit.PDFDocument, columns: Column[], rows: string[][]) {
  const tableWidth = columns.reduce((s, c) => s + c.width, 0);
  const headerH = 18;

  const drawHeaderRow = () => {
    const y = doc.y;
    doc.rect(CONTENT_LEFT, y, tableWidth, headerH).fill('#2563eb');
    let x = CONTENT_LEFT;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    for (const c of columns) {
      doc.text(c.label, x + 3, y + 5, { width: c.width - 6, align: c.align ?? 'left', lineBreak: false });
      x += c.width;
    }
    doc.y = y + headerH;
    doc.fillColor('#111');
  };

  drawHeaderRow();

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    doc.font('Helvetica').fontSize(7.5);
    const cellHeights = columns.map((c, ci) => doc.heightOfString(cells[ci] ?? '', { width: c.width - 6 }));
    const rowH = Math.max(13, ...cellHeights) + 4;

    if (doc.y + rowH > doc.page.height - 45) {
      doc.addPage();
      doc.y = 40;
      drawHeaderRow();
    }

    const y = doc.y;
    if (i % 2 === 1) {
      doc.rect(CONTENT_LEFT, y, tableWidth, rowH).fill('#f3f4f6');
    }
    let x = CONTENT_LEFT;
    doc.fillColor('#111').font('Helvetica').fontSize(7.5);
    for (let ci = 0; ci < columns.length; ci++) {
      doc.text(cells[ci] ?? '', x + 3, y + 3, { width: columns[ci].width - 6, align: columns[ci].align ?? 'left' });
      x += columns[ci].width;
    }
    doc.y = y + rowH;
  }

  // bottom border
  doc.moveTo(CONTENT_LEFT, doc.y).lineTo(CONTENT_LEFT + tableWidth, doc.y).strokeColor('#ddd').stroke();
}

function drawFooter(doc: PDFKit.PDFDocument, count: number) {
  // Re-anchor x at the left margin — after the table the cursor sits at the last column.
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(`${count} record(s). Generated ${fmtDateTime(new Date())} IST.`, CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(9).fillColor('#111')
    .text('Verified physical count & signature: ____________________________', CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.4);
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#888')
    .text('Computer-generated statutory register under the NDPS Act. Retain for inspection.', CONTENT_LEFT, doc.y, { align: 'center', width: CONTENT_WIDTH });
}

// Register row from ndps.service.getRegister().items
export interface RegisterItem {
  occurredAt: Date | string;
  entryType: string;
  drugName: string;
  strength: string | null;
  quantity: number;
  from: string | null;
  to: string | null;
  recordedBy: string | null;
  counterparty: string | null;
  coSignBy: string | null;
  ndpsLicenseNumber: string | null;
  form3cNumber: string | null;
  transportDetails: string | null;
  grossWeight: string | null;
  batchNumber: string | null;
  patient: { mrn: string; name: string } | null;
  doctorRegNo: string | null;
  bedNumber: string | null;
  diagnosis: string | null;
  reasonCode: string | null;
  referenceNumber: string | null;
}

const TITLES: Record<string, string> = {
  '3C': 'FORM 3C — Register of Narcotic Consignments Received',
  '3E': 'FORM 3E — Patient-wise Consumption Register',
  transfer: 'Internal NDPS Transfer Register (Delivery Challans)',
  disposal: 'NDPS Disposal Register (Broken / Spoiled)',
  all: 'NDPS Transaction Register (All Entries)',
};

const dash = (v: unknown) => (v == null || v === '' ? '—' : String(v));

export function streamNdpsRegisterPdf(
  res: Response,
  opts: { formType: string; tenant: TenantInfo | null; from?: string; to?: string; items: RegisterItem[] },
) {
  const formType = opts.formType in TITLES ? opts.formType : 'all';
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ndps-form-${formType}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, opts.tenant, TITLES[formType], { from: opts.from, to: opts.to });

  let columns: Column[];
  let rows: string[][];
  const drug = (i: RegisterItem) => `${i.drugName}${i.strength ? ` ${i.strength}` : ''}`;

  if (formType === '3C') {
    columns = [
      { label: 'Date', width: 95 }, { label: 'Drug', width: 130 }, { label: 'Qty', width: 40, align: 'right' },
      { label: 'Form 3C No', width: 110 }, { label: 'NDPS Licence', width: 110 }, { label: 'Batch', width: 80 },
      { label: 'Gross Wt', width: 70 }, { label: 'Recorded By', width: 127 },
    ];
    rows = opts.items.map((i) => [fmtDateTime(i.occurredAt), drug(i), String(i.quantity), dash(i.form3cNumber), dash(i.ndpsLicenseNumber), dash(i.batchNumber), dash(i.grossWeight), dash(i.recordedBy)]);
  } else if (formType === '3E') {
    columns = [
      { label: 'Date', width: 90 }, { label: 'Drug', width: 110 }, { label: 'Dose', width: 38, align: 'right' },
      { label: 'Patient (MRN)', width: 120 }, { label: 'Bed', width: 50 }, { label: 'Doctor Reg', width: 95 },
      { label: 'Diagnosis', width: 140 }, { label: 'Recorded By', width: 119 },
    ];
    rows = opts.items.map((i) => [fmtDateTime(i.occurredAt), drug(i), String(i.quantity), i.patient ? `${i.patient.name} (${i.patient.mrn})` : '—', dash(i.bedNumber), dash(i.doctorRegNo), dash(i.diagnosis), dash(i.recordedBy)]);
  } else if (formType === 'transfer') {
    columns = [
      { label: 'Date', width: 100 }, { label: 'Drug', width: 135 }, { label: 'Qty', width: 45, align: 'right' },
      { label: 'From', width: 120 }, { label: 'To', width: 120 }, { label: 'Issued By', width: 110 }, { label: 'Received By', width: 132 },
    ];
    rows = opts.items.map((i) => [fmtDateTime(i.occurredAt), drug(i), String(i.quantity), dash(i.from), dash(i.to), dash(i.recordedBy), dash(i.counterparty)]);
  } else if (formType === 'disposal') {
    columns = [
      { label: 'Date', width: 100 }, { label: 'Drug', width: 130 }, { label: 'Qty', width: 42, align: 'right' },
      { label: 'Reason', width: 90 }, { label: 'Reference', width: 130 }, { label: 'Logged By', width: 115 }, { label: 'Co-signed By', width: 155 },
    ];
    rows = opts.items.map((i) => [fmtDateTime(i.occurredAt), drug(i), String(i.quantity), dash(i.reasonCode), dash(i.referenceNumber), dash(i.recordedBy), dash(i.coSignBy)]);
  } else {
    columns = [
      { label: 'Date', width: 100 }, { label: 'Type', width: 70 }, { label: 'Drug', width: 150 }, { label: 'Qty', width: 45, align: 'right' },
      { label: 'From', width: 120 }, { label: 'To', width: 120 }, { label: 'Recorded By', width: 157 },
    ];
    rows = opts.items.map((i) => [fmtDateTime(i.occurredAt), i.entryType, drug(i), String(i.quantity), dash(i.from), dash(i.to), dash(i.recordedBy)]);
  }

  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888').text('No records for this register in the selected period.', CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
  } else {
    drawTable(doc, columns, rows);
  }
  drawFooter(doc, rows.length);
  doc.end();
}

// Daily row from ndps.service.getDailyBalances().items
export interface DailyItem {
  date: Date | string;
  drugName: string;
  strength: string | null;
  openingBalance: number;
  received: number;
  dispensed: number;
  disposed: number;
  closingBalance: number;
  physicalCount: number | null;
  isVerified: boolean;
  variance: number | null;
}

export function streamNdpsDailyPdf(
  res: Response,
  opts: { tenant: TenantInfo | null; from?: string; to?: string; items: DailyItem[] },
) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ndps-form-3H-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, opts.tenant, 'FORM 3H — Daily Account of Narcotic Drugs', { from: opts.from, to: opts.to });

  const columns: Column[] = [
    { label: 'Date', width: 80 }, { label: 'Drug', width: 150 },
    { label: 'Opening', width: 65, align: 'right' }, { label: 'Received', width: 65, align: 'right' },
    { label: 'Dispensed', width: 70, align: 'right' }, { label: 'Spoilt', width: 60, align: 'right' },
    { label: 'Closing', width: 65, align: 'right' }, { label: 'Physical', width: 65, align: 'right' },
    { label: 'Variance', width: 65, align: 'right' }, { label: 'Verified', width: 77, align: 'center' },
  ];
  const rows = opts.items.map((i) => [
    fmtDate(i.date),
    `${i.drugName}${i.strength ? ` ${i.strength}` : ''}`,
    String(i.openingBalance), String(i.received), String(i.dispensed), String(i.disposed), String(i.closingBalance),
    i.physicalCount == null ? '—' : String(i.physicalCount),
    i.variance == null ? '—' : (i.variance > 0 ? `+${i.variance}` : String(i.variance)),
    i.isVerified ? 'Yes' : 'No',
  ]);

  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888').text('No daily accounts for the selected period.', CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
  } else {
    drawTable(doc, columns, rows);
  }
  drawFooter(doc, rows.length);
  doc.end();
}
