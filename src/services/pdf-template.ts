// ---------------------------------------------------------------------------
// Per-document-type PDF templates.
//
// The PDF Builder used to be a letterhead editor: one logo, one accent colour,
// one footer note, applied identically to every document. Which meant a hospital
// could not print discharge summaries on A4 portrait and the NDPS register on
// A4 landscape, could not stamp DUPLICATE across a reprinted receipt, could not
// put a signature block on a salary slip, and could not add its own consent
// paragraph to a prescription.
//
// A template is the presentation contract for ONE document type: page setup,
// typography, colours, what the header and footer show, watermark, table style,
// signature block and any custom text blocks the hospital wants to add. The
// document BODY stays code-owned — a discharge summary's clinical content is not
// something an admin should be able to drag around — but everything wrapping it
// is now configurable per type.
//
// Storage is `Tenant.themeConfig.pdfTemplates`, the same migration-free place
// the letterhead already lives (see hospital-branding.service).
//
// Resolution is three layers, so "set it once for everything" and "but the
// register is landscape" both work:
//     DEFAULT_TEMPLATE  ←  themeConfig.pdfTemplates.__all__  ←  ….<documentType>
// ---------------------------------------------------------------------------

export type PdfPageSize = 'A4' | 'A5' | 'LETTER' | 'LEGAL';
export type PdfOrientation = 'portrait' | 'landscape';
/** PDFKit's three built-in families — no font files to ship. */
export type PdfFontFamily = 'Helvetica' | 'Times' | 'Courier';

export interface PdfPageSetup {
  size: PdfPageSize;
  orientation: PdfOrientation;
  /** Page margin in points (1pt = 1/72"). */
  margin: number;
}

export interface PdfTypography {
  fontFamily: PdfFontFamily;
  /** Body text size in points. Headings and small print scale off this. */
  baseFontSize: number;
  lineGap: number;
}

export interface PdfColors {
  /** null inherits the letterhead accent, so one colour change repaints everything. */
  accent: string | null;
  ink: string;
  muted: string;
}

export interface PdfHeaderOptions {
  /** Off prints on pre-printed stationery that already carries the letterhead. */
  showLetterhead: boolean;
  headerStyle: 'inherit' | 'centered' | 'left';
  showTitleBar: boolean;
  /** Renames the document, e.g. "Prescription" → "Advice & Prescription". */
  titleOverride: string | null;
  showMetaStrip: boolean;
}

export interface PdfFooterOptions {
  showFooter: boolean;
  /** Overrides the letterhead's footer note for this document type only. */
  footerTextOverride: string | null;
  showPageNumbers: boolean;
  showGeneratedAt: boolean;
}

export interface PdfWatermark {
  enabled: boolean;
  text: string;
  /** 0.02–0.4. Anything heavier fights the text underneath. */
  opacity: number;
  angle: number;
  /** null uses the accent colour. */
  color: string | null;
  fontSize: number;
}

export interface PdfTableStyle {
  density: 'compact' | 'normal' | 'comfortable';
  headerFill: 'accent' | 'muted' | 'none';
  zebraRows: boolean;
  gridLines: 'none' | 'horizontal' | 'all';
}

export interface PdfSignatureBlock {
  enabled: boolean;
  /** One ruled signing line per label, laid out across the page. */
  labels: string[];
  /** Height of the block in points — room above the rule for a wet signature. */
  height: number;
}

export interface PdfCustomBlock {
  id: string;
  position: 'before_body' | 'after_body';
  heading: string | null;
  text: string;
}

export interface PdfTemplate {
  page: PdfPageSetup;
  typography: PdfTypography;
  colors: PdfColors;
  header: PdfHeaderOptions;
  footer: PdfFooterOptions;
  watermark: PdfWatermark;
  table: PdfTableStyle;
  signature: PdfSignatureBlock;
  blocks: PdfCustomBlock[];
}

export const DEFAULT_INK = '#1a2332';
export const DEFAULT_MUTED = '#5b6472';

export const DEFAULT_TEMPLATE: PdfTemplate = {
  page: { size: 'A4', orientation: 'portrait', margin: 42 },
  typography: { fontFamily: 'Helvetica', baseFontSize: 9, lineGap: 2 },
  colors: { accent: null, ink: DEFAULT_INK, muted: DEFAULT_MUTED },
  header: {
    showLetterhead: true,
    headerStyle: 'inherit',
    showTitleBar: true,
    titleOverride: null,
    showMetaStrip: true,
  },
  footer: {
    showFooter: true,
    footerTextOverride: null,
    showPageNumbers: true,
    showGeneratedAt: true,
  },
  watermark: { enabled: false, text: 'COPY', opacity: 0.08, angle: -35, color: null, fontSize: 90 },
  table: { density: 'normal', headerFill: 'accent', zebraRows: true, gridLines: 'horizontal' },
  signature: { enabled: false, labels: ['Authorised Signatory'], height: 48 },
  blocks: [],
};

