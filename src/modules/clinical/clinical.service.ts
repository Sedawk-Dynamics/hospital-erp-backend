import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { abnormalFindings } from '../../shared/vitals-ranges';
import { notifyUsers, doctorUserIdFromProfile, usersWithRoles } from '../../shared/notify';
import { istDayStart, istDayEnd } from '../../shared/date.utils';
import { getPaginationParams } from '../../shared/pagination';
import { normalizeAdmissionType, type AdmissionType } from '../../shared/admission-type';
import { ACTIVE_ADMISSION_STATUS, isActiveAdmission } from '../../shared/admission-status';
import type {
  CreateVisitInput,
  GetVisitsQuery,
  UpdateVisitInput,
  CreateAdmissionInput,
  GetAdmissionsQuery,
  UpdateAdmissionInput,
  CreateTransferInput,
  GetTransfersQuery,
  RecordVitalsInput,
  GetVitalsQuery,
  GetAllVitalsQuery,
  AddDiagnosisInput,
  GetDiagnosesQuery,
  GetAllDiagnosesQuery,
  UpdateDiagnosisInput,
  CreateOtRequestInput,
  GetOtRequestsQuery,
  CreateReservationInput,
  GetReservationsQuery,
  UpdateReservationInput,
  CreateEstimationInput,
  GetEstimationsQuery,
  UpdateEstimationInput,
  GetClinicalOrdersQuery,
  AcknowledgeClinicalOrderInput,
  CorrectVitalInput,
  GetOrderAcknowledgementsQuery,
  CreateAdmissionRequestInput,
  GetAdmissionRequestsQuery,
  AcceptAdmissionRequestInput,
  RejectAdmissionRequestInput,
  AdmitFromReservationInput,
} from './clinical.validation';

/**
 * Window during which the original recorder can silently fix a typo in their
 * own vital entry without the edit being treated as an audited correction.
 * Kept intentionally short (15 minutes). Any edit outside this window, or any
 * edit by a different nurse, creates a new append-only Vital row whose
 * `supersedesVitalId` points at the original.
 */
export const VITAL_SELF_CORRECTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Roles permitted to record or correct vitals. Nursing runs the routine rounds,
 * but a doctor examining a patient must be able to take and correct a reading
 * too — every Vital stores `recordedBy` and corrections are append-only, so
 * authorship stays unambiguous either way. Super admin keeps write access for
 * support / data correction scenarios.
 */
const VITAL_RECORDER_ROLES = new Set(['nurse', 'doctor', 'super_admin']);

/**
 * Subset of recorder roles allowed to silently self-correct within the grace
 * window. `super_admin` always goes through the audited append-only path even
 * if they were the original recorder.
 */
const VITAL_SELF_CORRECT_ROLES = new Set(['nurse', 'doctor']);

function assertCanWriteVitals(roles: string[]): void {
  if (!roles.some((r) => VITAL_RECORDER_ROLES.has(r))) {
    throw AppError.forbidden(
      'Only clinical staff (nursing or medical) can record or correct vitals.',
    );
  }
}

// ==================== Visits ====================

/**
 * Create a new visit.
 */
export async function createVisit(tenantId: string, data: CreateVisitInput) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify doctor belongs to tenant — only when supplied (doctor optional now).
  if (data.doctorId) {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: data.doctorId, tenantId },
    });
    if (!doctor) {
      throw AppError.notFound('Doctor not found');
    }
  }

  // No doctor → insert via raw SQL. The (unregenerated) Prisma client still
  // types doctorId as required and rejects a null/omitted value, so we bypass it.
  if (!data.doctorId) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO visits (id, tenant_id, patient_id, doctor_id, appointment_id, visit_type, visit_date, chief_complaint, status, created_at, updated_at)
      VALUES (gen_random_uuid()::text, ${tenantId}, ${data.patientId}, NULL, ${data.appointmentId ?? null}, ${data.visitType}::"VisitType", ${new Date(data.visitDate)}, ${data.chiefComplaint ?? null}, 'active'::"VisitStatus", now(), now())
      RETURNING id
    `;
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
      select: { id: true, mrn: true, firstName: true, lastName: true },
    });
    logger.info({ tenantId, visitId: rows[0].id, doctorless: true }, 'Visit created');
    return {
      id: rows[0].id,
      tenantId,
      patientId: data.patientId,
      doctorId: null,
      visitType: data.visitType,
      status: 'active',
      patient,
    };
  }

  const visit = await prisma.visit.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      appointmentId: data.appointmentId,
      visitType: data.visitType,
      visitDate: new Date(data.visitDate),
      chiefComplaint: data.chiefComplaint,
      status: 'active',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: visit.id }, 'Visit created');
  return visit;
}

/**
 * Find or create an OP visit for the given appointment. Used at consultation
 * start so the doctor can place lab / imaging orders before they finish the
 * SOAP note (orders need a visitId; the visit was previously created only at
 * consultation completion). Idempotent: returns the existing active visit
 * tied to the appointment when one exists.
 */
export async function ensureVisitForAppointment(
  tenantId: string,
  appointmentId: string,
) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    select: {
      id: true,
      patientId: true,
      doctorId: true,
      reason: true,
      status: true,
    },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Prefer a visit already linked to this appointment.
  const linked = await prisma.visit.findFirst({
    where: { tenantId, appointmentId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  if (linked) return linked;

  // Fall back to any active visit for this patient with the same doctor — the
  // legacy consultation flow created visits without backfilling appointmentId
  // before this endpoint existed.
  const existing = await prisma.visit.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      status: 'active',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    // Backfill the appointment link so future lookups by appointmentId match.
    if (!existing.appointmentId) {
      try {
        await prisma.visit.update({
          where: { id: existing.id },
          data: { appointmentId },
        });
      } catch {
        /* non-fatal */
      }
    }
    return existing;
  }

  // An UNCLAIMED encounter for this patient — active, no doctor, no
  // appointment. That is what an emergency or temporary registration leaves
  // behind: the patient was taken in before anyone knew which consultant would
  // see them.
  //
  // Adopt it rather than opening a second one. The check above matches on
  // doctorId, so a doctorless visit never matched and the patient ended up with
  // two active OP visits for one attendance — orders and notes then scattered
  // across both, which is worse than having no encounter at all.
  const unclaimed = await prisma.visit.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      status: 'active',
      doctorId: null,
      appointmentId: null,
      // OUTPATIENT encounters only. Direct-admit adopts the same registration
      // visit and converts it to `ip` — leaving an active IP visit that is also
      // doctorless and appointment-less. Without this filter, booking an OP
      // appointment for an admitted patient would claim their INPATIENT
      // encounter and stamp an outpatient appointment onto the middle of their
      // stay. An admitted patient's encounter is never up for adoption.
      visitType: 'op',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (unclaimed) {
    const adopted = await prisma.visit.update({
      where: { id: unclaimed.id },
      data: {
        doctorId: appointment.doctorId,
        appointmentId: appointment.id,
        // Keep whatever the desk wrote at registration — it is the patient's
        // own account of why they came, and the appointment reason is usually
        // the same thing typed again.
        chiefComplaint: unclaimed.chiefComplaint ?? appointment.reason ?? undefined,
      },
    });
    logger.info(
      { tenantId, appointmentId, visitId: adopted.id },
      'Unclaimed encounter adopted by appointment',
    );
    return adopted;
  }

  const visit = await prisma.visit.create({
    data: {
      tenantId,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      appointmentId: appointment.id,
      visitType: 'op',
      visitDate: new Date(),
      chiefComplaint: appointment.reason ?? undefined,
      status: 'active',
    },
  });
  logger.info(
    { tenantId, appointmentId, visitId: visit.id },
    'Visit auto-created for in-flight consultation',
  );
  return visit;
}

/**
 * Get paginated list of visits with filters.
 */
export async function getVisits(tenantId: string, query: GetVisitsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.visitType) where.visitType = query.visitType;
  if (query.status) where.status = query.status;

  if (query.fromDate) {
    where.visitDate = { ...where.visitDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.visitDate = { ...where.visitDate, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { chiefComplaint: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [visits, total] = await Promise.all([
    prisma.visit.findMany({
      where,
      skip,
      take,
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
      orderBy: { visitDate: query.sortOrder ?? 'desc' },
    }),
    prisma.visit.count({ where }),
  ]);

  return { visits, total, page, limit };
}

/**
 * Get a single visit by ID.
 */
export async function getVisitById(tenantId: string, id: string) {
  const visit = await prisma.visit.findFirst({
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
      admission: true,
      vitals: { orderBy: { recordedAt: 'desc' }, take: 5 },
      diagnoses: { orderBy: { diagnosedAt: 'desc' } },
    },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Name whoever recorded the intake complaint. `nurseChiefComplaintById` is a
  // bare FK column with no Prisma relation on it, so it cannot be `include`d —
  // and an id tells the doctor nothing. Resolved here rather than adding a
  // relation, which would mean a new foreign-key constraint on a live table
  // for a label.
  let nurseChiefComplaintBy: { id: string; firstName: string; lastName: string | null } | null = null;
  if (visit.nurseChiefComplaintById) {
    nurseChiefComplaintBy = await prisma.user.findFirst({
      where: { id: visit.nurseChiefComplaintById },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  return { ...visit, nurseChiefComplaintBy };
}

/**
 * Update a visit.
 */
export async function updateVisit(tenantId: string, id: string, data: UpdateVisitInput, userId?: string) {
  const visit = await prisma.visit.findFirst({
    where: { id, tenantId },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  if (visit.status === 'completed' || visit.status === 'discharged') {
    throw AppError.badRequest('Cannot update a closed visit');
  }

  if (data.doctorId) {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: data.doctorId, tenantId },
    });
    if (!doctor) {
      throw AppError.notFound('Doctor not found');
    }
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: {
      ...(data.doctorId && { doctorId: data.doctorId }),
      ...(data.chiefComplaint !== undefined && { chiefComplaint: data.chiefComplaint }),
      // Attribution is stamped here rather than trusted from the caller — the
      // point of a separate field is knowing who recorded it, so the client
      // must not be able to claim someone else said it.
      ...(data.nurseChiefComplaint !== undefined && {
        nurseChiefComplaint: data.nurseChiefComplaint || null,
        nurseChiefComplaintById: data.nurseChiefComplaint ? (userId ?? null) : null,
        nurseChiefComplaintAt: data.nurseChiefComplaint ? new Date() : null,
      }),
      ...(data.visitType && { visitType: data.visitType }),
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: id }, 'Visit updated');
  return updated;
}

/**
 * Close (complete) a visit.
 */
export async function closeVisit(tenantId: string, id: string) {
  const visit = await prisma.visit.findFirst({
    where: { id, tenantId },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  if (visit.status === 'completed') {
    throw AppError.badRequest('Visit is already closed');
  }

  if (visit.status === 'discharged') {
    throw AppError.badRequest('Visit has already been discharged');
  }

  // An admission reuses the same Visit row (Admission.visitId is 1:1). If this
  // visit backs a still-admitted patient, completing it here — e.g. when the
  // doctor finishes the OP consultation *after* the patient was admitted — would
  // flip the shared IP visit to 'completed' and lock the treating doctor out of
  // writing IP prescriptions / progress notes (those resolve the patient's
  // "active" visit). Keep it active; the visit is closed at discharge instead.
  const backingAdmission = await prisma.admission.findFirst({
    where: { visitId: id, status: { not: 'discharged' } },
    select: { id: true },
  });
  if (backingAdmission) {
    logger.info(
      { tenantId, visitId: id, admissionId: backingAdmission.id },
      'Visit close skipped — visit backs an active admission (kept active for IP)',
    );
    return prisma.visit.findFirstOrThrow({
      where: { id },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: { status: 'completed' },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: id }, 'Visit closed');
  return updated;
}

// ==================== Admissions ====================

/**
 * Create a new admission.
 */
export async function createAdmission(tenantId: string, userId: string, data: CreateAdmissionInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Check if visit already has an admission
  const existingAdmission = await prisma.admission.findUnique({
    where: { visitId: data.visitId },
  });
  if (existingAdmission) {
    throw AppError.conflict('This visit already has an admission');
  }

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify doctor belongs to tenant — only when one is supplied (optional now).
  if (data.doctorId) {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: data.doctorId, tenantId },
    });
    if (!doctor) {
      throw AppError.notFound('Doctor not found');
    }
  }

  // Bed & ward are optional at registration — front desk assigns/changes them
  // later from the IP ledger. Only validate + occupy a bed when one is supplied.
  let bed: Awaited<ReturnType<typeof prisma.bed.findFirst>> = null;
  if (data.bedId) {
    bed = await prisma.bed.findFirst({
      where: { id: data.bedId, tenantId, ...(data.wardId ? { wardId: data.wardId } : {}) },
    });
    if (!bed) {
      throw AppError.notFound('Bed not found in the specified ward');
    }
    // The bed must be free, or reserved/occupied for THIS patient already
    // (e.g. a reservation getting converted into an admission).
    const bedHeldByThisPatient =
      bed.currentPatientId === data.patientId &&
      (bed.status === 'reserved' || bed.status === 'occupied');
    if (bed.status !== 'available' && !bedHeldByThisPatient) {
      throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
    }
  }

  const admission = await prisma.$transaction(async (tx) => {
    const created = await tx.admission.create({
      data: {
        tenantId,
        visitId: data.visitId,
        patientId: data.patientId,
        doctorId: data.doctorId,
        // Derive ward from the bed if only a bed was passed; both may be null.
        wardId: data.wardId ?? bed?.wardId ?? undefined,
        bedId: data.bedId ?? undefined,
        admissionDate: new Date(data.admissionDate),
        expectedDischargeDate: data.expectedDischargeDate
          ? new Date(data.expectedDischargeDate)
          : undefined,
        admissionReason: data.admissionReason,
        depositAmount: data.depositAmount ?? 0,
        // G12: how this IP patient settles (cash/package/insurance/corporate).
        billingCategory: (data as any).billingCategory ?? undefined,
        status: 'admitted',
        admittedBy: userId,
      },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    // A deposit taken at admission is money handed over by a patient, so it
    // gets a Payment and a Receipt like any other money. It used to be written
    // to depositAmount as a bare number — no date, no tender, nobody named, and
    // nothing to hand the patient. In the same transaction as the admission, so
    // the money and its receipt commit together.
    const depositTaken = Number(data.depositAmount ?? 0);
    if (depositTaken > 0) {
      const billing = await import('../billing/billing.service');
      await billing.recordAdmissionDepositReceipt(tx, tenantId, userId, {
        patientId: data.patientId,
        admissionId: created.id,
        amount: depositTaken,
        paymentMethod: (data as any).depositPaymentMethod,
      });
    }

    // Occupy the bed atomically (only when a bed was assigned at registration).
    if (data.bedId) {
      await tx.bed.update({
        where: { id: data.bedId },
        data: { status: 'occupied', currentPatientId: data.patientId },
      });
    }

    // If the patient had active reservations, close them out and free any
    // reserved-but-different bed so it doesn't leak in the 'reserved' state.
    const activeReservations = await tx.reservation.findMany({
      where: {
        tenantId,
        patientId: data.patientId,
        status: { in: ['reserved', 'confirmed'] },
      },
      select: { id: true, bedId: true },
    });
    if (activeReservations.length > 0) {
      await tx.reservation.updateMany({
        where: { id: { in: activeReservations.map((r) => r.id) } },
        data: { status: 'admitted' },
      });
      const staleBedIds = activeReservations
        .map((r) => r.bedId)
        .filter((id): id is string => Boolean(id) && id !== data.bedId);
      if (staleBedIds.length > 0) {
        await tx.bed.updateMany({
          where: {
            id: { in: staleBedIds },
            status: 'reserved',
            currentPatientId: data.patientId,
          },
          data: { status: 'available', currentPatientId: null },
        });
      }
    }

    // Normalise the visit to an active IP encounter so downstream IP screens
    // (which resolve the visit via ?status=active + prefer visitType 'ip') find
    // exactly this visit.
    if (visit.visitType !== 'ip' || visit.status !== 'active') {
      await tx.visit.update({
        where: { id: data.visitId },
        data: { visitType: 'ip', status: 'active' },
      });
    }

    return created;
  });

  // Care type (ip | emergency | daycare) — set via raw SQL since the Prisma
  // client isn't regenerated yet. Defaults to 'ip'.
  const admissionType = normalizeAdmissionType((data as any).admissionType);
  await prisma.$executeRaw`UPDATE admissions SET admission_type = ${admissionType} WHERE id = ${admission.id}`;

  logger.info({ tenantId, admissionId: admission.id, bedId: data.bedId, admissionType }, 'Admission created');
  await autoConnectTpaOnAdmission(tenantId, userId, admission.id, (data as any).billingCategory);
  return { ...admission, admissionType };
}

/**
 * When an IP patient is booked as insurance/corporate, connect them to the TPA
 * straight away (link the policy) — so it's done from the start, not left to the
 * billing desk. Runs after the admission commits; always non-fatal.
 */
async function autoConnectTpaOnAdmission(
  tenantId: string,
  userId: string,
  admissionId: string,
  billingCategory?: string | null,
) {
  const cat = (billingCategory ?? '').toLowerCase();
  if (cat !== 'insurance' && cat !== 'corporate') return;
  try {
    const billing = await import('../billing/billing.service');
    await billing.ensureAdmissionTpaLink(tenantId, userId, admissionId);
  } catch (err) {
    logger.warn({ tenantId, admissionId, err }, 'Auto TPA link on admission failed (non-fatal)');
  }
}

/**
 * Get paginated list of admissions.
 */
export async function getAdmissions(tenantId: string, query: GetAdmissionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if ((query as any).doctorUserId) {
    // Resolve DoctorProfile from the logged-in user ID. Without this the
    // doctor's IP panel filters by user.id against Admission.doctorId
    // (which is DoctorProfile.id) and silently returns nothing, which is
    // exactly the bug that landed in /doctor/ip after frontdesk admits.
    const dp = await prisma.doctorProfile.findFirst({
      where: { userId: (query as any).doctorUserId, tenantId },
      select: { id: true },
    });
    if (!dp) {
      return { admissions: [], total: 0, page, limit };
    }
    // An admission the front desk opened without naming a consultant — which is
    // the norm for an emergency case — belongs to nobody, so a doctor scoped to
    // "my patients" never saw it and neither did anyone else. `includeUnassigned`
    // adds those, so waiting work is visible to whoever can pick it up.
    //
    // Uses AND/OR rather than `where.doctorId` because a `search` filter already
    // occupies `where.OR`, and a second top-level OR would silently replace it.
    if ((query as any).includeUnassigned) {
      where.AND = [
        ...((where.AND as unknown[]) ?? []),
        { OR: [{ doctorId: dp.id }, { doctorId: null }] },
      ];
    } else {
      where.doctorId = dp.id;
    }
  }
  if ((query as any).nurseId) where.nurseId = (query as any).nurseId;
  if (query.wardId) where.wardId = query.wardId;
  // Stays still waiting on a bed. Deliberately keyed on bedId alone: wardId can
  // be set while the bed is not (a patient placed on a ward before a specific
  // bed frees up), and it is the bed that says where they actually are.
  if ((query as { unassignedBed?: boolean }).unassignedBed) where.bedId = null;
  // `status=admitted` means "still on the ward", which INCLUDES a patient the
  // doctor has signed off who is waiting on the counter. Every caller that asks
  // for admitted patients — eMAR, charting, forms, ward orders, the nurse
  // dashboard, the doctor's active-admission lookup — means "who is here", and
  // dropping a ready_to_discharge patient from those would take them off their
  // own drug chart while they are still in the bed. Ask for
  // `status=ready_to_discharge` to narrow to just the counter queue.
  if (query.status) {
    where.status = query.status === 'admitted' ? ACTIVE_ADMISSION_STATUS : query.status;
  }

  if ((query as any).date) {
    const d = new Date((query as any).date);
    if (!isNaN(d.getTime())) {
      const start = new Date(d);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(d);
      end.setUTCHours(23, 59, 59, 999);
      where.admissionDate = { gte: start, lte: end };
    }
  } else {
    // Date-range window (reports screen). `date` wins when both are supplied.
    if ((query as any).fromDate) {
      const from = new Date((query as any).fromDate);
      from.setUTCHours(0, 0, 0, 0);
      where.admissionDate = { ...where.admissionDate, gte: from };
    }
    if ((query as any).toDate) {
      const to = new Date((query as any).toDate);
      to.setUTCHours(23, 59, 59, 999);
      where.admissionDate = { ...where.admissionDate, lte: to };
    }
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { admissionReason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  // Care-type filter (ip | emergency | daycare). The column isn't in the
  // (unregenerated) Prisma client, so pre-fetch matching ids by raw SQL and
  // intersect via where.id. 'ip' also matches legacy NULLs.
  const typeFilter = (query as any).admissionType as string | undefined;
  if (typeFilter && ['ip', 'emergency', 'daycare'].includes(typeFilter)) {
    const idRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM admissions
      WHERE tenant_id = ${tenantId}
        AND (admission_type = ${typeFilter}${typeFilter === 'ip' ? Prisma.sql` OR admission_type IS NULL` : Prisma.empty})
    `;
    where.id = { in: idRows.map((r) => r.id) };
  }

  const [admissions, total] = await Promise.all([
    prisma.admission.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
      orderBy: { admissionDate: query.sortOrder ?? 'desc' },
    }),
    prisma.admission.count({ where }),
  ]);

  // Attach admission_type (raw column) to each row.
  const typeMap = await fetchAdmissionTypes(admissions.map((a) => a.id));

  const withType = admissions.map((a) => ({
    ...a,
    admissionType: typeMap.get(a.id) ?? 'ip',
    // Kept alongside the status so existing clients that read the flag keep
    // working; the status itself is now the source of truth.
    dischargeReady: a.status === 'ready_to_discharge',
  }));

  return { admissions: withType, total, page, limit };
}

