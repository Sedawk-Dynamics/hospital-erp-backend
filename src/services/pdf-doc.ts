import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import {
  drawBrandedHeader,
  drawBrandedFooters,
  tintHex,
  DEFAULT_ACCENT,
  type HospitalBranding,
  type PdfMetaItem,
} from './pdf-branding';
import {
  DEFAULT_TEMPLATE,
  fontNames,
  pageDimensions,
  tableRowHeight,
  type PdfTemplate,
} from './pdf-template';
import { registerEmbeddedFonts } from './pdf-fonts';

// ---------------------------------------------------------------------------
// The one way to make a PDF in this app.
//
// Every generator used to open its own PDFDocument with its own hardcoded page
// size, margin, fonts and table colours, then call the shared header/footer. So
// the PDF Builder could change the letterhead and nothing else: a hospital could
// not print the NDPS register landscape, stamp DUPLICATE on a reprinted receipt,
// or put a signature line on a payslip.
//
// createBrandedDocument applies the document type's template — page setup,
// typography, colours, header, watermark, before-body blocks — and hands back a
// `theme` the body draws with. finalizeBrandedDocument closes it out with the
// after-body blocks, signature block, watermark on every page and the footer.
//
//   const { pdf, theme } = createBrandedDocument({ res, branding, template,
//     title: 'Payment Receipt', filename: 'receipt-123.pdf' });
//   … body …
//   finalizeBrandedDocument({ pdf, branding, template, theme });
// ---------------------------------------------------------------------------

export interface PdfTheme {
  margin: number;
  contentWidth: number;
  accent: string;
  ink: string;
  muted: string;
  /** Very light accent tint — card fills, zebra rows. */
  soft: string;
  hairline: string;
  font: { regular: string; bold: string; italic: string };
  size: {
    body: number;
    small: number;
    tiny: number;
    heading: number;
    title: number;
  };
  lineGap: number;
  rowHeight: number;
  template: PdfTemplate;
}

const HAIRLINE = '#d3d8de';

