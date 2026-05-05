import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Helpers
// ============================================================

const dateString = z
  .string()
  .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date' });

const uuidParam = z.string().uuid('Invalid ID');

// ============================================================
// Staff Profiles
// ============================================================

export const createStaffProfileSchema = z.object({
  body: z.object({
    userId: z.string().uuid('Invalid user ID'),
    departmentId: z.string().uuid('Invalid department ID'),
    employeeId: z.string().max(50).optional(),
    position: z.string().max(100).optional(),
    dateOfJoining: dateString.optional(),
    dateOfBirth: dateString.optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    address: z.string().max(500).optional(),
    emergencyContactName: z.string().max(100).optional(),
    emergencyContactPhone: z.string().max(20).optional(),
    salary: z.number().positive().optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  }),
});

export const updateStaffProfileSchema = z.object({
  body: z.object({
    departmentId: z.string().uuid('Invalid department ID').optional(),
    employeeId: z.string().max(50).optional().nullable(),
    position: z.string().max(100).optional().nullable(),
    dateOfJoining: dateString.optional(),
    dateOfBirth: dateString.optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    address: z.string().max(500).optional().nullable(),
    emergencyContactName: z.string().max(100).optional().nullable(),
    emergencyContactPhone: z.string().max(20).optional().nullable(),
    salary: z.number().positive().optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
    status: z.enum(['active', 'on_leave', 'resigned', 'terminated']).optional(),
  }),
  params: z.object({ id: uuidParam }),
});

export const getStaffProfilesSchema = z.object({
  query: paginationSchema.extend({
    departmentId: z.string().uuid().optional(),
    status: z.enum(['active', 'on_leave', 'resigned', 'terminated']).optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  }),
});

export const staffIdParamSchema = z.object({
  params: z.object({ id: uuidParam }),
});

// ============================================================
// Licenses
// ============================================================

export const addLicenseSchema = z.object({
  body: z.object({
    staffId: z.string().uuid('Invalid staff ID'),
    licenseType: z.string().min(1, 'License type is required').max(100),
    licenseNumber: z.string().min(1, 'License number is required').max(100),
    issuingAuthority: z.string().max(255).optional(),
    issuedDate: dateString.optional(),
    expiryDate: dateString.optional(),
    documentUrl: z.string().url().optional(),
    status: z.enum(['active', 'expired', 'renewal_pending']).default('active'),
  }),
});

export const updateLicenseSchema = z.object({
  body: z.object({
    licenseType: z.string().min(1).max(100).optional(),
    licenseNumber: z.string().min(1).max(100).optional(),
    issuingAuthority: z.string().max(255).optional().nullable(),
    issuedDate: dateString.optional(),
    expiryDate: dateString.optional(),
    documentUrl: z.string().url().optional().nullable(),
    status: z.enum(['active', 'expired', 'renewal_pending']).optional(),
  }),
  params: z.object({ id: uuidParam }),
});

export const getLicensesSchema = z.object({
  query: paginationSchema.extend({
    staffId: z.string().uuid().optional(),
    status: z.enum(['active', 'expired', 'renewal_pending']).optional(),
  }),
});

export const getExpiringLicensesSchema = z.object({
  query: paginationSchema.extend({
    daysAhead: z.coerce.number().int().positive().default(30),
  }),
});

// ============================================================
// Duty Rosters
// ============================================================

export const createDutyRosterSchema = z.object({
  body: z
    .object({
      staffId: z.string().uuid('Invalid staff ID').optional(),
      userId: z.string().uuid('Invalid user ID').optional(),
      departmentId: z.string().uuid('Invalid department ID').optional(),
      wardId: z.string().uuid('Invalid ward ID').optional(),
      role: z.string().max(50).optional(),
      shiftDate: dateString,
      shiftType: z.enum(['morning', 'afternoon', 'night', 'general']),
      startTime: z.string().min(1, 'Start time is required'),
      endTime: z.string().min(1, 'End time is required'),
    })
    .refine((d) => Boolean(d.staffId || d.userId), {
      message: 'Either staffId or userId is required',
      path: ['staffId'],
    }),
});

export const createDutyRosterBulkSchema = z.object({
  body: z.object({
    entries: z
      .array(
        z
          .object({
            staffId: z.string().uuid().optional(),
            userId: z.string().uuid().optional(),
            departmentId: z.string().uuid().optional(),
            wardId: z.string().uuid().optional(),
            role: z.string().max(50).optional(),
            shiftDate: dateString,
            shiftType: z.enum(['morning', 'afternoon', 'night', 'general']),
            startTime: z.string().min(1),
            endTime: z.string().min(1),
          })
          .refine((d) => Boolean(d.staffId || d.userId), {
            message: 'Each entry needs either staffId or userId',
            path: ['staffId'],
          }),
      )
      .min(1)
      .max(500),
  }),
});

export const updateDutyRosterSchema = z.object({
  body: z.object({
    staffId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    wardId: z.string().uuid().nullable().optional(),
    role: z.string().max(50).nullable().optional(),
    shiftDate: dateString.optional(),
    shiftType: z.enum(['morning', 'afternoon', 'night', 'general']).optional(),
    startTime: z.string().min(1).optional(),
    endTime: z.string().min(1).optional(),
    status: z.enum(['scheduled', 'published', 'completed', 'swapped', 'cancelled']).optional(),
  }),
  params: z.object({ id: uuidParam }),
});