/**
 * Get a single admission by ID.
 */
export async function getAdmissionById(tenantId: string, id: string) {
  const admission = await prisma.admission.findFirst({
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
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
      visit: {
        select: { id: true, visitType: true, visitDate: true, chiefComplaint: true, status: true },
      },
      // Active nurse(s) assigned to this admission — surfaced in the IP workspace
      // header (the whole care team reads the admission, so no nurse_assignments
      // permission is needed to see who is nursing the patient).
      nurseAssignments: {
        where: { status: 'active' },
        orderBy: { assignedAt: 'desc' },
        take: 3,
        select: {
          id: true,
          shiftType: true,
          shiftDate: true,
          nurse: { select: { firstName: true, lastName: true } },
          ward: { select: { name: true } },
          bed: { select: { bedNumber: true } },
        },
      },
      admitter: { select: { id: true, firstName: true, lastName: true } },
      discharger: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const typeMap = await fetchAdmissionTypes([admission.id]);
  return { ...admission, admissionType: typeMap.get(admission.id) ?? 'ip' };
}

/**
 * Update an admission.
 */
export async function updateAdmission(
  tenantId: string,
  id: string,
  data: UpdateAdmissionInput,
  userId?: string,
) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  if (admission.status === 'discharged') {
    throw AppError.badRequest('Cannot update a discharged admission');
  }

  if (data.bedId) {
    // wardId may be null for a pending-placement (ER) admission (G6/2.3) — only
    // constrain the bed lookup by ward when we actually have one.
    const wardId = data.wardId ?? admission.wardId ?? undefined;
    const bed = await prisma.bed.findFirst({
      where: { id: data.bedId, wardId, tenantId },
    });
    if (!bed) {
      throw AppError.notFound('Bed not found in the specified ward');
    }
  }

  // Only an INCREASE is new money. Raising a deposit from 5,000 to 7,000 means
  // the patient handed over 2,000 more, and that gets a receipt. Lowering it is
  // a correction or a refund, and neither is money coming in — issuing a
  // receipt for one would invent a payment that never happened.
  const depositBefore = Number(admission.depositAmount ?? 0);
  const depositAfter = data.depositAmount !== undefined ? Number(data.depositAmount) : depositBefore;
  const depositIncrease = Math.round(Math.max(0, depositAfter - depositBefore) * 100) / 100;

  const updated = await prisma.$transaction(async (tx) => {
    if (depositIncrease > 0) {
      const billing = await import('../billing/billing.service');
      await billing.recordAdmissionDepositReceipt(tx, tenantId, userId ?? '', {
        patientId: admission.patientId,
        admissionId: id,
        amount: depositIncrease,
        paymentMethod: (data as any).depositPaymentMethod,
        notes: 'Admission deposit topped up',
      });
    }
    return tx.admission.update({
    where: { id },
    data: {
      ...(data.wardId && { wardId: data.wardId }),
      ...(data.bedId && { bedId: data.bedId }),
      ...(data.expectedDischargeDate !== undefined && {
        expectedDischargeDate: data.expectedDischargeDate
          ? new Date(data.expectedDischargeDate)
          : null,
      }),
      ...(data.admissionReason !== undefined && { admissionReason: data.admissionReason }),
      ...(data.depositAmount !== undefined && { depositAmount: data.depositAmount }),
      ...((data as any).billingCategory !== undefined && {
        billingCategory: (data as any).billingCategory,
      }),
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
    });
  });

  logger.info({ tenantId, admissionId: id, depositIncrease }, 'Admission updated');
  return updated;
}

/**
 * Front-desk "assign / change bed" from the IP ledger — applied INSTANTLY (no
 * transfer-approval step). Beds are no longer picked at registration, so this is
 * the primary way a patient gets (or moves) a bed during the stay. Frees the old
 * bed and occupies the new one atomically; ward is derived from the chosen bed.
 * Pass `bedId: null` to unassign (free the current bed, leave the patient bedless).
 */
export async function assignAdmissionBed(
  tenantId: string,
  id: string,
  data: { bedId: string | null },
) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
    select: { id: true, patientId: true, visitId: true, bedId: true, wardId: true, status: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  if (admission.status === 'discharged') {
    throw AppError.badRequest('Cannot change the bed of a discharged admission');
  }

  let newWardId: string | null = null;
  if (data.bedId) {
    const bed = await prisma.bed.findFirst({
      where: { id: data.bedId, tenantId },
      select: { id: true, bedNumber: true, status: true, currentPatientId: true, wardId: true },
    });
    if (!bed) throw AppError.notFound('Bed not found');
    const heldForThisPatient =
      bed.currentPatientId === admission.patientId &&
      (bed.status === 'reserved' || bed.status === 'occupied');
    // A no-op re-assign to the same bed is fine; otherwise the bed must be free.
    if (bed.id !== admission.bedId && bed.status !== 'available' && !heldForThisPatient) {
      throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
    }
    newWardId = bed.wardId;
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Free the previously-occupied bed if we're moving off it.
    if (admission.bedId && admission.bedId !== data.bedId) {
      await tx.bed.updateMany({
        where: { id: admission.bedId, currentPatientId: admission.patientId },
        data: { status: 'available', currentPatientId: null },
      });
    }
    // Occupy the new bed.
    if (data.bedId) {
      await tx.bed.update({
        where: { id: data.bedId },
        data: { status: 'occupied', currentPatientId: admission.patientId },
      });
    }
    // Record the bed/ward move as a PatientTransfer so per-bed billing can
    // reconstruct the occupancy timeline (each bed billed for the days it was
    // actually occupied). Only when the bed genuinely changes — a no-op
    // re-assign to the same bed writes nothing. Marked approved (instant move);
    // createdAt is the boundary time between the old and new bed's charges.
    if (admission.bedId !== data.bedId) {
      await tx.patientTransfer.create({
        data: {
          tenantId,
          patientId: admission.patientId,
          visitId: admission.visitId,
          transferType: newWardId !== admission.wardId ? 'ward_to_ward' : 'bed_to_bed',
          fromBedId: admission.bedId,
          toBedId: data.bedId,
          fromWardId: admission.wardId,
          toWardId: newWardId,
          status: 'approved',
        },
      });
    }
    return tx.admission.update({
      where: { id },
      data: { bedId: data.bedId, wardId: newWardId },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });
  });

  logger.info({ tenantId, admissionId: id, bedId: data.bedId }, 'Admission bed assigned/changed');
  return updated;
}

/**
 * Convert an admission's care TYPE (ip ⇄ emergency ⇄ daycare). All three share
 * the same IP flow, so this only changes the tag. Front desk, doctors and nurses
 * can flip it. Written via raw SQL (client not regenerated for this column yet).
 */
export async function changeAdmissionType(tenantId: string, id: string, type: string) {
  const admissionType = normalizeAdmissionType(type);
  const adm = await prisma.admission.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true },
  });
  if (!adm) throw AppError.notFound('Admission not found');
  if (adm.status === 'discharged') {
    throw AppError.badRequest('Cannot change the type of a discharged admission');
  }
  await prisma.$executeRaw`UPDATE admissions SET admission_type = ${admissionType}, updated_at = now() WHERE id = ${id} AND tenant_id = ${tenantId}`;
  logger.info({ tenantId, admissionId: id, admissionType }, 'Admission type changed');
  return { id, admissionType };
}

