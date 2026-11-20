// ---------------------------------------------------------------------------
// A GST report as a real PDF document (gap items 282 / 372).
//
// "PDF" on the report screens used to be window.print(), which printed the
// whole web page — sidebar, period picker and all. This renders the report
// itself: a title, the period, the headline figures, the table and its notes,
// with the hospital's name and GSTIN on top and the run details at the foot.
//
// The rows come from the screen, not from a second query, for the same reason
// the CSV export does it that way: a document that does not match the screen
// it was exported from is worse than none.
// ---------------------------------------------------------------------------

import PDFDocument from 'pdfkit';

export interface ReportPdfInput {
  title: string;
  subtitle?: string | null;
  period?: { from?: string | null; to?: string | null } | null;
  stats?: Array<{ label: string; value: string }>;
  columns: Array<{ label: string; align?: 'left' | 'right' | 'center' }>;
  rows: Array<Array<string | number | null>>;
  notes?: string[];
  runBy?: string | null;
}

/** Hard caps so one request cannot ask for a thousand-page document. */
export const PDF_LIMITS = { columns: 30, rows: 20000, cell: 300 } as const;

/** The standard PDF fonts have no rupee glyph; print it as "Rs." instead. */
const pdfSafe = (v: unknown) => String(v ?? '').replace(/₹\s?/g, 'Rs. ');

export async function renderReportPdf(
  input: ReportPdfInput,
  header: {
    hospitalName: string | null;
    gstin: string | null;
    gstinVerified: boolean;
    /**
     * Gap #311: what to print beside the GSTIN — from gstinVerificationCaption,
     * so a SANDBOX pass is labelled too. Absent → derived from gstinVerified.
     */
    gstinCaption?: string | null;
  },
): Promise<Buffer> {
  const gstinCaption =
    header.gstinCaption !== undefined
      ? header.gstinCaption
      : header.gstinVerified
        ? null
        : 'not verified with the GST portal';
  const wide = input.columns.length > 7;
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 18;

  // ── Header ──
  doc.font('Helvetica-Bold').fontSize(13).text(header.hospitalName ?? 'Hospital', left, doc.y, { width });
  doc.font('Helvetica').fontSize(8.5).fillColor('#444')
    .text(header.gstin
      ? `GSTIN ${header.gstin}${gstinCaption ? ` (${gstinCaption})` : ''}`
      : 'Not registered under GST', { width });
  doc.moveDown(0.5).fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(12).text(pdfSafe(input.title), { width });
  if (input.subtitle) doc.font('Helvetica').fontSize(9).text(pdfSafe(input.subtitle), { width });
  const p = input.period;
  doc.font('Helvetica').fontSize(9).text(
    p && (p.from || p.to) ? `Period: ${p.from ?? '—'} to ${p.to ?? '—'}` : 'Period: all',
    { width },
  );
  doc.moveDown(0.5);

  // ── Headline figures ──
  if (input.stats?.length) {
    doc.fontSize(9);
    for (const s of input.stats) {
      doc.font('Helvetica').text(`${pdfSafe(s.label)}: `, { continued: true }).font('Helvetica-Bold').text(pdfSafe(s.value));
    }
    doc.moveDown(0.5);
  }

  // ── The table ──
  const cols = input.columns.slice(0, PDF_LIMITS.columns);
  const rows = input.rows.slice(0, PDF_LIMITS.rows);
  const fontSize = cols.length > 12 ? 6 : cols.length > 8 ? 7 : 8;
  // Width by content, within limits, so a description column gets the room.
  const sample = [cols.map((c) => c.label), ...rows.slice(0, 200).map((r) => r.map((v) => String(v ?? '')))];
  const natural = cols.map((_, i) => Math.min(40, Math.max(4, ...sample.map((r) => (r[i] ?? '').length))));
  const totalNatural = natural.reduce((a, b) => a + b, 0) || 1;
  const widths = natural.map((w) => (w / totalNatural) * width);

  const cellText = (v: unknown) => pdfSafe(v).slice(0, PDF_LIMITS.cell);
  const drawRow = (cells: string[], bold: boolean, shade: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - 4 }))) + 4;
    if (doc.y + h > bottom()) {
      doc.addPage();
      if (!bold) drawRow(cols.map((c) => c.label), true, true);
    }
    const y = doc.y;
    if (shade) doc.rect(left, y, width, h).fill('#eeeeee').fillColor('#000');
    let x = left;
    cells.forEach((c, i) => {
      doc.text(c, x + 2, y + 2, { width: widths[i] - 4, align: cols[i]?.align ?? 'left' });
      x += widths[i];
    });
    doc.y = y + h;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).strokeColor('#cccccc').stroke();
  };
  drawRow(cols.map((c) => c.label), true, true);
  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(9).text('Nothing in this period.', left, doc.y + 4, { width });
  }
  for (const r of rows) drawRow(cols.map((_, i) => cellText(r[i])), false, false);
  if (input.rows.length > rows.length) {
    doc.font('Helvetica-Oblique').fontSize(8)
      .text(`${input.rows.length - rows.length} further row(s) not printed — export to Excel for the full set.`, left, doc.y + 4, { width });
  }

  // ── Notes ──
  if (input.notes?.length) {
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).text('Notes', left, doc.y, { width });
    doc.font('Helvetica').fontSize(8);
    for (const n of input.notes.slice(0, 40)) doc.text(`- ${pdfSafe(n).slice(0, 1000)}`, { width });
  }

  // ── Provenance on every page ──
  const stamp = `Run by ${input.runBy ?? 'unknown user'} on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Gap 372: the footer sits inside the bottom margin, and PDFKit adds a page
    // for any text that crosses the margin — lineBreak:false does not stop it.
    // That page held nothing but the footer (the GSTR-3B PDF's second page).
    // Lift the margin while the footer is written, then put it back.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#666')
      .text(`${stamp} · page ${i + 1} of ${range.count}`, left, doc.page.height - bottomMargin - 8, {
        width, align: 'center', lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return done;
}
