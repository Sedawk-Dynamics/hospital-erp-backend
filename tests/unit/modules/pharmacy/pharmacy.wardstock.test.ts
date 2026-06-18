import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  returnWardStock,
  adjustWardStock,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ADMIN = ['pharmacy_admin'];

function model() {
  return {
    create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(),
  };
}
function txWith() {
  const tx: any = { wardStock: model(), wardStockLedger: model(), drugBatch: model() };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  return tx;
}

describe('Pharmacy — G13 ward stock reverse flows', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('returnWardStock (ward → central)', () => {
    it('moves stock back to central and logs a returned ledger entry', async () => {
      (prisma.ward.findFirst as any).mockResolvedValue({ id: 'w1' });
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws1', drugId: 'd1', quantityInStock: 50 });

      const res = await returnWardStock(TENANT_ID, USER_ID, ADMIN, {
        wardId: 'w1', drugBatchId: 'b1', quantity: 20, reason: 'near expiry',
      });

      expect(res.returned).toBe(20);
      expect(tx.wardStock.update.mock.calls[0][0].data.quantityInStock).toEqual({ decrement: 20 });
      // Central batch is restored.
      expect(tx.drugBatch.update.mock.calls[0][0].data.quantityInStock).toEqual({ increment: 20 });
      expect(tx.wardStockLedger.create.mock.calls[0][0].data.movementType).toBe('returned');
    });

    it('rejects a return exceeding ward stock', async () => {
      (prisma.ward.findFirst as any).mockResolvedValue({ id: 'w1' });
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws1', drugId: 'd1', quantityInStock: 5 });
      await expect(
        returnWardStock(TENANT_ID, USER_ID, ADMIN, { wardId: 'w1', drugBatchId: 'b1', quantity: 20 }),
      ).rejects.toThrow(/Insufficient ward stock/i);
    });

    it('rejects a non-pharmacy-admin caller', async () => {
      await expect(
        returnWardStock(TENANT_ID, USER_ID, ['nurse'], { wardId: 'w1', drugBatchId: 'b1', quantity: 1 }),
      ).rejects.toThrow(/pharmacy admin/i);
    });
  });

  describe('adjustWardStock (count correction)', () => {
    it('sets the ward count and logs an adjusted ledger entry with the delta', async () => {
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws1', drugId: 'd1', quantityInStock: 50 });

      const res = await adjustWardStock(TENANT_ID, USER_ID, ADMIN, {
        wardId: 'w1', drugBatchId: 'b1', newQuantity: 45, reason: 'breakage',
      });

      expect(res).toMatchObject({ from: 50, to: 45, delta: -5 });
      expect(tx.wardStock.update.mock.calls[0][0].data.quantityInStock).toBe(45);
      const ledger = tx.wardStockLedger.create.mock.calls[0][0].data;
      expect(ledger.movementType).toBe('adjusted');
      expect(ledger.quantity).toBe(5); // |delta|
      // Central stock is NOT touched by an adjustment.
      expect(tx.drugBatch.update).not.toHaveBeenCalled();
    });
  });
});
