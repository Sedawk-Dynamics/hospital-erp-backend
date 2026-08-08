import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  matchInwardLines,
  commitInward,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];

// A formulary candidate as findFormularyMatches selects it (incl. live batches).
function candidate(over: Record<string, any> = {}) {
  return {
    id: 'drug-existing',
    drugName: 'Telmac 40',
    genericName: 'Telmisartan',
    manufacturer: 'Aristo',
    dosageForm: 'tablet',
    strength: '40mg',
    packSize: 10,
    price: 5,
    drugMasterId: null,
    drugBatches: [{ quantityInStock: 100 }],
    ...over,
  };
}

describe('Pharmacy — G1 bulk stock inward (CSV / OCR / manual)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── matchInwardLines — score + recommend per line ──
  describe('matchInwardLines', () => {
    it('recommends MAP for a near-duplicate name (Telmac 40 Tab → Telmac 40)', async () => {
      (prisma.drugFormulary.findMany as any).mockResolvedValue([candidate()]);

      const { lines } = await matchInwardLines(TENANT_ID, [{ drugName: 'Telmac 40 Tab' }]);

      expect(lines).toHaveLength(1);
      expect(lines[0].recommendation).toBe('map');
      expect(lines[0].suggestedFormularyId).toBe('drug-existing');
      // The candidate (with its stock rollup) rides along for the side-by-side view.
      expect(lines[0].matches[0].totalStock).toBe(100);
    });

    it('recommends CREATE when nothing in the formulary looks similar', async () => {
      (prisma.drugFormulary.findMany as any).mockResolvedValue([]);

      const { lines } = await matchInwardLines(TENANT_ID, [{ drugName: 'Zynovia XR 500' }]);

      expect(lines[0].recommendation).toBe('create');
      expect(lines[0].suggestedFormularyId).toBeNull();
      expect(lines[0].matches).toHaveLength(0);
    });

    it('scores each line independently and preserves order', async () => {
      (prisma.drugFormulary.findMany as any)
        .mockResolvedValueOnce([candidate()]) // line 0 → match
        .mockResolvedValueOnce([]); // line 1 → no match

      const { lines } = await matchInwardLines(TENANT_ID, [
        { drugName: 'Telmac 40 Tab' },
        { drugName: 'Brand New Drug 5' },
      ]);

      expect(lines[0].index).toBe(0);
      expect(lines[0].recommendation).toBe('map');
      expect(lines[1].index).toBe(1);
      expect(lines[1].recommendation).toBe('create');
    });
  });

  // ── commitInward — apply the reviewed decisions ──
  describe('commitInward', () => {
    it('MAP line adds stock to the existing drug without creating a new row', async () => {
      // Target lookup (commitInward) + drug existence check (createBatch) share the mock.
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({
        id: 'drug-existing',
        drugName: 'Telmac 40',
      });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null); // no clashing batch
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-1' });

      const res = await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        invoiceNumber: 'INV-9',
        lines: [
          {
            action: 'map',
            targetFormularyId: 'drug-existing',
            drugName: 'Telmac 40 Tab',
            batchNumber: 'B1',
            expiryDate: '2030-12-31',
            quantityReceived: 100,
          },
        ],
      } as any);

      expect(prisma.drugFormulary.create).not.toHaveBeenCalled();
      expect(res.mappedDrugs).toBe(1);
      expect(res.createdDrugs).toBe(0);
      expect(res.batchesIn).toBe(1);
      expect(res.failed).toBe(0);
      expect(res.results[0]).toMatchObject({ status: 'ok', action: 'map', formularyId: 'drug-existing' });
      // Header invoice number flows onto the batch.
      expect((prisma.drugBatch.create as any).mock.calls[0][0].data.invoiceNumber).toBe('INV-9');
    });

    it('CREATE line mints a new formulary row then receives its batch', async () => {
      // createFormularyItem(force) → create; createBatch → drug exists, batch created.
      (prisma.drugFormulary.create as any).mockResolvedValue({ id: 'drug-new', drugName: 'Zynovia XR 500' });
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-new', drugName: 'Zynovia XR 500' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-2' });

      const res = await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        lines: [
          {
            action: 'create',
            drugName: 'Zynovia XR 500',
            batchNumber: 'B2',
            expiryDate: '2030-12-31',
            quantityReceived: 50,
            sellingPrice: 12,
          },
        ],
      } as any);

      expect(prisma.drugFormulary.create).toHaveBeenCalledTimes(1);
      expect(res.createdDrugs).toBe(1);
      expect(res.batchesIn).toBe(1);
      expect(res.results[0]).toMatchObject({ status: 'ok', action: 'create', formularyId: 'drug-new' });
    });

    it('carries the composition onto a product created at inward', async () => {
      // The salt is typed on the review row for an unmapped "add as new" line —
      // it is the only chance to capture it. commitInward used to drop it, so a
      // product born here had an empty composition forever. That also broke the
      // NEXT delivery: composition is one of the fields the matcher scores, so
      // the same drug arriving again would not resolve to this row.
      (prisma.drugFormulary.create as any).mockResolvedValue({ id: 'drug-new', drugName: 'Zynovia XR 500' });
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-new', drugName: 'Zynovia XR 500' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-3' });
      (prisma.$executeRaw as any).mockClear?.();

      await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        lines: [
          {
            action: 'create',
            drugName: 'Zynovia XR 500',
            composition: 'Metformin Hydrochloride 500mg',
            strength: '500mg',
            batchNumber: 'B3',
            expiryDate: '2030-12-31',
            quantityReceived: 10,
          },
        ],
      } as any);

      // composition is a raw-SQL column, so it is written outside the create().
      const wroteComposition = ((prisma.$executeRaw as any).mock?.calls ?? []).some(
        (call: unknown[]) => call.slice(1).includes('Metformin Hydrochloride 500mg'),
      );
      expect(wroteComposition, 'composition should be stored on the new row').toBe(true);
      // strength goes through the ordinary create()
      expect((prisma.drugFormulary.create as any).mock.calls[0][0].data).toMatchObject({
        strength: '500mg',
      });
    });

    it('records a per-line error and keeps posting the remaining lines', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-existing', drugName: 'Telmac 40' });
      // First line: clashing batch number with no addToExisting → createBatch throws.
      // Second line: clean → posts.
      (prisma.drugBatch.findFirst as any)
        .mockResolvedValueOnce({ id: 'old-batch' })
        .mockResolvedValueOnce(null);
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-ok' });

      const res = await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        lines: [
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'Telmac 40 Tab', batchNumber: 'DUP', expiryDate: '2030-12-31', quantityReceived: 10 },
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'Telmac 40 Tab', batchNumber: 'CLEAN', expiryDate: '2030-12-31', quantityReceived: 10 },
        ],
      } as any);

      expect(res.total).toBe(2);
      expect(res.failed).toBe(1);
      expect(res.batchesIn).toBe(1);
      expect(res.results[0].status).toBe('error');
      expect(res.results[0].message).toMatch(/already exists/i);
      expect(res.results[1].status).toBe('ok');
    });

    it('G2: folds a total-bill purchase discount into each line + reports net', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-existing', drugName: 'Telmac 40' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-x' });

      const res = await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        invoiceDiscountPercent: 10, // whole-invoice discount on top of line discounts
        lines: [
          // gross 1000, 10% line → net 900
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'A', batchNumber: 'A1', expiryDate: '2030-12-31', quantityReceived: 10, purchasePrice: 100, purchaseDiscountPercent: 10 },
          // gross 500, no line discount → net 500
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'B', batchNumber: 'B1', expiryDate: '2030-12-31', quantityReceived: 10, purchasePrice: 50 },
        ],
      } as any);

      // Line 1: 10% line ∘ 10% bill = 19% effective; Line 2: 0% ∘ 10% = 10%.
      const calls = (prisma.drugBatch.create as any).mock.calls;
      expect(calls[0][0].data.purchaseDiscountPercent).toBe(19);
      expect(calls[1][0].data.purchaseDiscountPercent).toBe(10);
      // MRP / gross rate are untouched — only the discount carries the bill cut.
      expect(calls[0][0].data.purchasePrice).toBe(100);

      expect(res.purchaseSummary).toMatchObject({
        grossValue: 1500,
        lineDiscount: 100, // 1500 gross − 1400 after line discounts
        invoiceDiscountPercent: 10,
        invoiceDiscount: 140, // 10% of the 1400 net
        netValue: 1260,
      });
    });

    it('G2: a flat invoice discount amount converts to the same net', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-existing', drugName: 'Telmac 40' });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
      (prisma.drugBatch.create as any).mockResolvedValue({ id: 'batch-x' });

      const res = await commitInward(TENANT_ID, USER_ID, ADMIN_ROLES, {
        invoiceDiscountAmount: 140, // ₹140 off the 1400 net == 10%
        lines: [
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'A', batchNumber: 'A1', expiryDate: '2030-12-31', quantityReceived: 10, purchasePrice: 100, purchaseDiscountPercent: 10 },
          { action: 'map', targetFormularyId: 'drug-existing', drugName: 'B', batchNumber: 'B1', expiryDate: '2030-12-31', quantityReceived: 10, purchasePrice: 50 },
        ],
      } as any);

      expect(res.purchaseSummary.invoiceDiscountPercent).toBe(10);
      expect(res.purchaseSummary.netValue).toBe(1260);
    });

    it('rejects a non-pharmacy-admin caller', async () => {
      await expect(
        commitInward(TENANT_ID, USER_ID, ['pharmacist'], {
          lines: [{ action: 'create', drugName: 'X', batchNumber: 'B', expiryDate: '2030-01-01', quantityReceived: 1 }],
        } as any),
      ).rejects.toThrow(/pharmacy admin/i);
    });
  });
});
