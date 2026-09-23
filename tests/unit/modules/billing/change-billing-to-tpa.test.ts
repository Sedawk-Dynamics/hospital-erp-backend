import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';

const insuranceMocks = vi.hoisted(() => ({
  findActivePolicyForPatient: vi.fn(),
  createClaim: vi.fn(),
  applyBillSplit: vi.fn(),
  resyncClaimAmount: vi.fn(),
}));

vi.mock('../../../../src/modules/insurance/insurance.service', () => insuranceMocks);

import { changeAdmissionBillingToTpa } from '../../../../src/modules/billing/billing.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'billing-user-1';
const ADMISSION_ID = 'admission-1';
const PATIENT_ID = 'patient-1';

const policy = {
  id: 'policy-1',
  patientId: PATIENT_ID,
  policyNumber: 'POL-1001',
  insurer: { id: 'insurer-1', name: 'Safe Health', gstin: null, stateCode: null },
  tpa: { id: 'tpa-1', name: 'Care TPA', gstin: null, stateCode: null },
};

describe('changeAdmissionBillingToTpa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insuranceMocks.findActivePolicyForPatient.mockResolvedValue(policy);
    vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(policy as never);
    vi.mocked(prisma.bill.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: 'audit-1' } as never);
  });

  it('changes an active cash admission and connects its policy without finalising the bill', async () => {
    vi.mocked(prisma.admission.findFirst)
      .mockResolvedValueOnce({
        id: ADMISSION_ID,
        patientId: PATIENT_ID,
        billingCategory: 'cash',
        status: 'admitted',
      } as never)
      .mockResolvedValueOnce({
        id: ADMISSION_ID,
        patientId: PATIENT_ID,
        billingCategory: 'insurance',
        status: 'admitted',
      } as never);
    vi.mocked(prisma.admission.update).mockResolvedValue({ id: ADMISSION_ID } as never);

    const result = await changeAdmissionBillingToTpa(TENANT_ID, USER_ID, ADMISSION_ID);

    expect(prisma.admission.update).toHaveBeenCalledWith({
      where: { id: ADMISSION_ID },
      data: { billingCategory: 'insurance' },
    });
    expect(result).toMatchObject({
      admission: { id: ADMISSION_ID, billingCategory: 'insurance' },
      policy: { id: 'policy-1', policyNumber: 'POL-1001' },
      claim: null,
      connected: true,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        entityType: 'admission',
        entityId: ADMISSION_ID,
        oldValues: { billingCategory: 'cash' },
        newValues: { billingCategory: 'insurance', policyId: 'policy-1' },
      }),
    });
  });

  it('rejects a selected policy that does not belong to the admitted patient', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValue({
      id: ADMISSION_ID,
      patientId: PATIENT_ID,
      billingCategory: 'cash',
      status: 'admitted',
    } as never);
    vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(null);

    await expect(
      changeAdmissionBillingToTpa(TENANT_ID, USER_ID, ADMISSION_ID, { policyId: 'other-policy' }),
    ).rejects.toThrow('The selected insurance policy is not valid for this patient.');

    expect(prisma.insurancePolicy.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'other-policy', tenantId: TENANT_ID, patientId: PATIENT_ID, status: 'active' },
    }));
    expect(prisma.admission.update).not.toHaveBeenCalled();
  });
});
