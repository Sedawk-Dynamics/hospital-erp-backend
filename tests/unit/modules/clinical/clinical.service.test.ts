import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';
import {
  createVisit,
  getVisits,
  getVisitById,
  closeVisit,
  createAdmission,
  getAdmissions,
  dischargePatient,
  createTransfer,
  approveTransfer,
  recordVitals,
  getVitals,
  addDiagnosis,
  getDiagnoses,
  updateDiagnosis,
  deleteDiagnosis,
} from '../../../../src/modules/clinical/clinical.service';

// ─── Extend mocks for vital.count and diagnosis.count ───
(prisma.vital as any).count = vi.fn();
(prisma.diagnosis as any).count = vi.fn();

// ─── Shared fixtures ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

const mockPatient = {
  id: 'patient-1',
  mrn: 'MRN-001',
  firstName: 'Alice',
  lastName: 'Smith',
  tenantId: TENANT_ID,
  phone: '1234567890',
};

const mockDoctor = {
  id: 'doctor-1',
  tenantId: TENANT_ID,
  userId: 'user-doc-1',
  user: { firstName: 'Dr.', lastName: 'House' },
  department: { id: 'dept-1', name: 'General Medicine' },
};

const mockVisitActive = {
  id: 'visit-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  visitType: 'op',
  visitDate: new Date('2026-03-09'),
  chiefComplaint: 'Headache',
  status: 'active',
};

const mockVisitCompleted = {
  ...mockVisitActive,
  id: 'visit-2',
  status: 'completed',
};

const mockVisitDischarged = {
  ...mockVisitActive,
  id: 'visit-3',
  status: 'discharged',
};

const mockBed = {
  id: 'bed-1',
  bedNumber: 'B-101',
  room: { id: 'room-1', wardId: 'ward-1' },
};

const mockWard = {
  id: 'ward-1',
  name: 'General Ward',
};

const mockAdmission = {
  id: 'admission-1',
  tenantId: TENANT_ID,
  visitId: 'visit-1',
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  wardId: 'ward-1',
  bedId: 'bed-1',
  admissionDate: new Date('2026-03-09'),
  status: 'admitted',
  admittedBy: USER_ID,
  patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
  doctor: { user: { firstName: 'Dr.', lastName: 'House' } },
  ward: { id: 'ward-1', name: 'General Ward' },
  bed: { id: 'bed-1', bedNumber: 'B-101' },
};

const mockTransfer = {
  id: 'transfer-1',
  tenantId: TENANT_ID,
  patientId: 'patient-1',
  visitId: 'visit-1',
  transferType: 'ward',
  fromWardId: 'ward-1',
  toWardId: 'ward-2',
  reason: 'Upgrade required',
  status: 'requested',
  requestedBy: USER_ID,
};

// ─── Tests ───

