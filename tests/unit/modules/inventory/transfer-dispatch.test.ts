import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createStockTransfer } from '../../../../src/modules/inventory/inventory.transfer.service';

/**
 * Recording a transfer IS the transfer, and that is where the stock moves.
 *
 * These tests arrived with the NDPS challan screen's deletion. That screen
 * guaranteed two things the transfer flow has to guarantee instead — a narcotic
 * needs a second person, and you cannot draw more than the location holds — so
 * its tests were re-pointed here rather than deleted with it. A rule whose only
 * test went away with the screen it used to live on is a rule nobody is
 * checking.
 *
 * They moved a second time when the four-step board (pending → approved →
 * dispatched → received) collapsed into one action. The rules did not change;
 * only where they are enforced did, so the assertions follow them across.
 */

const TENANT = 't1';
const USER = 'u1';
const WARD = 'w1';

/** A vault narcotic being moved from the pharmacy to a ward. */
const vaultBatch = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  batchNumber: 'MOR441',
  quantityInStock: 100,
  drug: {
    id: 'd1',
    drugName: 'Morphine Inj',
    controlledClass: 'narcotic',
    vaultControlled: true,
    schedule: 'H1',
  },
  ...over,
});

const ordinaryBatch = (over: Record<string, unknown> = {}) => ({
  id: 'b2',
  batchNumber: 'PCM100',
  quantityInStock: 60,
  drug: {
    id: 'd2',
    drugName: 'Paracetamol 500',
    controlledClass: null,
    vaultControlled: false,
    schedule: null,
  },
  ...over,
});

/** The minimum a drug transfer needs. */
const input = (over: Record<string, unknown> = {}) => ({
  drugBatchId: 'b1',
  fromDepartmentId: 'dep1',
  toWardId: WARD,
  quantityRequested: 5,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.user.findFirst as any).mockResolvedValue({ id: 'u2' });
  (prisma.department.findFirst as any).mockResolvedValue({ id: 'dep1', name: 'Pharmacy' });
  (prisma.drugBatch.update as any).mockResolvedValue({});
  (prisma.wardStock.findFirst as any).mockResolvedValue(null);
  (prisma.wardStock.create as any).mockResolvedValue({});
  (prisma.wardStock.update as any).mockResolvedValue({});
  (prisma.wardStockLedger.create as any).mockResolvedValue({});
  (prisma.stockTransaction.create as any).mockResolvedValue({});
  (prisma.stockTransfer.findFirst as any).mockResolvedValue(null); // transfer-number lookup
  (prisma.stockTransfer.create as any).mockImplementation(async (a: any) => ({
    id: 'st1',
    ...a.data,
  }));
});

describe('moving a controlled drug', () => {
  it('refuses to move a narcotic with nobody taking custody', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(vaultBatch());

    await expect(createStockTransfer(TENANT, USER, input() as never)).rejects.toThrow(
      /name the person receiving it/i,
    );
    // Nothing may move before the gate passes.
    expect(prisma.drugBatch.update).not.toHaveBeenCalled();
    expect(prisma.stockTransfer.create).not.toHaveBeenCalled();
  });

  it('refuses to let the mover co-sign their own hand-over', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(vaultBatch());

    await expect(
      createStockTransfer(TENANT, USER, input({ custodianId: USER }) as never),
    ).rejects.toThrow(/cannot be the person dispatching/i);
    expect(prisma.drugBatch.update).not.toHaveBeenCalled();
  });

  it('moves the stock and records who took custody', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(vaultBatch());

    await createStockTransfer(TENANT, USER, input({ custodianId: 'u2' }) as never);

    expect(prisma.drugBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { quantityInStock: { decrement: 5 } },
    });
    const created = (prisma.stockTransfer.create as any).mock.calls[0][0].data;
    expect(created).toMatchObject({ custodianId: 'u2', status: 'received', quantityTransferred: 5 });
    expect(created.custodyAt).toBeInstanceOf(Date);
  });

  it('refuses to draw more than the batch holds', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(vaultBatch({ quantityInStock: 3 }));

    await expect(
      createStockTransfer(TENANT, USER, input({ custodianId: 'u2' }) as never),
    ).rejects.toThrow(/insufficient drug stock/i);
    expect(prisma.drugBatch.update).not.toHaveBeenCalled();
  });

  it('moves an ordinary medicine with no custodian at all', async () => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(ordinaryBatch());

    await createStockTransfer(TENANT, USER, input({ drugBatchId: 'b2' }) as never);

    expect(prisma.drugBatch.update).toHaveBeenCalled();
    const created = (prisma.stockTransfer.create as any).mock.calls[0][0].data;
    expect(created.custodianId).toBeNull();
  });
});

