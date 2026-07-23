import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { TEMP_MRN_PREFIX, isTemporaryMrn } from '../../shared/temporary-patient';
import { generateMRN } from './patients.service';
import type {
  CreateTemporaryPatientInput,
  RegisterTemporaryPatientInput,
} from './patients.validation';

// ============================================================
// Temporary (provisional) patient — create / register-in-place / merge
// ============================================================
// A temp patient is a normal Patient row with a `TEMP-` MRN. It flows through
// the ordinary OP queue / IP admission / billing pipeline like any patient.
// When identified it is either registered in place (permanent MRN, same row) or
// merged into an existing patient (episode repointed, temp retired) — either way
// there is never a duplicate patient row.

/**
 * Every model that carries a NON-unique `patientId` scalar, resolved from the
 * Prisma DMMF once at load. The merge repoints all of them from the temp record
 * onto the target patient — clinical, pharmacy and billing alike — so nothing is
 * orphaned. Unique `patientId` columns (singleton profile rows) are skipped: a
 * temp record never has them, and repointing could collide with the target's.
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

/** Approximate DOB from an age in years (Jan 1 of the birth year). */
function dobFromAge(age?: number): Date | undefined {
  if (age == null || Number.isNaN(age)) return undefined;
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear() - age, 0, 1));
}

/**
 * Mint the next `TEMP-YYYYMMDD-NNN` MRN for the tenant. Uses the highest existing
 * suffix (not a row count) so gaps from retired/merged records never produce a
 * colliding number, with a uniqueness re-check for safety.
 */
async function generateTemporaryMrn(tenantId: string): Promise<string> {
  const dayPrefix = `${TEMP_MRN_PREFIX}${ymd(new Date())}-`;
  const latest = await prisma.patient.findFirst({
    where: { tenantId, mrn: { startsWith: dayPrefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });
  let next = 1;
  if (latest?.mrn) {
    const parsed = parseInt(latest.mrn.slice(dayPrefix.length), 10);
    if (!Number.isNaN(parsed)) next = parsed + 1;
  }
  let mrn = `${dayPrefix}${String(next).padStart(3, '0')}`;
  while (await prisma.patient.findFirst({ where: { tenantId, mrn }, select: { id: true } })) {
    next += 1;
    mrn = `${dayPrefix}${String(next).padStart(3, '0')}`;
  }
  return mrn;
}

/**
 * Create a temporary patient from whatever the front desk knows. Only a first
 * name is stored as a hard field (defaulted when blank); everything else is
 * optional. Returns a plain Patient — routing to OP (appointment) or IP
 * (admission) then happens through the normal flows, since it is a normal row.
 */
export async function createTemporaryPatient(
  tenantId: string,
  userId: string,
  data: CreateTemporaryPatientInput,
) {
  const mrn = await generateTemporaryMrn(tenantId);

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      firstName: data.firstName?.trim() || 'Temporary',
      lastName: data.lastName?.trim() || null,
      phone: data.phone?.trim() || null,
      gender: (data.gender as any) || undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : dobFromAge(data.age),
      email: data.email?.trim() || null,
      bloodGroup: data.bloodGroup || undefined,
      addressLine1: data.address?.trim() || null,
      city: data.city?.trim() || null,
      state: data.state?.trim() || null,
      postalCode: data.zipCode?.trim() || null,
      registrationSource: 'front_desk',
      notes: data.notes?.trim() || 'Temporary patient — register or connect later',
      isNew: false,
    },
    select: {
      id: true, mrn: true, firstName: true, lastName: true, phone: true,
      gender: true, dateOfBirth: true, email: true,
    },
  });

  void safeAudit({
    tenantId, userId, action: 'create', entityType: 'temporary_patient', entityId: patient.id,
    description: `Temporary patient ${mrn} created`,
    newValues: { mrn, firstName: patient.firstName },
  });
  logger.info({ tenantId, patientId: patient.id, mrn }, 'Temporary patient created');
  return patient;
}

/**
 * Register a temp record in place — issue a permanent MRN and fill the real
 * details on the SAME row. Every visit / admission / prescription / bill already
 * attached stays put; no second row is ever created.
 */
export async function registerTemporaryPatient(
  tenantId: string,
  userId: string,
  tempId: string,
  data: RegisterTemporaryPatientInput,
) {
  const temp = await prisma.patient.findFirst({
    where: { id: tempId, tenantId },
    select: { id: true, mrn: true },
  });
  if (!temp) throw AppError.notFound('Temporary patient not found');
  if (!isTemporaryMrn(temp.mrn)) {
    throw AppError.badRequest('This patient is already registered');
  }

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
      notes: `Registered from temporary record ${temp.mrn}`,
    },
    select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
  });

  void safeAudit({
    tenantId, userId, action: 'update', entityType: 'temporary_patient', entityId: tempId,
    description: `Temporary patient ${temp.mrn} registered as ${permanentMrn}`,
    oldValues: { mrn: temp.mrn }, newValues: { mrn: permanentMrn },
  });
  logger.info({ tenantId, tempId, from: temp.mrn, to: permanentMrn }, 'Temporary patient registered in place');
  return updated;
}

/**
 * Merge a temp record into an already-registered patient. Repoints every
 * non-unique `patientId` reference onto the target in one transaction, then
 * retires the temp (isActive false, MRN suffixed `-MERGED`). No duplicate row
 * survives; the temp is kept only for audit.
 */
export async function mergeTemporaryPatient(
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
  if (!temp) throw AppError.notFound('Temporary patient not found');
  if (!target) throw AppError.notFound('Target patient not found');
  if (!isTemporaryMrn(temp.mrn)) throw AppError.badRequest('Source is not a temporary patient');
  if (isTemporaryMrn(target.mrn)) throw AppError.badRequest('Target must be a registered (permanent) patient');

  const counts = await prisma.$transaction(async (tx) => {
    const moved: Record<string, number> = {};
    for (const delegate of PATIENT_REPOINT_DELEGATES) {
      const res = await (tx as any)[delegate].updateMany({
        where: { patientId: tempId },
        data: { patientId: targetPatientId },
      });
      if (res.count) moved[delegate] = res.count;
    }
    await tx.patient.update({
      where: { id: tempId },
      data: { isActive: false, mrn: `${temp.mrn}-MERGED`, notes: `Merged into ${target.mrn}` },
    });
    return moved;
  });

  void safeAudit({
    tenantId, userId, action: 'update', entityType: 'temporary_patient', entityId: targetPatientId,
    description: `Temporary patient ${temp.mrn} connected to ${target.mrn}`,
    oldValues: { tempId, tempMrn: temp.mrn },
    newValues: { targetPatientId, targetMrn: target.mrn, moved: counts },
  });
  logger.info({ tenantId, tempId, targetPatientId, moved: counts }, 'Temporary patient connected to registered patient');
  return { target, moved: counts };
}

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
    logger.warn({ err, entry: entry.entityType }, 'Temporary-patient audit write skipped');
  }
}