// ── Document registry ──────────────────────────────────────────────────────
// Every PDF the system produces. The builder lists these so an admin can see
// the full reach and style each one; each generator passes its own key so the
// right template is applied. Adding a PDF means adding a row here.

export const PDF_DOCUMENT_TYPES = [
  'prescription',
  'discharge_summary',
  'ip_bill',
  'op_bill',
  'payment_receipt',
  'salary_slip',
  'ndps_register',
  'ndps_daily',
] as const;

export type PdfDocumentType = (typeof PDF_DOCUMENT_TYPES)[number];

/** The pseudo-type that carries defaults for every document. */
export const ALL_DOCUMENTS_KEY = '__all__';

export interface PdfDocumentMeta {
  key: PdfDocumentType;
  label: string;
  group: string;
  description: string;
  /** The title the generator passes when the template does not override it. */
  defaultTitle: string;
}

export const PDF_DOCUMENT_REGISTRY: PdfDocumentMeta[] = [
  {
    key: 'prescription',
    label: 'Prescription',
    group: 'Clinical',
    description: 'What the doctor hands the patient at the end of a consultation.',
    defaultTitle: 'Prescription',
  },
  {
    key: 'discharge_summary',
    label: 'Discharge Summary',
    group: 'Clinical',
    description: 'The IP discharge record, printed and sent to the patient portal.',
    defaultTitle: 'Discharge Summary',
  },
  {
    key: 'ip_bill',
    label: 'IP / Emergency / DayCare Bill',
    group: 'Billing',
    description: 'The consolidated admission bill, interim or final.',
    defaultTitle: 'Inpatient Bill',
  },
  {
    key: 'op_bill',
    label: 'OP / Counter Bill',
    group: 'Billing',
    // Healthcare services are GST-exempt in India, so for most hospitals this
    // is a bill of supply rather than a tax invoice — it names itself from the
    // template title, and only shows a tax line when something on it is taxed.
    description: 'The itemised outpatient bill, printable whether or not it has been paid.',
    defaultTitle: 'Bill',
  },
  {
    key: 'payment_receipt',
    label: 'Payment Receipt',
    group: 'Billing',
    description: 'Issued against a payment, a reversal or a bill cancellation.',
    defaultTitle: 'Payment Receipt',
  },
  {
    key: 'salary_slip',
    label: 'Salary Slip',
    group: 'HR',
    description: 'Monthly payslip for a staff member.',
    defaultTitle: 'Salary Slip',
  },
  {
    key: 'ndps_register',
    label: 'NDPS Register',
    group: 'Compliance',
    description: 'The narcotics register extract — a statutory record.',
    defaultTitle: 'NDPS Register',
  },
  {
    key: 'ndps_daily',
    label: 'NDPS Daily Statement',
    group: 'Compliance',
    description: 'Day-wise narcotics movement summary.',
    defaultTitle: 'NDPS Daily Statement',
  },
];

export function isPdfDocumentType(v: unknown): v is PdfDocumentType {
  return typeof v === 'string' && (PDF_DOCUMENT_TYPES as readonly string[]).includes(v);
}

/**
 * Built-in per-type starting points, applied under the hospital's own settings.
 *
 * These are not opinions — they preserve how these documents already printed
 * before templates existed. A payslip has always carried two signing lines and
 * the NDPS register has always needed the width for its seven columns; a
 * hospital that has never opened the builder must still get those.
 */
export const DOCUMENT_TYPE_DEFAULTS: Partial<Record<PdfDocumentType, unknown>> = {
  salary_slip: {
    signature: { enabled: true, labels: ['Employee Signature', 'HR / Authorised Signatory'], height: 52 },
  },
  ndps_register: {
    page: { orientation: 'landscape' },
    table: { density: 'compact' },
    signature: { enabled: true, labels: ['Pharmacist', 'Witness', 'Verified by'], height: 52 },
  },
  ndps_daily: {
    signature: { enabled: true, labels: ['Pharmacist', 'Verified by'], height: 52 },
  },
};

// ── Merge + validation ─────────────────────────────────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;

function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v : fallback;
}

