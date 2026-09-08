import { prisma } from '../../config/database';
import { taxResolverFor, billItemTaxFields } from '../gst/gst-resolver.service';

/** Medical and dental services — what an OPD consultation is, and exempt. */
const CONSULTATION_SAC = '999312';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import {
  REGISTRATION_FEE_REFERENCE_TYPE,
  registrationFeeTotals,
  shouldChargeRegistrationFee,
} from '../../shared/registration-fee';
import {
  getRegistrationFeeSettings,
  getPatientVisitStatus,
} from '../hospital-settings/hospital-settings.service';

/** Money to paise — bills must not carry floating-point dust. */
const round2 = (n: number) => Math.round(n * 100) / 100;
import type {
  CreateDoctorProfileInput,
  UpdateDoctorScheduleInput,
  CreateDoctorLeaveInput,
  GetDoctorLeavesQuery,
  ListAllDoctorLeavesQuery,
  UpsertScheduleOverrideInput,
  BulkOverrideInput,
  BookAppointmentInput,
  UpdateAppointmentStatusInput,
  GetAppointmentsQuery,
  GetDoctorProfilesQuery,
  RescheduleAppointmentInput,
  FrontdeskCheckoutInput,
} from './appointments.validation';
import { createPayment, recalculateBillTotalsPublic } from '../billing/billing.service';
import { createBillInSeriesWithRetry } from '../../shared/bill-number';

// Valid status transitions
const STATUS_TRANSITIONS: Record<string, string[]> = {
  // Patient-app bookings land here until the fee is settled. Front desk can
  // take the money (→ booked/confirmed) or drop the request (→ cancelled).
  pending_payment: ['booked', 'confirmed', 'cancelled', 'no_show'],
  booked: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_consultation', 'cancelled'],
  in_consultation: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Edit window for a completed OP consultation. Beyond this, the record is locked.
 * IP records remain editable until the admission is discharged.
 */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Compute whether the consultation form (vitals + diagnoses + meds + narrative)
 * is still editable for a given appointment, and return a fully-assembled
 * prefill payload for the consultation form so the UI can hydrate it.
 *
 * The appointment's status is NOT changed. Edits are applied in-place by
 * individual update endpoints, each of which re-checks this window server-side.
 */
export async function getConsultationFormData(tenantId: string, id: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id, tenantId },
    include: {
      visits: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        include: {
          vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
          diagnoses: { orderBy: { diagnosedAt: 'asc' } },
          prescriptions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { prescriptionItems: true },
          },
          progressNotes: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { pins: true },
          },
        },
      },
    },
  });

  if (!appointment) throw AppError.notFound('Appointment not found');

  const visit = appointment.visits[0];
  let canEdit = false;
  let reason: string | null = null;

  if (appointment.status === 'in_consultation') {
    canEdit = true;
  } else if (appointment.status === 'completed' && visit) {
    if (visit.visitType === 'ip') {
      const admission = await prisma.admission.findFirst({
        where: { visitId: visit.id, tenantId },
        select: { status: true },
      });
      if (admission?.status === 'discharged') {
        reason = 'Patient has been discharged';
      } else {
        canEdit = true;
      }
    } else {
      const age = Date.now() - new Date(visit.updatedAt).getTime();
      if (age <= EDIT_WINDOW_MS) canEdit = true;
      else reason = 'Edit window has closed (24 hours after completion)';
    }
  } else {
    reason = `Appointment status '${appointment.status}' is not editable`;
  }

  // Assemble prefill data shaped like the frontend ConsultationFormData.
  //
  // Source-of-truth priority for each field is:
  //   1. Dedicated table (visit / vital / diagnosis / prescription item) — most authoritative
  //   2. Progress note's structured SOAP JSON (subjective/objective/assessment/plan)
  //   3. Progress note's content markdown (parsed best-effort as a last resort)
  //
  // The third path catches notes saved when the Prisma client was out of
  // sync (the SOAP JSON columns may be null) or imported from an older
  // version of this module. Without it, editors see empty fields even
  // though the doctor typed the values.
  const note = visit?.progressNotes[0] as any;
  const objective = note?.objective ?? {};
  const plan = note?.plan ?? {};
  const subjective = note?.subjective ?? {};
  const parsedContent = parseProgressNoteContent(note?.content);

  // Prefer structured JSON; fall back to parsed content; fall back to empty.
  const pick = <T>(...values: Array<T | null | undefined>): T | '' => {
    for (const v of values) {
      if (v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== '')) {
        return v;
      }
    }
    return '' as any;
  };

  const prefill = visit
    ? {
        visitId: visit.id,
        chiefComplaint: pick<string>(
          subjective.chiefComplaints,
          visit.chiefComplaint,
          parsedContent.chiefComplaint,
        ),
        vitals: visit.vitals[0]
          ? {
              temperature: toNum(visit.vitals[0].temperature),
              bloodPressureSystolic: visit.vitals[0].bloodPressureSystolic ?? undefined,
              bloodPressureDiastolic: visit.vitals[0].bloodPressureDiastolic ?? undefined,
              pulseRate: visit.vitals[0].pulseRate ?? undefined,
              respiratoryRate: visit.vitals[0].respiratoryRate ?? undefined,
              oxygenSaturation: toNum(visit.vitals[0].oxygenSaturation),
              weightKg: toNum(visit.vitals[0].weightKg),
              heightCm: toNum(visit.vitals[0].heightCm),
              bloodSugar: toNum(visit.vitals[0].bloodSugar),
            }
          : {},
        diagnoses: visit.diagnoses.map((d) => ({
          icdCode: d.icdCode || '',
          diagnosisName: d.diagnosisName,
          diagnosisType: d.diagnosisType,
        })),
        medicines: (visit.prescriptions[0]?.prescriptionItems ?? []).map((it) => {
          // The save flow encodes frequency + timing as "1-0-1 - After Meal"
          // and duration as "5 days". Decompose them here so the form fields
          // (frequency select / timing select / durationValue / durationUnit)
          // round-trip correctly. Also mirror `dosage` into the newer `dose`
          // field the UI binds to.
          const { frequency, timing, isPrn } = splitFrequency(it.frequency);
          const { durationValue, durationUnit } = splitDuration(it.duration);
          return {
            drugId: it.drugId || undefined,
            drugName: it.drugName,
            // New UI field + legacy alias
            dose: it.dosage || '',
            dosage: it.dosage || '',
            frequency,
            timing,
            durationValue,
            durationUnit,
            // Legacy `duration` kept for any consumer still reading it.
            duration: it.duration || '',
            route: it.route || 'oral',
            instructions: it.instructions || '',
            // Per-intake dose multiplier — round-trips so the edit form shows
            // what the doctor originally entered (default 1 for older rows).
            doseQuantity: it.doseQuantity != null ? Number(it.doseQuantity) : 1,
            isPrn: isPrn || it.isPrn,
            quantity: it.quantity ?? undefined,
          };
        }),
        prescriptionId: visit.prescriptions[0]?.id,
        progressNoteId: note?.id,

        // Rehydrated SOAP extras — JSON > parsed content > empty
        generalExamination: pick<string>(
          objective.generalExamination,
          parsedContent.generalExamination,
        ),
        systemicExamination: pick<string>(
          objective.systemicExamination,
          parsedContent.systemicExamination,
        ),
        physicalObservations: Array.isArray(objective.physicalObservations)
          ? objective.physicalObservations
          : parsedContent.physicalObservations,
        impression: pick<string>(note?.impressions, parsedContent.impression),
        advice: pick<string>(plan.advice, parsedContent.advice),
        followUpNotes: pick<string>(plan.followUpNotes, parsedContent.followUpNotes),
        referralNotes: pick<string>(plan.referralNotes, parsedContent.referralNotes),
        pins: (note?.pins ?? []).map((p: any) => ({
          dischargeSection: p.dischargeSection,
          content: p.content,
        })),

        // Legacy / backward-compat
        impressions: note?.impressions ?? '',
        discussions: note?.discussions ?? '',
        conclusions: note?.conclusions ?? '',
        customFields: note?.customFields ?? [],
        pinToDischargeSummary: note?.pinToDischargeSummary ?? false,
        followUpDate: visit.prescriptions[0]?.followUpDate
          ? new Date(visit.prescriptions[0].followUpDate).toISOString().split('T')[0]
          : plan.followUpDate ?? '',
      }
    : null;

  return { canEdit, reason, prefill, appointmentStatus: appointment.status };
}

