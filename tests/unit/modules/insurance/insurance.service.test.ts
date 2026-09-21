import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';
import {
  createInsurer,
  getInsurers,
  updateInsurer,
  createTPA,
  getTPAs,
  createPolicy,
  getPolicies,
  updatePolicy,
  createClaim,
  getClaims,
  approveClaim,
  rejectClaim,
  createPreAuth,
  getPreAuths,
  approvePreAuth,
  rejectPreAuth,
  updatePreAuth,
  createTpaLog,
  getTpaLogs,
  recordTpaCommunication,
  calculateDelayLiability,
} from '../../../../src/modules/insurance/insurance.service';

// ─── Shared test fixtures ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

describe('final authorization delay liability', () => {
  it('prorates the daily room rate only for time beyond the authorization deadline', () => {
    const dueAt = new Date('2026-09-20T09:00:00.000Z');
    expect(calculateDelayLiability(dueAt, new Date('2026-09-20T12:00:00.000Z'), 2400)).toEqual({ lateMinutes: 180, amount: 300 });
    expect(calculateDelayLiability(dueAt, new Date('2026-09-20T08:59:00.000Z'), 2400)).toEqual({ lateMinutes: 0, amount: 0 });
  });
});

const mockInsurer = {
  id: 'insurer-1',
  tenantId: TENANT_ID,
  name: 'National Health Insurance',
  contactPerson: 'Alice Johnson',
  phone: '+1234567890',
  email: 'alice@nhi.com',
  address: '100 Insurance Ave',
  isActive: true,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockTPA = {
  id: 'tpa-1',
  tenantId: TENANT_ID,
  name: 'MediClaim TPA',
  contactPerson: 'Bob Williams',
  phone: '+0987654321',
  email: 'bob@mediclaim.com',
  address: '200 TPA Blvd',
  isActive: true,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockPatient = {
  id: 'patient-1',
  tenantId: TENANT_ID,
  firstName: 'Charlie',
  lastName: 'Brown',
  phone: '+1112223333',
  email: 'charlie@email.com',
};

const mockPolicy = {
  id: 'policy-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  insurerId: 'insurer-1',
  tpaId: 'tpa-1',
  policyNumber: 'POL-2024-001',
  groupNumber: 'GRP-100',
  planName: 'Gold Plan',
  coverageAmount: 500000,
  coPayPercent: 10,
  deductibleAmount: 5000,
  exclusions: null,
  // Relative to now: a claim is refused unless the policy is valid TODAY, so a
  // hardcoded window silently expires and takes these tests down with it.
  validFrom: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
  validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  status: 'active',
  createdAt: new Date('2024-01-01'),
  patient: { id: 'patient-1', firstName: 'Charlie', lastName: 'Brown' },
  insurer: { id: 'insurer-1', name: 'National Health Insurance' },
  tpa: { id: 'tpa-1', name: 'MediClaim TPA' },
};

const mockBill = {
  id: 'bill-1',
  tenantId: TENANT_ID,
  billNumber: 'BILL-001',
  totalAmount: 25000,
};

const mockClaim = {
  id: 'claim-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  policyId: 'policy-1',
  billId: 'bill-1',
  claimNumber: 'CLM-20240315-0001',
  claimAmount: 20000,
  approvedAmount: null,
  status: 'submitted',
  submissionDate: new Date('2024-03-15'),
  approvalDate: null,
  rejectionReason: null,
  documentsUrl: null,
  submittedBy: USER_ID,
  reviewedBy: null,
  createdAt: new Date('2024-03-15'),
  patient: { id: 'patient-1', firstName: 'Charlie', lastName: 'Brown' },
  policy: { id: 'policy-1', policyNumber: 'POL-2024-001' },
  bill: { id: 'bill-1', billNumber: 'BILL-001', totalAmount: 25000 },
};

const mockPreAuth = {
  id: 'preauth-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  policyId: 'policy-1',
  procedureDescription: 'Knee Replacement Surgery',
  estimatedCost: 150000,
  status: 'pending',
  approvalNumber: null,
  validFrom: null,
  validTo: null,
  notes: 'Urgent procedure needed',
  submittedBy: USER_ID,
  createdAt: new Date('2024-03-15'),
  patient: { id: 'patient-1', firstName: 'Charlie', lastName: 'Brown' },
  policy: { id: 'policy-1', policyNumber: 'POL-2024-001' },
};

// ─── Tests ───

describe('Insurance Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════
  // Insurers
  // ═══════════════════════════════════════════

  describe('createInsurer', () => {
    const insurerInput = {
      name: 'National Health Insurance',
      contactPerson: 'Alice Johnson',
      phone: '+1234567890',
      email: 'alice@nhi.com',
      address: '100 Insurance Ave',
    };

    it('should create an insurer successfully', async () => {
      vi.mocked(prisma.insurer.create).mockResolvedValue(mockInsurer as any);

      const result = await createInsurer(TENANT_ID, insurerInput);

      expect(prisma.insurer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          name: 'National Health Insurance',
          contactPerson: 'Alice Johnson',
          isActive: true,
        }),
      });
      expect(result).toEqual(mockInsurer);
    });

    it('should create an insurer with isActive explicitly set to false', async () => {
      const inactiveInsurer = { ...mockInsurer, isActive: false };
      vi.mocked(prisma.insurer.create).mockResolvedValue(inactiveInsurer as any);

      const result = await createInsurer(TENANT_ID, { ...insurerInput, isActive: false });

      expect(prisma.insurer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isActive: false,
        }),
      });
      expect(result.isActive).toBe(false);
    });
  });

  describe('getInsurers', () => {
    it('should return paginated insurers', async () => {
      vi.mocked(prisma.insurer.findMany).mockResolvedValue([mockInsurer] as any);
      vi.mocked(prisma.insurer.count).mockResolvedValue(1);

      const result = await getInsurers(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        insurers: [mockInsurer],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('should apply search filter when provided', async () => {
      vi.mocked(prisma.insurer.findMany).mockResolvedValue([]);
      vi.mocked(prisma.insurer.count).mockResolvedValue(0);

      await getInsurers(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        search: 'National',
      });

      const call = vi.mocked(prisma.insurer.findMany).mock.calls[0][0];
      expect((call as any).where.OR).toBeDefined();
      expect((call as any).where.OR).toHaveLength(3);
    });
  });

  describe('updateInsurer', () => {
    it('should update an insurer successfully', async () => {
      const updatedInsurer = { ...mockInsurer, name: 'Premium Health Insurance' };
      vi.mocked(prisma.insurer.findFirst).mockResolvedValue(mockInsurer as any);
      vi.mocked(prisma.insurer.update).mockResolvedValue(updatedInsurer as any);

      const result = await updateInsurer(TENANT_ID, 'insurer-1', {
        name: 'Premium Health Insurance',
      });

      expect(prisma.insurer.update).toHaveBeenCalledWith({
        where: { id: 'insurer-1' },
        data: expect.objectContaining({ name: 'Premium Health Insurance' }),
      });
      expect(result.name).toBe('Premium Health Insurance');
    });

    it('should throw notFound if insurer does not exist', async () => {
      vi.mocked(prisma.insurer.findFirst).mockResolvedValue(null);

      await expect(
        updateInsurer(TENANT_ID, 'nonexistent', { name: 'Updated' }),
      ).rejects.toThrow('Insurer not found');
    });
  });

  // ═══════════════════════════════════════════
  // TPA Providers
  // ═══════════════════════════════════════════

  describe('createTPA', () => {
    const tpaInput = {
      name: 'MediClaim TPA',
      contactPerson: 'Bob Williams',
      phone: '+0987654321',
      email: 'bob@mediclaim.com',
      address: '200 TPA Blvd',
    };

    it('should create a TPA provider successfully', async () => {
      vi.mocked(prisma.tpaProvider.create).mockResolvedValue(mockTPA as any);

      const result = await createTPA(TENANT_ID, tpaInput);

      expect(prisma.tpaProvider.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          name: 'MediClaim TPA',
          isActive: true,
        }),
      });
      expect(result).toEqual(mockTPA);
    });
  });

  describe('getTPAs', () => {
    it('should return paginated TPA providers', async () => {
      vi.mocked(prisma.tpaProvider.findMany).mockResolvedValue([mockTPA] as any);
      vi.mocked(prisma.tpaProvider.count).mockResolvedValue(1);

      const result = await getTPAs(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        tpas: [mockTPA],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  // ═══════════════════════════════════════════
  // Insurance Policies
  // ═══════════════════════════════════════════

  describe('createPolicy', () => {
    const policyInput = {
      patientId: 'patient-1',
      insurerId: 'insurer-1',
      tpaId: 'tpa-1',
      policyNumber: 'POL-2024-001',
      groupNumber: 'GRP-100',
      planName: 'Gold Plan',
      coverageAmount: 500000,
      coPayPercent: 10,
      deductibleAmount: 5000,
      validFrom: '2024-01-01',
      validTo: '2025-01-01',
    };

    it('should create a policy successfully', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.insurer.findFirst).mockResolvedValue(mockInsurer as any);
      vi.mocked(prisma.tpaProvider.findFirst).mockResolvedValue(mockTPA as any);
      vi.mocked(prisma.insurancePolicy.create).mockResolvedValue(mockPolicy as any);

      const result = await createPolicy(TENANT_ID, policyInput);

      expect(prisma.patient.findFirst).toHaveBeenCalledWith({
        where: { id: 'patient-1', tenantId: TENANT_ID },
      });
      expect(prisma.insurer.findFirst).toHaveBeenCalledWith({
        where: { id: 'insurer-1', tenantId: TENANT_ID },
      });
      expect(prisma.insurancePolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            insurerId: 'insurer-1',
            policyNumber: 'POL-2024-001',
            coverageAmount: 500000,
          }),
        }),
      );
      expect(result).toEqual(mockPolicy);
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(createPolicy(TENANT_ID, policyInput)).rejects.toThrow('Patient not found');
    });

    it('should throw notFound if insurer does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.insurer.findFirst).mockResolvedValue(null);

      await expect(createPolicy(TENANT_ID, policyInput)).rejects.toThrow('Insurer not found');
    });

    it('should throw notFound if TPA does not exist when tpaId is provided', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.insurer.findFirst).mockResolvedValue(mockInsurer as any);
      vi.mocked(prisma.tpaProvider.findFirst).mockResolvedValue(null);

      await expect(createPolicy(TENANT_ID, policyInput)).rejects.toThrow(
        'TPA provider not found',
      );
    });
  });

  describe('getPolicies', () => {
    it('should return paginated policies', async () => {
      vi.mocked(prisma.insurancePolicy.findMany).mockResolvedValue([mockPolicy] as any);
      vi.mocked(prisma.insurancePolicy.count).mockResolvedValue(1);

      const result = await getPolicies(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        policies: [mockPolicy],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('updatePolicy', () => {
    it('should update a policy successfully', async () => {
      const updatedPolicy = { ...mockPolicy, planName: 'Platinum Plan' };
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.insurancePolicy.update).mockResolvedValue(updatedPolicy as any);

      const result = await updatePolicy(TENANT_ID, 'policy-1', { planName: 'Platinum Plan' });

      expect(result.planName).toBe('Platinum Plan');
    });

    it('should throw notFound if policy does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(null);

      await expect(
        updatePolicy(TENANT_ID, 'nonexistent', { planName: 'Updated' }),
      ).rejects.toThrow('Insurance policy not found');
    });
  });

  // ═══════════════════════════════════════════
  // Insurance Claims
  // ═══════════════════════════════════════════

  describe('createClaim', () => {
    const claimInput = {
      policyId: 'policy-1',
      patientId: 'patient-1',
      billId: 'bill-1',
      claimAmount: 20000,
    };

    it('should create a claim successfully', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBill as any);
      // generateClaimNumber makes ONE lookup — the day's highest number. It used
      // to make a second, re-checking that number for the tenant, which could
      // never fire; queueing a value for a call that no longer happens leaves it
      // in the mock's queue for whatever test runs next.
      vi.mocked(prisma.insuranceClaim.findFirst)
        .mockResolvedValueOnce(null)
        // The new document-completeness gate immediately builds a checklist
        // for the claim it just created, and therefore reads it back three times.
        .mockResolvedValueOnce(mockClaim as any)
        .mockResolvedValueOnce({ ...mockClaim, insuranceCase: null } as any)
        .mockResolvedValueOnce(mockClaim as any);
      vi.mocked(prisma.insuranceClaim.create).mockResolvedValue(mockClaim as any);

      const result = await createClaim(TENANT_ID, USER_ID, claimInput);

      expect(prisma.insuranceClaim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            policyId: 'policy-1',
            billId: 'bill-1',
            claimAmount: 20000,
            status: 'submitted',
            submittedBy: USER_ID,
          }),
        }),
      );
      expect(result).toEqual(mockClaim);
    });

    it('should throw notFound if policy does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(null);

      await expect(
        createClaim(TENANT_ID, USER_ID, claimInput),
      ).rejects.toThrow('Insurance policy not found');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(
        createClaim(TENANT_ID, USER_ID, claimInput),
      ).rejects.toThrow('Patient not found');
    });

    it('should throw notFound if bill does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(
        createClaim(TENANT_ID, USER_ID, claimInput),
      ).rejects.toThrow('Bill not found');
    });
  });

  describe('getClaims', () => {
    it('should return paginated claims', async () => {
      vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([mockClaim] as any);
      vi.mocked(prisma.insuranceClaim.count).mockResolvedValue(1);

      const result = await getClaims(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        claims: [mockClaim],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('approveClaim', () => {
    it('should approve a submitted claim', async () => {
      const approvedClaim = {
        ...mockClaim,
        status: 'approved',
        approvedAmount: 18000,
        approvalDate: new Date(),
        reviewedBy: USER_ID,
      };
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(mockClaim as any);
      vi.mocked(prisma.insuranceClaim.update).mockResolvedValue(approvedClaim as any);

      const result = await approveClaim(TENANT_ID, 'claim-1', USER_ID, {
        approvedAmount: 18000,
      });

      expect(prisma.insuranceClaim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'claim-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedAmount: 18000,
            reviewedBy: USER_ID,
          }),
        }),
      );
      expect(result.status).toBe('approved');
    });

    it('should throw notFound if claim does not exist', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(null);

      await expect(
        approveClaim(TENANT_ID, 'nonexistent', USER_ID, { approvedAmount: 18000 }),
      ).rejects.toThrow('Insurance claim not found');
    });

    it('should throw badRequest if claim is not in reviewable status', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        ...mockClaim,
        status: 'approved',
      } as any);

      try {
        await approveClaim(TENANT_ID, 'claim-1', USER_ID, { approvedAmount: 18000 });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Claim must be under review or submitted to approve',
        );
      }
    });
  });

  describe('rejectClaim', () => {
    it('should reject a submitted claim', async () => {
      const rejectedClaim = {
        ...mockClaim,
        status: 'rejected',
        rejectionReason: 'Insufficient documentation',
        reviewedBy: USER_ID,
      };
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(mockClaim as any);
      vi.mocked(prisma.insuranceClaim.update).mockResolvedValue(rejectedClaim as any);

      const result = await rejectClaim(TENANT_ID, 'claim-1', USER_ID, {
        rejectionReason: 'Insufficient documentation',
      });

      expect(prisma.insuranceClaim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'claim-1' },
          data: expect.objectContaining({
            status: 'rejected',
            rejectionReason: 'Insufficient documentation',
            reviewedBy: USER_ID,
          }),
        }),
      );
      expect(result.status).toBe('rejected');
    });

    it('should throw badRequest if claim is not in reviewable status', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        ...mockClaim,
        status: 'rejected',
      } as any);

      try {
        await rejectClaim(TENANT_ID, 'claim-1', USER_ID, {
          rejectionReason: 'Duplicate claim',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
      }
    });
  });

  // ═══════════════════════════════════════════
  // Pre-Authorization Requests
  // ═══════════════════════════════════════════

  describe('createPreAuth', () => {
    const preAuthInput = {
      patientId: 'patient-1',
      policyId: 'policy-1',
      procedureDescription: 'Knee Replacement Surgery',
      estimatedCost: 150000,
      notes: 'Urgent procedure needed',
    };

    it('should create a pre-authorization request successfully', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.preAuthorizationRequest.create).mockResolvedValue(mockPreAuth as any);

      const result = await createPreAuth(TENANT_ID, USER_ID, preAuthInput);

      expect(prisma.preAuthorizationRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            policyId: 'policy-1',
            procedureDescription: 'Knee Replacement Surgery',
            estimatedCost: 150000,
            status: 'pending',
            submittedBy: USER_ID,
          }),
        }),
      );
      expect(result).toEqual(mockPreAuth);
    });

    it('should throw notFound if policy does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(null);

      await expect(
        createPreAuth(TENANT_ID, USER_ID, preAuthInput),
      ).rejects.toThrow('Insurance policy not found');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(mockPolicy as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(
        createPreAuth(TENANT_ID, USER_ID, preAuthInput),
      ).rejects.toThrow('Patient not found');
    });
  });

  describe('getPreAuths', () => {
    it('should return paginated pre-authorization requests', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([mockPreAuth] as any);
      vi.mocked(prisma.preAuthorizationRequest.count).mockResolvedValue(1);

      const result = await getPreAuths(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        preAuths: [mockPreAuth],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('updatePreAuth', () => {
    it('should update a pending pre-authorization request', async () => {
      const updatedPreAuth = { ...mockPreAuth, estimatedCost: 175000 };
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(mockPreAuth as any);
      vi.mocked(prisma.preAuthorizationRequest.update).mockResolvedValue(updatedPreAuth as any);

      const result = await updatePreAuth(TENANT_ID, 'preauth-1', { estimatedCost: 175000 });

      expect(result.estimatedCost).toBe(175000);
    });

    it('should throw notFound if pre-auth does not exist', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(null);

      await expect(
        updatePreAuth(TENANT_ID, 'nonexistent', { estimatedCost: 200000 }),
      ).rejects.toThrow('Pre-authorization request not found');
    });

    it('should throw badRequest if pre-auth is not in pending status', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue({
        ...mockPreAuth,
        status: 'approved',
      } as any);

      try {
        await updatePreAuth(TENANT_ID, 'preauth-1', { estimatedCost: 200000 });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Can only update pending pre-authorization requests',
        );
      }
    });
  });

  describe('approvePreAuth', () => {
    it('should approve a pending pre-authorization request', async () => {
      const approvedPreAuth = {
        ...mockPreAuth,
        status: 'approved',
        approvalNumber: 'PA-20240315-0001',
        validFrom: new Date('2024-03-15'),
        validTo: new Date('2024-06-15'),
      };
      vi.mocked(prisma.preAuthorizationRequest.findFirst)
        .mockResolvedValueOnce(mockPreAuth as any)   // existence check
        .mockResolvedValueOnce(null);                  // for generatePreAuthRequestNumber
      vi.mocked(prisma.preAuthorizationRequest.update).mockResolvedValue(approvedPreAuth as any);

      const result = await approvePreAuth(TENANT_ID, 'preauth-1', {
        approvalNumber: 'PA-20240315-0001',
        validFrom: '2024-03-15',
        validTo: '2024-06-15',
      });

      expect(prisma.preAuthorizationRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'preauth-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvalNumber: 'PA-20240315-0001',
          }),
        }),
      );
      expect(result.status).toBe('approved');
    });

    it('should throw notFound if pre-auth does not exist', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(null);

      await expect(
        approvePreAuth(TENANT_ID, 'nonexistent', { approvalNumber: 'PA-001' }),
      ).rejects.toThrow('Pre-authorization request not found');
    });

    it('should throw badRequest if pre-auth is not pending', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue({
        ...mockPreAuth,
        status: 'approved',
      } as any);

      try {
        await approvePreAuth(TENANT_ID, 'preauth-1', { approvalNumber: 'PA-001' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Can only approve pending or on-hold pre-authorization requests',
        );
      }
    });
  });

  describe('rejectPreAuth', () => {
    it('should reject a pending pre-authorization request', async () => {
      const rejectedPreAuth = {
        ...mockPreAuth,
        status: 'denied',
        notes: 'Procedure not covered under plan',
      };
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(mockPreAuth as any);
      vi.mocked(prisma.preAuthorizationRequest.update).mockResolvedValue(rejectedPreAuth as any);

      const result = await rejectPreAuth(TENANT_ID, 'preauth-1', {
        notes: 'Procedure not covered under plan',
      });

      expect(prisma.preAuthorizationRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'preauth-1' },
          data: expect.objectContaining({
            status: 'denied',
            notes: 'Procedure not covered under plan',
          }),
        }),
      );
      expect(result.status).toBe('denied');
    });

    it('should throw badRequest if pre-auth is not pending', async () => {
      vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue({
        ...mockPreAuth,
        status: 'denied',
      } as any);

      try {
        await rejectPreAuth(TENANT_ID, 'preauth-1', { notes: 'Denied' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Can only deny pending or on-hold pre-authorization requests',
        );
      }
    });
  });
});

