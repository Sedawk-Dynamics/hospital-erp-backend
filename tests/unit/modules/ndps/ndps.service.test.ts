import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  receiveConsignment,

  recordConsumption,
  logDisposal,
  runDailyClose,
  getStockByLocation,
} from '../../../../src/modules/ndps/ndps.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const ADMIN = ['pharmacy_admin'];
const VAULT = { id: 'vault-1', tenantId: TENANT, name: 'Central Vault', type: 'main_vault' };
const ICU = { id: 'icu-1', tenantId: TENANT, name: 'ICU Cart A', type: 'sub_store' };

beforeEach(() => {
  vi.clearAllMocks();
  // Run transaction callbacks against the prisma mock itself.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.ndpsTransaction.create as any).mockImplementation((args: any) => ({ id: 'txn-1', ...args.data }));
});

const narcotic = (over: any = {}) =>
  (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Morphine', isNarcotic: true, ...over });

describe('NDPS — Form 3C inward', () => {
  it('receives a consignment into the vault and records the statutory fields', async () => {
    narcotic();
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(VAULT);
    (prisma.ndpsStockBalance.findFirst as any).mockResolvedValue(null);
    (prisma.ndpsStockBalance.create as any).mockResolvedValue({ id: 'bal-1', quantity: 50 });

    const txn = await receiveConsignment(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', quantity: 50, ndpsLicenseNumber: 'NDPS-LIC-9', form3cNumber: '3C-2026-01',
      transportDetails: 'TS09AB1234', grossWeight: '1.2kg', batchNumber: 'MOR-01',
    });
    expect(txn.entryType).toBe('inward');
    expect(txn.form3cNumber).toBe('3C-2026-01');
    expect(txn.ndpsLicenseNumber).toBe('NDPS-LIC-9');
    expect(prisma.ndpsStockBalance.create).toHaveBeenCalled();
  });

  it('rejects a drug that is not flagged as an NDPS narcotic', async () => {
    narcotic({ isNarcotic: false });
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(VAULT);
    await expect(
      receiveConsignment(TENANT, USER, ADMIN, { drugFormularyId: 'd1', quantity: 10, ndpsLicenseNumber: 'L', form3cNumber: 'C' }),
    ).rejects.toThrow(/not flagged as an NDPS narcotic/);
  });

  it('blocks a non-admin', async () => {
    await expect(
      receiveConsignment(TENANT, USER, ['pharmacist'], { drugFormularyId: 'd1', quantity: 10, ndpsLicenseNumber: 'L', form3cNumber: 'C' }),
    ).rejects.toThrow();
  });
});

// The dual-authentication challan moved to the stock-transfer board, so its
// rules are tested there now — see tests/unit/modules/inventory/
// transfer-dispatch.test.ts (custody, and the over-draw refusal) and
// transfer-custody.test.ts (the policy itself). Deleting a screen must not
// delete the checks on the rules it enforced.

describe('NDPS — Form 3E consumption', () => {
  it('enforces the mandatory doctor reg / bed / diagnosis fields', async () => {
    narcotic();
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(ICU);
    await expect(
      recordConsumption(TENANT, USER, ADMIN, { drugFormularyId: 'd1', fromLocationId: ICU.id, quantity: 1, patientId: 'p1', doctorRegNo: '', bedNumber: 'B1', diagnosis: 'pain' }),
    ).rejects.toThrow(/registration number is mandatory/);
  });

  it('records a bedside administration with the audit fields', async () => {
    narcotic();
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(ICU);
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    (prisma.ndpsStockBalance.findFirst as any).mockResolvedValue({ id: 'b1', quantity: 10 });
    (prisma.ndpsStockBalance.update as any).mockResolvedValue({});

    const txn = await recordConsumption(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', fromLocationId: ICU.id, quantity: 1, patientId: 'p1',
      doctorRegNo: 'NMC-12345', bedNumber: 'ICU-3', diagnosis: 'post-op analgesia',
    });
    expect(txn.entryType).toBe('dispense');
    expect(txn.doctorRegNo).toBe('NMC-12345');
    expect(txn.bedNumber).toBe('ICU-3');
  });
});

describe('NDPS — disposal', () => {
  it('requires a reference number and a medical-director co-sign', async () => {
    narcotic();
    await expect(
      logDisposal(TENANT, USER, ADMIN, { drugFormularyId: 'd1', locationId: ICU.id, quantity: 1, reasonCode: 'breakage', referenceNumber: '', coSignById: 'md-2' }),
    ).rejects.toThrow(/reference number is mandatory/);
  });

  it('logs a breakage and deducts from the location', async () => {
    narcotic();
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(ICU);
    (prisma.ndpsStockBalance.findFirst as any).mockResolvedValue({ id: 'b1', quantity: 4 });
    (prisma.ndpsStockBalance.update as any).mockResolvedValue({});
    const txn = await logDisposal(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', locationId: ICU.id, quantity: 1, reasonCode: 'breakage', referenceNumber: 'FIR-77/2026', coSignById: 'md-2',
    });
    expect(txn.entryType).toBe('disposal');
    expect(txn.reasonCode).toBe('breakage');
  });
});

