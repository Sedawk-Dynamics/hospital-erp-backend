import crypto from 'crypto';
import { prisma } from '../../config/database';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { commissionService } from '../commission/commission.service';

// ────────────────────────────────────────────────────────────
// MRN Generation (mirrors patients.service.ts)
// ────────────────────────────────────────────────────────────

async function generateMRN(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `MRN-${dateStr}-`;

  const latestPatient = await prisma.patient.findFirst({
    where: { tenantId, mrn: { startsWith: prefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });

  let nextNumber = 1;
  if (latestPatient?.mrn) {
    const lastNumber = parseInt(latestPatient.mrn.replace(prefix, ''), 10);
    if (!isNaN(lastNumber)) nextNumber = lastNumber + 1;
  }

  const mrn = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.patient.findFirst({
    where: { tenantId, mrn },
  });
  if (existing) return generateMRN(tenantId);

  return mrn;
}

// ────────────────────────────────────────────────────────────
// Connection-based patient lookup
// ────────────────────────────────────────────────────────────

async function findConnectedPatients(userId: string, tenantId?: string) {
  const where: Record<string, unknown> = {
    userId,
    status: 'approved',
    patientId: { not: null },
  };
  if (tenantId) where.tenantId = tenantId;

  const connections = await prisma.patientHospitalConnection.findMany({
    where,
    select: { patientId: true, tenantId: true },
  });

  return connections
    .filter((c) => c.patientId !== null)
    .map((c) => ({ id: c.patientId!, tenantId: c.tenantId }));
}

/**
 * Fallback: find patients by email (for backward compat when no connections exist).
 */
async function findPatientsByEmail(email: string) {
  return prisma.patient.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, tenantId: true },
  });
}

/**
 * Resolve patient IDs: use connections if any exist, else fall back to email match.
 */
async function resolvePatientIds(userId: string, email: string, tenantId?: string) {
  const connected = await findConnectedPatients(userId, tenantId);
  if (connected.length > 0) return connected.map((p) => p.id);

  // Fallback for patients who existed before connections were introduced
  const byEmail = await findPatientsByEmail(email);
  if (tenantId) return byEmail.filter((p) => p.tenantId === tenantId).map((p) => p.id);
  return byEmail.map((p) => p.id);
}

// ────────────────────────────────────────────────────────────
// Hospital Search & Discovery
// ────────────────────────────────────────────────────────────

/**
 * Look up a hospital by its 6-digit code or by name.
 */
export async function lookupHospital(userId: string, query: { code?: string; search?: string }) {
  const where: Record<string, unknown> = {
    slug: { not: '__platform__' },
    isActive: true,
  };

  // Exact code match takes priority
  if (query.code) {
    where.hospitalCode = { equals: query.code.toUpperCase(), mode: 'insensitive' };
  } else if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { hospitalCode: { equals: query.search.toUpperCase(), mode: 'insensitive' } },
    ];
  } else {
    return { data: [] };
  }

  const hospitals = await prisma.tenant.findMany({
    where,
    take: 10,
    select: {
      id: true,
      name: true,
      slug: true,
      hospitalCode: true,
      logoUrl: true,
      city: true,
      state: true,
      address: true,
      phone: true,
      email: true,
      allowDirectPatientConnection: true,
    },
    orderBy: { name: 'asc' },
  });

  // Get user's existing connections
  const connections = await prisma.patientHospitalConnection.findMany({
    where: { userId, tenantId: { in: hospitals.map((h) => h.id) } },
    select: { tenantId: true, status: true },
  });
  const connectionMap = new Map(connections.map((c) => [c.tenantId, c.status]));

  return {
    data: hospitals.map((h) => ({
      ...h,
      connectionStatus: connectionMap.get(h.id) ?? 'none',
    })),
  };
}

// ────────────────────────────────────────────────────────────
// Connection Management (Patient Side)
// ────────────────────────────────────────────────────────────

