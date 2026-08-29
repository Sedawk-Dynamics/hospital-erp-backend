import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  dispatchStockTransfer,
  receiveStockTransfer,
} from '../../../../src/modules/inventory/inventory.transfer.service';

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

describe('receiving a drug transfer puts it on the ward shelf', () => {
  /**
   * The whole point of naming a ward.
   *
   * Receiving used to do nothing at all — the comment said "just confirms
   * delivery, no stock change" — so a drug was decremented from the pharmacy
   * batch on dispatch and credited nowhere. Every dispatched drug transfer in
   * the live database had produced zero ward-stock ledger rows: the medicine
   * left the pharmacy and was tracked nowhere.
   */
  const dispatched = (over: Record<string, unknown> = {}) => ({
    id: 'st1',
    tenantId: TENANT,
    transferNumber: 'ST-1',
    status: 'dispatched',
    quantityRequested: 10,
    quantityTransferred: 10,
    drugBatchId: 'b1',
    inventoryItemId: null,
    toWardId: 'ward-1',
    drugBatch: { drugId: 'd1' },
    ...over,
  });

  beforeEach(() => {
    (prisma.wardStock.findFirst as any).mockResolvedValue(null);
    (prisma.wardStock.create as any).mockResolvedValue({ id: 'ws1' });
    (prisma.wardStock.update as any).mockResolvedValue({ id: 'ws1' });
    (prisma.wardStockLedger.create as any).mockResolvedValue({ id: 'wl1' });
  });

  it('credits the ward and writes a ledger row', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(dispatched());
    await receiveStockTransfer(TENANT, 'st1', USER);

    expect(prisma.wardStock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wardId: 'ward-1', drugBatchId: 'b1', quantityInStock: 10 }),
      }),
    );
    const ledger = (prisma.wardStockLedger.create as any).mock.calls[0][0].data;
    expect(ledger).toMatchObject({ wardId: 'ward-1', movementType: 'received', quantity: 10 });
    // Where it came from, so the ward can trace its own shelf.
    expect(ledger.reason).toMatch(/ST-1/);
  });

  it('adds to the shelf when the ward already holds that batch', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(dispatched());
    (prisma.wardStock.findFirst as any).mockResolvedValue({ id: 'ws-existing' });
    await receiveStockTransfer(TENANT, 'st1', USER);

    expect(prisma.wardStock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityInStock: { increment: 10 } } }),
    );
    expect(prisma.wardStock.create).not.toHaveBeenCalled();
  });

  it('does not touch ward stock for a transfer with no ward', async () => {
    // Consumables and equipment stay department-scoped, exactly as before.
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(dispatched({ toWardId: null }));
    await receiveStockTransfer(TENANT, 'st1', USER);
    expect(prisma.wardStock.create).not.toHaveBeenCalled();
    expect(prisma.wardStockLedger.create).not.toHaveBeenCalled();
  });

  it('still marks the transfer received either way', async () => {
    (prisma.stockTransfer.findFirst as any).mockResolvedValue(dispatched());
    await receiveStockTransfer(TENANT, 'st1', USER);
    const data = (prisma.stockTransfer.update as any).mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'received', receivedBy: USER });
  });
});
