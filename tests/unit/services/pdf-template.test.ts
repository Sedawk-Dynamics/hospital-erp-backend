import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  DOCUMENT_TYPE_DEFAULTS,
  PDF_DOCUMENT_REGISTRY,
  PDF_DOCUMENT_TYPES,
  isPdfDocumentType,
  mergeTemplate,
  pageDimensions,
  tableRowHeight,
  fontNames,
} from '../../../src/services/pdf-template';

describe('mergeTemplate', () => {
  it('keeps the base when there is nothing to merge', () => {
    expect(mergeTemplate(DEFAULT_TEMPLATE, undefined)).toEqual(DEFAULT_TEMPLATE);
    expect(mergeTemplate(DEFAULT_TEMPLATE, null)).toEqual(DEFAULT_TEMPLATE);
    expect(mergeTemplate(DEFAULT_TEMPLATE, 'not an object')).toEqual(DEFAULT_TEMPLATE);
  });

  it('applies a partial patch without disturbing the rest', () => {
    const t = mergeTemplate(DEFAULT_TEMPLATE, { page: { orientation: 'landscape' } });
    expect(t.page.orientation).toBe('landscape');
    expect(t.page.size).toBe(DEFAULT_TEMPLATE.page.size);
    expect(t.typography).toEqual(DEFAULT_TEMPLATE.typography);
  });

  // This is the whole safety story: a template comes off the wire and out of a
  // JSON column, so a bad value must never reach PDFKit and produce a file
  // nobody can open.
  describe('clamping untrusted values', () => {
    it('rejects an unknown page size, orientation, font and density', () => {
      const t = mergeTemplate(DEFAULT_TEMPLATE, {
        page: { size: 'A0', orientation: 'sideways' },
        typography: { fontFamily: 'Comic Sans' },
        table: { density: 'enormous', headerFill: 'rainbow', gridLines: 'dotted' },
      });
      expect(t.page.size).toBe('A4');
      expect(t.page.orientation).toBe('portrait');
      expect(t.typography.fontFamily).toBe('Helvetica');
      expect(t.table.density).toBe('normal');
      expect(t.table.headerFill).toBe('accent');
      expect(t.table.gridLines).toBe('horizontal');
    });

    it('clamps a margin that would leave no page, or no room for the footer', () => {
      expect(mergeTemplate(DEFAULT_TEMPLATE, { page: { margin: -100 } }).page.margin).toBe(18);
      expect(mergeTemplate(DEFAULT_TEMPLATE, { page: { margin: 5000 } }).page.margin).toBe(90);
    });

    it('clamps an unreadable font size', () => {
      expect(mergeTemplate(DEFAULT_TEMPLATE, { typography: { baseFontSize: 0.1 } }).typography.baseFontSize).toBe(6);
      expect(mergeTemplate(DEFAULT_TEMPLATE, { typography: { baseFontSize: 400 } }).typography.baseFontSize).toBe(14);
    });

    // A watermark dark enough to obscure a dose or an amount is a safety
    // problem, not a design choice.
    it('caps watermark opacity however hard it is pushed', () => {
      expect(mergeTemplate(DEFAULT_TEMPLATE, { watermark: { opacity: 1 } }).watermark.opacity).toBe(0.4);
      expect(mergeTemplate(DEFAULT_TEMPLATE, { watermark: { opacity: 0 } }).watermark.opacity).toBe(0.02);
    });

    it('bounds watermark text, angle and size', () => {
      const t = mergeTemplate(DEFAULT_TEMPLATE, {
        watermark: { text: 'x'.repeat(500), angle: 999, fontSize: 99999 },
      });
      expect(t.watermark.text).toHaveLength(40);
      expect(t.watermark.angle).toBe(90);
      expect(t.watermark.fontSize).toBe(200);
    });

    it('only accepts six-digit hex colours, and null to inherit', () => {
      expect(mergeTemplate(DEFAULT_TEMPLATE, { colors: { accent: 'red' } }).colors.accent).toBe(null);
      expect(mergeTemplate(DEFAULT_TEMPLATE, { colors: { ink: 'nope' } }).colors.ink).toBe(DEFAULT_TEMPLATE.colors.ink);
      expect(mergeTemplate(DEFAULT_TEMPLATE, { colors: { accent: '#ABCDEF' } }).colors.accent).toBe('#ABCDEF');
      expect(mergeTemplate(DEFAULT_TEMPLATE, { colors: { accent: null } }).colors.accent).toBe(null);
    });

    it('drops junk signature labels and keeps the base when none survive', () => {
      const t = mergeTemplate(DEFAULT_TEMPLATE, {
        signature: { enabled: true, labels: [1, null, '   ', 'Pharmacist', 'a', 'b', 'c', 'd'] },
      });
      expect(t.signature.labels).toEqual(['Pharmacist', 'a', 'b', 'c']); // capped at 4
      const none = mergeTemplate(DEFAULT_TEMPLATE, { signature: { labels: [null, ''] } });
      expect(none.signature.labels).toEqual(DEFAULT_TEMPLATE.signature.labels);
    });

    it('ignores blocks that are not an array, and skips empty ones', () => {
      expect(mergeTemplate(DEFAULT_TEMPLATE, { blocks: 'nope' }).blocks).toEqual([]);
      const t = mergeTemplate(DEFAULT_TEMPLATE, {
        blocks: [
          { heading: '   ', text: '  ' },
          'not an object',
          { heading: 'Consent', text: 'Sample', position: 'before_body' },
        ],
      });
      expect(t.blocks).toHaveLength(1);
      expect(t.blocks[0]).toMatchObject({ heading: 'Consent', position: 'before_body' });
    });

    it('caps the number of blocks and the length of each', () => {
      const t = mergeTemplate(DEFAULT_TEMPLATE, {
        blocks: Array.from({ length: 20 }, (_, i) => ({ heading: `H${i}`, text: 'x'.repeat(9000) })),
      });
      expect(t.blocks).toHaveLength(6);
      expect(t.blocks[0].text).toHaveLength(2000);
    });

    it('defaults an unknown block position to after the body', () => {
      const t = mergeTemplate(DEFAULT_TEMPLATE, { blocks: [{ text: 'x', position: 'sideways' }] });
      expect(t.blocks[0].position).toBe('after_body');
    });
  });

  it('is idempotent — merging its own output changes nothing', () => {
    const once = mergeTemplate(DEFAULT_TEMPLATE, {
      page: { size: 'A5' },
      watermark: { enabled: true, text: 'COPY' },
      blocks: [{ heading: 'X', text: 'y' }],
    });
    expect(mergeTemplate(once, once)).toEqual(once);
  });
});

