import { describe, it, expect } from 'vitest';
import { renderReportPdf, type ReportPdfInput } from '../../../../src/modules/gst/gst-reports.pdf';

const HEADER = { hospitalName: 'Test Hospital', gstin: '27AAPFU0939F1ZV', gstinVerified: false };

/** PDFKit writes one uncompressed "/Type /Page" object per page. */
const pageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

const report = (rows: number, over: Partial<ReportPdfInput> = {}): ReportPdfInput => ({
  title: 'A-9 GSTR-3B',
  period: { from: '2026-09-01', to: '2026-09-30' },
  stats: [{ label: 'Outward tax', value: '₹350.00' }],
  columns: [{ label: 'Box' }, { label: 'What' }, { label: 'Amount', align: 'right' }],
  rows: Array.from({ length: rows }, (_, i) => ['3.1(a)', `Row ${i}`, '7,000.00']),
  notes: ['Input tax credit covers pharmacy purchases only.'],
  runBy: 'Book Keeper',
  ...over,
});

// Gap items 282 / 372: the PDF is the report itself, not a print of the page.
describe('renderReportPdf', () => {
  it('renders the report table as a PDF document', async () => {
    const buf = await renderReportPdf(report(120), HEADER);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  // Gap 372: the footer used to spill onto a page of its own.
  it('keeps a short report (GSTR-3B) on a single page', async () => {
    expect(pageCount(await renderReportPdf(report(8), HEADER))).toBe(1);
    expect(pageCount(await renderReportPdf(report(0, { notes: [] }), HEADER))).toBe(1);
  });

  it('adds no footer-only page to a multi-page report', async () => {
    const buf = await renderReportPdf(report(120), HEADER);
    // 120 rows of ~13pt fit on 3 portrait pages; one more would be the footer.
    expect(pageCount(buf)).toBeLessThanOrEqual(3);
  });
});