// Inverse of frontend encodeFrequency() — given a stored string like
// "1-0-1 - After Meal", "As Needed (SOS)", or "Stat", recover the
// frequency code, timing label, and isPrn flag that drive the edit form.
function splitFrequency(raw: string | null | undefined): {
  frequency: string;
  timing: string;
  isPrn: boolean;
} {
  if (!raw || typeof raw !== 'string') {
    return { frequency: '', timing: '', isPrn: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { frequency: '', timing: '', isPrn: false };
  if (/^as needed/i.test(trimmed) || /\bsos\b/i.test(trimmed)) {
    return { frequency: 'SOS', timing: '', isPrn: true };
  }
  if (/^stat$/i.test(trimmed)) {
    return { frequency: 'Stat', timing: '', isPrn: false };
  }
  const parts = trimmed.split(/\s*-\s*/);
  // "1-0-1" splits to ["1","0","1"] — that's the code itself, no timing.
  if (parts.length === 3 && parts.every((p) => /^\d/.test(p))) {
    return { frequency: parts.join('-'), timing: '', isPrn: false };
  }
  // "1-0-1 - After Meal" splits to ["1","0","1","After Meal"] under \s*-\s*
  if (parts.length >= 4 && parts.slice(0, 3).every((p) => /^\d/.test(p))) {
    return {
      frequency: parts.slice(0, 3).join('-'),
      timing: parts.slice(3).join(' - '),
      isPrn: false,
    };
  }
  // Fallback: split on " - " literal — handles non-numeric timing labels.
  const dashIdx = trimmed.indexOf(' - ');
  if (dashIdx !== -1) {
    return {
      frequency: trimmed.slice(0, dashIdx).trim(),
      timing: trimmed.slice(dashIdx + 3).trim(),
      isPrn: false,
    };
  }
  return { frequency: trimmed, timing: '', isPrn: false };
}

// Inverse of frontend encodeDuration() — given "5 days" / "2 weeks" /
// "1 months", recover the separate value + unit the UI binds to.
function splitDuration(raw: string | null | undefined): {
  durationValue: string;
  durationUnit: 'days' | 'weeks' | 'months';
} {
  if (!raw || typeof raw !== 'string') {
    return { durationValue: '', durationUnit: 'days' };
  }
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)$/i);
  if (!m) return { durationValue: '', durationUnit: 'days' };
  const unit = m[2].toLowerCase();
  const normalised: 'days' | 'weeks' | 'months' = unit.startsWith('week')
    ? 'weeks'
    : unit.startsWith('month')
      ? 'months'
      : 'days';
  return { durationValue: m[1], durationUnit: normalised };
}

// Parse fields back out of the markdown `content` column that
// use-consultation-completion.ts's buildProgressNoteContent writes on save.
// Used as a fallback when the structured SOAP JSON is missing. The regex
// matches section headers of the form "**Heading:**" until the next
// heading or end-of-string.
function parseProgressNoteContent(content: string | null | undefined): {
  chiefComplaint: string;
  generalExamination: string;
  systemicExamination: string;
  physicalObservations: Array<{ source: 'free_text'; value: string }>;
  advice: string;
  followUpNotes: string;
  referralNotes: string;
  impression: string;
} {
  const empty = {
    chiefComplaint: '',
    generalExamination: '',
    systemicExamination: '',
    physicalObservations: [] as Array<{ source: 'free_text'; value: string }>,
    advice: '',
    followUpNotes: '',
    referralNotes: '',
    impression: '',
  };
  if (!content || typeof content !== 'string') return empty;

  const extract = (heading: string): string => {
    // Captures everything from "**Heading:**\n" up to the next "**...:**" or EOS.
    const escaped = heading.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(
      `\\*\\*${escaped}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[^\\n]+:\\*\\*|$)`,
      'i',
    );
    const m = content.match(re);
    return (m?.[1] ?? '').trim();
  };

  const physRaw = extract('Physical Observations');
  const physicalObservations = physRaw
    ? physRaw
        .split(/\n/)
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter((line) => line.length > 0)
        .map((value) => ({ source: 'free_text' as const, value }))
    : [];

  const followUp = extract('Follow-up');
  // Follow-up is typically formatted as "After N days — YYYY/MM/DD — notes"
  // — pull just the trailing notes segment when present.
  const followUpNotes = followUp.includes(' — ')
    ? followUp.split(' — ').slice(-1)[0] || ''
    : followUp;

  return {
    chiefComplaint: extract('Chief Complaint') || extract('Chief Complaints'),
    generalExamination: extract('General Examination'),
    systemicExamination: extract('Systemic Examination'),
    physicalObservations,
    advice: extract('Advice'),
    followUpNotes,
    referralNotes: extract('Referral'),
    impression: extract('Impression'),
  };
}

function toNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

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
    /** Days after a paid consultation in which a return visit is free. */
    freeFollowUpDays?: number | null;
  },
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id, tenantId },
  });
  if (!doctor) throw AppError.notFound('Doctor profile not found');

  // Pick the editable fields explicitly. The route has no validation
  // middleware and the controller hands `req.body` straight through, so
  // spreading it into `update` let a caller set anything on the row —
  // tenantId and userId included. Only these belong to the profile form.
  const patch: Record<string, unknown> = {};
  if (data.specialization !== undefined) patch.specialization = data.specialization;
  if (data.qualifications !== undefined) patch.qualifications = data.qualifications;
  if (data.consultationFee !== undefined) patch.consultationFee = data.consultationFee;
  if (data.experienceYears !== undefined) patch.experienceYears = data.experienceYears;
  if (data.bio !== undefined) patch.bio = data.bio;
  if (data.isAvailable !== undefined) patch.isAvailable = data.isAvailable;
  if (data.departmentId !== undefined) patch.departmentId = data.departmentId;
  if (data.freeFollowUpDays !== undefined) {
    // Clamped: a negative window is meaningless and a huge one would silently
    // make every consultation free. 0/null both mean "no free follow-up".
    const n = Number(data.freeFollowUpDays);
    patch.freeFollowUpDays =
      Number.isFinite(n) && n > 0 ? Math.min(365, Math.trunc(n)) : null;
  }

  const updated = await prisma.doctorProfile.update({
    where: { id },
    data: patch,
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
 * Doctor applies for a leave. Supports multi-day ranges and half-day variants.
 * Starts in `pending` state — HR/admin must approve before it blocks booking.
 */
export async function createDoctorLeave(doctorId: string, data: CreateDoctorLeaveInput) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const startDate = new Date(data.startDate);
  const endDate = new Date(data.endDate);

  if (endDate < startDate) {
    throw AppError.badRequest('End date cannot be before start date');
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (startDate < today) {
    throw AppError.badRequest('Leave start date cannot be in the past');
  }

  // Reject when an overlapping non-rejected leave already exists
  const overlapping = await prisma.doctorLeave.findFirst({
    where: {
      doctorId,
      status: { in: ['pending', 'approved'] },
      AND: [
        { leaveDate: { lte: endDate } },
        {
          OR: [
            { endDate: null, leaveDate: { gte: startDate } },
            { endDate: { gte: startDate } },
          ],
        },
      ],
    },
  });

  if (overlapping) {
    throw AppError.conflict('An overlapping leave already exists for this range');
  }

  // Partial-day handling. Time range blocks matching slots on every date in the range.
  //   full_day               → null/null  (blocks whole day)
  //   half_day_morning       → 00:00-13:00
  //   half_day_afternoon     → 13:00-23:59
  //   custom_hours           → startTime-endTime (validated HH:MM)
  let startTime: Date | null = null;
  let endTime: Date | null = null;
  if (data.dayType === 'half_day_morning') {
    startTime = new Date('1970-01-01T00:00:00.000Z');
    endTime = new Date('1970-01-01T13:00:00.000Z');
  } else if (data.dayType === 'half_day_afternoon') {
    startTime = new Date('1970-01-01T13:00:00.000Z');
    endTime = new Date('1970-01-01T23:59:00.000Z');
  } else if (data.dayType === 'custom_hours' && data.startTime && data.endTime) {
    startTime = new Date(`1970-01-01T${data.startTime}:00.000Z`);
    endTime = new Date(`1970-01-01T${data.endTime}:00.000Z`);
  }

  const leave = await prisma.doctorLeave.create({
    data: {
      doctorId,
      leaveDate: startDate,
      endDate: endDate.getTime() === startDate.getTime() ? null : endDate,
      startTime,
      endTime,
      leaveType: data.leaveType,
      status: 'pending',
      reason: data.reason,
    },
  });

  logger.info({ doctorId, leaveId: leave.id }, 'Doctor leave requested');
  return leave;
}

/**
 * List a specific doctor's leaves (used by the doctor's own calendar).
 */
export async function getDoctorLeaves(doctorId: string, query: GetDoctorLeavesQuery) {
  const where: any = { doctorId };

  if (query.status) where.status = query.status;
  if (query.fromDate || query.toDate) {
    where.leaveDate = {};
    if (query.fromDate) where.leaveDate.gte = new Date(query.fromDate);
    if (query.toDate) where.leaveDate.lte = new Date(query.toDate);
  }

  return prisma.doctorLeave.findMany({
    where,
    orderBy: { leaveDate: 'desc' },
    include: {
      approver: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

/**
 * List all doctor leaves across the tenant (HR/admin approval queue).
 */
export async function listAllDoctorLeaves(tenantId: string, query: ListAllDoctorLeavesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    doctor: { tenantId },
  };
  if (query.status) where.status = query.status;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.fromDate || query.toDate) {
    where.leaveDate = {};
    if (query.fromDate) where.leaveDate.gte = new Date(query.fromDate);
    if (query.toDate) where.leaveDate.lte = new Date(query.toDate);
  }

  const [leaves, total] = await Promise.all([
    prisma.doctorLeave.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.doctorLeave.count({ where }),
  ]);

  return { leaves, total, page, limit };
}

/**
 * HR/admin approves a doctor leave request.
 */
export async function approveDoctorLeave(tenantId: string, leaveId: string, approverUserId: string) {
  const leave = await prisma.doctorLeave.findFirst({
    where: { id: leaveId, doctor: { tenantId } },
  });
  if (!leave) throw AppError.notFound('Leave request not found');
  if (leave.status !== 'pending') {
    throw AppError.badRequest(`Leave is already ${leave.status}`);
  }

  return prisma.doctorLeave.update({
    where: { id: leaveId },
    data: {
      status: 'approved',
      approvedBy: approverUserId,
      approvedAt: new Date(),
    },
  });
}

/**
 * HR/admin rejects a doctor leave request.
 */
export async function rejectDoctorLeave(
  tenantId: string,
  leaveId: string,
  approverUserId: string,
  reason?: string,
) {
  const leave = await prisma.doctorLeave.findFirst({
    where: { id: leaveId, doctor: { tenantId } },
  });
  if (!leave) throw AppError.notFound('Leave request not found');
  if (leave.status !== 'pending') {
    throw AppError.badRequest(`Leave is already ${leave.status}`);
  }

  return prisma.doctorLeave.update({
    where: { id: leaveId },
    data: {
      status: 'rejected',
      approvedBy: approverUserId,
      approvedAt: new Date(),
      reason: reason ? `${leave.reason ?? ''}\n[Rejected: ${reason}]`.trim() : leave.reason,
    },
  });
}

/**
 * Doctor cancels their own pending leave request.
 */
export async function cancelDoctorLeave(tenantId: string, leaveId: string) {
  const leave = await prisma.doctorLeave.findFirst({
    where: { id: leaveId, doctor: { tenantId } },
  });
  if (!leave) throw AppError.notFound('Leave request not found');
  if (leave.status === 'cancelled' || leave.status === 'rejected') {
    throw AppError.badRequest(`Leave is already ${leave.status}`);
  }

  return prisma.doctorLeave.update({
    where: { id: leaveId },
    data: { status: 'cancelled' },
  });
}

// ── Schedule Overrides (date-specific) ──────────────────────────────────────

function toDbTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

function normalizeDate(d: string | Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

/**
 * List a doctor's date-specific schedule overrides in a window.
 */
export async function listScheduleOverrides(
  tenantId: string,
  doctorId: string,
  query: { fromDate?: string; toDate?: string },
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
    select: { id: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  const where: any = { doctorId };
  if (query.fromDate || query.toDate) {
    where.date = {};
    if (query.fromDate) where.date.gte = normalizeDate(query.fromDate);
    if (query.toDate) where.date.lte = normalizeDate(query.toDate);
  }

  return prisma.doctorScheduleOverride.findMany({
    where,
    orderBy: { date: 'asc' },
    include: { shifts: { orderBy: { startTime: 'asc' } } },
  });
}

/**
 * Create or update a date-specific override (upsert on (doctorId, date)).
 * Replaces all shifts for that date.
 */
export async function upsertScheduleOverride(
  tenantId: string,
  doctorId: string,
  data: UpsertScheduleOverrideInput,
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
    select: { id: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  for (const s of data.shifts) {
    if (s.startTime >= s.endTime) {
      throw AppError.badRequest(`Shift start time (${s.startTime}) must be before end time (${s.endTime})`);
    }
  }

  const date = normalizeDate(data.date);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.doctorScheduleOverride.findUnique({
      where: { doctorId_date: { doctorId, date } },
    });

    let overrideId: string;
    if (existing) {
      await tx.doctorScheduleOverride.update({
        where: { id: existing.id },
        data: {
          isDayOff: data.isDayOff,
          note: data.note ?? null,
        },
      });
      await tx.doctorOverrideShift.deleteMany({ where: { overrideId: existing.id } });
      overrideId = existing.id;
    } else {
      const created = await tx.doctorScheduleOverride.create({
        data: {
          doctorId,
          date,
          isDayOff: data.isDayOff,
          note: data.note ?? null,
        },
      });
      overrideId = created.id;
    }

    if (!data.isDayOff && data.shifts.length > 0) {
      await tx.doctorOverrideShift.createMany({
        data: data.shifts.map((s) => ({
          overrideId,
          startTime: toDbTime(s.startTime),
          endTime: toDbTime(s.endTime),
          slotDurationMinutes: s.slotDurationMinutes ?? 15,
          maxPatients: s.maxPatients,
        })),
      });
    }

    return tx.doctorScheduleOverride.findUnique({
      where: { id: overrideId },
      include: { shifts: { orderBy: { startTime: 'asc' } } },
    });
  });
}

/**
 * Bulk-apply the same override to every date in the range (optionally filtered by days-of-week).
 */
export async function bulkApplyOverrides(
  tenantId: string,
  doctorId: string,
  data: BulkOverrideInput,
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
    select: { id: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  const from = normalizeDate(data.fromDate);
  const to = normalizeDate(data.toDate);
  if (to < from) throw AppError.badRequest('toDate must be on or after fromDate');

  for (const s of data.shifts) {
    if (s.startTime >= s.endTime) {
      throw AppError.badRequest(`Shift start time (${s.startTime}) must be before end time (${s.endTime})`);
    }
  }

  // Enumerate every date in the range
  const dates: Date[] = [];
  const daySet = data.daysOfWeek && data.daysOfWeek.length > 0 ? new Set(data.daysOfWeek) : null;
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (daySet && !daySet.has(d.getUTCDay())) continue;
    dates.push(new Date(d));
  }

  if (dates.length === 0) return { created: 0, updated: 0, skipped: 0 };

  // Find existing overrides in the range to honor skipExisting
  const existing = await prisma.doctorScheduleOverride.findMany({
    where: { doctorId, date: { in: dates } },
    select: { id: true, date: true },
  });
  const existingByDate = new Map(existing.map((e) => [e.date.getTime(), e.id]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const date of dates) {
      const existingId = existingByDate.get(date.getTime());

      if (existingId && data.skipExisting) {
        skipped++;
        continue;
      }

      let overrideId: string;
      if (existingId) {
        await tx.doctorScheduleOverride.update({
          where: { id: existingId },
          data: { isDayOff: data.isDayOff, note: data.note ?? null },
        });
        await tx.doctorOverrideShift.deleteMany({ where: { overrideId: existingId } });
        overrideId = existingId;
        updated++;
      } else {
        const ovr = await tx.doctorScheduleOverride.create({
          data: { doctorId, date, isDayOff: data.isDayOff, note: data.note ?? null },
        });
        overrideId = ovr.id;
        created++;
      }

      if (!data.isDayOff && data.shifts.length > 0) {
        await tx.doctorOverrideShift.createMany({
          data: data.shifts.map((s) => ({
            overrideId,
            startTime: toDbTime(s.startTime),
            endTime: toDbTime(s.endTime),
            slotDurationMinutes: s.slotDurationMinutes ?? 15,
            maxPatients: s.maxPatients,
          })),
        });
      }
    }
  });

  return { created, updated, skipped, totalDates: dates.length };
}

/**
 * Remove a date-specific override (reverts that date to the weekly recurring schedule).
 */
export async function deleteScheduleOverride(tenantId: string, overrideId: string) {
  const override = await prisma.doctorScheduleOverride.findFirst({
    where: { id: overrideId, doctor: { tenantId } },
  });
  if (!override) throw AppError.notFound('Schedule override not found');

  await prisma.doctorScheduleOverride.delete({ where: { id: overrideId } });
  return { ok: true };
}

/**
 * Calculate available time slots for a doctor on a given date.
 * Handles:
 *   - Multiple shifts per day (DoctorSchedule rows with the same dayOfWeek)
 *   - Full-day approved leaves (block everything)
 *   - Partial/custom-hour approved leaves (block only slots that overlap)
 *   - Multi-day leave ranges via leaveDate..endDate
 *   - Existing non-cancelled appointments
 */
export async function getAvailableSlots(tenantId: string, doctorId: string, date: string) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
  });

  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const targetDate = normalizeDate(date);
  const dayOfWeek = new Date(date).getDay();

  // 1. Date-specific override takes precedence over the weekly recurring schedule.
  const override = await prisma.doctorScheduleOverride.findUnique({
    where: { doctorId_date: { doctorId, date: targetDate } },
    include: { shifts: { orderBy: { startTime: 'asc' } } },
  });

  if (override?.isDayOff) {
    return { date, slots: [], message: override.note || 'Doctor is off on this date' };
  }

  let shiftSources: Array<{ startTime: Date; endTime: Date; slotDurationMinutes: number }>;
  if (override && override.shifts.length > 0) {
    shiftSources = override.shifts.map((s) => ({
      startTime: s.startTime as Date,
      endTime: s.endTime as Date,
      slotDurationMinutes: s.slotDurationMinutes,
    }));
  } else {
    const schedules = await prisma.doctorSchedule.findMany({
      where: { doctorId, dayOfWeek, isActive: true },
      orderBy: { startTime: 'asc' },
    });
    if (schedules.length === 0) {
      return { date, slots: [], message: 'Doctor does not have a schedule for this day' };
    }
    shiftSources = schedules.map((s) => ({
      startTime: s.startTime as Date,
      endTime: s.endTime as Date,
      slotDurationMinutes: s.slotDurationMinutes,
    }));
  }

  // Every approved leave covering this date — may be 1 full-day OR several partial windows
  const leaves = await prisma.doctorLeave.findMany({
    where: {
      doctorId,
      status: 'approved',
      leaveDate: { lte: targetDate },
      OR: [
        { endDate: null, leaveDate: targetDate },
        { endDate: { gte: targetDate } },
      ],
    },
  });

  const fullDayLeave = leaves.find((l) => !l.startTime && !l.endTime);
  if (fullDayLeave) {
    return { date, slots: [], message: 'Doctor is on leave on this date' };
  }

  // Convert time-only leaves to minute ranges for overlap checks
  const leaveWindows = leaves
    .filter((l) => l.startTime && l.endTime)
    .map((l) => {
      const s = l.startTime as Date;
      const e = l.endTime as Date;
      return {
        startMin: s.getUTCHours() * 60 + s.getUTCMinutes(),
        endMin: e.getUTCHours() * 60 + e.getUTCMinutes(),
      };
    });

  // Existing bookings for this day (to mark booked slots)
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

  const bookedRanges = existingAppointments.map((apt) => {
    const s = apt.startTime as Date;
    const e = apt.endTime as Date | null;
    const startMin = s.getUTCHours() * 60 + s.getUTCMinutes();
    const endMin = e
      ? (e as Date).getUTCHours() * 60 + (e as Date).getUTCMinutes()
      : startMin + 60;
    return { startMin, endMin };
  });

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const fmt = (mins: number) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

  const slots: Array<{
    startTime: string;
    endTime: string;
    available: boolean;
    onLeave?: boolean;
  }> = [];

  // Generate slots for every shift (date-override or weekly recurring)
  for (const schedule of shiftSources) {
    const ss = schedule.startTime as Date;
    const se = schedule.endTime as Date;
    const shiftStart = ss.getUTCHours() * 60 + ss.getUTCMinutes();
    const shiftEnd = se.getUTCHours() * 60 + se.getUTCMinutes();
    const slotDuration = schedule.slotDurationMinutes;

    let cur = shiftStart;
    while (cur + slotDuration <= shiftEnd) {
      const slotStartMin = cur;
      const slotEndMin = cur + slotDuration;

      const onLeave = leaveWindows.some(
        (lw) => slotStartMin < lw.endMin && slotEndMin > lw.startMin,
      );

      const isBooked = bookedRanges.some(
        (br) => slotStartMin < br.endMin && slotEndMin > br.startMin,
      );

      slots.push({
        startTime: fmt(slotStartMin),
        endTime: fmt(slotEndMin),
        available: !isBooked && !onLeave,
        ...(onLeave ? { onLeave: true } : {}),
      });

      cur += slotDuration;
    }
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
  if ((patient as { deceasedAt?: Date | null }).deceasedAt) {
    // Refused rather than warned. Booking a dead patient is either a
    // mis-selected record or a death recorded against the wrong one, and both
    // want stopping at the counter rather than surfacing later as a reminder
    // to the family.
    throw AppError.badRequest(
      'This patient is recorded as deceased. If that is wrong, an administrator can remove the death record.',
    );
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

  // Record the front desk's registration-fee decision. Written by raw SQL
  // because the column is not in the (unregenerated) client — same as
  // `admission_type`. Only an explicit choice is stored: leaving it null means
  // "the desk did not say", and the rule decides when the bill is raised.
  if (typeof data.chargeRegistrationFee === 'boolean') {
    await prisma.$executeRaw`
      UPDATE appointments SET charge_registration_fee = ${data.chargeRegistrationFee}
      WHERE id = ${appointment.id}
    `;
  }

  logger.info(
    { tenantId, appointmentId: appointment.id, doctorId: data.doctorId, patientId: data.patientId },
    'Appointment booked',
  );
  return { ...appointment, chargeRegistrationFee: data.chargeRegistrationFee ?? null };
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
    // Patient-app bookings awaiting a fee — front desk must action these.
    pendingPayment: appointments.filter((a) => a.status === 'pending_payment').length,
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
  // Consultation kind: consultation | follow_up | procedure (stored in
  // consultationType at booking). Used by the Referral / follow-up report.
  if ((query as any).type) where.consultationType = (query as any).type;

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
                select: { status: true, paymentMethod: true, paymentSource: true },
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
    let paymentStatus:
      | 'paid_online'
      | 'paid_at_frontdesk'
      | 'pay_at_frontdesk'
      | 'pending'
      | 'no_billing' = 'no_billing';

    if (bill) {
      const completedSource = latestPayment?.status === 'completed' ? latestPayment.paymentSource : null;

      if (bill.status === 'paid' || bill.status === 'partially_paid') {
        // The bill has been (at least partly) collected — label by source.
        paymentStatus = completedSource === 'frontdesk' ? 'paid_at_frontdesk' : 'paid_online';
      } else if (latestPayment?.status === 'pending') {
        paymentStatus = 'pending'; // online payment initiated but not yet captured
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

  // Cancelling has to settle the consultation charge, or the fee stays on the
  // books and rebooking raises a second one for the same consultation. Only
  // reachable before `in_consultation`, so the visit never happened and the
  // money cannot have been earned.
  //
  // Best-effort: a booking that could not be cancelled because its bill would
  // not tidy up is a worse outcome than a bill needing a manual look.
  if (newStatus === 'cancelled') {
    try {
      const billing = await import('../billing/billing.service');
      const settled = await billing.settleCancelledAppointmentCharge(
        tenantId,
        userId,
        id,
        data.cancellationReason || 'cancelled by staff',
      );
      if (settled.creditedToAdvance > 0) {
        logger.info(
          { tenantId, appointmentId: id, amount: settled.creditedToAdvance },
          'Cancelled consultation fee carried to patient advance',
        );
      }
    } catch (err) {
      logger.warn(
        { tenantId, appointmentId: id, err },
        'Could not settle the consultation charge on cancellation (non-fatal)',
      );
    }
  }

  logger.info(
    { tenantId, appointmentId: id, from: currentStatus, to: newStatus },
    'Appointment status updated',
  );
  return updated;
}

/**
 * Reschedule an appointment in place.
 *
 * Deliberately an UPDATE, not a cancel + re-book: the appointment keeps its id,
 * so the linked bill / payment, queue token, consultation record and audit
 * history all stay attached. Runs the same guards as `bookAppointment`
 * (past date, doctor leave, slot conflict) against the new slot.
 */
export async function rescheduleAppointment(
  tenantId: string,
  id: string,
  data: RescheduleAppointmentInput,
  userId: string,
) {
  const appointment = await prisma.appointment.findFirst({ where: { id, tenantId } });
  if (!appointment) {
    throw AppError.notFound('Appointment not found');
  }

  // `checked_in` is reschedulable too: a patient who has arrived may need to be
  // moved to another slot/day from the front desk. Not in-consultation/completed.
  const RESCHEDULABLE = ['pending_payment', 'booked', 'confirmed', 'no_show', 'checked_in'];
  if (!RESCHEDULABLE.includes(appointment.status)) {
    throw AppError.badRequest(
      `Cannot reschedule an appointment that is '${appointment.status.replace(/_/g, ' ')}'`,
    );
  }

  const doctorId = data.doctorId || appointment.doctorId;
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId },
  });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const appointmentDate = new Date(data.appointmentDate);
  appointmentDate.setUTCHours(0, 0, 0, 0);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (appointmentDate < today) {
    throw AppError.badRequest('Cannot reschedule an appointment into the past');
  }

  const leave = await prisma.doctorLeave.findFirst({
    where: { doctorId, leaveDate: appointmentDate },
  });
  if (leave && !leave.startTime && !leave.endTime) {
    throw AppError.badRequest('Doctor is on leave on the selected date');
  }

  const startTimeDate = new Date(`1970-01-01T${data.startTime}:00.000Z`);
  const endTimeDate = new Date(`1970-01-01T${data.endTime}:00.000Z`);

  const dayStart = new Date(appointmentDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(appointmentDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const conflicting = await prisma.appointment.findFirst({
    where: {
      id: { not: id }, // the row being moved never conflicts with itself
      doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show', 'pending_payment'] },
      startTime: { lt: endTimeDate },
      endTime: { gt: startTimeDate },
    },
  });
  if (conflicting) {
    throw AppError.conflict('This time slot is already booked');
  }

  const previous = `${appointment.appointmentDate.toISOString().slice(0, 10)} ${appointment.startTime
    .toISOString()
    .slice(11, 16)}`;
  const note = `Rescheduled from ${previous}${data.reason ? ` — ${data.reason}` : ''}`;

  const updated = await prisma.appointment.update({
    where: { id },
    data: {
      doctorId,
      appointmentDate,
      startTime: startTimeDate,
      endTime: endTimeDate,
      // A no-show that gets a new slot goes back into the booked queue.
      // A checked-in patient moved to another slot is no longer "arrived", but
      // keeps their settled fee → back to confirmed (not unpaid 'booked').
      ...(appointment.status === 'no_show'
        ? { status: 'booked' }
        : appointment.status === 'checked_in'
          ? { status: 'confirmed' }
          : {}),
      notes: appointment.notes ? `${appointment.notes}\n${note}` : note,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
      },
      doctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  logger.info(
    { tenantId, appointmentId: id, userId, to: `${data.appointmentDate} ${data.startTime}` },
    'Appointment rescheduled',
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
 * Staff-side: convert a `pending_payment` appointment into a booked one with a
 * pending front-desk Bill attached, so the cashier can collect cash/UPI on the
 * spot. Mirrors `confirmFrontdeskPayment` from the patient portal but is
 * gated by tenant ownership instead of patient connection — used by the
 * Front Desk Dashboard's "Collect Payment" action on `pending_payment` rows.
 */
/**
 * Find or create the consultation bill attached to an appointment.
 *
 * Deliberately creates the bill as `pending`, not `draft`: a draft bill cannot
 * be paid (`createPayment` rejects it) and never shows as revenue. Idempotent —
 * a second call returns the bill that already references this appointment.
 */
/**
 * Whether this appointment is a free follow-up, and what the consultation
 * therefore costs.
 *
 * Every consultation used to charge the doctor's full fee, so a patient asked
 * back in a week to have a wound looked at paid twice for a visit the doctor
 * had scheduled themselves. A doctor can now set a window in days; a return to
 * the SAME doctor inside it carries no consultation fee.
 *
 * Deliberately narrow:
 *   - same doctor only. A follow-up is with the clinician who asked for it;
 *     waiving another doctor's fee is not this feature's business.
 *   - the previous visit must have been PAID. A free follow-up follows a
 *     consultation the hospital was actually paid for — chaining it off an
 *     unpaid visit would let a whole course of treatment run for nothing.
 *   - it never touches the registration fee, which is a separate one-time
 *     charge for opening the file.
 *
 * A patient can therefore have consecutive free follow-ups only if each one is
 * itself paid, which by definition it is not — the window always measures back
 * to the last PAID consultation.
 */
async function resolveConsultationFee(
  tenantId: string,
  appointment: { id: string; patientId: string; doctorId: string; doctor: { consultationFee: unknown; freeFollowUpDays?: number | null } },
): Promise<{ fee: number; isFreeFollowUp: boolean; basedOn: Date | null; windowDays: number }> {
  const listFee = appointment.doctor?.consultationFee ? Number(appointment.doctor.consultationFee) : 0;
  const windowDays = Number(appointment.doctor?.freeFollowUpDays ?? 0) || 0;
  if (windowDays <= 0 || listFee <= 0) {
    return { fee: listFee, isFreeFollowUp: false, basedOn: null, windowDays: 0 };
  }

  const since = new Date();
  since.setDate(since.getDate() - windowDays);

  // The most recent consultation with this doctor whose bill was actually
  // settled. `paid` only — a partially paid bill has not been paid for.
  const previous = await prisma.appointment.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      id: { not: appointment.id },
      appointmentDate: { gte: since },
      status: { in: ['completed', 'in_consultation', 'checked_in', 'confirmed'] },
    },
    orderBy: { appointmentDate: 'desc' },
    select: { id: true, appointmentDate: true },
  });
  if (!previous) {
    return { fee: listFee, isFreeFollowUp: false, basedOn: null, windowDays };
  }

  const paidBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      status: 'paid',
      billItems: { some: { referenceType: 'appointment', referenceId: previous.id } },
    },
    select: { id: true },
  });
  if (!paidBill) {
    return { fee: listFee, isFreeFollowUp: false, basedOn: null, windowDays };
  }

  return { fee: 0, isFreeFollowUp: true, basedOn: previous.appointmentDate, windowDays };
}

async function ensureAppointmentBill(
  tenantId: string,
  appointmentId: string,
  userId: string,
  description = 'Consultation Fee (Pay at Front Desk)',
) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    include: { doctor: true },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.status === 'cancelled' || appointment.status === 'no_show') {
    throw AppError.badRequest(`Cannot collect payment for ${appointment.status} appointment`);
  }

  const existingBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointment.id } },
    },
  });

  if (existingBill) return { appointment, bill: existingBill };

  // A return to the same doctor inside their free-follow-up window carries no
  // consultation fee. The registration fee below is untouched — that is a
  // separate one-time charge for opening the file.
  const feeResolution = await resolveConsultationFee(tenantId, appointment as never);
  const amount = feeResolution.fee > 0 ? feeResolution.fee : 0;

  // The one-time registration fee for opening a file at THIS hospital. Decided
  // here rather than at booking so it is applied however the appointment was
  // made — front desk, walk-in or the patient's own portal, none of which
  // necessarily showed a checkbox.
  const [settings, visitStatus, deskChoice] = await Promise.all([
    getRegistrationFeeSettings(tenantId),
    getPatientVisitStatus(tenantId, appointment.patientId, { excludeAppointmentId: appointmentId }),
    readRegistrationChoice(appointmentId),
  ]);
  const chargeRegistration = shouldChargeRegistrationFee({
    settings,
    isFirstVisit: visitStatus.isFirstVisit,
    alreadyCharged: visitStatus.registrationFeeCharged,
    deskChoice,
  });
  const regTotals = registrationFeeTotals(settings);

  // A consultation is an exempt healthcare service under SAC 999312. The
  // registration fee is whatever the hospital configured, offered to the rules
  // as the fee's own classification.
  const resolver = await taxResolverFor(tenantId);
  const consultationTax = resolver.price(
    { kind: 'consultation', sacCode: CONSULTATION_SAC },
    { unitPrice: amount, quantity: 1 },
  );
  const registrationTax = resolver.price(
    {
      kind: 'registration',
      itemRatePercent: settings.gstRatePercent,
      itemTreatment: settings.gstRatePercent > 0 ? 'taxable' : 'exempt',
      // The hospital set this rate deliberately on its own settings screen, so
      // it is not an unclassified guess needing resolution.
      itemApproved: true,
    },
    { unitPrice: regTotals.unitPrice, quantity: 1 },
  );

  const registrationTotal = chargeRegistration ? registrationTax.money.totalAmount : 0;
  const subtotal = round2(consultationTax.money.taxableValue + (chargeRegistration ? registrationTax.money.taxableValue : 0));
  const taxAmount = round2(
    consultationTax.money.taxAmount + (chargeRegistration ? registrationTax.money.taxAmount : 0),
  );
  const total = round2(consultationTax.money.totalAmount + registrationTotal);

  // `bill_number` is unique GLOBALLY, so a per-tenant sequence collides between
  // hospitals: two of them raising a consultation bill on the same day both
  // computed BILL-<ymd>-0001 and the second insert violated the index. This is
  // the busiest bill path there is, so it retries rather than surfacing a 500 —
  // it runs outside a transaction, which is what makes retry possible here and
  // not on the ward paths.
  const bill = await createBillInSeriesWithRetry(prisma, 'BILL', {
      tenantId,
      patientId: appointment.patientId,
      billDate: new Date(),
      subtotal,
      discountAmount: 0,
      taxAmount,
      totalAmount: total,
      insuranceCoveredAmount: 0,
      patientPayableAmount: total,
      amountPaid: 0,
      balanceDue: total,
      status: 'pending',
      generatedBy: userId,
      billItems: {
        create: [
          {
            description,
            category: 'consultation',
            quantity: 1,
            unitPrice: amount,
            discountPercent: 0,
            discountAmount: 0,
            // Exempt, but now BECAUSE the rules say so rather than because a
            // zero was typed into the source. The answer is the same today; the
            // difference is that it can be explained on the bill, reported as
            // exempt turnover, and changed by configuration rather than by an
            // edit here.
            ...billItemTaxFields(consultationTax),
            referenceType: 'appointment',
            referenceId: appointment.id,
          },
          ...(chargeRegistration
            ? [
                {
                  description: settings.label,
                  category: 'registration' as const,
                  quantity: 1,
                  unitPrice: regTotals.unitPrice,
                  discountPercent: 0,
                  discountAmount: 0,
                  ...billItemTaxFields(registrationTax),
                  // Referenced by TYPE so the once-per-patient check can find it
                  // again regardless of what the label or amount later becomes.
                  referenceType: REGISTRATION_FEE_REFERENCE_TYPE,
                  referenceId: appointment.id,
                },
              ]
            : []),
        ],
      },
  });

  // Name and number it. This bill is created already-payable rather than as a
  // draft, so it never passes through `finalizeBill` and used to carry no
  // document type and no invoice number — a consultation the hospital could not
  // put in a return. Best effort: taking the patient's money must not fail
  // because a series could not be read.
  const { issueDocumentForExistingBill } = await import('../billing/billing.service');
  const issued = await issueDocumentForExistingBill(tenantId, bill.id);

  logger.info(
    {
      tenantId,
      appointmentId,
      billId: bill.id,
      amount,
      registrationTotal,
      freeFollowUp: feeResolution.isFreeFollowUp,
      documentType: issued?.documentType ?? null,
      invoiceNumber: issued?.invoiceNumber ?? null,
      by: userId,
    },
    'Consultation bill created for appointment',
  );
  return { appointment, bill };
}

