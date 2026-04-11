import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateDoctorProfileInput,
  UpdateDoctorScheduleInput,
  CreateDoctorLeaveInput,
  BookAppointmentInput,
  UpdateAppointmentStatusInput,
  GetAppointmentsQuery,
  GetDoctorProfilesQuery,
} from './appointments.validation';

// Valid status transitions
const STATUS_TRANSITIONS: Record<string, string[]> = {
  booked: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_consultation', 'cancelled'],
  in_consultation: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Create a doctor profile linked to a user.
 */
export async function createDoctorProfile(tenantId: string, data: CreateDoctorProfileInput) {
  // Verify the user exists and belongs to the tenant
  const user = await prisma.user.findFirst({
    where: { id: data.userId, tenantId },
  });

  if (!user) {
    throw AppError.notFound('User not found in this tenant');
  }

  // Check if doctor profile already exists for this user
  const existingProfile = await prisma.doctorProfile.findFirst({
    where: { userId: data.userId, tenantId },
  });

  if (existingProfile) {
    throw AppError.conflict('Doctor profile already exists for this user');
  }

  const doctor = await prisma.doctorProfile.create({
    data: {
      userId: data.userId,
      tenantId,
      departmentId: data.departmentId,
      specialization: data.specialization,
      qualifications: data.qualification,
      licenseNumber: data.registrationNumber,
      experienceYears: data.experience,
      consultationFee: data.consultationFee,
      bio: data.bio,
    },
    include: {
      user: {
        select: { firstName: true, lastName: true, email: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info({ tenantId, doctorId: doctor.id }, 'Doctor profile created');
  return doctor;
}

/**
 * Update a doctor profile (fee, specialization, etc.).
 */
export async function updateDoctorProfile(
  tenantId: string,
  id: string,
  data: {
    specialization?: string;
    qualifications?: string;
    consultationFee?: number;
    experienceYears?: number;
    bio?: string;
    isAvailable?: boolean;
    departmentId?: string;
  },
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id, tenantId },
  });
  if (!doctor) throw AppError.notFound('Doctor profile not found');

  const updated = await prisma.doctorProfile.update({
    where: { id },
    data,
    include: {
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, doctorId: id }, 'Doctor profile updated');
  return updated;
}

/**
 * Get paginated list of doctor profiles.
 * Auto-creates DoctorProfile for users with the "doctor" role who lack one.
 */
export async function getDoctorProfiles(tenantId: string, query: GetDoctorProfilesQuery) {
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
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.departmentId) {
    where.departmentId = query.departmentId;
  }

  if (query.specialization) {
    where.specialization = { contains: query.specialization, mode: 'insensitive' };
  }

  if (query.isActive !== undefined) {
    where.isAvailable = query.isActive;
  }

  if (query.search) {
    where.OR = [
      { specialization: { contains: query.search, mode: 'insensitive' } },
      { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [doctors, total] = await Promise.all([
    prisma.doctorProfile.findMany({
      where,
      skip,
      take,
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true, phone: true },
        },
        department: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.doctorProfile.count({ where }),
  ]);

  return { doctors, total, page, limit };
}

/**
 * Get a single doctor profile with schedules.
 */
export async function getDoctorProfile(tenantId: string, id: string) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id, tenantId },
    include: {
      user: {
        select: { firstName: true, lastName: true, email: true, phone: true },
      },
      department: {
        select: { id: true, name: true },
      },
      schedules: {
        orderBy: { dayOfWeek: 'asc' },
      },
    },
  });

  if (!doctor) {
    throw AppError.notFound('Doctor profile not found');
  }

  return doctor;
}

/**
 * Create or update schedule slots for a doctor.
 */
export async function updateDoctorSchedule(doctorId: string, data: UpdateDoctorScheduleInput) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  // Validate that startTime < endTime for each schedule
  for (const schedule of data.schedules) {
    if (schedule.startTime >= schedule.endTime) {
      throw AppError.badRequest(
        `Start time must be before end time for day ${schedule.dayOfWeek}`,
      );
    }
  }

  // Delete existing schedules and recreate them
  await prisma.$transaction(async (tx) => {
    await tx.doctorSchedule.deleteMany({
      where: { doctorId },
    });

    await tx.doctorSchedule.createMany({
      data: data.schedules.map((schedule) => ({
        doctorId,
        dayOfWeek: schedule.dayOfWeek,
        startTime: new Date(`1970-01-01T${schedule.startTime}:00.000Z`),
        endTime: new Date(`1970-01-01T${schedule.endTime}:00.000Z`),
        slotDurationMinutes: schedule.slotDurationMinutes ?? 15,
        maxPatients: schedule.maxPatients,
        isActive: schedule.isActive ?? true,
      })),
    });
  });

  const updatedSchedules = await prisma.doctorSchedule.findMany({
    where: { doctorId },
    orderBy: { dayOfWeek: 'asc' },
  });

  logger.info({ doctorId }, 'Doctor schedule updated');
  return updatedSchedules;
}

/**
 * Create a leave entry for a doctor.
 * DoctorLeave only has leaveDate (single date), startTime, endTime, reason.
 */
export async function createDoctorLeave(doctorId: string, data: CreateDoctorLeaveInput) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const leaveDate = new Date(data.startDate);

  if (leaveDate < new Date()) {
    throw AppError.badRequest('Leave date cannot be in the past');
  }

  // Check for overlapping leaves on the same date
  const overlapping = await prisma.doctorLeave.findFirst({
    where: {
      doctorId,
      leaveDate,
    },
  });

  if (overlapping) {
    throw AppError.conflict('A leave already exists for this date');
  }

  const leave = await prisma.doctorLeave.create({
    data: {
      doctorId,
      leaveDate,
      reason: data.reason,
    },
  });

  logger.info({ doctorId, leaveId: leave.id }, 'Doctor leave created');
  return leave;
}

