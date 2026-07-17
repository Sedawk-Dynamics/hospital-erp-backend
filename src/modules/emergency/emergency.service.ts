import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { EMERGENCY_MRN_PREFIX, isEmergencyMrn } from '../../shared/emergency';
import { generateMRN } from '../patients/patients.service';
import type {
  CreateEmergencyPatientInput,
  RegisterEmergencyPatientInput,
} from './emergency.validation';

// ============================================================
// Front-desk Emergency / Casualty (Golden Hour) patient flow
// ============================================================
// The front desk mints a temporary patient (MRN prefix TEMP-ER-…) for a casualty
// case and routes it as OP or IP. It then flows through the normal OP queue / IP
// admission pipeline, highlighted everywhere as "emergency". Once the patient is
// identified the temp record is either registered in place (permanent MRN) or
// connected to an already-registered patient (the whole episode is repointed and
// the temp is retired).

/**
 * Every model that carries a non-unique `patientId` scalar, resolved from the
 * Prisma DMMF once at load. The merge repoints all of them from the temp record
 * onto the permanent patient — clinical, pharmacy and billing alike — so nothing
 * about the emergency episode is orphaned. Unique `patientId` columns (singleton
 * profile records like MedicalHistory) are skipped: a temp record never has them,
 * and repointing could collide with the target's own.
 */
const PATIENT_REPOINT_DELEGATES: string[] = Prisma.dmmf.datamodel.models
  .filter((m) =>
    m.fields.some(
      (f) => f.name === 'patientId' && f.kind === 'scalar' && !f.isUnique && !f.isId,
    ),
  )
  .map((m) => m.name.charAt(0).toLowerCase() + m.name.slice(1));

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Approximate DOB from an age in years (Jan 1 of the birth year). */
function dobFromAge(age?: number): Date | undefined {
  if (age == null || Number.isNaN(age)) return undefined;
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear() - age, 0, 1));
}

/**
 * Mint the next TEMP-ER-YYYYMMDD-NNN MRN for the tenant. Uses the highest
 * existing suffix (not a row count) so gaps from retired/merged records never
 * produce a colliding number, with a uniqueness re-check for safety.
 */
