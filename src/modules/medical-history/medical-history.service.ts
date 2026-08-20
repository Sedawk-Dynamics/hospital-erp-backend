import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import {
  resolvePersonPatientIds,
  resolvePersonCanonicalPatientId,
} from '../../shared/patient-identity';

// ============================================================
// Personal History
// ============================================================

export interface UpsertPersonalHistoryInput {
  appetite?: string | null;
  diet?: string | null;
  sleepPattern?: string | null;
  disorders?: string | null;
  pastMedicalHistory?: string | null;
  pastSurgicalHistory?: string | null;
  exerciseHabits?: string | null;
  smokingStatus?: 'never' | 'former' | 'current' | null;
  alcoholConsumption?: 'none' | 'occasional' | 'moderate' | 'heavy' | null;
  notes?: string | null;
}

export async function getPersonalHistory(patientId: string) {
  // Personal history belongs to the human, not to the per-hospital patient
  // row. Read across every row that IS this person, newest first, so habits
  // recorded at one hospital (or by the patient in their portal) show up
  // everywhere.
  const ids = await resolvePersonPatientIds(patientId);
  const rows = await prisma.patientPersonalHistory.findMany({
    where: { patientId: { in: ids } },
    orderBy: { updatedAt: 'desc' },
    take: 1,
  });
  return rows[0] ?? null;
}

const PERSONAL_HISTORY_FIELDS = [
  'appetite',
  'diet',
  'sleepPattern',
  'disorders',
  'pastMedicalHistory',
  'pastSurgicalHistory',
  'exerciseHabits',
  'smokingStatus',
  'alcoholConsumption',
  'notes',
] as const;

/**
 * Partial merge — only the keys actually present in `data` are written.
 *
 * This record has three authors: the patient (portal), the doctor and the
 * nurse. It used to rewrite all ten columns on every save, defaulting anything
 * absent to null, so whoever saved last silently erased the other side's
 * fields — a patient updating their diet wiped the doctor's past-medical /
 * past-surgical narrative, and a doctor saving the narrative wiped the
 * patient's habits. Merging also means two people editing *different* fields
 * no longer clobber each other, even from a stale page.
 *
 * Clearing a field is still possible: send it explicitly as null or ''.
 */
export async function upsertPersonalHistory(
  patientId: string,
  userId: string,
  data: UpsertPersonalHistoryInput,
) {
  const payload: Record<string, unknown> = { updatedBy: userId };
  for (const key of PERSONAL_HISTORY_FIELDS) {
    if (data[key] === undefined) continue;
    // '' from a cleared input means "remove this", not "store an empty string".
    payload[key] = data[key] === '' ? null : data[key];
  }

  // Write to the person's canonical row so they never accumulate one
  // lifestyle record per hospital.
  const canonicalId = await resolvePersonCanonicalPatientId(patientId);
  const result = await prisma.patientPersonalHistory.upsert({
    where: { patientId: canonicalId },
    create: { patientId: canonicalId, ...payload },
    update: payload,
  });
  logger.info(
    { patientId, updatedBy: userId, fields: Object.keys(payload).filter((k) => k !== 'updatedBy') },
    'Personal history updated',
  );
  return result;
}

// ============================================================
// Medical & Surgical History (assembled read model)
// ============================================================

/**
 * Everything the doctor's "Medical & Surgical History" tab shows, in one call:
 * the past medical / surgical narrative, every diagnosis ever recorded, and
 * the consultation notes and summaries the doctors have written.
 *
 * Previously the tab only rendered the lifestyle fields (appetite, diet,
 * sleep…), so past illnesses, past surgeries, the diagnosis list and the
 * doctors' own consultation notes had no home anywhere in the history view.
 */
