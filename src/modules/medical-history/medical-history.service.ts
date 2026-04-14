import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';

// ============================================================
// Personal History
// ============================================================

export interface UpsertPersonalHistoryInput {
  appetite?: string | null;
  diet?: string | null;
  sleepPattern?: string | null;
  disorders?: string | null;
  exerciseHabits?: string | null;
  smokingStatus?: 'never' | 'former' | 'current' | null;
  alcoholConsumption?: 'none' | 'occasional' | 'moderate' | 'heavy' | null;
  notes?: string | null;
}

export async function getPersonalHistory(patientId: string) {
  return prisma.patientPersonalHistory.findUnique({ where: { patientId } });
}

export async function upsertPersonalHistory(
  patientId: string,
  userId: string,
  data: UpsertPersonalHistoryInput,
) {
  const payload: any = {
    appetite: data.appetite ?? null,
    diet: data.diet ?? null,
    sleepPattern: data.sleepPattern ?? null,
    disorders: data.disorders ?? null,
    exerciseHabits: data.exerciseHabits ?? null,
    smokingStatus: data.smokingStatus ?? null,
    alcoholConsumption: data.alcoholConsumption ?? null,
    notes: data.notes ?? null,
    updatedBy: userId,
  };
  const result = await prisma.patientPersonalHistory.upsert({
    where: { patientId },
    create: { patientId, ...payload },
    update: payload,
  });
  logger.info({ patientId, updatedBy: userId }, 'Personal history updated');
  return result;
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
  return prisma.patientFamilyHistory.findMany({
    where: { patientId },
    orderBy: [{ relationSide: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createFamilyHistory(
  patientId: string,
  userId: string,
  data: FamilyHistoryInput,
) {
  const entry = await prisma.patientFamilyHistory.create({
    data: {
      patientId,
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
  const existing = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId } });
  if (!existing) throw AppError.notFound('Family history entry not found');
  const update: any = { updatedBy: userId };
  if (data.conditionName !== undefined) update.conditionName = data.conditionName;
  if (data.relationSide !== undefined) update.relationSide = data.relationSide as any;
  if (data.relationship !== undefined) update.relationship = data.relationship;
  if (data.notes !== undefined) update.notes = data.notes;
  return prisma.patientFamilyHistory.update({ where: { id }, data: update });
}

export async function deleteFamilyHistory(patientId: string, id: string) {
  const existing = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId } });
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
  return prisma.patientAllergy.findMany({
    where: { patientId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createAllergy(patientId: string, userId: string, data: AllergyInput) {
  const duplicate = await prisma.patientAllergy.findFirst({
    where: { patientId, allergen: { equals: data.allergen, mode: 'insensitive' } },
  });
  if (duplicate) throw AppError.conflict('This allergy is already recorded');
  const allergy = await prisma.patientAllergy.create({
    data: {
      patientId,
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
  const existing = await prisma.patientAllergy.findFirst({ where: { id, patientId } });
  if (!existing) throw AppError.notFound('Allergy not found');
  const update: any = {};
  if (data.allergen !== undefined) update.allergen = data.allergen;
  if (data.allergyType !== undefined) update.allergyType = data.allergyType as any;
  if (data.severity !== undefined) update.severity = (data.severity ?? null) as any;
  if (data.reaction !== undefined) update.reaction = data.reaction;
  return prisma.patientAllergy.update({ where: { id }, data: update });
}

export async function deleteAllergy(patientId: string, id: string) {
  const existing = await prisma.patientAllergy.findFirst({ where: { id, patientId } });
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
