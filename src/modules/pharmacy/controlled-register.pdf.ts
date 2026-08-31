import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  drawSectionHeading,
  drawTable,
  type TableRow,
} from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';
import type { DrugLicenceSettings } from '../../shared/controlled-drug';
import type { RegisterRow } from './controlled-register.service';

// ---------------------------------------------------------------------------
// The Controlled-Drug Register, as the document an inspector is handed.
//
// Two things make this a statutory record rather than a screen dump:
//
//   The licence block. A register is filed against a specific licence at a
//   specific premises in a specific state. Without those the page is just a
//   list of medicines, so when they are missing the document says so in place
//   rather than printing a blank line — a reader must be able to tell an
//   unconfigured system from a licence that genuinely has no number.
//
//   The closing declaration. A register is signed; an unsigned print-out is
//   not a register. The signature block is part of the document, not something
//   the pharmacist is expected to add by hand afterwards.
// ---------------------------------------------------------------------------

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

const dmy = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(dt.getTime())
    ? '—'
    : `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

const dmyTime = (d: Date | string) => {
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return '—';
  return `${dmy(dt)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
};

export interface RegisterPdfInput {
  rows: RegisterRow[];
  summary: {
    openingStock: number;
    inward: number;
    outward: number;
    internalTransfer: number;
    closingBalance: number;
  };
  window: { from: Date; to: Date };
  licence: DrugLicenceSettings;
  /** What the register was filtered to, printed so the scope is unambiguous. */
  scopeLabel: string;
}

