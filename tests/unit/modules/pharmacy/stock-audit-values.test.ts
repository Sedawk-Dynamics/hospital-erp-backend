import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  drugStockAuditValues,
  drugStockAuditLinesAfterCommit,
} from '../../../../src/modules/pharmacy/pharmacy.audit';
import { adjustBatchStock } from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

// Gap 303: every drug-stock audit row records before/after quantity AND value
// (at purchase cost), plus the source document.
describe('drugStockAuditValues', () => {
  it('records before/after quantity and value for one batch', () => {
    const snap = drugStockAuditValues(
      [{ drugBatchId: 'b1', batchNumber: 'BN1', before: 8, after: 7, unitCost: '12.50' }],
      { movementType: 'adjustment', documentNumber: null, referenceType: 'stock_adjustment', referenceId: 'b1' },
    );
    expect(snap.oldValues).toMatchObject({ qty: 8, unitCost: 12.5, value: 100, batchNumber: 'BN1' });
    expect(snap.newValues).toMatchObject({
      qty: 7, unitCost: 12.5, value: 87.5, delta: -1, valueDelta: -12.5,
      valuationBasis: 'purchase_cost', movementType: 'adjustment',
      source: { type: 'stock_adjustment', id: 'b1' },
    });
  });

  it('totals several batches and keeps the per-batch lines (a multi-line sale)', () => {
    const snap = drugStockAuditValues(
      [
        { drugBatchId: 'b1', before: 10, after: 7, unitCost: 2 },
        { drugBatchId: 'b2', before: 5, after: 4, unitCost: 10 },
      ],
      { movementType: 'sale', documentNumber: 'PH-20261120-0001', referenceType: 'pharmacy_sale', referenceId: 'bill-1' },
    );
    expect(snap.oldValues).toMatchObject({ qty: 15, value: 70 });
    expect(snap.newValues).toMatchObject({ qty: 11, value: 54, delta: -4, valueDelta: -16, documentNumber: 'PH-20261120-0001' });
    expect((snap.newValues as any).lines).toHaveLength(2);
  });

  it('values an unpriced batch at ₹0 rather than failing', () => {
    const snap = drugStockAuditValues([{ drugBatchId: 'b1', before: 3, after: 0, unitCost: null }], { movementType: 'sale' });
    expect(snap.oldValues.value).toBe(0);
    expect(snap.newValues.qty).toBe(0);
  });

  it('uses the old cost for "before" when the cost basis itself changed', () => {
    const snap = drugStockAuditValues(
      [{ drugBatchId: 'b1', before: 10, after: 10, unitCostBefore: 5, unitCost: 6 }],
      { movementType: 'adjustment' },
    );
    expect(snap.oldValues.value).toBe(50);
    expect(snap.newValues.value).toBe(60);
  });
});

describe('drugStockAuditLinesAfterCommit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('walks the live quantity back by the summed delta per batch', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', batchNumber: 'BN1', quantityInStock: 5, purchasePrice: 4, drug: { drugName: 'A' } },
    ]);
    const lines = await drugStockAuditLinesAfterCommit(TENANT_ID, [
      { drugBatchId: 'b1', delta: 2 },
      { drugBatchId: 'b1', delta: 1 },
    ]);
    expect(lines).toEqual([
      expect.objectContaining({ drugBatchId: 'b1', before: 2, after: 5, unitCost: 4, drugName: 'A' }),
    ]);
  });
});

describe('adjustBatchStock audit (QA: batch 8 → 7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes before/after quantity and value at purchase cost', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue({
      id: 'b1', tenantId: TENANT_ID, drugId: 'd1', quantityInStock: 8, batchNumber: 'BN1',
      purchasePrice: 10, drug: { id: 'd1', drugName: 'Paracetamol' },
    });
    (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', quantityInStock: 7, drug: { drugName: 'Paracetamol' }, supplier: null });

    await adjustBatchStock(TENANT_ID, USER_ID, ['pharmacy_admin'], 'b1', { newQuantity: 7, reason: 'Recount' });

    const data = (prisma.auditLog.create as any).mock.calls[0][0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.oldValues).toMatchObject({ qty: 8, value: 80, quantityInStock: 8 });
    expect(data.newValues).toMatchObject({ qty: 7, value: 70, delta: -1, from: 8, to: 7, valuationBasis: 'purchase_cost' });
  });
});
