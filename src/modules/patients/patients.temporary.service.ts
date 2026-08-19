import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { TEMP_MRN_PREFIX, isTemporaryMrn } from '../../shared/temporary-patient';
import { findAccountHolderByPhone } from './patients.service';
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
 * A friendly placeholder name for an unnamed temporary patient: `Temporary 1`,
 * `Temporary 2`, … The number is the next after the highest existing
 * `Temporary <n>` name for the tenant, so it reads as a simple running counter
 * (gaps from merges are ignored — the label is cosmetic, the MRN is the key).
 */
async function generateTemporaryName(tenantId: string): Promise<string> {
  const existing = await prisma.patient.findMany({
    where: { tenantId, firstName: { startsWith: 'Temporary ' } },
    select: { firstName: true },
  });
  let max = 0;
  for (const p of existing) {
    const m = /^Temporary (\d+)$/.exec(p.firstName ?? '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `Temporary ${max + 1}`;
}

/**
 * Create a temporary patient from whatever the front desk knows. Only a first
 * name is stored as a hard field (defaulted to `Temporary <n>` when blank);
 * everything else is optional.
 *
 * ALSO opens an active OP visit for them.
 *
 * A temporary patient is an ordinary `Patient` row with no flag and no access
 * restriction, so "visible only to the front desk" was never a permissions
 * problem — it is that nothing else could REFERENCE them. `LabOrder.visitId`,
 * `Prescription.visitId` and `ImagingRequest.visitId` are all non-null, so with
 * no visit on file the lab could not raise an order, the doctor could not
 * prescribe and radiology could not book a study. Not "the departments cannot
 * see them" but "there is nothing for a department to attach work to".
 *
 * The visit carries no doctor: at the door of an emergency nobody knows which
 * consultant will take the patient, and `Visit.doctorId` is nullable precisely
 * for that. It is filled in when someone picks the patient up.
 */
export async function createTemporaryPatient(
  tenantId: string,
  userId: string,
  data: CreateTemporaryPatientInput,
) {
  const mrn = await generateTemporaryMrn(tenantId);
  const fallbackName = await generateTemporaryName(tenantId);

  // Who this patient belongs under. The number on an emergency form is usually
  // the attender's — the relative who brought them in — so if it already owns
  // an account, the patient is filed under it exactly as an ordinary family
  // member would be.
  //
  // Resolve-only, never create. `create()` mints a portal account when a phone
  // matches nothing, which is right for someone registering themselves and
  // wrong here: an unidentified patient must not end up with a login account in
  // their name off the back of a relative's phone number. No match simply means
  // no linkage.
  const accountHolderId =
    data.userId ?? (await findAccountHolderByPhone(data.phone));

  // Mirrors create(): the first profile on an account is that person, anything
  // after it is somebody they are responsible for. The desk overrides this by
  // passing the actual relationship.
  let relationship = data.relationship;
  if (accountHolderId && !relationship) {
    const existingForUser = await prisma.patient.count({ where: { userId: accountHolderId } });
    relationship = existingForUser === 0 ? 'self' : 'other';
  }

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      firstName: data.firstName?.trim() || fallbackName,
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
      // The attender linkage. Without these the record was an island: it did
      // not appear under the account of the person who brought the patient in,
      // which is what QA reported.
      ...(accountHolderId ? { userId: accountHolderId } : {}),
      ...(relationship ? { relationship: relationship as never } : {}),
      ...(relationship ? { isSelf: relationship === 'self' } : {}),
    },
    select: {
      id: true, mrn: true, firstName: true, lastName: true, phone: true,
      gender: true, dateOfBirth: true, email: true,
      userId: true, relationship: true,
    },
  });

  // Open the encounter that makes them workable. Deliberately NOT fatal: an
  // emergency registration must complete even if this fails — a patient at the
  // door with a half-made record still beats a registration that refused. The
  // caller gets visitId: null and can retry.
  let visitId: string | null = null;
  try {
    const clinical = await import('../clinical/clinical.service');
    const visit = await clinical.createVisit(tenantId, {
      patientId: patient.id,
      visitType: 'op',
      visitDate: new Date().toISOString(),
      chiefComplaint: data.notes?.trim() || undefined,
    } as never);
    visitId = (visit as { id?: string })?.id ?? null;
  } catch (err) {
    logger.warn(
      { tenantId, patientId: patient.id, err },
      'Temporary patient created but its visit could not be opened',
    );
  }

  void safeAudit({
    tenantId, userId, action: 'create', entityType: 'temporary_patient', entityId: patient.id,
    description: `Temporary patient ${mrn} created`,
    newValues: { mrn, firstName: patient.firstName, visitId, userId: accountHolderId, relationship },
  });
  logger.info({ tenantId, patientId: patient.id, mrn, visitId }, 'Temporary patient created');
  return { ...patient, visitId };
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
 * After a merge, close any OPEN outpatient encounter that carries no clinical
 * work — provided at least one open encounter survives.
 *
 * Merge repoints the temporary record's visit onto the target, which is right:
 * the episode has to follow the patient. But if the target was already
 * mid-episode — they walked in this morning, and someone has just realised the
 * unconscious admission is the same person — they end up holding TWO open
 * outpatient encounters. From then on a prescription can land on one and the
 * lab order on the other, and neither view shows the whole attendance.
 *
 * Only an EMPTY encounter is closed. An encounter with a single vital, note,
 * order or bill against it is somebody's record of care and is never touched
 * automatically; if two of those collide the merge leaves both and says so in
 * the log, because picking a winner is a clinical decision.
 */
