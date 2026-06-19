import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  prePackHold,
  releaseHold,
  listStockHolds,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
});

describe('Pharmacy — OP pre-pack (Stock Hold)', () => {
  it('reserves stock from the batch without billing', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    (prisma.drugBatch.findFirst as any).mockResolvedValue({
      id: 'b1', drugId: 'd1', batchNumber: 'B1', quantityInStock: 100, isExpired: false, isRecalled: false,
      sellingPrice: 5, expiryDate: new Date('2028-01-01'), drug: { drugName: 'Amox', price: 5, taxPercent: 12 },
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.pharmacyStockHold.create as any).mockImplementation((args: any) => ({ id: 'hold-1', status: args.data.status, items: [] }));

    const hold = await prePackHold(TENANT, USER, { patientId: 'p1', items: [{ drugBatchId: 'b1', quantity: 10 }] });
    expect(hold.status).toBe('held');
    // available-to-sell pool reduced by the held qty
    expect(prisma.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { decrement: 10 } } });
    // not billed at pre-pack time
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it('refuses to pre-pack more than is in stock', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue({
      id: 'b1', drugId: 'd1', batchNumber: 'B1', quantityInStock: 3, isExpired: false, isRecalled: false,
      sellingPrice: 5, expiryDate: new Date('2028-01-01'), drug: { drugName: 'Amox', taxPercent: 12 },
    });
    await expect(
      prePackHold(TENANT, USER, { items: [{ drugBatchId: 'b1', quantity: 10 }] }),
    ).rejects.toThrow(/Insufficient stock/);
  });

  it('refuses to pre-pack from an expired batch', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue({
      id: 'b1', drugId: 'd1', batchNumber: 'B1', quantityInStock: 100, isExpired: true, isRecalled: false,
      sellingPrice: 5, expiryDate: new Date('2020-01-01'), drug: { drugName: 'Amox', taxPercent: 12 },
    });
    await expect(
      prePackHold(TENANT, USER, { items: [{ drugBatchId: 'b1', quantity: 1 }] }),
    ).rejects.toThrow(/expired/);
  });
});

describe('Pharmacy — release a hold', () => {
  it('returns the reserved stock to the pool', async () => {
    (prisma.pharmacyStockHold.findFirst as any).mockResolvedValue({
      id: 'hold-1', status: 'held', items: [{ id: 'i1', drugBatchId: 'b1', quantity: 10 }],
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.pharmacyStockHold.update as any).mockImplementation((args: any) => ({ id: 'hold-1', status: args.data.status }));

    const r = await releaseHold(TENANT, USER, 'hold-1');
    expect(r.status).toBe('released');
    expect(prisma.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { increment: 10 } } });
  });

  it('refuses to release an already-collected hold', async () => {
    (prisma.pharmacyStockHold.findFirst as any).mockResolvedValue({ id: 'hold-2', status: 'collected', items: [] });
    await expect(releaseHold(TENANT, USER, 'hold-2')).rejects.toThrow(/already collected/);
  });
});

describe('Pharmacy — list holds', () => {
  it('shapes holds with item totals', async () => {
    (prisma.pharmacyStockHold.findMany as any).mockResolvedValue([
      {
        id: 'hold-1', status: 'held', createdAt: new Date(), collectedAt: null, notes: null,
        patient: { mrn: 'MRN1', firstName: 'A', lastName: 'B' },
        items: [{ id: 'i1', quantity: 10, unitPrice: 5, drug: { drugName: 'Amox', strength: null }, drugBatch: { batchNumber: 'B1' } }],
      },
    ]);
    const r = await listStockHolds(TENANT, { status: 'held' });
    expect(r.total).toBe(1);
    expect(r.items[0].patient).toMatchObject({ mrn: 'MRN1', name: 'A B' });
    expect(r.items[0].total).toBe(50); // 10 × 5
  });
});