export async function requestConnection(
  userId: string,
  email: string,
  tenantId: string,
  message?: string,
) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, isActive: true, allowDirectPatientConnection: true },
  });

  if (!tenant || !tenant.isActive || tenant.slug === '__platform__') {
    throw AppError.notFound('Hospital not found');
  }

  // Check for existing connection
  const existing = await prisma.patientHospitalConnection.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
  });

  if (existing) {
    if (existing.status === 'approved') throw AppError.conflict('Already connected to this hospital');
    if (existing.status === 'pending') throw AppError.conflict('Connection request already pending');
    // If rejected, allow re-request
    if (existing.status === 'rejected') {
      const updated = await prisma.patientHospitalConnection.update({
        where: { id: existing.id },
        data: { status: 'pending', requestMessage: message, rejectionReason: null, reviewedBy: null, reviewedAt: null },
        include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
      });
      return updated;
    }
  }

  // If hospital allows direct connection, auto-approve
  if (tenant.allowDirectPatientConnection) {
    const patientId = await createPatientInTenant(userId, email, tenantId);
    const connection = await prisma.patientHospitalConnection.create({
      data: {
        userId,
        tenantId,
        status: 'approved',
        patientId,
        requestMessage: message,
      },
      include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
    });
    return connection;
  }

  // Otherwise create pending request
  const connection = await prisma.patientHospitalConnection.create({
    data: {
      userId,
      tenantId,
      status: 'pending',
      requestMessage: message,
    },
    include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
  });
  return connection;
}

export async function getMyConnections(userId: string) {
  return prisma.patientHospitalConnection.findMany({
    where: { userId },
    include: {
      tenant: {
        select: { id: true, name: true, slug: true, hospitalCode: true, logoUrl: true, city: true, state: true, address: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function cancelConnection(userId: string, connectionId: string) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, userId },
  });

  if (!connection) throw AppError.notFound('Connection not found');
  if (connection.status !== 'pending') {
    throw AppError.badRequest('Only pending requests can be cancelled');
  }

  await prisma.patientHospitalConnection.delete({ where: { id: connectionId } });
  return { success: true };
}

// ────────────────────────────────────────────────────────────
// Connection Management (Hospital Staff / Admin Side)
// ────────────────────────────────────────────────────────────

export async function listConnectionRequests(
  tenantId: string,
  query: { status?: string; limit?: number; page?: number },
) {
  const limit = query.limit || 30;
  const page = query.page || 1;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId };
  if (query.status) where.status = query.status;

  const [connections, total] = await Promise.all([
    prisma.patientHospitalConnection.findMany({
      where,
      take: limit,
      skip,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        patient: { select: { id: true, mrn: true } },
        reviewer: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.patientHospitalConnection.count({ where }),
  ]);

  return { data: connections, meta: { total, page, limit } };
}

export async function approveConnection(
  tenantId: string,
  connectionId: string,
  reviewerId: string,
) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, tenantId, status: 'pending' },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!connection) throw AppError.notFound('Pending connection request not found');

  const patientId = await createPatientInTenant(connection.userId, connection.user.email, tenantId);

  return prisma.patientHospitalConnection.update({
    where: { id: connectionId },
    data: {
      status: 'approved',
      patientId,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
}

export async function rejectConnection(
  tenantId: string,
  connectionId: string,
  reviewerId: string,
  reason?: string,
) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, tenantId, status: 'pending' },
  });

  if (!connection) throw AppError.notFound('Pending connection request not found');

  return prisma.patientHospitalConnection.update({
    where: { id: connectionId },
    data: {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
}

// ────────────────────────────────────────────────────────────
// Internal: Create patient record in a hospital tenant
// ────────────────────────────────────────────────────────────

async function createPatientInTenant(userId: string, email: string, tenantId: string): Promise<string> {
  // Check if patient already exists in this tenant by email
  const existingPatient = await prisma.patient.findFirst({
    where: { tenantId, email: { equals: email, mode: 'insensitive' } },
  });
  if (existingPatient) return existingPatient.id;

  // Get user info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true, phone: true },
  });
  if (!user) throw AppError.notFound('User not found');

  const mrn = await generateMRN(tenantId);

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      registrationSource: 'self_signup',
      patientType: 'outpatient',
    },
  });

  return patient.id;
}

// ────────────────────────────────────────────────────────────
// Patient Portal Data Queries (updated to use connections)
// ────────────────────────────────────────────────────────────