describe('a drug transfer lands on the ward shelf', () => {
  beforeEach(() => {
    (prisma.drugBatch.findFirst as any).mockResolvedValue(ordinaryBatch());
  });

  it('credits the ward and writes a ledger row', async () => {
    await createStockTransfer(TENANT, USER, input({ drugBatchId: 'b2' }) as never);

    expect(prisma.wardStock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wardId: WARD, drugBatchId: 'b2', quantityInStock: 5 }),
      }),
    );
    expect(prisma.wardStockLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wardId: WARD, movementType: 'received', quantity: 5 }),
      }),
    );
  });

  it('adds to the shelf when the ward already holds that batch', async () => {
    (prisma.wardStock.findFirst as any).mockResolvedValue({ id: 'ws1' });

    await createStockTransfer(TENANT, USER, input({ drugBatchId: 'b2' }) as never);

    expect(prisma.wardStock.update).toHaveBeenCalledWith({
      where: { id: 'ws1' },
      data: { quantityInStock: { increment: 5 } },
    });
    expect(prisma.wardStock.create).not.toHaveBeenCalled();
  });

  it('does not touch ward stock for a transfer with no ward', async () => {
    await createStockTransfer(
      TENANT,
      USER,
      input({ drugBatchId: 'b2', toWardId: undefined, toDepartmentId: 'dep2' }) as never,
    );

    expect(prisma.wardStock.create).not.toHaveBeenCalled();
    expect(prisma.wardStockLedger.create).not.toHaveBeenCalled();
    // The stock still leaves the pharmacy either way.
    expect(prisma.drugBatch.update).toHaveBeenCalled();
  });
});

describe('moving a generic item between departments', () => {
  beforeEach(() => {
    (prisma.inventoryItem.findFirst as any).mockResolvedValue({
      id: 'i1',
      itemName: 'Nitrile gloves',
      currentStock: 40,
    });
  });

  const itemInput = (over: Record<string, unknown> = {}) => ({
    inventoryItemId: 'i1',
    fromDepartmentId: 'dep1',
    toDepartmentId: 'dep2',
    quantityRequested: 10,
    ...over,
  });

  it('records where it left and where it arrived', async () => {
    await createStockTransfer(TENANT, USER, itemInput() as never);

    const calls = (prisma.stockTransaction.create as any).mock.calls.map((c: any) => c[0].data);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ transactionType: 'stock_out', departmentId: 'dep1', quantity: 10 });
    expect(calls[1]).toMatchObject({ transactionType: 'stock_in', departmentId: 'dep2', quantity: 10 });
  });

  it('leaves the hospital-wide total alone, because nothing left the building', async () => {
    // currentStock is one figure for the whole hospital, so a department-to-
    // department move nets to zero. The old flow decremented on dispatch and
    // incremented the same field on receive, which came to the same nothing.
    await createStockTransfer(TENANT, USER, itemInput() as never);

    expect(prisma.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('refuses to move more than the hospital holds', async () => {
    await expect(
      createStockTransfer(TENANT, USER, itemInput({ quantityRequested: 41 }) as never),
    ).rejects.toThrow(/insufficient stock/i);
    expect(prisma.stockTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses to send a consumable to a ward', async () => {
    await expect(
      createStockTransfer(
        TENANT,
        USER,
        itemInput({ toDepartmentId: undefined, toWardId: WARD }) as never,
      ),
    ).rejects.toThrow();
  });
});
