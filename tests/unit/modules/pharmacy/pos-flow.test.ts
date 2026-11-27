import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createPharmacySale } from '../../../../src/modules/pharmacy/pharmacy.service';
import { createPharmacySaleSchema } from '../../../../src/modules/pharmacy/pharmacy.validation';
import { clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import {
  unitCostOf,
  marginPercent,
  saleLineFigures,
  loadPaidSaleLines,
  summariseSaleLines,
} from '../../../../src/modules/pharmacy/pharmacy.sales-figures';

// Regression cover for the pharmacy POS gap items: G-6 (IP counter sales),
// G-8 (card payment 400), 344 (payment before dispense), 346 (one sales
// query) and 348 (margin on cost).

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const FUTURE = new Date('2030-12-31');
const VALID_GSTIN = '27AAPFU0939F1ZV';

function model() {
  return {
    create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn(),
  };
}

function saleTx() {
  const tx: any = {
    drugBatch: model(), bill: model(), billItem: model(), payment: model(), admission: model(),
    dispensingRecord: model(), prescription: model(), gstDocumentSeries: model(), tenant: model(),
    stockMovement: model(), drugFormulary: model(),
  };
  tx.drugBatch.findFirst.mockResolvedValue({
    id: 'b1', batchNumber: 'BN1', quantityInStock: 100, isRecalled: false, expiryDate: FUTURE,
    drug: {
      drugName: 'Amox', price: 105, packSize: 1, looseUnitLabel: 'Tablet', dosageForm: 'tablet',
      taxPercent: 5, hsnCode: '3004', category: 'drug',
    },
  });
  tx.bill.count.mockResolvedValue(0);
  tx.bill.create.mockResolvedValue({ id: 'bill-1', billDate: new Date() });
  tx.dispensingRecord.create.mockResolvedValue({ id: 'dr1' });
  tx.drugBatch.update.mockResolvedValue({});
  tx.billItem.create.mockResolvedValue({});
  tx.payment.create.mockResolvedValue({});
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-1', billItems: [], payments: [], patient: {} });
  (prisma.tenant.findUnique as any).mockResolvedValue({ name: 'Hospital' });
  return tx;
}

const line = { drugBatchId: 'b1', quantity: 1, unitPrice: 105, saleUnit: 'pack' as const };

beforeEach(() => {
  vi.clearAllMocks();
  clearGstMasterCache();
  (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
  (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 0, balanceDue: 0 } });
  (prisma.admission.findFirst as any).mockResolvedValue(null);
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { gst: { registered: true, gstin: VALID_GSTIN, inpatientCompositeExempt: true } },
  });
  (prisma.hsnGstRate.findMany as any).mockResolvedValue([
    { hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: 'Medicaments' },
  ]);
  (prisma.sacCode.findMany as any).mockResolvedValue([]);
  (prisma.gstCategoryDefault.findMany as any).mockResolvedValue([]);
});

describe('G-6 — an admitted patient at the counter', () => {
  it('exempts the medicine on the server and tags the bill IP without making it the IP bill', async () => {
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1', billingCategory: 'cash', depositAmount: 0 });
    (prisma.$queryRaw as any).mockResolvedValue([{ admission_type: 'ip' }]);
    const tx = saleTx();

    await createPharmacySale(TENANT_ID, USER_ID, { patientId: 'p1', items: [line], paymentMethod: 'cash' } as any);

    const item = tx.billItem.create.mock.calls[0][0].data;
    expect(item.gstTreatment).toBe('exempt');
    expect(item.rateSource).toBe('inpatient_composite');
    const bill = tx.bill.create.mock.calls[0][0].data;
    expect(bill.encounterType).toBe('ip');
    expect(bill.saleAdmissionId).toBe('adm-1');
    // `admissionId` would make this paid counter bill the admission's running bill.
    expect(bill.admissionId).toBeUndefined();
  });

  it('keeps an outpatient sale taxable and tagged OP', async () => {
    const tx = saleTx();
    await createPharmacySale(TENANT_ID, USER_ID, { patientId: 'p1', items: [line], paymentMethod: 'cash' } as any);
    const item = tx.billItem.create.mock.calls[0][0].data;
    expect(item.gstTreatment).toBe('taxable');
    expect(item.taxPercent).toBe(5);
    expect(tx.bill.create.mock.calls[0][0].data.encounterType).toBe('op');
  });

  it('does not refuse a PAID sale to an admitted cash patient over deposit', async () => {
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1', billingCategory: 'cash', depositAmount: 10 });
    (prisma.$queryRaw as any).mockResolvedValue([{ admission_type: 'ip' }]);
    (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 999, balanceDue: 999 } });
    const tx = saleTx();
    await createPharmacySale(TENANT_ID, USER_ID, { patientId: 'p1', items: [line], paymentMethod: 'cash' } as any);
    expect(tx.bill.create).toHaveBeenCalled();
  });
});

