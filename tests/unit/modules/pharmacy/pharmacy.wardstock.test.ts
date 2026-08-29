import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  returnWardStock,
  adjustWardStock,
  dispenseFromWard,
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

  /**
   * Stock that goes bad while it sits on the ward shelf.
   *
   * The pharmacy refuses to ISSUE an expired or recalled batch, but a batch
   * can pass that door in good condition and go bad weeks later in the ward
   * cupboard. Nothing looked at it again, so an expired tablet could be given
   * to a patient and billed for, and a recall reached every screen except the
   * wards already holding the stock.
   */
  describe('dispenseFromWard refuses stock that has gone bad on the shelf', () => {
    const goodShelf = { id: 'ws1', drugId: 'd1', quantityInStock: 50 };
    const batch = (over: Record<string, unknown>) => ({
      id: 'b1', batchNumber: 'B-1', isExpired: false, isRecalled: false, recallReason: null,
      expiryDate: new Date(Date.now() + 400 * 864e5), sellingPrice: 10, purchasePrice: 8,
      drug: { drugName: 'Paracetamol 500', category: 'tablet', price: 10, taxPercent: 12,
        isLifeSaving: false, isNarcotic: false, isReimbursable: null,
        schedule: null, controlledClass: null, vaultControlled: false },
      ...over,
    });
    const dose = () => dispenseFromWard(TENANT_ID, USER_ID, {
      wardId: 'w1', drugBatchId: 'b1', patientId: 'p1', quantity: 1, override: true,
    });

    beforeEach(() => {
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    });

    it('refuses an expired batch, and says when it expired', async () => {
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue(goodShelf);
      tx.drugBatch.findUnique.mockResolvedValue(batch({ isExpired: true, expiryDate: new Date('2026-01-31') }));

      await expect(dose()).rejects.toThrow(/expired on 31\/1\/2026/);
      // Nothing moved and nothing was billed.
      expect(tx.wardStock.update).not.toHaveBeenCalled();
      expect(tx.wardStockLedger.create).not.toHaveBeenCalled();
    });

    it('refuses a recalled batch, and passes on the reason', async () => {
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue(goodShelf);
      tx.drugBatch.findUnique.mockResolvedValue(
        batch({ isRecalled: true, recallReason: 'Contamination, lot 44' }),
      );

      await expect(dose()).rejects.toThrow(/recalled.*Contamination, lot 44/);
      expect(tx.wardStock.update).not.toHaveBeenCalled();
    });
  });

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
      // Signed: breaking five and finding five are opposite events, and this
      // used to store both as 5.
      expect(ledger.quantity).toBe(-5);
      // Central stock is NOT touched by an adjustment.
      expect(tx.drugBatch.update).not.toHaveBeenCalled();
    });

    it('records a correction the other way as a positive number', async () => {
      const tx = txWith();
      tx.wardStock.findFirst.mockResolvedValue({ id: 'ws1', drugId: 'd1', quantityInStock: 45 });

      const res = await adjustWardStock(TENANT_ID, USER_ID, ADMIN, {
        wardId: 'w1', drugBatchId: 'b1', newQuantity: 50, reason: 'found in the cupboard',
      });

      expect(res).toMatchObject({ from: 45, to: 50, delta: 5 });
      expect(tx.wardStockLedger.create.mock.calls[0][0].data.quantity).toBe(5);
    });
  });
});
