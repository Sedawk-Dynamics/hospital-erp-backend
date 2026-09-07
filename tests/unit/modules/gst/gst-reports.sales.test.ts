import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getSalesRegister,
  getRateWiseSummary,
  getHsnSummary,
  getB2bRegister,
  getB2cSummary,
  getExemptTurnover,
} from '../../../../src/modules/gst/gst-reports.sales';

const TENANT = 'tenant-1';

// A-1 is the register; every other sales report is a FOLD of it. So the thing
// worth testing hardest is not any one summary — it is that they all still add
// up to the same register, because a return that does not tie is a notice.

function item(over: Record<string, unknown> = {}) {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    description: 'Charge',
    category: 'other',
    quantity: 1,
    unitPrice: 100,
    discountAmount: 0,
    taxPercent: 0,
    taxableValue: 100,
    taxAmount: 0,
    cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0,
    totalAmount: 100,
    hsnSacCode: null,
    gstTreatment: 'exempt',
    rateSource: 'category_default',
    requiresTaxResolution: false,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

const taxedItem = (over: Record<string, unknown> = {}) =>
  item({
    description: 'Deluxe room',
    category: 'room',
    unitPrice: 8000,
    taxPercent: 5,
    taxableValue: 8000,
    taxAmount: 400,
    cgstAmount: 200, sgstAmount: 200,
    totalAmount: 8400,
    hsnSacCode: '996311',
    gstTreatment: 'taxable',
    ...over,
  });

function bill(over: Record<string, unknown> = {}) {
  return {
    id: 'bill-1',
    billNumber: 'BILL-1',
    invoiceNumber: 'INV/2026-27/000001',
    gstDocumentType: 'invoice_cum_bill_of_supply',
    billDate: new Date('2026-09-03T00:00:00Z'),
    status: 'paid',
    financialYear: '2026-27',
    admissionId: null,
    recipientGstin: null,
    placeOfSupplyStateCode: '27',
    isInterState: false,
    patient: { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    billItems: [taxedItem(), item()],
    ...over,
  };
}

const seed = (bills: unknown[]) => (prisma.bill.findMany as any).mockResolvedValue(bills);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSalesRegister (A-1)', () => {
  it('flattens each bill into one row per line', async () => {
    seed([bill()]);
    const { rows } = await getSalesRegister(TENANT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      billNumber: 'BILL-1',
      invoiceNumber: 'INV/2026-27/000001',
      department: 'room',
      hsnSac: '996311',
      gstTreatment: 'taxable',
      treatmentLabel: 'Taxable',
      taxableValue: 8000,
      cgstAmount: 200,
      sgstAmount: 200,
      taxAmount: 400,
    });
  });

  it('names a patient with no surname without printing "null"', async () => {
    seed([bill({ patient: { id: 'p1', mrn: 'M', firstName: 'Asha', lastName: null } })]);
    const { rows } = await getSalesRegister(TENANT);
    expect(rows[0].patientName).toBe('Asha');
  });

  it('marks an admitted patient\'s bill as IP', async () => {
    seed([bill({ admissionId: 'adm-1' })]);
    const { rows } = await getSalesRegister(TENANT);
    expect(rows[0].patientType).toBe('ip');
  });

  // A draft is a basket, not a document, and the advance bucket is a holding
  // account that must never be counted as turnover.
  it('excludes drafts and the advance bucket in the query', async () => {
    seed([]);
    await getSalesRegister(TENANT);
    const where = (prisma.bill.findMany as any).mock.calls[0][0].where;
    expect(where.status).toEqual({ not: 'draft' });
    expect(where.NOT).toEqual({ billNumber: { startsWith: 'ADV-' } });
  });

  it('passes the period and every filter through to the query', async () => {
    seed([]);
    await getSalesRegister(TENANT, {
      from: '2026-09-01', to: '2026-09-30',
      department: 'pharmacy', documentType: 'tax_invoice',
      treatment: 'taxable', customerType: 'b2b',
    });
    const arg = (prisma.bill.findMany as any).mock.calls[0][0];
    expect(arg.where.billDate.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // Inclusive of the closing day, which is what a person means by "to".
    expect(arg.where.billDate.lte.toISOString()).toBe('2026-09-30T23:59:59.999Z');
    expect(arg.where.gstDocumentType).toBe('tax_invoice');
    expect(arg.where.recipientGstin).toEqual({ not: null });
    expect(arg.select.billItems.where).toEqual({ category: 'pharmacy', gstTreatment: 'taxable' });
  });
});

