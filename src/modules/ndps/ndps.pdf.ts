import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import { createBrandedDocument, finalizeBrandedDocument, type PdfTheme } from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';

// ============================================================
// NDPS statutory register PDFs — Form 3C / 3E / 3H
// ============================================================
// The Inspector Dashboard exports registers a drug inspector can sign: Form 3C
// (inward consignments), Form 3E (patient-wise consumption) and Form 3H (daily
// account).
//
// Page setup, letterhead, fonts, margins and the footer come from the
// `ndps_register` / `ndps_daily` templates in the PDF Builder. What does NOT
// come from there is the FORM ITSELF — the titles, the column set and the
// certification wording are prescribed by statute and are not a hospital's to
// restyle. Column widths are declared at their natural landscape-A4 size and
// scaled to whatever content width the template ends up with, so changing the
// page size can never push a column off the paper.

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

// The width the column tables below were laid out against: A4 landscape
// (842 × 595) with 40pt margins. Every column width scales off this.
const DESIGN_WIDTH = 762;

const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  });

/** The statutory form caption, under the branded letterhead. */
function drawFormCaption(
  doc: PDFKit.PDFDocument,
  theme: PdfTheme,
  title: string,
  period: { from?: string; to?: string },
) {
  doc
    .font(theme.font.bold)
    .fontSize(theme.size.heading + 2)
    .fillColor(theme.ink)
    .text(title, theme.margin, doc.y, { align: 'center', width: theme.contentWidth });
  const range =
    period.from || period.to
      ? `Period: ${period.from ? fmtDate(period.from) : '\u2014'} to ${period.to ? fmtDate(period.to) : '\u2014'}`
      : 'Period: all records';
  doc
    .font(theme.font.regular)
    .fontSize(theme.size.small)
    .fillColor(theme.muted)
    .text(range, theme.margin, doc.y, { align: 'center', width: theme.contentWidth });
  doc.moveDown(0.6);
}

function drawTable(doc: PDFKit.PDFDocument, theme: PdfTheme, columns: Column[], rows: string[][]) {
  const left = theme.margin;
  // Scale the statutory column layout to whatever width this page actually has,
  // so a template change can never push a column off the paper.
  const scale = theme.contentWidth / DESIGN_WIDTH;
  const w = columns.map((c) => c.width * scale);
  const tableWidth = w.reduce((sum, x) => sum + x, 0);
  const cellFont = Math.max(6, theme.size.tiny);
  const headerH = cellFont + 10;

  const drawHeaderRow = () => {
    const y = doc.y;
    doc.rect(left, y, tableWidth, headerH).fill(theme.accent);
    let x = left;
    doc.font(theme.font.bold).fontSize(cellFont).fillColor('#ffffff');
    columns.forEach((c, ci) => {
      doc.text(c.label, x + 3, y + 5, { width: w[ci] - 6, align: c.align ?? 'left', lineBreak: false });
      x += w[ci];
    });
    doc.y = y + headerH;
    doc.fillColor(theme.ink);
  };

  drawHeaderRow();

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    doc.font(theme.font.regular).fontSize(cellFont);
    const cellHeights = columns.map((_c, ci) => doc.heightOfString(cells[ci] ?? '', { width: w[ci] - 6 }));
    const rowH = Math.max(cellFont + 5, ...cellHeights) + 4;

    if (doc.y + rowH > doc.page.height - theme.margin - 24) {
      doc.addPage();
      doc.y = theme.margin;
      drawHeaderRow();
    }

    const y = doc.y;
    if (i % 2 === 1) {
      doc.rect(left, y, tableWidth, rowH).fill(theme.soft);
    }
    let x = left;
    doc.fillColor(theme.ink).font(theme.font.regular).fontSize(cellFont);
    columns.forEach((c, ci) => {
      doc.text(cells[ci] ?? '', x + 3, y + 3, { width: w[ci] - 6, align: c.align ?? 'left' });
      x += w[ci];
    });
    doc.y = y + rowH;
  }

  doc.moveTo(left, doc.y).lineTo(left + tableWidth, doc.y).strokeColor(theme.hairline).stroke();
}

/**
 * The statutory certification. Part of the form, so not configurable — the
 * template's signature block is drawn after it at finalize time.
 */
function drawCertification(doc: PDFKit.PDFDocument, theme: PdfTheme, count: number) {
  // Re-anchor x at the left margin — after the table the cursor sits at the last column.
  doc.moveDown(0.8);
  doc
    .font(theme.font.regular)
    .fontSize(theme.size.tiny)
    .fillColor(theme.muted)
    .text(`${count} record(s). Generated ${fmtDateTime(new Date())} IST.`, theme.margin, doc.y, {
      width: theme.contentWidth,
    });
  doc.moveDown(0.6);
  doc
    .font(theme.font.italic)
    .fontSize(theme.size.tiny)
    .fillColor(theme.muted)
    .text(
      'Computer-generated statutory register under the NDPS Act. Retain for inspection.',
      theme.margin,
      doc.y,
      { align: 'center', width: theme.contentWidth },
    );
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

/** Prescribed under the NDPS Act — not a hospital-configurable caption. */
const TITLES_DAILY = 'FORM 3H — Daily Account of Narcotic Drugs';

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
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const formType = opts.formType in TITLES ? opts.formType : 'all';
  const { pdf: doc, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: 'NDPS Register',
    subtitle: TITLES[formType],
    filename: `ndps-form-${formType}-${new Date().toISOString().slice(0, 10)}.pdf`,
  });

  drawFormCaption(doc, theme, TITLES[formType], { from: opts.from, to: opts.to });

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
    doc
      .font(theme.font.italic)
      .fontSize(theme.size.body)
      .fillColor(theme.muted)
      .text('No records for this register in the selected period.', theme.margin, doc.y, {
        width: theme.contentWidth,
      });
  } else {
    drawTable(doc, theme, columns, rows);
  }
  drawCertification(doc, theme, rows.length);
  finalizeBrandedDocument({ pdf: doc, branding, theme });
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
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const { pdf: doc, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: 'NDPS Daily Statement',
    subtitle: TITLES_DAILY,
    filename: `ndps-form-3h-${new Date().toISOString().slice(0, 10)}.pdf`,
  });

  drawFormCaption(doc, theme, TITLES_DAILY, { from: opts.from, to: opts.to });

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
    doc
      .font(theme.font.italic)
      .fontSize(theme.size.body)
      .fillColor(theme.muted)
      .text('No daily accounts for the selected period.', theme.margin, doc.y, {
        width: theme.contentWidth,
      });
  } else {
    drawTable(doc, theme, columns, rows);
  }
  drawCertification(doc, theme, rows.length);
  finalizeBrandedDocument({ pdf: doc, branding, theme });
}
