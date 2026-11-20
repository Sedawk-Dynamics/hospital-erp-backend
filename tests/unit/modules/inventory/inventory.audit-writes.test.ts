import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

vi.mock('../../../../src/modules/inventory/inventory.audit', async (orig) => {
  const real = await orig<typeof import('../../../../src/modules/inventory/inventory.audit')>();
  return { ...real, safeInventoryAudit: vi.fn(async () => undefined) };
});

import { safeInventoryAudit } from '../../../../src/modules/inventory/inventory.audit';
import { createStockTransaction, createItem, createSupplier } from '../../../../src/modules/inventory/inventory.service';

// Gap 303: inventory actions must reach the shared audit writer with
// before/after quantity and value.
describe('inventory audit writes (gap 303)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stock transaction records before/after qty and value', async () => {
    vi.mocked(prisma.inventoryItem.findFirst).mockResolvedValue({
      id: 'i1', itemName: 'Gloves', itemCode: 'GL', currentStock: 10, costPerUnit: 5, minimumStockThreshold: 2, unitOfMeasurement: 'box',
    } as any);
    vi.mocked(prisma.stockTransaction.create).mockResolvedValue({ id: 'tx1' } as any);
    vi.mocked(prisma.inventoryItem.update).mockResolvedValue({} as any);

    await createStockTransaction('t1', 'u1', { inventoryItemId: 'i1', transactionType: 'stock_out', quantity: 4 } as any);

    const call = vi.mocked(safeInventoryAudit).mock.calls.find((c) => c[0].entityType === 'stock_transaction')![0];
    expect(call.oldValues).toMatchObject({ qty: 10, value: 50 });
    expect(call.newValues).toMatchObject({ qty: 6, value: 30, transactionType: 'stock_out' });
  });

  it('item and supplier creation are audited', async () => {
    vi.mocked(prisma.inventoryItem.create).mockResolvedValue({ id: 'i2', itemName: 'Mask', itemCode: null, currentStock: 3, costPerUnit: 2 } as any);
    vi.mocked(prisma.supplier.create).mockResolvedValue({ id: 's1', name: 'Acme', gstNumber: null } as any);
    await createItem('t1', { itemName: 'Mask', category: 'consumable', currentStock: 3, costPerUnit: 2 } as any);
    await createSupplier('t1', { name: 'Acme' } as any);
    const types = vi.mocked(safeInventoryAudit).mock.calls.map((c) => c[0].entityType);
    expect(types).toEqual(expect.arrayContaining(['inventory_item', 'supplier']));
    const item = vi.mocked(safeInventoryAudit).mock.calls.find((c) => c[0].entityType === 'inventory_item')![0];
    expect(item.newValues).toMatchObject({ qty: 3, value: 6 });
  });
});