/**
 * Set (or clear) the treating consultant on an admission.
 *
 * `Admission.doctorId` is nullable so the front desk can open an emergency
 * admission before a consultant is named — but nothing could fill it in
 * afterwards: `updateAdmissionSchema` has no doctorId, so an unassigned
 * admission stayed unassigned forever and never appeared on any doctor's list.
 *
 * A doctor calling this for themselves is claiming the patient; the desk or an
 * admin can assign anyone. Handing over a patient who already has a consultant
 * is allowed but recorded, since it changes who is answerable for the stay.
 */
export async function assignAdmissionDoctor(
  tenantId: string,
  id: string,
  doctorId: string | null,
  actorUserId: string,
) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true, doctorId: true, patientId: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  if (admission.status === 'discharged') {
    throw AppError.badRequest('Cannot change the consultant on a discharged admission');
  }

  if (doctorId) {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: doctorId, tenantId },
      select: { id: true },
    });
    if (!doctor) throw AppError.notFound('Doctor not found at this hospital');
  }

  const updated = await prisma.admission.update({
    where: { id },
    data: { doctorId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });

  // Who is answerable for a stay is worth an audit row, not just a log line.
  // Best-effort: a failed audit write must not undo the assignment.
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId,
        action: 'update',
        entityType: 'Admission',
        entityId: id,
        description: doctorId
          ? `Treating consultant set on admission ${id}`
          : `Treating consultant cleared on admission ${id}`,
        oldValues: { doctorId: admission.doctorId },
        newValues: { doctorId },
      },
    });
  } catch {
    /* audit is not worth failing the change over */
  }

  logger.info({ tenantId, admissionId: id, doctorId, actorUserId }, 'Admission consultant changed');
  const typeMap = await fetchAdmissionTypes([id]);
  return { ...updated, admissionType: typeMap.get(id) ?? 'ip' };
}

/** Fetch admission_type for a set of admission ids (raw — client not regenerated). */
async function fetchAdmissionTypes(ids: string[]): Promise<Map<string, AdmissionType>> {
  const map = new Map<string, AdmissionType>();
  if (ids.length === 0) return map;
  const rows = await prisma.$queryRaw<{ id: string; admission_type: string | null }[]>`
    SELECT id, admission_type FROM admissions WHERE id IN (${Prisma.join(ids)})
  `;
  for (const r of rows) map.set(r.id, normalizeAdmissionType(r.admission_type));
  return map;
}

/**
 * Discharge a patient (close admission).
 */
export async function dischargePatient(
  tenantId: string,
  id: string,
  userId: string,
  data?: { dischargeDate?: string; notes?: string; force?: boolean; reason?: string },
) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  if (admission.status === 'discharged') {
    throw AppError.badRequest('Patient is already discharged');
  }

  // Discharge has TWO gates, and both must pass before the bed is released.
  //
  //   1. CLINICAL — a published discharge summary (the doctor's sign-off).
  //      Publishing no longer discharges the patient by itself; it only marks
  //      them ready, and the counter performs the discharge below.
  //   2. FINANCIAL — the stay's bill must be fully settled. Marking someone
  //      discharged with money outstanding drops them off the active-IP
  //      worklists and effectively writes the balance off.
  //
  // `force` is the administrative override for LAMA / transfer-out / death and
  // skips BOTH gates; it requires a reason, which is written into the notes.
  if (!data?.force) {
    const publishedSummary = await prisma.dischargeSummary.findFirst({
      where: { admissionId: id, status: 'published' },
      select: { id: true },
    });
    if (!publishedSummary) {
      throw AppError.badRequest(
        'A published discharge summary is required before discharging this patient. Please complete and publish the discharge summary first.',
      );
    }

    const billing = await import('../billing/billing.service');
    const outstanding = await billing.getAdmissionOutstanding(tenantId, id);
    if (!outstanding.isCleared) {
      throw AppError.badRequest(
        `The final bill is not cleared — ₹${outstanding.balanceAfterDeposit.toFixed(2)} is still outstanding. Collect or settle the balance before discharging this patient.`,
      );
    }
  } else if (!data.reason?.trim()) {
    throw AppError.badRequest(
      'A reason is required to discharge without clinical sign-off and bill clearance (e.g. LAMA, transfer-out, death).',
    );
  }

  const dischargeDate = data?.dischargeDate ? new Date(data.dischargeDate) : new Date();

  const updated = await prisma.$transaction(async (tx) => {
    // Update admission status
    const discharged = await tx.admission.update({
      where: { id },
      data: {
        status: 'discharged',
        dischargeDate,
        dischargedBy: userId,
      },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        doctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    // Free the bed only if it is still tied to this patient (defensive
    // against a concurrent transfer that already moved them off it).
    if (admission.bedId) {
      await tx.bed.updateMany({
        where: { id: admission.bedId, currentPatientId: admission.patientId },
        data: { status: 'available', currentPatientId: null },
      });
    }

    // Update the visit status to discharged
    await tx.visit.update({
      where: { id: admission.visitId },
      data: { status: 'discharged' },
    });

    // Stamp the discharge date onto the summary.
    //
    // The summary copies it from the admission when it is written — but the
    // summary IS the discharge gate, so it is written while the patient is
    // still admitted and there is no date to copy yet. Nothing filled it in
    // afterwards, so every stored copy stayed null and the clinical history
    // panel, which renders that field as each row's headline, showed every past
    // stay as "Not yet discharged".
    //
    // Only fills a blank: a summary that already carries a date keeps it.
    await tx.dischargeSummary.updateMany({
      where: { admissionId: id, dischargeDate: null },
      data: { dischargeDate },
    });

    return discharged;
  });

  // G5 (2.1): assemble the discharge bill — pull every outstanding charge onto a
  // finalized final-charges bill — AFTER the clinical discharge commits. Awaited
  // (so the response carries the financial summary for the discharge screen) but
  // wrapped so a billing glitch never fails the already-committed discharge. Its
  // charge-pull is idempotent, so this is the single assembly point (no double-bill).
  let dischargeBilling: Awaited<ReturnType<typeof import('../billing/billing.service')['assembleDischargeBill']>> | null = null;
  try {
    const billing = await import('../billing/billing.service');
    // Signature is (tenantId, userId, admissionId, opts) — pass in that order.
    dischargeBilling = await billing.assembleDischargeBill(tenantId, userId, id);
  } catch (err) {
    logger.error({ err, admissionId: id }, 'discharge bill assembly failed');
  }

  // Who released the bed, when, and on what authority. A forced discharge skips
  // the clinical + financial gates, so its reason has to be recoverable later.
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'update',
        entityType: 'admission',
        entityId: id,
        description: data?.force
          ? `Patient discharged by administrative override — Reason: ${data.reason?.trim()}`
          : 'Patient discharged after discharge-summary sign-off and bill clearance',
        newValues: {
          status: 'discharged',
          dischargeDate: dischargeDate.toISOString(),
          forced: !!data?.force,
          reason: data?.reason?.trim() ?? null,
        },
      },
    });
  } catch (err) {
    logger.warn({ err, admissionId: id }, 'Failed to write discharge audit log');
  }

  logger.info({ tenantId, admissionId: id, forced: !!data?.force }, 'Patient discharged');
  return { ...updated, dischargeBilling };
}

/**
 * Admissions still occupying a bed but waiting on the cash counter — the
 * clinical side is done and Front Desk / Billing has to clear the bill before
 * the patient can leave.
 */
export async function getDischargeReadyAdmissions(tenantId: string) {
  const rows = await prisma.admission.findMany({
    where: { tenantId, status: 'ready_to_discharge' },
    select: { id: true },
  });
  return new Set(rows.map((a) => a.id));
}

// ==================== Transfers ====================

/**
 * Create a patient transfer request.
 */
/**
 * Roles whose transfer authority is placement only.
 *
 * Moving a patient to another ward or bed is a placement decision nursing
 * makes every day. Changing who the consultant is reassigns clinical
 * responsibility for the patient — it rewrites visit, admission and
 * appointment doctorId — and that is not nursing's call. One route serves both,
 * so the line is drawn here where the transfer type is known.
 */
const PLACEMENT_ONLY_TRANSFER_ROLES = new Set(['nurse', 'nurse_admin']);

export async function createTransfer(
  tenantId: string,
  userId: string,
  data: CreateTransferInput,
  actorRoles: string[] = [],
) {
  if (data.transferType === 'doctor_to_doctor') {
    // Refused only when EVERY role the caller holds is placement-only, so a
    // nurse who is also a doctor on this tenant is not blocked by the weaker
    // of their two roles.
    const placementOnly =
      actorRoles.length > 0 && actorRoles.every((r) => PLACEMENT_ONLY_TRANSFER_ROLES.has(r));
    if (placementOnly) {
      throw AppError.forbidden(
        'Changing the consultant is a clinical decision. You can move a patient between wards or beds.',
      );
    }
  }

  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const transfer = await prisma.patientTransfer.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      transferType: data.transferType,
      fromDoctorId: data.fromDoctorId,
      toDoctorId: data.toDoctorId,
      fromBedId: data.fromBedId,
      toBedId: data.toBedId,
      fromWardId: data.fromWardId,
      toWardId: data.toWardId,
      reason: data.reason,
      requestedBy: userId,
      status: 'requested',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      fromDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      toDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      fromWard: { select: { id: true, name: true } },
      toWard: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, transferId: transfer.id }, 'Transfer request created');

  // Front-desk "instant" transfer — immediately approve so the bed/ward (or
  // doctor) actually moves, no pending step. Keeps the PatientTransfer record for
  // audit. approveTransfer is hoisted (function declaration below).
  if ((data as any).autoApprove) {
    return approveTransfer(tenantId, transfer.id, userId, { status: 'approved' });
  }
  return transfer;
}

