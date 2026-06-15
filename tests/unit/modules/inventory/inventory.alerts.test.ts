import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

// Mock the notify layer so we can assert dispatches without touching the
// notification table machinery.
vi.mock('../../../../src/modules/inventory/inventory.notify', () => ({
  notifyInventoryRecipients: vi.fn().mockResolvedValue(1),
  hasOpenInventoryAlert: vi.fn().mockResolvedValue(false),
  getAlertRecipientUserIds: vi.fn().mockResolvedValue(['u1', 'u2']),
  DEFAULT_ALERT_RECIPIENT_ROLES: ['inventory_manager', 'pharmacy_admin', 'admin'],
}));

import {
  createStockTransaction,
  cancelPurchaseOrder,
  runInventoryAlerts,
} from '../../../../src/modules/inventory/inventory.service';
import {
  notifyInventoryRecipients,
  hasOpenInventoryAlert,
} from '../../../../src/modules/inventory/inventory.notify';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function mockTransaction() {
  const txMock = {
    stockTransaction: { create: vi.fn().mockResolvedValue({ id: 'tx-1', inventoryItem: {} }) },
    inventoryItem: { update: vi.fn().mockResolvedValue({}) },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(txMock));
  return txMock;
}

describe('Inventory alerts & guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (hasOpenInventoryAlert as any).mockResolvedValue(false);
    (notifyInventoryRecipients as any).mockResolvedValue(1);
  });

  // ── Prevent use of expired stock ──────────────────────────
  describe('createStockTransaction — expired-batch guard', () => {
    it('blocks a stock-out of an expired batch when the guard is on', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID, preventExpiredUse: true,
        lowStockAlertEnabled: true, reorderNotifyEnabled: true,
      });
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1', tenantId: TENANT_ID, currentStock: 50, minimumStockThreshold: 10,
      });
      const past = new Date();
      past.setFullYear(past.getFullYear() - 1);
      (prisma.stockTransaction.findFirst as any).mockResolvedValue({ expiryDate: past });

      await expect(
        createStockTransaction(TENANT_ID, USER_ID, {
          inventoryItemId: 'item-1', transactionType: 'stock_out', quantity: 5, batchNumber: 'B1',
        } as any),
      ).rejects.toThrow(/expired/i);
    });

    it('allows the stock-out when the guard is disabled', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID, preventExpiredUse: false,
        lowStockAlertEnabled: false, reorderNotifyEnabled: false,
      });
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1', tenantId: TENANT_ID, currentStock: 50, minimumStockThreshold: 10,
      });
      mockTransaction();

      await expect(
        createStockTransaction(TENANT_ID, USER_ID, {
          inventoryItemId: 'item-1', transactionType: 'stock_out', quantity: 5, batchNumber: 'B1',
        } as any),
      ).resolves.toBeDefined();
      // Guard disabled → no batch expiry lookup needed.
      expect(prisma.stockTransaction.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Reorder alert on threshold crossing ───────────────────
  describe('createStockTransaction — low-stock crossing alert', () => {
    it('fires a reorder alert when a stock-out crosses the threshold', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID, preventExpiredUse: false,
        lowStockAlertEnabled: true, reorderNotifyEnabled: true, alertRecipientRoles: [],
      });
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1', tenantId: TENANT_ID, currentStock: 12, minimumStockThreshold: 10,
        itemName: 'Gloves', itemCode: 'G1', unitOfMeasurement: 'box',
      });
      mockTransaction();

      await createStockTransaction(TENANT_ID, USER_ID, {
        inventoryItemId: 'item-1', transactionType: 'stock_out', quantity: 5,
      } as any);

      expect(notifyInventoryRecipients).toHaveBeenCalledTimes(1);
      const arg = (notifyInventoryRecipients as any).mock.calls[0][0];
      expect(arg.referenceType).toBe('inventory_low_stock');
      expect(arg.referenceId).toBe('item-1');
    });

    it('does not alert when the item was already below threshold', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID, preventExpiredUse: false,
        lowStockAlertEnabled: true, reorderNotifyEnabled: true, alertRecipientRoles: [],
      });
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1', tenantId: TENANT_ID, currentStock: 8, minimumStockThreshold: 10,
        itemName: 'Gloves',
      });
      mockTransaction();

      await createStockTransaction(TENANT_ID, USER_ID, {
        inventoryItemId: 'item-1', transactionType: 'stock_out', quantity: 2,
      } as any);

      expect(notifyInventoryRecipients).not.toHaveBeenCalled();
    });
  });

  // ── Cancel purchase order ─────────────────────────────────
  describe('cancelPurchaseOrder', () => {
    it('cancels a draft PO and records the reason in notes', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue({
        id: 'po-1', tenantId: TENANT_ID, status: 'draft', orderNumber: 'PO-1', notes: null,
      });
      (prisma.purchaseOrder.update as any).mockImplementation(({ data }: any) => ({
        id: 'po-1', orderNumber: 'PO-1', ...data,
      }));

      const result = await cancelPurchaseOrder(TENANT_ID, 'po-1', USER_ID, { reason: 'duplicate' });

      expect(result.status).toBe('cancelled');
      const arg = (prisma.purchaseOrder.update as any).mock.calls[0][0];
      expect(arg.data.status).toBe('cancelled');
      expect(arg.data.notes).toContain('duplicate');
    });

    it('refuses to cancel a delivered PO', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue({
        id: 'po-1', tenantId: TENANT_ID, status: 'delivered', orderNumber: 'PO-1',
      });

      await expect(
        cancelPurchaseOrder(TENANT_ID, 'po-1', USER_ID, {}),
      ).rejects.toThrow(/cannot be cancelled/i);
    });
  });

  // ── Alert run sweep ───────────────────────────────────────
  describe('runInventoryAlerts', () => {
    it('notifies for low-stock items and expiring batches', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID,
        lowStockAlertEnabled: true, expiryAlertEnabled: true, autoFlagExpired: false,
        expiryAlertMonths: 3, alertRecipientRoles: [],
      });
      (prisma.inventorySetting.update as any).mockResolvedValue({});

      // getLowStockItems → raw query (items, then count)
      (prisma.$queryRawUnsafe as any)
        .mockResolvedValueOnce([
          { id: 'item-1', item_name: 'Gloves', item_code: 'G1', current_stock: 5, minimum_stock_threshold: 50, unit_of_measurement: 'box' },
        ])
        .mockResolvedValueOnce([{ count: 1 }]);

      // getExpiringInventory → one stock-in row, fully remaining
      const future = new Date();
      future.setMonth(future.getMonth() + 1);
      (prisma.stockTransaction.findMany as any).mockResolvedValue([
        {
          id: 'tx1', inventoryItemId: 'item-1', batchNumber: 'B1',
          expiryDate: future, createdAt: new Date(), quantity: 10, unitCost: null,
          inventoryItem: { id: 'item-1', itemName: 'Gloves', itemCode: 'G1', unitOfMeasurement: 'box', category: 'consumable', currentStock: 5 },
          supplier: null,
        },
      ]);
      (prisma.stockTransaction.aggregate as any).mockResolvedValue({ _sum: { quantity: 0 } });

      const result = await runInventoryAlerts(TENANT_ID, USER_ID);

      expect(result.lowStockAlerts).toBe(1);
      expect(result.expiryAlerts).toBe(1);
      expect(result.expiredFlagged).toBe(0);
      expect(notifyInventoryRecipients).toHaveBeenCalledTimes(2);
      expect(prisma.inventorySetting.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID } }),
      );
    });

    it('skips an item that already has an open low-stock alert', async () => {
      (prisma.inventorySetting.findUnique as any).mockResolvedValue({
        id: 'is-1', tenantId: TENANT_ID,
        lowStockAlertEnabled: true, expiryAlertEnabled: false, autoFlagExpired: false,
        expiryAlertMonths: 3, alertRecipientRoles: [],
      });
      (prisma.inventorySetting.update as any).mockResolvedValue({});
      (prisma.$queryRawUnsafe as any)
        .mockResolvedValueOnce([
          { id: 'item-1', item_name: 'Gloves', current_stock: 5, minimum_stock_threshold: 50 },
        ])
        .mockResolvedValueOnce([{ count: 1 }]);
      (hasOpenInventoryAlert as any).mockResolvedValue(true); // already alerted

      const result = await runInventoryAlerts(TENANT_ID, USER_ID);

      expect(result.lowStockAlerts).toBe(0);
      expect(notifyInventoryRecipients).not.toHaveBeenCalled();
    });
  });
});
