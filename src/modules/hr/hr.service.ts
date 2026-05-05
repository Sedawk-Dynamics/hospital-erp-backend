import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateStaffProfileInput,
  UpdateStaffProfileInput,
  GetStaffProfilesQuery,
  AddLicenseInput,
  UpdateLicenseInput,
  GetLicensesQuery,
  GetExpiringLicensesQuery,
  CreateDutyRosterInput,
  CreateDutyRosterBulkInput,
  UpdateDutyRosterInput,
  GetDutyRostersQuery,
  RecordAttendanceInput,
  GetAttendanceQuery,
  GetAttendanceSummaryQuery,
  ApplyLeaveInput,
  GetLeavesQuery,
  GeneratePayrollInput,
  GetPayrollListQuery,
} from './hr.validation';

// ============================================================
// Staff Profiles
// ============================================================

export async function createStaffProfile(tenantId: string, data: CreateStaffProfileInput) {
  // Check user exists
  const user = await prisma.user.findFirst({
    where: { id: data.userId, tenantId },
  });
  if (!user) {
    throw AppError.notFound('User not found');
  }

  // Check for duplicate staff profile for the same user
  const existing = await prisma.staffProfile.findUnique({
    where: { userId: data.userId },
  });
  if (existing) {
    throw AppError.conflict('Staff profile already exists for this user');
  }

  // Check if employeeId is unique within the tenant
  if (data.employeeId) {
    const existingEmpId = await prisma.staffProfile.findUnique({
      where: { employeeId: data.employeeId },
    });
    if (existingEmpId) {
      throw AppError.conflict('Employee ID already in use');
    }
  }

  const profile = await prisma.staffProfile.create({
    data: {
      tenantId,
      userId: data.userId,
      departmentId: data.departmentId,
      employeeId: data.employeeId,
      position: data.position,
      dateOfJoining: data.dateOfJoining ? new Date(data.dateOfJoining) : undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      gender: data.gender as any,
      address: data.address,
      emergencyContactName: data.emergencyContactName,
      emergencyContactPhone: data.emergencyContactPhone,
      salary: data.salary,
      employmentType: data.employmentType as any,
    },
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, staffId: profile.id }, 'Staff profile created');
  return profile;
}

export async function getStaffProfiles(tenantId: string, query: GetStaffProfilesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.StaffProfileWhereInput = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { employeeId: { contains: search, mode: 'insensitive' } },
      { position: { contains: search, mode: 'insensitive' } },
      { user: { firstName: { contains: search, mode: 'insensitive' } } },
      { user: { lastName: { contains: search, mode: 'insensitive' } } },
    ];
  }

  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.status) where.status = query.status as any;
  if (query.employmentType) where.employmentType = query.employmentType as any;

  const orderBy: Prisma.StaffProfileOrderByWithRelationInput = {};
  if (query.sortBy) {
    (orderBy as any)[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [profiles, total] = await Promise.all([
    prisma.staffProfile.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        department: { select: { id: true, name: true } },
      },
    }),
    prisma.staffProfile.count({ where }),
  ]);

  return { profiles, total, page, limit };
}