async function generateEmergencyMrn(tenantId: string): Promise<string> {
  const dayPrefix = `${EMERGENCY_MRN_PREFIX}${ymd(new Date())}-`;
  const latest = await prisma.patient.findFirst({
    where: { tenantId, mrn: { startsWith: dayPrefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });
  let next = 1;
  if (latest?.mrn) {
    // Suffix is the leading numeric run after the day prefix (a merged record's
    // MRN is like TEMP-ER-YYYYMMDD-002-MERGED — parseInt stops at the dash).
    const parsed = parseInt(latest.mrn.slice(dayPrefix.length), 10);
    if (!Number.isNaN(parsed)) next = parsed + 1;
  }
  let mrn = `${dayPrefix}${String(next).padStart(3, '0')}`;
  // Race / gap safety: bump past any existing collision.
  while (await prisma.patient.findFirst({ where: { tenantId, mrn }, select: { id: true } })) {
    next += 1;
    mrn = `${dayPrefix}${String(next).padStart(3, '0')}`;
  }
  return mrn;
}

/**
 * Resolve the DoctorProfile.id used for the required Visit/Appointment FK.
 * Prefers the front desk's chosen casualty doctor; otherwise falls back to any
 * tenant doctor as a placeholder (the record can be reassigned later).
 */
async function resolveDoctorId(tenantId: string, provided?: string): Promise<string> {
  if (provided) {
    const doc = await prisma.doctorProfile.findFirst({ where: { id: provided, tenantId }, select: { id: true } });
    if (doc) return doc.id;
  }
  const fallback = await prisma.doctorProfile.findFirst({ where: { tenantId }, select: { id: true } });
  if (!fallback) {
    throw AppError.badRequest('No doctor is available to attend the emergency. Add a doctor first.');
  }
  return fallback.id;
}

// ------------------------------------------------------------
// Create — mint a temp patient and route it OP or IP
// ------------------------------------------------------------

export async function createEmergencyPatient(
  tenantId: string,
  userId: string,
  data: CreateEmergencyPatientInput,
) {
  const now = new Date();
  const mrn = await generateEmergencyMrn(tenantId);

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      firstName: data.firstName?.trim() || 'Emergency',
      lastName: data.lastName?.trim() || 'Patient',
      phone: data.phone?.trim() || null,
      gender: (data.gender as any) || undefined,
      // An exact DOB beats an approximate age.
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : dobFromAge(data.age),
      email: data.email?.trim() || null,
      addressLine1: data.address?.trim() || null,
      notes: data.notes?.trim() || 'Emergency / Casualty (Golden Hour) — temporary patient',
      isNew: false,
    },
    select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, gender: true },
  });

  const doctorId = await resolveDoctorId(tenantId, data.doctorId);
  const chiefComplaint = data.chiefComplaint?.trim() || 'Emergency / Casualty (Golden Hour)';

  let appointmentId: string | null = null;
  let admissionId: string | null = null;
  let tokenNumber: string | null = null;

  if (data.type === 'op') {
    // Mirror the front-desk walk-in: a checked-in emergency appointment that
    // shows in the OP queue immediately. The OP Visit is created lazily when the
    // doctor starts the consultation (ensureVisitForAppointment).
    const appointmentDate = new Date(now);
    appointmentDate.setUTCHours(0, 0, 0, 0);
    const startTimeDate = new Date(`1970-01-01T${hhmm(now)}:00.000Z`);
    const endTimeDate = new Date(startTimeDate.getTime() + 15 * 60 * 1000);

    const appointment = await prisma.appointment.create({
      data: {
        tenantId,
        patientId: patient.id,
        doctorId,
        appointmentDate,
        startTime: startTimeDate,
        endTime: endTimeDate,
        appointmentType: 'walk_in',
        consultationType: 'emergency',
        priority: 'emergency',
        visitType: 'new',
        reason: chiefComplaint,
        status: 'checked_in',
        bookedBy: userId,
      },
      select: { id: true },
    });
    appointmentId = appointment.id;

    // Best-effort queue token so the case carries a number in the OP queue.
    try {
      const queueDate = new Date(now);
      queueDate.setUTCHours(0, 0, 0, 0);
      const todaysTokens = await prisma.queueToken.count({
        where: { tenantId, doctorId, queueDate },
      });
      const token = await prisma.queueToken.create({
        data: {
          tenantId,
          patientId: patient.id,
          doctorId,
          appointmentId: appointment.id,
          tokenNumber: String(todaysTokens + 1),
          queueDate,
          status: 'checked_in',
          checkInTime: now,
        },
        select: { tokenNumber: true },
      });
      tokenNumber = token.tokenNumber;
    } catch (err) {
      logger.warn({ err, tenantId, patientId: patient.id }, 'Emergency OP queue token skipped');
    }
  } else {
    // IP: open a live IP admission on the spot. Bed/ward/attending are optional
    // (a "pending-placement" admission) — the Admission columns are nullable
    // specifically for this Golden-Hour case.
    const admission = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.create({
        data: {
          tenantId,
          patientId: patient.id,
          doctorId,
          visitType: 'ip',
          visitDate: now,
          status: 'active',
          chiefComplaint,
        },
        select: { id: true },
      });
      const adm = await tx.admission.create({
        data: {
          tenantId,
          visitId: visit.id,
          patientId: patient.id,
          // Only stamp the attending on the admission if the front desk actually
          // chose one; a placeholder doctor stays off the admission (pending).
          doctorId: data.doctorId ?? null,
          wardId: data.wardId ?? null,
          bedId: data.bedId ?? null,
          admissionDate: now,
          status: 'admitted',
          admittedBy: userId,
          billingCategory: data.billingCategory ?? 'cash',
          admissionReason: chiefComplaint,
        },
        select: { id: true },
      });
      // Occupy the bed if one was chosen at intake.
      if (data.bedId) {
        await tx.bed.updateMany({
          where: { id: data.bedId, tenantId },
          data: { status: 'occupied', currentPatientId: patient.id },
        });
      }
      return adm;
    });
    admissionId = admission.id;
  }

  logger.info(
    { tenantId, patientId: patient.id, mrn, type: data.type, appointmentId, admissionId },
    'Emergency patient created',
  );

  void safeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'emergency_patient',
    entityId: patient.id,
    description: `Emergency ${data.type.toUpperCase()} patient ${mrn} created`,
    newValues: { type: data.type, mrn, appointmentId, admissionId },
  });

  return { ...patient, type: data.type, appointmentId, admissionId, tokenNumber };
}