export function streamControlledRegisterPdf(
  res: Response,
  input: RegisterPdfInput,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const { rows, summary, window, licence } = input;

  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: 'Controlled-Drug Register',
    subtitle: input.scopeLabel,
    meta: [
      { label: 'Period', value: `${dmy(window.from)} – ${dmy(window.to)}` },
      { label: 'Entries', value: String(rows.length) },
    ],
    filename: `controlled-drug-register-${dmy(window.from).replace(/\//g, '-')}.pdf`,
  });

  // ── Licence block ────────────────────────────────────────────────────────
  drawSectionHeading(pdf, theme, 'LICENCE PARTICULARS');
  const licenceLines: Array<[string, string]> = [
    ['Retail licence (Form 20/21)', dash(licence.retailLicenceNumber)],
    ['Wholesale licence (20B/21B)', dash(licence.wholesaleLicenceNumber)],
    ['NDPS licence', dash(licence.ndpsLicenceNumber)],
    ['State', dash(licence.state)],
    ['Licence holder', dash(licence.licenceHolderName || branding.name)],
    ['Registered premises', dash(licence.premisesAddress)],
  ];
  pdf.font(theme.font.regular).fontSize(theme.size.small).fillColor(theme.ink);
  const colW = theme.contentWidth / 2;
  licenceLines.forEach(([label, value], i) => {
    const x = theme.margin + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) pdf.moveDown(0.15);
    const y = pdf.y;
    pdf.fillColor(theme.muted).text(`${label}: `, x, y, { width: colW, continued: true });
    pdf.fillColor(theme.ink).text(value);
    if (i % 2 === 0) pdf.y = y; // keep the pair on one line
  });
  pdf.moveDown(0.6);

  if (!licence.retailLicenceNumber || !licence.state) {
    // Said in place rather than left blank: a reader must be able to tell an
    // unconfigured system from a licence that genuinely carries no number.
    pdf
      .font(theme.font.bold)
      .fontSize(theme.size.tiny)
      .fillColor('#b45309')
      .text(
        'LICENCE DETAILS NOT CONFIGURED — set them under Settings → Controlled Drugs before filing this register.',
        theme.margin,
        pdf.y,
        { width: theme.contentWidth, align: 'center' },
      );
    pdf.moveDown(0.6);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  drawSectionHeading(pdf, theme, 'SUMMARY');
  const sumRow: TableRow = [
    String(summary.openingStock),
    String(summary.inward),
    String(summary.outward),
    String(summary.internalTransfer),
    String(summary.closingBalance),
  ];
  drawTable(
    pdf,
    theme,
    [
      { header: 'Opening stock', width: 1, align: 'right' },
      { header: 'Inward', width: 1, align: 'right' },
      { header: 'Outward', width: 1, align: 'right' },
      { header: 'Internal transfer', width: 1, align: 'right' },
      { header: 'Closing balance', width: 1, align: 'right' },
    ],
    [sumRow],
  );
  pdf
    .font(theme.font.regular)
    .fontSize(theme.size.tiny)
    .fillColor(theme.muted)
    .text(
      'Internal transfers move stock between the vault and its sub-stores. They are listed for custody and are not counted in the balance — hospital-wide they net to zero.',
      theme.margin,
      pdf.y + 2,
      { width: theme.contentWidth },
    );
  pdf.moveDown(0.8);

  // ── Ledger ───────────────────────────────────────────────────────────────
  drawSectionHeading(pdf, theme, 'MOVEMENT LEDGER');
  drawTable(
    pdf,
    theme,
    [
      { header: 'Date/Time', width: 1.4 },
      { header: 'Txn', width: 1.4 },
      { header: 'Item / API', width: 2.6 },
      { header: 'Batch', width: 1.2 },
      // Wide enough for a whole date. At 1.0 "31/12/2026" wrapped after the
      // eighth character and the column read as a different date entirely.
      { header: 'Expiry', width: 1.35 },
      { header: 'Open', width: 0.7, align: 'right' },
      { header: 'In', width: 0.6, align: 'right' },
      { header: 'Out', width: 0.6, align: 'right' },
      { header: 'Tfr', width: 0.6, align: 'right' },
      { header: 'Close', width: 0.7, align: 'right' },
      { header: 'Patient / Dept', width: 1.8 },
      { header: 'Prescriber', width: 1.45 },
      { header: 'Verified by', width: 1.1 },
    ],
    rows.map((r) => [
      dmyTime(r.occurredAt),
      `${r.txnType}\n${r.txnId}`,
      r.apiStrength ? `${r.itemName}\n${r.apiStrength}` : r.itemName,
      dash(r.batchNumber),
      dmy(r.expiryDate),
      String(r.opening),
      r.qtyIn ? String(r.qtyIn) : '',
      r.qtyOut ? String(r.qtyOut) : '',
      r.transferQty ? String(r.transferQty) : '',
      String(r.closing),
      dash(r.patientOrDept),
      dash(r.prescriber),
      dash(r.verification),
    ]),
  );

  if (rows.length === 0) {
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text('No controlled-drug movement in this period.', theme.margin, pdf.y + 6, {
        width: theme.contentWidth,
        align: 'center',
      });
  }

  // ── Declaration ──────────────────────────────────────────────────────────
  // A register is signed. An unsigned print-out is not a register, so the
  // signature block is part of the document rather than something added later.
  pdf.moveDown(1.2);
  pdf
    .font(theme.font.regular)
    .fontSize(theme.size.tiny)
    .fillColor(theme.ink)
    .text(
      'Certified that the above is a true extract of the controlled-drug register maintained at this premises for the period stated.',
      theme.margin,
      pdf.y,
      { width: theme.contentWidth },
    );
  pdf.moveDown(2);
  const half = theme.contentWidth / 2;
  const lineY = pdf.y;
  pdf
    .strokeColor(theme.muted)
    .lineWidth(0.5)
    .moveTo(theme.margin, lineY).lineTo(theme.margin + half - 20, lineY)
    .moveTo(theme.margin + half + 20, lineY).lineTo(theme.margin + theme.contentWidth, lineY)
    .stroke();
  pdf
    .font(theme.font.regular)
    .fontSize(theme.size.tiny)
    .fillColor(theme.muted)
    .text('Registered Pharmacist', theme.margin, lineY + 4, { width: half - 20 })
    .text('Date & Seal', theme.margin + half + 20, lineY + 4, { width: half - 20 });

  finalizeBrandedDocument({ pdf, theme, branding });
}

// ---------------------------------------------------------------------------
// FORM 35 — the Inspection Book layout.
//
// The register above is how the hospital reads its own controlled stock. This
// is the sheet a drug inspector is handed and signs, and its shape is not ours
// to choose: twelve fixed columns, the licence and premises named in a band
// across the top, and a signature block for the head pharmacist AND the
// inspector at the foot. An unsigned print-out is not a Form 35.
//
// Landscape is forced. Twelve columns do not fit portrait, and a register that
// wraps its columns is one an inspector will refuse.
// ---------------------------------------------------------------------------