export const getDutyRostersSchema = z.object({
  query: paginationSchema.extend({
    staffId: z.string().uuid().optional(),
    // userId is the User PK; the service resolves it to that user's
    // StaffProfile so the nurse self-view can ask for "my shifts" without
    // having to know its own staffId.
    userId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    role: z.string().max(50).optional(),
    shiftType: z.enum(['morning', 'afternoon', 'night', 'general']).optional(),
    status: z.enum(['scheduled', 'published', 'completed', 'swapped', 'cancelled']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const dutyRosterIdParamSchema = z.object({
  params: z.object({ id: uuidParam }),
});

// ============================================================
// Attendance
// ============================================================

export const recordAttendanceSchema = z.object({
  body: z.object({
    staffId: z.string().uuid('Invalid staff ID'),
    date: dateString,
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    source: z.enum(['manual', 'biometric', 'system']).default('manual'),
    status: z.enum(['present', 'absent', 'half_day', 'on_leave', 'holiday']).default('present'),
    overtimeHours: z.number().min(0).default(0),
    notes: z.string().max(1000).optional(),
  }),
});

export const getAttendanceSchema = z.object({
  query: paginationSchema.extend({
    staffId: z.string().uuid().optional(),
    status: z.enum(['present', 'absent', 'half_day', 'on_leave', 'holiday']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const getAttendanceSummarySchema = z.object({
  query: z.object({
    staffId: z.string().uuid().optional(),
    month: z.coerce.number().int().min(1).max(12),
    year: z.coerce.number().int().min(2000).max(2100),
  }),
});

// ============================================================
// Leave Requests
// ============================================================

export const applyLeaveSchema = z.object({
  body: z.object({
    staffId: z.string().uuid('Invalid staff ID'),
    leaveType: z.enum(['vacation', 'sick', 'casual', 'maternity', 'paternity', 'unpaid', 'other']),
    startDate: dateString,
    endDate: dateString,
    reason: z.string().max(1000).optional(),
  }),
});

export const getLeavesSchema = z.object({
  query: paginationSchema.extend({
    staffId: z.string().uuid().optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    leaveType: z
      .enum(['vacation', 'sick', 'casual', 'maternity', 'paternity', 'unpaid', 'other'])
      .optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const leaveIdParamSchema = z.object({
  params: z.object({ id: uuidParam }),
});

export const leaveBalanceParamSchema = z.object({
  params: z.object({ userId: uuidParam }),
});

// ============================================================
// Payroll
// ============================================================

export const generatePayrollSchema = z.object({
  body: z.object({
    staffId: z.string().uuid('Invalid staff ID'),
    payPeriodStart: dateString,
    payPeriodEnd: dateString,
    allowances: z.number().min(0).default(0),
    deductions: z.number().min(0).default(0),
    overtimePay: z.number().min(0).default(0),
    taxDeduction: z.number().min(0).default(0),
    notes: z.string().max(1000).optional(),
  }),
});

export const getPayrollListSchema = z.object({
  query: paginationSchema.extend({
    staffId: z.string().uuid().optional(),
    status: z.enum(['draft', 'processed', 'paid']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const payrollIdParamSchema = z.object({
  params: z.object({ id: uuidParam }),
});

// ============================================================
// Inferred types
// ============================================================

export type CreateStaffProfileInput = z.infer<typeof createStaffProfileSchema>['body'];
export type UpdateStaffProfileInput = z.infer<typeof updateStaffProfileSchema>['body'];
export type GetStaffProfilesQuery = z.infer<typeof getStaffProfilesSchema>['query'];

export type AddLicenseInput = z.infer<typeof addLicenseSchema>['body'];
export type UpdateLicenseInput = z.infer<typeof updateLicenseSchema>['body'];
export type GetLicensesQuery = z.infer<typeof getLicensesSchema>['query'];
export type GetExpiringLicensesQuery = z.infer<typeof getExpiringLicensesSchema>['query'];

export type CreateDutyRosterInput = z.infer<typeof createDutyRosterSchema>['body'];
export type CreateDutyRosterBulkInput = z.infer<typeof createDutyRosterBulkSchema>['body'];
export type UpdateDutyRosterInput = z.infer<typeof updateDutyRosterSchema>['body'];
export type GetDutyRostersQuery = z.infer<typeof getDutyRostersSchema>['query'];

export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>['body'];
export type GetAttendanceQuery = z.infer<typeof getAttendanceSchema>['query'];
export type GetAttendanceSummaryQuery = z.infer<typeof getAttendanceSummarySchema>['query'];

export type ApplyLeaveInput = z.infer<typeof applyLeaveSchema>['body'];
export type GetLeavesQuery = z.infer<typeof getLeavesSchema>['query'];

export type GeneratePayrollInput = z.infer<typeof generatePayrollSchema>['body'];
export type GetPayrollListQuery = z.infer<typeof getPayrollListSchema>['query'];
