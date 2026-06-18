import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  generateReorderDraftPOs,
  setDrugPurchaseOrderStatus,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN = ['pharmacy_admin'];

// A below-threshold drug for getReorderList (stock 2 ≤ minStock 10).
function lowDrug() {
  return {
    id: 'd1', drugName: 'Amox 500', strength: '500mg', manufacturer: 'M',
    minStock: 10, packSize: 1, drugBatches: [{ quantityInStock: 2 }],
  };
}

describe('Pharmacy — G9 draft purchase orders', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('generateReorderDraftPOs', () => {
    it('creates a draft PO grouped by the last-used supplier with a suggested qty', async () => {
      (prisma.drugFormulary.findMany as any).mockResolvedValue([lowDrug()]);
      // Used by getReorderList (supplier.name) AND generate (supplierId).
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ drugId: 'd1', supplierId: 's1', supplier: { name: 'Sup' } }]);
      (prisma.drugPurchaseOrderItem.findMany as any).mockResolvedValue([]); // nothing open yet
      (prisma.drugPurchaseOrder.create as any).mockResolvedValue({ id: 'po1', supplierId: 's1', items: [] });

      const res = await generateReorderDraftPOs(TENANT_ID, USER_ID, ADMIN);

      expect(res.created).toBe(1);
      expect(res.skipped).toBe(0);
      const data = (prisma.drugPurchaseOrder.create as any).mock.calls[0][0].data;
      expect(data.supplierId).toBe('s1');
      expect(data.status).toBe('draft');
      // suggestedQty = max(minStock*2 − stock, minStock) = max(18, 10) = 18.
      expect(data.items.create[0]).toMatchObject({ drugId: 'd1', quantityOrdered: 18 });
    });

    it('skips drugs already on an open PO (no duplicate drafts)', async () => {
      (prisma.drugFormulary.findMany as any).mockResolvedValue([lowDrug()]);
      (prisma.drugBatch.findMany as any).mockResolvedValue([{ drugId: 'd1', supplierId: 's1', supplier: { name: 'Sup' } }]);
      (prisma.drugPurchaseOrderItem.findMany as any).mockResolvedValue([{ drugId: 'd1' }]); // already ordered

      const res = await generateReorderDraftPOs(TENANT_ID, USER_ID, ADMIN);

      expect(res.created).toBe(0);
      expect(res.skipped).toBe(1);
      expect(prisma.drugPurchaseOrder.create).not.toHaveBeenCalled();
    });

    it('rejects a non-pharmacy-admin caller', async () => {
      await expect(generateReorderDraftPOs(TENANT_ID, USER_ID, ['pharmacist'])).rejects.toThrow(/pharmacy admin/i);
    });
  });

  describe('setDrugPurchaseOrderStatus', () => {
    it('moves a draft with a supplier to sent', async () => {
      (prisma.drugPurchaseOrder.findFirst as any).mockResolvedValue({ id: 'po1', tenantId: TENANT_ID, status: 'draft', supplierId: 's1' });
      (prisma.drugPurchaseOrder.update as any).mockResolvedValue({});

      await setDrugPurchaseOrderStatus(TENANT_ID, ADMIN, 'po1', 'sent');
      expect((prisma.drugPurchaseOrder.update as any).mock.calls[0][0].data.status).toBe('sent');
    });

    it('blocks an illegal transition', async () => {
      (prisma.drugPurchaseOrder.findFirst as any).mockResolvedValue({ id: 'po1', tenantId: TENANT_ID, status: 'draft', supplierId: 's1' });
      await expect(setDrugPurchaseOrderStatus(TENANT_ID, ADMIN, 'po1', 'received')).rejects.toThrow(/Cannot move/i);
    });

    it('refuses to send a PO with no supplier assigned', async () => {
      (prisma.drugPurchaseOrder.findFirst as any).mockResolvedValue({ id: 'po1', tenantId: TENANT_ID, status: 'draft', supplierId: null });
      await expect(setDrugPurchaseOrderStatus(TENANT_ID, ADMIN, 'po1', 'sent')).rejects.toThrow(/supplier/i);
    });
  });
});