function hexOrNull(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' && HEX.test(v) ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

function strOrNull(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v.trim() ? v : null;
  return fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Fold a partial (and untrusted — it comes off the wire and out of a JSON
 * column) template over a base, clamping every value into a range that can
 * actually render. A stored template written by an older build, or hand-edited
 * JSON, must never be able to produce an unopenable PDF.
 */
export function mergeTemplate(base: PdfTemplate, patch: unknown): PdfTemplate {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const obj = (k: string): Record<string, unknown> => {
    const v = p[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };

  const page = obj('page');
  const typo = obj('typography');
  const colors = obj('colors');
  const header = obj('header');
  const footer = obj('footer');
  const watermark = obj('watermark');
  const table = obj('table');
  const signature = obj('signature');

  const rawLabels = Array.isArray((signature as { labels?: unknown }).labels)
    ? ((signature as { labels: unknown[] }).labels
        .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        .map((l) => l.trim())
        .slice(0, 4))
    : null;

  return {
    page: {
      size: oneOf(page.size, ['A4', 'A5', 'LETTER', 'LEGAL'] as const, base.page.size),
      orientation: oneOf(page.orientation, ['portrait', 'landscape'] as const, base.page.orientation),
      // Below ~18pt the footer runs off the page; above ~90 there is no room left.
      margin: Math.round(num(page.margin, base.page.margin, 18, 90)),
    },
    typography: {
      fontFamily: oneOf(typo.fontFamily, ['Helvetica', 'Times', 'Courier'] as const, base.typography.fontFamily),
      baseFontSize: num(typo.baseFontSize, base.typography.baseFontSize, 6, 14),
      lineGap: num(typo.lineGap, base.typography.lineGap, 0, 8),
    },
    colors: {
      accent: hexOrNull(colors.accent, base.colors.accent),
      ink: hex(colors.ink, base.colors.ink),
      muted: hex(colors.muted, base.colors.muted),
    },
    header: {
      showLetterhead: bool(header.showLetterhead, base.header.showLetterhead),
      headerStyle: oneOf(header.headerStyle, ['inherit', 'centered', 'left'] as const, base.header.headerStyle),
      showTitleBar: bool(header.showTitleBar, base.header.showTitleBar),
      titleOverride: strOrNull(header.titleOverride, base.header.titleOverride),
      showMetaStrip: bool(header.showMetaStrip, base.header.showMetaStrip),
    },
    footer: {
      showFooter: bool(footer.showFooter, base.footer.showFooter),
      footerTextOverride: strOrNull(footer.footerTextOverride, base.footer.footerTextOverride),
      showPageNumbers: bool(footer.showPageNumbers, base.footer.showPageNumbers),
      showGeneratedAt: bool(footer.showGeneratedAt, base.footer.showGeneratedAt),
    },
    watermark: {
      enabled: bool(watermark.enabled, base.watermark.enabled),
      text: str(watermark.text, base.watermark.text).slice(0, 40),
      // Hard-capped: a watermark dark enough to obscure a dose is a safety issue.
      opacity: num(watermark.opacity, base.watermark.opacity, 0.02, 0.4),
      angle: num(watermark.angle, base.watermark.angle, -90, 90),
      color: hexOrNull(watermark.color, base.watermark.color),
      fontSize: num(watermark.fontSize, base.watermark.fontSize, 20, 200),
    },
    table: {
      density: oneOf(table.density, ['compact', 'normal', 'comfortable'] as const, base.table.density),
      headerFill: oneOf(table.headerFill, ['accent', 'muted', 'none'] as const, base.table.headerFill),
      zebraRows: bool(table.zebraRows, base.table.zebraRows),
      gridLines: oneOf(table.gridLines, ['none', 'horizontal', 'all'] as const, base.table.gridLines),
    },
    signature: {
      enabled: bool(signature.enabled, base.signature.enabled),
      labels: rawLabels && rawLabels.length ? rawLabels : base.signature.labels,
      height: num(signature.height, base.signature.height, 30, 120),
    },
    blocks: Array.isArray(p.blocks) ? coerceBlocks(p.blocks) : base.blocks,
  };
}

function coerceBlocks(raw: unknown[]): PdfCustomBlock[] {
  const out: PdfCustomBlock[] = [];
  // Six is already more than any real document needs, and each one costs page
  // space that the clinical body has to give up.
  for (const r of raw.slice(0, 6)) {
    if (!r || typeof r !== 'object') continue;
    const b = r as Record<string, unknown>;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const heading = typeof b.heading === 'string' ? b.heading.trim() : '';
    if (!text && !heading) continue;
    out.push({
      id: typeof b.id === 'string' && b.id ? b.id : `block-${out.length + 1}`,
      position: oneOf(b.position, ['before_body', 'after_body'] as const, 'after_body'),
      heading: heading || null,
      text: text.slice(0, 2000),
    });
  }
  return out;
}

// ── Rendering theme ────────────────────────────────────────────────────────

/** Page dimensions in points, portrait. PDFKit knows the names; we need the numbers. */
const PAGE_DIMS: Record<PdfPageSize, [number, number]> = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
};

export function pageDimensions(page: PdfPageSetup): { width: number; height: number } {
  const [w, h] = PAGE_DIMS[page.size] ?? PAGE_DIMS.A4;
  return page.orientation === 'landscape' ? { width: h, height: w } : { width: w, height: h };
}

/** Row height for a table at the template's density, at a given font size. */
export function tableRowHeight(t: PdfTemplate): number {
  const base = t.typography.baseFontSize;
  const pad = t.table.density === 'compact' ? 5 : t.table.density === 'comfortable' ? 11 : 7.5;
  return Math.round((base + pad) * 10) / 10;
}

/** PDFKit font names for the chosen family. */
export function fontNames(family: PdfFontFamily): {
  regular: string;
  bold: string;
  italic: string;
} {
  if (family === 'Times') {
    return { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' };
  }
  if (family === 'Courier') {
    return { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' };
}
