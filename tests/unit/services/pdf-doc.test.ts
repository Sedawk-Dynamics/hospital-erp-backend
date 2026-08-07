import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  buildTheme,
  drawKeyValueCard,
  drawSectionHeading,
  drawTable,
} from '../../../src/services/pdf-doc';
import {
  DEFAULT_TEMPLATE,
  DOCUMENT_TYPE_DEFAULTS,
  PDF_DOCUMENT_TYPES,
  mergeTemplate,
  type PdfTemplate,
} from '../../../src/services/pdf-template';
import { DEFAULT_SHOW, type HospitalBranding } from '../../../src/services/pdf-branding';

// A template is admin-editable config that feeds straight into PDFKit. tsc
// cannot catch a rotate() without a restore, a font name PDFKit does not know,
// or a watermark loop that walks off the buffered page range — but a rendered
// file that is not a PDF can.

const branding: HospitalBranding = {
  name: 'Sample Hospital',
  tagline: 'Caring for life',
  logoUrl: null,
  showLogo: true,
  headerStyle: 'centered',
  addressLine1: '1 Sample Road',
  addressLine2: null,
  city: 'Pune',
  state: 'MH',
  pincode: '411001',
  country: 'India',
  phone: '020-0000000',
  altPhone: null,
  email: 'sample@example.com',
  website: 'example.com',
  registrationNo: 'REG-1',
  gstin: 'GST-1',
  accreditation: 'NABH',
  footerText: null,
  accentColor: '#0f766e',
  show: { ...DEFAULT_SHOW },
};

/** Render a representative document and return the bytes. */
async function render(template: PdfTemplate, rows = 120): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let resolve!: (b: Buffer) => void;
  const done = new Promise<Buffer>((r) => (resolve = r));
  const sink = new Writable({
    write(c, _e, cb) {
      chunks.push(Buffer.from(c));
      cb();
    },
    final(cb) {
      resolve(Buffer.concat(chunks));
      cb();
    },
  });

  const { pdf, theme } = createBrandedDocument({
    branding,
    template,
    title: 'Test Document',
    subtitle: 'Sample',
    meta: [{ label: 'No', value: 'X-1' }],
  });
  pdf.pipe(sink);
  drawKeyValueCard(pdf, theme, [
    ['Patient', 'Sample Patient'],
    ['MRN', 'SAMPLE-000'],
  ]);
  drawSectionHeading(pdf, theme, 'A table');
  drawTable(
    pdf,
    theme,
    [
      { header: 'Item', width: 0.5 },
      { header: 'Qty', width: 0.2, align: 'right' },
      { header: 'Amount', width: 0.3, align: 'right' },
    ],
    // Enough rows to force page breaks and exercise the repeated header row.
    Array.from({ length: rows }, (_, i) => [`Line item ${i + 1}`, String(i + 1), `${i * 10}.00`]),
  );
  finalizeBrandedDocument({ pdf, branding, theme });
  return done;
}

function expectWellFormedPdf(buf: Buffer) {
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.subarray(-1024).toString('latin1')).toContain('%%EOF');
  expect(buf.length).toBeGreaterThan(2000);
}