// ═══════════════════════════════════════════
// TPA communication logs
// ═══════════════════════════════════════════

describe('TPA communication logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTpaLog', () => {
    it('files the entry against the claim and takes the TPA from its policy', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        id: 'claim-1',
        policy: { tpaId: 'tpa-1' },
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockResolvedValue({ id: 'log-1' } as any);

      await createTpaLog(TENANT_ID, USER_ID, {
        claimId: 'claim-1',
        communicationType: 'phone',
        direction: 'inbound',
        subject: 'Called about the settlement',
        content: 'Transfer goes out on Friday.',
      });

      expect(prisma.tpaCommunicationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            claimId: 'claim-1',
            tpaId: 'tpa-1',
            isSystem: false,
            communicatedBy: USER_ID,
          }),
        }),
      );
    });

    it('leaves the TPA null when the policy names none', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        id: 'claim-1',
        policy: { tpaId: null },
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockResolvedValue({ id: 'log-1' } as any);

      await createTpaLog(TENANT_ID, USER_ID, {
        claimId: 'claim-1',
        communicationType: 'email',
        direction: 'outbound',
        subject: 'Chasing the settlement',
      });

      const arg = vi.mocked(prisma.tpaCommunicationLog.create).mock.calls[0][0] as any;
      expect(arg.data.tpaId).toBeNull();
    });

    it('refuses a claim belonging to another hospital', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(null);

      await expect(
        createTpaLog(TENANT_ID, USER_ID, {
          claimId: 'someone-elses-claim',
          communicationType: 'phone',
          direction: 'inbound',
          subject: 'Called',
        }),
      ).rejects.toThrow('Insurance claim not found');
      expect(prisma.tpaCommunicationLog.create).not.toHaveBeenCalled();
    });

    it('refuses a TPA belonging to another hospital', async () => {
      vi.mocked(prisma.tpaProvider.findFirst).mockResolvedValue(null);

      await expect(
        createTpaLog(TENANT_ID, USER_ID, {
          tpaId: 'someone-elses-tpa',
          communicationType: 'phone',
          direction: 'inbound',
          subject: 'Called',
        }),
      ).rejects.toThrow('TPA provider not found');
      expect(prisma.tpaCommunicationLog.create).not.toHaveBeenCalled();
    });
  });

  describe('getTpaLogs', () => {
    it('applies every filter it is given', async () => {
      vi.mocked(prisma.tpaCommunicationLog.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.tpaCommunicationLog.count).mockResolvedValue(0);

      await getTpaLogs(TENANT_ID, {
        claimId: 'claim-1',
        direction: 'inbound',
        communicationType: 'phone',
        isSystem: false,
        page: 1,
        limit: 20,
      });

      const arg = vi.mocked(prisma.tpaCommunicationLog.findMany).mock.calls[0][0] as any;
      expect(arg.where).toMatchObject({
        tenantId: TENANT_ID,
        claimId: 'claim-1',
        direction: 'inbound',
        communicationType: 'phone',
        isSystem: false,
      });
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('keeps an isSystem filter of false rather than treating it as absent', async () => {
      vi.mocked(prisma.tpaCommunicationLog.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.tpaCommunicationLog.count).mockResolvedValue(0);

      await getTpaLogs(TENANT_ID, { isSystem: false, page: 1, limit: 20 });

      const arg = vi.mocked(prisma.tpaCommunicationLog.findMany).mock.calls[0][0] as any;
      expect(arg.where.isSystem).toBe(false);
    });
  });

  describe('recordTpaCommunication', () => {
    it('marks what the lifecycle writes as system-written', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        policy: { tpaId: 'tpa-1' },
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockResolvedValue({ id: 'log-1' } as any);

      const wrote = await recordTpaCommunication({
        tenantId: TENANT_ID,
        claimId: 'claim-1',
        userId: USER_ID,
        direction: 'outbound',
        subject: 'Claim CLM-1 submitted for review',
      });

      expect(wrote).toBe(true);
      const arg = vi.mocked(prisma.tpaCommunicationLog.create).mock.calls[0][0] as any;
      expect(arg.data.isSystem).toBe(true);
      expect(arg.data.tpaId).toBe('tpa-1');
    });

    it('trims a subject longer than the column instead of losing the entry', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        policy: { tpaId: null },
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockResolvedValue({ id: 'log-1' } as any);

      await recordTpaCommunication({
        tenantId: TENANT_ID,
        claimId: 'claim-1',
        direction: 'outbound',
        subject: 'x'.repeat(400),
      });

      const arg = vi.mocked(prisma.tpaCommunicationLog.create).mock.calls[0][0] as any;
      expect(arg.data.subject).toHaveLength(255);
    });

    it('reports failure instead of throwing', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
        policy: { tpaId: null },
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockRejectedValue(new Error('column went away'));

      await expect(
        recordTpaCommunication({
          tenantId: TENANT_ID,
          claimId: 'claim-1',
          direction: 'outbound',
          subject: 'Claim submitted',
        }),
      ).resolves.toBe(false);
    });
  });

  describe('a failed log never undoes the action it describes', () => {
    it('approves the claim even when the log write fails', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(mockClaim as any);
      vi.mocked(prisma.insuranceClaim.update).mockResolvedValue({
        ...mockClaim,
        status: 'approved',
        approvedAmount: 18000,
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockRejectedValue(new Error('log table is gone'));

      const result = await approveClaim(TENANT_ID, 'claim-1', USER_ID, { approvedAmount: 18000 });

      expect(result.status).toBe('approved');
      expect(prisma.insuranceClaim.update).toHaveBeenCalled();
    });

    it('rejects the claim even when the log write fails', async () => {
      vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue(mockClaim as any);
      vi.mocked(prisma.insuranceClaim.update).mockResolvedValue({
        ...mockClaim,
        status: 'rejected',
      } as any);
      vi.mocked(prisma.tpaCommunicationLog.create).mockRejectedValue(new Error('log table is gone'));

      const result = await rejectClaim(TENANT_ID, 'claim-1', USER_ID, {
        rejectionReason: 'Not covered',
      });

      expect(result.status).toBe('rejected');
    });
  });
});