describe('the folds of A-1', () => {
  it('A-2 groups by rate and by department, both adding to the register', async () => {
    seed([bill()]);
    const r = await getRateWiseSummary(TENANT);
    expect(r.byRate.map((x) => x.ratePercent)).toEqual([5, 0]);
    expect(r.byRate[0]).toMatchObject({ treatment: 'taxable', taxAmount: 400, taxableValue: 8000 });
    // The department cut is the SAME lines, so it must total the same.
    const deptTax = r.byDepartment.reduce((t, d) => t + d.taxAmount, 0);
    expect(deptTax).toBe(r.totals.taxAmount);
    expect(r.totals.totalAmount).toBe(8500);
  });

  // Both carry a zero and they are not the same answer: GSTR-3B reports exempt
  // turnover and taxable-at-0% in different boxes.
  it('A-2 keeps exempt apart from taxable at a nil rate', async () => {
    seed([bill({ billItems: [item(), item({ gstTreatment: 'taxable', taxPercent: 0 })] })]);
    const r = await getRateWiseSummary(TENANT);
    expect(r.byRate.map((x) => x.treatment).sort()).toEqual(['exempt', 'taxable']);
  });

  it('A-3 truncates the code to the digits the turnover obliges', async () => {
    seed([bill({ billItems: [taxedItem({ hsnSacCode: '30049099' })] })]);
    const four = await getHsnSummary(TENANT);
    expect(four.reportingDigits).toBe(4);
    expect(four.byCode[0].hsnSac).toBe('3004');
    const six = await getHsnSummary(TENANT, { sixDigit: true });
    expect(six.byCode[0].hsnSac).toBe('300490');
  });

  // Folding them into a blank row is how an unclassified line reaches a return
  // unnoticed. They are counted separately so somebody has to look at them.
  it('A-3 keeps lines with no code out of the table', async () => {
    seed([bill()]);
    const r = await getHsnSummary(TENANT);
    expect(r.byCode).toHaveLength(1);
    expect(r.unclassified.count).toBe(1);
    expect(r.unclassified.totalAmount).toBe(100);
  });

  it('A-4 reports B2B invoice-wise, because the counterparty claims per invoice', async () => {
    seed([bill({ recipientGstin: '27AAPFU0939F1ZV' })]);
    const r = await getB2bRegister(TENANT);
    expect(r.invoices).toHaveLength(1);
    expect(r.invoices[0]).toMatchObject({
      invoiceNumber: 'INV/2026-27/000001',
      recipientGstin: '27AAPFU0939F1ZV',
      taxAmount: 400,
      totalAmount: 8500,
    });
  });

  it('A-5 lists a large inter-state B2C bill separately from the summary', async () => {
    seed([
      bill({ id: 'big', billNumber: 'BIG', isInterState: true, placeOfSupplyStateCode: '29',
        billItems: [taxedItem({ unitPrice: 300000, taxableValue: 300000, totalAmount: 315000, taxAmount: 15000, cgstAmount: 0, sgstAmount: 0, igstAmount: 15000 })] }),
      bill({ id: 'small', billNumber: 'SMALL' }),
    ]);
    const r = await getB2cSummary(TENANT);
    expect(r.largeInterState).toHaveLength(1);
    expect(r.largeInterState[0].billNumber).toBe('BIG');
    // The big one is reported invoice-wise, so it must NOT also be summarised.
    expect(r.summary.reduce((t, s) => t + s.totalAmount, 0)).toBe(8500);
  });

  it('A-7 separates exempt, nil-rated and non-GST rather than lumping them', async () => {
    seed([
      bill({
        billItems: [
          taxedItem(),
          item({ gstTreatment: 'exempt', taxableValue: 1000, totalAmount: 1000 }),
          item({ gstTreatment: 'nil_rated', taxableValue: 500, totalAmount: 500 }),
          item({ gstTreatment: 'non_gst', taxableValue: 300, totalAmount: 300 }),
        ],
      }),
    ]);
    const r = await getExemptTurnover(TENANT);
    expect(r.exempt.taxableValue).toBe(1000);
    expect(r.nilRated.taxableValue).toBe(500);
    expect(r.nonGst.taxableValue).toBe(300);
    expect(r.exemptTurnover).toBe(1800);
    expect(r.totalTurnover).toBe(9800);
    // The ratio Rule 42 turns on. Wrong here and the reversal is wrong.
    expect(r.exemptRatio).toBeCloseTo(18.37, 1);
  });

  it('A-7 counts a line with no treatment as neither, and says how many', async () => {
    seed([bill({ billItems: [taxedItem(), item({ gstTreatment: null })] })]);
    const r = await getExemptTurnover(TENANT);
    expect(r.unclassified.count).toBe(1);
    expect(r.exemptTurnover).toBe(0);
    // It is not silently folded into taxable turnover either.
    expect(r.taxable.taxableValue).toBe(8000);
  });

  // The property the whole design exists for.
  it('every fold still adds up to the register it summarises', async () => {
    seed([
      bill({
        billItems: [
          taxedItem(),
          taxedItem({ taxPercent: 18, taxableValue: 1000, taxAmount: 180, cgstAmount: 90, sgstAmount: 90, totalAmount: 1180, hsnSacCode: '999722' }),
          item(),
          item({ gstTreatment: 'nil_rated' }),
        ],
      }),
    ]);
    const [register, rate, exempt] = await Promise.all([
      getSalesRegister(TENANT),
      getRateWiseSummary(TENANT),
      getExemptTurnover(TENANT),
    ]);
    const registerTotal = register.rows.reduce((t, l) => t + l.totalAmount, 0);
    expect(rate.totals.totalAmount).toBe(registerTotal);
    expect(rate.byRate.reduce((t, x) => t + x.totalAmount, 0)).toBe(registerTotal);
    expect(rate.byDepartment.reduce((t, x) => t + x.totalAmount, 0)).toBe(registerTotal);
    expect(exempt.totalTurnover).toBe(
      register.rows.reduce((t, l) => t + l.taxableValue, 0),
    );
  });
});
