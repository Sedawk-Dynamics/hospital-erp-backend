import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  receiveConsignment,
  recordConsumption,
  logDisposal,
} from '../../../../src/modules/ndps/ndps.service';

/**
 * Narcotic stock used to live in a ledger of its own, disconnected from
 * DrugBatch — invisible to valuation, expiry alerts, recalls and GST, with
 * Form 3C's batch number and expiry as free-typed strings nothing checked.
 *
 * These tests pin the property that unification depends on: anything which
 * changes the narcotic TOTAL now changes real batch stock as well, so the
 * statutory register and the shelf cannot drift apart again.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';
const ADMIN_ROLES = ['pharmacy_admin'];
const DRUG = 'drug-1';

const tx = {
  drugBatch: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  ndpsStockBalance: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  ndpsTransaction: { create: vi.fn() },
  bill: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  billItem: { create: vi.fn() },
  admission: { findFirst: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(tx).forEach((m) => Object.values(m).forEach((f: any) => f.mockReset?.()));

  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(tx));
  (prisma.drugFormulary.findFirst as any).mockResolvedValue({
    id: DRUG, drugName: 'Morphine', isNarcotic: true, price: 0, taxPercent: 0,
  });
  (prisma.ndpsLocation.findFirst as any).mockResolvedValue({ id: 'vault-1', type: 'main_vault' });
  (prisma.patient.findFirst as any).mockResolvedValue({ id: 'pat-1' });

  tx.ndpsStockBalance.findFirst.mockResolvedValue({ id: 'bal-1', quantity: 500 });
  tx.ndpsStockBalance.update.mockResolvedValue({});
  tx.ndpsTransaction.create.mockImplementation(async (a: any) => ({ id: 'txn-1', ...a.data }));
  tx.drugBatch.create.mockResolvedValue({ id: 'batch-new' });
  tx.drugBatch.update.mockResolvedValue({});
  tx.drugBatch.findFirst.mockResolvedValue(null);
  tx.drugBatch.findMany.mockResolvedValue([]);
});

describe('Form 3C inward creates real stock', () => {
  it('creates a DrugBatch, so the consignment is visible to valuation and expiry', async () => {
    await receiveConsignment(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG,
      quantity: 10,
      ndpsLicenseNumber: 'LIC-1',
      form3cNumber: '3C-991',
      batchNumber: 'FEN-B901',
      expiryDate: '2028-05-31',
    });

    expect(tx.drugBatch.create).toHaveBeenCalled();
    const arg = tx.drugBatch.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      drugId: DRUG, batchNumber: 'FEN-B901', quantityInStock: 10, quantityReceived: 10,
    });
  });

  it('links the register entry to the batch it created', async () => {
    await receiveConsignment(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, quantity: 10, ndpsLicenseNumber: 'L', form3cNumber: '3C-1',
    });
    expect(tx.ndpsTransaction.create.mock.calls[0][0].data.drugBatchId).toBe('batch-new');
  });

  it('falls back to the Form 3C note number so a batch always has an identity', async () => {
    await receiveConsignment(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, quantity: 5, ndpsLicenseNumber: 'L', form3cNumber: '991',
    });
    expect(tx.drugBatch.create.mock.calls[0][0].data.batchNumber).toBe('3C-991');
  });

  it('tops up the same batch on a split delivery instead of duplicating it', async () => {
    tx.drugBatch.findFirst.mockResolvedValue({ id: 'batch-existing' });
    tx.drugBatch.update.mockResolvedValue({ id: 'batch-existing' });

    await receiveConsignment(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, quantity: 4, ndpsLicenseNumber: 'L',
      form3cNumber: '3C-1', batchNumber: 'FEN-B901',
    });

    expect(tx.drugBatch.create).not.toHaveBeenCalled();
    expect(tx.drugBatch.update.mock.calls[0][0].data).toMatchObject({
      quantityInStock: { increment: 4 },
    });
  });
});

describe('consumption and disposal take real stock too', () => {
  it('draws a bedside dose from batch stock, earliest expiry first', async () => {
    tx.drugBatch.findMany.mockResolvedValue([
      { id: 'b-old', quantityInStock: 2 },
      { id: 'b-new', quantityInStock: 10 },
    ]);

    await recordConsumption(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, fromLocationId: 'vault-1', quantity: 5,
      patientId: 'pat-1', doctorRegNo: 'NMC-1', bedNumber: 'B-1', diagnosis: 'pain',
    });

    // 2 off the earliest-expiring batch, the remaining 3 off the next.
    expect(tx.drugBatch.update).toHaveBeenCalledTimes(2);
    expect(tx.drugBatch.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'b-old' }, data: { quantityInStock: { decrement: 2 } },
    });
    expect(tx.drugBatch.update.mock.calls[1][0]).toMatchObject({
      where: { id: 'b-new' }, data: { quantityInStock: { decrement: 3 } },
    });
  });

  it('records which batch the dose came from', async () => {
    tx.drugBatch.findMany.mockResolvedValue([{ id: 'b-old', quantityInStock: 10 }]);
    await recordConsumption(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, fromLocationId: 'vault-1', quantity: 1,
      patientId: 'pat-1', doctorRegNo: 'NMC-1', bedNumber: 'B-1', diagnosis: 'pain',
    });
    expect(tx.ndpsTransaction.create.mock.calls[0][0].data.drugBatchId).toBe('b-old');
  });

  it('takes a destroyed vial out of real stock as well as the register', async () => {
    tx.drugBatch.findMany.mockResolvedValue([{ id: 'b-1', quantityInStock: 10 }]);
    await logDisposal(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, locationId: 'vault-1', quantity: 3,
      reasonCode: 'breakage', referenceNumber: 'FIR-1', coSignById: 'user-2',
    });
    expect(tx.drugBatch.update.mock.calls[0][0].data).toMatchObject({
      quantityInStock: { decrement: 3 },
    });
  });

  it('still records a consumption when the batch side has nothing left', async () => {
    // The location balance is authoritative for the statutory register. Refusing
    // a legally-recorded consumption because batch stock is behind would be the
    // wrong failure — the register must stay complete.
    tx.drugBatch.findMany.mockResolvedValue([]);
    const r = await recordConsumption(TENANT, USER, ADMIN_ROLES, {
      drugFormularyId: DRUG, fromLocationId: 'vault-1', quantity: 1,
      patientId: 'pat-1', doctorRegNo: 'NMC-1', bedNumber: 'B-1', diagnosis: 'pain',
    });
    expect(r).toBeTruthy();
    expect(tx.ndpsTransaction.create.mock.calls[0][0].data.drugBatchId).toBeNull();
  });
});
