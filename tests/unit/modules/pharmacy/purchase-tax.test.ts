import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  assertSupplierInvoice,
  inputTaxToReverse,
  purchaseLineTax,
  supplierStateOf,
  writeOffTypeFor,
} from '../../../../src/modules/pharmacy/purchase-tax';
import {
  adjustBatchStock,
  createBatch,
  createReturn,
  getPurchaseReport,
} from '../../../../src/modules/pharmacy/pharmacy.service';
import { receivePurchaseOrder } from '../../../../src/modules/inventory/inventory.service';

// G-9 / G-10 / G-12 — purchase-side GST capture.

const TENANT = 'tenant-1';
const ADMIN = ['pharmacy_admin'];
// A valid Maharashtra GSTIN (check digit included): the hospital's own state is 27.
const HOME_GSTIN = '27AAPFU0939F1ZV';

const p = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  p.tenant.findFirst.mockResolvedValue({
    themeConfig: { gst: { registered: true, gstin: HOME_GSTIN } },
  });
});

describe('purchase-tax helpers', () => {
  it('reads the supplier state from the stored code, else the GSTIN', () => {
    expect(supplierStateOf({ stateCode: '29' })).toBe('29');
    expect(supplierStateOf({ gstNumber: '07ABCDE1234F1Z5' })).toBe('07');
    expect(supplierStateOf({ gstNumber: '' })).toBeNull();
    expect(supplierStateOf(null)).toBeNull();
  });

  it('splits an intra-state receipt CGST+SGST and an inter-state one IGST (G-10)', () => {
    const local = purchaseLineTax({ taxableValue: 1000, ratePercent: 12, supplierState: '27', homeState: '27' });
    expect(local).toMatchObject({ taxAmount: 120, cgst: 60, sgst: 60, igst: 0, interState: false });
    const other = purchaseLineTax({ taxableValue: 1000, ratePercent: 12, supplierState: '29', homeState: '27' });
    expect(other).toMatchObject({ taxAmount: 120, cgst: 0, sgst: 0, igst: 120, interState: true });
  });

  it('reverses tax at the rate paid, keeping the batch\'s own IGST split (G-12)', () => {
    const t = inputTaxToReverse(
      { purchasePrice: 10, purchaseDiscountPercent: 10, gstPercent: 18, inputCgst: 0, inputSgst: 0, inputIgst: 162 },
      50,
      '27',
    );
    // 10 less 10% = 9 a unit, 50 units = 450, 18% = 81, all IGST.
    expect(t).toMatchObject({ taxableValue: 450, gstPercent: 18, taxAmount: 81, igst: 81, cgst: 0, sgst: 0 });
  });

  it('falls back to the drug rate when an old batch recorded none, never ₹0', () => {
    const t = inputTaxToReverse({ purchasePrice: 20 }, 5, '27', 5);
    expect(t).toMatchObject({ taxableValue: 100, gstPercent: 5, taxAmount: 5, cgst: 2.5, sgst: 2.5 });
  });

  it('recognises write-off reasons, and an explicit type wins', () => {
    expect(writeOffTypeFor(undefined, 'Damaged in transit')).toBe('damaged');
    expect(writeOffTypeFor(undefined, 'Strip broken')).toBe('damaged');
    expect(writeOffTypeFor(undefined, 'Expired stock removed')).toBe('expired');
    expect(writeOffTypeFor(undefined, 'Count correction after stock take')).toBeNull();
    expect(writeOffTypeFor('other', 'Count correction')).toBe('other');
  });

  it('requires the invoice number and date only from a registered supplier (G-9)', () => {
    expect(() => assertSupplierInvoice({ name: 'Local Medicals', gstNumber: null }, null, null)).not.toThrow();
    expect(() => assertSupplierInvoice({ name: 'ABC Pharma', gstNumber: HOME_GSTIN }, 'INV-1', null))
      .toThrow(/ABC Pharma is GST-registered — enter the supplier invoice date/);
    expect(() => assertSupplierInvoice({ name: 'ABC Pharma', gstNumber: HOME_GSTIN }, 'INV-1', '2026-11-01'))
      .not.toThrow();
  });
});

describe('createBatch — goods receipt tax (G-9, G-10)', () => {
  const base = {
    drugId: 'drug-1',
    batchNumber: 'B1',
    expiryDate: '2028-01-01',
    supplierId: 'sup-1',
    purchasePrice: 10,
    gstPercent: 12,
    quantityReceived: 100,
  };

  beforeEach(() => {
    p.drugFormulary.findFirst.mockResolvedValue({ id: 'drug-1', drugName: 'Amoxy', gstTreatment: null, hsnCode: null });
    p.drugBatch.findFirst.mockResolvedValue(null);
    p.drugBatch.create.mockImplementation(({ data }: any) => Promise.resolve({ ...data, supplier: null, drug: null }));
  });

  it('refuses a registered supplier\'s receipt with no invoice', async () => {
    p.supplier.findFirst.mockResolvedValue({ id: 'sup-1', name: 'ABC Pharma', gstNumber: '29AAPFU0939F1ZV', stateCode: '29' });
    await expect(createBatch(TENANT, 'u1', ADMIN, base as any)).rejects.toThrow(/GST-registered/);
    expect(p.drugBatch.create).not.toHaveBeenCalled();
  });

  it('stores IGST for an inter-state supplier', async () => {
    p.supplier.findFirst.mockResolvedValue({ id: 'sup-1', name: 'ABC Pharma', gstNumber: '29AAPFU0939F1ZV', stateCode: '29' });
    await createBatch(TENANT, 'u1', ADMIN, { ...base, invoiceNumber: 'INV-9', invoiceDate: '2026-11-01' } as any);
    const data = p.drugBatch.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ invoiceNumber: 'INV-9', inputCgst: 0, inputSgst: 0, inputIgst: 120 });
  });

  it('stores CGST+SGST for a local supplier', async () => {
    p.supplier.findFirst.mockResolvedValue({ id: 'sup-1', name: 'Local Medicals', gstNumber: null, stateCode: '27' });
    await createBatch(TENANT, 'u1', ADMIN, base as any);
    const data = p.drugBatch.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ inputCgst: 60, inputSgst: 60, inputIgst: 0 });
  });
});