describe('NDPS — Form 3H daily close', () => {
  it('computes opening + received − dispensed − disposed = closing', async () => {
    (prisma.drugFormulary.findMany as any).mockResolvedValue([{ id: 'd1', drugName: 'Morphine' }]);
    (prisma.ndpsTransaction.findMany as any).mockResolvedValue([
      { entryType: 'inward', quantity: 50 },
      { entryType: 'dispense', quantity: 12 },
      { entryType: 'disposal', quantity: 1 },
    ]);
    (prisma.ndpsDailyBalance.findFirst as any).mockResolvedValueOnce({ closingBalance: 30 }); // previous day close (opening)
    (prisma.ndpsDailyBalance.findFirst as any).mockResolvedValueOnce(null); // no row for today yet
    (prisma.ndpsStockBalance.aggregate as any).mockResolvedValue({ _sum: { quantity: 67 } });
    (prisma.ndpsDailyBalance.create as any).mockImplementation((args: any) => ({ id: 'dc-1', ...args.data }));

    const r = await runDailyClose(TENANT, '2026-06-19');
    expect(r.count).toBe(1);
    const row = r.rows[0];
    expect(row.openingBalance).toBe(30);
    expect(row.received).toBe(50);
    expect(row.dispensed).toBe(12);
    expect(row.disposed).toBe(1);
    expect(row.closingBalance).toBe(30 + 50 - 12 - 1); // 67
  });
});

describe('NDPS — Inspector stock-by-location', () => {
  it('groups live balances by drug with a per-location breakdown', async () => {
    (prisma.ndpsLocation.findMany as any).mockResolvedValue([VAULT, ICU]);
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(VAULT); // getOrCreateMainVault
    (prisma.ndpsStockBalance.findMany as any).mockResolvedValue([
      { drugFormularyId: 'd1', locationId: VAULT.id, quantity: 50, drug: { id: 'd1', drugName: 'Morphine', strength: '10mg' } },
      { drugFormularyId: 'd1', locationId: ICU.id, quantity: 8, drug: { id: 'd1', drugName: 'Morphine', strength: '10mg' } },
    ]);
    const r = await getStockByLocation(TENANT);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].total).toBe(58);
    expect(r.items[0].locations).toHaveLength(2);
  });
});

describe('NDPS — Form 3E IP-bill posting', () => {
  const armConsumption = () => {
    (prisma.ndpsLocation.findFirst as any).mockResolvedValue(ICU);
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    (prisma.ndpsStockBalance.findFirst as any).mockResolvedValue({ id: 'b1', quantity: 10 });
    (prisma.ndpsStockBalance.update as any).mockResolvedValue({});
  };

  it("posts the dose cost to the patient's active IP bill (opening a draft bill)", async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Morphine', isNarcotic: true, price: 120, taxPercent: 0 });
    armConsumption();
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1' });
    (prisma.bill.findFirst as any).mockResolvedValue(null); // no open bill yet
    (prisma.bill.count as any).mockResolvedValue(0);
    (prisma.bill.create as any).mockImplementation((args: any) => ({ id: 'bill-1', billNumber: args.data.billNumber }));
    (prisma.billItem.create as any).mockResolvedValue({ id: 'bi-1' });
    (prisma.bill.update as any).mockResolvedValue({});

    const res: any = await recordConsumption(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', fromLocationId: ICU.id, quantity: 2, patientId: 'p1', doctorRegNo: 'NMC-1', bedNumber: 'ICU-3', diagnosis: 'pain',
    });

    expect(prisma.bill.create).toHaveBeenCalled();
    const billItemArg = (prisma.billItem.create as any).mock.calls[0][0].data;
    expect(billItemArg.category).toBe('pharmacy');
    expect(billItemArg.totalAmount).toBe(240); // 120 × 2
    expect(billItemArg.referenceType).toBe('ndps_consumption');
    expect(prisma.bill.update).toHaveBeenCalled();
    expect(res.entryType).toBe('dispense');
    expect(res.billing.charged).toBe(240);
  });

  it('appends to the existing open bill rather than creating a new one', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Morphine', isNarcotic: true, price: 50, taxPercent: 12 });
    armConsumption();
    (prisma.admission.findFirst as any).mockResolvedValue(null);
    (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-open', billNumber: 'IPW-1' });
    (prisma.billItem.create as any).mockResolvedValue({ id: 'bi-1' });
    (prisma.bill.update as any).mockResolvedValue({});

    const res: any = await recordConsumption(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', fromLocationId: ICU.id, quantity: 1, patientId: 'p1', doctorRegNo: 'NMC-1', bedNumber: 'B1', diagnosis: 'pain',
    });

    expect(prisma.bill.create).not.toHaveBeenCalled();
    expect((prisma.billItem.create as any).mock.calls[0][0].data.billId).toBe('bill-open');
    expect(res.billing.billId).toBe('bill-open');
    expect(res.billing.charged).toBe(50);
  });

  it('records the consumption but skips billing when the drug has no price', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Morphine', isNarcotic: true, price: null, taxPercent: null });
    armConsumption();

    const res: any = await recordConsumption(TENANT, USER, ADMIN, {
      drugFormularyId: 'd1', fromLocationId: ICU.id, quantity: 1, patientId: 'p1', doctorRegNo: 'NMC-1', bedNumber: 'B1', diagnosis: 'pain',
    });

    expect(res.billing).toBeNull();
    expect(prisma.bill.create).not.toHaveBeenCalled();
    expect(prisma.billItem.create).not.toHaveBeenCalled();
    expect(res.entryType).toBe('dispense');
  });
});
