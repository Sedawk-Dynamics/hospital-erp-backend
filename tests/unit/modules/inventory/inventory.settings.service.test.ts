import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  getInventorySettings,
  getInventorySettingsSafe,
  updateInventorySettings,
} from '../../../../src/modules/inventory/inventory.settings.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

describe('Inventory Settings Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getInventorySettings', () => {
    it('returns the existing settings row when present', async () => {
      const existing = { id: 'is-1', tenantId: TENANT_ID, defaultLowStockThreshold: 25 };
      (prisma.inventorySetting.findUnique as any).mockResolvedValue(existing);

      const result = await getInventorySettings(TENANT_ID);

      expect(result).toEqual(existing);
      expect(prisma.inventorySetting.upsert).not.toHaveBeenCalled();
    });

    it('lazily creates a default row when none exists', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue(null);
      const created = { id: 'is-1', tenantId: TENANT_ID, defaultLowStockThreshold: 10 };
      (prisma.inventorySetting.upsert as any).mockResolvedValue(created);

      const result = await getInventorySettings(TENANT_ID);

      expect(prisma.inventorySetting.upsert).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID },
        create: { tenantId: TENANT_ID },
        update: {},
      });
      expect(result).toEqual(created);
    });
  });

  describe('getInventorySettingsSafe', () => {
    it('falls back to defaults when the lookup throws', async () => {
      (prisma.inventorySetting.findUnique as any).mockRejectedValue(new Error('db down'));

      const result = await getInventorySettingsSafe(TENANT_ID);

      expect(result.defaultLowStockThreshold).toBe(10);
      expect(result.preventExpiredUse).toBe(true);
      expect(result.expiryAlertMonths).toBe(3);
    });

    it('falls back to defaults when the row resolves to null', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue(null);
      (prisma.inventorySetting.upsert as any).mockResolvedValue(null);

      const result = await getInventorySettingsSafe(TENANT_ID);

      expect(result.id).toBe('default');
      expect(result.lowStockAlertEnabled).toBe(true);
    });
  });

  describe('updateInventorySettings', () => {
    it('normalises recipient role slugs (lowercase, snake_case, deduped)', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1',
        tenantId: TENANT_ID,
        alertRecipientRoles: [],
      });
      (prisma.inventorySetting.update as any).mockImplementation(({ data }: any) => ({
        id: 'is-1',
        tenantId: TENANT_ID,
        ...data,
      }));

      const result = await updateInventorySettings(TENANT_ID, USER_ID, {
        defaultLowStockThreshold: 20,
        alertRecipientRoles: ['Pharmacy Admin', 'admin', 'admin', 'Inventory-Manager'],
      });

      const updateArg = (prisma.inventorySetting.update as any).mock.calls[0][0];
      expect(updateArg.where).toEqual({ tenantId: TENANT_ID });
      expect(updateArg.data.defaultLowStockThreshold).toBe(20);
      expect(updateArg.data.alertRecipientRoles).toEqual([
        'pharmacy_admin',
        'admin',
        'inventory_manager',
      ]);
      expect(result.defaultLowStockThreshold).toBe(20);
      // An audit entry is written for the config change.
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('only writes the fields that were provided', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1',
        tenantId: TENANT_ID,
        alertRecipientRoles: [],
      });
      (prisma.inventorySetting.update as any).mockResolvedValue({ id: 'is-1', tenantId: TENANT_ID });

      await updateInventorySettings(TENANT_ID, USER_ID, { preventExpiredUse: false });

      const updateArg = (prisma.inventorySetting.update as any).mock.calls[0][0];
      expect(updateArg.data).toEqual({ preventExpiredUse: false });
    });
  });
});
