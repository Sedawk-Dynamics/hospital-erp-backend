import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  computeBillBalance,
  isAdvanceApplication,
} from '../../../../src/modules/billing/bill-payment-ledger';
import {
  allocateAdvanceDrawdown,
  receivableFigures,
  getPatientCharges,
  getCollectionSummary,
  getAdmissionAdvanceBalance,
  collectAdmissionAdvance,
} from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';

beforeEach(() => vi.clearAllMocks());

// Gap item 286 — one balance formula for every bill list.
describe('computeBillBalance', () => {
  it('explains a balance of 500 on a 25,500 bill with 25,000 covered by the insurer', () => {
    const b = computeBillBalance({ total: 25_500, insurerShare: 25_000, patientShare: 500 });
    expect(b.balance).toBe(500);
    expect(b.insurerOutstanding).toBe(25_000);
    expect(b.totalOutstanding).toBe(25_500);
    expect(b.paid).toBe(0);
  });

  it('is lines - concessions - payments - advance applied + refunds without a split', () => {
    const b = computeBillBalance({
      lines: 1_200, total: 1_000, payments: 300, advanceApplied: 200, refunds: 100,
    });
    expect(b.concessions).toBe(200);
    expect(b.balance).toBe(600);
    expect(b.totalOutstanding).toBe(600);
  });

  it('never reads a negative balance when more came in than is owed', () => {
    expect(computeBillBalance({ total: 700, advanceApplied: 1_000 }).balance).toBe(0);
  });

  it('counts insurer money against the insurer share only', () => {
    const b = computeBillBalance({ total: 10_000, insurerShare: 8_000, insurerPaid: 8_000, payments: 500 });
    expect(b.balance).toBe(1_500);
    expect(b.insurerOutstanding).toBe(0);
    expect(b.totalOutstanding).toBe(1_500);
  });
});

// Gap items 360 / 361 — moving held money onto a bill is not new money.
describe('isAdvanceApplication', () => {
  it('recognises a stay deposit applied to a bill and a desk-advance adjustment', () => {
    expect(isAdvanceApplication({ paymentType: 'advance', transactionId: 'IPDEP:adm-1' })).toBe(true);
    expect(isAdvanceApplication({ paymentType: 'regular', sourceAdvancePaymentId: 'adv-1' })).toBe(true);
    expect(isAdvanceApplication({ paymentType: 'regular', notes: 'Adjusted from advance' })).toBe(true);
  });

  it('does not treat a receipt, a cash payment or a refund voucher as an application', () => {
    expect(isAdvanceApplication({ paymentType: 'advance', transactionId: 'IPDEPRCPT:adm-1' })).toBe(false);
    expect(isAdvanceApplication({ paymentType: 'advance', transactionId: null, paymentMethod: 'cash' })).toBe(false);
    expect(isAdvanceApplication({ paymentType: 'regular', paymentMethod: 'cash' })).toBe(false);
    expect(isAdvanceApplication({ paymentType: 'refund', sourceAdvancePaymentId: 'adv-1' })).toBe(false);
  });
});

// Gap item 283 — an adjustment is split across the receipts it draws down.
describe('allocateAdvanceDrawdown', () => {
  it('draws the oldest receipt first and spills onto the next', () => {
    expect(
      allocateAdvanceDrawdown([{ id: 'a', remaining: 500 }, { id: 'b', remaining: 1_000 }], 1_200),
    ).toEqual([{ sourceId: 'a', amount: 500 }, { sourceId: 'b', amount: 700 }]);
  });

  it('skips an exhausted receipt', () => {
    expect(
      allocateAdvanceDrawdown([{ id: 'a', remaining: 0 }, { id: 'b', remaining: 1_000 }], 300),
    ).toEqual([{ sourceId: 'b', amount: 300 }]);
  });
});

// Gap item 287 — every receivable figure reconciles.
describe('receivableFigures', () => {
  it('billed - received - adjusted - disallowed - written off = outstanding', () => {
    const f = receivableFigures(
      { total: 45_200, payments: 4_000, insurerPaid: 2_500, refunds: 200, advanceApplied: 1_000 },
      [{ disallowedAmount: 1_500, writtenOffAmount: 500 }],
    );
    expect(f.received).toBe(6_300);
    expect(f.outstanding).toBe(45_200 - 6_300 - 1_000 - 1_500 - 500);
    expect(f.billed - f.received - f.adjusted - f.disallowed - f.writtenOff).toBe(f.outstanding);
  });
});