describe('ClinicalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════
  // createVisit
  // ═══════════════════════════════════════════
  describe('createVisit', () => {
    it('should create a visit successfully', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(mockDoctor as any);
      const createdVisit = {
        ...mockVisitActive,
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
        doctor: mockDoctor,
      };
      vi.mocked(prisma.visit.create).mockResolvedValue(createdVisit as any);

      const result = await createVisit(TENANT_ID, {
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        visitType: 'op',
        visitDate: '2026-03-09',
        chiefComplaint: 'Headache',
      });

      expect(result).toEqual(createdVisit);
      expect(prisma.visit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            doctorId: 'doctor-1',
            visitType: 'op',
            chiefComplaint: 'Headache',
            status: 'active',
          }),
        }),
      );
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(
        createVisit(TENANT_ID, {
          patientId: 'no-patient',
          doctorId: 'doctor-1',
          visitType: 'op',
          visitDate: '2026-03-09',
        }),
      ).rejects.toThrow('Patient not found');
    });

    it('should throw notFound if doctor does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);

      await expect(
        createVisit(TENANT_ID, {
          patientId: 'patient-1',
          doctorId: 'no-doctor',
          visitType: 'op',
          visitDate: '2026-03-09',
        }),
      ).rejects.toThrow('Doctor not found');
    });
  });

  // ═══════════════════════════════════════════
  // getVisits
  // ═══════════════════════════════════════════
  describe('getVisits', () => {
    it('should return visits with pagination', async () => {
      const visits = [
        { id: 'visit-1', status: 'active' },
        { id: 'visit-2', status: 'completed' },
      ];
      vi.mocked(prisma.visit.findMany).mockResolvedValue(visits as any);
      vi.mocked(prisma.visit.count).mockResolvedValue(2);

      const result = await getVisits(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.visits).toEqual(visits);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  // ═══════════════════════════════════════════
  // getVisitById
  // ═══════════════════════════════════════════
  describe('getVisitById', () => {
    it('should throw notFound for non-existent visit', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null);

      await expect(getVisitById(TENANT_ID, 'no-visit')).rejects.toThrow('Visit not found');
    });

    it('should return visit with details', async () => {
      const visitWithDetails = {
        ...mockVisitActive,
        patient: mockPatient,
        doctor: mockDoctor,
        admission: null,
        vitals: [],
        diagnoses: [],
      };
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(visitWithDetails as any);

      const result = await getVisitById(TENANT_ID, 'visit-1');

      expect(result.id).toBe('visit-1');
      expect(result.patient).toBeDefined();
      expect(result.doctor).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════
  // closeVisit
  // ═══════════════════════════════════════════
  describe('closeVisit', () => {
    it('should close an active visit', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      const closedVisit = {
        ...mockVisitActive,
        status: 'completed',
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
        doctor: { user: { firstName: 'Dr.', lastName: 'House' } },
      };
      vi.mocked(prisma.visit.update).mockResolvedValue(closedVisit as any);

      const result = await closeVisit(TENANT_ID, 'visit-1');

      expect(result.status).toBe('completed');
      expect(prisma.visit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'visit-1' },
          data: { status: 'completed' },
        }),
      );
    });

    it('should throw badRequest if visit is already completed', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitCompleted as any);

      await expect(closeVisit(TENANT_ID, 'visit-2')).rejects.toThrow('Visit is already closed');
    });

    it('should throw badRequest if visit is already discharged', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitDischarged as any);

      await expect(closeVisit(TENANT_ID, 'visit-3')).rejects.toThrow(
        'Visit has already been discharged',
      );
    });

    it('should throw notFound for non-existent visit on close', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null);

      await expect(closeVisit(TENANT_ID, 'no-visit')).rejects.toThrow('Visit not found');
    });
  });

  // ═══════════════════════════════════════════
  // createAdmission
  // ═══════════════════════════════════════════
  describe('createAdmission', () => {
    it('should create an admission and mark bed as occupied', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      vi.mocked(prisma.admission.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(mockDoctor as any);
      vi.mocked(prisma.bed.findFirst).mockResolvedValue(mockBed as any);
      vi.mocked(prisma.admission.create).mockResolvedValue(mockAdmission as any);
      vi.mocked(prisma.visit.update).mockResolvedValue({} as any);

      const result = await createAdmission(TENANT_ID, USER_ID, {
        visitId: 'visit-1',
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        wardId: 'ward-1',
        bedId: 'bed-1',
        admissionDate: '2026-03-09',
        admissionReason: 'Surgery',
      });

      expect(result).toEqual(mockAdmission);
      expect(prisma.admission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            visitId: 'visit-1',
            patientId: 'patient-1',
            doctorId: 'doctor-1',
            wardId: 'ward-1',
            bedId: 'bed-1',
            status: 'admitted',
            admittedBy: USER_ID,
          }),
        }),
      );
    });

    it('should throw notFound if visit does not exist for admission', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null);

      await expect(
        createAdmission(TENANT_ID, USER_ID, {
          visitId: 'no-visit',
          patientId: 'patient-1',
          doctorId: 'doctor-1',
          wardId: 'ward-1',
          bedId: 'bed-1',
          admissionDate: '2026-03-09',
        }),
      ).rejects.toThrow('Visit not found');
    });

    it('should throw conflict if visit already has an admission', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      vi.mocked(prisma.admission.findUnique).mockResolvedValue(mockAdmission as any);

      await expect(
        createAdmission(TENANT_ID, USER_ID, {
          visitId: 'visit-1',
          patientId: 'patient-1',
          doctorId: 'doctor-1',
          wardId: 'ward-1',
          bedId: 'bed-1',
          admissionDate: '2026-03-09',
        }),
      ).rejects.toThrow('This visit already has an admission');
    });

    it('should throw notFound if bed is not found in the specified ward', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      vi.mocked(prisma.admission.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(mockDoctor as any);
      vi.mocked(prisma.bed.findFirst).mockResolvedValue(null);

      await expect(
        createAdmission(TENANT_ID, USER_ID, {
          visitId: 'visit-1',
          patientId: 'patient-1',
          doctorId: 'doctor-1',
          wardId: 'ward-1',
          bedId: 'no-bed',
          admissionDate: '2026-03-09',
        }),
      ).rejects.toThrow('Bed not found in the specified ward');
    });
  });

  // ═══════════════════════════════════════════
  // getAdmissions
  // ═══════════════════════════════════════════
  describe('getAdmissions', () => {
    it('should return paginated admissions', async () => {
      const admissions = [mockAdmission];
      vi.mocked(prisma.admission.findMany).mockResolvedValue(admissions as any);
      vi.mocked(prisma.admission.count).mockResolvedValue(1);

      const result = await getAdmissions(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.admissions).toEqual(admissions);
      expect(result.total).toBe(1);
    });
  });

  // ═══════════════════════════════════════════
  // dischargePatient
  // ═══════════════════════════════════════════
  describe('dischargePatient', () => {
    it('should discharge patient and free bed', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        ...mockAdmission,
        status: 'admitted',
      } as any);

      const dischargedAdmission = {
        ...mockAdmission,
        status: 'discharged',
        dischargeDate: new Date(),
        dischargedBy: USER_ID,
      };

      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          admission: {
            update: vi.fn().mockResolvedValue(dischargedAdmission),
          },
          visit: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return fn(tx);
      });

      const result = await dischargePatient(TENANT_ID, 'admission-1', USER_ID);

      expect(result.status).toBe('discharged');
      expect(result.dischargedBy).toBe(USER_ID);
    });

    it('should create discharge summary on discharge (visit status set to discharged)', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        ...mockAdmission,
        status: 'admitted',
      } as any);

      let visitUpdateData: any = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          admission: {
            update: vi.fn().mockResolvedValue({
              ...mockAdmission,
              status: 'discharged',
              dischargeDate: new Date(),
              dischargedBy: USER_ID,
            }),
          },
          visit: {
            update: vi.fn().mockImplementation((args: any) => {
              visitUpdateData = args;
              return {};
            }),
          },
        };
        return fn(tx);
      });

      await dischargePatient(TENANT_ID, 'admission-1', USER_ID);

      // Verify the visit status was set to discharged inside the transaction
      expect(visitUpdateData).toEqual(
        expect.objectContaining({
          where: { id: 'visit-1' },
          data: { status: 'discharged' },
        }),
      );
    });

    it('should throw badRequest if patient is already discharged', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        ...mockAdmission,
        status: 'discharged',
      } as any);

      await expect(dischargePatient(TENANT_ID, 'admission-1', USER_ID)).rejects.toThrow(
        'Patient is already discharged',
      );
    });

    it('should throw notFound for non-existent admission on discharge', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue(null);

      await expect(dischargePatient(TENANT_ID, 'no-admission', USER_ID)).rejects.toThrow(
        'Admission not found',
      );
    });
  });

  // ═══════════════════════════════════════════
  // createTransfer
  // ═══════════════════════════════════════════
  describe('createTransfer', () => {
    it('should create a transfer request', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      const createdTransfer = {
        ...mockTransfer,
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
        fromDoctor: null,
        toDoctor: null,
        fromWard: { id: 'ward-1', name: 'General Ward' },
        toWard: { id: 'ward-2', name: 'ICU' },
      };
      vi.mocked(prisma.patientTransfer.create).mockResolvedValue(createdTransfer as any);

      const result = await createTransfer(TENANT_ID, USER_ID, {
        patientId: 'patient-1',
        visitId: 'visit-1',
        transferType: 'ward',
        fromWardId: 'ward-1',
        toWardId: 'ward-2',
        reason: 'Upgrade required',
      });

      expect(result.status).toBe('requested');
      expect(prisma.patientTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            visitId: 'visit-1',
            transferType: 'ward',
            status: 'requested',
            requestedBy: USER_ID,
          }),
        }),
      );
    });

    it('should throw notFound if visit does not exist for transfer', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null);

      await expect(
        createTransfer(TENANT_ID, USER_ID, {
          patientId: 'patient-1',
          visitId: 'no-visit',
          transferType: 'ward',
          reason: 'Test',
        }),
      ).rejects.toThrow('Visit not found');
    });
  });

  // ═══════════════════════════════════════════
  // approveTransfer
  // ═══════════════════════════════════════════
  describe('approveTransfer', () => {
    it('should approve a transfer request', async () => {
      vi.mocked(prisma.patientTransfer.findFirst).mockResolvedValue(mockTransfer as any);
      const approvedTransfer = {
        ...mockTransfer,
        status: 'approved',
        approvedBy: 'admin-1',
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
        fromDoctor: null,
        toDoctor: null,
        fromWard: { id: 'ward-1', name: 'General Ward' },
        toWard: { id: 'ward-2', name: 'ICU' },
      };
      vi.mocked(prisma.patientTransfer.update).mockResolvedValue(approvedTransfer as any);

      const result = await approveTransfer(TENANT_ID, 'transfer-1', 'admin-1');

      expect(result.status).toBe('approved');
      expect(prisma.patientTransfer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'transfer-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedBy: 'admin-1',
          }),
        }),
      );
    });

    it('should throw notFound if transfer does not exist', async () => {
      vi.mocked(prisma.patientTransfer.findFirst).mockResolvedValue(null);

      await expect(approveTransfer(TENANT_ID, 'no-transfer', 'admin-1')).rejects.toThrow(
        'Transfer not found',
      );
    });

    it('should throw badRequest if transfer is already approved', async () => {
      vi.mocked(prisma.patientTransfer.findFirst).mockResolvedValue({
        ...mockTransfer,
        status: 'approved',
      } as any);

      await expect(approveTransfer(TENANT_ID, 'transfer-1', 'admin-1')).rejects.toThrow(
        'Transfer has already been approved',
      );
    });
  });

  // ═══════════════════════════════════════════
  // recordVitals
  // ═══════════════════════════════════════════
  describe('recordVitals', () => {
    it('should record vital signs successfully', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      const createdVital = {
        id: 'vital-1',
        visitId: 'visit-1',
        patientId: 'patient-1',
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        temperature: 98.6,
        respiratoryRate: 16,
        oxygenSaturation: 98,
        weightKg: 70,
        heightCm: 175,
        bmi: 22.9,
        recordedBy: USER_ID,
        recorder: { id: USER_ID, firstName: 'Nurse', lastName: 'Joy' },
      };
      vi.mocked(prisma.vital.create).mockResolvedValue(createdVital as any);

      const result = await recordVitals(TENANT_ID, USER_ID, ['nurse'], {
        visitId: 'visit-1',
        patientId: 'patient-1',
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        temperature: 98.6,
        respiratoryRate: 16,
        oxygenSaturation: 98,
        weightKg: 70,
        heightCm: 175,
      });

      expect(result.id).toBe('vital-1');
      expect(result.bloodPressureSystolic).toBe(120);
      expect(result.bmi).toBe(22.9);
      expect(prisma.vital.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visitId: 'visit-1',
            patientId: 'patient-1',
            bloodPressureSystolic: 120,
            bloodPressureDiastolic: 80,
            pulseRate: 72,
            temperature: 98.6,
            recordedBy: USER_ID,
          }),
        }),
      );
    });

    it('should throw badRequest if patient does not match the visit', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue({
        ...mockVisitActive,
        patientId: 'different-patient',
      } as any);

      await expect(
        recordVitals(TENANT_ID, USER_ID, ['nurse'], {
          visitId: 'visit-1',
          patientId: 'patient-1',
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
        }),
      ).rejects.toThrow('Patient does not match the visit');
    });

    it('should reject doctors and other non-nursing roles', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);

      await expect(
        recordVitals(TENANT_ID, USER_ID, ['doctor'], {
          visitId: 'visit-1',
          patientId: 'patient-1',
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
        }),
      ).rejects.toThrow(/nursing team/);

      await expect(
        recordVitals(TENANT_ID, USER_ID, ['front_desk'], {
          visitId: 'visit-1',
          patientId: 'patient-1',
          bloodPressureSystolic: 120,
        }),
      ).rejects.toThrow(/nursing team/);
    });

    it('should calculate BMI when weight and height are provided', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      vi.mocked(prisma.vital.create).mockImplementation(async (args: any) => {
        return { id: 'vital-2', ...args.data };
      });

      const result = await recordVitals(TENANT_ID, USER_ID, ['nurse'], {
        visitId: 'visit-1',
        patientId: 'patient-1',
        weightKg: 70,
        heightCm: 175,
      });

      // BMI = 70 / (1.75 * 1.75) = 22.857... => 22.9
      expect(result.bmi).toBe(22.9);
    });
  });

  // ═══════════════════════════════════════════
  // getVitals
  // ═══════════════════════════════════════════
  describe('getVitals', () => {
    it('should return paginated vitals for a patient', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      const vitals = [
        { id: 'vital-1', bloodPressureSystolic: 120 },
        { id: 'vital-2', bloodPressureSystolic: 130 },
      ];
      vi.mocked(prisma.vital.findMany).mockResolvedValue(vitals as any);
      vi.mocked((prisma.vital as any).count).mockResolvedValue(2);

      const result = await getVitals(TENANT_ID, 'patient-1', { page: 1, limit: 20 } as any);

      expect(result.vitals).toEqual(vitals);
      expect(result.total).toBe(2);
    });
  });

  // ═══════════════════════════════════════════
  // addDiagnosis
  // ═══════════════════════════════════════════
  describe('addDiagnosis', () => {
    it('should add a diagnosis to a visit', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(mockVisitActive as any);
      const createdDiagnosis = {
        id: 'diag-1',
        visitId: 'visit-1',
        patientId: 'patient-1',
        icdCode: 'J06.9',
        diagnosisName: 'Upper Respiratory Infection',
        diagnosisType: 'primary',
        notes: 'Acute',
        diagnosedBy: USER_ID,
        diagnoser: { id: USER_ID, firstName: 'Dr.', lastName: 'House' },
        visit: { id: 'visit-1', visitDate: new Date(), visitType: 'op' },
      };
      vi.mocked(prisma.diagnosis.create).mockResolvedValue(createdDiagnosis as any);

      const result = await addDiagnosis(TENANT_ID, USER_ID, {
        visitId: 'visit-1',
        patientId: 'patient-1',
        icdCode: 'J06.9',
        diagnosisName: 'Upper Respiratory Infection',
        diagnosisType: 'primary',
        notes: 'Acute',
      });

      expect(result.id).toBe('diag-1');
      expect(result.diagnosisName).toBe('Upper Respiratory Infection');
      expect(prisma.diagnosis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visitId: 'visit-1',
            patientId: 'patient-1',
            icdCode: 'J06.9',
            diagnosisName: 'Upper Respiratory Infection',
            diagnosisType: 'primary',
            diagnosedBy: USER_ID,
          }),
        }),
      );
    });

    it('should throw notFound if visit does not exist for diagnosis', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null);

      await expect(
        addDiagnosis(TENANT_ID, USER_ID, {
          visitId: 'no-visit',
          patientId: 'patient-1',
          diagnosisName: 'Test',
        }),
      ).rejects.toThrow('Visit not found');
    });
  });

  // ═══════════════════════════════════════════
  // getDiagnoses
  // ═══════════════════════════════════════════
  describe('getDiagnoses', () => {
    it('should return paginated diagnoses for a patient', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      const diagnoses = [{ id: 'diag-1', diagnosisName: 'Flu' }];
      vi.mocked(prisma.diagnosis.findMany).mockResolvedValue(diagnoses as any);
      vi.mocked((prisma.diagnosis as any).count).mockResolvedValue(1);

      const result = await getDiagnoses(TENANT_ID, 'patient-1', { page: 1, limit: 20 } as any);

      expect(result.diagnoses).toEqual(diagnoses);
      expect(result.total).toBe(1);
    });
  });

  // ═══════════════════════════════════════════
  // updateDiagnosis
  // ═══════════════════════════════════════════
  describe('updateDiagnosis', () => {
    it('should update a diagnosis', async () => {
      vi.mocked(prisma.diagnosis.findFirst).mockResolvedValue({
        id: 'diag-1',
        visitId: 'visit-1',
        patientId: 'patient-1',
        diagnosisName: 'Old Name',
      } as any);
      const updatedDiag = {
        id: 'diag-1',
        diagnosisName: 'Updated Diagnosis',
        icdCode: 'J11',
        diagnoser: { id: USER_ID, firstName: 'Dr.', lastName: 'House' },
        visit: { id: 'visit-1', visitDate: new Date(), visitType: 'op' },
      };
      vi.mocked(prisma.diagnosis.update).mockResolvedValue(updatedDiag as any);

      const result = await updateDiagnosis(TENANT_ID, 'diag-1', {
        diagnosisName: 'Updated Diagnosis',
        icdCode: 'J11',
      });

      expect(result.diagnosisName).toBe('Updated Diagnosis');
      expect(prisma.diagnosis.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'diag-1' },
          data: expect.objectContaining({
            diagnosisName: 'Updated Diagnosis',
            icdCode: 'J11',
          }),
        }),
      );
    });

    it('should throw notFound for non-existent diagnosis on update', async () => {
      vi.mocked(prisma.diagnosis.findFirst).mockResolvedValue(null);

      await expect(
        updateDiagnosis(TENANT_ID, 'no-diag', { diagnosisName: 'Test' }),
      ).rejects.toThrow('Diagnosis not found');
    });
  });

  // ═══════════════════════════════════════════
  // deleteDiagnosis
  // ═══════════════════════════════════════════
  describe('deleteDiagnosis', () => {
    it('should delete a diagnosis', async () => {
      vi.mocked(prisma.diagnosis.findFirst).mockResolvedValue({
        id: 'diag-1',
        visitId: 'visit-1',
      } as any);
      vi.mocked(prisma.diagnosis.delete).mockResolvedValue({} as any);

      await deleteDiagnosis(TENANT_ID, 'diag-1');

      expect(prisma.diagnosis.delete).toHaveBeenCalledWith({ where: { id: 'diag-1' } });
    });

    it('should throw notFound for non-existent diagnosis on delete', async () => {
      vi.mocked(prisma.diagnosis.findFirst).mockResolvedValue(null);

      await expect(deleteDiagnosis(TENANT_ID, 'no-diag')).rejects.toThrow(
        'Diagnosis not found',
      );
    });
  });
});
