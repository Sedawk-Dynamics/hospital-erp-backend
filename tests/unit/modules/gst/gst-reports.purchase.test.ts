import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getPurchaseRegister,
  getItcSummary,
  getSupplierGstinExceptions,
  getItcReversalWorking,
  getPurchaseReturns,
} from '../../../../src/modules/gst/gst-reports.purchase';

const TENANT = 'tenant-1';
const VALID_GSTIN = '27AAPFU0939F1ZV';

function batch(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    batchNumber: 'B-1',
    invoiceNumber: 'SUP/001',
    invoiceDate: new Date('2026-09-05T00:00:00Z'),
    createdAt: new Date('2026-09-06T00:00:00Z'),
    quantityReceived: 100,
    freeQuantity: 0,
    purchasePrice: 10,
    purchaseDiscountPercent: 0,
    gstPercent: 12,
    drug: { drugName: 'Paracetamol 500mg', hsnCode: '30049099' },
    supplier: { id: 's1', name: 'Acme Pharma', gstNumber: VALID_GSTIN },
    ...over,
  };
}

/** A bill line, for the turnover half of the Rule 42 working. */
function billWith(items: Array<Record<string, unknown>>) {
  return {
    id: 'bill-1', billNumber: 'BILL-1', invoiceNumber: 'INV/1',
    gstDocumentType: 'invoice_cum_bill_of_supply',
    billDate: new Date('2026-09-03T00:00:00Z'), status: 'paid',
    financialYear: '2026-27', admissionId: null, recipientGstin: null,
    placeOfSupplyStateCode: '27', isInterState: false,
    patient: { id: 'p1', mrn: 'M', firstName: 'Asha', lastName: 'Rao' },
    billItems: items.map((o, i) => ({
      id: `it-${i}`, description: 'Charge', category: 'other', quantity: 1,
      unitPrice: 100, discountAmount: 0, taxPercent: 0, taxableValue: 100,
      taxAmount: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0,
      totalAmount: 100, hsnSacCode: null, gstTreatment: 'exempt',
      rateSource: 'category_default', requiresTaxResolution: false,
      createdAt: new Date('2026-09-03T00:00:00Z'), ...o,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.bill.findMany as any).mockResolvedValue([]);
});

describe('getPurchaseRegister (B-1)', () => {
  it('computes the taxable value and the tax from what the batch carries', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const { rows } = await getPurchaseRegister(TENANT);
    expect(rows[0]).toMatchObject({
      supplierName: 'Acme Pharma',
      supplierGstin: VALID_GSTIN,
      invoiceNumber: 'SUP/001',
      taxableValue: 1000,
      gstRatePercent: 12,
      taxAmount: 120,
      landingTotal: 1120,
    });
  });

  it('takes the line discount off before taxing it', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch({ purchaseDiscountPercent: 10 })]);
    const { rows } = await getPurchaseRegister(TENANT);
    expect(rows[0].taxableValue).toBe(900);
    expect(rows[0].taxAmount).toBe(108);
  });

  // Free goods are received but not paid for, so they carry no purchase value
  // and no input tax — only the paid units do.
  it('does not tax the free quantity', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch({ quantityReceived: 110, freeQuantity: 10 })]);
    const { rows } = await getPurchaseRegister(TENANT);
    expect(rows[0].taxableValue).toBe(1000);
  });

  // Credit belongs to the month of the supplier's invoice. Keyed on entry, it
  // would move into whichever month somebody got round to the paperwork.
  it('dates a purchase by the supplier invoice, falling back to receipt', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([]);
    await getPurchaseRegister(TENANT, { from: '2026-09-01', to: '2026-09-30' });
    const where = (prisma.drugBatch.findMany as any).mock.calls[0][0].where;
    expect(where.OR[0].invoiceDate.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(where.OR[1]).toMatchObject({ invoiceDate: null });
  });
});

