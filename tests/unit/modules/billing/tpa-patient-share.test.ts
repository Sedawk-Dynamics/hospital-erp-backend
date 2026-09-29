import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getAdmissionOutstanding } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';
const ADMISSION = 'admission-1';

function splitBill() {
  vi.mocked(prisma.admission.findFirst).mockResolvedValue({
    id: ADMISSION,
    patientId: 'patient-1',
    visitId: null,
    depositAmount: 0,
  } as never);
  vi.mocked(prisma.bill.findMany).mockResolvedValue([
    {
      id: 'bill-1',
      amountPaid: 12_000,
      discountAmount: 0,
      insuranceCoveredAmount: 12_000,
      billItems: [
        {
          totalAmount: 17_900,
          referenceType: null,
          referenceId: null,
          description: 'Final hospital bill',
        },
      ],
    },
  ] as never);
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.refund.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.refund.aggregate).mockResolvedValue({ _sum: { amount: 0 } } as never);
}

describe('TPA patient-share clearance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitBill();
  });

  it('does not count a TPA remittance as payment of the patient share', async () => {
    vi.mocked(prisma.payment.aggregate).mockResolvedValue({ _sum: { amount: 0 } } as never);

    const result = await getAdmissionOutstanding(TENANT, ADMISSION);

    expect(result.insuranceCovered).toBe(12_000);
    expect(result.balanceAfterDeposit).toBe(5_900);
    expect(result.isCleared).toBe(false);
  });

  it('clears only after the patient has paid the patient share', async () => {
    vi.mocked(prisma.payment.aggregate).mockResolvedValue({ _sum: { amount: 5_900 } } as never);

    const result = await getAdmissionOutstanding(TENANT, ADMISSION);

    expect(result.cashPaid).toBe(5_900);
    expect(result.balanceAfterDeposit).toBe(0);
    expect(result.isCleared).toBe(true);
  });
});
