import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { dispatchStockTransfer } from '../../../../src/modules/inventory/inventory.transfer.service';

/**
 * Dispatch is where stock actually moves, and it had no tests at all.
 *
 * These arrived with the NDPS challan screen's deletion. That screen guaranteed
 * two things the board now has to guarantee instead — a narcotic needs a second
 * person, and you cannot draw more than the location holds — so its tests are
 * re-pointed here rather than deleted with it. A rule whose only test went away
 * with the screen it used to live on is a rule nobody is checking.
 */

const TENANT = 't1';
const USER = 'u1';

const vaultTransfer = (over: Record<string, unknown> = {}) => ({
  id: 'st1',
  tenantId: TENANT,
  status: 'approved',
  quantityRequested: 5,
  drugBatchId: 'b1',
  inventoryItemId: null,
  drugBatch: {
    id: 'b1',
    batchNumber: 'MOR441',
    quantityInStock: 100,
    drug: {
      drugName: 'Morphine Inj',
      controlledClass: 'narcotic',
      vaultControlled: true,
      schedule: 'H1',
    },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.user.findFirst as any).mockResolvedValue({ id: 'u2' });
  (prisma.drugBatch.update as any).mockResolvedValue({});
  (prisma.stockTransfer.update as any).mockImplementation(async (a: any) => ({ id: 'st1', ...a.data }));
});

describe('dispatching a controlled transfer', () => {
  it('refuses to move a narcotic with nobody taking custody', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(vaultTransfer());
    await expect(dispatchStockTransfer(TENANT, 'st1', USER)).rejects.toThrow(
      /name the person receiving it/i,
    );
    // Nothing may move before the gate passes.
    expect(prisma.drugBatch.update).not.toHaveBeenCalled();
  });

  it('refuses to let the dispatcher co-sign their own hand-over', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(vaultTransfer());
    await expect(dispatchStockTransfer(TENANT, 'st1', USER, undefined, USER)).rejects.toThrow(
      /cannot be the person dispatching/i,
    );
    expect(prisma.drugBatch.update).not.toHaveBeenCalled();
  });

  it('moves the stock and records who took custody', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(vaultTransfer());
    await dispatchStockTransfer(TENANT, 'st1', USER, undefined, 'u2');

    expect(prisma.drugBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityInStock: { decrement: 5 } } }),
    );
    const data = (prisma.stockTransfer.update as any).mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'dispatched', custodianId: 'u2' });
    expect(data.custodyAt).toBeInstanceOf(Date);
  });

  it('refuses to draw more than the batch holds', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(
      vaultTransfer({ drugBatch: { ...vaultTransfer().drugBatch, quantityInStock: 2 } }),
    );
    await expect(dispatchStockTransfer(TENANT, 'st1', USER, 5, 'u2')).rejects.toThrow(
      /Insufficient drug stock/i,
    );
  });

  it('dispatches an ordinary medicine with no custodian at all', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(
      vaultTransfer({
        drugBatch: {
          id: 'b1', batchNumber: 'P1', quantityInStock: 100,
          drug: { drugName: 'Paracetamol', controlledClass: null, vaultControlled: false, schedule: 'OTC' },
        },
      }),
    );
    await dispatchStockTransfer(TENANT, 'st1', USER);

    const data = (prisma.stockTransfer.update as any).mock.calls[0][0].data;
    expect(data.status).toBe('dispatched');
    expect(data.custodianId).toBeNull();
  });

  it('only dispatches an approved transfer', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(vaultTransfer({ status: 'pending' }));
    await expect(dispatchStockTransfer(TENANT, 'st1', USER, undefined, 'u2')).rejects.toThrow(
      /Only approved transfers/i,
    );
  });
});