// ------------------------------------------------------------
// List — active temp emergency patients + their held charges
// ------------------------------------------------------------

export async function listEmergencyPatients(tenantId: string) {
  const patients = await prisma.patient.findMany({
    where: { tenantId, isActive: true, mrn: { startsWith: EMERGENCY_MRN_PREFIX } },
    select: {
      id: true,
      mrn: true,
      firstName: true,
      lastName: true,
      phone: true,
      gender: true,
      dateOfBirth: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const ids = patients.map((p) => p.id);
  if (!ids.length) return { items: [], total: 0 };

  const [bills, admissions, appointments] = await Promise.all([
    prisma.bill.groupBy({
      by: ['patientId'],
      where: { tenantId, patientId: { in: ids }, status: { not: 'cancelled' } },
      _sum: { totalAmount: true, balanceDue: true },
      _count: { _all: true },
    }),
    prisma.admission.findMany({
      where: { tenantId, patientId: { in: ids }, status: 'admitted' },
      select: {
        id: true,
        patientId: true,
        status: true,
        admissionDate: true,
        ward: { select: { name: true } },
        bed: { select: { bedNumber: true } },
      },
      orderBy: { admissionDate: 'desc' },
    }),
    prisma.appointment.findMany({
      where: { tenantId, patientId: { in: ids } },
      select: { id: true, patientId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const billByPatient = new Map(bills.map((b) => [b.patientId, b]));
  const admByPatient = new Map<string, (typeof admissions)[number]>();
  for (const a of admissions) if (!admByPatient.has(a.patientId)) admByPatient.set(a.patientId, a);
  const apptByPatient = new Map<string, (typeof appointments)[number]>();
  for (const a of appointments) if (!apptByPatient.has(a.patientId)) apptByPatient.set(a.patientId, a);

  const items = patients.map((p) => {
    const bill = billByPatient.get(p.id);
    const adm = admByPatient.get(p.id);
    const appt = apptByPatient.get(p.id);
    return {
      ...p,
      type: adm ? ('ip' as const) : ('op' as const),
      admissionId: adm?.id ?? null,
      admissionStatus: adm?.status ?? null,
      ward: adm?.ward?.name ?? null,
      bed: adm?.bed?.bedNumber ?? null,
      appointmentId: appt?.id ?? null,
      appointmentStatus: appt?.status ?? null,
      billCount: bill?._count._all ?? 0,
      heldAmount: Number(bill?._sum.totalAmount ?? 0),
      balanceDue: Number(bill?._sum.balanceDue ?? 0),
    };
  });
  return { items, total: items.length };
}

// ------------------------------------------------------------
// Register — convert the temp record into a permanent patient in place
// ------------------------------------------------------------

export async function registerEmergencyPatient(
  tenantId: string,
  userId: string,
  tempId: string,
  data: RegisterEmergencyPatientInput,
) {
  const temp = await prisma.patient.findFirst({
    where: { id: tempId, tenantId },
    select: { id: true, mrn: true },
  });
  if (!temp) throw AppError.notFound('Emergency patient not found');
  if (!isEmergencyMrn(temp.mrn)) {
    throw AppError.badRequest('This is not a temporary emergency patient');
  }

  // Issue a permanent MRN; everything already attached to this record (visits,
  // admission, prescriptions, orders, bills) stays put — it is the same row.
  const permanentMrn = await generateMRN(tenantId);

  const updated = await prisma.patient.update({
    where: { id: tempId },
    data: {
      mrn: permanentMrn,
      firstName: data.firstName.trim(),
      lastName: data.lastName?.trim() || null,
      gender: (data.gender as any) || undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      phone: data.phone?.trim() || undefined,
      email: data.email?.trim() || undefined,
      bloodGroup: data.bloodGroup || undefined,
      addressLine1: data.address?.trim() || undefined,
      city: data.city?.trim() || undefined,
      state: data.state?.trim() || undefined,
      postalCode: data.zipCode?.trim() || undefined,
      registrationSource: 'front_desk',
      notes: `Registered from emergency record ${temp.mrn}`,
    },
    select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
  });

  void safeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'emergency_patient',
    entityId: tempId,
    description: `Emergency patient ${temp.mrn} registered as ${permanentMrn}`,
    oldValues: { mrn: temp.mrn },
    newValues: { mrn: permanentMrn },
  });

  logger.info({ tenantId, tempId, from: temp.mrn, to: permanentMrn }, 'Emergency patient registered in place');
  return updated;
}

// ------------------------------------------------------------
// Merge — connect the temp record to an existing registered patient
// ------------------------------------------------------------

export async function mergeEmergencyPatient(
  tenantId: string,
  userId: string,
  tempId: string,
  targetPatientId: string,
) {
  if (tempId === targetPatientId) throw AppError.badRequest('Cannot merge a patient into itself');

  const [temp, target] = await Promise.all([
    prisma.patient.findFirst({ where: { id: tempId, tenantId }, select: { id: true, mrn: true } }),
    prisma.patient.findFirst({ where: { id: targetPatientId, tenantId }, select: { id: true, mrn: true } }),
  ]);
  if (!temp) throw AppError.notFound('Emergency patient not found');
  if (!target) throw AppError.notFound('Target patient not found');
  if (!isEmergencyMrn(temp.mrn)) throw AppError.badRequest('Source is not a temporary emergency patient');
  if (isEmergencyMrn(target.mrn)) throw AppError.badRequest('Target must be a permanent (registered) patient');

  const counts = await prisma.$transaction(async (tx) => {
    const moved: Record<string, number> = {};
    for (const delegate of PATIENT_REPOINT_DELEGATES) {
      const res = await (tx as any)[delegate].updateMany({
        where: { patientId: tempId },
        data: { patientId: targetPatientId },
      });
      if (res.count) moved[delegate] = res.count;
    }
    // Retire the temp record (kept for audit; flagged inactive + MRN suffixed).
    await tx.patient.update({
      where: { id: tempId },
      data: { isActive: false, mrn: `${temp.mrn}-MERGED`, notes: `Merged into ${target.mrn}` },
    });
    return moved;
  });

  void safeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'emergency_patient',
    entityId: targetPatientId,
    description: `Emergency patient ${temp.mrn} connected to ${target.mrn}`,
    oldValues: { tempId, tempMrn: temp.mrn },
    newValues: { targetPatientId, targetMrn: target.mrn, moved: counts },
  });

  logger.info({ tenantId, tempId, targetPatientId, moved: counts }, 'Emergency patient connected to registered patient');
  return { target, moved: counts };
}

// ------------------------------------------------------------
// Audit helper (never blocks the main flow)
// ------------------------------------------------------------

async function safeAudit(entry: {
  tenantId: string;
  userId: string;
  action: 'create' | 'update';
  entityType: string;
  entityId: string;
  description: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        description: entry.description,
        oldValues: (entry.oldValues as any) ?? undefined,
        newValues: (entry.newValues as any) ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, entry: entry.entityType }, 'Emergency audit write skipped');
  }
}