async function reconcileOpenEncounters(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
): Promise<{ closed: number; needsReview: number }> {
  const open = await tx.visit.findMany({
    where: { tenantId, patientId, status: 'active', visitType: 'op' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      _count: {
        select: {
          vitals: true,
          diagnoses: true,
          progressNotes: true,
          nursingNotes: true,
          prescriptions: true,
          labOrders: true,
          imagingRequests: true,
          bills: true,
        },
      },
    },
  });
  if (open.length <= 1) return { closed: 0, needsReview: 0 };

  const weight = (v: (typeof open)[number]) =>
    Object.values(v._count).reduce((sum, n) => sum + n, 0);

  const withWork = open.filter((v) => weight(v) > 0);
  const empty = open.filter((v) => weight(v) === 0);

  // Keep every encounter that has care recorded against it. If none has, keep
  // the oldest — it is the one the desk opened first.
  const keep = new Set(withWork.map((v) => v.id));
  if (keep.size === 0) keep.add(open[0].id);

  const toClose = empty.filter((v) => !keep.has(v.id)).map((v) => v.id);
  if (toClose.length > 0) {
    await tx.visit.updateMany({
      where: { id: { in: toClose } },
      data: { status: 'completed' },
    });
  }

  return { closed: toClose.length, needsReview: withWork.length > 1 ? withWork.length : 0 };
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

  const { moved: counts, encounters } = await prisma.$transaction(async (tx) => {
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

    // The episode has followed the patient; make sure they are not now holding
    // two open outpatient encounters for one attendance.
    const rec = await reconcileOpenEncounters(tx, tenantId, targetPatientId);

    // `moved` is a per-model count map — callers total it to say "7 records
    // moved". Encounter housekeeping is a different fact and travels beside it
    // rather than inside it.
    return { moved, encounters: rec };
  });

  void safeAudit({
    tenantId, userId, action: 'update', entityType: 'temporary_patient', entityId: targetPatientId,
    description:
      `Temporary patient ${temp.mrn} connected to ${target.mrn}` +
      (encounters.needsReview > 0
        ? ` — ${encounters.needsReview} open encounters both carry care and were left for review`
        : ''),
    oldValues: { tempId, tempMrn: temp.mrn },
    newValues: { targetPatientId, targetMrn: target.mrn, moved: counts, encounters },
  });

  // Both records had care on them, so neither could be closed automatically.
  // The merge is correct and nothing is lost, but the patient is now holding
  // two open encounters and somebody has to decide which one the rest of this
  // attendance belongs on. Logged at warn so it is not discovered weeks later
  // in an audit trail.
  if (encounters.needsReview > 0) {
    logger.warn(
      { tenantId, targetPatientId, openEncounters: encounters.needsReview },
      'Merge left multiple open encounters, both carrying care — needs a clinical decision',
    );
  }

  logger.info(
    { tenantId, tempId, targetPatientId, moved: counts, encounters },
    'Temporary patient connected to registered patient',
  );
  return { target, moved: counts, encounters };
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