export async function getPatientProfile(userId: string, email: string) {
  const patients = await prisma.patient.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: {
      emergencyContacts: true,
      allergies: true,
      tenant: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (patients.length === 0) return null;
  return patients[0];
}

export async function getPatientAppointments(
  userId: string,
  email: string,
  query: { status?: string; limit?: number; sortOrder?: 'asc' | 'desc'; tenantId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId);
  if (patientIds.length === 0) return { data: [] };

  const limit = query.limit || 50;
  const where: Record<string, unknown> = { patientId: { in: patientIds } };
  if (query.status) where.status = query.status;

  const appointments = await prisma.appointment.findMany({
    where,
    take: limit,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { appointmentDate: query.sortOrder || 'desc' },
  });

  return { data: appointments };
}

export async function getPatientLabReports(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId);
  if (patientIds.length === 0) return { data: [] };

  const reports = await prisma.labReport.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 50,
    include: {
      labOrder: {
        select: {
          id: true,
          status: true,
          labOrderItems: {
            select: { id: true, test: { select: { id: true, testName: true, testCode: true } } },
          },
        },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: reports };
}

export async function getPatientPrescriptions(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId);
  if (patientIds.length === 0) return { data: [] };

  const prescriptions = await prisma.prescription.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 30,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      prescriptionItems: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: prescriptions };
}

