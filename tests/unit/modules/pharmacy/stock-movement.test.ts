import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  recordDrugStockMovement,
  buildStockLedger,
  resetDrugStockMovementProbe,
  inventoryTypeForMovement,
} from '../../../../src/modules/pharmacy/pharmacy.stock-movement';
import { cancelPharmacySale } from '../../../../src/modules/pharmacy/pharmacy.service';

// 349: every change to a pharmacy batch's stock writes a movement row, and the
// Pharmacy Stock Ledger's closing balance equals live stock.

const T = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  resetDrugStockMovementProbe(true);
});

describe('recordDrugStockMovement', () => {
  it('writes a signed row on the caller transaction', async () => {
    const tx = { drugStockMovement: { create: vi.fn() } };
    await recordDrugStockMovement(tx, {
      tenantId: T, drugId: 'd1', drugBatchId: 'b1', movementType: 'sale', quantity: -3,
      referenceType: 'pharmacy_sale', referenceId: 'bill-1',
    });
    expect(tx.drugStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ drugId: 'd1', drugBatchId: 'b1', movementType: 'sale', quantity: -3 }),
    });
  });

  it('skips a zero quantity and a missing drug id', async () => {
    const tx = { drugStockMovement: { create: vi.fn() } };
    await recordDrugStockMovement(tx, { tenantId: T, drugId: 'd1', drugBatchId: 'b1', movementType: 'adjustment', quantity: 0 });
    await recordDrugStockMovement(tx, { tenantId: T, drugId: '', drugBatchId: 'b1', movementType: 'sale', quantity: -1 });
    expect(tx.drugStockMovement.create).not.toHaveBeenCalled();
  });

  // Until `prisma db push` creates the table, a write inside the sale's
  // transaction would abort the sale — so it is skipped instead.
  it('does not write when the table is not there yet', async () => {
    resetDrugStockMovementProbe(null);
    (prisma.drugStockMovement.findFirst as any).mockRejectedValueOnce(
      Object.assign(new Error('relation does not exist'), { code: 'P2021' }),
    );
    const tx = { drugStockMovement: { create: vi.fn() } };
    await recordDrugStockMovement(tx, { tenantId: T, drugId: 'd1', drugBatchId: 'b1', movementType: 'sale', quantity: -1 });
    expect(tx.drugStockMovement.create).not.toHaveBeenCalled();
  });
});