/**
 * Calculate available time slots for a doctor on a given date.
 */
export async function getAvailableSlots(tenantId: string, doctorId: string, date: string) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
  });

  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const targetDate = new Date(date);
  const dayOfWeek = targetDate.getDay(); // 0=Sunday, 6=Saturday

  // Get the doctor's schedule for this day of the week
  const schedule = await prisma.doctorSchedule.findFirst({
    where: {
      doctorId,
      dayOfWeek,
      isActive: true,
    },
  });

  if (!schedule) {
    return { date, slots: [], message: 'Doctor does not have a schedule for this day' };
  }

  // Check for leaves on this date
  const leave = await prisma.doctorLeave.findFirst({
    where: {
      doctorId,
      leaveDate: targetDate,
    },
  });

  if (leave) {
    // If no specific time range, it's a full day leave
    if (!leave.startTime && !leave.endTime) {
      return { date, slots: [], message: 'Doctor is on leave on this date' };
    }
  }

  // Generate all possible slots from schedule
  const slots: Array<{ startTime: string; endTime: string; available: boolean }> = [];
  // schedule.startTime is a Date object (db.Time) - extract HH:MM from it
  const schedStartTime = schedule.startTime as Date;
  const schedEndTime = schedule.endTime as Date;
  const startHour = schedStartTime.getUTCHours();
  const startMin = schedStartTime.getUTCMinutes();
  const endHour = schedEndTime.getUTCHours();
  const endMin = schedEndTime.getUTCMinutes();

  const scheduleStartMinutes = startHour * 60 + startMin;
  const scheduleEndMinutes = endHour * 60 + endMin;
  const slotDuration = schedule.slotDurationMinutes;

  let effectiveStart = scheduleStartMinutes;
  let effectiveEnd = scheduleEndMinutes;

  // Get existing appointments for this doctor on this date
  const dayStart = new Date(targetDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const existingAppointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show', 'pending_payment'] },
    },
    select: { startTime: true, endTime: true },
  });

  const bookedSlots = existingAppointments.map((apt) => ({
    start: apt.startTime as Date,
    end: apt.endTime as Date | null,
  }));

  // Generate time slots
  let currentMinutes = effectiveStart;
  while (currentMinutes + slotDuration <= effectiveEnd) {
    const slotStartHour = Math.floor(currentMinutes / 60);
    const slotStartMin = currentMinutes % 60;
    const slotEndMinutes = currentMinutes + slotDuration;
    const slotEndHour = Math.floor(slotEndMinutes / 60);
    const slotEndMin = slotEndMinutes % 60;

    const slotStart = `${slotStartHour.toString().padStart(2, '0')}:${slotStartMin.toString().padStart(2, '0')}`;
    const slotEnd = `${slotEndHour.toString().padStart(2, '0')}:${slotEndMin.toString().padStart(2, '0')}`;

    // Check if this slot is already booked
    const isBooked = bookedSlots.some((booked) => {
      const bookedStartH = (booked.start as Date).getUTCHours();
      const bookedStartM = (booked.start as Date).getUTCMinutes();
      const bookedStart = `${bookedStartH.toString().padStart(2, '0')}:${bookedStartM.toString().padStart(2, '0')}`;
      const bookedEndH = booked.end ? (booked.end as Date).getUTCHours() : bookedStartH + 1;
      const bookedEndM = booked.end ? (booked.end as Date).getUTCMinutes() : bookedStartM;
      const bookedEnd = `${bookedEndH.toString().padStart(2, '0')}:${bookedEndM.toString().padStart(2, '0')}`;
      return bookedStart === slotStart || (bookedStart < slotEnd && bookedEnd > slotStart);
    });

    slots.push({
      startTime: slotStart,
      endTime: slotEnd,
      available: !isBooked,
    });

    currentMinutes += slotDuration;
  }

  return { date, doctorId, slots };
}

