import { describe, it, expect } from 'vitest';
import { buildTaxSummary } from '../../../../src/modules/billing/billing.bill-document';
import type { BillDocumentLine } from '../../../../src/modules/billing/billing.bill-document';

// The rate-wise summary is how a RETURN reads a bill: GSTR-1 reports turnover
// by rate, not by line. Getting the grouping wrong does not look wrong on the
// paper — it looks like a tidy table with the wrong numbers in it.

function line(over: Partial<BillDocumentLine> = {}): BillDocumentLine {
  return {
    description: 'Charge',
    category: 'other',
    quantity: 1,
    unitPrice: 100,
    totalAmount: 100,
    status: 'posted',
    at: '2026-09-01T00:00:00Z',
    hsnSac: null,
    gstTreatment: 'exempt',
    treatmentLabel: 'Exempt',
    taxRatePercent: 0,
    taxableValue: 100,
    taxAmount: 0,
    cgstRate: 0, cgstAmount: 0,
    sgstRate: 0, sgstAmount: 0,
    igstRate: 0, igstAmount: 0,
    cessAmount: 0,
    ...over,
  };
}

const taxed = (over: Partial<BillDocumentLine> = {}) =>
  line({
    gstTreatment: 'taxable', treatmentLabel: 'Taxable',
    taxRatePercent: 5, taxableValue: 8000, taxAmount: 400,
    cgstRate: 2.5, cgstAmount: 200, sgstRate: 2.5, sgstAmount: 200,
    totalAmount: 8400,
    ...over,
  });

describe('buildTaxSummary', () => {
  it('collapses lines at the same rate into one row', () => {
    const rows = buildTaxSummary([taxed(), taxed(), taxed({ taxableValue: 1000, taxAmount: 50, cgstAmount: 25, sgstAmount: 25 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      treatment: 'taxable', ratePercent: 5,
      taxableValue: 17000, cgstAmount: 425, sgstAmount: 425, taxAmount: 850,
    });
  });

  // Both carry a zero and they are not the same answer: a return reports exempt
  // turnover and nil-rated turnover in different boxes.
  it('keeps exempt and nil-rated apart even though both are 0%', () => {
    const rows = buildTaxSummary([
      line(),
      line({ gstTreatment: 'nil_rated', treatmentLabel: 'Nil rated', taxableValue: 60, totalAmount: 60 }),
    ]);
    expect(rows.map((r) => r.treatment).sort()).toEqual(['exempt', 'nil_rated']);
  });

  it('separates two taxable rates on one bill', () => {
    const rows = buildTaxSummary([
      taxed(),
      taxed({ taxRatePercent: 18, taxableValue: 1000, taxAmount: 180, cgstAmount: 90, sgstAmount: 90 }),
    ]);
    // Highest rate first, so the taxed rows lead and the exempt block closes.
    expect(rows.map((r) => r.ratePercent)).toEqual([18, 5]);
  });

  it('puts the taxed rows before the exempt ones', () => {
    const rows = buildTaxSummary([line(), taxed()]);
    expect(rows.map((r) => r.treatment)).toEqual(['taxable', 'exempt']);
  });

  // A pending charge has not been priced onto a bill, so there is nothing to
  // declare for it. Counting it would report turnover that has not been billed.
  it('leaves out a line with no tax position at all', () => {
    const rows = buildTaxSummary([
      line({ status: 'pending', gstTreatment: null, treatmentLabel: null }),
      taxed(),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].treatment).toBe('taxable');
  });

  it('carries the IGST split for an inter-state supply', () => {
    const rows = buildTaxSummary([
      taxed({ cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0, igstRate: 5, igstAmount: 400 }),
    ]);
    expect(rows[0]).toMatchObject({ igstAmount: 400, cgstAmount: 0, sgstAmount: 0, taxAmount: 400 });
  });

  it('has nothing to summarise on a bill with no lines', () => {
    expect(buildTaxSummary([])).toEqual([]);
  });

  // Money added in a loop drifts. The rows are what a return reports, so they
  // are rounded at every step rather than at the end.
  it('does not accumulate floating-point dust', () => {
    const rows = buildTaxSummary(
      Array.from({ length: 3 }, () =>
        taxed({ taxableValue: 0.1, taxAmount: 0.2, cgstAmount: 0.1, sgstAmount: 0.1 }),
      ),
    );
    expect(rows[0].taxableValue).toBe(0.3);
    expect(rows[0].cgstAmount).toBe(0.3);
  });
});