/**
 * Get paginated list of transfers.
 */
export async function getTransfers(tenantId: string, query: GetTransfersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.status) where.status = query.status;
  if (query.transferType) where.transferType = query.transferType;
  if (query.fromDoctorId) where.fromDoctorId = query.fromDoctorId;
  if (query.toDoctorId) where.toDoctorId = query.toDoctorId;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { reason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [transfers, total] = await Promise.all([
    prisma.patientTransfer.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        fromDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        toDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        fromWard: { select: { id: true, name: true } },
        toWard: { select: { id: true, name: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.patientTransfer.count({ where }),
  ]);

  return { transfers, total, page, limit };
}

/**
 * Get a single transfer by ID.
 */
export async function getTransferById(tenantId: string, id: string) {
  const transfer = await prisma.patientTransfer.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      visit: {
        select: { id: true, visitType: true, visitDate: true, status: true },
      },
      fromDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      toDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      fromBed: { select: { id: true, bedNumber: true } },
      toBed: { select: { id: true, bedNumber: true } },
      fromWard: { select: { id: true, name: true } },
      toWard: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true } },
      approver: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!transfer) {
    throw AppError.notFound('Transfer not found');
  }

  return transfer;
}

/**
 * Approve or reject a transfer.
 *
 * On approval the receiving doctor / bed / ward is actually applied to the
 * underlying records (visit, admission, appointment, bed occupancy) so the
 * patient appears in the destination's worklist. Rejection is purely a status
 * change.
 */
export async function approveTransfer(
  tenantId: string,
  id: string,
  userId: string,
  data?: { status?: 'approved' | 'rejected'; notes?: string },
) {
  const transfer = await prisma.patientTransfer.findFirst({
    where: { id, tenantId },
    include: { visit: { select: { id: true, appointmentId: true, patientId: true } } },
  });

  if (!transfer) {
    throw AppError.notFound('Transfer not found');
  }

  if (transfer.status !== 'requested') {
    throw AppError.badRequest(`Transfer has already been ${transfer.status}`);
  }

  const newStatus = data?.status ?? 'approved';

  const updated = await prisma.$transaction(async (tx) => {
    if (newStatus === 'approved') {
      switch (transfer.transferType) {
        case 'doctor_to_doctor': {
          if (!transfer.toDoctorId) {
            throw AppError.badRequest('Transfer is missing the receiving doctor');
          }
          // Reassign the visit to the receiving doctor.
          await tx.visit.update({
            where: { id: transfer.visitId },
            data: { doctorId: transfer.toDoctorId },
          });
          // Mirror onto the active admission (if IP) so the IP worklist follows.
          await tx.admission.updateMany({
            where: { visitId: transfer.visitId, tenantId },
            data: { doctorId: transfer.toDoctorId },
          });
          // Move the linked appointment so the patient surfaces on the new
          // doctor's OP list.
          if (transfer.visit?.appointmentId) {
            await tx.appointment.update({
              where: { id: transfer.visit.appointmentId },
              data: { doctorId: transfer.toDoctorId },
            });
          }
          break;
        }
        case 'ward_to_ward':
        case 'bed_to_bed': {
          const admission = await tx.admission.findFirst({
            where: { visitId: transfer.visitId, tenantId },
          });
          if (!admission) {
            throw AppError.badRequest('No active admission found for this transfer');
          }
          const admissionUpdate: { wardId?: string; bedId?: string } = {};
          if (transfer.toWardId) admissionUpdate.wardId = transfer.toWardId;
          if (transfer.toBedId) admissionUpdate.bedId = transfer.toBedId;
          if (Object.keys(admissionUpdate).length > 0) {
            await tx.admission.update({
              where: { id: admission.id },
              data: admissionUpdate,
            });
          }
          // Free the old bed and occupy the new one.
          if (transfer.fromBedId && transfer.fromBedId !== transfer.toBedId) {
            await tx.bed.update({
              where: { id: transfer.fromBedId },
              data: { status: 'available', currentPatientId: null },
            });
          }
          if (transfer.toBedId) {
            await tx.bed.update({
              where: { id: transfer.toBedId },
              data: { status: 'occupied', currentPatientId: transfer.patientId },
            });
          }
          break;
        }
      }
    }

    return tx.patientTransfer.update({
      where: { id },
      data: {
        status: newStatus,
        approvedBy: userId,
      },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        fromDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        toDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        fromWard: { select: { id: true, name: true } },
        toWard: { select: { id: true, name: true } },
      },
    });
  });

  logger.info(
    { tenantId, transferId: id, status: newStatus, type: transfer.transferType },
    'Transfer status updated',
  );
  return updated;
}

// ==================== Vitals ====================

/**
 * Record vital signs for a patient.
 * Scoped by tenant through the visit relation since Vital has no tenantId.
 *
 * Nursing owns routine vitals rounds, but the treating doctor examines the
 * patient too and may record their own reading (VITAL_RECORDER_ROLES = nurse,
 * doctor, super_admin). The route is also gated on `vitals:create`; we re-check
 * the role here because permissions can drift between tenants.
 */
export async function recordVitals(
  tenantId: string,
  userId: string,
  roles: string[],
  data: RecordVitalsInput,
) {
  assertCanWriteVitals(roles);

  // Resolve to a visitId. Nurses on OPD see confirmed appointments before the
  // doctor opens consultation, so a Visit row may not exist yet — auto-create
  // one from the appointment in that case (parallels
  // nursing-forms.resolveVisitContext).
  let resolvedVisitId: string | null = data.visitId ?? null;

  if (!resolvedVisitId && data.admissionId) {
    const adm = await prisma.admission.findFirst({
      where: { id: data.admissionId, tenantId, patientId: data.patientId },
      select: { visitId: true },
    });
    if (!adm) throw AppError.notFound('Admission not found');
    resolvedVisitId = adm.visitId;
  }

  if (!resolvedVisitId && data.appointmentId) {
    const appt = await prisma.appointment.findFirst({
      where: { id: data.appointmentId, tenantId, patientId: data.patientId },
      select: {
        id: true,
        doctorId: true,
        appointmentDate: true,
        visits: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
      },
    });
    if (!appt) throw AppError.notFound('Appointment not found');
    const existingVisitId = appt.visits[0]?.id;
    if (existingVisitId) {
      resolvedVisitId = existingVisitId;
    } else {
      const newVisit = await prisma.visit.create({
        data: {
          tenantId,
          patientId: data.patientId,
          doctorId: appt.doctorId,
          appointmentId: appt.id,
          visitType: 'op',
          visitDate: appt.appointmentDate,
          status: 'active',
        },
        select: { id: true },
      });
      resolvedVisitId = newVisit.id;
    }
  }

  if (!resolvedVisitId) {
    throw AppError.badRequest('Either visitId, admissionId, or appointmentId is required');
  }

  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: resolvedVisitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient matches the visit
  if (visit.patientId !== data.patientId) {
    throw AppError.badRequest('Patient does not match the visit');
  }

  // Calculate BMI if weight and height provided
  let bmi: number | undefined;
  if (data.weightKg && data.heightCm && data.heightCm >= 30) {
    const heightM = data.heightCm / 100;
    const rawBmi = parseFloat((data.weightKg / (heightM * heightM)).toFixed(1));
    // Clamp to Decimal(4,1) range (max 999.9) — reject obviously wrong values
    bmi = rawBmi > 0 && rawBmi < 999.9 ? rawBmi : undefined;
  }

  // Clamp decimal values to their column precision to prevent overflow
  const clamp = (val: number | undefined | null, max: number): number | undefined =>
    val != null && val > 0 && val <= max ? val : undefined;

  const vital = await prisma.vital.create({
    data: {
      visitId: resolvedVisitId,
      patientId: data.patientId,
      bloodPressureSystolic: data.bloodPressureSystolic,
      bloodPressureDiastolic: data.bloodPressureDiastolic,
      pulseRate: data.pulseRate,
      temperature: clamp(data.temperature, 999.9),         // Decimal(4,1)
      respiratoryRate: data.respiratoryRate,
      oxygenSaturation: clamp(data.oxygenSaturation, 100), // Decimal(4,1), max 100%
      weightKg: clamp(data.weightKg, 999.99),              // Decimal(5,2)
      heightCm: clamp(data.heightCm, 9999.9),              // Decimal(5,1)
      bmi,
      bloodSugar: clamp(data.bloodSugar, 9999.99),         // Decimal(6,2)
      notes: data.notes,
      recordedBy: userId,
    },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  // A reading outside the adult range is the one thing on this screen a doctor
  // needs told about — nursing takes almost every vital in the hospital and
  // nothing carried an abnormal one to the treating doctor, who found it only
  // by opening the chart. Normal readings deliberately stay silent: a bell that
  // fires on every routine round is a bell people stop reading.
  const findings = abnormalFindings({
    bloodPressureSystolic: data.bloodPressureSystolic,
    bloodPressureDiastolic: data.bloodPressureDiastolic,
    pulseRate: data.pulseRate,
    temperature: data.temperature,
    respiratoryRate: data.respiratoryRate,
    oxygenSaturation: data.oxygenSaturation,
  });
  if (findings.length > 0) {
    // `visit.doctorId` is a DoctorProfile id, not a User id.
    const doctorUserId = await doctorUserIdFromProfile(tenantId, visit.doctorId);
    // Never notify the person who just typed it — a doctor recording their own
    // examination reading does not need telling about it.
    if (doctorUserId && doctorUserId !== userId) {
      const patient = await prisma.patient.findFirst({
        where: { id: data.patientId, tenantId },
        select: { firstName: true, lastName: true, mrn: true },
      });
      const who = patient
        ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() + (patient.mrn ? ` (${patient.mrn})` : '')
        : 'A patient';
      await notifyUsers({
        tenantId,
        userIds: [doctorUserId],
        title: 'Abnormal vitals recorded',
        message: `${who}: ${findings.join(', ')}.`,
        notificationType: 'alert',
        // The doctor needs the patient, not a list of everyone's vitals.
        referenceType: 'vital_abnormal',
        referenceId: data.patientId,
      });
    }
  }

  logger.info(
    { visitId: resolvedVisitId, vitalId: vital.id, abnormal: findings.length },
    'Vitals recorded',
  );
  return vital;
}

/**
 * Get paginated vitals for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getVitals(tenantId: string, patientId: string, query: GetVitalsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const where: any = {
    patientId,
    visit: { tenantId },
    // Only rows nobody has superseded. A corrected reading and its correction
    // are the SAME observation, so listing both plots the patient twice on
    // every trend chart and shows a value that has since been amended as if it
    // still stood. The full chain stays available at /vitals/:id/history.
    correctedBy: { none: {} },
  };

  if (query.visitId) {
    where.visitId = query.visitId;
  }

  const [vitals, total] = await Promise.all([
    prisma.vital.findMany({
      where,
      skip,
      take,
      include: {
        recorder: { select: { id: true, firstName: true, lastName: true } },
        corrector: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { recordedAt: 'desc' },
    }),
    prisma.vital.count({ where }),
  ]);

  return { vitals, total, page, limit };
}

/**
 * Get all vitals for a tenant (across all patients).
 */
export async function getAllVitals(tenantId: string, query: GetAllVitalsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;

  // IST day boundaries — the ward's "today" is the local one, and a UTC cut
  // would drop the evening round into the next day.
  if ((query as any).fromDate) {
    where.recordedAt = { ...(where.recordedAt ?? {}), gte: istDayStart((query as any).fromDate) };
  }
  if ((query as any).toDate) {
    where.recordedAt = { ...(where.recordedAt ?? {}), lte: istDayEnd((query as any).toDate) };
  }

  if (query.search) {
    where.patient = {
      OR: [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { mrn: { contains: query.search, mode: 'insensitive' } },
      ],
    };
  }

  const [vitals, total] = await Promise.all([
    prisma.vital.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        recorder: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { recordedAt: 'desc' },
    }),
    prisma.vital.count({ where }),
  ]);

  return { vitals, total, page, limit };
}

/**
 * Get latest vitals for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getLatestVitals(tenantId: string, patientId: string) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const vital = await prisma.vital.findFirst({
    where: {
      patientId,
      visit: { tenantId },
      // The canonical reading is the row NOBODY has superseded — the schema
      // says so and nothing enforced it. A corrected reading and its
      // correction both sat in this query, so whichever happened to have the
      // later timestamp won and the other silently disappeared. That is what
      // made a doctor's edit look like it had overwritten the nurse's value.
      correctedBy: { none: {} },
    },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
      // Who amended it, so the reading can say so instead of presenting a
      // changed number as if it were the original.
      corrector: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
    orderBy: { recordedAt: 'desc' },
  });

  return vital;
}

/**
 * Append-only correction for a vital. Writers = the clinical recorders
 * (nurse, doctor, super_admin — VITAL_RECORDER_ROLES):
 *   1. Self-correction within the grace window by the original recorder
 *      (nurse or doctor) — in-place update, no audit row created.
 *   2. Any other correction — creates a new Vital row with supersedesVitalId,
 *      isCorrection=true, correctionReason required (append-only history).
 *   3. Non-clinical roles are rejected outright.
 */