describe('getPurchaseReport — opening stock is not a purchase (G-9)', () => {
  it('filters opening stock out at the query', async () => {
    p.drugBatch.findMany.mockResolvedValue([]);
    await getPurchaseReport(TENANT, {});
    const where = p.drugBatch.findMany.mock.calls[0][0].where;
    expect(where.isOpeningStock).toBe(false);
    expect(where.NOT).toEqual({ batchNumber: 'OPENING', supplierId: null });
  });
});

describe('vendor return — GST copied from the purchase batch (G-12)', () => {
  it('names the item and carries the tax to reverse', async () => {
    p.drugBatch.findFirst.mockResolvedValue({
      id: 'batch-1', drugId: 'drug-1', batchNumber: 'B1', expiryDate: new Date('2027-01-01'),
      quantityInStock: 40, purchasePrice: 10, purchaseDiscountPercent: 0, gstPercent: 12,
      inputCgst: 60, inputSgst: 60, inputIgst: 0,
    });
    p.supplier.findFirst.mockResolvedValue({ id: 'sup-1', name: 'ABC Pharma', gstNumber: HOME_GSTIN, stateCode: '27' });
    p.drugFormulary.findFirst.mockResolvedValue({ taxPercent: 12 });
    p.drugReturn.create.mockResolvedValue({ id: 'ret-1', drugBatch: null });
    // processReturn runs straight after; stop it at its first read — only the
    // row that was written matters here.
    p.drugReturn.findFirst.mockResolvedValue(null);

    await createReturn(TENANT, 'u1', ADMIN, {
      returnType: 'vendor_return', drugBatchId: 'batch-1', supplierId: 'sup-1', quantity: 10,
    } as any).catch(() => undefined);

    const data = p.drugReturn.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      drugId: 'drug-1',
      batchNumber: 'B1',
      inputGstPercent: 12,
      inputTaxableValue: 100,
      inputCgst: 6,
      inputSgst: 6,
      inputIgst: 0,
      // What was paid: value plus its GST.
      creditAmount: 112,
    });
  });
});

describe('adjustBatchStock — damaged stock is a write-off (G-12)', () => {
  it('records the input tax to reverse', async () => {
    const batch = {
      id: 'batch-1', drugId: 'drug-1', batchNumber: 'B1', quantityInStock: 30, supplierId: 'sup-1',
      purchasePrice: 10, purchaseDiscountPercent: 0, gstPercent: 5, invoiceNumber: 'INV-1',
      inputCgst: null, inputSgst: null, inputIgst: null,
      drug: { id: 'drug-1', drugName: 'Amoxy', category: 'drug', taxPercent: 5 },
      supplier: { gstNumber: null, stateCode: '27' },
    };
    p.drugBatch.findFirst.mockResolvedValue(batch);
    p.drugBatch.update.mockResolvedValue({ ...batch, quantityInStock: 20 });
    p.drugStockWriteOff.create.mockResolvedValue({ id: 'wo-1' });

    const out = await adjustBatchStock(TENANT, 'u1', ADMIN, 'batch-1', { newQuantity: 20, reason: 'Damaged — bottles broken' });

    const data = p.drugStockWriteOff.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      writeOffType: 'damaged', quantity: 10, taxableValue: 100, gstPercent: 5,
      inputCgst: 2.5, inputSgst: 2.5, inputIgst: 0, drugName: 'Amoxy', purchaseInvoiceNo: 'INV-1',
    });
    expect(out.writeOff).toEqual({ id: 'wo-1', taxToReverse: 5 });
  });

  it('does not book a plain count correction as a write-off', async () => {
    const batch = { id: 'batch-1', drugId: 'drug-1', batchNumber: 'B1', quantityInStock: 30, drug: { drugName: 'Amoxy' } };
    p.drugBatch.findFirst.mockResolvedValue(batch);
    p.drugBatch.update.mockResolvedValue({ ...batch, quantityInStock: 25 });
    await adjustBatchStock(TENANT, 'u1', ADMIN, 'batch-1', { newQuantity: 25, reason: 'Recount' });
    expect(p.drugStockWriteOff.create).not.toHaveBeenCalled();
  });
});

describe('receivePurchaseOrder — supplier invoice on the GRN (G-9)', () => {
  it('refuses a registered supplier\'s receipt with no invoice', async () => {
    p.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1', supplierId: 'sup-1', orderNumber: 'PO-1', status: 'approved',
      items: [{ id: 'poi-1', quantityOrdered: 10, quantityReceived: 0, inventoryItemId: 'item-1', drugId: null }],
    });
    p.supplier.findFirst.mockResolvedValue({ name: 'ABC Pharma', gstNumber: HOME_GSTIN, stateCode: '27' });
    await expect(
      receivePurchaseOrder(TENANT, 'po-1', 'u1', { items: [{ purchaseOrderItemId: 'poi-1', quantityReceived: 5 }] } as any),
    ).rejects.toThrow(/GST-registered/);
    expect(p.$transaction).not.toHaveBeenCalled();
  });
});
