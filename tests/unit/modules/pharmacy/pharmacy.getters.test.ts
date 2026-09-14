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
  recallBatch,
  unrecallBatch,
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

    // G6: the POS / dispensing picker must be FEFO (earliest expiry first).
    it('availableOnly orders FEFO — earliest expiry first', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([]);
      (prisma.drugBatch.count as any).mockResolvedValue(0);
      await getBatches(TENANT_ID, { page: 1, limit: 20, availableOnly: true } as any);
      const orderBy = (prisma.drugBatch.findMany as any).mock.calls[0][0].orderBy;
      expect(orderBy).toEqual([{ expiryDate: 'asc' }, { createdAt: 'asc' }]);
    });

    // The management list stays newest-received-first.
    it('default list orders by createdAt desc (management view)', async () => {
      (prisma.drugBatch.findMany as any).mockResolvedValue([]);
      (prisma.drugBatch.count as any).mockResolvedValue(0);
      await getBatches(TENANT_ID, { page: 1, limit: 20 } as any);
      const orderBy = (prisma.drugBatch.findMany as any).mock.calls[0][0].orderBy;
      expect(orderBy).toEqual({ createdAt: 'desc' });
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

    it('imports an OTC catalogue row as a retail product, not a medicine', async () => {
      (prisma.drugMaster.findUnique as any).mockResolvedValue({
        id: 'otc-1',
        isPublished: true,
        type: 'otc',
        name: 'Baby Lotion',
        productCategory: 'Baby Care',
        packSize: 1,
        packSizeLabel: '1 bottle',
        mrp: 120,
        scheduleResolved: null,
      });
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'product-1',
        ...data,
      }));

      const result = await importFormularyItem(TENANT_ID, ADMIN_ROLES, {
        drugMasterId: 'otc-1',
      } as any);

      expect(result.item).toMatchObject({
        category: 'product',
        productCategory: 'Baby Care',
      });
      expect(result.item.schedule).toBeUndefined();
      expect(prisma.drugMaster.findUnique).toHaveBeenCalledTimes(1);
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

    // A new catalogue release arrives unclassified and the deploy's pass takes
    // a while; a drug imported in that window must not reach the formulary
    // without the schedule the dispensing gate reads.
    it('labels an unclassified catalogue drug before copying it, so the copy inherits a schedule', async () => {
      const bare = { id: 'm1', isPublished: true, name: 'Tramazac 50 Capsule', genericName: 'Tramadol (50mg)', dosageForm: 'capsule', packSize: 10, packSizeLabel: 'strip of 10 capsules', mrp: 50, scheduleResolved: null };
      const labelled = { ...bare, scheduleResolved: 'H1', scheduleReason: 'matched Tramadol', controlledClass: 'psychotropic', vaultControlled: false, requiresQrScan: false };
      (prisma.drugMaster.findUnique as any).mockResolvedValueOnce(bare).mockResolvedValue(labelled);
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.create as any).mockImplementation(async ({ data }: any) => ({ id: 'd1', ...data }));

      const r = await importFormularyItem(TENANT_ID, ADMIN_ROLES, { drugMasterId: 'm1' } as any);

      // Without the labelling step the insert inherits nothing from a bare row.
      const data = (prisma.drugFormulary.create as any).mock.calls[0][0].data;
      expect(data).toMatchObject({ schedule: 'H1', scheduleSource: 'inherited', controlledClass: 'psychotropic' });
      expect(r.item).toMatchObject({ schedule: 'H1' });
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

    it('labels unclassified catalogue drugs first, so every copy carries a schedule', async () => {
      const bare = { id: 'm2', name: 'B', dosageForm: 'tablet', packSize: 10, packSizeLabel: '10', mrp: 20, scheduleResolved: null };
      (prisma.drugMaster.findMany as any)
        .mockResolvedValueOnce([bare]) // the pick
        .mockResolvedValueOnce([{ ...bare, scheduleResolved: 'H', scheduleReason: 'matched' }]); // after labelling
      (prisma.drugFormulary.findMany as any).mockResolvedValue([]);
      (prisma.drugFormulary.createMany as any).mockResolvedValue({ count: 1 });

      await importFormularyItemsBulk(TENANT_ID, ADMIN_ROLES, { drugMasterIds: ['m2'] });

      const rows = (prisma.drugFormulary.createMany as any).mock.calls[0][0].data;
      expect(rows[0]).toMatchObject({ drugMasterId: 'm2', schedule: 'H', scheduleSource: 'inherited' });
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
    // This used to take a `gstRate` off the query, default it to 12, and apply
    // that one rate to every dispense — ignoring the rate each line was
    // actually billed at. It now folds the same bill lines the hospital files
    // from, filtered to the pharmacy department, so a two-rate sale reports two
    // rates instead of one average.
    it('reports each line at the rate it was actually billed at', async () => {
      (prisma.bill.findMany as any).mockResolvedValue([
        {
          id: 'b1', billNumber: 'PH-1', invoiceNumber: 'TI/2026-27/000001',
          gstDocumentType: 'tax_invoice', billDate: new Date('2026-09-01T00:00:00Z'),
          status: 'paid', financialYear: '2026-27', admissionId: null,
          recipientGstin: null, placeOfSupplyStateCode: '27', isInterState: false,
          patient: null, generator: null,
          billItems: [
            {
              id: 'i1', description: 'Amox', category: 'pharmacy', quantity: 1,
              unitPrice: 112, discountAmount: 0, hsnSacCode: '3004',
              gstTreatment: 'taxable', taxPercent: 5, taxableValue: 106.67,
              cgstAmount: 2.67, sgstAmount: 2.66, igstAmount: 0, cessAmount: 0,
              taxAmount: 5.33, totalAmount: 112, rateSource: 'hsn_master',
              requiresTaxResolution: false,
            },
            {
              id: 'i2', description: 'Protein powder', category: 'pharmacy', quantity: 1,
              unitPrice: 118, discountAmount: 0, hsnSacCode: '21069099',
              gstTreatment: 'taxable', taxPercent: 18, taxableValue: 100,
              cgstAmount: 9, sgstAmount: 9, igstAmount: 0, cessAmount: 0,
              taxAmount: 18, totalAmount: 118, rateSource: 'hsn_master',
              requiresTaxResolution: false,
            },
          ],
        },
      ]);
      const r = await getGstReport(TENANT_ID, {} as any);
      expect(r.summary.totalSales).toBeCloseTo(230, 1);
      expect(r.summary.totalGst).toBeCloseTo(23.33, 1);
      // Two rates, kept apart — the old report would have flattened both to one.
      expect(r.byRate.map((x) => x.ratePercent).sort((a, b) => a - b)).toEqual([5, 18]);
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
