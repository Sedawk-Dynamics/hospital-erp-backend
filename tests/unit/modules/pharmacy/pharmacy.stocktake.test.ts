import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import { reconcileStockTake } from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];

describe('Pharmacy — G4 physical stock-take reconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies counted variances as audited adjustments and leaves matches alone', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', tenantId: TENANT_ID, quantityInStock: 100, sellingPrice: 10, batchNumber: 'BN1', drug: { drugName: 'A' } },
      { id: 'b2', tenantId: TENANT_ID, quantityInStock: 100, sellingPrice: 5, batchNumber: 'BN2', drug: { drugName: 'B' } },
    ]);
    // adjustBatchStock (called only for the varied batch) reloads + updates.
    (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID, quantityInStock: 100, batchNumber: 'BN1', drug: { id: 'd1', drugName: 'A' } });
    (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', quantityInStock: 90, drug: { drugName: 'A' }, supplier: null });

    const res = await reconcileStockTake(TENANT_ID, USER_ID, ADMIN_ROLES, {
      reason: 'Monthly count',
      lines: [
        { batchId: 'b1', countedQuantity: 90 }, // shortfall of 10
        { batchId: 'b2', countedQuantity: 100 }, // matches
      ],
    });

    expect(res.total).toBe(2);
    expect(res.matched).toBe(1);
    expect(res.adjusted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.netDelta).toBe(-10);
    expect(res.valueDelta).toBe(-100); // -10 units × ₹10
    // Only the varied batch was written, to the counted quantity.
    expect(prisma.drugBatch.update).toHaveBeenCalledTimes(1);
    expect((prisma.drugBatch.update as any).mock.calls[0][0].data.quantityInStock).toBe(90);
    // Variance is audited so it shows in the discrepancy report.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(res.results.find((r) => r.batchId === 'b2')?.status).toBe('matched');
  });

  it('is per-line resilient — an unknown batch fails without aborting the sheet', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', tenantId: TENANT_ID, quantityInStock: 50, sellingPrice: 4, batchNumber: 'BN1', drug: { drugName: 'A' } },
    ]);
    (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'b1', tenantId: TENANT_ID, quantityInStock: 50, batchNumber: 'BN1', drug: { id: 'd1', drugName: 'A' } });
    (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', quantityInStock: 55, drug: { drugName: 'A' }, supplier: null });

    const res = await reconcileStockTake(TENANT_ID, USER_ID, ADMIN_ROLES, {
      reason: 'Cycle count',
      lines: [
        { batchId: 'missing-batch', countedQuantity: 5 },
        { batchId: 'b1', countedQuantity: 55 }, // surplus of 5
      ],
    });

    expect(res.failed).toBe(1);
    expect(res.adjusted).toBe(1);
    expect(res.netDelta).toBe(5);
    expect(res.results.find((r) => r.batchId === 'missing-batch')?.status).toBe('error');
  });

  it('rejects a non-pharmacy-admin caller', async () => {
    await expect(
      reconcileStockTake(TENANT_ID, USER_ID, ['pharmacist'], {
        reason: 'x',
        lines: [{ batchId: 'b1', countedQuantity: 1 }],
      }),
    ).rejects.toThrow(/pharmacy admin/i);
  });
});