/**
 * Book an appointment.
 */
export async function bookAppointment(tenantId: string, data: BookAppointmentInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify doctor exists
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId, isAvailable: true },
  });
  if (!doctor) {
    throw AppError.notFound('Doctor not found or inactive');
  }

  const appointmentDate = new Date(data.appointmentDate);
  appointmentDate.setUTCHours(0, 0, 0, 0);

  // Prevent booking in the past
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (appointmentDate < today) {
    throw AppError.badRequest('Cannot book an appointment in the past');
  }

  // Check for doctor leave on this date
  const leave = await prisma.doctorLeave.findFirst({
    where: {
      doctorId: data.doctorId,
      leaveDate: appointmentDate,
    },
  });

  if (leave && !leave.startTime && !leave.endTime) {
    throw AppError.badRequest('Doctor is on leave on the selected date');
  }

  // Convert HH:MM strings to Date objects for @db.Time() fields
  const startTimeDate = new Date(`1970-01-01T${data.startTime}:00.000Z`);
  const endTimeDate = new Date(`1970-01-01T${data.endTime}:00.000Z`);

  // Check for slot conflicts
  const dayStart = new Date(appointmentDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(appointmentDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const conflicting = await prisma.appointment.findFirst({
    where: {
      doctorId: data.doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show', 'pending_payment'] },
      OR: [
        { startTime: { lt: endTimeDate }, endTime: { gt: startTimeDate } },
      ],
    },
  });

  if (conflicting) {
    throw AppError.conflict('This time slot is already booked');
  }

  // ── Auto-detect visitType based on patient history ──
  let visitType: 'new' | 'revisit' = 'new';
  const lastCompletedAppt = await prisma.appointment.findFirst({
    where: {
      patientId: data.patientId,
      tenantId,
      status: 'completed',
    },
    orderBy: { appointmentDate: 'desc' },
    select: { appointmentDate: true },
  });

  if (lastCompletedAppt) {
    const daysSinceLast = Math.floor(
      (Date.now() - new Date(lastCompletedAppt.appointmentDate).getTime()) / (1000 * 60 * 60 * 24),
    );
    // Within 30 days → review/revisit; otherwise → new cycle (old returning)
    visitType = daysSinceLast <= 30 ? 'revisit' : 'new';
  }

  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      appointmentDate,
      startTime: startTimeDate,
      endTime: endTimeDate,
      appointmentType: 'scheduled',
      consultationType: data.type || 'consultation',
      priority: data.priority || 'normal',
      visitType,
      reason: data.reason,
      notes: data.notes,
      status: 'booked',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  logger.info(
    { tenantId, appointmentId: appointment.id, doctorId: data.doctorId, patientId: data.patientId },
    'Appointment booked',
  );
  return appointment;
}

/**
 * Get appointment statistics for a given date (or today).
 */
export async function getAppointmentStats(tenantId: string, date?: string) {
  const targetDate = date ? new Date(date) : new Date();
  const dayStart = new Date(targetDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const where: any = {
    tenantId,
    appointmentDate: { gte: dayStart, lte: dayEnd },
  };

  const appointments = await prisma.appointment.findMany({
    where,
    select: { status: true },
  });

  return {
    all: appointments.length,
    booked: appointments.filter((a) => a.status === 'booked' || a.status === 'confirmed').length,
    ipAppointments: 0,
    arrived: appointments.filter((a) => a.status === 'checked_in').length,
    withDoctor: appointments.filter((a) => a.status === 'in_consultation').length,
    completed: appointments.filter((a) => a.status === 'completed').length,
    cancelled: appointments.filter((a) => a.status === 'cancelled').length,
  };
}

/**
 * Get paginated list of appointments with filters.
 */
export async function getAppointments(tenantId: string, query: GetAppointmentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.date) {
    const targetDate = new Date(query.date);
    const dayStart = new Date(targetDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCHours(23, 59, 59, 999);
    where.appointmentDate = { gte: dayStart, lte: dayEnd };
  } else {
    if (query.fromDate) {
      where.appointmentDate = { ...where.appointmentDate, gte: new Date(query.fromDate) };
    }
    if (query.toDate) {
      where.appointmentDate = { ...where.appointmentDate, lte: new Date(query.toDate) };
    }
  }

  if (query.doctorId) where.doctorId = query.doctorId;
  if ((query as any).doctorUserId) {
    // Resolve DoctorProfile from User ID so the frontend can pass the logged-in user ID
    const dp = await prisma.doctorProfile.findFirst({
      where: { userId: (query as any).doctorUserId, tenantId },
      select: { id: true },
    });
    if (dp) {
      where.doctorId = dp.id;
    } else {
      return { appointments: [], total: 0, page, limit };
    }
  }
  if (query.patientId) where.patientId = query.patientId;
  if (query.status) where.status = query.status;

  if ((query as any).search) {
    const s = (query as any).search;
    where.patient = {
      OR: [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { mrn: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
      ],
    };
  }

  const [rawAppointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, gender: true, dateOfBirth: true, isNew: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
        queueTokens: true,
      },
      orderBy: [{ appointmentDate: 'asc' }, { startTime: 'asc' }],
    }),
    prisma.appointment.count({ where }),
  ]);

  // Enrich with payment info via BillItem.referenceType='appointment'
  const appointmentIds = rawAppointments.map((a) => a.id);
  const billItems = appointmentIds.length > 0
    ? await prisma.billItem.findMany({
        where: { referenceType: 'appointment', referenceId: { in: appointmentIds } },
        select: {
          referenceId: true,
          bill: {
            select: {
              id: true,
              status: true,
              totalAmount: true,
              amountPaid: true,
              balanceDue: true,
              billNumber: true,
              payments: {
                take: 1,
                orderBy: { createdAt: 'desc' },
                select: { status: true, paymentMethod: true },
              },
            },
          },
        },
      })
    : [];

  const billMap = new Map<string, typeof billItems[number]['bill']>();
  for (const bi of billItems) {
    if (bi.referenceId && !billMap.has(bi.referenceId)) {
      billMap.set(bi.referenceId, bi.bill);
    }
  }

  const appointments = rawAppointments.map((a) => {
    const bill = billMap.get(a.id);
    const latestPayment = bill?.payments?.[0];
    let paymentStatus: 'paid_online' | 'pay_at_frontdesk' | 'pending' | 'no_billing' = 'no_billing';

    if (bill) {
      if (bill.status === 'paid') {
        paymentStatus = latestPayment?.paymentMethod === 'cash' ? 'paid_online' : 'paid_online';
      } else if (latestPayment?.status === 'completed') {
        paymentStatus = 'paid_online';
      } else if (latestPayment?.status === 'pending') {
        paymentStatus = 'pending'; // online payment initiated but not completed
      } else {
        paymentStatus = 'pay_at_frontdesk';
      }
    }

    return {
      ...a,
      paymentInfo: bill
        ? {
            billId: bill.id,
            billNumber: bill.billNumber,
            billStatus: bill.status,
            totalAmount: Number(bill.totalAmount),
            amountPaid: Number(bill.amountPaid),
            balanceDue: Number(bill.balanceDue),
            paymentStatus,
          }
        : null,
    };
  });

  return { appointments, total, page, limit };
}