/** The desk's stored registration-fee choice; null when they never said. */
async function readRegistrationChoice(appointmentId: string): Promise<boolean | null> {
  const rows = await prisma.$queryRaw<{ charge_registration_fee: boolean | null }[]>`
    SELECT charge_registration_fee FROM appointments WHERE id = ${appointmentId}
  `;
  return rows[0]?.charge_registration_fee ?? null;
}

/**
 * What the counter is about to charge for this appointment, itemised, BEFORE
 * any bill exists.
 *
 * The registration fee was invisible: it is decided inside
 * `ensureAppointmentBill` from three inputs the desk cannot see (the hospital
 * setting, whether this is the patient's first visit here, and an override
 * that only `createAppointment` could ever write). QA went looking for a
 * "collect registration charge" action and reasonably concluded there wasn't
 * one. This is what the desk needs to see: whether the fee applies, how much
 * it is, and WHY it does or does not apply.
 */
export async function getAppointmentChargePreview(tenantId: string, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    include: { doctor: { select: { consultationFee: true, freeFollowUpDays: true } } },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  const [settings, visitStatus, deskChoice] = await Promise.all([
    getRegistrationFeeSettings(tenantId),
    getPatientVisitStatus(tenantId, appointment.patientId, { excludeAppointmentId: appointmentId }),
    readRegistrationChoice(appointmentId),
  ]);

  const applies = shouldChargeRegistrationFee({
    settings,
    isFirstVisit: visitStatus.isFirstVisit,
    alreadyCharged: visitStatus.registrationFeeCharged,
    deskChoice,
  });
  const totals = registrationFeeTotals(settings);
  const feeResolution = await resolveConsultationFee(tenantId, appointment as never);
  const consultationFee = feeResolution.fee;
  const listFee = appointment.doctor?.consultationFee
    ? Number(appointment.doctor.consultationFee)
    : 0;

  // Say plainly why the fee is or is not on the bill, so a desk that expected
  // one and does not see it knows which of the three reasons applies.
  // Order matters: "already charged" only explains a MISSING fee when the
  // hospital charges it once per patient. Where it may be charged again, a
  // previous charge is history, not the reason — saying otherwise told a desk
  // the fee was absent while it was sitting on the bill.
  const reason = !settings.enabled
    ? 'This hospital has no registration fee configured.'
    : settings.oncePerPatient && visitStatus.registrationFeeCharged
      ? 'Already charged to this patient at this hospital.'
      : deskChoice === false
        ? 'Waived at the counter.'
        : !visitStatus.isFirstVisit && settings.oncePerPatient
          ? 'Not a first visit — the fee is once per patient.'
          : visitStatus.registrationFeeCharged
            ? 'Charged again at the counter — this hospital allows it more than once.'
            : visitStatus.isFirstVisit
              ? 'First visit at this hospital.'
              : 'Charged at the counter.';

  return {
    consultationFee,
    // Say when the fee has been waived and why, so a desk seeing ₹0 against a
    // doctor who charges ₹600 is not left wondering whether something broke.
    followUp: {
      isFree: feeResolution.isFreeFollowUp,
      listFee,
      windowDays: feeResolution.windowDays,
      previousVisitDate: feeResolution.basedOn,
    },
    registration: {
      // Can the desk act on it at all? Only when the hospital charges one.
      configured: settings.enabled,
      applies,
      label: settings.label,
      amount: totals.unitPrice,
      taxAmount: totals.taxAmount,
      totalAmount: totals.totalAmount,
      isFirstVisit: visitStatus.isFirstVisit,
      alreadyCharged: visitStatus.registrationFeeCharged,
      /** null = the desk has not said; the rule decides. */
      deskChoice,
      reason,
    },
    total: round2(consultationFee + (applies ? totals.totalAmount : 0)),
  };
}