export async function getStaffProfileById(tenantId: string, id: string) {
  const profile = await prisma.staffProfile.findFirst({
    where: { id, tenantId },
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
      department: { select: { id: true, name: true } },
      staffLicenses: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!profile) {
    throw AppError.notFound('Staff profile not found');
  }

  return profile;
}

export async function updateStaffProfile(
  tenantId: string,
  id: string,
  data: UpdateStaffProfileInput,
) {
  const existing = await prisma.staffProfile.findFirst({
    where: { id, tenantId },
  });
  if (!existing) {
    throw AppError.notFound('Staff profile not found');
  }

  if (data.employeeId && data.employeeId !== existing.employeeId) {
    const dup = await prisma.staffProfile.findUnique({
      where: { employeeId: data.employeeId },
    });
    if (dup) {
      throw AppError.conflict('Employee ID already in use');
    }
  }

  const updateData: Prisma.StaffProfileUpdateInput = {};
  if (data.departmentId !== undefined) updateData.department = { connect: { id: data.departmentId } };
  if (data.employeeId !== undefined) updateData.employeeId = data.employeeId;
  if (data.position !== undefined) updateData.position = data.position;
  if (data.dateOfJoining !== undefined) updateData.dateOfJoining = new Date(data.dateOfJoining);
  if (data.dateOfBirth !== undefined) updateData.dateOfBirth = new Date(data.dateOfBirth);
  if (data.gender !== undefined) updateData.gender = data.gender as any;
  if (data.address !== undefined) updateData.address = data.address;
  if (data.emergencyContactName !== undefined) updateData.emergencyContactName = data.emergencyContactName;
  if (data.emergencyContactPhone !== undefined) updateData.emergencyContactPhone = data.emergencyContactPhone;
  if (data.salary !== undefined) updateData.salary = data.salary;
  if (data.employmentType !== undefined) updateData.employmentType = data.employmentType as any;
  if (data.status !== undefined) updateData.status = data.status as any;

  const profile = await prisma.staffProfile.update({
    where: { id },
    data: updateData,
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, staffId: id }, 'Staff profile updated');
  return profile;
}

export async function deactivateStaffProfile(tenantId: string, id: string) {
  const existing = await prisma.staffProfile.findFirst({
    where: { id, tenantId },
  });
  if (!existing) {
    throw AppError.notFound('Staff profile not found');
  }

  const profile = await prisma.staffProfile.update({
    where: { id },
    data: { status: 'terminated' },
  });

  logger.info({ tenantId, staffId: id }, 'Staff profile deactivated');
  return profile;
}

// ============================================================
// Licenses
// ============================================================

export async function addLicense(tenantId: string, data: AddLicenseInput) {
  // Verify staff belongs to this tenant
  const staff = await prisma.staffProfile.findFirst({
    where: { id: data.staffId, tenantId },
  });
  if (!staff) {
    throw AppError.notFound('Staff profile not found');
  }

  // Check for duplicate license number for the same staff
  const duplicate = await prisma.staffLicense.findFirst({
    where: { staffId: data.staffId, licenseNumber: data.licenseNumber },
  });
  if (duplicate) {
    throw AppError.conflict('This license number already exists for the staff member');
  }

  const license = await prisma.staffLicense.create({
    data: {
      staffId: data.staffId,
      licenseType: data.licenseType,
      licenseNumber: data.licenseNumber,
      issuingAuthority: data.issuingAuthority,
      issuedDate: data.issuedDate ? new Date(data.issuedDate) : undefined,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
      documentUrl: data.documentUrl,
      status: data.status as any,
    },
    include: {
      staff: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  logger.info({ staffId: data.staffId, licenseId: license.id }, 'Staff license added');
  return license;
}

export async function getLicenses(tenantId: string, query: GetLicensesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.StaffLicenseWhereInput = {
    staff: { tenantId },
  };

  if (query.staffId) where.staffId = query.staffId;
  if (query.status) where.status = query.status as any;

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { licenseType: { contains: search, mode: 'insensitive' } },
      { licenseNumber: { contains: search, mode: 'insensitive' } },
      { issuingAuthority: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [licenses, total] = await Promise.all([
    prisma.staffLicense.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        staff: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.staffLicense.count({ where }),
  ]);

  return { licenses, total, page, limit };
}

export async function updateLicense(tenantId: string, id: string, data: UpdateLicenseInput) {
  const existing = await prisma.staffLicense.findFirst({
    where: { id, staff: { tenantId } },
  });
  if (!existing) {
    throw AppError.notFound('License not found');
  }

  if (data.licenseNumber && data.licenseNumber !== existing.licenseNumber) {
    const dup = await prisma.staffLicense.findFirst({
      where: { staffId: existing.staffId, licenseNumber: data.licenseNumber, id: { not: id } },
    });
    if (dup) {
      throw AppError.conflict('This license number already exists for the staff member');
    }
  }

  const updateData: any = {};
  if (data.licenseType !== undefined) updateData.licenseType = data.licenseType;
  if (data.licenseNumber !== undefined) updateData.licenseNumber = data.licenseNumber;
  if (data.issuingAuthority !== undefined) updateData.issuingAuthority = data.issuingAuthority;
  if (data.issuedDate !== undefined) updateData.issuedDate = new Date(data.issuedDate);
  if (data.expiryDate !== undefined) updateData.expiryDate = new Date(data.expiryDate);
  if (data.documentUrl !== undefined) updateData.documentUrl = data.documentUrl;
  if (data.status !== undefined) updateData.status = data.status;

  const license = await prisma.staffLicense.update({
    where: { id },
    data: updateData,
  });

  logger.info({ licenseId: id }, 'Staff license updated');
  return license;
}

export async function getExpiringLicenses(tenantId: string, query: GetExpiringLicensesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + (query.daysAhead || 30));

  const where: Prisma.StaffLicenseWhereInput = {
    staff: { tenantId },
    expiryDate: {
      gte: now,
      lte: futureDate,
    },
    status: { not: 'expired' },
  };

  const [licenses, total] = await Promise.all([
    prisma.staffLicense.findMany({
      where,
      skip,
      take,
      orderBy: { expiryDate: 'asc' },
      include: {
        staff: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.staffLicense.count({ where }),
  ]);

  return { licenses, total, page, limit };
}

// ============================================================
// Duty Rosters
// ============================================================

async function resolveDefaultDepartmentId(tenantId: string): Promise<string> {
  const departments = await prisma.department.findMany({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (departments.length === 0) {
    throw AppError.badRequest(
      'No departments configured for this tenant; create one before adding rosters',
    );
  }
  const nursing = departments.find((d) => /nurs/i.test(d.name));
  return (nursing ?? departments[0]!).id;
}

async function resolveStaffForRoster(
  tenantId: string,
  data: CreateDutyRosterInput,
): Promise<{ staffId: string; departmentId: string }> {
  if (data.staffId) {
    const staff = await prisma.staffProfile.findFirst({
      where: { id: data.staffId, tenantId },
      select: { id: true, departmentId: true },
    });
    if (!staff) {
      throw AppError.notFound('Staff profile not found');
    }
    return { staffId: staff.id, departmentId: data.departmentId ?? staff.departmentId };
  }

  if (!data.userId) {
    throw AppError.badRequest('Either staffId or userId is required');
  }

  const user = await prisma.user.findFirst({
    where: { id: data.userId, tenantId },
    select: { id: true },
  });
  if (!user) {
    throw AppError.notFound('User not found in this tenant');
  }

  const existing = await prisma.staffProfile.findFirst({
    where: { userId: data.userId, tenantId },
    select: { id: true, departmentId: true },
  });
  if (existing) {
    return { staffId: existing.id, departmentId: data.departmentId ?? existing.departmentId };
  }

  const departmentId = data.departmentId ?? (await resolveDefaultDepartmentId(tenantId));
  const created = await prisma.staffProfile.create({
    data: { userId: data.userId, tenantId, departmentId },
    select: { id: true, departmentId: true },
  });
  logger.info(
    { tenantId, userId: data.userId, staffId: created.id },
    'Auto-created staff profile for roster',
  );
  return { staffId: created.id, departmentId: created.departmentId };
}

export async function createDutyRoster(
  tenantId: string,
  data: CreateDutyRosterInput,
  createdBy?: string,
) {
  const { staffId, departmentId } = await resolveStaffForRoster(tenantId, data);

  // Reject duplicate same-staff / same-date / same-shift entries; allow different
  // shifts on the same day (morning + night is legitimate for split shifts).
  const overlap = await prisma.dutyRoster.findFirst({
    where: {
      tenantId,
      staffId,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.shiftType as any,
      status: { not: 'cancelled' },
    },
  });
  if (overlap) {
    throw AppError.conflict('Staff already has a roster entry for this date and shift');
  }

  // Rosters are published on create — nurse_admin authoring is the approval.
  // No separate approve/publish step.
  const now = new Date();
  const roster = await prisma.dutyRoster.create({
    data: {
      tenantId,
      staffId,
      departmentId,
      wardId: data.wardId ?? null,
      role: data.role ?? null,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.shiftType as any,
      startTime: new Date(`1970-01-01T${data.startTime}`),
      endTime: new Date(`1970-01-01T${data.endTime}`),
      status: 'published',
      approvedBy: createdBy ?? null,
      approvedAt: now,
      createdBy: createdBy ?? null,
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      department: { select: { id: true, name: true } },
      ward: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, rosterId: roster.id }, 'Duty roster created');
  return roster;
}

export async function createDutyRosterBulk(
  tenantId: string,
  data: CreateDutyRosterBulkInput,
  createdBy?: string,
) {
  const results: { created: any[]; skipped: Array<{ index: number; reason: string }> } = {
    created: [],
    skipped: [],
  };

  for (let i = 0; i < data.entries.length; i++) {
    const entry = data.entries[i]!;
    try {
      const row = await createDutyRoster(tenantId, entry, createdBy);
      results.created.push(row);
    } catch (err: any) {
      results.skipped.push({ index: i, reason: err?.message || 'unknown error' });
    }
  }

  logger.info(
    { tenantId, created: results.created.length, skipped: results.skipped.length },
    'Duty roster bulk create',
  );
  return results;
}

export async function getDutyRosters(tenantId: string, query: GetDutyRostersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.DutyRosterWhereInput = { tenantId };

  if (query.staffId) where.staffId = query.staffId;
  // Resolve userId → staffId so callers (e.g. the nurse self-view) can ask
  // for "my shifts" without first having to fetch their staff profile. If
  // the user has no profile, return an empty page rather than the whole
  // tenant's roster.
  if (query.userId) {
    const staff = await prisma.staffProfile.findFirst({
      where: { userId: query.userId, tenantId },
      select: { id: true },
    });
    if (!staff) {
      return { rosters: [], total: 0, page, limit };
    }
    where.staffId = staff.id;
  }
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.wardId) where.wardId = query.wardId;
  if (query.role) where.role = query.role;
  if (query.shiftType) where.shiftType = query.shiftType as any;
  if (query.status) where.status = query.status as any;

  if (query.fromDate || query.toDate) {
    where.shiftDate = {};
    if (query.fromDate) where.shiftDate.gte = new Date(query.fromDate);
    if (query.toDate) where.shiftDate.lte = new Date(query.toDate);
  }

  const orderBy: Prisma.DutyRosterOrderByWithRelationInput = {};
  if (query.sortBy) {
    (orderBy as any)[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.shiftDate = 'desc';
  }

  const [rosters, total] = await Promise.all([
    prisma.dutyRoster.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        staff: {
          // user.id is needed so the nurse-admin handover screen can match
          // a roster row against a candidate user without a second roundtrip.
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
        department: { select: { id: true, name: true } },
        ward: { select: { id: true, name: true } },
      },
    }),
    prisma.dutyRoster.count({ where }),
  ]);

  return { rosters, total, page, limit };
}

export async function getDutyRosterById(tenantId: string, id: string) {
  const roster = await prisma.dutyRoster.findFirst({
    where: { id, tenantId },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      department: { select: { id: true, name: true } },
    },
  });

  if (!roster) {
    throw AppError.notFound('Duty roster not found');
  }

  return roster;
}

export async function updateDutyRoster(
  tenantId: string,
  id: string,
  data: UpdateDutyRosterInput,
) {
  const existing = await prisma.dutyRoster.findFirst({
    where: { id, tenantId },
  });
  if (!existing) {
    throw AppError.notFound('Duty roster not found');
  }

  const updateData: any = {};
  if (data.staffId !== undefined) updateData.staffId = data.staffId;
  if (data.departmentId !== undefined) updateData.departmentId = data.departmentId;
  if (data.wardId !== undefined) updateData.wardId = data.wardId;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.shiftDate !== undefined) updateData.shiftDate = new Date(data.shiftDate);
  if (data.shiftType !== undefined) updateData.shiftType = data.shiftType;
  if (data.startTime !== undefined) updateData.startTime = new Date(`1970-01-01T${data.startTime}`);
  if (data.endTime !== undefined) updateData.endTime = new Date(`1970-01-01T${data.endTime}`);
  if (data.status !== undefined) updateData.status = data.status;

  const roster = await prisma.dutyRoster.update({
    where: { id },
    data: updateData,
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      department: { select: { id: true, name: true } },
      ward: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, rosterId: id }, 'Duty roster updated');
  return roster;
}

export async function publishDutyRoster(tenantId: string, id: string, approvedBy?: string) {
  const existing = await prisma.dutyRoster.findFirst({
    where: { id, tenantId },
  });
  if (!existing) {
    throw AppError.notFound('Duty roster not found');
  }

  if (existing.status !== 'scheduled') {
    throw AppError.badRequest('Only scheduled rosters can be published');
  }

  const roster = await prisma.dutyRoster.update({
    where: { id },
    data: {
      status: 'published',
      approvedBy: approvedBy ?? null,
      approvedAt: new Date(),
    },
  });

  logger.info({ tenantId, rosterId: id }, 'Duty roster published');
  return roster;
}

// ============================================================
// Attendance
// ============================================================

export async function recordAttendance(tenantId: string, data: RecordAttendanceInput) {
  const staff = await prisma.staffProfile.findFirst({
    where: { id: data.staffId, tenantId },
  });
  if (!staff) {
    throw AppError.notFound('Staff profile not found');
  }

  // Check for duplicate attendance record on the same date
  const existing = await prisma.attendance.findUnique({
    where: {
      staffId_date: {
        staffId: data.staffId,
        date: new Date(data.date),
      },
    },
  });

  if (existing) {
    // Update existing record (e.g. adding checkout)
    const updated = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        checkIn: data.checkIn ? new Date(data.checkIn) : existing.checkIn,
        checkOut: data.checkOut ? new Date(data.checkOut) : existing.checkOut,
        source: data.source as any,
        status: data.status as any,
        overtimeHours: data.overtimeHours,
        notes: data.notes ?? existing.notes,
      },
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    logger.info({ tenantId, attendanceId: updated.id }, 'Attendance updated');
    return updated;
  }

  const attendance = await prisma.attendance.create({
    data: {
      tenantId,
      staffId: data.staffId,
      date: new Date(data.date),
      checkIn: data.checkIn ? new Date(data.checkIn) : undefined,
      checkOut: data.checkOut ? new Date(data.checkOut) : undefined,
      source: data.source as any,
      status: data.status as any,
      overtimeHours: data.overtimeHours,
      notes: data.notes,
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, attendanceId: attendance.id }, 'Attendance recorded');
  return attendance;
}

export async function getAttendance(tenantId: string, query: GetAttendanceQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.AttendanceWhereInput = { tenantId };

  if (query.staffId) where.staffId = query.staffId;
  if (query.status) where.status = query.status as any;

  if (query.fromDate || query.toDate) {
    where.date = {};
    if (query.fromDate) where.date.gte = new Date(query.fromDate);
    if (query.toDate) where.date.lte = new Date(query.toDate);
  }

  const orderBy: Prisma.AttendanceOrderByWithRelationInput = {};
  if (query.sortBy) {
    (orderBy as any)[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.date = 'desc';
  }

  const [records, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    prisma.attendance.count({ where }),
  ]);

  return { records, total, page, limit };
}

export async function getAttendanceSummary(tenantId: string, query: GetAttendanceSummaryQuery) {
  const startDate = new Date(query.year, query.month - 1, 1);
  const endDate = new Date(query.year, query.month, 0); // last day of month

  const where: Prisma.AttendanceWhereInput = {
    tenantId,
    date: { gte: startDate, lte: endDate },
  };

  if (query.staffId) where.staffId = query.staffId;

  const records = await prisma.attendance.findMany({
    where,
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  // Aggregate by staff
  const staffMap = new Map<
    string,
    {
      staffId: string;
      staffName: string;
      present: number;
      absent: number;
      halfDay: number;
      onLeave: number;
      holiday: number;
      totalOvertimeHours: number;
    }
  >();

  for (const record of records) {
    const key = record.staffId;
    if (!staffMap.has(key)) {
      staffMap.set(key, {
        staffId: key,
        staffName: `${record.staff.user.firstName} ${record.staff.user.lastName}`,
        present: 0,
        absent: 0,
        halfDay: 0,
        onLeave: 0,
        holiday: 0,
        totalOvertimeHours: 0,
      });
    }

    const entry = staffMap.get(key)!;
    switch (record.status) {
      case 'present':
        entry.present++;
        break;
      case 'absent':
        entry.absent++;
        break;
      case 'half_day':
        entry.halfDay++;
        break;
      case 'on_leave':
        entry.onLeave++;
        break;
      case 'holiday':
        entry.holiday++;
        break;
    }
    entry.totalOvertimeHours += Number(record.overtimeHours);
  }

  return {
    month: query.month,
    year: query.year,
    summary: Array.from(staffMap.values()),
  };
}

// ============================================================
// Leave Requests
// ============================================================

export async function applyLeave(tenantId: string, data: ApplyLeaveInput) {
  const staff = await prisma.staffProfile.findFirst({
    where: { id: data.staffId, tenantId },
  });
  if (!staff) {
    throw AppError.notFound('Staff profile not found');
  }

  const startDate = new Date(data.startDate);
  const endDate = new Date(data.endDate);

  if (endDate < startDate) {
    throw AppError.badRequest('End date must be after start date');
  }

  // Check for overlapping approved/pending leave requests
  const overlap = await prisma.leaveRequest.findFirst({
    where: {
      tenantId,
      staffId: data.staffId,
      status: { in: ['pending', 'approved'] },
      OR: [
        { startDate: { lte: endDate }, endDate: { gte: startDate } },
      ],
    },
  });
  if (overlap) {
    throw AppError.conflict('Overlapping leave request already exists');
  }

  const leave = await prisma.leaveRequest.create({
    data: {
      tenantId,
      staffId: data.staffId,
      leaveType: data.leaveType as any,
      startDate,
      endDate,
      reason: data.reason,
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, leaveId: leave.id }, 'Leave request submitted');
  return leave;
}

export async function getLeaves(tenantId: string, query: GetLeavesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.LeaveRequestWhereInput = { tenantId };

  if (query.staffId) where.staffId = query.staffId;
  if (query.status) where.status = query.status as any;
  if (query.leaveType) where.leaveType = query.leaveType as any;

  if (query.fromDate || query.toDate) {
    where.startDate = {};
    if (query.fromDate) where.startDate.gte = new Date(query.fromDate);
    if (query.toDate) where.startDate.lte = new Date(query.toDate);
  }

  const orderBy: Prisma.LeaveRequestOrderByWithRelationInput = {};
  if (query.sortBy) {
    (orderBy as any)[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [leaves, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        approver: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.leaveRequest.count({ where }),
  ]);

  return { leaves, total, page, limit };
}

export async function approveLeave(tenantId: string, id: string, approvedBy: string) {
  const leave = await prisma.leaveRequest.findFirst({
    where: { id, tenantId },
  });
  if (!leave) {
    throw AppError.notFound('Leave request not found');
  }
  if (leave.status !== 'pending') {
    throw AppError.badRequest('Only pending leave requests can be approved');
  }

  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy,
      approvedAt: new Date(),
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, leaveId: id, approvedBy }, 'Leave request approved');
  return updated;
}

export async function rejectLeave(tenantId: string, id: string, approvedBy: string) {
  const leave = await prisma.leaveRequest.findFirst({
    where: { id, tenantId },
  });
  if (!leave) {
    throw AppError.notFound('Leave request not found');
  }
  if (leave.status !== 'pending') {
    throw AppError.badRequest('Only pending leave requests can be rejected');
  }

  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: {
      status: 'rejected',
      approvedBy,
      approvedAt: new Date(),
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, leaveId: id, approvedBy }, 'Leave request rejected');
  return updated;
}

export async function getLeaveBalance(tenantId: string, userId: string) {
  // Find the staff profile for the user
  const staff = await prisma.staffProfile.findFirst({
    where: { userId, tenantId },
  });
  if (!staff) {
    throw AppError.notFound('Staff profile not found for this user');
  }

  const currentYear = new Date().getFullYear();
  const yearStart = new Date(currentYear, 0, 1);
  const yearEnd = new Date(currentYear, 11, 31);

  // Count approved leaves for the current year
  const approvedLeaves = await prisma.leaveRequest.findMany({
    where: {
      tenantId,
      staffId: staff.id,
      status: 'approved',
      startDate: { gte: yearStart },
      endDate: { lte: yearEnd },
    },
  });

  // Calculate days used per leave type
  const leaveTypes = ['vacation', 'sick', 'casual', 'maternity', 'paternity', 'unpaid', 'other'] as const;

  const balance: Record<string, { used: number; pending: number }> = {};
  for (const lt of leaveTypes) {
    balance[lt] = { used: 0, pending: 0 };
  }

  for (const leave of approvedLeaves) {
    const start = new Date(leave.startDate);
    const end = new Date(leave.endDate);
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    balance[leave.leaveType].used += days;
  }

  // Also count pending leaves
  const pendingLeaves = await prisma.leaveRequest.findMany({
    where: {
      tenantId,
      staffId: staff.id,
      status: 'pending',
      startDate: { gte: yearStart },
      endDate: { lte: yearEnd },
    },
  });

  for (const leave of pendingLeaves) {
    const start = new Date(leave.startDate);
    const end = new Date(leave.endDate);
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    balance[leave.leaveType].pending += days;
  }

  return {
    staffId: staff.id,
    userId,
    year: currentYear,
    balance,
  };
}

// ============================================================
// Payroll
// ============================================================

export async function generatePayroll(tenantId: string, data: GeneratePayrollInput, processedBy: string) {
  const staff = await prisma.staffProfile.findFirst({
    where: { id: data.staffId, tenantId },
  });
  if (!staff) {
    throw AppError.notFound('Staff profile not found');
  }

  // Check for duplicate payroll in the same period
  const existing = await prisma.payroll.findFirst({
    where: {
      tenantId,
      staffId: data.staffId,
      payPeriodStart: new Date(data.payPeriodStart),
      payPeriodEnd: new Date(data.payPeriodEnd),
    },
  });
  if (existing) {
    throw AppError.conflict('Payroll already generated for this staff and period');
  }

  const basicSalary = Number(staff.salary ?? 0);
  const allowances = data.allowances || 0;
  const deductions = data.deductions || 0;
  const overtimePay = data.overtimePay || 0;
  const taxDeduction = data.taxDeduction || 0;
  const grossSalary = basicSalary + allowances + overtimePay;
  const netSalary = grossSalary - deductions - taxDeduction;

  const payroll = await prisma.payroll.create({
    data: {
      tenantId,
      staffId: data.staffId,
      payPeriodStart: new Date(data.payPeriodStart),
      payPeriodEnd: new Date(data.payPeriodEnd),
      basicSalary,
      allowances,
      deductions,
      overtimePay,
      taxDeduction,
      grossSalary,
      netSalary,
      processedBy,
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, payrollId: payroll.id }, 'Payroll generated');
  return payroll;
}

export async function getPayrollList(tenantId: string, query: GetPayrollListQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.PayrollWhereInput = { tenantId };

  if (query.staffId) where.staffId = query.staffId;
  if (query.status) where.status = query.status as any;

  if (query.fromDate || query.toDate) {
    where.payPeriodStart = {};
    if (query.fromDate) where.payPeriodStart.gte = new Date(query.fromDate);
    if (query.toDate) where.payPeriodStart.lte = new Date(query.toDate);
  }

  const orderBy: Prisma.PayrollOrderByWithRelationInput = {};
  if (query.sortBy) {
    (orderBy as any)[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [payrolls, total] = await Promise.all([
    prisma.payroll.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    prisma.payroll.count({ where }),
  ]);

  return { payrolls, total, page, limit };
}

export async function getPayrollById(tenantId: string, id: string) {
  const payroll = await prisma.payroll.findFirst({
    where: { id, tenantId },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      processor: { select: { firstName: true, lastName: true } },
      salarySlip: true,
    },
  });

  if (!payroll) {
    throw AppError.notFound('Payroll record not found');
  }

  return payroll;
}

export async function approvePayroll(tenantId: string, id: string, processedBy: string) {
  const payroll = await prisma.payroll.findFirst({
    where: { id, tenantId },
  });
  if (!payroll) {
    throw AppError.notFound('Payroll record not found');
  }
  if (payroll.status !== 'draft') {
    throw AppError.badRequest('Only draft payrolls can be approved');
  }

  const updated = await prisma.payroll.update({
    where: { id },
    data: {
      status: 'processed',
      processedBy,
    },
    include: {
      staff: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info({ tenantId, payrollId: id, processedBy }, 'Payroll approved');
  return updated;
}

/**
 * Generate a unique slip number.
 */
function generateSlipNumber(payrollId: string): string {
  const now = new Date();
  const dateStr =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const suffix = payrollId.slice(-6).toUpperCase();
  return `SLIP-${dateStr}-${suffix}`;
}

export async function getPayslip(tenantId: string, payrollId: string) {
  const payroll = await prisma.payroll.findFirst({
    where: { id: payrollId, tenantId },
    include: {
      staff: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      salarySlip: true,
    },
  });

  if (!payroll) {
    throw AppError.notFound('Payroll record not found');
  }

  // If salary slip already exists, return it
  if (payroll.salarySlip) {
    return { payroll, salarySlip: payroll.salarySlip };
  }

  // Create the salary slip on first access
  const slipNumber = generateSlipNumber(payrollId);
  const salarySlip = await prisma.salarySlip.create({
    data: {
      payrollId,
      staffId: payroll.staffId,
      slipNumber,
    },
  });

  logger.info({ tenantId, payrollId, slipId: salarySlip.id }, 'Salary slip generated');
  return { payroll, salarySlip };
}