// Gap item 338 — the bed charge for every occupied day, never twice.
describe('getPatientCharges room days', () => {
  function mockStay(billedDays: number | null) {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.serviceTariff.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.admission.findMany).mockResolvedValue([
      { id: 'adm-1', visitId: 'v-1', admissionDate: twoDaysAgo, dischargeDate: null, status: 'admitted', bedId: 'bed-1', wardId: 'w-1' },
    ] as never);
    vi.mocked(prisma.patientTransfer.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bed.findMany).mockResolvedValue([{ id: 'bed-1', bedNumber: 'B1', bedType: 'general' }] as never);
    vi.mocked(prisma.ward.findMany).mockResolvedValue([{ id: 'w-1', name: 'General', wardType: 'general', dailyCharge: 500 }] as never);
    const billedRef = billedDays == null
      ? []
      : [{ id: 'item-1', billId: 'bill-1', referenceType: 'admission', referenceId: 'adm-1' }];
    const billedLines = billedDays == null
      ? []
      : [{ id: 'item-1', billId: 'bill-1', referenceId: 'adm-1', quantity: billedDays }];
    vi.mocked(prisma.billItem.findMany)
      .mockResolvedValueOnce(billedRef as never) // indexBilledReferences
      .mockResolvedValueOnce(billedLines as never); // days already billed
  }

  it('pulls every occupied day when nothing is billed yet', async () => {
    mockStay(null);
    const { charges } = await getPatientCharges(TENANT, { patientId: 'p-1', source: 'room' });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ referenceId: 'adm-1', quantity: 3, totalAmount: 1_500 });
  });

  it('adds only the days occupied since the last pull as a top-up line', async () => {
    mockStay(1);
    const { charges } = await getPatientCharges(TENANT, { patientId: 'p-1', source: 'room' });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ referenceId: 'adm-1#1', quantity: 2, totalAmount: 1_000 });
  });

  it('offers nothing once every day is billed', async () => {
    mockStay(3);
    const { charges } = await getPatientCharges(TENANT, { patientId: 'p-1', source: 'room' });
    expect(charges).toHaveLength(0);
  });
});

// Gap item 361 — the same advance is not counted twice.
describe('getCollectionSummary', () => {
  it('counts an advance once, when received, not again when applied', async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([
      { amount: 1_000, paymentType: 'advance', paymentMethod: 'cash', transactionId: 'IPDEPRCPT:adm-1', paymentSource: 'frontdesk' },
      { amount: 700, paymentType: 'advance', paymentMethod: 'advance', transactionId: 'IPDEP:adm-1', paymentSource: null },
      { amount: 300, paymentType: 'regular', paymentMethod: 'cash', transactionId: null, paymentSource: 'frontdesk' },
    ] as never);
    vi.mocked(prisma.bill.findMany).mockResolvedValue([] as never);
    const s = await getCollectionSummary(TENANT, {});
    expect(s.totalCollection).toBe(1_300);
    expect(s.cash).toBe(1_300);
    expect(s.netAdvanceAdjusted).toBe(700);
  });
});

// Gap item 335 — Collect Advance lands on the stay, one balance per admission.
describe('collectAdmissionAdvance', () => {
  it('refuses a discharged stay (gap item 339)', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValue({
      id: 'adm-1', patientId: 'p-1', status: 'discharged', patient: { firstName: 'A', lastName: 'B' },
    } as never);
    await expect(
      collectAdmissionAdvance(TENANT, 'u-1', { admissionId: 'adm-1', amount: 500, paymentMethod: 'cash' }),
    ).rejects.toThrow(/discharged/);
  });

  it('reports collected = deposit + advances, less what was applied', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValue({ depositAmount: 1_500 } as never);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([{ id: 'app-1', amount: 700 }] as never);
    vi.mocked(prisma.refund.findMany).mockResolvedValue([] as never);
    const bal = await getAdmissionAdvanceBalance(TENANT, 'adm-1');
    expect(bal).toMatchObject({ collected: 1_500, applied: 700, available: 800 });
  });
});