export async function getPatientBills(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId);
  if (patientIds.length === 0) return { data: [] };

  const bills = await prisma.bill.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 30,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      billItems: { select: { id: true, description: true, totalAmount: true } },
      payments: { select: { id: true, amount: true, paymentMethod: true, status: true, paymentDate: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: bills };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Convert HH:MM string to a Date object for @db.Time columns */
function timeToDate(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(`1970-01-01T${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00.000Z`);
}

// ────────────────────────────────────────────────────────────
// Appointment Booking (Patient Side)
// ────────────────────────────────────────────────────────────

/**
 * List all active hospitals for patient to book appointments.
 */
export async function getAllHospitalsForBooking(
  query: { search?: string; page?: number; limit?: number } = {},
) {
  const limit = query.limit || 10;
  const page = query.page || 1;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    slug: { not: '__platform__' },
    isActive: true,
  };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { city: { contains: query.search, mode: 'insensitive' } },
      { state: { contains: query.search, mode: 'insensitive' } },
      { address: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [hospitals, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        hospitalCode: true,
        logoUrl: true,
        city: true,
        state: true,
        address: true,
        phone: true,
        email: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.tenant.count({ where }),
  ]);

  return { data: hospitals, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/**
 * List doctors available in a hospital for the patient to book with.
 * No connection required — open booking.
 *
 * If users with the "doctor" role exist but lack a DoctorProfile row,
 * a profile is auto-created so they appear in booking and downstream
 * slot / appointment flows work (Appointment.doctorId → DoctorProfile).
 */
export async function getDoctorsForBooking(
  userId: string,
  tenantId: string,
  query: { departmentId?: string; search?: string },
) {
  // ── Auto-create missing DoctorProfile rows ──────────────────
  const doctorUsersWithoutProfile = await prisma.user.findMany({
    where: {
      tenantId,
      isActive: true,
      userRoles: { some: { role: { name: 'doctor' } } },
      doctorProfile: null,
    },
    select: { id: true },
  });

  if (doctorUsersWithoutProfile.length > 0) {
    // Ensure at least one department exists for the tenant
    let defaultDept = await prisma.department.findFirst({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    if (!defaultDept) {
      defaultDept = await prisma.department.create({
        data: { tenantId, name: 'General', isActive: true },
        select: { id: true },
      });
    }

    for (const u of doctorUsersWithoutProfile) {
      await prisma.doctorProfile.create({
        data: {
          userId: u.id,
          tenantId,
          departmentId: defaultDept.id,
          isAvailable: true,
        },
      });
    }
  }

  // ── Query DoctorProfile as before ───────────────────────────
  const where: Record<string, unknown> = { tenantId, isAvailable: true };
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.search) {
    where.OR = [
      { specialization: { contains: query.search, mode: 'insensitive' } },
      { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const doctors = await prisma.doctorProfile.findMany({
    where,
    take: 50,
    include: {
      user: { select: { firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
      schedules: { where: { isActive: true }, orderBy: { dayOfWeek: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    data: doctors.map((d) => ({
      id: d.id,
      userId: d.userId,
      firstName: d.user.firstName,
      lastName: d.user.lastName,
      specialization: d.specialization,
      qualifications: d.qualifications,
      consultationFee: d.consultationFee ? Number(d.consultationFee) : null,
      experienceYears: d.experienceYears,
      department: d.department,
      availableDays: [...new Set(d.schedules.map((s) => s.dayOfWeek))],
    })),
  };
}

/**
 * Get available time slots for a doctor on a given date (patient-facing).
 */
export async function getDoctorSlotsForPatient(
  userId: string,
  tenantId: string,
  doctorId: string,
  date: string,
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId, isAvailable: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  const targetDate = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  targetDate.setHours(0, 0, 0, 0);
  if (targetDate < today) {
    return { date, doctorId, slots: [], message: 'Cannot view slots for past dates' };
  }
  targetDate.setHours(0, 0, 0, 0);
  const dayOfWeek = targetDate.getDay();

  const schedule = await prisma.doctorSchedule.findFirst({
    where: { doctorId, dayOfWeek, isActive: true },
  });
  if (!schedule) {
    return { date, doctorId, slots: [], message: 'Doctor is not available on this day' };
  }

  // Check for leaves
  const leave = await prisma.doctorLeave.findFirst({
    where: { doctorId, leaveDate: targetDate },
  });
  if (leave && !leave.startTime && !leave.endTime) {
    return { date, doctorId, slots: [], message: 'Doctor is on leave on this date' };
  }

  // Generate slots
  const schedStartTime = schedule.startTime as Date;
  const schedEndTime = schedule.endTime as Date;
  const startMinutes = schedStartTime.getUTCHours() * 60 + schedStartTime.getUTCMinutes();
  const endMinutes = schedEndTime.getUTCHours() * 60 + schedEndTime.getUTCMinutes();
  const slotDuration = schedule.slotDurationMinutes;

  // Get booked appointments
  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setHours(23, 59, 59, 999);

  const existingAppointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show'] },
    },
    select: { startTime: true, endTime: true },
  });

  const bookedSlots = existingAppointments.map((apt) => ({
    start: apt.startTime as Date,
    end: apt.endTime as Date | null,
  }));

  const slots: Array<{ startTime: string; endTime: string; available: boolean }> = [];
  let current = startMinutes;

  while (current + slotDuration <= endMinutes) {
    const slotStart = `${Math.floor(current / 60).toString().padStart(2, '0')}:${(current % 60).toString().padStart(2, '0')}`;
    const slotEndMin = current + slotDuration;
    const slotEnd = `${Math.floor(slotEndMin / 60).toString().padStart(2, '0')}:${(slotEndMin % 60).toString().padStart(2, '0')}`;

    const isBooked = bookedSlots.some((booked) => {
      const bsH = (booked.start as Date).getUTCHours();
      const bsM = (booked.start as Date).getUTCMinutes();
      const bs = `${bsH.toString().padStart(2, '0')}:${bsM.toString().padStart(2, '0')}`;
      const beH = booked.end ? (booked.end as Date).getUTCHours() : bsH + 1;
      const beM = booked.end ? (booked.end as Date).getUTCMinutes() : bsM;
      const be = `${beH.toString().padStart(2, '0')}:${beM.toString().padStart(2, '0')}`;
      return bs === slotStart || (bs < slotEnd && be > slotStart);
    });

    slots.push({ startTime: slotStart, endTime: slotEnd, available: !isBooked });
    current += slotDuration;
  }

  return { date, doctorId, slots };
}

/**
 * Book an appointment as a patient.
 */
export async function bookAppointmentAsPatient(
  userId: string,
  email: string,
  tenantId: string,
  data: { doctorId: string; appointmentDate: string; startTime: string; endTime: string; reason?: string },
) {
  // Verify hospital exists
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, isActive: true, slug: true },
  });
  if (!tenant || !tenant.isActive || tenant.slug === '__platform__') {
    throw AppError.notFound('Hospital not found');
  }

  // Auto-create connection + patient record if not exists
  let connection = await prisma.patientHospitalConnection.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
  });

  if (!connection) {
    // Create patient record and approved connection automatically
    const patientId = await createPatientInTenant(userId, email, tenantId);
    connection = await prisma.patientHospitalConnection.create({
      data: { userId, tenantId, status: 'approved', patientId },
    });
  } else if (connection.status !== 'approved' || !connection.patientId) {
    // Upgrade existing connection to approved
    const patientId = connection.patientId || await createPatientInTenant(userId, email, tenantId);
    connection = await prisma.patientHospitalConnection.update({
      where: { id: connection.id },
      data: { status: 'approved', patientId },
    });
  }

  const patientId = connection.patientId!;

  // Verify doctor
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId, isAvailable: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found or unavailable');

  const appointmentDate = new Date(data.appointmentDate);
  appointmentDate.setHours(0, 0, 0, 0);

  // Prevent booking in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (appointmentDate < today) {
    throw AppError.badRequest('Cannot book an appointment in the past');
  }

  // Check leave
  const leave = await prisma.doctorLeave.findFirst({
    where: { doctorId: data.doctorId, leaveDate: appointmentDate },
  });
  if (leave && !leave.startTime && !leave.endTime) {
    throw AppError.badRequest('Doctor is on leave on the selected date');
  }

  // Check slot conflict
  const dayStart = new Date(appointmentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(appointmentDate);
  dayEnd.setHours(23, 59, 59, 999);

  const startTimeDate = timeToDate(data.startTime);
  const endTimeDate = timeToDate(data.endTime);

  const conflicting = await prisma.appointment.findFirst({
    where: {
      doctorId: data.doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show'] },
      OR: [
        { startTime: { lt: endTimeDate }, endTime: { gt: startTimeDate } },
      ],
    },
  });
  if (conflicting) throw AppError.conflict('This time slot is already booked');

  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      patientId,
      doctorId: data.doctorId,
      appointmentDate,
      startTime: startTimeDate,
      endTime: endTimeDate,
      appointmentType: 'scheduled',
      visitType: 'new',
      reason: data.reason,
      status: 'booked',
      bookedBy: userId,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  return appointment;
}

/**
 * Cancel an appointment as a patient.
 */
export async function cancelAppointmentAsPatient(
  userId: string,
  email: string,
  appointmentId: string,
) {
  // Find the appointment and verify it belongs to the patient
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);

  if (patientIds.length === 0) {
    // Fallback to email
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, patientId: { in: patientIds } },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (!['booked', 'confirmed'].includes(appointment.status)) {
    throw AppError.badRequest('Only booked or confirmed appointments can be cancelled');
  }

  const updated = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: 'cancelled',
      cancelledBy: userId,
      cancellationReason: 'Cancelled by patient',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  return updated;
}

/**
 * List departments for a connected hospital.
 */
export async function getDepartmentsForBooking(userId: string, tenantId: string) {
  const departments = await prisma.department.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return { data: departments };
}

// ────────────────────────────────────────────────────────────
// Payment Info & Online Payment
// ────────────────────────────────────────────────────────────

/**
 * Check if a hospital supports online payments.
 */
export async function getPaymentInfo(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { linkedAccountId: true, bankVerified: true },
  });
  if (!tenant) throw AppError.notFound('Hospital not found');

  return {
    onlinePaymentAvailable: !!tenant.linkedAccountId && tenant.bankVerified,
  };
}

/**
 * Generate a bill number in IST timezone (BILL-YYYYMMDD-XXXX).
 */
async function generateBillNumber(tenantId: string): Promise<string> {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = (ist.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = ist.getUTCDate().toString().padStart(2, '0');
  const prefix = `BILL-${y}${m}${d}-`;

  const latest = await prisma.bill.findFirst({
    where: { tenantId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  });

  let next = 1;
  if (latest?.billNumber) {
    next = parseInt(latest.billNumber.split('-').pop() || '0', 10) + 1;
  }

  const billNumber = `${prefix}${next.toString().padStart(4, '0')}`;

  const dup = await prisma.bill.findFirst({ where: { tenantId, billNumber } });
  if (dup) return generateBillNumber(tenantId);

  return billNumber;
}

/**
 * Create a Razorpay order so the patient can pay online for a booked appointment.
 * Creates a Bill + BillItem + Payment + PaymentTransfer in one go.
 */
export async function createPatientPaymentOrder(
  userId: string,
  email: string,
  data: { appointmentId: string },
) {
  // Resolve patient
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);
  if (patientIds.length === 0) {
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: data.appointmentId, patientId: { in: patientIds } },
    include: { doctor: true },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  const consultationFee = appointment.doctor.consultationFee
    ? Number(appointment.doctor.consultationFee)
    : 0;
  if (consultationFee <= 0) {
    throw AppError.badRequest('No consultation fee for this doctor');
  }

  const tenantId = appointment.tenantId;

  // Verify hospital has bank linked
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.linkedAccountId || !tenant.bankVerified) {
    throw AppError.badRequest('Hospital bank account not linked. Online payment unavailable.');
  }

  // Check if a bill already exists for this appointment (avoid duplicates)
  const existingBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointment.id } },
      status: { in: ['pending', 'partially_paid'] },
    },
  });

  let billId: string;

  if (existingBill) {
    billId = existingBill.id;
  } else {
    // Create a bill + bill item for the consultation fee
    const billNumber = await generateBillNumber(tenantId);
    const bill = await prisma.bill.create({
      data: {
        tenantId,
        patientId: appointment.patientId,
        billNumber,
        billDate: new Date(),
        subtotal: consultationFee,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: consultationFee,
        insuranceCoveredAmount: 0,
        patientPayableAmount: consultationFee,
        amountPaid: 0,
        balanceDue: consultationFee,
        status: 'pending',
        generatedBy: userId,
        billItems: {
          create: {
            description: 'Consultation Fee',
            category: 'consultation',
            quantity: 1,
            unitPrice: consultationFee,
            discountPercent: 0,
            discountAmount: 0,
            taxPercent: 0,
            taxAmount: 0,
            totalAmount: consultationFee,
            referenceType: 'appointment',
            referenceId: appointment.id,
          },
        },
      },
    });
    billId = bill.id;
  }

  // Commission calculation
  const commissionPercent = await commissionService.getCommissionForTenant(tenantId);
  const commissionAmount = Math.round((consultationFee * commissionPercent / 100) * 100) / 100;
  const hospitalAmount = Math.round((consultationFee - commissionAmount) * 100) / 100;
  const amountInPaise = Math.round(consultationFee * 100);

  // Create Razorpay order
  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `appt_${data.appointmentId.slice(0, 8)}_${Date.now()}`,
    notes: { tenantId, billId, appointmentId: data.appointmentId },
  });

  // Create payment + transfer records
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      billId,
      patientId: appointment.patientId,
      paymentDate: new Date(),
      amount: consultationFee,
      paymentMethod: 'upi',
      paymentType: 'regular',
      status: 'pending',
      processedBy: userId,
      gatewayReference: order.id,
      notes: 'Online consultation fee payment',
    },
  });

  await prisma.paymentTransfer.create({
    data: {
      tenantId,
      paymentId: payment.id,
      razorpayOrderId: order.id,
      totalAmount: consultationFee,
      commissionAmount,
      hospitalAmount,
      commissionPercent,
      transferStatus: 'pending',
    },
  });

  logger.info({ appointmentId: data.appointmentId, billId, orderId: order.id }, 'Patient payment order created');

  return {
    orderId: order.id,
    amount: amountInPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    paymentId: payment.id,
    billId,
  };
}