describe('344 — payment before the medicine leaves', () => {
  it('refuses an unpaid sale with no credit reason, writing nothing', async () => {
    const tx = saleTx();
    await expect(
      createPharmacySale(TENANT_ID, USER_ID, { patientId: 'p1', items: [line], amountPaid: 0 } as any),
    ).rejects.toThrow(/Pay later/);
    expect(tx.bill.create).not.toHaveBeenCalled();
    expect(tx.dispensingRecord.create).not.toHaveBeenCalled();
  });

  it('dispenses on credit when a reason is given, and stores it', async () => {
    const tx = saleTx();
    await createPharmacySale(TENANT_ID, USER_ID, {
      patientId: 'p1', items: [line], amountPaid: 0, creditReason: 'Staff — salary deduction',
    } as any);
    const bill = tx.bill.create.mock.calls[0][0].data;
    expect(bill.status).toBe('pending');
    expect(bill.creditReason).toBe('Staff — salary deduction');
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
});

describe('G-8 — card payment', () => {
  it('accepts a blank card reference (null) instead of a bare 400', () => {
    const parsed = createPharmacySaleSchema.safeParse({
      body: {
        items: [{ ...line, drugBatchId: '0b9f2c64-3c1e-4c0a-9a55-1d2c3b4a5e6f' }],
        payments: [{ method: 'credit_card', amount: 105, reference: null }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('records the card in the same transaction as the sale, with its reference', async () => {
    const tx = saleTx();
    await createPharmacySale(TENANT_ID, USER_ID, {
      patientId: 'p1', items: [line], paymentMethod: 'credit_card', paymentReference: 'AUTH-7781',
    } as any);
    const pay = tx.payment.create.mock.calls[0][0].data;
    expect(pay.paymentMethod).toBe('credit_card');
    expect(pay.transactionId).toBe('AUTH-7781');
    // Paid in full off the server's own total — no client-side rounding to disagree with.
    expect(tx.bill.create.mock.calls[0][0].data.status).toBe('paid');
  });
});

describe('348 — margin on cost', () => {
  it('is (retail excl. tax − cost) ÷ cost', () => {
    // ₹105 MRP at 5% → ₹100 ex-tax; cost ₹80 → 25%.
    const f = saleLineFigures(
      { quantityDispensed: 1, lineTotal: 105, taxPercent: 5 },
      { purchasePrice: 80 },
    );
    expect(f.retailExclTax).toBeCloseTo(100, 2);
    expect(marginPercent(f.retailExclTax, f.cost)).toBe(25);
  });

  it('says "cost not set" (null) instead of a negative percentage', () => {
    expect(unitCostOf({ purchasePrice: null })).toBeNull();
    const f = saleLineFigures({ quantityDispensed: 1, lineTotal: 100, taxPercent: 0 }, { purchasePrice: 0 });
    expect(f.cost).toBeNull();
    expect(f.profit).toBeNull();
    expect(marginPercent(f.retailExclTax, f.cost)).toBeNull();
  });

  it('takes the purchase discount and free units out of the cost', () => {
    // ₹10 less 10% = ₹9 on 90 paid of 100 received → ₹8.10 a unit.
    expect(unitCostOf({ purchasePrice: 10, purchaseDiscountPercent: 10, quantityReceived: 100, freeQuantity: 10 }))
      .toBeCloseTo(8.1, 5);
  });
});

describe('346 — one definition of a sale', () => {
  it('counts only lines on PAID bills, priced as billed', async () => {
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { id: 'd1', quantityDispensed: 1, lineTotal: 100, taxPercent: 0, billId: 'paid', dispensedAt: new Date(), drugBatch: { purchasePrice: 50 } },
      { id: 'd2', quantityDispensed: 1, lineTotal: 70, taxPercent: 0, billId: 'pending', dispensedAt: new Date(), drugBatch: { purchasePrice: 50 } },
      // A queue dispense whose bill is found through its bill line.
      { id: 'd3', quantityDispensed: 2, lineTotal: null, unitPrice: 10, taxPercent: 0, billId: null, dispensedAt: new Date(), drugBatch: {} },
    ]);
    (prisma.billItem.findMany as any).mockResolvedValue([
      { referenceId: 'd3', billId: 'paid', taxableValue: 20, taxAmount: 0, totalAmount: 20 },
    ]);
    (prisma.bill.findMany as any).mockResolvedValue([{ id: 'paid' }]);

    const lines = await loadPaidSaleLines(TENANT_ID, new Date(0), new Date());
    expect(lines.map((l) => l.id)).toEqual(['d1', 'd3']);
    const s = summariseSaleLines(lines);
    expect(s.revenue).toBe(120);
    expect(s.costMissingLines).toBe(1);
    expect(s.marginPct).toBe(100); // (100 − 50) ÷ 50 over the costed line
  });
});

describe('345 — one selling unit per item', () => {
  it('names a whole bottle as a bottle, not as ml', async () => {
    const { saleUnitNouns, describeSaleQty } = await import('../../../../src/modules/pharmacy/pharmacy.units');
    const nouns = saleUnitNouns({ dosageForm: 'syrup', unitOfMeasurement: 'Bottle', packSize: 1 });
    expect(nouns).toEqual({ packNoun: 'bottle', looseNoun: 'bottle' });
    expect(describeSaleQty(2, 'pack', 1, nouns)).toBe('2 bottles');
  });

  it('describes a strip sale and a loose sale in the configured nouns', async () => {
    const { saleUnitNouns, describeSaleQty } = await import('../../../../src/modules/pharmacy/pharmacy.units');
    const nouns = saleUnitNouns({ looseUnitLabel: 'tablet', unitOfMeasurement: 'Strip (UQC PAC)', packSize: 10 });
    expect(describeSaleQty(20, 'pack', 10, nouns)).toBe('2 strips of 10 tablets');
    expect(describeSaleQty(5, 'loose', 10, nouns)).toBe('5 tablets, loose');
  });
});