describe('createBrandedDocument / finalizeBrandedDocument', () => {
  it('renders a well-formed multi-page PDF on the defaults', async () => {
    expectWellFormedPdf(await render(DEFAULT_TEMPLATE));
  });

  it.each([...PDF_DOCUMENT_TYPES])('renders %s on its built-in defaults', async (type) => {
    expectWellFormedPdf(await render(mergeTemplate(DEFAULT_TEMPLATE, DOCUMENT_TYPE_DEFAULTS[type])));
  });

  const variants: Array<[string, unknown]> = [
    ['A5 at the smallest margin', { page: { size: 'A5', margin: 18 } }],
    ['Legal landscape at the largest margin', { page: { size: 'LEGAL', orientation: 'landscape', margin: 90 } }],
    ['Times at the largest body size', { typography: { fontFamily: 'Times', baseFontSize: 14, lineGap: 8 } }],
    ['Courier at the smallest body size', { typography: { fontFamily: 'Courier', baseFontSize: 6, lineGap: 0 } }],
    ['watermark at full strength', { watermark: { enabled: true, text: 'DUPLICATE', opacity: 1, angle: -90 } }],
    ['no letterhead, no title bar, no meta', { header: { showLetterhead: false, showTitleBar: false, showMetaStrip: false } }],
    ['no footer at all', { footer: { showFooter: false } }],
    ['four signing lines', { signature: { enabled: true, labels: ['A', 'B', 'C', 'D'] } }],
    ['full grid, comfortable, unfilled header', { table: { gridLines: 'all', density: 'comfortable', headerFill: 'none', zebraRows: false } }],
    ['custom blocks at both ends', {
      blocks: [
        { id: 'a', position: 'before_body', heading: 'Consent', text: 'Sample consent text.' },
        { id: 'b', position: 'after_body', heading: 'Terms', text: 'Sample terms text.' },
      ],
    }],
  ];

  it.each(variants)('renders with %s', async (_name, patch) => {
    expectWellFormedPdf(await render(mergeTemplate(DEFAULT_TEMPLATE, patch)));
  });

  it('renders every extreme at once', async () => {
    expectWellFormedPdf(
      await render(
        mergeTemplate(DEFAULT_TEMPLATE, {
          page: { size: 'A5', orientation: 'landscape', margin: 20 },
          typography: { fontFamily: 'Courier', baseFontSize: 6.5 },
          colors: { accent: '#7c2d12' },
          header: { showLetterhead: false, titleOverride: 'RENAMED' },
          watermark: { enabled: true, text: 'CANCELLED', opacity: 0.4, angle: 45, fontSize: 200 },
          table: { gridLines: 'all', density: 'compact' },
          signature: { enabled: true, labels: ['One', 'Two', 'Three'] },
          blocks: [{ id: 'c', position: 'after_body', heading: 'Note', text: 'x'.repeat(1500) }],
        }),
      ),
    );
  });

  // Anything stored in a JSON column can be hand-edited or left behind by an
  // older build. The merge layer is what stands between that and PDFKit.
  it('renders even when the stored template is garbage', async () => {
    expectWellFormedPdf(
      await render(
        mergeTemplate(DEFAULT_TEMPLATE, {
          page: { size: 'A0', orientation: 42, margin: -999 },
          typography: { fontFamily: 'Comic Sans', baseFontSize: 900, lineGap: 'x' },
          colors: { accent: 'red', ink: 'nope' },
          watermark: { enabled: true, text: 'z'.repeat(500), opacity: 5, angle: 999, fontSize: 99999 },
          signature: { enabled: true, labels: [1, null, '', 'ok'] },
          blocks: 'not an array',
        }),
      ),
    );
  });

  it('renders a document with no body rows at all', async () => {
    expectWellFormedPdf(await render(DEFAULT_TEMPLATE, 0));
  });
});

describe('buildTheme', () => {
  it('inherits the letterhead accent when the template does not set one', () => {
    const theme = buildTheme(DEFAULT_TEMPLATE, branding);
    expect(theme.accent).toBe(branding.accentColor);
  });

  it('lets the template override the accent for this document type only', () => {
    const theme = buildTheme(mergeTemplate(DEFAULT_TEMPLATE, { colors: { accent: '#123456' } }), branding);
    expect(theme.accent).toBe('#123456');
  });

  it('falls back to the default accent when the letterhead colour is unusable', () => {
    const theme = buildTheme(DEFAULT_TEMPLATE, { ...branding, accentColor: 'not-a-colour' });
    expect(theme.accent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('derives the content width from the template page, not a constant', () => {
    const a4 = buildTheme(DEFAULT_TEMPLATE, branding);
    const landscape = buildTheme(
      mergeTemplate(DEFAULT_TEMPLATE, { page: { orientation: 'landscape' } }),
      branding,
    );
    expect(landscape.contentWidth).toBeGreaterThan(a4.contentWidth);
  });
});