describe('getItcSummary (B-2)', () => {
  it('folds the credit by rate and by supplier', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      batch(),
      batch({ id: 'b2', gstPercent: 5, purchasePrice: 20 }),
      batch({ id: 'b3', supplier: { id: 's2', name: 'Beta Labs', gstNumber: VALID_GSTIN } }),
    ]);
    const r = await getItcSummary(TENANT);
    expect(r.byRate.map((x) => x.ratePercent)).toEqual([12, 5]);
    expect(r.byRate[0].taxAmount).toBe(240);
    // Acme supplied two of the three batches: 120 at 12% plus 100 at 5%.
    expect(r.bySupplier[0]).toMatchObject({ supplierName: 'Acme Pharma', taxAmount: 220 });
    expect(r.bySupplier[1]).toMatchObject({ supplierName: 'Beta Labs', taxAmount: 120 });
    expect(r.totals.taxAmount).toBe(340);
  });

  it('counts purchases with no rate recorded — that credit cannot be claimed', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch({ gstPercent: null })]);
    const r = await getItcSummary(TENANT);
    expect(r.withoutRate).toBe(1);
    expect(r.totals.taxAmount).toBe(0);
  });

  // An accountant who takes this as the hospital's complete input credit will
  // under-claim, so the report has to say what it cannot see.
  it('says what a batch-based register does not cover', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([]);
    const r = await getItcSummary(TENANT);
    expect(r.coverage).toMatch(/equipment, rent, utilities/);
  });
});

describe('getSupplierGstinExceptions (B-4)', () => {
  it('flags a supplier with no GSTIN, with the tax at risk', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      batch({ supplier: { id: 's3', name: 'No GSTIN Traders', gstNumber: null } }),
    ]);
    const r = await getSupplierGstinExceptions(TENANT);
    expect(r.suppliers[0]).toMatchObject({ supplierName: 'No GSTIN Traders', problem: 'No GSTIN on file', taxAtRisk: 120 });
  });

  it('flags a GSTIN that fails the checksum', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      batch({ supplier: { id: 's4', name: 'Typo Pharma', gstNumber: '27AAPFU0939F1ZZ' } }),
    ]);
    const r = await getSupplierGstinExceptions(TENANT);
    expect(r.suppliers[0].problem).toMatch(/Invalid GSTIN/);
  });

  it('leaves a valid supplier alone', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const r = await getSupplierGstinExceptions(TENANT);
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.taxAtRisk).toBe(0);
  });
});

describe('getItcReversalWorking (B-3)', () => {
  it('reverses the exempt share of the common credit', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    // 8,000 taxable and 2,000 exempt → 20% of the credit goes back.
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([
        { gstTreatment: 'taxable', taxPercent: 5, taxableValue: 8000, taxAmount: 400, totalAmount: 8400 },
        { gstTreatment: 'exempt', taxableValue: 2000, totalAmount: 2000 },
      ]),
    ]);

    const r = await getItcReversalWorking(TENANT);

    expect(r.exemptRatioPercent).toBe(20);
    expect(r.creditAvailable).toBe(120);
    expect(r.reversal.d1).toBe(24);
    expect(r.netCreditAvailable).toBe(96);
  });

  // For a hospital nearly everything is exempt, so nearly all of the credit
  // goes back. If this figure ever looks small, the exempt ratio is wrong.
  it('gives back nearly all of it when nearly everything is exempt', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([
        { gstTreatment: 'taxable', taxPercent: 5, taxableValue: 1000, taxAmount: 50, totalAmount: 1050 },
        { gstTreatment: 'exempt', taxableValue: 99000, totalAmount: 99000 },
      ]),
    ]);
    const r = await getItcReversalWorking(TENANT);
    expect(r.exemptRatioPercent).toBe(99);
    expect(r.netCreditAvailable).toBe(1.2);
  });

  it('lays the working out step by step with the rule\'s own labels', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const r = await getItcReversalWorking(TENANT);
    expect(r.working.map((w) => w.step)).toEqual([
      'T', 'T1', 'T2', 'T3', 'C1', 'T4', 'C2', 'E', 'F', 'D1', 'D2', 'C3',
    ]);
    // Every figure names where it came from, so an auditor can follow it
    // rather than rebuild it.
    expect(r.working.every((w) => !!w.source)).toBe(true);
  });

  // The system does not record which purchases were used exclusively for what,
  // so the whole of the input tax is treated as common credit — the
  // conservative reading. Saying so is the point.
  it('reports T1 to T4 as zero and says why', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const r = await getItcReversalWorking(TENANT);
    for (const step of ['T1', 'T2', 'T3', 'T4']) {
      const row = r.working.find((w) => w.step === step)!;
      expect(row.amount).toBe(0);
      expect(row.source).toMatch(/Not recorded/);
    }
    expect(r.notes[0]).toMatch(/does not record that split/);
  });

  it('reverses nothing when there is no turnover to apportion against', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const r = await getItcReversalWorking(TENANT);
    expect(r.reversal.total).toBe(0);
    expect(r.netCreditAvailable).toBe(120);
  });
});

