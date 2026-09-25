import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { notifyPatientInsuranceMilestone } from '../../../../src/modules/insurance/insurance.notifications';

describe('patient insurance milestone notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one patient-portal notification and deduplicates retries', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ userId: 'patient-user-1' } as never);
    vi.mocked(prisma.notification.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'notification-1' } as never);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'notification-1' } as never);

    const input = {
      tenantId: 'tenant-1', patientId: 'patient-1', title: 'Insurance claim approved',
      message: 'Approved', referenceType: 'insurance_claim' as const, referenceId: 'claim-1',
    };
    await expect(notifyPatientInsuranceMilestone(input)).resolves.toBe(true);
    await expect(notifyPatientInsuranceMilestone(input)).resolves.toBe(false);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it('never fails the insurance action when notification storage is unavailable', async () => {
    vi.mocked(prisma.patient.findFirst).mockRejectedValue(new Error('notifications unavailable'));
    await expect(notifyPatientInsuranceMilestone({
      tenantId: 'tenant-1', patientId: 'patient-1', title: 'Insurance claim settled',
      message: 'Settled', referenceType: 'insurance_claim', referenceId: 'claim-1',
    })).resolves.toBe(false);
  });
});
