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

    it('rejects a non-pharmacy-admin caller', async () => {
      await expect(
        commitInward(TENANT_ID, USER_ID, ['pharmacist'], {
          lines: [{ action: 'create', drugName: 'X', batchNumber: 'B', expiryDate: '2030-01-01', quantityReceived: 1 }],
        } as any),
      ).rejects.toThrow(/pharmacy admin/i);
    });
  });
});