/**
 * Add or remove the registration line on a bill that already exists.
 *
 * The fee is normally decided while the bill is assembled. When the desk
 * answers afterwards there is nothing left to decide — the bill is built — so
 * the line has to be reconciled against the answer instead.
 *
 * Adding still respects the rule: if the fee is switched off for the hospital,
 * or this patient has already paid it, an explicit "yes" cannot conjure a
 * charge that should not exist.
 */
async function reconcileRegistrationFeeLine(
  tenantId: string,
  appointmentId: string,
  billId: string,
  charge: boolean,
): Promise<void> {
  const existing = await prisma.billItem.findFirst({
    where: { billId, referenceType: REGISTRATION_FEE_REFERENCE_TYPE },
    select: { id: true },
  });

  if (!charge) {
    if (!existing) return;
    await prisma.billItem.delete({ where: { id: existing.id } });
    await recalculateBillTotalsPublic(billId);
    logger.info({ tenantId, appointmentId, billId }, 'Registration fee removed from bill at desk request');
    return;
  }

  if (existing) return; // already on the bill

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    select: { patientId: true },
  });
  if (!appointment) return;

  const [settings, visitStatus] = await Promise.all([
    getRegistrationFeeSettings(tenantId),
    getPatientVisitStatus(tenantId, appointment.patientId, { excludeAppointmentId: appointmentId }),
  ]);
  // `deskChoice: true` is the answer we are acting on; the rule still gets a
  // veto on "not configured" and "already paid it".
  if (!shouldChargeRegistrationFee({
    settings,
    isFirstVisit: visitStatus.isFirstVisit,
    alreadyCharged: visitStatus.registrationFeeCharged,
    deskChoice: true,
  })) {
    return;
  }

  const totals = registrationFeeTotals(settings);
  const reconcileResolver = await taxResolverFor(tenantId);
  const reconcileTax = reconcileResolver.price(
    {
      kind: 'registration',
      itemRatePercent: settings.gstRatePercent,
      itemTreatment: settings.gstRatePercent > 0 ? 'taxable' : 'exempt',
      itemApproved: true,
    },
    { unitPrice: totals.unitPrice, quantity: 1 },
  );
  await prisma.billItem.create({
    data: {
      billId,
      description: settings.label,
      category: 'registration',
      quantity: 1,
      unitPrice: totals.unitPrice,
      discountPercent: 0,
      discountAmount: 0,
      ...billItemTaxFields(reconcileTax),
      referenceType: REGISTRATION_FEE_REFERENCE_TYPE,
      referenceId: appointmentId,
    },
  });
  await recalculateBillTotalsPublic(billId);
  logger.info({ tenantId, appointmentId, billId }, 'Registration fee added to bill at desk request');
}

