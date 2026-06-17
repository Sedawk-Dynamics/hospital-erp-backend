import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  createPharmacySale,
  createReturn,
  processReturn,
  mergeEmergencyPatient,
  getWardLedger,
  getPurchaseReport,
  getReturnById,
  createFormularyItem,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];
const FUTURE = new Date('2030-12-31');

function model() {
  return {
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn(),
  };
}
function txWith(overrides: Record<string, any> = {}) {
  const tx: any = {
    drugBatch: model(), drugFormulary: model(), drugReturn: model(), prescriptionItem: model(),
    wardStock: model(), wardStockLedger: model(), bill: model(), billItem: model(),
    payment: model(), refund: model(), admission: model(), patient: model(),
    dispensingRecord: model(), prescription: model(),
    ...overrides,
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  return tx;
}

describe('Pharmacy — flow coverage (sale / returns / merge / reports)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── G7 split payment + G2 bill discount (createPharmacySale) ──
  describe('createPharmacySale (G7 / G2)', () => {
    function mockSaleBatch(tx: any, stock = 100) {
      tx.drugBatch.findFirst.mockResolvedValue({
        id: 'b1', batchNumber: 'BN1', quantityInStock: stock, isRecalled: false, expiryDate: FUTURE,
        drug: { drugName: 'Amox', price: 100, packSize: 1, looseUnitLabel: 'Tablet', dosageForm: 'tablet', taxPercent: 12 },
      });
      tx.bill.count.mockResolvedValue(0);
      tx.bill.create.mockResolvedValue({ id: 'bill-1' });
      tx.dispensingRecord.create.mockResolvedValue({ id: 'dr1' });
      tx.drugBatch.update.mockResolvedValue({});
      tx.billItem.create.mockResolvedValue({});
      tx.payment.create.mockResolvedValue({});
      // createPharmacySale returns getPharmacySale(...) — stub the re-fetch.
      (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-1', billItems: [], payments: [], patient: {} });
      (prisma.tenant.findUnique as any).mockResolvedValue({ name: 'Hospital' });
    }

    it('records each tender of a split payment and settles in full', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      mockSaleBatch(tx);

      await createPharmacySale(TENANT_ID, USER_ID, {
        patientId: 'p1',
        items: [{ drugBatchId: 'b1', quantity: 1, unitPrice: 100, saleUnit: 'pack' }],
        payments: [{ method: 'cash', amount: 60 }, { method: 'upi', amount: 40 }],
      } as any);

      expect(tx.payment.create).toHaveBeenCalledTimes(2);
      const bill = tx.bill.create.mock.calls[0][0].data;
      expect(bill.totalAmount).toBe(100);
      expect(bill.amountPaid).toBe(100);
      expect(bill.balanceDue).toBe(0);
      expect(bill.status).toBe('paid');
    });

    it('trims change off the last tender (excess cash is not a credit)', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      mockSaleBatch(tx);

      await createPharmacySale(TENANT_ID, USER_ID, {
        patientId: 'p1',
        items: [{ drugBatchId: 'b1', quantity: 1, unitPrice: 100, saleUnit: 'pack' }],
        payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 40 }], // 140 for a 100 bill
      } as any);

      // upi tender fully trimmed → only the cash row survives, summing to 100.
      expect(tx.payment.create).toHaveBeenCalledTimes(1);
      expect(tx.payment.create.mock.calls[0][0].data.amount).toBe(100);
      expect(tx.bill.create.mock.calls[0][0].data.amountPaid).toBe(100);
    });

    it('applies a bill-level discount and reduces the total', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      mockSaleBatch(tx);

      await createPharmacySale(TENANT_ID, USER_ID, {
        patientId: 'p1',
        items: [{ drugBatchId: 'b1', quantity: 1, unitPrice: 100, saleUnit: 'pack' }],
        billDiscountPercent: 10,
      } as any);

      const bill = tx.bill.create.mock.calls[0][0].data;
      expect(bill.totalAmount).toBe(90);     // 100 − 10%
      expect(bill.discountAmount).toBe(10);
      expect(bill.amountPaid).toBe(90);      // default pay-in-full of the discounted total
    });

    it('rejects a sale that exceeds available stock', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      mockSaleBatch(tx, 0);
      await expect(createPharmacySale(TENANT_ID, USER_ID, {
        patientId: 'p1', items: [{ drugBatchId: 'b1', quantity: 1, unitPrice: 100, saleUnit: 'pack' }],
      } as any)).rejects.toThrow('Insufficient stock');
    });
  });

  // ── G5 vendor return (credit note) ────────────────────────
  describe('createReturn — vendor_return (G5)', () => {
    it('auto-computes the credit value from purchase price × qty and applies immediately', async () => {
      (prisma.supplier.findFirst as any).mockResolvedValue({ id: 's1', tenantId: TENANT_ID });
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID, purchasePrice: 30 });
      (prisma.drugReturn.create as any).mockImplementation((args: any) => Promise.resolve({ id: 'r1', ...args.data, drugBatch: { batchNumber: 'BN1', drug: { drugName: 'Amox' } } }));
      // Returns now apply immediately — createReturn finalizes via processReturn.
      (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'r1', tenantId: TENANT_ID, status: 'pending', returnType: 'vendor_return', drugBatchId: 'b1', quantity: 5, refundAmount: null });
      const tx = txWith();
      tx.drugBatch.findUnique.mockResolvedValue({ quantityInStock: 100 });
      tx.drugReturn.findUnique.mockResolvedValue({ id: 'r1', status: 'processed' });

      await createReturn(TENANT_ID, USER_ID, ADMIN_ROLES, {
        returnType: 'vendor_return', drugBatchId: 'b1', supplierId: 's1', quantity: 5, reason: 'expired', creditNoteNumber: 'CN-9',
      } as any);

      const created = (prisma.drugReturn.create as any).mock.calls[0][0].data;
      expect(created.creditNoteNumber).toBe('CN-9');
      expect(created.creditAmount).toBe(150); // 30 × 5
      // vendor return decrements stock on the immediate apply
      expect(tx.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { decrement: 5 } } });
    });

    it('requires a supplier for a vendor return', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID });
      await expect(createReturn(TENANT_ID, USER_ID, ADMIN_ROLES, {
        returnType: 'vendor_return', drugBatchId: 'b1', quantity: 5,
      } as any)).rejects.toThrow('Supplier ID is required');
    });
  });

  // ── Patient return: staff-entered "money given" overrides billed price ──
  describe('createReturn — refund amount override (money given)', () => {
    it('uses the entered refund amount instead of the billed price', async () => {
      // Original sale: 10 units @ ₹20 (so billed price for 3 = ₹60), but staff
      // hands back ₹40.
      (prisma.dispensingRecord.findFirst as any).mockResolvedValue({
        id: 'dr1', drugBatchId: 'b1', patientId: 'p1', billId: 'bill-1', saleUnit: 'pack',
        quantityDispensed: 10, unitPrice: 20, discountPercent: 0,
      });
      (prisma.drugReturn.aggregate as any).mockResolvedValue({ _sum: { quantity: 0 } });
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID });
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      (prisma.drugReturn.create as any).mockImplementation((args: any) => Promise.resolve({ id: 'r1', ...args.data }));
      // immediate apply
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'r1', tenantId: TENANT_ID, status: 'pending', returnType: 'patient_return',
        drugBatchId: 'b1', quantity: 3, billId: 'bill-1', patientId: 'p1', refundAmount: 40,
      });
      const tx = txWith();
      tx.payment.findFirst.mockResolvedValue({ id: 'pay1', bill: { id: 'bill-1', amountPaid: 200, totalAmount: 200, status: 'paid' } });
      tx.admission.findFirst.mockResolvedValue(null);
      tx.refund.create.mockResolvedValue({ id: 'rf1' });
      tx.drugReturn.findUnique.mockResolvedValue({ id: 'r1', status: 'processed' });

      await createReturn(TENANT_ID, USER_ID, ADMIN_ROLES, {
        returnType: 'patient_return', dispensingRecordId: 'dr1', quantity: 3, refundAmount: 40,
      } as any);

      // the DrugReturn is created with the entered amount, not the ₹60 billed price
      expect((prisma.drugReturn.create as any).mock.calls[0][0].data.refundAmount).toBe(40);
      // and a refund of that amount is booked against the bill (shows on the bill)
      expect(tx.refund.create.mock.calls[0][0].data.amount).toBe(40);
      expect(tx.bill.update).toHaveBeenCalled();
    });
  });

  // ── G5 / G14 processReturn (stock direction + refund routing) ──
  describe('processReturn — stock + refund routing', () => {
    it('decrements stock for a vendor return (stock leaves the shelf)', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'r1', tenantId: TENANT_ID, status: 'pending', returnType: 'vendor_return', drugBatchId: 'b1', quantity: 5, refundAmount: null,
      });
      const tx = txWith();
      tx.drugBatch.findUnique.mockResolvedValue({ quantityInStock: 100 });
      tx.drugReturn.update.mockResolvedValue({});
      tx.drugBatch.update.mockResolvedValue({});
      tx.drugReturn.findUnique.mockResolvedValue({ id: 'r1', status: 'processed' });

      const r = await processReturn(TENANT_ID, 'r1', USER_ID, { status: 'processed' });
      expect(r!.status).toBe('processed');
      expect(tx.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { decrement: 5 } } });
    });

    it('refunds cash for a patient return with no admission (G14)', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'r1', tenantId: TENANT_ID, status: 'pending', returnType: 'patient_return', drugBatchId: 'b1', quantity: 5,
        billId: 'bill-1', patientId: 'p1', refundAmount: 50,
      });
      const tx = txWith();
      tx.drugReturn.update.mockResolvedValue({});
      tx.drugBatch.update.mockResolvedValue({});
      tx.payment.findFirst.mockResolvedValue({ id: 'pay1', bill: { id: 'bill-1', amountPaid: 100, totalAmount: 100, status: 'paid' } });
      tx.admission.findFirst.mockResolvedValue(null); // no admission → cash
      tx.refund.create.mockResolvedValue({ id: 'rf1' });
      tx.bill.update.mockResolvedValue({});
      tx.drugReturn.findUnique.mockResolvedValue({ id: 'r1', status: 'processed', patientId: 'p1', refundId: 'rf1', patient: null });

      await processReturn(TENANT_ID, 'r1', USER_ID, { status: 'processed' });
      expect(tx.refund.create).toHaveBeenCalled();
      expect(tx.admission.update).not.toHaveBeenCalled(); // cash path never touches the advance
    });

    it('credits advance for a package patient return (G14)', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'r1', tenantId: TENANT_ID, status: 'pending', returnType: 'patient_return', drugBatchId: 'b1', quantity: 5,
        billId: 'bill-1', patientId: 'p1', refundAmount: 50,
      });
      const tx = txWith();
      tx.drugReturn.update.mockResolvedValue({});
      tx.drugBatch.update.mockResolvedValue({});
      tx.payment.findFirst.mockResolvedValue({ id: 'pay1', bill: { id: 'bill-1', amountPaid: 100, totalAmount: 100, status: 'paid' } });
      tx.admission.findFirst.mockResolvedValue({ id: 'adm1', billingCategory: 'package', depositAmount: 1000 });
      tx.refund.create.mockResolvedValue({ id: 'rf1' });
      tx.bill.update.mockResolvedValue({});
      tx.admission.update.mockResolvedValue({});
      tx.drugReturn.findUnique.mockResolvedValue({ id: 'r1', status: 'processed', patientId: 'p1', refundId: 'rf1', patient: null });

      await processReturn(TENANT_ID, 'r1', USER_ID, { status: 'processed' });
      expect(tx.admission.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'adm1' } }));
    });
  });

  // ── G16 retrospective merge ───────────────────────────────
  describe('mergeEmergencyPatient (G16)', () => {
    it('migrates the temp patient ledger to the permanent MRN and retires it', async () => {
      (prisma.patient.findFirst as any)
        .mockResolvedValueOnce({ id: 'temp', mrn: 'TEMP-ER-20260101-001' })
        .mockResolvedValueOnce({ id: 'tgt', mrn: 'MRN001' });
      const tx = txWith();
      tx.bill.updateMany.mockResolvedValue({ count: 2 });
      tx.payment.updateMany.mockResolvedValue({ count: 1 });
      tx.dispensingRecord.updateMany.mockResolvedValue({ count: 3 });
      tx.drugReturn.updateMany.mockResolvedValue({ count: 0 });
      tx.refund.updateMany.mockResolvedValue({ count: 0 });
      tx.prescription.updateMany.mockResolvedValue({ count: 1 });
      tx.patient.update.mockResolvedValue({});

      const r = await mergeEmergencyPatient(TENANT_ID, USER_ID, 'temp', 'tgt');
      expect(r.bills).toBe(2);
      expect(r.dispenses).toBe(3);
      expect(tx.patient.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'temp' } }));
    });

    it('refuses to merge into a non-permanent target', async () => {
      (prisma.patient.findFirst as any)
        .mockResolvedValueOnce({ id: 'temp', mrn: 'TEMP-ER-1' })
        .mockResolvedValueOnce({ id: 'tgt', mrn: 'TEMP-ER-2' });
      await expect(mergeEmergencyPatient(TENANT_ID, USER_ID, 'temp', 'tgt')).rejects.toThrow('permanent');
    });
  });

  // ── G13 ward ledger ───────────────────────────────────────
  describe('getWardLedger (G13)', () => {
    it('joins ledger rows with drug + patient detail', async () => {
      (prisma.wardStockLedger.findMany as any).mockResolvedValue([
        { id: 'l1', drugBatchId: 'b1', patientId: 'p1', movementType: 'dispensed', quantity: 2, createdAt: new Date(), reason: null },
      ]);
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ id: 'b1', batchNumber: 'BN1', drug: { drugName: 'Amox' } }]);
      (prisma.patient.findMany as any).mockResolvedValue([{ id: 'p1', mrn: 'M1', firstName: 'A', lastName: 'B' }]);

      const r = await getWardLedger(TENANT_ID, { wardId: 'ward-1' });
      expect(r.items[0]).toMatchObject({ movementType: 'dispensed', drugName: 'Amox', quantity: 2, patientMrn: 'M1' });
    });
  });

  // ── G15 purchase report (with invoice trace) ──────────────
  describe('getPurchaseReport (G15)', () => {
    it('lists received batches with invoice number and totals', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([
        { id: 'b1', batchNumber: 'BN1', expiryDate: FUTURE, createdAt: new Date(), mrp: 50, purchasePrice: 30,
          purchaseDiscountPercent: 10, gstPercent: 12, quantityReceived: 100, freeQuantity: 10,
          invoiceNumber: 'INV-1', invoiceDate: new Date(), drug: { id: 'd1', drugName: 'Amox' }, supplier: { id: 's1', name: 'Acme' } },
      ]);
      const r = await getPurchaseReport(TENANT_ID, {});
      expect(r.items[0].invoiceNumber).toBe('INV-1');
      expect(r.totals.lineCount).toBe(1);
      expect(r.totals.totalQty).toBe(100);
    });
  });

  // ── G3 return receipt detail ──────────────────────────────
  describe('getReturnById (G3)', () => {
    it('returns the record with its original invoice number + hospital', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'r1', billId: 'bill-1', quantity: 5 });
      (prisma.bill.findFirst as any).mockResolvedValue({ billNumber: 'PH-1' });
      (prisma.tenant.findUnique as any).mockResolvedValue({ name: 'Hospital' });

      const r = await getReturnById(TENANT_ID, 'r1');
      expect(r.return.id).toBe('r1');
      expect(r.billNumber).toBe('PH-1');
      expect(r.hospital?.name).toBe('Hospital');
    });

    it('throws when the return is unknown', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue(null);
      await expect(getReturnById(TENANT_ID, 'nope')).rejects.toThrow('Drug return not found');
    });
  });

  // ── G1 duplicate-suspected guard on inward ────────────────
  describe('createFormularyItem — duplicate guard (G1)', () => {
    it('returns duplicate_suspected when a near-identical drug exists', async () => {
      // "Telmac 40 Tab" vs existing "Telmac 40" → high-confidence match, blocked.
      (prisma.drugFormulary.findMany as any).mockResolvedValue([
        { id: 'existing', drugName: 'Telmac 40', genericName: null, manufacturer: null, dosageForm: null, strength: null, packSize: null, price: null, drugMasterId: null, drugBatches: [] },
      ]);

      const r = await createFormularyItem(TENANT_ID, ADMIN_ROLES, { drugName: 'Telmac 40 Tab' } as any);
      expect(r.status).toBe('duplicate_suspected');
      expect((r as any).matches.length).toBeGreaterThan(0);
      // It must NOT create a new row when a duplicate is suspected.
      expect(prisma.drugFormulary.create).not.toHaveBeenCalled();
    });
  });
});
