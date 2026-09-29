import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { applyPaymentToBill } from '../../../../src/modules/billing/bill-payment-ledger';

describe('bill payment ledger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves only the genuine patient share due after the TPA pays its split', async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      totalAmount: 17_900,
      insuranceCoveredAmount: 12_000,
      patientPayableAmount: 5_900,
      status: 'finalized',
    } as never);
    vi.mocked(prisma.payment.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 12_000 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.refund.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.bill.update).mockResolvedValue({ id: 'bill-1' } as never);

    await applyPaymentToBill(prisma as never, 'bill-1');

    expect(prisma.bill.update).toHaveBeenCalledWith({
      where: { id: 'bill-1' },
      data: {
        amountPaid: 12_000,
        balanceDue: 5_900,
        status: 'partially_paid',
      },
    });
  });

  it('does not expose a partially unpaid TPA share as patient due', async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      totalAmount: 17_900,
      insuranceCoveredAmount: 12_000,
      patientPayableAmount: 5_900,
      status: 'pending',
    } as never);
    vi.mocked(prisma.payment.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 400 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.refund.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.bill.update).mockResolvedValue({ id: 'bill-1' } as never);

    await applyPaymentToBill(prisma as never, 'bill-1');

    expect(prisma.bill.update).toHaveBeenCalledWith({
      where: { id: 'bill-1' },
      data: {
        amountPaid: 400,
        balanceDue: 5_900,
        status: 'partially_paid',
      },
    });
  });

  it('repairs a missing historical bill split from the settled approved claim', async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      totalAmount: 17_900,
      insuranceCoveredAmount: 0,
      patientPayableAmount: 17_900,
      status: 'pending',
      insuranceClaims: [{ approvedAmount: 15_000, coveredAmount: 15_000, claimAmount: 15_000 }],
    } as never);
    vi.mocked(prisma.payment.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 15_000 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.refund.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.bill.update).mockResolvedValue({ id: 'bill-1' } as never);

    await applyPaymentToBill(prisma as never, 'bill-1');

    expect(prisma.bill.update).toHaveBeenCalledWith({
      where: { id: 'bill-1' },
      data: {
        amountPaid: 15_000,
        balanceDue: 2_900,
        status: 'partially_paid',
        insuranceCoveredAmount: 15_000,
        patientPayableAmount: 2_900,
      },
    });
  });

  it('clears due and marks the bill paid when TPA and patient collections cover it', async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      totalAmount: 17_900,
      insuranceCoveredAmount: 12_000,
      patientPayableAmount: 5_900,
      status: 'partially_paid',
    } as never);
    vi.mocked(prisma.payment.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 17_900 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 5_900 } } as never);
    vi.mocked(prisma.refund.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 0 } } as never);
    vi.mocked(prisma.bill.update).mockResolvedValue({ id: 'bill-1' } as never);

    await applyPaymentToBill(prisma as never, 'bill-1');

    expect(prisma.bill.update).toHaveBeenCalledWith({
      where: { id: 'bill-1' },
      data: {
        amountPaid: 17_900,
        balanceDue: 0,
        status: 'paid',
      },
    });
  });
});