describe('getPurchaseReturns (B-6)', () => {
  const vendorReturn = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    createdAt: new Date('2026-09-12T00:00:00Z'),
    quantity: 10,
    reason: 'Damaged in transit',
    status: 'approved',
    creditNoteNumber: 'SUPCN/9',
    creditAmount: 112,
    batchNumber: 'B-1',
    expiryDate: new Date('2027-07-07T00:00:00Z'),
    drug: { drugName: 'Paracetamol 500mg', hsnCode: '30049099' },
    supplier: { id: 's1', name: 'Acme Pharma', gstNumber: VALID_GSTIN },
    drugBatch: {
      purchasePrice: 10, purchaseDiscountPercent: 0, gstPercent: 12,
      invoiceNumber: 'SUP/001', invoiceDate: new Date('2026-09-05T00:00:00Z'),
    },
    ...over,
  });

  function seedReturns(returns: unknown[], writeOffs: unknown[] = []) {
    (prisma.drugReturn.findMany as any).mockResolvedValue(returns);
    (prisma.stockTransaction.findMany as any).mockResolvedValue(writeOffs);
  }

  // Priced at what was PAID on the batch, so the reversal matches the credit
  // that was taken — not at today's rate, and not at the selling rate.
  it('reverses the tax at the rate paid on the batch it came from', async () => {
    seedReturns([vendorReturn()]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.returns[0]).toMatchObject({
      taxableValue: 100, gstRatePercent: 12, taxToReverse: 12,
      purchaseInvoiceNumber: 'SUP/001',
      supplierCreditNoteNumber: 'SUPCN/9',
    });
    expect(r.totals.taxToReverse).toBe(12);
  });

  it('takes the batch discount into account, as the purchase did', async () => {
    seedReturns([vendorReturn({ drugBatch: { purchasePrice: 10, purchaseDiscountPercent: 20, gstPercent: 12, invoiceNumber: null, invoiceDate: null } })]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.returns[0].taxableValue).toBe(80);
    expect(r.returns[0].taxToReverse).toBe(9.6);
  });

  // The supplier owes a credit note for stock they took back. One that never
  // arrives is money the hospital has written off by accident.
  it('counts stock sent back with no supplier credit note', async () => {
    seedReturns([vendorReturn({ creditNoteNumber: null })]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.totals.withoutSupplierCreditNote).toBe(1);
  });

  // Nothing goes back to anybody, but 17(5)(h) blocks the credit all the same.
  // This is the one hospitals forget.
  it('reports expiry write-offs beside the returns', async () => {
    seedReturns([], [
      {
        id: 'w1', createdAt: new Date('2026-09-20T00:00:00Z'), quantity: 5,
        batchNumber: 'X-1', expiryDate: new Date('2026-09-01T00:00:00Z'),
        totalCost: 250, notes: 'Expired on the shelf',
        inventoryItem: { itemName: 'Surgical gloves' },
        supplier: { id: 's1', name: 'Acme Pharma' },
      },
    ]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.expiryWriteOffs[0]).toMatchObject({ itemName: 'Surgical gloves', value: 250 });
    expect(r.totals.expiredValue).toBe(250);
    expect(r.notes.join(' ')).toMatch(/17\(5\)\(h\)/);
  });

  it('asks only for vendor returns, never a patient return', async () => {
    seedReturns([]);
    await getPurchaseReturns(TENANT);
    const where = (prisma.drugReturn.findMany as any).mock.calls[0][0].where;
    expect(where.returnType).toBe('vendor_return');
  });
});