export async function getMedicalSurgicalHistory(tenantId: string, patientId: string) {
  const [personal, diagnoses, notes] = await Promise.all([
    // Through getPersonalHistory, not findUnique on this row.
    //
    // upsertPersonalHistory writes to the person's CANONICAL patient row so
    // they never accumulate one lifestyle record per hospital. Reading the row
    // the doctor happens to be looking at therefore misses history the moment
    // those two differ — the narrative is saved, and the tab that saved it
    // shows nothing back. The lifestyle fields on this same panel already read
    // across the person, so the two halves disagreed with each other.
    //
    // Diagnoses and notes below stay on this patientId deliberately: they are
    // this hospital's clinical record of this encounter series, not a
    // person-level fact like habits or past surgery.
    getPersonalHistory(patientId),

    // Every diagnosis on file, newest first, with the visit it came from.
    prisma.diagnosis.findMany({
      where: { patientId, visit: { tenantId } },
      orderBy: { diagnosedAt: 'desc' },
      take: 100,
      include: {
        visit: { select: { id: true, visitType: true, visitDate: true } },
        diagnoser: { select: { firstName: true, lastName: true } },
      },
    }),

    // Doctor-authored consultation notes and summaries. Archived notes are
    // excluded — an amended note is superseded, not history.
    prisma.progressNote.findMany({
      where: { patientId, status: { not: 'archived' }, visit: { tenantId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        noteType: true,
        content: true,
        impressions: true,
        conclusions: true,
        createdAt: true,
        visit: { select: { id: true, visitType: true, visitDate: true } },
        admissionId: true,
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
    }),
  ]);

  const doctorName = (u?: { firstName: string; lastName: string | null } | null) =>
    u ? `Dr. ${u.firstName} ${u.lastName ?? ''}`.trim() : null;

  return {
    pastMedicalHistory: personal?.pastMedicalHistory ?? null,
    pastSurgicalHistory: personal?.pastSurgicalHistory ?? null,
    // Chronic/known disorders already lived on the personal-history record.
    disorders: personal?.disorders ?? null,
    diagnoses: diagnoses.map((d) => ({
      id: d.id,
      diagnosisName: d.diagnosisName,
      icdCode: d.icdCode,
      diagnosisType: d.diagnosisType,
      notes: d.notes,
      recordedAt: d.diagnosedAt,
      visitType: d.visit?.visitType ?? null,
      visitDate: d.visit?.visitDate ?? null,
      doctorName: doctorName(d.diagnoser),
    })),
    consultationNotes: notes.map((n) => ({
      id: n.id,
      noteType: n.noteType,
      content: n.content,
      impressions: n.impressions,
      conclusions: n.conclusions,
      recordedAt: n.createdAt,
      visitType: n.visit?.visitType ?? null,
      visitDate: n.visit?.visitDate ?? null,
      isInpatient: !!n.admissionId,
      doctorName: doctorName(n.doctor?.user),
    })),
  };
}

// ============================================================
// Family History
// ============================================================

export interface FamilyHistoryInput {
  conditionName: string;
  relationSide: 'maternal' | 'paternal';
  relationship?: string;
  notes?: string;
}

export async function listFamilyHistory(patientId: string) {
  // Whose parents had what is a fact about the person, not about the hospital
  // that happened to record it.
  const ids = await resolvePersonPatientIds(patientId);
  return prisma.patientFamilyHistory.findMany({
    where: { patientId: { in: ids } },
    orderBy: [{ relationSide: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createFamilyHistory(
  patientId: string,
  userId: string,
  data: FamilyHistoryInput,
) {
  const canonicalId = await resolvePersonCanonicalPatientId(patientId);
  const duplicate = await prisma.patientFamilyHistory.findFirst({
    where: {
      patientId: { in: await resolvePersonPatientIds(patientId) },
      conditionName: { equals: data.conditionName, mode: 'insensitive' },
      relationSide: data.relationSide as any,
    },
  });
  if (duplicate) throw AppError.conflict('This family condition is already recorded');
  const entry = await prisma.patientFamilyHistory.create({
    data: {
      patientId: canonicalId,
      conditionName: data.conditionName,
      relationSide: data.relationSide as any,
      relationship: data.relationship,
      notes: data.notes,
      updatedBy: userId,
    },
  });
  logger.info({ patientId, entryId: entry.id }, 'Family history added');
  return entry;
}

export async function updateFamilyHistory(
  patientId: string,
  userId: string,
  id: string,
  data: Partial<FamilyHistoryInput>,
) {
  const existing = await prisma.patientFamilyHistory.findFirst({
    where: { id, patientId: { in: await resolvePersonPatientIds(patientId) } },
  });
  if (!existing) throw AppError.notFound('Family history entry not found');
  const update: any = { updatedBy: userId };
  if (data.conditionName !== undefined) update.conditionName = data.conditionName;
  if (data.relationSide !== undefined) update.relationSide = data.relationSide as any;
  if (data.relationship !== undefined) update.relationship = data.relationship;
  if (data.notes !== undefined) update.notes = data.notes;
  return prisma.patientFamilyHistory.update({ where: { id }, data: update });
}

export async function deleteFamilyHistory(patientId: string, id: string) {
  const existing = await prisma.patientFamilyHistory.findFirst({
    where: { id, patientId: { in: await resolvePersonPatientIds(patientId) } },
  });
  if (!existing) throw AppError.notFound('Family history entry not found');
  await prisma.patientFamilyHistory.delete({ where: { id } });
}

// ============================================================
// Allergies
// ============================================================

export interface AllergyInput {
  allergen: string;
  allergyType: 'drug' | 'food' | 'environmental' | 'other';
  severity?: 'mild' | 'moderate' | 'severe' | 'life_threatening';
  reaction?: string;
}

export async function listAllergies(patientId: string) {
  // An allergy recorded at one hospital MUST be visible at the next one —
  // this list drives the prescribing safety checks.
  const ids = await resolvePersonPatientIds(patientId);
  return prisma.patientAllergy.findMany({
    where: { patientId: { in: ids } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createAllergy(patientId: string, userId: string, data: AllergyInput) {
  const canonicalId = await resolvePersonCanonicalPatientId(patientId);
  const duplicate = await prisma.patientAllergy.findFirst({
    where: {
      patientId: { in: await resolvePersonPatientIds(patientId) },
      allergen: { equals: data.allergen, mode: 'insensitive' },
    },
  });
  if (duplicate) throw AppError.conflict('This allergy is already recorded');
  const allergy = await prisma.patientAllergy.create({
    data: {
      patientId: canonicalId,
      allergen: data.allergen,
      allergyType: data.allergyType as any,
      severity: (data.severity ?? null) as any,
      reaction: data.reaction,
      notedBy: userId,
    },
  });
  logger.info({ patientId, allergyId: allergy.id }, 'Allergy added');
  return allergy;
}

export async function updateAllergy(
  patientId: string,
  id: string,
  data: Partial<AllergyInput>,
) {
  const existing = await prisma.patientAllergy.findFirst({
    where: { id, patientId: { in: await resolvePersonPatientIds(patientId) } },
  });
  if (!existing) throw AppError.notFound('Allergy not found');
  const update: any = {};
  if (data.allergen !== undefined) update.allergen = data.allergen;
  if (data.allergyType !== undefined) update.allergyType = data.allergyType as any;
  if (data.severity !== undefined) update.severity = (data.severity ?? null) as any;
  if (data.reaction !== undefined) update.reaction = data.reaction;
  return prisma.patientAllergy.update({ where: { id }, data: update });
}

export async function deleteAllergy(patientId: string, id: string) {
  const existing = await prisma.patientAllergy.findFirst({
    where: { id, patientId: { in: await resolvePersonPatientIds(patientId) } },
  });
  if (!existing) throw AppError.notFound('Allergy not found');
  await prisma.patientAllergy.delete({ where: { id } });
}

// ============================================================
// Current Medications (manually tracked, doctor-editable)
// ============================================================

export interface CurrentMedicationInput {
  drugName: string;
  dosage?: string;
  frequency?: string;
  route?: string;
  startedOn?: string;
  source?: string;
  notes?: string;
  isActive?: boolean;
}

export async function listCurrentMedications(patientId: string) {
  return prisma.patientCurrentMedication.findMany({
    where: { patientId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createCurrentMedication(
  patientId: string,
  userId: string,
  data: CurrentMedicationInput,
) {
  const entry = await prisma.patientCurrentMedication.create({
    data: {
      patientId,
      drugName: data.drugName,
      dosage: data.dosage,
      frequency: data.frequency,
      route: data.route,
      startedOn: data.startedOn ? new Date(data.startedOn) : null,
      source: data.source,
      notes: data.notes,
      addedBy: userId,
      isActive: data.isActive ?? true,
    },
  });
  logger.info({ patientId, medId: entry.id }, 'Current medication added');
  return entry;
}

export async function updateCurrentMedication(
  patientId: string,
  id: string,
  data: Partial<CurrentMedicationInput>,
) {
  const existing = await prisma.patientCurrentMedication.findFirst({ where: { id, patientId } });
  if (!existing) throw AppError.notFound('Current medication not found');
  const update: any = {};
  if (data.drugName !== undefined) update.drugName = data.drugName;
  if (data.dosage !== undefined) update.dosage = data.dosage;
  if (data.frequency !== undefined) update.frequency = data.frequency;
  if (data.route !== undefined) update.route = data.route;
  if (data.startedOn !== undefined) update.startedOn = data.startedOn ? new Date(data.startedOn) : null;
  if (data.source !== undefined) update.source = data.source;
  if (data.notes !== undefined) update.notes = data.notes;
  if (data.isActive !== undefined) update.isActive = data.isActive;
  return prisma.patientCurrentMedication.update({ where: { id }, data: update });
}

export async function deleteCurrentMedication(patientId: string, id: string) {
  const existing = await prisma.patientCurrentMedication.findFirst({ where: { id, patientId } });
  if (!existing) throw AppError.notFound('Current medication not found');
  await prisma.patientCurrentMedication.delete({ where: { id } });
}

/**
 * Combined: derived current meds (from active prescriptions) + manual entries.
 */
export async function getAllCurrentMedications(patientId: string, tenantId?: string) {
  const { buildDrugHistory } = await import('../prescriptions/drug-history.service');
  const [derived, manual] = await Promise.all([
    buildDrugHistory({ patientIds: [patientId], tenantId, limit: 100 }),
    listCurrentMedications(patientId),
  ]);
  return { derived: derived.current, manual };
}

// ============================================================
// Tenant verification helper (for doctor routes)
// ============================================================

export async function verifyPatientTenant(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');
}