describe('buildStockLedger', () => {
  const liveStock = (n: number) =>
    (prisma.drugBatch.aggregate as any).mockImplementation(async (args: any) =>
      args?.where?.isExpired ? { _sum: { quantityInStock: 0 } } : { _sum: { quantityInStock: n } },
    );

  it('closes at live stock, with sales in the period', async () => {
    const day = new Date('2026-11-10T06:00:00.000Z');
    (prisma.drugStockMovement.findMany as any).mockResolvedValue([
      { id: 'm1', drugId: 'd1', drugBatchId: 'b1', movementType: 'receipt', quantity: 120, referenceType: 'drug_batch', referenceId: 'b1', party: 'Acme', createdAt: day },
      { id: 'm2', drugId: 'd1', drugBatchId: 'b1', movementType: 'sale', quantity: -9, referenceType: 'pharmacy_sale', referenceId: 'bill-1', party: null, createdAt: new Date(day.getTime() + 3600_000) },
    ]);
    (prisma.drugStockMovement.aggregate as any).mockImplementation(async (args: any) =>
      args?._min ? { _min: { createdAt: new Date('2026-10-01T00:00:00.000Z') } } : { _sum: { quantity: 0 } },
    );
    (prisma.drugBatch.findMany as any).mockResolvedValue([{ id: 'b1', batchNumber: 'BN1', drug: { id: 'd1', drugName: 'Amox' } }]);
    (prisma.bill.findMany as any).mockResolvedValue([{ id: 'bill-1', billNumber: 'PH-1', patient: { firstName: 'A', lastName: 'B', mrn: 'M1' } }]);
    liveStock(111);

    const r = await buildStockLedger(T, { fromDate: '2026-11-01', toDate: '2026-11-19', drugId: 'd1' });
    expect(r.summary.closingStock).toBe(111);
    expect(r.summary.liveStock).toBe(111);
    expect(r.summary.openingStock).toBe(0);
    expect(r.summary.totalDispensed).toBe(9);
    expect(r.summary.reconstructedBefore).toBeNull();
    const sale = r.entries.find((e) => e.movementType === 'sale')!;
    expect(sale.quantityOut).toBe(9);
    expect(sale.party).toContain('PH-1');
    // Newest first; running balance ends at the closing figure.
    expect(r.entries[0].balance).toBe(111);
  });

  it('walks back movements after the period so a past closing is that day\'s stock', async () => {
    (prisma.drugStockMovement.findMany as any).mockResolvedValue([]);
    (prisma.drugStockMovement.aggregate as any).mockImplementation(async (args: any) =>
      args?._min ? { _min: { createdAt: new Date('2026-01-01T00:00:00.000Z') } } : { _sum: { quantity: -20 } },
    );
    liveStock(80);
    const r = await buildStockLedger(T, { fromDate: '2026-10-01', toDate: '2026-10-31' });
    // 20 sold after the period: on 31 Oct there were 100.
    expect(r.summary.closingStock).toBe(100);
    expect(r.summary.openingStock).toBe(100);
  });

  // Gap 347: the ledger had no actor column — every row now names who made it.
  it('names who made each movement', async () => {
    const day = new Date('2026-11-10T06:00:00.000Z');
    (prisma.drugStockMovement.findMany as any).mockResolvedValue([
      { id: 'm1', drugId: 'd1', drugBatchId: 'b1', movementType: 'sale', quantity: -2, referenceType: 'pharmacy_sale', referenceId: 'bill-1', party: 'X', performedBy: 'u1', createdAt: day },
      { id: 'm2', drugId: 'd1', drugBatchId: 'b1', movementType: 'adjustment', quantity: 1, referenceType: null, referenceId: null, party: null, performedBy: null, createdAt: day },
    ]);
    (prisma.drugStockMovement.aggregate as any).mockImplementation(async (args: any) =>
      args?._min ? { _min: { createdAt: new Date('2026-10-01T00:00:00.000Z') } } : { _sum: { quantity: 0 } },
    );
    (prisma.drugBatch.findMany as any).mockResolvedValue([{ id: 'b1', batchNumber: 'BN1', drug: { id: 'd1', drugName: 'Amox' } }]);
    (prisma.user.findMany as any).mockResolvedValue([{ id: 'u1', firstName: 'Pharmacist', lastName: 'Test' }]);
    liveStock(10);

    const r = await buildStockLedger(T, { fromDate: '2026-11-01', toDate: '2026-11-19' });
    expect(r.entries.find((e) => e.id === 'm1')!.by).toBe('Pharmacist Test');
    expect(r.entries.find((e) => e.id === 'm2')!.by).toBeNull();
    expect((prisma.user.findMany as any).mock.calls[0][0].where.id.in).toEqual(['u1']);
  });

  it('lists a vendor return as an outflow when rebuilding pre-log history', async () => {
    (prisma.drugStockMovement.findMany as any).mockResolvedValue([]);
    (prisma.drugStockMovement.aggregate as any).mockResolvedValue({ _sum: {}, _min: {} });
    (prisma.drugBatch.findMany as any).mockResolvedValue([]);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([]);
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      { id: 'r1', returnType: 'vendor_return', quantity: 5, createdAt: new Date(Date.now() - 86400_000), drugBatch: { batchNumber: 'BN', drug: { id: 'd1', drugName: 'Amox' } } },
    ]);
    liveStock(10);
    const r = await buildStockLedger(T, {});
    const vr = r.entries.find((e) => e.movementType === 'vendor_return')!;
    expect(vr.quantityOut).toBe(5);
    expect(vr.quantityIn).toBe(0);
    expect(vr.reconstructed).toBe(true);
    expect(r.summary.closingStock).toBe(10);
    expect(r.summary.reconstructedBefore).not.toBeNull();
  });
});

describe('inventory mapping', () => {
  it('reads sales and transfers as stock out, receipts as stock in', () => {
    expect(inventoryTypeForMovement('sale', -2)).toBe('stock_out');
    expect(inventoryTypeForMovement('transfer_out', -2)).toBe('stock_out');
    expect(inventoryTypeForMovement('receipt', 5)).toBe('stock_in');
    expect(inventoryTypeForMovement('sale_cancel', 2)).toBe('return_stock');
  });
});

describe('cancelPharmacySale', () => {
  it('records the restock as a sale_cancel movement', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-1', status: 'paid' });
    (prisma.drugReturn.count as any).mockResolvedValue(0);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { id: 'rec-1', drugBatchId: 'b1', quantityDispensed: 4, prescriptionId: null },
    ]);
    (prisma.drugBatch.update as any).mockResolvedValue({ id: 'b1', drugId: 'd1' });
    await cancelPharmacySale(T, 'user-1', 'bill-1', { reason: 'wrong patient' } as any).catch(() => undefined);
    expect(prisma.drugStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ movementType: 'sale_cancel', quantity: 4, drugId: 'd1', drugBatchId: 'b1' }),
    });
  });
});