export async function initiateFrontdeskPayment(
  tenantId: string,
  appointmentId: string,
  userId: string,
  opts: { chargeRegistrationFee?: boolean } = {},
) {
  // Record the desk's decision BEFORE the bill is assembled — the fee is
  // resolved while the bill is built, so a choice made afterwards would not
  // reach it. Only an explicit choice is stored; leaving it alone means "the
  // desk did not say" and the rule decides.
  if (typeof opts.chargeRegistrationFee === 'boolean') {
    await prisma.$executeRaw`
      UPDATE appointments SET charge_registration_fee = ${opts.chargeRegistrationFee}
      WHERE id = ${appointmentId} AND tenant_id = ${tenantId}
    `;
  }

  const { appointment, bill } = await ensureAppointmentBill(tenantId, appointmentId, userId);

  // ensureAppointmentBill returns an EXISTING bill untouched, so a choice made
  // after the bill was raised reached nothing: the desk picked "charge the
  // registration fee", the counter still showed the consultation fee alone, and
  // nothing said why. Reconcile the line here so the decision is honoured
  // whenever it is made.
  //
  // Only while the bill is still collectable — a paid or part-paid bill is a
  // record of money taken, not a draft to edit.
  if (typeof opts.chargeRegistrationFee === 'boolean' && bill.status === 'pending') {
    await reconcileRegistrationFeeLine(tenantId, appointmentId, bill.id, opts.chargeRegistrationFee);
  }

  // Move pending_payment → booked. Other statuses are left alone — the bill
  // is what the cashier needs; the appointment may already be booked/confirmed
  // for an already-checked-in walk-in.
  if (appointment.status === 'pending_payment') {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'booked' },
    });
  }

  // The lines, not just the total — the desk could see "₹700 due" with no way
  // to tell that ₹100 of it was the registration fee.
  const items = await prisma.billItem.findMany({
    where: { billId: bill.id },
    select: { id: true, description: true, category: true, quantity: true, totalAmount: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    billId: bill.id,
    billNumber: bill.billNumber,
    totalAmount: Number(bill.totalAmount),
    amountPaid: Number(bill.amountPaid),
    balanceDue: Number(bill.balanceDue),
    status: bill.status,
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      category: i.category,
      quantity: i.quantity,
      amount: Number(i.totalAmount),
    })),
  };
}

