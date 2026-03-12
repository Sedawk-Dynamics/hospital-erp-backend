import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';
import {
  registerDonor,
  getDonors,
  updateDonor,
  recordDonation,
  getDonations,
  getBloodInventory,
  updateBloodUnit,
  addBloodUnit,
  requestCrossMatch,
  getCrossMatches,
  completeCrossMatch,
  requestTransfusion,
  getTransfusions,
} from '../../../../src/modules/blood-bank/blood-bank.service';

// ─── Shared test fixtures ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

const mockDonor = {
  id: 'donor-1',
  tenantId: TENANT_ID,
  firstName: 'David',
  lastName: 'Miller',
  dateOfBirth: new Date('1985-06-15'),
  gender: 'male',
  bloodGroup: 'O+',
  phone: '+1234567890',
  email: 'david@email.com',
  address: '456 Oak St',
  healthStatus: 'healthy',
  isEligible: true,
  lastDonationDate: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockDonation = {
  id: 'donation-1',
  tenantId: TENANT_ID,
  donorId: 'donor-1',
  donationDate: new Date('2024-03-15'),
  donationType: 'whole_blood',
  volumeMl: 450,
  bagNumber: 'BAG-001',
  screeningResult: 'pending',
  notes: null,
  collectedBy: USER_ID,
  createdAt: new Date('2024-03-15'),
  donor: { id: 'donor-1', firstName: 'David', lastName: 'Miller', bloodGroup: 'O+' },
};

const mockBloodUnit = {
  id: 'unit-1',
  tenantId: TENANT_ID,
  donationId: 'donation-1',
  componentType: 'whole_blood',
  bloodGroup: 'O+',
  bagNumber: 'INV-BAG-001',
  volumeMl: 450,
  collectionDate: new Date('2024-03-15'),
  expiryDate: new Date('2024-04-15'),
  storageLocation: 'Fridge-A-01',
  status: 'available',
  createdAt: new Date('2024-03-15'),
};

const mockPatient = {
  id: 'patient-1',
  tenantId: TENANT_ID,
  firstName: 'Emma',
  lastName: 'Wilson',
  bloodGroup: 'O+',
};

const mockCrossMatch = {
  id: 'cm-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  bloodInventoryId: 'unit-1',
  result: 'pending',
  testedBy: null,
  testedAt: null,
  notes: null,
  createdAt: new Date('2024-03-16'),
};

const mockTransfusion = {
  id: 'tf-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  visitId: 'visit-1',
  bloodInventoryId: 'unit-1',
  crossMatchId: 'cm-1',
  transfusionDate: new Date('2024-03-16'),
  volumeMl: 450,
  orderedBy: 'doctor-1',
  administeredBy: 'nurse-1',
  adverseReaction: false,
  reactionDetails: null,
  notes: null,
  createdAt: new Date('2024-03-16'),
};

// ─── Tests ───

describe('Blood Bank Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════
  // Donors
  // ═══════════════════════════════════════════

  describe('registerDonor', () => {
    const donorInput = {
      firstName: 'David',
      lastName: 'Miller',
      dateOfBirth: '1985-06-15',
      gender: 'male',
      bloodGroup: 'O+',
      phone: '+1234567890',
      email: 'david@email.com',
      address: '456 Oak St',
      healthStatus: 'healthy',
    };

    it('should register a new blood donor successfully', async () => {
      vi.mocked(prisma.bloodDonor.create).mockResolvedValue(mockDonor as any);

      const result = await registerDonor(TENANT_ID, donorInput);

      expect(prisma.bloodDonor.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          firstName: 'David',
          lastName: 'Miller',
          bloodGroup: 'O+',
          isEligible: true,
        }),
      });
      expect(result).toEqual(mockDonor);
    });

    it('should register a donor with isEligible set to false', async () => {
      const ineligibleDonor = { ...mockDonor, isEligible: false };
      vi.mocked(prisma.bloodDonor.create).mockResolvedValue(ineligibleDonor as any);

      const result = await registerDonor(TENANT_ID, { ...donorInput, isEligible: false });

      expect(prisma.bloodDonor.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isEligible: false,
        }),
      });
      expect(result.isEligible).toBe(false);
    });
  });

  describe('getDonors', () => {
    it('should return paginated donors', async () => {
      vi.mocked(prisma.bloodDonor.findMany).mockResolvedValue([mockDonor] as any);
      vi.mocked(prisma.bloodDonor.count).mockResolvedValue(1);

      const result = await getDonors(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        donors: [mockDonor],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('should filter donors by blood group', async () => {
      vi.mocked(prisma.bloodDonor.findMany).mockResolvedValue([mockDonor] as any);
      vi.mocked(prisma.bloodDonor.count).mockResolvedValue(1);

      await getDonors(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        bloodGroup: 'O+',
      });

      const call = vi.mocked(prisma.bloodDonor.findMany).mock.calls[0][0];
      expect((call as any).where.bloodGroup).toBe('O+');
    });

    it('should apply search filter when provided', async () => {
      vi.mocked(prisma.bloodDonor.findMany).mockResolvedValue([]);
      vi.mocked(prisma.bloodDonor.count).mockResolvedValue(0);

      await getDonors(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        search: 'David',
      });

      const call = vi.mocked(prisma.bloodDonor.findMany).mock.calls[0][0];
      expect((call as any).where.OR).toBeDefined();
      expect((call as any).where.OR).toHaveLength(4);
    });
  });

  describe('updateDonor', () => {
    it('should update a donor successfully', async () => {
      const updatedDonor = { ...mockDonor, phone: '+9999999999' };
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue(mockDonor as any);
      vi.mocked(prisma.bloodDonor.update).mockResolvedValue(updatedDonor as any);

      const result = await updateDonor(TENANT_ID, 'donor-1', { phone: '+9999999999' });

      expect(prisma.bloodDonor.findFirst).toHaveBeenCalledWith({
        where: { id: 'donor-1', tenantId: TENANT_ID },
      });
      expect(result.phone).toBe('+9999999999');
    });

    it('should throw notFound if donor does not exist', async () => {
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue(null);

      await expect(
        updateDonor(TENANT_ID, 'nonexistent', { phone: '+0000000000' }),
      ).rejects.toThrow('Blood donor not found');
    });
  });

  // ═══════════════════════════════════════════
  // Donations
  // ═══════════════════════════════════════════

  describe('recordDonation', () => {
    const donationInput = {
      donorId: 'donor-1',
      donationDate: '2024-03-15',
      donationType: 'whole_blood',
      volumeMl: 450,
      bagNumber: 'BAG-001',
      collectedBy: USER_ID,
    };

    it('should record a donation successfully', async () => {
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue(mockDonor as any);
      vi.mocked(prisma.bloodDonation.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.bloodDonation.create).mockResolvedValue(mockDonation as any);
      vi.mocked(prisma.bloodDonor.update).mockResolvedValue(mockDonor as any);

      const result = await recordDonation(TENANT_ID, donationInput);

      expect(prisma.bloodDonation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          donorId: 'donor-1',
          volumeMl: 450,
          bagNumber: 'BAG-001',
        }),
      });
      // Should also update donor's last donation date
      expect(prisma.bloodDonor.update).toHaveBeenCalledWith({
        where: { id: 'donor-1' },
        data: { lastDonationDate: expect.any(Date) },
      });
      expect(result).toEqual(mockDonation);
    });

    it('should throw notFound if donor does not exist', async () => {
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue(null);

      await expect(recordDonation(TENANT_ID, donationInput)).rejects.toThrow(
        'Blood donor not found',
      );
    });

    it('should throw badRequest if donor is not eligible', async () => {
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue({
        ...mockDonor,
        isEligible: false,
      } as any);

      try {
        await recordDonation(TENANT_ID, donationInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Donor is currently not eligible for donation',
        );
      }
    });

    it('should throw conflict if bag number already exists', async () => {
      vi.mocked(prisma.bloodDonor.findFirst).mockResolvedValue(mockDonor as any);
      vi.mocked(prisma.bloodDonation.findUnique).mockResolvedValue(mockDonation as any);

      try {
        await recordDonation(TENANT_ID, donationInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe(
          'A donation with this bag number already exists',
        );
      }
    });
  });

  describe('getDonations', () => {
    it('should return paginated donations', async () => {
      vi.mocked(prisma.bloodDonation.findMany).mockResolvedValue([mockDonation] as any);
      vi.mocked(prisma.bloodDonation.count).mockResolvedValue(1);

      const result = await getDonations(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        donations: [mockDonation],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  // ═══════════════════════════════════════════
  // Blood Inventory
  // ═══════════════════════════════════════════

  describe('getBloodInventory', () => {
    it('should return paginated blood inventory', async () => {
      vi.mocked(prisma.bloodInventory.findMany).mockResolvedValue([mockBloodUnit] as any);
      vi.mocked(prisma.bloodInventory.count).mockResolvedValue(1);

      const result = await getBloodInventory(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        items: [mockBloodUnit],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('should filter inventory by blood group', async () => {
      vi.mocked(prisma.bloodInventory.findMany).mockResolvedValue([mockBloodUnit] as any);
      vi.mocked(prisma.bloodInventory.count).mockResolvedValue(1);

      await getBloodInventory(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        bloodGroup: 'O+',
      });

      const call = vi.mocked(prisma.bloodInventory.findMany).mock.calls[0][0];
      expect((call as any).where.bloodGroup).toBe('O+');
    });
  });

  describe('addBloodUnit', () => {
    const unitInput = {
      donationId: 'donation-1',
      componentType: 'whole_blood',
      bloodGroup: 'O+',
      bagNumber: 'INV-BAG-001',
      volumeMl: 450,
      collectionDate: '2024-03-15',
      expiryDate: '2024-04-15',
      storageLocation: 'Fridge-A-01',
    };

    it('should add a blood unit successfully', async () => {
      vi.mocked(prisma.bloodInventory.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.bloodDonation.findFirst).mockResolvedValue(mockDonation as any);
      vi.mocked(prisma.bloodInventory.create).mockResolvedValue(mockBloodUnit as any);

      const result = await addBloodUnit(TENANT_ID, unitInput);

      expect(prisma.bloodInventory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          bloodGroup: 'O+',
          componentType: 'whole_blood',
          bagNumber: 'INV-BAG-001',
          volumeMl: 450,
        }),
      });
      expect(result).toEqual(mockBloodUnit);
    });

    it('should throw conflict if bag number already exists', async () => {
      vi.mocked(prisma.bloodInventory.findUnique).mockResolvedValue(mockBloodUnit as any);

      try {
        await addBloodUnit(TENANT_ID, unitInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe(
          'A blood unit with this bag number already exists',
        );
      }
    });
  });

  describe('updateBloodUnit', () => {
    it('should update a blood unit successfully', async () => {
      const updatedUnit = { ...mockBloodUnit, storageLocation: 'Fridge-B-02' };
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue(mockBloodUnit as any);
      vi.mocked(prisma.bloodInventory.update).mockResolvedValue(updatedUnit as any);

      const result = await updateBloodUnit(TENANT_ID, 'unit-1', {
        storageLocation: 'Fridge-B-02',
      });

      expect(result.storageLocation).toBe('Fridge-B-02');
    });

    it('should throw notFound if blood unit does not exist', async () => {
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue(null);

      await expect(
        updateBloodUnit(TENANT_ID, 'nonexistent', { storageLocation: 'Fridge-C-01' }),
      ).rejects.toThrow('Blood unit not found');
    });
  });

  // ═══════════════════════════════════════════
  // Cross-Match
  // ═══════════════════════════════════════════

  describe('requestCrossMatch', () => {
    const crossMatchInput = {
      patientId: 'patient-1',
      bloodInventoryId: 'unit-1',
      notes: 'Pre-surgery cross-match',
    };

    it('should create a cross-match request and reserve the blood unit', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue(mockBloodUnit as any);
      vi.mocked(prisma.crossMatchTest.create).mockResolvedValue(mockCrossMatch as any);
      vi.mocked(prisma.bloodInventory.update).mockResolvedValue({
        ...mockBloodUnit,
        status: 'reserved',
      } as any);

      const result = await requestCrossMatch(TENANT_ID, crossMatchInput);

      expect(prisma.crossMatchTest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          patientId: 'patient-1',
          bloodInventoryId: 'unit-1',
        }),
      });
      // Should reserve the blood unit
      expect(prisma.bloodInventory.update).toHaveBeenCalledWith({
        where: { id: 'unit-1' },
        data: { status: 'reserved' },
      });
      expect(result).toEqual(mockCrossMatch);
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(requestCrossMatch(TENANT_ID, crossMatchInput)).rejects.toThrow(
        'Patient not found',
      );
    });

    it('should throw notFound if blood unit does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue(null);

      await expect(requestCrossMatch(TENANT_ID, crossMatchInput)).rejects.toThrow(
        'Blood inventory unit not found',
      );
    });

    it('should throw badRequest if blood unit is not available', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue({
        ...mockBloodUnit,
        status: 'issued',
      } as any);

      try {
        await requestCrossMatch(TENANT_ID, crossMatchInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Blood unit is not available for cross-matching',
        );
      }
    });
  });

  describe('getCrossMatches', () => {
    it('should return paginated cross-match tests', async () => {
      vi.mocked(prisma.crossMatchTest.findMany).mockResolvedValue([mockCrossMatch] as any);
      vi.mocked(prisma.crossMatchTest.count).mockResolvedValue(1);

      const result = await getCrossMatches(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        crossMatches: [mockCrossMatch],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('completeCrossMatch', () => {
    it('should complete a cross-match test with compatible result', async () => {
      const completedCrossMatch = {
        ...mockCrossMatch,
        result: 'compatible',
        testedBy: USER_ID,
        testedAt: new Date(),
      };
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue(mockCrossMatch as any);
      vi.mocked(prisma.crossMatchTest.update).mockResolvedValue(completedCrossMatch as any);

      const result = await completeCrossMatch(TENANT_ID, 'cm-1', USER_ID, {
        result: 'compatible',
      });

      expect(prisma.crossMatchTest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cm-1' },
          data: expect.objectContaining({
            result: 'compatible',
            testedBy: USER_ID,
          }),
        }),
      );
      expect(result.result).toBe('compatible');
      // Should NOT release unit back for compatible result
      expect(prisma.bloodInventory.update).not.toHaveBeenCalled();
    });

    it('should release blood unit when result is incompatible', async () => {
      const incompatibleResult = {
        ...mockCrossMatch,
        result: 'incompatible',
        testedBy: USER_ID,
        testedAt: new Date(),
      };
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue(mockCrossMatch as any);
      vi.mocked(prisma.crossMatchTest.update).mockResolvedValue(incompatibleResult as any);
      vi.mocked(prisma.bloodInventory.update).mockResolvedValue({
        ...mockBloodUnit,
        status: 'available',
      } as any);

      await completeCrossMatch(TENANT_ID, 'cm-1', USER_ID, {
        result: 'incompatible',
      });

      expect(prisma.bloodInventory.update).toHaveBeenCalledWith({
        where: { id: 'unit-1' },
        data: { status: 'available' },
      });
    });

    it('should throw notFound if cross-match does not exist', async () => {
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue(null);

      await expect(
        completeCrossMatch(TENANT_ID, 'nonexistent', USER_ID, { result: 'compatible' }),
      ).rejects.toThrow('Cross-match test not found');
    });

    it('should throw badRequest if cross-match has already been completed', async () => {
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue({
        ...mockCrossMatch,
        result: 'compatible',
      } as any);

      try {
        await completeCrossMatch(TENANT_ID, 'cm-1', USER_ID, { result: 'compatible' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Cross-match test has already been completed',
        );
      }
    });
  });

  // ═══════════════════════════════════════════
  // Transfusions
  // ═══════════════════════════════════════════

  describe('requestTransfusion', () => {
    const transfusionInput = {
      patientId: 'patient-1',
      visitId: 'visit-1',
      bloodInventoryId: 'unit-1',
      crossMatchId: 'cm-1',
      transfusionDate: '2024-03-16',
      volumeMl: 450,
      orderedBy: 'doctor-1',
      administeredBy: 'nurse-1',
    };

    it('should request a transfusion successfully and mark unit as issued', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue({
        ...mockCrossMatch,
        result: 'compatible',
      } as any);
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue({
        ...mockBloodUnit,
        status: 'reserved',
      } as any);
      vi.mocked(prisma.transfusion.create).mockResolvedValue(mockTransfusion as any);
      vi.mocked(prisma.bloodInventory.update).mockResolvedValue({
        ...mockBloodUnit,
        status: 'issued',
      } as any);

      const result = await requestTransfusion(TENANT_ID, transfusionInput);

      expect(prisma.transfusion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          patientId: 'patient-1',
          bloodInventoryId: 'unit-1',
          crossMatchId: 'cm-1',
          volumeMl: 450,
        }),
      });
      // Should mark the blood unit as issued
      expect(prisma.bloodInventory.update).toHaveBeenCalledWith({
        where: { id: 'unit-1' },
        data: { status: 'issued' },
      });
      expect(result).toEqual(mockTransfusion);
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(requestTransfusion(TENANT_ID, transfusionInput)).rejects.toThrow(
        'Patient not found',
      );
    });

    it('should throw notFound if cross-match does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue(null);

      await expect(requestTransfusion(TENANT_ID, transfusionInput)).rejects.toThrow(
        'Cross-match test not found',
      );
    });

    it('should throw badRequest if cross-match result is not compatible', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue({
        ...mockCrossMatch,
        result: 'incompatible',
      } as any);

      try {
        await requestTransfusion(TENANT_ID, transfusionInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Cross-match test result is not compatible',
        );
      }
    });

    it('should throw badRequest if blood unit is not available for transfusion', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.crossMatchTest.findFirst).mockResolvedValue({
        ...mockCrossMatch,
        result: 'compatible',
      } as any);
      vi.mocked(prisma.bloodInventory.findFirst).mockResolvedValue({
        ...mockBloodUnit,
        status: 'discarded',
      } as any);

      try {
        await requestTransfusion(TENANT_ID, transfusionInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Blood unit is not available for transfusion',
        );
      }
    });
  });

  describe('getTransfusions', () => {
    it('should return paginated transfusions', async () => {
      vi.mocked(prisma.transfusion.findMany).mockResolvedValue([mockTransfusion] as any);
      vi.mocked(prisma.transfusion.count).mockResolvedValue(1);

      const result = await getTransfusions(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        transfusions: [mockTransfusion],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('should filter transfusions by patient', async () => {
      vi.mocked(prisma.transfusion.findMany).mockResolvedValue([mockTransfusion] as any);
      vi.mocked(prisma.transfusion.count).mockResolvedValue(1);

      await getTransfusions(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        patientId: 'patient-1',
      });

      const call = vi.mocked(prisma.transfusion.findMany).mock.calls[0][0];
      expect((call as any).where.patientId).toBe('patient-1');
    });
  });
});