export async function correctVital(
  tenantId: string,
  userId: string,
  roles: string[],
  vitalId: string,
  data: CorrectVitalInput,
) {
  assertCanWriteVitals(roles);

  const original = await prisma.vital.findFirst({
    where: { id: vitalId, visit: { tenantId } },
    include: { visit: { select: { tenantId: true } } },
  });
  if (!original) throw AppError.notFound('Vital not found');

  // Can't correct a row that has already been superseded — correct the newest
  // row in its chain instead to avoid ambiguous history.
  const superseder = await prisma.vital.findFirst({
    where: { supersedesVitalId: vitalId },
    select: { id: true },
  });
  if (superseder) {
    throw AppError.badRequest(
      'This reading has already been corrected. Correct the latest entry instead.',
    );
  }

  const withinGrace =
    Date.now() - original.recordedAt.getTime() <= VITAL_SELF_CORRECTION_WINDOW_MS;
  const sameRecorder = original.recordedBy === userId;
  const isCorrectiveRole = roles.some((r) => VITAL_SELF_CORRECT_ROLES.has(r));
  const canSelfCorrect = withinGrace && sameRecorder && isCorrectiveRole;

  const clamp = (val: number | undefined | null, max: number): number | undefined =>
    val != null && val > 0 && val <= max ? val : undefined;

  // Recompute BMI if weight/height are being changed.
  const nextWeight = data.weightKg ?? (Number(original.weightKg ?? 0) || undefined);
  const nextHeight = data.heightCm ?? (Number(original.heightCm ?? 0) || undefined);
  let nextBmi: number | undefined;
  if (nextWeight && nextHeight && nextHeight >= 30) {
    const heightM = nextHeight / 100;
    const raw = parseFloat((nextWeight / (heightM * heightM)).toFixed(1));
    nextBmi = raw > 0 && raw < 999.9 ? raw : undefined;
  }

  if (canSelfCorrect) {
    const updated = await prisma.vital.update({
      where: { id: vitalId },
      data: {
        bloodPressureSystolic: data.bloodPressureSystolic ?? original.bloodPressureSystolic,
        bloodPressureDiastolic: data.bloodPressureDiastolic ?? original.bloodPressureDiastolic,
        pulseRate: data.pulseRate ?? original.pulseRate,
        temperature: clamp(data.temperature, 999.9) ?? original.temperature,
        respiratoryRate: data.respiratoryRate ?? original.respiratoryRate,
        oxygenSaturation: clamp(data.oxygenSaturation, 100) ?? original.oxygenSaturation,
        weightKg: clamp(data.weightKg, 999.99) ?? original.weightKg,
        heightCm: clamp(data.heightCm, 9999.9) ?? original.heightCm,
        bmi: nextBmi ?? original.bmi,
        bloodSugar: clamp(data.bloodSugar, 9999.99) ?? original.bloodSugar,
        notes: data.notes ?? original.notes,
      },
      include: { recorder: { select: { id: true, firstName: true, lastName: true } } },
    });
    logger.info({ vitalId, userId, mode: 'self-correct-silent' }, 'Vital edited in place');
    return { mode: 'self-correct-silent', vital: updated };
  }

  // Out-of-grace or cross-role correction: create a new append-only row.
  const correction = await prisma.vital.create({
    data: {
      visitId: original.visitId,
      patientId: original.patientId,
      bloodPressureSystolic: data.bloodPressureSystolic ?? original.bloodPressureSystolic,
      bloodPressureDiastolic: data.bloodPressureDiastolic ?? original.bloodPressureDiastolic,
      pulseRate: data.pulseRate ?? original.pulseRate,
      temperature: clamp(data.temperature, 999.9) ?? original.temperature,
      respiratoryRate: data.respiratoryRate ?? original.respiratoryRate,
      oxygenSaturation: clamp(data.oxygenSaturation, 100) ?? original.oxygenSaturation,
      weightKg: clamp(data.weightKg, 999.99) ?? original.weightKg,
      heightCm: clamp(data.heightCm, 9999.9) ?? original.heightCm,
      bmi: nextBmi ?? original.bmi,
      bloodSugar: clamp(data.bloodSugar, 9999.99) ?? original.bloodSugar,
      notes: data.notes ?? original.notes,
      recordedBy: userId,
      supersedesVitalId: vitalId,
      isCorrection: true,
      correctionReason: data.correctionReason,
      correctedById: userId,
    },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
      corrector: { select: { id: true, firstName: true, lastName: true } },
      supersedes: {
        select: { id: true, recordedAt: true, recordedBy: true },
      },
    },
  });

  logger.info(
    { originalId: vitalId, newId: correction.id, userId, mode: 'audited-correction' },
    'Vital correction appended',
  );
  return { mode: 'audited-correction', vital: correction };
}

/**
 * Return the full correction chain for a vital: the ancestor (if this row is
 * itself a correction), the row, and all rows that have ever superseded it.
 * Ordered newest-first.
 */
export async function getVitalHistory(tenantId: string, vitalId: string) {
  const seed = await prisma.vital.findFirst({
    where: { id: vitalId, visit: { tenantId } },
  });
  if (!seed) throw AppError.notFound('Vital not found');

  // Walk backwards to the root.
  let rootId = seed.id;
  let cursor: { supersedesVitalId: string | null } | null = {
    supersedesVitalId: (seed as any).supersedesVitalId ?? null,
  };
  while (cursor?.supersedesVitalId) {
    rootId = cursor.supersedesVitalId;
    cursor = await prisma.vital.findFirst({
      where: { id: cursor.supersedesVitalId },
      select: { supersedesVitalId: true },
    });
  }

  // Walk forward from the root collecting the full chain.
  const chain: any[] = [];
  let current: any = await prisma.vital.findFirst({
    where: { id: rootId },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
      corrector: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  while (current) {
    chain.push(current);
    current = await prisma.vital.findFirst({
      where: { supersedesVitalId: current.id },
      include: {
        recorder: { select: { id: true, firstName: true, lastName: true } },
        corrector: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  // Newest first.
  return chain.reverse();
}

// ==================== Diagnoses ====================

/**
 * Add a diagnosis for a patient.
 * Scoped by tenant through the visit relation since Diagnosis has no tenantId.
 */
export async function addDiagnosis(tenantId: string, userId: string, data: AddDiagnosisInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient matches the visit
  if (visit.patientId !== data.patientId) {
    throw AppError.badRequest('Patient does not match the visit');
  }

  const diagnosis = await prisma.diagnosis.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      icdCode: data.icdCode,
      diagnosisName: data.diagnosisName,
      diagnosisType: data.diagnosisType ?? 'primary',
      notes: data.notes,
      diagnosedBy: userId,
    },
    include: {
      diagnoser: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
  });

  logger.info({ visitId: data.visitId, diagnosisId: diagnosis.id }, 'Diagnosis added');
  return diagnosis;
}

/**
 * Get diagnoses for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getDiagnoses(tenantId: string, patientId: string, query: GetDiagnosesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const where: any = {
    patientId,
    visit: { tenantId },
  };

  if (query.visitId) where.visitId = query.visitId;
  if (query.diagnosisType) where.diagnosisType = query.diagnosisType;

  if (query.search) {
    where.OR = [
      { diagnosisName: { contains: query.search, mode: 'insensitive' } },
      { icdCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [diagnoses, total] = await Promise.all([
    prisma.diagnosis.findMany({
      where,
      skip,
      take,
      include: {
        diagnoser: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { diagnosedAt: 'desc' },
    }),
    prisma.diagnosis.count({ where }),
  ]);

  return { diagnoses, total, page, limit };
}

/**
 * Get all diagnoses for a tenant (across all patients).
 */
export async function getAllDiagnoses(tenantId: string, query: GetAllDiagnosesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.diagnosisType) where.diagnosisType = query.diagnosisType;

  if (query.search) {
    where.OR = [
      { diagnosisName: { contains: query.search, mode: 'insensitive' } },
      { icdCode: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [diagnoses, total] = await Promise.all([
    prisma.diagnosis.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        diagnoser: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { diagnosedAt: 'desc' },
    }),
    prisma.diagnosis.count({ where }),
  ]);

  return { diagnoses, total, page, limit };
}

/**
 * Update a diagnosis.
 * Scoped by tenant through the visit relation.
 */
export async function updateDiagnosis(tenantId: string, id: string, data: UpdateDiagnosisInput) {
  const diagnosis = await prisma.diagnosis.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!diagnosis) {
    throw AppError.notFound('Diagnosis not found');
  }

  const updated = await prisma.diagnosis.update({
    where: { id },
    data: {
      ...(data.icdCode !== undefined && { icdCode: data.icdCode }),
      ...(data.diagnosisName && { diagnosisName: data.diagnosisName }),
      ...(data.diagnosisType && { diagnosisType: data.diagnosisType }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
    include: {
      diagnoser: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
  });

  logger.info({ diagnosisId: id }, 'Diagnosis updated');
  return updated;
}

/**
 * Delete a diagnosis.
 * Scoped by tenant through the visit relation.
 */
export async function deleteDiagnosis(tenantId: string, id: string) {
  const diagnosis = await prisma.diagnosis.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!diagnosis) {
    throw AppError.notFound('Diagnosis not found');
  }

  await prisma.diagnosis.delete({ where: { id } });

  logger.info({ diagnosisId: id }, 'Diagnosis deleted');
}

// ==================== OT Requests ====================

/**
 * Create an OT (Operating Theater) request.
 */
export async function createOtRequest(tenantId: string, data: CreateOtRequestInput) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify doctor belongs to tenant
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId },
  });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const otRequest = await prisma.otRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      doctorId: data.doctorId,
      procedureName: data.procedureName,
      procedureDetails: data.procedureDetails,
      urgency: data.urgency ?? 'elective',
      preferredDate: data.preferredDate ? new Date(data.preferredDate) : undefined,
      preferredTime: data.preferredTime ? new Date(`1970-01-01T${data.preferredTime}`) : undefined,
      durationMinutes: data.durationMinutes,
      requiredEquipment: data.requiredEquipment ?? undefined,
      status: 'requested',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
      visit: {
        select: { id: true, visitType: true, visitDate: true },
      },
      ot: true,
    },
  });

  logger.info({ tenantId, otRequestId: otRequest.id }, 'OT request created');
  return otRequest;
}

/**
 * Get paginated list of OT requests with filters.
 */
export async function getOtRequests(tenantId: string, query: GetOtRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.patientId) where.patientId = query.patientId;

  if (query.fromDate) {
    where.preferredDate = { ...where.preferredDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.preferredDate = { ...where.preferredDate, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { procedureName: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [otRequests, total] = await Promise.all([
    prisma.otRequest.findMany({
      where,
      skip,
      take,
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
        visit: {
          select: { id: true, visitType: true, visitDate: true },
        },
        ot: true,
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.otRequest.count({ where }),
  ]);

  return { otRequests, total, page, limit };
}

/**
 * Get a single OT request by ID.
 */
export async function getOtRequestById(tenantId: string, id: string) {
  const otRequest = await prisma.otRequest.findFirst({
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
      visit: {
        select: { id: true, visitType: true, visitDate: true, chiefComplaint: true, status: true },
      },
      ot: true,
    },
  });

  if (!otRequest) {
    throw AppError.notFound('OT request not found');
  }

  return otRequest;
}

// ==================== Reservations ====================

export async function createReservation(tenantId: string, userId: string, data: CreateReservationInput) {
  // Validate ward + (optional) bed before any writes.
  const ward = await prisma.ward.findFirst({ where: { id: data.wardId, tenantId } });
  if (!ward) throw AppError.notFound('Ward not found');

  if (data.bedId) {
    const bed = await prisma.bed.findFirst({
      where: { id: data.bedId, wardId: data.wardId, tenantId },
    });
    if (!bed) throw AppError.notFound('Bed not found in the specified ward');
    if (bed.status !== 'available') {
      throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
    }
  }

  const reservation = await prisma.$transaction(async (tx) => {
    const created = await tx.reservation.create({
      data: {
        tenantId,
        patientId: data.patientId,
        doctorId: data.doctorId,
        wardId: data.wardId,
        bedId: data.bedId,
        reservedDate: new Date(data.reservedDate),
        expectedAdmission: data.expectedAdmission ? new Date(data.expectedAdmission) : undefined,
        diagnosis: data.diagnosis,
        speciality: data.speciality,
        advanceAmount: data.advanceAmount ?? 0,
        notes: data.notes,
        createdBy: userId,
      },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    if (data.bedId) {
      // Block the bed only if still available — guard against the race where
      // another writer occupied it between the check above and this update.
      const blocked = await tx.bed.updateMany({
        where: { id: data.bedId, status: 'available' },
        data: { status: 'reserved', currentPatientId: data.patientId },
      });
      if (blocked.count === 0) {
        throw AppError.conflict('Bed was taken before the reservation could block it');
      }
    }

    return created;
  });

  logger.info({ tenantId, reservationId: reservation.id, bedId: data.bedId }, 'Reservation created');
  return reservation;
}

export async function getReservations(tenantId: string, query: GetReservationsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.wardId) where.wardId = query.wardId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { diagnosis: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  if (query.fromDate || query.toDate) {
    where.reservedDate = {};
    if (query.fromDate) where.reservedDate.gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setUTCHours(23, 59, 59, 999);
      where.reservedDate.lte = end;
    }
  }

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
      orderBy: { reservedDate: 'desc' },
    }),
    prisma.reservation.count({ where }),
  ]);

  return { reservations, total, page, limit };
}

export async function getReservationById(tenantId: string, id: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });
  if (!reservation) throw AppError.notFound('Reservation not found');
  return reservation;
}

