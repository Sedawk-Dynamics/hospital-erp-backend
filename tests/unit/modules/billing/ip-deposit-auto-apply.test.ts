import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { consolidateAdmissionBill } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';
const ADMISSION = 'admission-1';
const PATIENT = 'patient-1';
const USER = 'user-1';
const BILL = 'bill-1';

/**
 * Set the mocks up so the stay has `deposit` on file, none of it applied yet,
 * and a bill owing `balance`.
 */
function scenario({ deposit, balance }: { deposit: number; balance: number }) {
  vi.mocked(prisma.admission.findFirst).mockResolvedValue({ id: ADMISSION, patientId: PATIENT, depositAmount: deposit } as never);
  vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: PATIENT, tenantId: TENANT } as never);
  // getOrCreateRunningIpBill -> an open draft; then every balance read.
  vi.mocked(prisma.bill.findFirst).mockResolvedValue({ id: BILL, status: 'draft', balanceDue: balance, billNumber: 'IPW-1' } as never);
  vi.mocked(prisma.bill.findUnique).mockResolvedValue({ id: BILL, status: 'draft' } as never);
  // no deposit payments recorded yet, and no advance bucket rows
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.refund.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.billItem.findMany).mockResolvedValue([] as never);
  // 0 items so finalizeBill (a much larger surface) is skipped — the deposit
  // application is gated on `finalize` being ASKED for, not on it firing.
  vi.mocked(prisma.billItem.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.insuranceClaim.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.discount.aggregate).mockResolvedValue({ _sum: { value: null } } as never);
  vi.mocked(prisma.payment.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);
  vi.mocked(prisma.refund.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);
  vi.mocked(prisma.bill.update).mockResolvedValue({ id: BILL, status: 'draft' } as never);
  vi.mocked(prisma.payment.create).mockResolvedValue({ id: 'pay-1' } as never);
}

beforeEach(() => vi.clearAllMocks());

/**
 * A deposit taken at admission used to sit untouched until somebody pressed
 * "Apply to bill", so the counter was shown — and could collect — the full
 * amount while the hospital was already holding part of it. Preparing a bill
 * for payment now sets that money against it first.
 */
describe('consolidateAdmissionBill — the deposit comes off before the counter asks', () => {
  it('applies the deposit when the bill is prepared for payment', async () => {
    scenario({ deposit: 1000, balance: 6700 });

    await consolidateAdmissionBill(TENANT, USER, ADMISSION, { finalize: true });

    const deposits = vi.mocked(prisma.payment.create).mock.calls
      .map((c) => c[0]!.data as any)
      .filter((d) => String(d.transactionId ?? '').startsWith('IPDEP:'));
    expect(deposits).toHaveLength(1);
    expect(Number(deposits[0].amount)).toBe(1000);
  });

  /** Never more than the bill owes — a deposit must not overpay a bill. */
  it('applies only up to the balance when the deposit is larger', async () => {
    scenario({ deposit: 15000, balance: 500 });

    await consolidateAdmissionBill(TENANT, USER, ADMISSION, { finalize: true });

    const deposits = vi.mocked(prisma.payment.create).mock.calls
      .map((c) => c[0]!.data as any)
      .filter((d) => String(d.transactionId ?? '').startsWith('IPDEP:'));
    expect(deposits).toHaveLength(1);
    expect(Number(deposits[0].amount)).toBe(500);
  });

  it('does nothing when the bill owes nothing', async () => {
    scenario({ deposit: 1000, balance: 0 });

    await consolidateAdmissionBill(TENANT, USER, ADMISSION, { finalize: true });

    const deposits = vi.mocked(prisma.payment.create).mock.calls
      .map((c) => c[0]!.data as any)
      .filter((d) => String(d.transactionId ?? '').startsWith('IPDEP:'));
    expect(deposits).toHaveLength(0);
  });

  /**
   * Idempotent: once the deposit has been recorded against the stay there is
   * nothing left to apply, so refreshing the bill again must not take it twice.
   */
  it('does not apply the same deposit twice', async () => {
    scenario({ deposit: 1000, balance: 6700 });
    vi.mocked(prisma.payment.findMany).mockResolvedValue([{ id: 'p1', amount: 1000, billId: BILL }] as never);

    await consolidateAdmissionBill(TENANT, USER, ADMISSION, { finalize: true });

    const deposits = vi.mocked(prisma.payment.create).mock.calls
      .map((c) => c[0]!.data as any)
      .filter((d) => String(d.transactionId ?? '').startsWith('IPDEP:'));
    expect(deposits).toHaveLength(0);
  });

  /** Only when the bill is being closed for payment. */
  it('leaves the deposit alone when not finalizing', async () => {
    scenario({ deposit: 1000, balance: 6700 });

    await consolidateAdmissionBill(TENANT, USER, ADMISSION, {});

    const deposits = vi.mocked(prisma.payment.create).mock.calls
      .map((c) => c[0]!.data as any)
      .filter((d) => String(d.transactionId ?? '').startsWith('IPDEP:'));
    expect(deposits).toHaveLength(0);
  });
});
