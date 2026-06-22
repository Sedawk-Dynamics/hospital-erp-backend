import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  batchPurchaseEconomics,
  getPatientCreditStatus,
  adjustBatchStock,
  getStockAdjustments,
  setPrescriptionPharmacyStatus,
  getFormularyAlternatives,
  getReorderList,
  getNarcoticRegister,
  getReturnableDispenses,
  transferToWard,
  dispenseFromWard,
  getWardStock,
  createEmergencyPatient,
  mergeFormularyItems,
  getStockValuationReport,
  getVendorWiseReport,
  getDailyTransactionReport,
  getCreditNotesReport,
  createBatch,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];

// A full per-model mock for use inside $transaction callbacks.
function model() {
  return {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    aggregate: vi.fn(),
    count: vi.fn(),
  };
}
function txWith(overrides: Record<string, any> = {}) {
  const tx: any = {
    drugBatch: model(),
    drugFormulary: model(),
    drugReturn: model(),
    prescriptionItem: model(),
    wardStock: model(),
    wardStockLedger: model(),
    bill: model(),
    billItem: model(),
    payment: model(),
    refund: model(),
    admission: model(),
    patient: model(),
    dispensingRecord: model(),
    prescription: model(),
    ...overrides,
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  return tx;
}

describe('Pharmacy — feature coverage (G1–G17 + credit gate + GRN gaps)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── G2: purchase economics ────────────────────────────────
  describe('batchPurchaseEconomics (G2)', () => {
    it('derives net rate, value, tax, landing cost and margin', () => {
      const e = batchPurchaseEconomics({
        mrp: 120, purchasePrice: 88, purchaseDiscountPercent: 10, gstPercent: 12,
        sellingPrice: 100, quantityReceived: 110, freeQuantity: 10,
      });
      expect(e.netRate).toBe(79.2);            // 88 × (1 − 0.10)
      expect(e.netPurchaseValue).toBe(7920);   // 79.2 × 100 paid units
      expect(e.taxAmount).toBe(950.4);         // 12% of net value
      expect(e.landingPerUnit).toBe(80.64);    // (7920 + 950.4) ÷ 110 received
      expect(e.marginPerUnit).toBe(19.36);     // 100 − 80.64
      expect(e.marginPercent).toBeCloseTo(24.01, 1);
    });

    it('returns nulls when pricing is absent', () => {
      const e = batchPurchaseEconomics({});
      expect(e.netRate).toBeNull();
      expect(e.netPurchaseValue).toBeNull();
      expect(e.marginPercent).toBeNull();
    });
  });

  // ── Credit & clearance check (design-doc IP Step 3) ───────
  describe('getPatientCreditStatus', () => {
    it('flags clearance for a cash patient over deposit', async () => {
      (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1', billingCategory: 'cash', depositAmount: 1000 });
      (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 1500, balanceDue: 1500 } });

      const s = await getPatientCreditStatus(TENANT_ID, 'patient-1');
      expect(s.category).toBe('cash');
      expect(s.exceeded).toBe(true);
      expect(s.requiresClearance).toBe(true);
      expect(s.available).toBe(-500);
    });

    it('never gates a package patient', async () => {
      (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1', billingCategory: 'package', depositAmount: 0 });
      (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 5000, balanceDue: 5000 } });

      const s = await getPatientCreditStatus(TENANT_ID, 'patient-1');
      expect(s.requiresClearance).toBe(false);
    });

    it('does not gate when there is no admission', async () => {
      (prisma.admission.findFirst as any).mockResolvedValue(null);
      (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 0, balanceDue: 0 } });

      const s = await getPatientCreditStatus(TENANT_ID, 'patient-1');
      expect(s.hasAdmission).toBe(false);
      expect(s.requiresClearance).toBe(false);
    });
  });

  // ── G4: stock adjustment + audit ──────────────────────────
  describe('adjustBatchStock (G4)', () => {
    it('corrects on-hand stock and reports the delta', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1', tenantId: TENANT_ID, batchNumber: 'B1', quantityInStock: 100, drug: { id: 'd1', drugName: 'Amox' },
      });
      (prisma.drugBatch.update as any).mockResolvedValue({ id: 'batch-1', quantityInStock: 80 });

      const r = await adjustBatchStock(TENANT_ID, USER_ID, ADMIN_ROLES, 'batch-1', { newQuantity: 80, reason: 'count' });
      expect(r.from).toBe(100);
      expect(r.to).toBe(80);
      expect(r.delta).toBe(-20);
      expect(prisma.drugBatch.update).toHaveBeenCalledWith(expect.objectContaining({ data: { quantityInStock: 80 } }));
    });

    it('rejects a negative corrected quantity', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', tenantId: TENANT_ID, quantityInStock: 10, drug: {} });
      await expect(adjustBatchStock(TENANT_ID, USER_ID, ADMIN_ROLES, 'batch-1', { newQuantity: -1, reason: 'x' }))
        .rejects.toThrow('cannot be negative');
    });

    it('throws if the batch does not exist', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      await expect(adjustBatchStock(TENANT_ID, USER_ID, ADMIN_ROLES, 'nope', { newQuantity: 5, reason: 'x' }))
        .rejects.toThrow('Drug batch not found');
    });
  });

  describe('getStockAdjustments (G4)', () => {
    it('maps tagged audit rows into a discrepancy report', async () => {
      (prisma.auditLog.findMany as any).mockResolvedValue([
        { id: 'a1', entityId: 'batch-1', createdAt: new Date(), user: { id: 'u', firstName: 'Jo', lastName: null },
          newValues: { type: 'stock_adjustment', drugName: 'Amox', batchNumber: 'B1', from: 100, to: 80, delta: -20, reason: 'count' } },
      ]);
      (prisma.auditLog.count as any).mockResolvedValue(1);

      const r = await getStockAdjustments(TENANT_ID, {});
      expect(r.total).toBe(1);
      expect(r.items[0]).toMatchObject({ batchId: 'batch-1', from: 100, to: 80, delta: -20, reason: 'count', user: 'Jo' });
    });
  });

  // ── G12: ward→pharmacy order lifecycle ────────────────────
  describe('setPrescriptionPharmacyStatus (G12)', () => {
    it('advances the fulfilment status', async () => {
      (prisma.prescription.findFirst as any).mockResolvedValue({ id: 'rx-1', pharmacyStatus: 'ordered' });
      (prisma.prescription.update as any).mockResolvedValue({ id: 'rx-1', pharmacyStatus: 'ready' });

      const r = await setPrescriptionPharmacyStatus(TENANT_ID, USER_ID, 'rx-1', 'ready');
      expect(r.pharmacyStatus).toBe('ready');
    });

    it('throws when the prescription is missing', async () => {
      (prisma.prescription.findFirst as any).mockResolvedValue(null);
      await expect(setPrescriptionPharmacyStatus(TENANT_ID, USER_ID, 'x', 'ready')).rejects.toThrow('Prescription not found');
    });
  });

  // ── G8: alternatives by composition ───────────────────────
  describe('getFormularyAlternatives (G8)', () => {
    it('lists same-composition brands, in-stock first', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', genericName: 'Paracetamol', strength: '500mg', dosageForm: 'tablet' });
      (prisma.drugFormulary.findMany as any).mockResolvedValue([
        { id: 'd2', drugName: 'Calpol', genericName: 'Paracetamol', manufacturer: 'GSK', dosageForm: 'tablet', strength: '500mg', price: 5, packSize: 10, looseUnitLabel: 'Tablet', drugBatches: [] },
        { id: 'd3', drugName: 'Dolo', genericName: 'Paracetamol', manufacturer: 'Micro', dosageForm: 'tablet', strength: '500mg', price: 4, packSize: 15, looseUnitLabel: 'Tablet', drugBatches: [{ quantityInStock: 20, expiryDate: new Date('2027-01-01') }] },
      ]);

      const r = await getFormularyAlternatives(TENANT_ID, 'd1');
      expect(r.composition).toBe('Paracetamol');
      expect(r.alternatives[0].drugName).toBe('Dolo'); // in stock sorts first
      expect(r.alternatives[0].totalStock).toBe(20);
    });

    it('returns empty when the drug has no composition', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', genericName: null });
      const r = await getFormularyAlternatives(TENANT_ID, 'd1');
      expect(r.alternatives).toEqual([]);
    });
  });

  // ── G9: reorder list ──────────────────────────────────────
  describe('getReorderList (G9)', () => {
    it('surfaces low-stock drugs with a suggested top-up qty', async () => {
      (prisma.drugFormulary.findMany as any).mockResolvedValue([
        { id: 'd1', drugName: 'Amox', strength: '500mg', manufacturer: 'X', minStock: 20, packSize: 10, drugBatches: [{ quantityInStock: 5 }] },
        { id: 'd2', drugName: 'Pan', strength: '40mg', manufacturer: 'Y', minStock: 10, packSize: 10, drugBatches: [{ quantityInStock: 50 }] },
      ]);
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ drugId: 'd1', supplier: { name: 'Acme' } }]);

      const r = await getReorderList(TENANT_ID);
      expect(r.total).toBe(1); // only d1 is at/below reorder level
      expect(r.items[0]).toMatchObject({ drugId: 'd1', stock: 5, minStock: 20, suggestedQty: 35, lastSupplier: 'Acme' });
    });
  });

  // ── G17: narcotic register ────────────────────────────────
  describe('getNarcoticRegister (G17)', () => {
    it('lists scheduled-drug dispenses for a DI audit', async () => {
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([
        { id: 'dr1', quantityDispensed: 2, dispensedAt: new Date(), billId: 'b1',
          patient: { id: 'p1', mrn: 'M1', firstName: 'A', lastName: 'B' },
          dispenser: { id: 'u1', firstName: 'Ph', lastName: 'One' },
          drugBatch: { batchNumber: 'BN1', drug: { drugName: 'Morphine', drugMaster: { schedule: 'X' } } } },
      ]);
      const r = await getNarcoticRegister(TENANT_ID, {});
      expect(r.total).toBe(1);
      expect(r.items[0]).toMatchObject({ drugName: 'Morphine', schedule: 'X', quantity: 2, patientMrn: 'M1', dispensedBy: 'Ph One' });
    });
  });

  // ── G3: returnable lookup ─────────────────────────────────
  describe('getReturnableDispenses (G3)', () => {
    it('throws when neither patientId nor billNumber is given', async () => {
      await expect(getReturnableDispenses(TENANT_ID, {})).rejects.toThrow('Provide a patientId or a billNumber');
    });

    it('throws when the bill number is unknown', async () => {
      (prisma.bill.findFirst as any).mockResolvedValue(null);
      await expect(getReturnableDispenses(TENANT_ID, { billNumber: 'NOPE' })).rejects.toThrow('Bill not found');
    });

    it('computes returnable quantity (dispensed minus already returned)', async () => {
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([
        { id: 'dr1', quantityDispensed: 10, dispensedAt: new Date(), billId: 'b1', patientId: 'p1', saleUnit: 'pack', unitPrice: 10, discountPercent: 0,
          drugBatch: { batchNumber: 'BN1', drug: { drugName: 'Amox', looseUnitLabel: 'Tablet' } },
          drugReturns: [{ quantity: 3 }] },
      ]);
      (prisma.bill.findMany as any).mockResolvedValue([{ id: 'b1', billNumber: 'PH-1' }]);

      const r = await getReturnableDispenses(TENANT_ID, { patientId: 'p1' });
      expect(r.items[0].remaining).toBe(7); // 10 dispensed − 3 already returned
    });
  });

  // ── G13: ward stock ───────────────────────────────────────
  describe('transferToWard (G13)', () => {
    it('moves stock from central pharmacy into ward stock + ledger', async () => {
      (prisma.ward.findFirst as any).mockResolvedValue({ id: 'ward-1' });
      const tx = txWith();
      tx.drugBatch.findFirst.mockResolvedValue({ id: 'batch-1', tenantId: TENANT_ID, drugId: 'd1', quantityInStock: 100, isRecalled: false, isExpired: false, expiryDate: new Date('2027-01-01') });
      tx.wardStock.findFirst.mockResolvedValue(null);
      tx.wardStock.create.mockResolvedValue({ id: 'ws-1', quantityInStock: 30 });

      const r = await transferToWard(TENANT_ID, USER_ID, ADMIN_ROLES, { wardId: 'ward-1', drugBatchId: 'batch-1', quantity: 30 });
      expect(r.quantityInStock).toBe(30);
      expect(tx.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { quantityInStock: { decrement: 30 } } });
      expect(tx.wardStockLedger.create).toHaveBeenCalled();
    });

    it('rejects when central stock is insufficient', async () => {
      (prisma.ward.findFirst as any).mockResolvedValue({ id: 'ward-1' });
      const tx = txWith();
      tx.drugBatch.findFirst.mockResolvedValue({ id: 'batch-1', tenantId: TENANT_ID, drugId: 'd1', quantityInStock: 5, isRecalled: false, isExpired: false, expiryDate: new Date('2027-01-01') });
      await expect(transferToWard(TENANT_ID, USER_ID, ADMIN_ROLES, { wardId: 'ward-1', drugBatchId: 'batch-1', quantity: 30 }))
        .rejects.toThrow('Insufficient central stock');
    });
  });

  describe('getWardStock (G13)', () => {
    it('returns on-hand ward rows with drug + batch detail', async () => {
      // getWardStock reads ward rows, then resolves batch detail in a 2nd query.
      (prisma.wardStock.findMany as any).mockResolvedValue([
        { id: 'ws-1', drugId: 'd1', drugBatchId: 'b1', quantityInStock: 12 },
      ]);
      (prisma.drugBatch.findMany as any).mockResolvedValue([
        { id: 'b1', batchNumber: 'BN1', expiryDate: new Date('2027-01-01'), sellingPrice: 9, drug: { id: 'd1', drugName: 'Amox', looseUnitLabel: 'Tablet' } },
      ]);
      const r = await getWardStock(TENANT_ID, 'ward-1');
      expect(r.items[0]).toMatchObject({ drugName: 'Amox', batchNumber: 'BN1', quantityInStock: 12, sellingPrice: 9 });
    });
  });

  describe('dispenseFromWard (G13 + credit gate)', () => {
    it('blocks a cash patient over deposit without clearance', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws-1', quantityInStock: 100 });
      tx.drugBatch.findUnique.mockResolvedValue({ id: 'b1', batchNumber: 'BN1', sellingPrice: 10, drug: { drugName: 'Amox', price: 10, taxPercent: 12, isLifeSaving: false } });
      // credit gate reads top-level prisma
      (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm', billingCategory: 'cash', depositAmount: 100 });
      (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 999, balanceDue: 999 } });

      await expect(dispenseFromWard(TENANT_ID, USER_ID, { wardId: 'ward-1', drugBatchId: 'b1', patientId: 'p1', quantity: 1 }))
        .rejects.toThrow('Credit Limit Exceeded');
    });

    it('allows a life-saving drug to bypass the credit gate', async () => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws-1', quantityInStock: 100 });
      tx.drugBatch.findUnique.mockResolvedValue({ id: 'b1', batchNumber: 'BN1', sellingPrice: 10, drug: { drugName: 'Adrenaline', price: 10, taxPercent: 12, isLifeSaving: true } });
      tx.bill.findFirst.mockResolvedValue({ id: 'bill-1', subtotal: 0, taxAmount: 0, totalAmount: 0, patientPayableAmount: 0, balanceDue: 0, status: 'draft' });
      tx.bill.update.mockResolvedValue({});
      tx.billItem.create.mockResolvedValue({});
      tx.wardStock.update.mockResolvedValue({});
      tx.wardStockLedger.create.mockResolvedValue({});

      const r = await dispenseFromWard(TENANT_ID, USER_ID, { wardId: 'ward-1', drugBatchId: 'b1', patientId: 'p1', quantity: 1 });
      expect(r.billId).toBe('bill-1');
      expect(tx.wardStock.update).toHaveBeenCalled();
    });
  });

  // ── G16: emergency pre-registration ───────────────────────
  describe('createEmergencyPatient (G16)', () => {
    it('mints a TEMP-ER MRN', async () => {
      (prisma.patient.count as any).mockResolvedValue(0);
      (prisma.patient.create as any).mockImplementation((args: any) => Promise.resolve({ id: 'p1', mrn: args.data.mrn, firstName: args.data.firstName, lastName: args.data.lastName }));

      const p = await createEmergencyPatient(TENANT_ID, USER_ID, {});
      expect(p.mrn).toMatch(/^TEMP-ER-\d{8}-001$/);
    });
  });

  // ── G1: merge duplicate formulary ─────────────────────────
  describe('mergeFormularyItems (G1)', () => {
    it('repoints batches/items/returns and deletes the source', async () => {
      (prisma.drugFormulary.findFirst as any)
        .mockResolvedValueOnce({ id: 'target', drugName: 'Telmac 40' })  // target
        .mockResolvedValueOnce({ id: 'source', drugName: 'Telmac 40 Tab' }); // source
      const tx = txWith();
      tx.drugBatch.updateMany.mockResolvedValue({ count: 2 });
      tx.prescriptionItem.updateMany.mockResolvedValue({ count: 1 });
      tx.drugReturn.updateMany.mockResolvedValue({ count: 0 });
      tx.drugFormulary.delete.mockResolvedValue({});

      const r = await mergeFormularyItems(TENANT_ID, USER_ID, ADMIN_ROLES, 'target', 'source');
      expect(r.batchesMoved).toBe(2);
      expect(r.prescriptionItemsMoved).toBe(1);
      expect(tx.drugFormulary.delete).toHaveBeenCalledWith({ where: { id: 'source' } });
    });

    it('refuses to merge a drug into itself', async () => {
      await expect(mergeFormularyItems(TENANT_ID, USER_ID, ADMIN_ROLES, 'x', 'x')).rejects.toThrow('into itself');
    });
  });

  // ── G15: reports ──────────────────────────────────────────
  describe('reports (G15)', () => {
    it('stock valuation totals purchase + selling value', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([
        { id: 'b1', batchNumber: 'BN1', quantityInStock: 10, purchasePrice: 8, sellingPrice: 12, expiryDate: new Date('2027-01-01'), drug: { id: 'd1', drugName: 'Amox' } },
      ]);
      const r = await getStockValuationReport(TENANT_ID);
      expect(r.totals.totalPurchaseValue).toBe(80);
      expect(r.totals.totalSellingValue).toBe(120);
      expect(r.totals.potentialMargin).toBe(40);
    });

    it('vendor-wise aggregates paid value + medicines and carries vendor metadata', async () => {
      const acme = { id: 's1', name: 'Acme', phone: '99999', email: 'a@acme', address: 'MG Rd', gstNumber: '29ABCDE1234F1Z5', licenseNumber: 'DL-21B/22B-001', supplyType: 'manufacturer' };
      (prisma.drugBatch.findMany as any).mockResolvedValue([
        { drugId: 'd1', supplierId: 's1', quantityReceived: 100, quantityInStock: 80, purchasePrice: 10, purchaseDiscountPercent: 0, supplier: acme },
        { drugId: 'd2', supplierId: 's1', quantityReceived: 50, quantityInStock: 50, purchasePrice: 20, purchaseDiscountPercent: 10, supplier: acme },
      ]);
      const r = await getVendorWiseReport(TENANT_ID);
      expect(r.items[0]).toMatchObject({ supplierId: 's1', supplierName: 'Acme', medicineCount: 2, batchCount: 2, gstNumber: '29ABCDE1234F1Z5', licenseNumber: 'DL-21B/22B-001' });
      expect(r.items[0].totalPaid).toBe(1900); // 100×10 + 50×20×0.9
      expect(r.vendor).toBeNull(); // no vendor selected
    });

    it('vendor-wise auto-populates the selected vendor metadata even with no purchases', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([]);
      (prisma.supplier.findFirst as any).mockResolvedValue({
        id: 's9', name: 'NewVendor', phone: '12345', email: 'n@v', address: 'Park St', gstNumber: '07PQRS9876K1Z2', licenseNumber: 'DL-9', supplyType: 'distributor', isActive: true,
      });
      const r = await getVendorWiseReport(TENANT_ID, 's9');
      expect(r.items).toHaveLength(0);
      expect(r.vendor).toMatchObject({ id: 's9', name: 'NewVendor', gstNumber: '07PQRS9876K1Z2', licenseNumber: 'DL-9' });
    });

    it('daily transaction report buckets collections by payment mode', async () => {
      (prisma.bill.findMany as any).mockResolvedValue([
        { id: 'b1', billNumber: 'PH-1', billDate: new Date(), totalAmount: 100, discountAmount: 0, taxAmount: 12, amountPaid: 100, status: 'paid',
          patient: { firstName: 'A', lastName: 'B', mrn: 'M1' },
          payments: [ { amount: 60, paymentMethod: 'cash', status: 'completed' }, { amount: 40, paymentMethod: 'upi', status: 'completed' } ] },
      ]);
      const r = await getDailyTransactionReport(TENANT_ID);
      expect(r.summary.billCount).toBe(1);
      expect(r.summary.collected).toBe(100);
      expect(r.summary.byPaymentMode).toMatchObject({ cash: 60, upi: 40 });
    });

    it('supplier credit-notes report totals the credited value', async () => {
      (prisma.drugReturn.findMany as any).mockResolvedValue([
        { id: 'r1', createdAt: new Date(), quantity: 5, status: 'processed', creditNoteNumber: 'CN-1', creditAmount: 250, reason: 'expired',
          supplier: { id: 's1', name: 'Acme' }, drugBatch: { batchNumber: 'BN1', drug: { drugName: 'Amox' } } },
      ]);
      const r = await getCreditNotesReport(TENANT_ID, {});
      expect(r.totals.noteCount).toBe(1);
      expect(r.totals.totalCredit).toBe(250);
      expect(r.items[0].creditNoteNumber).toBe('CN-1');
    });
  });

  // ── GRN gaps: increase-qty + price sanity ─────────────────
  describe('createBatch GRN gaps', () => {
    it('blocks a purchase rate above MRP', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID, drugName: 'Amox' });
      await expect(createBatch(TENANT_ID, USER_ID, ADMIN_ROLES, {
        drugId: 'd1', batchNumber: 'B1', expiryDate: '2027-12-31', quantityReceived: 10, mrp: 50, purchasePrice: 60,
      } as any)).rejects.toThrow('Purchase rate cannot exceed MRP');
    });

    it('folds quantity into the existing batch when addToExisting is set', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID, drugName: 'Amox' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', quantityInStock: 100, mrp: 50, purchasePrice: 30, sellingPrice: 45, freeQuantity: 0 });
      (prisma.drugBatch.update as any).mockResolvedValue({ id: 'batch-1', quantityInStock: 150 });

      const r = await createBatch(TENANT_ID, USER_ID, ADMIN_ROLES, {
        drugId: 'd1', batchNumber: 'B1', expiryDate: '2027-12-31', quantityReceived: 50, addToExisting: true,
      } as any);
      expect((r as any).quantityInStock).toBe(150);
      expect(prisma.drugBatch.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ quantityInStock: { increment: 50 }, quantityReceived: { increment: 50 } }),
      }));
    });

    it('still errors on a duplicate batch when addToExisting is not set', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID, drugName: 'Amox' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', quantityInStock: 100 });
      await expect(createBatch(TENANT_ID, USER_ID, ADMIN_ROLES, {
        drugId: 'd1', batchNumber: 'B1', expiryDate: '2027-12-31', quantityReceived: 50,
      } as any)).rejects.toThrow('already exists');
    });
  });
});