// Widths are set so each header's LONGEST WORD fits on one line. Left to
// themselves the numeric columns broke "OUTWARD" into "OUTWAR / D", which looks
// like a fault on a sheet a drug inspector signs.
const FORM35_COLUMNS: { header: string; width: number; align?: 'left' | 'right' | 'center' }[] = [
  { header: 'DATE', width: 0.055 },
  { header: 'VOUCHER/INVOICE #', width: 0.085 },
  { header: 'ITEM NAME', width: 0.125 },
  { header: 'BATCH #', width: 0.065 },
  { header: 'EXPIRY', width: 0.050, align: 'center' },
  { header: 'OPENING STOCK', width: 0.065, align: 'right' },
  { header: 'INWARD QTY', width: 0.060, align: 'right' },
  { header: 'OUTWARD QTY', width: 0.068, align: 'right' },
  { header: 'TRANSFERS (3H)', width: 0.075, align: 'right' },
  { header: 'CLOSING BALANCE', width: 0.068, align: 'right' },
  { header: 'PATIENT/DOCTOR/STORE DETAILS', width: 0.155 },
  { header: 'VERIFIED BY', width: 0.129 },
];

export function streamForm35Pdf(
  res: Response,
  input: RegisterPdfInput,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const { rows, window, licence } = input;

  // Force landscape whatever the hospital's template says — see above.
  const landscape: PdfTemplate | undefined = template
    ? { ...template, page: { ...template.page, orientation: 'landscape' } }
    : undefined;

  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template: landscape,
    title: 'FORM 35 / DRUG REGISTER — SCHEDULE X / NDPS (NARCOTICS)',
    subtitle: input.scopeLabel,
    filename: `form-35-${dmy(window.from).replace(/\//g, '-')}.pdf`,
  });

  // ── The identifying band ────────────────────────────────────────────────
  // Licence, premises and period on one line, the way the printed book has it.
  // Missing values print as an em dash rather than a blank, so a reader can
  // tell an unconfigured system from a licence with genuinely no number.
  const band = [
    `NDPS LICENCE NO: ${dash(licence.ndpsLicenceNumber)}`,
    `FACILITY: ${(licence.licenceHolderName || branding.name || '—').toUpperCase()}`,
    `PREMISES: ${dash(licence.premisesAddress)}`,
    `PERIOD: ${dmy(window.from)} – ${dmy(window.to)}`,
  ].join('   |   ');

  pdf.font(theme.font.bold).fontSize(theme.size.small).fillColor(theme.ink);
  pdf.text(band, theme.margin, pdf.y, { width: theme.contentWidth });
  pdf.moveDown(0.6);

  // ── The ledger ──────────────────────────────────────────────────────────
  const body: TableRow[] = rows.map((r) => [
    dmy(r.occurredAt),
    dash(r.txnId),
    r.itemName,
    dash(r.batchNumber),
    r.expiryDate ? dmy(r.expiryDate).slice(3) : '—', // MM/YYYY, as the book prints it
    String(r.opening),
    r.qtyIn ? String(r.qtyIn) : '0',
    r.qtyOut ? String(r.qtyOut) : '0',
    r.transferQty ? String(r.transferQty) : '0',
    String(r.closing),
    // One cell for whoever the movement was for: a patient and their
    // prescriber, or the store the stock moved to.
    [r.patientOrDept, r.prescriber].filter(Boolean).join(', ') || '—',
    dash(r.verification),
  ]);

  if (!body.length) {
    pdf.font(theme.font.regular).fontSize(theme.size.small).fillColor(theme.muted);
    pdf.text('No controlled-drug movement was recorded in this period.', theme.margin, pdf.y, {
      width: theme.contentWidth,
    });
    pdf.moveDown(1);
  } else {
    drawTable(pdf, theme, FORM35_COLUMNS, body);
  }

  // ── Sign-off ────────────────────────────────────────────────────────────
  pdf.moveDown(1.2);
  pdf.font(theme.font.bold).fontSize(theme.size.small).fillColor(theme.ink);
  pdf.text('VERIFICATION SIGN-OFF', theme.margin, pdf.y, { width: theme.contentWidth });
  pdf.moveDown(1.4);

  const half = theme.contentWidth / 2;
  const y = pdf.y;
  pdf.font(theme.font.regular).fontSize(theme.size.small).fillColor(theme.muted);
  pdf.text('HEAD PHARMACIST SIGNATURE & SEAL: ______________________', theme.margin, y, {
    width: half,
  });
  pdf.text('DRUG INSPECTOR SIGNATURE & SEAL: ______________________', theme.margin + half, y, {
    width: half,
  });

  pdf.moveDown(1.2);
  pdf.fontSize(theme.size.small - 1).fillColor(theme.muted);
  pdf.text(`Printed: ${dmyTime(new Date())}`, theme.margin, pdf.y, {
    width: theme.contentWidth,
    align: 'right',
  });

  finalizeBrandedDocument({ pdf, theme, branding });
}
