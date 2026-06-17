import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  getBatches,
  getExpiringBatches,
  getBatchById,
  updateBatch,
  getFormularyItemById,
  updateFormularyItem,
  deleteFormularyItem,
  importFormularyItem,
  importFormularyItemsBulk,
  getTenantCatalog,
  getDispenseRecords,
  verifyDispense,
  getReturns,
  getPharmacySales,
  cancelPharmacySale,
  listEmergencyPatients,
  recallBatch,
  unrecallBatch,
  recallDrug,
  getRecallAffectedPatients,
  getGstReport,
  getStockLedger,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];

function model() {
  return {
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn(),
  };
}
function txWith(overrides: Record<string, any> = {}) {
  const tx: any = {
    drugBatch: model(), drugFormulary: model(), drugReturn: model(), prescription: model(),
    dispensingRecord: model(), billItem: model(), payment: model(), bill: model(),
    ...overrides,
  };
  (prisma.$transaction as any).mockImplementation((arg: any) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(tx));
  return tx;
}

describe('Pharmacy — getters / CRUD / recalls coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Batches ───────────────────────────────────────────────
  describe('getBatches', () => {
    it('returns paginated batches', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ id: 'b1', batchNumber: 'BN1' }]);
      (prisma.drugBatch.count as any).mockResolvedValue(1);
      const r = await getBatches(TENANT_ID, { page: 1, limit: 20 } as any);
      expect(r.total).toBe(1);
      expect(r.batches).toHaveLength(1);
    });

    it('availableOnly filters to in-stock, non-expired, non-recalled', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([]);
      (prisma.drugBatch.count as any).mockResolvedValue(0);
      await getBatches(TENANT_ID, { page: 1, limit: 20, availableOnly: true } as any);
      const where = (prisma.drugBatch.findMany as any).mock.calls[0][0].where;
      expect(where).toMatchObject({ isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } });
    });
  });

  describe('getExpiringBatches', () => {
    it('queries within a future expiry window and returns batches', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ id: 'b1', expiryDate: new Date() }]);
      (prisma.drugBatch.count as any).mockResolvedValue(1);
      const r = await getExpiringBatches(TENANT_ID, { page: 1, limit: 20, days: 60 } as any);
      expect(r.total).toBe(1);
      const where = (prisma.drugBatch.findMany as any).mock.calls[0][0].where;
      expect(where.expiryDate.lte).toBeInstanceOf(Date);
      expect(where.quantityInStock).toEqual({ gt: 0 });
    });
  });

  describe('getBatchById', () => {
    it('returns the batch with derived economics', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'b1', batchNumber: 'BN1', purchasePrice: 10, quantityReceived: 100, drug: {}, supplier: null,
      });
      const r = await getBatchById(TENANT_ID, 'b1');
      expect(r.id).toBe('b1');
      expect(r.economics).toBeDefined();
    });

    it('throws when missing', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      await expect(getBatchById(TENANT_ID, 'x')).rejects.toThrow('Drug batch not found');
    });
  });

  describe('updateBatch', () => {
    it('persists invoice metadata + selling price (admin only)', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID });
      (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', invoiceNumber: 'INV-9' });
      await updateBatch(TENANT_ID, ADMIN_ROLES, 'b1', { invoiceNumber: 'INV-9', sellingPrice: 12 } as any);
      const data = (prisma.drugBatch.update as any).mock.calls[0][0].data;
      expect(data.invoiceNumber).toBe('INV-9');
      expect(data.sellingPrice).toBe(12);
    });

    it('rejects a non-admin', async () => {
      await expect(updateBatch(TENANT_ID, ['pharmacist'], 'b1', {} as any)).rejects.toThrow(/pharmacy admin/i);
    });
  });

  // ── Formulary getters / CRUD ──────────────────────────────
  describe('getFormularyItemById', () => {
    it('throws when not found', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      await expect(getFormularyItemById(TENANT_ID, 'x')).rejects.toThrow('Formulary item not found');
    });
  });

  describe('updateFormularyItem', () => {
    it('updates fields for an admin', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID });
      (prisma.drugFormulary.update as any).mockResolvedValue({ id: 'd1', drugName: 'New' });
      const r = await updateFormularyItem(TENANT_ID, ADMIN_ROLES, 'd1', { drugName: 'New' } as any);
      expect(r.drugName).toBe('New');
    });

    it('rejects a non-admin', async () => {
      await expect(updateFormularyItem(TENANT_ID, ['pharmacist'], 'd1', {} as any)).rejects.toThrow(/pharmacy admin/i);
    });
  });

  describe('deleteFormularyItem', () => {
    it('blocks deletion when batches are linked', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID });
      (prisma.drugBatch.count as any).mockResolvedValue(3);
      await expect(deleteFormularyItem(TENANT_ID, 'd1')).rejects.toThrow('3 batch(es) are linked');
    });

    it('deletes when nothing is linked', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID });
      (prisma.drugBatch.count as any).mockResolvedValue(0);
      (prisma.drugFormulary.delete as any).mockResolvedValue({});
      await deleteFormularyItem(TENANT_ID, 'd1');
      expect(prisma.drugFormulary.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
    });
  });

  // ── Catalog import ────────────────────────────────────────
  describe('importFormularyItem', () => {
    it('imports a published catalog drug into the tenant formulary', async () => {
      (prisma.drugMaster.findUnique as any).mockResolvedValue({ id: 'm1', isPublished: true, name: 'Amox', genericName: 'Amoxicillin', manufacturer: 'X', dosageForm: 'tablet', strength: '500mg', packSize: 10, packSizeLabel: '10 tablets', mrp: 30 });
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.create as any).mockResolvedValue({ id: 'd1', drugName: 'Amox' });
      const r = await importFormularyItem(TENANT_ID, ADMIN_ROLES, { drugMasterId: 'm1' } as any);
      expect(r.status).toBe('created');
      expect(r.item.id).toBe('d1');
    });

    it('is idempotent — returns already_imported when present', async () => {
      (prisma.drugMaster.findUnique as any).mockResolvedValue({ id: 'm1', isPublished: true, name: 'Amox' });
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugMasterId: 'm1', category: null });
      const r = await importFormularyItem(TENANT_ID, ADMIN_ROLES, { drugMasterId: 'm1' } as any);
      expect(r.status).toBe('already_imported');
      expect(prisma.drugFormulary.create).not.toHaveBeenCalled();
    });

    it('rejects an unpublished catalog drug', async () => {
      (prisma.drugMaster.findUnique as any).mockResolvedValue({ id: 'm1', isPublished: false });
      await expect(importFormularyItem(TENANT_ID, ADMIN_ROLES, { drugMasterId: 'm1' } as any)).rejects.toThrow('not published');
    });
  });

  describe('importFormularyItemsBulk', () => {
    it('creates only the not-yet-imported drugs and reports counts', async () => {
      (prisma.drugMaster.findMany as any).mockResolvedValue([
        { id: 'm1', name: 'A', dosageForm: 'tablet', packSize: 10, packSizeLabel: '10', mrp: 10 },
        { id: 'm2', name: 'B', dosageForm: 'tablet', packSize: 10, packSizeLabel: '10', mrp: 20 },
      ]);
      (prisma.drugFormulary.findMany as any).mockResolvedValue([{ drugMasterId: 'm1' }]); // m1 already imported
      (prisma.drugFormulary.createMany as any).mockResolvedValue({ count: 1 });

      const r = await importFormularyItemsBulk(TENANT_ID, ADMIN_ROLES, { drugMasterIds: ['m1', 'm2'] });
      expect(r.requested).toBe(2);
      expect(r.created).toBe(1);
      expect(r.skipped).toBe(1);
    });
  });

  describe('getTenantCatalog', () => {
    it('flags which catalog rows are already imported', async () => {
      (prisma.drugMaster.findMany as any).mockResolvedValue([{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }]);
      (prisma.drugMaster.count as any).mockResolvedValue(2);
      (prisma.drugFormulary.findMany as any).mockResolvedValue([{ id: 'd1', drugMasterId: 'm1' }]);
      const r = await getTenantCatalog(TENANT_ID, { page: 1, limit: 20 });
      const m1 = r.items.find((i: any) => i.id === 'm1');
      const m2 = r.items.find((i: any) => i.id === 'm2');
      expect(m1.imported).toBe(true);
      expect(m2.imported).toBe(false);
    });
  });

  // ── Dispensing ────────────────────────────────────────────
  describe('getDispenseRecords', () => {
    it('returns paginated dispensing records', async () => {
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([{ id: 'dr1' }]);
      (prisma.dispensingRecord.count as any).mockResolvedValue(1);
      const r = await getDispenseRecords(TENANT_ID, { page: 1, limit: 20 } as any);
      expect(r.records).toHaveLength(1);
      expect(r.total).toBe(1);
    });
  });

  describe('verifyDispense', () => {
    it('verifies a record by a different user', async () => {
      (prisma.dispensingRecord.findFirst as any).mockResolvedValue({ id: 'dr1', tenantId: TENANT_ID, dispensedBy: 'u2', verifiedBy: null });
      (prisma.dispensingRecord.update as any).mockResolvedValue({ id: 'dr1', verifiedBy: USER_ID });
      const r = await verifyDispense(TENANT_ID, 'dr1', USER_ID);
      expect(r.verifiedBy).toBe(USER_ID);
    });

    it('rejects re-verifying an already verified record', async () => {
      (prisma.dispensingRecord.findFirst as any).mockResolvedValue({ id: 'dr1', tenantId: TENANT_ID, dispensedBy: 'u2', verifiedBy: 'u3' });
      await expect(verifyDispense(TENANT_ID, 'dr1', USER_ID)).rejects.toThrow('already been verified');
    });
  });

  // ── Returns list ──────────────────────────────────────────
  describe('getReturns', () => {
    it('returns paginated returns', async () => {
      (prisma.drugReturn.findMany as any).mockResolvedValue([{ id: 'r1' }]);
      (prisma.drugReturn.count as any).mockResolvedValue(1);
      const r = await getReturns(TENANT_ID, { page: 1, limit: 20 } as any);
      expect(r.returns).toHaveLength(1);
      expect(r.total).toBe(1);
    });
  });

  // ── Counter sale list + void ──────────────────────────────
  describe('getPharmacySales', () => {
    it('lists PH- invoices with a period summary', async () => {
      (prisma.bill.findMany as any).mockResolvedValue([{ id: 'bill-1', billNumber: 'PH-1' }]);
      (prisma.bill.count as any).mockResolvedValue(1);
      (prisma.bill.aggregate as any).mockResolvedValue({ _sum: { totalAmount: 500, amountPaid: 500 }, _count: 1 });
      const r = await getPharmacySales(TENANT_ID, { page: 1, limit: 20 } as any);
      expect(r.bills).toHaveLength(1);
      expect(r.summary.totalAmount).toBe(500);
    });
  });

  describe('cancelPharmacySale', () => {
    it('restores stock, reverses payment and marks the bill cancelled', async () => {
      (prisma.bill.findFirst as any)
        .mockResolvedValueOnce({ id: 'bill-1', status: 'paid' }) // guard read
        .mockResolvedValueOnce({ id: 'bill-1', billItems: [], payments: [], patient: {} }); // getPharmacySale re-fetch
      (prisma.drugReturn.count as any).mockResolvedValue(0);
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([{ id: 'dr1', drugBatchId: 'b1', quantityDispensed: 2, prescriptionId: null }]);
      (prisma.tenant.findUnique as any).mockResolvedValue({ name: 'H' });
      const tx = txWith();

      await cancelPharmacySale(TENANT_ID, USER_ID, 'bill-1', { reason: 'entered in error' } as any);
      expect(tx.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { increment: 2 } } });
      expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'reversed' } }));
      expect(tx.bill.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }));
    });

    it('blocks a void when returns are recorded against the bill', async () => {
      (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-1', status: 'paid' });
      (prisma.drugReturn.count as any).mockResolvedValue(1);
      await expect(cancelPharmacySale(TENANT_ID, USER_ID, 'bill-1', { reason: 'x' } as any)).rejects.toThrow('returns recorded');
    });
  });

  // ── Emergency list ────────────────────────────────────────
  describe('listEmergencyPatients (G16)', () => {
    it('lists temp patients with their unpaid pharmacy hold', async () => {
      (prisma.patient.findMany as any).mockResolvedValue([{ id: 'p1', mrn: 'TEMP-ER-1', firstName: 'E', lastName: 'P', phone: null, createdAt: new Date() }]);
      (prisma.bill.groupBy as any).mockResolvedValue([{ patientId: 'p1', _sum: { totalAmount: 300, balanceDue: 300 }, _count: { _all: 2 } }]);
      const r = await listEmergencyPatients(TENANT_ID);
      expect(r.items[0]).toMatchObject({ id: 'p1', billCount: 2, heldAmount: 300, balanceDue: 300 });
    });
  });

  // ── Recalls ───────────────────────────────────────────────
  describe('recalls', () => {
    it('recallBatch flags the batch + notifies', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID });
      (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', batchNumber: 'BN1', isRecalled: true, drug: { drugName: 'Amox' } });
      (prisma.user.findMany as any).mockResolvedValue([]);
      const r = await recallBatch(TENANT_ID, 'b1', USER_ID, { recallReason: 'contamination' } as any);
      expect(r.isRecalled).toBe(true);
    });

    it('unrecallBatch refuses when the batch is not recalled', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID, isRecalled: false });
      await expect(unrecallBatch(TENANT_ID, 'b1')).rejects.toThrow('not recalled');
    });

    it('recallDrug cascades to all batches', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', tenantId: TENANT_ID });
      (prisma.$transaction as any).mockResolvedValue([{}, {}]);
      const r = await recallDrug(TENANT_ID, 'd1', USER_ID, { recallReason: 'defect' } as any);
      expect(r.batchesRecalled).toBe(true);
    });

    it('getRecallAffectedPatients lists who received a recalled batch', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID, drug: { id: 'd1', drugName: 'Amox' } });
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([
        { id: 'dr1', quantityDispensed: 2, dispensedAt: new Date(), patient: { id: 'p1', mrn: 'M1', firstName: 'A', lastName: 'B' }, prescription: null },
      ]);
      const r: any = await getRecallAffectedPatients(TENANT_ID, 'b1');
      const list = r.patients ?? r.affectedPatients ?? r.records ?? r.items;
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(1);
    });
  });

  // ── GST + stock ledger ────────────────────────────────────
  describe('getGstReport', () => {
    it('reverse-calculates taxable + GST from inclusive selling price', async () => {
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([
        { quantityDispensed: 1, drugBatch: { sellingPrice: 112, drug: { id: 'd1', drugName: 'Amox', category: { id: 'c1', name: 'Antibiotic' } } } },
      ]);
      const r = await getGstReport(TENANT_ID, { gstRate: 12 } as any);
      // 112 inclusive @ 12% → taxable 100, GST 12
      expect(r.summary.taxableValue).toBeCloseTo(100, 0);
      expect(r.summary.totalGst).toBeCloseTo(12, 0);
    });
  });

  describe('getStockLedger', () => {
    it('records a receipt entry for a received batch', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([
        { id: 'b1', createdAt: new Date(), batchNumber: 'BN1', quantityReceived: 100, drug: { id: 'd1', drugName: 'Amox' }, supplier: { name: 'Acme' } },
      ]);
      (prisma.dispensingRecord.findMany as any).mockResolvedValue([]);
      (prisma.drugReturn.findMany as any).mockResolvedValue([]);
      (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityInStock: 100 } });
      const r: any = await getStockLedger(TENANT_ID, {} as any);
      const entries = r.entries ?? r.items ?? r.ledger;
      const receipt = entries.find((e: any) => e.movementType === 'receipt');
      expect(receipt).toBeDefined();
      expect(receipt.quantityIn).toBe(100);
    });
  });
});