/**
 * Verify a Razorpay payment signature (patient portal).
 */
export async function verifyPatientPayment(data: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const body = data.razorpay_order_id + '|' + data.razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== data.razorpay_signature) {
    throw AppError.badRequest('Payment verification failed: Invalid signature');
  }

  const transfer = await prisma.paymentTransfer.findUnique({
    where: { razorpayOrderId: data.razorpay_order_id },
  });
  if (!transfer) throw AppError.notFound('Payment transfer not found');

  await prisma.paymentTransfer.update({
    where: { id: transfer.id },
    data: { razorpayPaymentId: data.razorpay_payment_id },
  });

  return { verified: true, transferId: transfer.id };
}

/**
 * Mark an appointment for front-desk payment.
 * Creates a pending Bill so the front desk knows to collect.
 */
export async function confirmFrontdeskPayment(
  userId: string,
  email: string,
  data: { appointmentId: string },
) {
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);
  if (patientIds.length === 0) {
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: data.appointmentId, patientId: { in: patientIds } },
    include: { doctor: true },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  const tenantId = appointment.tenantId;
  const consultationFee = appointment.doctor.consultationFee
    ? Number(appointment.doctor.consultationFee)
    : 0;

  // Check if a bill already exists for this appointment
  const existingBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointment.id } },
    },
  });

  if (existingBill) {
    return { billId: existingBill.id, status: existingBill.status };
  }

  // Create a pending bill for front desk collection
  const billNumber = await generateBillNumber(tenantId);
  const amount = consultationFee > 0 ? consultationFee : 0;

  const bill = await prisma.bill.create({
    data: {
      tenantId,
      patientId: appointment.patientId,
      billNumber,
      billDate: new Date(),
      subtotal: amount,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: amount,
      insuranceCoveredAmount: 0,
      patientPayableAmount: amount,
      amountPaid: 0,
      balanceDue: amount,
      status: 'pending',
      generatedBy: userId,
      billItems: {
        create: {
          description: 'Consultation Fee (Pay at Front Desk)',
          category: 'consultation',
          quantity: 1,
          unitPrice: amount,
          discountPercent: 0,
          discountAmount: 0,
          taxPercent: 0,
          taxAmount: 0,
          totalAmount: amount,
          referenceType: 'appointment',
          referenceId: appointment.id,
        },
      },
    },
  });

  logger.info({ appointmentId: data.appointmentId, billId: bill.id }, 'Frontdesk payment bill created');

  return { billId: bill.id, status: 'pending' };
}
