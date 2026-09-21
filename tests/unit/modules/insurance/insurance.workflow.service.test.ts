import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { recordSettlement } from '../../../../src/modules/insurance/insurance.workflow.service';

const settlement = {
  grossApprovedAmount: 10_000,
  grossPaidAmount: 1_001,
  tdsAmount: 0,
  disallowedAmount: 0,
  netPaidAmount: 1_001,
  settlementDate: new Date('2026-09-21'),
};

describe('insurance workflow settlement invariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a remittance that would over-apply the approved amount', async () => {
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
      id: 'claim-1', tenantId: 'tenant-1', status: 'partially_settled', approvedAmount: 10_000,
    } as never);
    vi.mocked(prisma.claimSettlement.aggregate).mockResolvedValue({
      _sum: { grossPaidAmount: 9_000 },
    } as never);

    await expect(recordSettlement('tenant-1', 'user-1', 'claim-1', settlement)).rejects.toMatchObject({
      message: 'Total settlement cannot exceed the claim approved amount',
    });
    expect(prisma.claimSettlement.create).not.toHaveBeenCalled();
  });

  it('rejects a settlement advice carrying a different approved amount', async () => {
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
      id: 'claim-1', tenantId: 'tenant-1', status: 'approved', approvedAmount: 9_500,
    } as never);

    await expect(recordSettlement('tenant-1', 'user-1', 'claim-1', settlement)).rejects.toMatchObject({
      message: 'Settlement approved amount must match the claim approved amount',
    });
    expect(prisma.claimSettlement.create).not.toHaveBeenCalled();
  });
});
