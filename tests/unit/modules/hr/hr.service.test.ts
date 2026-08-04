import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';
import {
  createStaffProfile,
  getStaffProfiles,
  updateStaffProfile,
  addLicense,
  getLicenses,
  createDutyRoster,
  getDutyRosters,
  updateDutyRoster,
  recordAttendance,
  getAttendance,
  applyLeave,
  getLeaves,
  approveLeave,
  rejectLeave,
  generatePayroll,
  getPayrollList,
} from '../../../../src/modules/hr/hr.service';

// ─── Shared test fixtures ───

const TENANT_ID = 'tenant-1';

const mockUser = {
  id: 'user-1',
  tenantId: TENANT_ID,
  firstName: 'Jane',
  lastName: 'Smith',
  email: 'jane@hospital.com',
};

const mockDepartment = {
  id: 'dept-1',
  name: 'Cardiology',
};

const mockStaffProfile = {
  id: 'staff-1',
  tenantId: TENANT_ID,
  userId: 'user-1',
  departmentId: 'dept-1',
  employeeId: 'EMP-001',
  position: 'Nurse',
  dateOfJoining: new Date('2024-01-15'),
  dateOfBirth: new Date('1990-05-20'),
  gender: 'female',
  address: '123 Main St',
  emergencyContactName: 'John Smith',
  emergencyContactPhone: '+1234567890',
  salary: 5000,
  employmentType: 'full_time',
  status: 'active',
  createdAt: new Date('2024-01-15'),
  updatedAt: new Date('2024-01-15'),
  user: { firstName: 'Jane', lastName: 'Smith', email: 'jane@hospital.com' },
  department: { id: 'dept-1', name: 'Cardiology' },
};

const mockLicense = {
  id: 'lic-1',
  staffId: 'staff-1',
  licenseType: 'RN',
  licenseNumber: 'LIC-12345',
  issuingAuthority: 'State Board of Nursing',
  issuedDate: new Date('2023-01-01'),
  expiryDate: new Date('2026-01-01'),
  documentUrl: null,
  status: 'active',
  createdAt: new Date('2024-01-15'),
  staff: {
    user: { firstName: 'Jane', lastName: 'Smith' },
  },
};

const mockDutyRoster = {
  id: 'roster-1',
  tenantId: TENANT_ID,
  staffId: 'staff-1',
  departmentId: 'dept-1',
  shiftDate: new Date('2024-03-15'),
  shiftType: 'morning',
  startTime: new Date('1970-01-01T08:00:00'),
  endTime: new Date('1970-01-01T16:00:00'),
  status: 'scheduled',
  createdAt: new Date('2024-03-10'),
  staff: {
    user: { firstName: 'Jane', lastName: 'Smith' },
  },
  department: { id: 'dept-1', name: 'Cardiology' },
};

const mockAttendance = {
  id: 'att-1',
  tenantId: TENANT_ID,
  staffId: 'staff-1',
  date: new Date('2024-03-15'),
  checkIn: new Date('2024-03-15T08:00:00'),
  checkOut: null,
  source: 'manual',
  status: 'present',
  overtimeHours: 0,
  notes: null,
  createdAt: new Date('2024-03-15'),
  staff: {
    user: { firstName: 'Jane', lastName: 'Smith' },
  },
};

const mockLeaveRequest = {
  id: 'leave-1',
  tenantId: TENANT_ID,
  staffId: 'staff-1',
  leaveType: 'vacation',
  startDate: new Date('2024-04-01'),
  endDate: new Date('2024-04-05'),
  reason: 'Family vacation',
  status: 'pending',
  approvedBy: null,
  approvedAt: null,
  createdAt: new Date('2024-03-20'),
  staff: {
    user: { firstName: 'Jane', lastName: 'Smith' },
  },
};

