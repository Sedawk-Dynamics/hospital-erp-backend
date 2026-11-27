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
  it('reports T1, T2 and T4 as zero and says why', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch()]);
    const r = await getItcReversalWorking(TENANT);
    for (const step of ['T1', 'T2', 'T4']) {
      const row = r.working.find((w) => w.step === step)!;
      expect(row.amount).toBe(0);
      expect(row.source).toMatch(/Not recorded/);
    }
    // T3 is now the blocked credit, which this valid-GSTIN batch has none of.
    expect(r.working.find((w) => w.step === 'T3')!.amount).toBe(0);
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

// Gap item 272: no valid supplier GSTIN, no input tax credit.
describe('purchases from a supplier with no GSTIN (gap item 272)', () => {
  const noGstin = () => batch({ id: 'b2', supplier: { id: 's2', name: 'Local Vendor', gstNumber: null } });

  it('marks the purchase ineligible in the register, with the reason', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([noGstin()]);
    const { rows } = await getPurchaseRegister(TENANT);
    expect(rows[0].itcEligibility).toBe('ineligible');
    expect(rows[0].itcBlockedReason).toMatch(/no GSTIN/);
  });

  it('keeps it out of the credit B-3 hands to GSTR-3B', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch(), noGstin()]);
    const r = await getItcReversalWorking(TENANT);
    expect(r.totalInputTax).toBe(240);
    expect(r.working.find((w) => w.step === 'T3')!.amount).toBe(120);
    expect(r.creditAvailable).toBe(120);
    expect(r.netCreditAvailable).toBe(120);
    expect(r.blockedCredit).toMatchObject({ total: 120, fromSuppliersWithoutGstin: 1 });
  });

  it('is still listed by the supplier exception report', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([noGstin()]);
    const r = await getSupplierGstinExceptions(TENANT);
    expect(r.suppliers[0]).toMatchObject({ supplierName: 'Local Vendor', problem: 'No GSTIN on file', taxAtRisk: 120 });
  });

  it('is counted as ineligible on the B-2 ladder, not reversed again', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([batch(), noGstin()]);
    const r = await getItcSummary(TENANT);
    const rung = (k: string) => r.ladder.find((x) => x.key === k)!.amount;
    expect(rung('gross')).toBe(240);
    expect(rung('ineligible')).toBe(120);
    expect(rung('eligible')).toBe(120);
  });
});

// ── Gap 273: damaged stock written off, and the head-wise split ─────────────
describe('B-6 pharmacy write-offs and the CGST / SGST / IGST split (gap 273)', () => {
  const damaged = (over: Record<string, unknown> = {}) => ({
    id: 'wo1', tenantId: TENANT, drugId: 'd1', drugBatchId: 'b1',
    drugName: 'Ceftriaxone 1g', batchNumber: 'CF-9', supplierId: 's1',
    writeOffType: 'damaged', quantity: 1, reason: 'Vial cracked',
    taxableValue: 100, gstPercent: 18, inputCgst: 9, inputSgst: 9, inputIgst: 0,
    purchaseInvoiceNo: 'SUP/77', performedBy: 'u1', createdAt: new Date('2026-11-20T10:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([]);
    (prisma.stockTransaction.findMany as any).mockResolvedValue([]);
    (prisma.drugBatch.findMany as any).mockResolvedValue([]);
  });

  // QA: one damaged unit of an 18% batch — the API had value 100 / tax 18 but
  // the totals the screen reads carried no split and no combined reversal.
  it('reports a damaged-stock write-off with its reversal, split by head, in the totals', async () => {
    (prisma.drugStockWriteOff.findMany as any).mockResolvedValue([damaged()]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.pharmacyWriteOffs[0]).toMatchObject({
      writeOffType: 'damaged', taxableValue: 100, gstRatePercent: 18,
      cgstAmount: 9, sgstAmount: 9, igstAmount: 0, taxToReverse: 18, purchaseInvoiceNumber: 'SUP/77',
    });
    expect(r.totals).toMatchObject({
      pharmacyWriteOffs: 1, pharmacyWriteOffValue: 100, pharmacyWriteOffTaxToReverse: 18,
      pharmacyWriteOffCgst: 9, pharmacyWriteOffSgst: 9, pharmacyWriteOffIgst: 0,
      totalTaxToReverse: 18,
    });
  });

  it('adds vendor returns and write-offs into one reversal total', async () => {
    (prisma.drugStockWriteOff.findMany as any).mockResolvedValue([damaged()]);
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      {
        id: 'r1', createdAt: new Date('2026-11-12T00:00:00Z'), quantity: 2, reason: 'Short expiry',
        status: 'approved', creditNoteNumber: null, creditAmount: null, batchNumber: 'B-1', expiryDate: null,
        inputGstPercent: 18, inputTaxableValue: 200, inputCgst: 18, inputSgst: 18, inputIgst: null,
        drug: { drugName: 'Paracetamol 500mg', hsnCode: '30049099' },
        supplier: { id: 's1', name: 'Acme Pharma', gstNumber: VALID_GSTIN, stateCode: '27' },
        drugBatch: null,
      },
    ]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.returns[0]).toMatchObject({ taxableValue: 200, taxToReverse: 36, cgstAmount: 18, sgstAmount: 18, igstAmount: 0 });
    expect(r.totals).toMatchObject({ taxToReverse: 36, returnCgst: 18, returnSgst: 18, returnIgst: 0, totalTaxToReverse: 54 });
  });

  it('splits an older return that stored no heads, and the heads add up to its tax', async () => {
    (prisma.drugStockWriteOff.findMany as any).mockResolvedValue([]);
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      {
        id: 'r2', createdAt: new Date('2026-11-12T00:00:00Z'), quantity: 10, reason: null,
        status: 'approved', creditNoteNumber: 'CN/1', creditAmount: 112, batchNumber: 'B-1', expiryDate: null,
        inputGstPercent: null, inputTaxableValue: null, inputCgst: null, inputSgst: null, inputIgst: null,
        drug: { drugName: 'Paracetamol 500mg', hsnCode: '30049099' },
        // A Gujarat supplier; the hospital's state is unknown in this test, so
        // the split falls back to intra-state, as the register assumes.
        supplier: { id: 's2', name: 'Guj Pharma', gstNumber: '24AAACC1206D1ZM', stateCode: '24' },
        drugBatch: { purchasePrice: 10, purchaseDiscountPercent: 0, gstPercent: 12, invoiceNumber: 'G/1', invoiceDate: null },
      },
    ]);
    const r = await getPurchaseReturns(TENANT);
    const row = r.returns[0];
    expect(row.taxToReverse).toBe(12);
    expect(row.cgstAmount + row.sgstAmount + row.igstAmount).toBe(12);
  });

  it('never reports a write-off with a rate but no stored heads as zero tax', async () => {
    (prisma.drugStockWriteOff.findMany as any).mockResolvedValue([
      damaged({ inputCgst: null, inputSgst: null, inputIgst: null }),
    ]);
    const r = await getPurchaseReturns(TENANT);
    expect(r.pharmacyWriteOffs[0]).toMatchObject({ taxToReverse: 18, cgstAmount: 9, sgstAmount: 9 });
  });
});