export function buildTheme(template: PdfTemplate, branding: HospitalBranding): PdfTheme {
  const accent =
    template.colors.accent ??
    (/^#[0-9a-fA-F]{6}$/.test(branding.accentColor) ? branding.accentColor : DEFAULT_ACCENT);
  const body = template.typography.baseFontSize;
  const dims = pageDimensions(template.page);
  return {
    margin: template.page.margin,
    contentWidth: dims.width - template.page.margin * 2,
    accent,
    ink: template.colors.ink,
    muted: template.colors.muted,
    soft: tintHex(accent, 0.9),
    hairline: HAIRLINE,
    font: fontNames(template.typography.fontFamily),
    size: {
      body,
      small: Math.max(6, body - 1),
      tiny: Math.max(5.5, body - 2),
      heading: body + 1.5,
      title: body + 2.5,
    },
    lineGap: template.typography.lineGap,
    rowHeight: tableRowHeight(template),
    template,
  };
}

export interface CreateDocOptions {
  /** When given, headers are set and the document is piped straight to the client. */
  res?: Response;
  branding: HospitalBranding;
  template?: PdfTemplate;
  /** Document title for the accent bar. The template may override it. */
  title: string;
  subtitle?: string;
  meta?: PdfMetaItem[];
  filename?: string;
  /** `attachment` forces a download instead of an inline view. */
  disposition?: 'inline' | 'attachment';
  /**
   * Skip the before-body blocks — for a generator that needs something of its
   * own above them and so places them itself with {@link drawCustomBlocks}.
   */
  skipBlocks?: boolean;
}

export interface BrandedDocument {
  pdf: PDFKit.PDFDocument;
  theme: PdfTheme;
  template: PdfTemplate;
}

export function createBrandedDocument(opts: CreateDocOptions): BrandedDocument {
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const theme = buildTheme(template, opts.branding);
  const dims = pageDimensions(template.page);

  const pdf = new PDFDocument({
    size: [dims.width, dims.height],
    margin: template.page.margin,
    bufferPages: true,
  });

  if (opts.res) {
    const name = opts.filename ?? 'document.pdf';
    opts.res.setHeader('Content-Type', 'application/pdf');
    opts.res.setHeader(
      'Content-Disposition',
      `${opts.disposition ?? 'inline'}; filename="${name.replace(/"/g, '')}"`,
    );
    pdf.pipe(opts.res);
  }

  // Swap in the embedded faces for the family the template asked for. Done here,
  // on the theme, so every generator and the shared header/footer pick them up
  // without knowing about it — and so an install without the font files still
  // produces a document, just without a rupee sign.
  const embedded = registerEmbeddedFonts(pdf, template.typography.fontFamily);
  if (embedded) theme.font = embedded;

  // The body's default text style. Generators that set their own font per call
  // still get the right family because fontNames() resolved it.
  pdf.font(theme.font.regular).fontSize(theme.size.body).fillColor(theme.ink);

  drawBrandedHeader(pdf, opts.branding, {
    title: template.header.titleOverride ?? opts.title,
    subtitle: opts.subtitle,
    meta: opts.meta,
    margin: theme.margin,
    contentWidth: theme.contentWidth,
    template,
    theme,
  });

  if (!opts.skipBlocks) drawCustomBlocks(pdf, theme, 'before_body');

  return { pdf, theme, template };
}

export interface FinalizeOptions {
  pdf: PDFKit.PDFDocument;
  branding: HospitalBranding;
  theme: PdfTheme;
  generatedAt?: Date;
  /** Skip the after-body blocks — for generators that place them themselves. */
  skipBlocks?: boolean;
}

/**
 * Close a branded document: after-body blocks, signature block, then the
 * watermark and footer on every buffered page. Ends the document.
 */
export function finalizeBrandedDocument(opts: FinalizeOptions): void {
  const { pdf, branding, theme } = opts;
  if (!opts.skipBlocks) drawCustomBlocks(pdf, theme, 'after_body');
  drawSignatureBlock(pdf, theme);
  drawWatermarks(pdf, theme);
  drawBrandedFooters(pdf, branding, {
    margin: theme.margin,
    contentWidth: theme.contentWidth,
    generatedAt: opts.generatedAt,
    template: theme.template,
    theme,
  });
  pdf.end();
}

// ── Building blocks generators draw with ──────────────────────────────────

/** A left-accent-ruled section heading. */
export function drawSectionHeading(pdf: PDFKit.PDFDocument, theme: PdfTheme, text: string): void {
  ensureSpace(pdf, theme, 26);
  const y = pdf.y;
  const h = theme.size.heading + 2;
  pdf.rect(theme.margin, y, 3, h).fill(theme.accent);
  pdf
    .font(theme.font.bold)
    .fontSize(theme.size.heading)
    .fillColor(theme.ink)
    .text(text.toUpperCase(), theme.margin + 8, y, { width: theme.contentWidth - 8 });
  pdf.moveDown(0.4);
}

export interface TableColumn {
  header: string;
  /** Share of the content width, 0..1. Shares are normalised. */
  width: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * A row of plain cells, or one with a kind:
 *
 *  - `group` — a heading that spans the table, tinted and bold, for an itemised
 *    list broken into heads (a bill's charge categories).
 *  - `total` — the subtotal under such a group: bold, no tint.
 *
 * `zebra` overrides the automatic striping, so a caller that groups its rows can
 * stripe within each group instead of down the whole table.
 */
export type TableRow = string[] | { cells: string[]; kind?: 'group' | 'total'; zebra?: boolean };

const rowCells = (r: TableRow): string[] => (Array.isArray(r) ? r : r.cells);
const rowKind = (r: TableRow) => (Array.isArray(r) ? undefined : r.kind);

/**
 * A table styled by the document's template — header fill, zebra, grid lines and
 * row density all come from there, so one setting restyles every table in the
 * app. Repeats the header row after a page break.
 */
export function drawTable(
  pdf: PDFKit.PDFDocument,
  theme: PdfTheme,
  columns: TableColumn[],
  rows: TableRow[],
): void {
  const t = theme.template.table;
  const totalShare = columns.reduce((n, c) => n + c.width, 0) || 1;
  const widths = columns.map((c) => (c.width / totalShare) * theme.contentWidth);
  const rowH = theme.rowHeight;
  const left = theme.margin;

  // A cell may carry more than one line — the controlled-drug register puts the
  // transaction id under its type and the API strength under the drug name.
  // A fixed row height drew those extra lines on top of the row beneath. Rows
  // are measured instead; a single-line row keeps exactly the height it had, so
  // no other document moves.
  pdf.font(theme.font.regular).fontSize(theme.size.small);
  // Self-calibrated rather than assumed: `currentLineHeight()` excludes the gap
  // PDFKit actually leaves between lines, so measuring one real line is the
  // only reliable unit.
  const lineH = pdf.heightOfString('X', { width: 10_000 });
  // What a one-line row has spare, reused so a taller row is padded the same
  // way instead of looking cramped.
  const vPad = Math.max(0, rowH - lineH);
  // Lines a cell will actually occupy. `heightOfString` is the only honest
  // answer, because a cell WRAPS as well as carrying explicit newlines —
  // "Tramadol (37.5mg) + Paracetamol (325mg)" is one newline but three lines in
  // its column, which is why counting newlines still left rows overlapping.
  const linesIn = (text: string, width: number) =>
    text ? Math.max(1, Math.round(pdf.heightOfString(text, { width }) / lineH)) : 1;
  const heightFor = (cells: string[], bold: boolean) => {
    pdf.font(bold ? theme.font.bold : theme.font.regular).fontSize(theme.size.small);
    const lines = Math.max(1, ...columns.map((_, i) => linesIn(cells[i] ?? '', widths[i] - 8)));
    return { lines, h: lines === 1 ? rowH : lines * lineH + vPad };
  };

  let tableTop = pdf.y;

  const headerRow = () => {
    const y = pdf.y;
    tableTop = y;
    // The header wraps for the same reason a cell does — "VERIFIED BY" does not
    // fit a narrow column — so it is measured the same way. Otherwise its second
    // line lands on top of the first row of data.
    pdf.font(theme.font.bold).fontSize(theme.size.tiny);
    const headLineH = pdf.heightOfString('X', { width: 10_000 });
    const headLines = Math.max(
      1,
      ...columns.map((c, i) =>
        Math.max(
          1,
          Math.round(
            pdf.heightOfString(c.header.toUpperCase(), { width: widths[i] - 8 }) / headLineH,
          ),
        ),
      ),
    );
    const headH = headLines === 1 ? rowH : headLines * headLineH + Math.max(0, rowH - headLineH);

    if (t.headerFill === 'accent') {
      pdf.rect(left, y, theme.contentWidth, headH).fill(theme.accent);
    } else if (t.headerFill === 'muted') {
      pdf.rect(left, y, theme.contentWidth, headH).fill(theme.soft);
    }
    const headerInk = t.headerFill === 'accent' ? '#ffffff' : theme.ink;
    const headTextY =
      headLines === 1
        ? y + (rowH - theme.size.tiny) / 2 - 0.5
        : y + (headH - headLines * headLineH) / 2;
    let x = left;
    columns.forEach((c, i) => {
      pdf
        .font(theme.font.bold)
        .fontSize(theme.size.tiny)
        .fillColor(headerInk)
        .text(c.header.toUpperCase(), x + 4, headTextY, {
          width: widths[i] - 8,
          align: c.align ?? 'left',
        });
      x += widths[i];
    });
    pdf.y = y + headH;
    if (t.gridLines !== 'none') {
      pdf
        .moveTo(left, pdf.y)
        .lineTo(left + theme.contentWidth, pdf.y)
        .strokeColor(theme.hairline)
        .lineWidth(0.5)
        .stroke();
    }
  };

  headerRow();

  rows.forEach((r, idx) => {
    const cells = rowCells(r);
    const kind = rowKind(r);
    const bold = kind === 'group' || kind === 'total';
    // Measured before the page-break check, so a tall row is never split.
    const measured = heightFor(cells, bold);
    const h = kind === 'group' ? rowH : measured.h;
    const rowLines = kind === 'group' ? 1 : measured.lines;
    if (ensureSpace(pdf, theme, h + 4)) headerRow();
    const y = pdf.y;
    const striped = Array.isArray(r)
      ? t.zebraRows && idx % 2 === 1
      : t.zebraRows && (r.zebra ?? false);
    // A group heading carries the tint whether or not striping is on — it is
    // what separates one head of charges from the next.
    if (kind === 'group' || striped) {
      pdf.rect(left, y, theme.contentWidth, h).fill(theme.soft);
    }
    if (kind === 'group') {
      // Spans the table: the heading reads across, not squeezed into column one.
      pdf
        .font(theme.font.bold)
        .fontSize(theme.size.small)
        .fillColor(theme.ink)
        .text(cells[0] ?? '', left + 4, y + (rowH - theme.size.small) / 2 - 0.5, {
          width: theme.contentWidth - 8,
          lineBreak: false,
          ellipsis: true,
        });
      pdf.y = y + rowH;
      if (t.gridLines === 'horizontal' || t.gridLines === 'all') {
        pdf
          .moveTo(left, pdf.y)
          .lineTo(left + theme.contentWidth, pdf.y)
          .strokeColor(theme.hairline)
          .lineWidth(0.4)
          .stroke();
      }
      return;
    }
    // One line keeps the original centring exactly; a taller row centres the
    // whole block so its lines sit evenly between the rules.
    const textY =
      rowLines === 1
        ? y + (rowH - theme.size.small) / 2 - 0.5
        : y + (h - rowLines * lineH) / 2;
    let x = left;
    columns.forEach((c, i) => {
      pdf
        .font(bold ? theme.font.bold : theme.font.regular)
        .fontSize(theme.size.small)
        .fillColor(theme.ink)
        .text(cells[i] ?? '', x + 4, textY, {
          width: widths[i] - 8,
          align: c.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
      x += widths[i];
    });
    pdf.y = y + h;
    if (t.gridLines === 'horizontal' || t.gridLines === 'all') {
      pdf
        .moveTo(left, pdf.y)
        .lineTo(left + theme.contentWidth, pdf.y)
        .strokeColor(theme.hairline)
        .lineWidth(0.4)
        .stroke();
    }
  });

  if (t.gridLines === 'all') {
    // Verticals are drawn once at the end so they do not get painted over by
    // the zebra fills.
    // Anchored to where the last header was drawn — rows no longer all have the
    // same height, so counting them cannot locate the top.
    const top = tableTop;
    let x = left;
    for (let i = 0; i <= columns.length; i++) {
      pdf
        .moveTo(x, top)
        .lineTo(x, pdf.y)
        .strokeColor(theme.hairline)
        .lineWidth(0.4)
        .stroke();
      x += widths[i] ?? 0;
    }
  }
  pdf.moveDown(0.6);
}

/** The two-column label/value card most documents open with. */
export function drawKeyValueCard(
  pdf: PDFKit.PDFDocument,
  theme: PdfTheme,
  entries: Array<[string, string]>,
  columns = 2,
): void {
  if (!entries.length) return;
  const rows = Math.ceil(entries.length / columns);
  const rowH = theme.size.body + 17;
  ensureSpace(pdf, theme, rows * rowH + 8);
  const colW = theme.contentWidth / columns;
  const top = pdf.y;
  pdf
    .rect(theme.margin, top, theme.contentWidth, rows * rowH)
    .fillAndStroke(theme.soft, tintHex(theme.accent, 0.6));
  entries.forEach(([k, v], i) => {
    const x = theme.margin + (i % columns) * colW + 8;
    const y = top + Math.floor(i / columns) * rowH + 5;
    pdf
      .font(theme.font.bold)
      .fontSize(theme.size.tiny)
      .fillColor(theme.muted)
      .text(k.toUpperCase(), x, y, { width: colW - 16, lineBreak: false });
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.body)
      .fillColor(theme.ink)
      .text(v || '—', x, y + theme.size.tiny + 2, { width: colW - 16, lineBreak: false });
  });
  pdf.y = top + rows * rowH + 10;
}

/**
 * Break to a new page when `needed` points will not fit above the footer.
 * Returns true when a page was added, so a table can re-draw its header row.
 */
export function ensureSpace(pdf: PDFKit.PDFDocument, theme: PdfTheme, needed: number): boolean {
  const limit = pdf.page.height - theme.margin - 18;
  if (pdf.y + needed <= limit) return false;
  pdf.addPage();
  pdf.y = theme.margin;
  return true;
}

// ── Template-driven furniture ─────────────────────────────────────────────

export function drawCustomBlocks(
  pdf: PDFKit.PDFDocument,
  theme: PdfTheme,
  position: 'before_body' | 'after_body',
): void {
  const blocks = theme.template.blocks.filter((b) => b.position === position);
  if (!blocks.length) return;
  for (const b of blocks) {
    ensureSpace(pdf, theme, 40);
    if (b.heading) drawSectionHeading(pdf, theme, b.heading);
    if (b.text) {
      pdf
        .font(theme.font.regular)
        .fontSize(theme.size.small)
        .fillColor(theme.ink)
        .text(b.text, theme.margin, pdf.y, { width: theme.contentWidth, lineGap: theme.lineGap });
    }
    pdf.moveDown(0.6);
  }
}

function drawSignatureBlock(pdf: PDFKit.PDFDocument, theme: PdfTheme): void {
  const sig = theme.template.signature;
  if (!sig.enabled || !sig.labels.length) return;
  ensureSpace(pdf, theme, sig.height + 12);
  pdf.moveDown(0.8);
  const top = pdf.y;
  const colW = theme.contentWidth / sig.labels.length;
  const ruleY = top + sig.height - 14;
  sig.labels.forEach((label, i) => {
    const x = theme.margin + i * colW;
    // Leave the space above the rule blank — that is where the pen goes.
    pdf
      .moveTo(x + 8, ruleY)
      .lineTo(x + colW - 8, ruleY)
      .strokeColor(theme.hairline)
      .lineWidth(0.7)
      .stroke();
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.tiny)
      .fillColor(theme.muted)
      .text(label, x + 8, ruleY + 4, { width: colW - 16, align: 'center', lineBreak: false });
  });
  pdf.y = top + sig.height;
}

/**
 * Stamp the watermark diagonally across every page. Runs at finalize time, over
 * buffered pages, so it lands on pages the body added after the header was drawn.
 * Drawn UNDER nothing — PDFKit has no z-order — so opacity is capped low enough
 * (see mergeTemplate) that the text underneath stays legible.
 */
function drawWatermarks(pdf: PDFKit.PDFDocument, theme: PdfTheme): void {
  const w = theme.template.watermark;
  if (!w.enabled || !w.text.trim()) return;
  const color = w.color ?? theme.accent;
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.save();
    pdf.rotate(w.angle, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
    pdf
      .fillColor(color)
      .fillOpacity(w.opacity)
      .font(theme.font.bold)
      .fontSize(w.fontSize)
      .text(w.text.toUpperCase(), 0, pdf.page.height / 2 - w.fontSize * 0.7, {
        width: pdf.page.width,
        align: 'center',
        lineBreak: false,
      });
    pdf.restore();
    pdf.fillOpacity(1);
    pdf.page.margins.bottom = savedBottom;
  }
}