export async function updateReservation(tenantId: string, id: string, data: UpdateReservationInput) {
  const existing = await prisma.reservation.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Reservation not found');

  const newWardId = data.wardId ?? existing.wardId;
  const newBedId = data.bedId !== undefined ? data.bedId : existing.bedId;
  const newStatus = (data.status ?? existing.status) as typeof existing.status;
  const bedChanging = newBedId !== existing.bedId;
  const releaseStatuses: (typeof existing.status)[] = ['cancelled', 'completed', 'admitted'];
  const willRelease = releaseStatuses.includes(newStatus);

  // Validate the incoming bed if the caller is moving to a new bed.
  if (bedChanging && newBedId) {
    const bed = await prisma.bed.findFirst({
      where: { id: newBedId, wardId: newWardId, tenantId },
    });
    if (!bed) throw AppError.notFound('Bed not found in the specified ward');
    if (bed.status !== 'available') {
      throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
    }
  }

  const reservation = await prisma.$transaction(async (tx) => {
    const updated = await tx.reservation.update({
      where: { id },
      data: {
        ...(data.wardId && { wardId: data.wardId }),
        ...(data.bedId !== undefined && { bedId: data.bedId }),
        ...(data.expectedAdmission && { expectedAdmission: new Date(data.expectedAdmission) }),
        ...(data.diagnosis !== undefined && { diagnosis: data.diagnosis }),
        ...(data.advanceAmount !== undefined && { advanceAmount: data.advanceAmount }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.status && { status: data.status as any }),
      },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    // Free the old bed if we're either swapping or terminating the
    // reservation. Only release it if it is still reserved for THIS patient
    // (don't undo a parallel admission that already flipped it to occupied).
    if (existing.bedId && (bedChanging || willRelease)) {
      await tx.bed.updateMany({
        where: {
          id: existing.bedId,
          status: 'reserved',
          currentPatientId: existing.patientId,
        },
        data: { status: 'available', currentPatientId: null },
      });
    }

    // Block the new bed unless the reservation is being terminated.
    if (bedChanging && newBedId && !willRelease) {
      const blocked = await tx.bed.updateMany({
        where: { id: newBedId, status: 'available' },
        data: { status: 'reserved', currentPatientId: existing.patientId },
      });
      if (blocked.count === 0) {
        throw AppError.conflict('Bed was taken before the reservation could block it');
      }
    }

    return updated;
  });

  logger.info({ tenantId, reservationId: id, status: newStatus }, 'Reservation updated');
  return reservation;
}

// ==================== Estimations ====================

export async function createEstimation(tenantId: string, userId: string, data: CreateEstimationInput) {
  const estimation = await prisma.estimation.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      complaints: data.complaints,
      estimationPeriodDays: data.estimationPeriodDays ?? 1,
      totalEstimateAmount: data.totalEstimateAmount,
      items: data.items ?? [],
      notes: data.notes,
      admissionId: data.admissionId,
      createdBy: userId,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  logger.info({ tenantId, estimationId: estimation.id }, 'Estimation created');
  return estimation;
}

export async function getEstimations(tenantId: string, query: GetEstimationsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { complaints: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setUTCHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const [estimations, total] = await Promise.all([
    prisma.estimation.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.estimation.count({ where }),
  ]);

  return { estimations, total, page, limit };
}

export async function getEstimationById(tenantId: string, id: string) {
  const estimation = await prisma.estimation.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!estimation) throw AppError.notFound('Estimation not found');
  return estimation;
}

export async function updateEstimation(tenantId: string, id: string, data: UpdateEstimationInput) {
  const existing = await prisma.estimation.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Estimation not found');

  const estimation = await prisma.estimation.update({
    where: { id },
    data: {
      ...(data.complaints !== undefined && { complaints: data.complaints }),
      ...(data.estimationPeriodDays && { estimationPeriodDays: data.estimationPeriodDays }),
      ...(data.totalEstimateAmount !== undefined && { totalEstimateAmount: data.totalEstimateAmount }),
      ...(data.items && { items: data.items }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.status && { status: data.status as any }),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  logger.info({ tenantId, estimationId: id }, 'Estimation updated');
  return estimation;
}

// ============================================================
// Clinical Orders — Unified nurse view (lab + imaging)
// ============================================================

/**
 * Shape normalised across lab and imaging so the nurse UI can render
 * them in a single table.
 */
export interface NurseClinicalOrder {
  id: string;
  orderType: 'lab' | 'imaging';
  orderNumber: string;
  status: string;
  priority: string;
  description: string;
  createdAt: Date;
  patientId: string;
  patient: { id: string; firstName: string; lastName: string; mrn: string | null } | null;
  doctor: { id: string; user: { firstName: string; lastName: string } | null } | null;
  wardId: string | null;
  ward: { id: string; name: string } | null;
  // Set when the patient marks the order done from the portal (got it done
  // elsewhere). UI shows a "Patient Uploaded" link to the upload.
  completedExternallyAt: Date | null;
  externalReportUrl: string | null;
  externalNotes: string | null;
  // Lab- / radiology-signed report. When present (and no patient upload),
  // UI shows a "Lab Report" / "Imaging Report" link instead.
  reportUrl: string | null;
  reportStatus: string | null;
}

/**
 * Fetch pending (or filtered) doctor orders across lab + imaging.
 * If `wardId` is provided we scope via the admission bound to the order's visit.
 */
export async function getClinicalOrders(
  tenantId: string,
  query: GetClinicalOrdersQuery,
  userId?: string,
) {
  const status = query.status ?? 'pending';
  const type = query.type ?? 'all';
  const limit = query.limit ?? 100;

  // Lab "pending" = status='ordered'; imaging "pending" = status='requested'.
  // Patient-completed orders (status='completed' + completedExternallyAt set)
  // stay in the "pending"/worklist feed so the nurse + doctor still see
  // them — just with a "Marked done by patient" badge. They are excluded
  // from the laboratory worklist via /lab/orders?status=ordered separately.
  const labWhere: any = { tenantId };
  const imagingWhere: any = { tenantId };

  if (status === 'pending') {
    labWhere.OR = [
      { status: 'ordered' },
      { completedExternallyAt: { not: null } },
    ];
    imagingWhere.OR = [
      { status: 'requested' },
      { completedExternallyAt: { not: null } },
    ];
  } else if (status === 'completed') {
    labWhere.status = 'completed';
    imagingWhere.status = 'completed';
  } else if (status === 'cancelled') {
    labWhere.status = 'cancelled';
    imagingWhere.status = 'cancelled';
  }

  // Ward filter resolves via admission.visitId === visitId
  if (query.wardId) {
    const admission = { some: { wardId: query.wardId, tenantId } };
    labWhere.visit = { admission };
    imagingWhere.visit = { admission };
  }

  if (query.patientId) {
    labWhere.patientId = query.patientId;
    imagingWhere.patientId = query.patientId;
  }

  // scope=mine: restrict to doctors currently assigned to the caller via
  // NurseDoctorAssignment. The orderer (User.id) on a lab/imaging order
  // belongs to a DoctorProfile, so we map User.id → DoctorProfile.id via
  // the assignment.doctorId column then back to DoctorProfile.userId for
  // the orderedBy comparison.
  if (query.scope === 'mine' && userId) {
    const assigns = await prisma.nurseDoctorAssignment.findMany({
      where: { tenantId, nurseId: userId, isActive: true },
      select: { doctorId: true },
    });
    const doctorProfileIds = assigns.map((a) => a.doctorId);
    if (doctorProfileIds.length === 0) return [] as NurseClinicalOrder[];
    const doctorUsers = await prisma.doctorProfile.findMany({
      where: { id: { in: doctorProfileIds }, tenantId },
      select: { userId: true },
    });
    const doctorUserIds: string[] = doctorUsers
      .map((d) => d.userId)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (doctorUserIds.length === 0) return [] as NurseClinicalOrder[];
    labWhere.orderedBy = { in: doctorUserIds };
    imagingWhere.orderedBy = { in: doctorUserIds };
  }

  const [labOrders, imagingOrders] = await Promise.all([
    type === 'imaging'
      ? Promise.resolve([])
      : prisma.labOrder.findMany({
          where: labWhere,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            orderer: { select: { id: true, firstName: true, lastName: true } },
            visit: {
              select: {
                id: true,
                admission: {
                  select: {
                    wardId: true,
                    ward: { select: { id: true, name: true } },
                  },
                },
              },
            },
            labOrderItems: {
              include: { test: { select: { testName: true } } },
            },
            labReport: {
              select: { id: true, status: true, pdfUrl: true, publishedAt: true },
            },
          },
        }),
    type === 'lab'
      ? Promise.resolve([])
      : prisma.imagingRequest.findMany({
          where: imagingWhere,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            orderer: { select: { id: true, firstName: true, lastName: true } },
            visit: {
              select: {
                id: true,
                admission: {
                  select: {
                    wardId: true,
                    ward: { select: { id: true, name: true } },
                  },
                },
              },
            },
            imagingResult: {
              select: { id: true, status: true, pdfReportUrl: true, signedAt: true },
            },
          },
        }),
  ]);

  const normalised: NurseClinicalOrder[] = [];

  for (const o of labOrders as any[]) {
    const testNames = (o.labOrderItems ?? [])
      .map((i: any) => i.test?.testName)
      .filter(Boolean)
      .join(', ');
    normalised.push({
      id: o.id,
      orderType: 'lab',
      orderNumber: o.id.slice(0, 8).toUpperCase(),
      status: o.status,
      priority: o.urgency,
      description: testNames || 'Lab order',
      createdAt: o.createdAt,
      patientId: o.patientId,
      patient: o.patient,
      doctor: o.orderer
        ? { id: o.orderer.id, user: { firstName: o.orderer.firstName, lastName: o.orderer.lastName } }
        : null,
      wardId: o.visit?.admission?.wardId ?? null,
      ward: o.visit?.admission?.ward ?? null,
      completedExternallyAt: o.completedExternallyAt ?? null,
      externalReportUrl: o.externalReportUrl ?? null,
      externalNotes: o.externalNotes ?? null,
      reportUrl: o.labReport?.pdfUrl ?? null,
      reportStatus: o.labReport?.status ?? null,
    });
  }

  for (const o of imagingOrders as any[]) {
    normalised.push({
      id: o.id,
      orderType: 'imaging',
      orderNumber: o.id.slice(0, 8).toUpperCase(),
      status: o.status,
      priority: o.urgency,
      description: `${o.imagingType}${o.bodyPart ? ' — ' + o.bodyPart : ''}${o.clinicalIndication ? ' (' + o.clinicalIndication + ')' : ''}`,
      createdAt: o.createdAt,
      patientId: o.patientId,
      patient: o.patient,
      doctor: o.orderer
        ? { id: o.orderer.id, user: { firstName: o.orderer.firstName, lastName: o.orderer.lastName } }
        : null,
      wardId: o.visit?.admission?.wardId ?? null,
      ward: o.visit?.admission?.ward ?? null,
      completedExternallyAt: o.completedExternallyAt ?? null,
      externalReportUrl: o.externalReportUrl ?? null,
      externalNotes: o.externalNotes ?? null,
      reportUrl: o.imagingResult?.pdfReportUrl ?? null,
      reportStatus: o.imagingResult?.status ?? null,
    });
  }

  // Sort newest-first after merging.
  normalised.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return normalised;
}

/**
 * Record nurse acknowledgment of a doctor order as a nursing note.
 * This gives us an audit trail without schema changes. The note is
 * attached to the order's visit + patient and tagged via metadata.
 */
export async function acknowledgeClinicalOrder(
  tenantId: string,
  userId: string,
  data: AcknowledgeClinicalOrderInput,
) {
  let patientId: string;
  let visitId: string;
  let description: string;

  if (data.orderType === 'lab') {
    const order = await prisma.labOrder.findFirst({
      where: { id: data.orderId, tenantId },
      select: { patientId: true, visitId: true, id: true },
    });
    if (!order) throw AppError.notFound('Lab order not found');
    patientId = order.patientId;
    visitId = order.visitId;
    description = `Lab order ${order.id.slice(0, 8).toUpperCase()}`;
  } else {
    const order = await prisma.imagingRequest.findFirst({
      where: { id: data.orderId, tenantId },
      select: { patientId: true, visitId: true, id: true, imagingType: true },
    });
    if (!order) throw AppError.notFound('Imaging request not found');
    patientId = order.patientId;
    visitId = order.visitId;
    description = `Imaging request (${order.imagingType})`;
  }

  const content = data.note?.trim()
    ? `Acknowledged ${description}. ${data.note.trim()}`
    : `Acknowledged ${description}.`;

  const note = await prisma.nursingNote.create({
    data: {
      patientId,
      visitId,
      nurseId: userId,
      noteType: 'observation',
      content,
      metadata: {
        kind: 'order_acknowledgment',
        orderType: data.orderType,
        orderId: data.orderId,
      },
    },
  });

  logger.info(
    { tenantId, orderType: data.orderType, orderId: data.orderId, noteId: note.id },
    'Clinical order acknowledged by nurse',
  );
  return { noteId: note.id, orderType: data.orderType, orderId: data.orderId };
}

/**
 * Return lab + imaging orders that are open against the caller's scope, each
 * annotated with whether a NursingNote acknowledgement exists.
 *   - scope=mine  → orders for admissions that have an active NurseAssignment to userId
 *   - scope=ward  → orders for admissions currently housed in wardId
 *   - scope=all   → every non-completed order in the tenant (supervisory views)
 */
export async function getOrderAcknowledgements(
  tenantId: string,
  userId: string,
  query: GetOrderAcknowledgementsQuery,
) {
  const limit = query.limit ?? 100;

  // Resolve the admission filter based on scope.
  let admissionIds: string[] | null = null;
  if (query.scope === 'mine') {
    const assigns = await prisma.nurseAssignment.findMany({
      where: { tenantId, nurseId: userId, status: 'active' },
      select: { admissionId: true },
    });
    admissionIds = Array.from(new Set(assigns.map((a) => a.admissionId)));
    if (admissionIds.length === 0) {
      return { orders: [], total: 0 };
    }
  } else if (query.scope === 'ward') {
    if (!query.wardId) {
      throw AppError.badRequest('wardId is required when scope=ward');
    }
    const wardAdmissions = await prisma.admission.findMany({
      where: { tenantId, wardId: query.wardId, status: ACTIVE_ADMISSION_STATUS },
      select: { id: true, visitId: true },
    });
    admissionIds = wardAdmissions.map((a) => a.id);
    if (admissionIds.length === 0) {
      return { orders: [], total: 0 };
    }
  }

  // Build the visit filter from admissions (orders are tied to visit, not admission).
  let visitIdFilter: string[] | null = null;
  if (admissionIds) {
    const admissions = await prisma.admission.findMany({
      where: { id: { in: admissionIds } },
      select: { visitId: true },
    });
    visitIdFilter = admissions.map((a) => a.visitId);
  }

  const wantLab = query.orderType === 'lab' || query.orderType === 'all';
  const wantImaging = query.orderType === 'imaging' || query.orderType === 'all';

  const [labOrders, imagingOrders] = await Promise.all([
    wantLab
      ? prisma.labOrder.findMany({
          where: {
            tenantId,
            ...(visitIdFilter ? { visitId: { in: visitIdFilter } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            visit: { select: { id: true } },
          },
        })
      : Promise.resolve([]),
    wantImaging
      ? prisma.imagingRequest.findMany({
          where: {
            tenantId,
            ...(visitIdFilter ? { visitId: { in: visitIdFilter } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            visit: { select: { id: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  // Collect ack-metadata in bulk from nursing notes (avoids N+1).
  const orderIds = [
    ...labOrders.map((o) => ({ id: o.id, type: 'lab' as const })),
    ...imagingOrders.map((o) => ({ id: o.id, type: 'imaging' as const })),
  ];

  const nurseNotes = orderIds.length
    ? await prisma.nursingNote.findMany({
        where: {
          visit: { tenantId },
          metadata: {
            path: ['kind'],
            equals: 'order_acknowledgment',
          } as any,
        },
        select: {
          id: true,
          metadata: true,
          nurseId: true,
          createdAt: true,
          nurse: { select: { id: true, firstName: true, lastName: true } },
        },
      })
    : [];

  const ackByKey = new Map<string, (typeof nurseNotes)[number]>();
  for (const note of nurseNotes) {
    const meta = (note.metadata as any) || {};
    if (meta.kind === 'order_acknowledgment' && meta.orderId && meta.orderType) {
      ackByKey.set(`${meta.orderType}:${meta.orderId}`, note);
    }
  }

  const decorate = (order: any, orderType: 'lab' | 'imaging') => {
    const ack = ackByKey.get(`${orderType}:${order.id}`) || null;
    return {
      ...order,
      orderType,
      acknowledgement: ack
        ? {
            noteId: ack.id,
            acknowledgedBy: ack.nurse,
            acknowledgedAt: ack.createdAt,
          }
        : null,
    };
  };

  const merged = [
    ...labOrders.map((o) => decorate(o, 'lab')),
    ...imagingOrders.map((o) => decorate(o, 'imaging')),
  ];

  const filtered =
    query.status === 'all'
      ? merged
      : merged.filter((o) =>
          query.status === 'acknowledged' ? !!o.acknowledgement : !o.acknowledgement,
        );

  filtered.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return { orders: filtered, total: filtered.length };
}

// ==================== Admission Requests ====================

const ADMISSION_REQUEST_INCLUDE = {
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
  doctor: {
    include: {
      user: { select: { firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  },
  visit: { select: { id: true, visitType: true, visitDate: true, chiefComplaint: true } },
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
  processedBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Who needs to know an admission request has come in. The front desk allocates
 * the bed, so they are the ones waiting on it; billing/admin see it because a
 * bed is a chargeable decision.
 */
const ADMISSION_REQUEST_RECIPIENT_ROLES = ['front_desk', 'admin', 'billing_admin'];

/**
 * Best-effort in-app notification. A notification that cannot be delivered must
 * never take the clinical action down with it — the request itself is the
 * record, and it is already saved by the time this runs.
 */
async function notifyAdmissionRequest(params: {
  tenantId: string;
  userIds: string[];
  title: string;
  message: string;
  requestId: string;
  urgent?: boolean;
}): Promise<void> {
  try {
    if (params.userIds.length === 0) return;
    await prisma.notification.createMany({
      data: params.userIds.map((userId) => ({
        tenantId: params.tenantId,
        userId,
        title: params.title,
        message: params.message,
        // An emergency admission request is not something to leave sitting in
        // the same pile as routine traffic.
        notificationType: (params.urgent ? 'alert' : 'general') as never,
        channel: 'in_app' as never,
        referenceType: 'admission_request',
        referenceId: params.requestId,
      })),
    });
  } catch (err) {
    logger.warn({ err, requestId: params.requestId }, 'Admission request notification failed');
  }
}

export async function createAdmissionRequest(
  tenantId: string,
  userId: string,
  data: CreateAdmissionRequestInput,
) {
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId },
    select: { id: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  if (data.visitId) {
    const visit = await prisma.visit.findFirst({
      where: { id: data.visitId, tenantId },
      select: { id: true },
    });
    if (!visit) throw AppError.notFound('Visit not found');
  }

  // Block stacking — one open request per (patient, doctor) is enough.
  const openRequest = await prisma.admissionRequest.findFirst({
    where: { tenantId, patientId: data.patientId, doctorId: data.doctorId, status: 'pending' },
    select: { id: true },
  });
  if (openRequest) {
    throw AppError.conflict(
      'A pending admission request already exists for this patient. Cancel it first or wait for front desk.',
    );
  }

  const request = await prisma.admissionRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      doctorId: data.doctorId,
      reason: data.reason,
      provisionalDiagnosis: data.provisionalDiagnosis,
      urgency: data.urgency ?? 'routine',
      preferredWardType: data.preferredWardType,
      expectedAdmissionDate: data.expectedAdmissionDate
        ? new Date(data.expectedAdmissionDate)
        : undefined,
      notes: data.notes,
      requestedById: userId,
    },
    include: ADMISSION_REQUEST_INCLUDE,
  });

  // Tell the front desk. The whole request lifecycle dispatched nothing at all,
  // so a doctor raising an IP request had no way to hand it over — QA found the
  // desk had to keep checking the list manually to notice one had arrived.
  const patientName = `${request.patient?.firstName ?? ''} ${request.patient?.lastName ?? ''}`.trim();
  const urgent = request.urgency === 'emergency' || request.urgency === 'urgent';
  void notifyAdmissionRequest({
    tenantId,
    userIds: await usersWithRoles(tenantId, ADMISSION_REQUEST_RECIPIENT_ROLES),
    title: urgent ? `${request.urgency === 'emergency' ? 'Emergency' : 'Urgent'} admission request` : 'New admission request',
    message:
      `${patientName || 'A patient'}${request.patient?.mrn ? ` · ${request.patient.mrn}` : ''}` +
      ` needs a bed${request.preferredWardType ? ` (${request.preferredWardType})` : ''}.` +
      `${request.reason ? ` ${request.reason}` : ''}`,
    requestId: request.id,
    urgent,
  });

  logger.info({ tenantId, admissionRequestId: request.id }, 'Admission request created');
  return request;
}

export async function getAdmissionRequests(tenantId: string, query: GetAdmissionRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.urgency) where.urgency = query.urgency;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.patientId) where.patientId = query.patientId;

  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setUTCHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { provisionalDiagnosis: { contains: query.search, mode: 'insensitive' } },
      { reason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.admissionRequest.findMany({
      where,
      skip,
      take,
      include: ADMISSION_REQUEST_INCLUDE,
      // Surface pending → most urgent → newest. Once acted on, fall back to
      // straight chronology so the audit trail reads top-down.
      orderBy: [
        { status: 'asc' },
        { urgency: 'desc' },
        { createdAt: 'desc' },
      ],
    }),
    prisma.admissionRequest.count({ where }),
  ]);

  return { requests, total, page, limit };
}

export async function getAdmissionRequestById(tenantId: string, id: string) {
  const request = await prisma.admissionRequest.findFirst({
    where: { id, tenantId },
    include: ADMISSION_REQUEST_INCLUDE,
  });
  if (!request) throw AppError.notFound('Admission request not found');
  return request;
}

export async function cancelAdmissionRequest(tenantId: string, id: string, userId: string) {
  const existing = await prisma.admissionRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Admission request not found');
  if (existing.status !== 'pending') {
    throw AppError.conflict(
      `Admission request cannot be cancelled — current status is ${existing.status}`,
    );
  }

  const updated = await prisma.admissionRequest.update({
    where: { id },
    data: { status: 'cancelled', processedById: userId, processedAt: new Date() },
    include: ADMISSION_REQUEST_INCLUDE,
  });
  logger.info({ tenantId, admissionRequestId: id, userId }, 'Admission request cancelled');
  return updated;
}

export async function rejectAdmissionRequest(
  tenantId: string,
  id: string,
  userId: string,
  data: RejectAdmissionRequestInput,
) {
  const existing = await prisma.admissionRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Admission request not found');
  if (existing.status !== 'pending') {
    throw AppError.conflict(
      `Admission request cannot be rejected — current status is ${existing.status}`,
    );
  }

  const updated = await prisma.admissionRequest.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectionReason: data.rejectionReason,
      processedById: userId,
      processedAt: new Date(),
    },
    include: ADMISSION_REQUEST_INCLUDE,
  });
  // Close the loop back to the doctor who asked. Without this they only learn
  // their request was turned down by going to look.
  if (updated.requestedById) {
    const name = `${updated.patient?.firstName ?? ''} ${updated.patient?.lastName ?? ''}`.trim();
    void notifyAdmissionRequest({
      tenantId,
      userIds: [updated.requestedById],
      title: 'Admission request declined',
      message:
        `${name || 'Your patient'} was not admitted.` +
        `${data.rejectionReason ? ` Reason: ${data.rejectionReason}` : ''}`,
      requestId: id,
      urgent: true,
    });
  }

  logger.info({ tenantId, admissionRequestId: id, userId }, 'Admission request rejected');
  return updated;
}

/**
 * Front-desk acceptance. Three branches:
 *   • `createReservation`: spins up a Reservation in the same transaction
 *     so the request tracks back to a bed-blocking record.
 *   • `directAdmit`: creates the IP Admission immediately. We pull or create
 *     a visit (request.visitId → existing active OP visit → new IP visit) so
 *     the existing Admission FK constraint is satisfied.
 *   • neither: just flips status to `accepted`; downstream flow continues
 *     manually via the regular Reservation / Admission endpoints.
 * `createReservation` and `directAdmit` are mutually exclusive — passing both
 * is a 400.
 */
export async function acceptAdmissionRequest(
  tenantId: string,
  id: string,
  userId: string,
  data: AcceptAdmissionRequestInput,
) {
  const existing = await prisma.admissionRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Admission request not found');
  if (existing.status !== 'pending') {
    throw AppError.conflict(
      `Admission request cannot be accepted — current status is ${existing.status}`,
    );
  }

  if (data.createReservation && data.directAdmit) {
    throw AppError.badRequest('Pick either reserve-now or direct-admit, not both');
  }

  // Pre-flight bed/ward checks. For a DIRECT ADMIT, bed & ward are OPTIONAL now —
  // front desk assigns them from the ledger after admitting. A RESERVATION still
  // needs a ward (its whole purpose is to hold a slot/bed), bed optional.
  if (data.createReservation) {
    if (!data.wardId) {
      throw AppError.badRequest('wardId is required when creating a reservation');
    }
    const ward = await prisma.ward.findFirst({ where: { id: data.wardId, tenantId } });
    if (!ward) throw AppError.notFound('Ward not found');
    if (data.bedId) {
      const bed = await prisma.bed.findFirst({
        where: { id: data.bedId, tenantId, ...(data.wardId ? { wardId: data.wardId } : {}) },
      });
      if (!bed) throw AppError.notFound('Bed not found in the specified ward');
      if (bed.status !== 'available') {
        throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
      }
    }
  }

  if (data.directAdmit) {
    if (data.wardId) {
      const ward = await prisma.ward.findFirst({ where: { id: data.wardId, tenantId } });
      if (!ward) throw AppError.notFound('Ward not found');
    }
    if (data.bedId) {
      const bed = await prisma.bed.findFirst({
        where: { id: data.bedId, tenantId, ...(data.wardId ? { wardId: data.wardId } : {}) },
      });
      if (!bed) throw AppError.notFound('Bed not found in the specified ward');
      // Mirror createAdmission: the bed must be free OR already held for THIS
      // patient via an existing reservation (in which case admission flips it
      // to occupied without breaking ownership).
      const heldForThisPatient =
        bed.currentPatientId === existing.patientId &&
        (bed.status === 'reserved' || bed.status === 'occupied');
      if (bed.status !== 'available' && !heldForThisPatient) {
        throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    let reservationId: string | undefined;
    let admissionId: string | undefined;

    if (data.createReservation && data.wardId) {
      const reservation = await tx.reservation.create({
        data: {
          tenantId,
          patientId: existing.patientId,
          doctorId: existing.doctorId,
          wardId: data.wardId,
          bedId: data.bedId,
          reservedDate: data.reservedDate ? new Date(data.reservedDate) : new Date(),
          expectedAdmission: data.expectedAdmission
            ? new Date(data.expectedAdmission)
            : existing.expectedAdmissionDate ?? undefined,
          diagnosis: existing.provisionalDiagnosis ?? undefined,
          advanceAmount: data.advanceAmount ?? 0,
          notes: data.notes ?? existing.notes ?? undefined,
          createdBy: userId,
        },
      });
      reservationId = reservation.id;

      if (data.bedId) {
        const blocked = await tx.bed.updateMany({
          where: { id: data.bedId, status: 'available' },
          data: { status: 'reserved', currentPatientId: existing.patientId },
        });
        if (blocked.count === 0) {
          throw AppError.conflict('Bed was taken before the reservation could block it');
        }
      }
    }

    if (data.directAdmit) {
      // Resolve the visit: prefer the request's linked visit, else any active
      // visit for the patient, else create an IP visit on the fly.
      let visitId = existing.visitId ?? null;
      let createdFreshVisit = false;
      if (!visitId) {
        const activeVisit = await tx.visit.findFirst({
          where: { tenantId, patientId: existing.patientId, status: 'active' },
          orderBy: { visitDate: 'desc' },
          select: { id: true },
        });
        if (activeVisit) visitId = activeVisit.id;
      }
      if (!visitId) {
        const newVisit = await tx.visit.create({
          data: {
            tenantId,
            patientId: existing.patientId,
            doctorId: existing.doctorId,
            visitType: 'ip',
            visitDate: data.admissionDate ? new Date(data.admissionDate) : new Date(),
            chiefComplaint: existing.reason,
            status: 'active',
          },
          select: { id: true },
        });
        visitId = newVisit.id;
        createdFreshVisit = true;
      }

      // Normalise the admission's visit to an ACTIVE, IP-typed encounter. The
      // request's linked visit is usually the OP consultation — leaving it as
      // visitType 'op' and/or status 'completed' meant the IP workspace (which
      // resolves the visit via ?status=active + prefers visitType 'ip') either
      // couldn't find it or picked a different visit, so every doctor write
      // (Rx / progress note / order) failed with "No active IP visit" or
      // "Admission does not belong to the supplied visit". Mirrors createAdmission.
      if (!createdFreshVisit) {
        await tx.visit.update({
          where: { id: visitId },
          data: { visitType: 'ip', status: 'active' },
        });
      }

      // Block any duplicate admission against the same visit (Admission.visitId
      // is unique). This realistically only fires if two front-desk users race.
      const dupe = await tx.admission.findUnique({ where: { visitId } });
      if (dupe) {
        throw AppError.conflict('This visit already has an admission');
      }

      const adm = await tx.admission.create({
        data: {
          tenantId,
          visitId,
          patientId: existing.patientId,
          doctorId: existing.doctorId,
          wardId: data.wardId ?? undefined,
          bedId: data.bedId ?? undefined,
          admissionDate: data.admissionDate ? new Date(data.admissionDate) : new Date(),
          expectedDischargeDate: data.expectedDischargeDate
            ? new Date(data.expectedDischargeDate)
            : undefined,
          admissionReason: data.admissionReason ?? existing.reason,
          depositAmount: data.depositAmount ?? data.advanceAmount ?? 0,
          status: 'admitted',
          admittedBy: userId,
        },
      });
      admissionId = adm.id;

      // Bed → occupied (only when a bed was chosen). Tolerate the "reserved for
      // this patient" pre-state.
      if (data.bedId) {
        await tx.bed.update({
          where: { id: data.bedId },
          data: { status: 'occupied', currentPatientId: existing.patientId },
        });
      }

      // Sweep up any other open reservations for this patient — they're
      // satisfied by this admission. Mirrors the cleanup in createAdmission.
      const stale = await tx.reservation.findMany({
        where: {
          tenantId,
          patientId: existing.patientId,
          status: { in: ['reserved', 'confirmed'] },
        },
        select: { id: true, bedId: true },
      });
      if (stale.length > 0) {
        await tx.reservation.updateMany({
          where: { id: { in: stale.map((r) => r.id) } },
          data: { status: 'admitted', admissionId: adm.id },
        });
        const orphanBeds = stale
          .map((r) => r.bedId)
          .filter((bid): bid is string => !!bid && bid !== data.bedId);
        if (orphanBeds.length > 0) {
          await tx.bed.updateMany({
            where: {
              id: { in: orphanBeds },
              status: 'reserved',
              currentPatientId: existing.patientId,
            },
            data: { status: 'available', currentPatientId: null },
          });
        }
      }
    }

    const updated = await tx.admissionRequest.update({
      where: { id },
      data: {
        status: 'accepted',
        reservationId,
        admissionId,
        processedById: userId,
        processedAt: new Date(),
      },
      include: ADMISSION_REQUEST_INCLUDE,
    });

    logger.info(
      { tenantId, admissionRequestId: id, userId, reservationId, admissionId },
      'Admission request accepted',
    );

    // Tell the doctor their patient has a bed. Fired outside the transaction's
    // critical path (void) — a notification must never roll back an admission.
    if (updated.requestedById) {
      const name = `${updated.patient?.firstName ?? ''} ${updated.patient?.lastName ?? ''}`.trim();
      void notifyAdmissionRequest({
        tenantId,
        userIds: [updated.requestedById],
        title: admissionId ? 'Patient admitted' : 'Bed reserved',
        message: admissionId
          ? `${name || 'Your patient'} has been admitted.`
          : `${name || 'Your patient'} has a bed reserved.`,
        requestId: id,
      });
    }

    return updated;
  });
}

/**
 * Convert an existing Reservation into an Admission. Bed defaults to the
 * reservation's blocked bed; the front desk can override (e.g. patient
 * arrives but the originally-blocked bed is now better used elsewhere) by
 * passing a different `bedId`. Visit resolution mirrors directAdmit so this
 * works for both walk-ins (no visit yet) and patients with an active OP visit.
 */
export async function admitFromReservation(
  tenantId: string,
  reservationId: string,
  userId: string,
  data: AdmitFromReservationInput,
) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, tenantId },
  });
  if (!reservation) throw AppError.notFound('Reservation not found');
  if (reservation.status === 'admitted') {
    throw AppError.conflict('Reservation is already admitted');
  }
  if (reservation.status === 'cancelled' || reservation.status === 'completed') {
    throw AppError.conflict(
      `Reservation cannot be admitted — current status is ${reservation.status}`,
    );
  }

  // A bed is OPTIONAL — if the reservation blocked one (or one is passed) we use
  // it, otherwise the patient is admitted without a bed and front desk assigns it
  // later from the ledger.
  const targetBedId = data.bedId ?? reservation.bedId ?? null;
  if (targetBedId) {
    const bed = await prisma.bed.findFirst({
      where: { id: targetBedId, tenantId, ...(reservation.wardId ? { wardId: reservation.wardId } : {}) },
    });
    if (!bed) throw AppError.notFound('Bed not found in the reservation ward');
    const heldForThisPatient =
      bed.currentPatientId === reservation.patientId &&
      (bed.status === 'reserved' || bed.status === 'occupied');
    if (bed.status !== 'available' && !heldForThisPatient) {
      throw AppError.conflict(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`);
    }
  }

  return prisma.$transaction(async (tx) => {
    let visitId: string | null = null;
    const activeVisit = await tx.visit.findFirst({
      where: { tenantId, patientId: reservation.patientId, status: 'active' },
      orderBy: { visitDate: 'desc' },
      select: { id: true, visitType: true },
    });
    if (activeVisit) {
      visitId = activeVisit.id;
      if (activeVisit.visitType !== 'ip') {
        await tx.visit.update({ where: { id: activeVisit.id }, data: { visitType: 'ip' } });
      }
    } else {
      const newVisit = await tx.visit.create({
        data: {
          tenantId,
          patientId: reservation.patientId,
          doctorId: reservation.doctorId,
          visitType: 'ip',
          visitDate: data.admissionDate ? new Date(data.admissionDate) : new Date(),
          chiefComplaint: reservation.diagnosis ?? undefined,
          status: 'active',
        },
        select: { id: true },
      });
      visitId = newVisit.id;
    }

    const dupe = await tx.admission.findUnique({ where: { visitId } });
    if (dupe) throw AppError.conflict('This visit already has an admission');

    const adm = await tx.admission.create({
      data: {
        tenantId,
        visitId,
        patientId: reservation.patientId,
        doctorId: reservation.doctorId,
        wardId: reservation.wardId ?? undefined,
        bedId: targetBedId ?? undefined,
        admissionDate: data.admissionDate ? new Date(data.admissionDate) : new Date(),
        expectedDischargeDate: data.expectedDischargeDate
          ? new Date(data.expectedDischargeDate)
          : undefined,
        admissionReason: data.admissionReason ?? reservation.diagnosis ?? undefined,
        depositAmount: data.depositAmount ?? Number(reservation.advanceAmount ?? 0),
        status: 'admitted',
        admittedBy: userId,
      },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    // Bed → occupied (tolerates the reserved-for-this-patient pre-state).
    if (targetBedId) {
      await tx.bed.update({
        where: { id: targetBedId },
        data: { status: 'occupied', currentPatientId: reservation.patientId },
      });
    }

    // Free up the originally-blocked bed if we admitted into a different one.
    if (reservation.bedId && reservation.bedId !== targetBedId) {
      await tx.bed.updateMany({
        where: {
          id: reservation.bedId,
          status: 'reserved',
          currentPatientId: reservation.patientId,
        },
        data: { status: 'available', currentPatientId: null },
      });
    }

    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: 'admitted', admissionId: adm.id },
    });

    // Close out the originating admission request, if any.
    await tx.admissionRequest.updateMany({
      where: { tenantId, reservationId: reservation.id, admissionId: null },
      data: { admissionId: adm.id },
    });

    logger.info(
      { tenantId, reservationId, admissionId: adm.id, bedId: targetBedId },
      'Reservation admitted',
    );
    return adm;
  });
}