/**
 * Walk-in / register-patient checkout: raise the consultation bill and, when
 * the counter takes the money there and then, record the payment against it.
 *
 * The registration dialog used to do this itself with `POST /billing`, which
 * creates a DRAFT bill and records no Payment at all — so counter takings never
 * reached billing, transactions or the day-end sheet, and the `paymentMode` it
 * sent was silently dropped by the validators. This mirrors what the patient
 * portal does (bill → payment → advance status) so both routes settle the same
 * way.
 */
export async function frontdeskCheckout(
  tenantId: string,
  appointmentId: string,
  userId: string,
  data: FrontdeskCheckoutInput,
) {
  const { appointment, bill } = await ensureAppointmentBill(
    tenantId,
    appointmentId,
    userId,
    data.collectNow ? 'Consultation Fee' : 'Consultation Fee (Pay at Front Desk)',
  );

  const balanceDue = Number(bill.balanceDue);
  let paymentId: string | null = null;
  let receiptNumber: string | null = null;

  if (data.collectNow && balanceDue > 0) {
    // Reuse the billing module's payment path so the Payment row, the receipt
    // and the bill's amountPaid/balanceDue/status all move together.
    const amount = data.amount != null ? data.amount : balanceDue;
    const { payment, receipt } = await createPayment(tenantId, userId, {
      billId: bill.id,
      amount,
      paymentMethod: data.paymentMethod ?? 'cash',
      referenceNumber: data.referenceNumber,
      notes: data.notes,
    } as any);
    paymentId = payment.id;
    receiptNumber = receipt.receiptNumber;
  }

  // A paid walk-in is confirmed; an unpaid one stays where it is so the
  // counter still sees it in the "collect payment" queue.
  if (data.collectNow && ['pending_payment', 'booked'].includes(appointment.status)) {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'confirmed' },
    });
  } else if (appointment.status === 'pending_payment') {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'booked' },
    });
  }

  const refreshed = await prisma.bill.findUnique({ where: { id: bill.id } });

  logger.info(
    { tenantId, appointmentId, billId: bill.id, collected: data.collectNow, paymentId },
    'Front-desk checkout completed',
  );

  return {
    billId: bill.id,
    billNumber: bill.billNumber,
    totalAmount: Number(refreshed?.totalAmount ?? bill.totalAmount),
    amountPaid: Number(refreshed?.amountPaid ?? 0),
    balanceDue: Number(refreshed?.balanceDue ?? balanceDue),
    status: refreshed?.status ?? bill.status,
    paymentId,
    receiptNumber,
  };
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