/**
 * Get single appointment by ID.
 */
export async function getAppointmentById(tenantId: string, id: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          dateOfBirth: true,
          gender: true,
          bloodGroup: true,
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      queueTokens: true,
      formSubmissions: {
        orderBy: { submittedAt: 'desc' },
        include: {
          instance: { select: { id: true, name: true, category: true } },
          submitter: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!appointment) {
    throw AppError.notFound('Appointment not found');
  }

  return appointment;
}

/**
 * Update appointment status with transition validation.
 */
export async function updateAppointmentStatus(
  tenantId: string,
  id: string,
  data: UpdateAppointmentStatusInput,
  userId: string,
) {
  const appointment = await prisma.appointment.findFirst({
    where: { id, tenantId },
  });

  if (!appointment) {
    throw AppError.notFound('Appointment not found');
  }

  const currentStatus = appointment.status;
  const newStatus = data.status;

  // Validate status transition
  const allowedTransitions = STATUS_TRANSITIONS[currentStatus];
  if (!allowedTransitions || !allowedTransitions.includes(newStatus)) {
    throw AppError.badRequest(
      `Cannot transition from '${currentStatus}' to '${newStatus}'. Allowed transitions: ${allowedTransitions?.join(', ') || 'none'}`,
    );
  }

  const updateData: any = {
    status: newStatus,
  };

  if (data.notes) {
    updateData.notes = data.notes;
  }

  if (newStatus === 'cancelled') {
    if (data.cancellationReason) {
      updateData.cancellationReason = data.cancellationReason;
    }
    updateData.cancelledBy = userId;
  }

  // When completed, mark patient as no longer new
  if (newStatus === 'completed' && appointment.patientId) {
    await prisma.patient.updateMany({
      where: { id: appointment.patientId, tenantId, isNew: true },
      data: { isNew: false },
    });
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: updateData,
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info(
    { tenantId, appointmentId: id, from: currentStatus, to: newStatus },
    'Appointment status updated',
  );
  return updated;
}

/**
 * Cancel an appointment.
 */
export async function cancelAppointment(
  tenantId: string,
  id: string,
  userId: string,
  reason?: string,
) {
  return updateAppointmentStatus(
    tenantId,
    id,
    {
      status: 'cancelled',
      cancellationReason: reason || 'Cancelled by user',
    },
    userId,
  );
}

/**
 * Generate a queue token for an appointment (auto-incrementing daily number).
 */
export async function generateQueueToken(tenantId: string, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    include: { doctor: true },
  });

  if (!appointment) {
    throw AppError.notFound('Appointment not found');
  }

  // Check if token already exists
  const existingToken = await prisma.queueToken.findFirst({
    where: { appointmentId },
  });

  if (existingToken) {
    throw AppError.conflict('Queue token already generated for this appointment');
  }

  // Get the last token number for the doctor on this date
  const dayStart = new Date(appointment.appointmentDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(appointment.appointmentDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const lastToken = await prisma.queueToken.findFirst({
    where: {
      tenantId,
      doctorId: appointment.doctorId,
      createdAt: { gte: dayStart, lte: dayEnd },
    },
    orderBy: { tokenNumber: 'desc' },
  });

  // tokenNumber is a string field in schema (VarChar(20))
  const lastTokenNum = lastToken ? parseInt(lastToken.tokenNumber, 10) : 0;
  const tokenNumber = (lastTokenNum + 1).toString().padStart(3, '0');

  const token = await prisma.queueToken.create({
    data: {
      tenantId,
      appointmentId,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      tokenNumber,
      queueDate: appointment.appointmentDate,
      status: 'waiting',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info(
    { tenantId, appointmentId, tokenNumber },
    'Queue token generated',
  );
  return token;
}

/**
 * Get queue for a doctor on a specific date.
 */
export async function getQueueByDoctor(tenantId: string, doctorId: string, date?: string) {
  const targetDate = date ? new Date(date) : new Date();
  const dayStart = new Date(targetDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const queue = await prisma.queueToken.findMany({
    where: {
      tenantId,
      doctorId,
      createdAt: { gte: dayStart, lte: dayEnd },
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
      },
      appointment: {
        select: {
          id: true,
          startTime: true,
          endTime: true,
          appointmentType: true,
          status: true,
        },
      },
    },
    orderBy: { tokenNumber: 'asc' },
  });

  return queue;
}

/**
 * Get today's appointments for a doctor.
 */
export async function getTodayAppointments(tenantId: string, doctorId: string) {
  const today = new Date();
  const dayStart = new Date(today);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(today);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const appointments = await prisma.appointment.findMany({
    where: {
      tenantId,
      doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show'] },
    },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      queueTokens: true,
    },
    orderBy: { startTime: 'asc' },
  });

  return appointments;
}