const mockPayroll = {
  id: 'payroll-1',
  tenantId: TENANT_ID,
  staffId: 'staff-1',
  payPeriodStart: new Date('2024-03-01'),
  payPeriodEnd: new Date('2024-03-31'),
  basicSalary: 5000,
  allowances: 500,
  deductions: 200,
  overtimePay: 300,
  taxDeduction: 400,
  grossSalary: 5800,
  netSalary: 5200,
  processedBy: 'admin-1',
  status: 'draft',
  createdAt: new Date('2024-04-01'),
  staff: {
    user: { firstName: 'Jane', lastName: 'Smith' },
  },
};

// ─── Tests ───

describe('HR Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════
  // Staff Profiles
  // ═══════════════════════════════════════════

  describe('createStaffProfile', () => {
    const createInput = {
      userId: 'user-1',
      departmentId: 'dept-1',
      employeeId: 'EMP-001',
      position: 'Nurse',
      dateOfJoining: '2024-01-15',
      dateOfBirth: '1990-05-20',
      gender: 'female',
      address: '123 Main St',
      emergencyContactName: 'John Smith',
      emergencyContactPhone: '+1234567890',
      salary: 5000,
      employmentType: 'full_time',
    };

    it('should create a staff profile successfully', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.staffProfile.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.staffProfile.create).mockResolvedValue(mockStaffProfile as any);

      const result = await createStaffProfile(TENANT_ID, createInput);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'user-1', tenantId: TENANT_ID },
      });
      expect(prisma.staffProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            userId: 'user-1',
            position: 'Nurse',
          }),
        }),
      );
      expect(result).toEqual(mockStaffProfile);
    });

    it('should throw notFound if user does not exist', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      await expect(createStaffProfile(TENANT_ID, createInput)).rejects.toThrow(AppError);
      await expect(createStaffProfile(TENANT_ID, createInput)).rejects.toThrow('User not found');
    });

    it('should throw conflict if staff profile already exists for user', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.staffProfile.findUnique).mockResolvedValueOnce(mockStaffProfile as any);

      try {
        await createStaffProfile(TENANT_ID, createInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe('Staff profile already exists for this user');
      }
    });

    it('should throw conflict if employeeId is already in use', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);
      // First findUnique for userId check returns null (no existing profile for user)
      vi.mocked(prisma.staffProfile.findUnique)
        .mockResolvedValueOnce(null) // userId check
        .mockResolvedValueOnce(mockStaffProfile as any); // employeeId check

      try {
        await createStaffProfile(TENANT_ID, createInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe('Employee ID already in use');
      }
    });
  });

  describe('getStaffProfiles', () => {
    it('should return paginated staff profiles', async () => {
      vi.mocked(prisma.staffProfile.findMany).mockResolvedValue([mockStaffProfile] as any);
      vi.mocked(prisma.staffProfile.count).mockResolvedValue(1);

      const result = await getStaffProfiles(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        profiles: [mockStaffProfile],
        total: 1,
        page: 1,
        limit: 20,
      });
      expect(prisma.staffProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_ID },
          skip: 0,
          take: 20,
        }),
      );
    });

    it('should apply search filter when provided', async () => {
      vi.mocked(prisma.staffProfile.findMany).mockResolvedValue([]);
      vi.mocked(prisma.staffProfile.count).mockResolvedValue(0);

      await getStaffProfiles(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        search: 'Jane',
      });

      const call = vi.mocked(prisma.staffProfile.findMany).mock.calls[0][0];
      expect((call as any).where.OR).toBeDefined();
      expect((call as any).where.OR).toHaveLength(4);
    });
  });

  describe('updateStaffProfile', () => {
    it('should update a staff profile successfully', async () => {
      const updatedProfile = { ...mockStaffProfile, position: 'Senior Nurse' };
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.staffProfile.update).mockResolvedValue(updatedProfile as any);

      const result = await updateStaffProfile(TENANT_ID, 'staff-1', { position: 'Senior Nurse' });

      expect(prisma.staffProfile.findFirst).toHaveBeenCalledWith({
        where: { id: 'staff-1', tenantId: TENANT_ID },
      });
      expect(result.position).toBe('Senior Nurse');
    });

    it('should throw notFound if staff profile does not exist', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(null);

      await expect(
        updateStaffProfile(TENANT_ID, 'nonexistent', { position: 'Doctor' }),
      ).rejects.toThrow('Staff profile not found');
    });
  });

  // ═══════════════════════════════════════════
  // Licenses
  // ═══════════════════════════════════════════

  describe('addLicense', () => {
    const licenseInput = {
      staffId: 'staff-1',
      licenseType: 'RN',
      licenseNumber: 'LIC-12345',
      issuingAuthority: 'State Board of Nursing',
      issuedDate: '2023-01-01',
      expiryDate: '2026-01-01',
      status: 'active',
    };

    it('should add a license successfully', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.staffLicense.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.staffLicense.create).mockResolvedValue(mockLicense as any);

      const result = await addLicense(TENANT_ID, licenseInput);

      expect(prisma.staffLicense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            staffId: 'staff-1',
            licenseType: 'RN',
            licenseNumber: 'LIC-12345',
          }),
        }),
      );
      expect(result).toEqual(mockLicense);
    });

    it('should throw notFound if staff profile does not exist', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(null);

      await expect(addLicense(TENANT_ID, licenseInput)).rejects.toThrow('Staff profile not found');
    });

    it('should throw conflict if duplicate license number exists for the same staff', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.staffLicense.findFirst).mockResolvedValue(mockLicense as any);

      try {
        await addLicense(TENANT_ID, licenseInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
      }
    });
  });

  describe('getLicenses', () => {
    it('should return paginated licenses', async () => {
      vi.mocked(prisma.staffLicense.findMany).mockResolvedValue([mockLicense] as any);
      vi.mocked(prisma.staffLicense.count).mockResolvedValue(1);

      const result = await getLicenses(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        licenses: [mockLicense],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  // ═══════════════════════════════════════════
  // Duty Rosters
  // ═══════════════════════════════════════════

  describe('createDutyRoster', () => {
    const rosterInput = {
      staffId: 'staff-1',
      departmentId: 'dept-1',
      shiftDate: '2024-03-15',
      shiftType: 'morning',
      startTime: '08:00',
      endTime: '16:00',
    };

    it('should create a duty roster successfully', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.dutyRoster.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.dutyRoster.create).mockResolvedValue(mockDutyRoster as any);

      const result = await createDutyRoster(TENANT_ID, rosterInput);

      expect(prisma.dutyRoster.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            staffId: 'staff-1',
            departmentId: 'dept-1',
          }),
        }),
      );
      expect(result).toEqual(mockDutyRoster);
    });

    it('should throw conflict if staff already has a roster for the date', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.dutyRoster.findFirst).mockResolvedValue(mockDutyRoster as any);

      try {
        await createDutyRoster(TENANT_ID, rosterInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe('Staff already has a roster entry for this date and shift');
      }
    });
  });

  describe('getDutyRosters', () => {
    it('should return paginated duty rosters', async () => {
      vi.mocked(prisma.dutyRoster.findMany).mockResolvedValue([mockDutyRoster] as any);
      vi.mocked(prisma.dutyRoster.count).mockResolvedValue(1);

      const result = await getDutyRosters(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        rosters: [mockDutyRoster],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('updateDutyRoster', () => {
    it('should update a duty roster successfully', async () => {
      const updated = { ...mockDutyRoster, shiftType: 'evening' };
      vi.mocked(prisma.dutyRoster.findFirst).mockResolvedValue(mockDutyRoster as any);
      vi.mocked(prisma.dutyRoster.update).mockResolvedValue(updated as any);

      const result = await updateDutyRoster(TENANT_ID, 'roster-1', { shiftType: 'evening' });

      expect(result.shiftType).toBe('evening');
    });

    it('should throw notFound if duty roster does not exist', async () => {
      vi.mocked(prisma.dutyRoster.findFirst).mockResolvedValue(null);

      await expect(
        updateDutyRoster(TENANT_ID, 'nonexistent', { shiftType: 'evening' }),
      ).rejects.toThrow('Duty roster not found');
    });
  });

  // ═══════════════════════════════════════════
  // Attendance
  // ═══════════════════════════════════════════

  describe('recordAttendance', () => {
    const attendanceInput = {
      staffId: 'staff-1',
      date: '2024-03-15',
      checkIn: '2024-03-15T08:00:00',
      source: 'manual',
      status: 'present',
    };

    it('should create a new attendance record', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.attendance.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.attendance.create).mockResolvedValue(mockAttendance as any);

      const result = await recordAttendance(TENANT_ID, attendanceInput);

      expect(prisma.attendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            staffId: 'staff-1',
            status: 'present',
          }),
        }),
      );
      expect(result).toEqual(mockAttendance);
    });

    it('should update existing attendance record if one exists for that date', async () => {
      const updatedAttendance = {
        ...mockAttendance,
        checkOut: new Date('2024-03-15T16:00:00'),
      };
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.attendance.findUnique).mockResolvedValue(mockAttendance as any);
      vi.mocked(prisma.attendance.update).mockResolvedValue(updatedAttendance as any);

      const result = await recordAttendance(TENANT_ID, {
        ...attendanceInput,
        checkOut: '2024-03-15T16:00:00',
      });

      expect(prisma.attendance.update).toHaveBeenCalled();
      expect(result.checkOut).toEqual(new Date('2024-03-15T16:00:00'));
    });

    it('should throw notFound if staff does not exist', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(null);

      await expect(recordAttendance(TENANT_ID, attendanceInput)).rejects.toThrow(
        'Staff profile not found',
      );
    });
  });

  describe('getAttendance', () => {
    it('should return paginated attendance records', async () => {
      vi.mocked(prisma.attendance.findMany).mockResolvedValue([mockAttendance] as any);
      vi.mocked(prisma.attendance.count).mockResolvedValue(1);

      const result = await getAttendance(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        records: [mockAttendance],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  // ═══════════════════════════════════════════
  // Leave Requests
  // ═══════════════════════════════════════════

  describe('applyLeave', () => {
    const leaveInput = {
      staffId: 'staff-1',
      leaveType: 'vacation',
      startDate: '2024-04-01',
      endDate: '2024-04-05',
      reason: 'Family vacation',
    };

    it('should create a leave request successfully', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.leaveRequest.create).mockResolvedValue(mockLeaveRequest as any);

      const result = await applyLeave(TENANT_ID, leaveInput);

      expect(prisma.leaveRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            staffId: 'staff-1',
            leaveType: 'vacation',
            reason: 'Family vacation',
          }),
        }),
      );
      expect(result).toEqual(mockLeaveRequest);
    });

    it('should throw badRequest if end date is before start date', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);

      try {
        await applyLeave(TENANT_ID, {
          ...leaveInput,
          startDate: '2024-04-10',
          endDate: '2024-04-05',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('End date must be after start date');
      }
    });

    it('should throw conflict if overlapping leave request exists', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue(mockLeaveRequest as any);

      try {
        await applyLeave(TENANT_ID, leaveInput);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe('Overlapping leave request already exists');
      }
    });
  });

  describe('getLeaves', () => {
    it('should return paginated leave requests', async () => {
      vi.mocked(prisma.leaveRequest.findMany).mockResolvedValue([mockLeaveRequest] as any);
      vi.mocked(prisma.leaveRequest.count).mockResolvedValue(1);

      const result = await getLeaves(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        leaves: [mockLeaveRequest],
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('approveLeave', () => {
    it('should approve a pending leave request', async () => {
      const approvedLeave = {
        ...mockLeaveRequest,
        status: 'approved',
        approvedBy: 'admin-1',
        approvedAt: new Date(),
      };
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue(mockLeaveRequest as any);
      vi.mocked(prisma.leaveRequest.update).mockResolvedValue(approvedLeave as any);

      const result = await approveLeave(TENANT_ID, 'leave-1', 'admin-1');

      expect(prisma.leaveRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'leave-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedBy: 'admin-1',
          }),
        }),
      );
      expect(result.status).toBe('approved');
    });

    it('should throw notFound if leave request does not exist', async () => {
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue(null);

      await expect(approveLeave(TENANT_ID, 'nonexistent', 'admin-1')).rejects.toThrow(
        'Leave request not found',
      );
    });

    it('should throw badRequest if leave is not in pending status', async () => {
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue({
        ...mockLeaveRequest,
        status: 'approved',
      } as any);

      try {
        await approveLeave(TENANT_ID, 'leave-1', 'admin-1');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('Only pending leave requests can be approved');
      }
    });
  });

  describe('rejectLeave', () => {
    it('should reject a pending leave request', async () => {
      const rejectedLeave = {
        ...mockLeaveRequest,
        status: 'rejected',
        approvedBy: 'admin-1',
        approvedAt: new Date(),
      };
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue(mockLeaveRequest as any);
      vi.mocked(prisma.leaveRequest.update).mockResolvedValue(rejectedLeave as any);

      const result = await rejectLeave(TENANT_ID, 'leave-1', 'admin-1');

      expect(prisma.leaveRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'leave-1' },
          data: expect.objectContaining({
            status: 'rejected',
            approvedBy: 'admin-1',
          }),
        }),
      );
      expect(result.status).toBe('rejected');
    });

    it('should throw badRequest if leave is not pending', async () => {
      vi.mocked(prisma.leaveRequest.findFirst).mockResolvedValue({
        ...mockLeaveRequest,
        status: 'rejected',
      } as any);

      try {
        await rejectLeave(TENANT_ID, 'leave-1', 'admin-1');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
      }
    });
  });

  // ═══════════════════════════════════════════
  // Payroll
  // ═══════════════════════════════════════════

  describe('generatePayroll', () => {
    const payrollInput = {
      staffId: 'staff-1',
      payPeriodStart: '2024-03-01',
      payPeriodEnd: '2024-03-31',
      allowances: 500,
      deductions: 200,
      overtimePay: 300,
      taxDeduction: 400,
    };

    it('should generate payroll successfully with correct salary calculations', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.payroll.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.payroll.create).mockResolvedValue(mockPayroll as any);

      const result = await generatePayroll(TENANT_ID, payrollInput, 'admin-1');

      expect(prisma.payroll.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            staffId: 'staff-1',
            basicSalary: 5000,
            allowances: 500,
            deductions: 200,
            overtimePay: 300,
            taxDeduction: 400,
            grossSalary: 5800, // 5000 + 500 + 300
            netSalary: 5200,   // 5800 - 200 - 400
            processedBy: 'admin-1',
          }),
        }),
      );
      expect(result).toEqual(mockPayroll);
    });

    it('should throw notFound if staff does not exist', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(null);

      await expect(
        generatePayroll(TENANT_ID, payrollInput, 'admin-1'),
      ).rejects.toThrow('Staff profile not found');
    });

    it('should throw conflict if payroll already exists for the period', async () => {
      vi.mocked(prisma.staffProfile.findFirst).mockResolvedValue(mockStaffProfile as any);
      vi.mocked(prisma.payroll.findFirst).mockResolvedValue(mockPayroll as any);

      try {
        await generatePayroll(TENANT_ID, payrollInput, 'admin-1');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe(
          'Payroll already generated for this staff and period',
        );
      }
    });
  });

  describe('getPayrollList', () => {
    it('should return paginated payroll list', async () => {
      vi.mocked(prisma.payroll.findMany).mockResolvedValue([mockPayroll] as any);
      vi.mocked(prisma.payroll.count).mockResolvedValue(1);

      const result = await getPayrollList(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' as const });

      expect(result).toEqual({
        payrolls: [mockPayroll],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('should apply staffId filter when provided', async () => {
      vi.mocked(prisma.payroll.findMany).mockResolvedValue([mockPayroll] as any);
      vi.mocked(prisma.payroll.count).mockResolvedValue(1);

      await getPayrollList(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc' as const,
        staffId: 'staff-1',
      });

      const call = vi.mocked(prisma.payroll.findMany).mock.calls[0][0];
      expect((call as any).where.staffId).toBe('staff-1');
    });
  });
});