describe('layered resolution', () => {
  // The three layers the builder promises: built-in → hospital-wide → per-type.
  it('lets a per-type override win over the hospital-wide default', () => {
    const all = mergeTemplate(DEFAULT_TEMPLATE, {
      typography: { fontFamily: 'Times', baseFontSize: 10 },
      page: { margin: 30 },
    });
    const perType = mergeTemplate(all, { page: { orientation: 'landscape' } });
    expect(perType.page.orientation).toBe('landscape');
    // …without losing what the hospital-wide layer set.
    expect(perType.typography.fontFamily).toBe('Times');
    expect(perType.page.margin).toBe(30);
  });
});

describe('built-in per-type defaults', () => {
  // These are not opinions — they preserve how the documents printed before
  // templates existed. A payslip has always carried signing lines.
  it('gives a salary slip its signing lines', () => {
    const t = mergeTemplate(DEFAULT_TEMPLATE, DOCUMENT_TYPE_DEFAULTS.salary_slip);
    expect(t.signature.enabled).toBe(true);
    expect(t.signature.labels).toContain('Employee Signature');
  });

  it('keeps the NDPS register landscape, where its seven columns fit', () => {
    const t = mergeTemplate(DEFAULT_TEMPLATE, DOCUMENT_TYPE_DEFAULTS.ndps_register);
    expect(t.page.orientation).toBe('landscape');
    expect(t.table.density).toBe('compact');
  });

  it('leaves the clinical documents on the plain defaults', () => {
    expect(DOCUMENT_TYPE_DEFAULTS.prescription).toBeUndefined();
    expect(DOCUMENT_TYPE_DEFAULTS.discharge_summary).toBeUndefined();
  });
});

describe('registry', () => {
  it('describes every document type exactly once', () => {
    expect(PDF_DOCUMENT_REGISTRY.map((r) => r.key).sort()).toEqual([...PDF_DOCUMENT_TYPES].sort());
    expect(new Set(PDF_DOCUMENT_REGISTRY.map((r) => r.key)).size).toBe(PDF_DOCUMENT_TYPES.length);
  });

  it('recognises only real document types', () => {
    expect(isPdfDocumentType('prescription')).toBe(true);
    expect(isPdfDocumentType('__all__')).toBe(false);
    expect(isPdfDocumentType('')).toBe(false);
    expect(isPdfDocumentType(undefined)).toBe(false);
  });
});

describe('render helpers', () => {
  it('swaps width and height for landscape', () => {
    const p = pageDimensions({ size: 'A4', orientation: 'portrait', margin: 42 });
    const l = pageDimensions({ size: 'A4', orientation: 'landscape', margin: 42 });
    expect(l.width).toBe(p.height);
    expect(l.height).toBe(p.width);
  });

  it('falls back to A4 for a size it does not know', () => {
    const d = pageDimensions({ size: 'A0' as never, orientation: 'portrait', margin: 42 });
    expect(d).toEqual(pageDimensions({ size: 'A4', orientation: 'portrait', margin: 42 }));
  });

  it('scales row height with density and font size', () => {
    const compact = tableRowHeight(mergeTemplate(DEFAULT_TEMPLATE, { table: { density: 'compact' } }));
    const comfortable = tableRowHeight(mergeTemplate(DEFAULT_TEMPLATE, { table: { density: 'comfortable' } }));
    expect(comfortable).toBeGreaterThan(compact);
    const big = tableRowHeight(mergeTemplate(DEFAULT_TEMPLATE, { typography: { baseFontSize: 14 } }));
    expect(big).toBeGreaterThan(tableRowHeight(DEFAULT_TEMPLATE));
  });

  it('maps each family to PDFKit font names that exist', () => {
    expect(fontNames('Times')).toEqual({ regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' });
    expect(fontNames('Courier').italic).toBe('Courier-Oblique');
    expect(fontNames('Helvetica').bold).toBe('Helvetica-Bold');
  });
});
