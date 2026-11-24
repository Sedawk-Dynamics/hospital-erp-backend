import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getStockValuation, isLiveBatch } from '../../../../src/modules/inventory/stock-valuation.service';
import {
  poLineName,
  auditDateBounds,
  getInventoryAuditLogs,
} from '../../../../src/modules/inventory/inventory.reports.service';
import { stockSnapshot } from '../../../../src/modules/inventory/inventory.audit';

// Gap 301: one valuation basis (purchase cost, live batches) for every screen.
describe('getStockValuation (gap 301)', () => {
  beforeEach(() => vi.clearAllMocks());
  const now = new Date('2026-11-19T10:00:00+05:30');

  it('values items at cost and drugs at batch purchase price, skipping expired batches', async () => {
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([
      { id: 'i1', itemName: 'Gloves', itemCode: 'GL', category: 'consumable', currentStock: 10, costPerUnit: 5, sellingPricePerUnit: 8 },
    ] as any);
    vi.mocked(prisma.drugBatch.findMany).mockResolvedValue([
      { drugId: 'd1', quantityInStock: 4, purchasePrice: 10, sellingPrice: 15, mrp: 20, expiryDate: new Date('2027-01-01'), isExpired: false, isRecalled: false, drug: { drugName: 'Para', hsnCode: null, category: 'drug' } },
      { drugId: 'd1', quantityInStock: 6, purchasePrice: 12, sellingPrice: null, mrp: 18, expiryDate: new Date('2027-02-01'), isExpired: false, isRecalled: false, drug: { drugName: 'Para', hsnCode: null, category: 'drug' } },
      // expired by date even though the flag was not set yet
      { drugId: 'd2', quantityInStock: 100, purchasePrice: 50, sellingPrice: 60, mrp: 70, expiryDate: new Date('2026-10-01'), isExpired: false, isRecalled: false, drug: { drugName: 'Old', hsnCode: null, category: 'drug' } },
      // no purchase price -> 0 and counted as unpriced
      { drugId: 'd3', quantityInStock: 2, purchasePrice: null, sellingPrice: 9, mrp: 9, expiryDate: new Date('2027-05-01'), isExpired: false, isRecalled: false, drug: { drugName: 'X', hsnCode: null, category: 'drug' } },
    ] as any);

    const v = await getStockValuation('t1', { now });

    expect(v.basis).toBe('purchase_cost');
    expect(v.asOf).toBe(now.toISOString());
    expect(v.items.costValue).toBe(50);
    expect(v.drugs.costValue).toBe(4 * 10 + 6 * 12);
    expect(v.drugs.unpricedBatches).toBe(1);
    expect(v.costValue).toBe(50 + 112);
    expect(v.itemCount).toBe(3); // 1 item + drugs d1, d3 (d2 expired)
    // Items mapped to an active drug are excluded from the item side.
    const where = vi.mocked(prisma.inventoryItem.findMany).mock.calls[0]![0]!.where as any;
    expect(where.formularyDrugs).toEqual({ none: { tenantId: 't1', isActive: true } });
    // Row values sum to the total (stock list matches the dashboard).
    expect(v.lines.reduce((s, l) => s + l.costValue, 0)).toBe(v.costValue);
  });

  it('isLiveBatch rejects recalled, empty and expired batches', () => {
    expect(isLiveBatch({ quantityInStock: 1, isExpired: false, isRecalled: true, expiryDate: null }, now)).toBe(false);
    expect(isLiveBatch({ quantityInStock: 0, isExpired: false, expiryDate: null }, now)).toBe(false);
    expect(isLiveBatch({ quantityInStock: 1, isExpired: false, expiryDate: new Date('2026-11-19') }, now)).toBe(true);
  });
});

describe('reorder history line names (gap 302)', () => {
  it('falls back from item name to drug name to code', () => {
    expect(poLineName({ inventoryItem: { itemName: 'Gauze', itemCode: 'G1' } })).toBe('Gauze');
    expect(poLineName({ inventoryItem: null, drug: { drugName: 'Paracetamol 500', hsnCode: '3004' } })).toBe('Paracetamol 500');
    expect(poLineName({ inventoryItem: { itemName: '', itemCode: 'G1' } })).toBe('G1');
    expect(poLineName({})).toBe('Unnamed item');
  });
});

describe('inventory audit logs (gap 303)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads date-only bounds as whole IST days so the "to" day is included', () => {
    const r = auditDateBounds('2026-11-01', '2026-11-19');
    expect(r.gte!.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(r.lte!.toISOString()).toBe('2026-11-19T18:29:59.999Z');
  });

  it('stockSnapshot gives qty and value at cost', () => {
    expect(stockSnapshot(15, '12.5')).toEqual({ qty: 15, unitCost: 12.5, value: 187.5 });
    expect(stockSnapshot(3, null)).toEqual({ qty: 3, unitCost: 0, value: 0 });
  });

  it('getInventoryAuditLogs applies the inclusive bounds', async () => {
    await getInventoryAuditLogs('t1', { fromDate: '2026-11-19', toDate: '2026-11-19' });
    const where = vi.mocked(prisma.auditLog.findMany).mock.calls.at(-1)![0]!.where as any;
    expect(where.createdAt.lte.toISOString()).toBe('2026-11-19T18:29:59.999Z');
    expect(where.entityType.in).toContain('stock_transaction');
  });
});
