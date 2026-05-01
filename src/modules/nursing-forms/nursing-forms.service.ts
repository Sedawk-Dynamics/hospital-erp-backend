import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateAdmissionAssessmentInput,
  CreatePainAssessmentInput,
  CreateFallRiskInput,
  CreateIntakeOutputInput,
  CreateWoundCareInput,
  CreateNursingNoteInput,
  ListFormsQuery,
} from './nursing-forms.validation';

// Nursing forms are owned by the bedside nursing team (mirrors vitals).
// `super_admin` retains write access for support/data correction. Doctors,
// nurse_admin, and other clinical roles can read but never write — same
// guarantee Vitals enforces.
const FORM_WRITER_ROLES = new Set(['nurse', 'super_admin']);

function assertCanWriteForms(roles: string[]): void {
  if (!roles.some((r) => FORM_WRITER_ROLES.has(r))) {
    throw AppError.forbidden(
      'Only nursing staff can record patient forms. Doctors and managers have read-only access.',
    );
  }
}

// Visit + tenant guardrail used by every create path. Centralised so we never
// forget to verify cross-tenant access on a new form type.
async function assertVisitInTenant(tenantId: string, visitId: string, patientId: string) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, tenantId },
    select: { id: true, patientId: true },
  });
  if (!visit) throw AppError.notFound('Visit not found');
  if (visit.patientId !== patientId) {
    throw AppError.badRequest('Patient does not match the visit');
  }
}

// Most callers know the admission id, not the visit id. Resolve the missing
// side here so each form schema only has to require one of the two. Always
// validates that whatever the caller did pass is in the tenant + matches the
// patient — same guarantee assertVisitInTenant gives for visit-keyed callers.
async function resolveVisitContext(
  tenantId: string,
  patientId: string,
  raw: { visitId?: string; admissionId?: string },
): Promise<{ visitId: string; admissionId?: string }> {
  if (raw.visitId) {
    await assertVisitInTenant(tenantId, raw.visitId, patientId);
    if (raw.admissionId) {
      const adm = await prisma.admission.findFirst({
        where: { id: raw.admissionId, tenantId, visitId: raw.visitId, patientId },
        select: { id: true },
      });
      if (!adm) throw AppError.badRequest('Admission does not match visit/patient');
    }
    return { visitId: raw.visitId, admissionId: raw.admissionId };
  }
  if (raw.admissionId) {
    const adm = await prisma.admission.findFirst({
      where: { id: raw.admissionId, tenantId, patientId },
      select: { id: true, visitId: true },
    });
    if (!adm) throw AppError.notFound('Admission not found');
    return { visitId: adm.visitId, admissionId: adm.id };
  }
  throw AppError.badRequest('Either visitId or admissionId is required');
}

// ──────────────────────────────────────────────────────────
// Admission Assessment
// ──────────────────────────────────────────────────────────

export async function createAdmissionAssessment(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateAdmissionAssessmentInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  const row = await prisma.nursingAdmissionAssessment.create({
    data: {
      visitId,
      admissionId,
      patientId: data.patientId,
      nurseId: userId,
      arrivalMode: data.arrivalMode,
      consciousnessLevel: data.consciousnessLevel,
      chiefComplaint: data.chiefComplaint,
      allergies: data.allergies,
      currentMedications: data.currentMedications,
      skinCondition: data.skinCondition,
      mobility: data.mobility,
      nutritionStatus: data.nutritionStatus,
      elimination: data.elimination,
      preferredLanguage: data.preferredLanguage,
      religiousNeeds: data.religiousNeeds,
      nextOfKin: data.nextOfKin ?? undefined,
      notes: data.notes,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : new Date(),
    },
    include: {
      nurse: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  logger.info({ id: row.id, patientId: data.patientId }, 'Admission assessment recorded');
  return row;
}

export async function listAdmissionAssessments(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.nursingAdmissionAssessment.findMany({
      where,
      skip,
      take,
      orderBy: { assessedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.nursingAdmissionAssessment.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Pain Assessment
// ──────────────────────────────────────────────────────────

export async function createPainAssessment(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreatePainAssessmentInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  const row = await prisma.painAssessment.create({
    data: {
      visitId,
      admissionId,
      patientId: data.patientId,
      nurseId: userId,
      painScore: data.painScore,
      painScale: data.painScale ?? 'numeric',
      painLocation: data.painLocation,
      painCharacter: data.painCharacter,
      painOnsetAt: data.painOnsetAt ? new Date(data.painOnsetAt) : undefined,
      aggravatingFactors: data.aggravatingFactors,
      relievingFactors: data.relievingFactors,
      intervention: data.intervention,
      reassessmentDueAt: data.reassessmentDueAt ? new Date(data.reassessmentDueAt) : undefined,
      notes: data.notes,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : new Date(),
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  logger.info({ id: row.id, patientId: data.patientId, score: data.painScore }, 'Pain assessment recorded');
  return row;
}

export async function listPainAssessments(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.painAssessment.findMany({
      where,
      skip,
      take,
      orderBy: { assessedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.painAssessment.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Fall Risk (Morse)
// ──────────────────────────────────────────────────────────

// Morse banding: 0–24 low, 25–44 moderate, ≥45 high. Computed server-side
// so risk can't drift from total via a client-side rounding bug.
function classifyFallRisk(total: number): 'low' | 'moderate' | 'high' {
  if (total >= 45) return 'high';
  if (total >= 25) return 'moderate';
  return 'low';
}

export async function createFallRisk(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateFallRiskInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  const total =
    data.historyOfFalling +
    data.secondaryDiagnosis +
    data.ambulatoryAid +
    data.ivOrSalineLock +
    data.gait +
    data.mentalStatus;
  const riskLevel = classifyFallRisk(total);

  const row = await prisma.fallRiskAssessment.create({
    data: {
      visitId,
      admissionId,
      patientId: data.patientId,
      nurseId: userId,
      historyOfFalling: data.historyOfFalling,
      secondaryDiagnosis: data.secondaryDiagnosis,
      ambulatoryAid: data.ambulatoryAid,
      ivOrSalineLock: data.ivOrSalineLock,
      gait: data.gait,
      mentalStatus: data.mentalStatus,
      totalScore: total,
      riskLevel,
      intervention: data.intervention,
      notes: data.notes,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : new Date(),
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  logger.info({ id: row.id, patientId: data.patientId, total, riskLevel }, 'Fall risk recorded');
  return row;
}

export async function listFallRisks(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.fallRiskAssessment.findMany({
      where,
      skip,
      take,
      orderBy: { assessedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.fallRiskAssessment.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Intake / Output
// ──────────────────────────────────────────────────────────

export async function createIntakeOutput(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateIntakeOutputInput,
) {
  assertCanWriteForms(roles);
  const { visitId } = await resolveVisitContext(tenantId, data.patientId, data);

  const row = await prisma.intakeOutputRecord.create({
    data: {
      visitId,
      patientId: data.patientId,
      nurseId: userId,
      recordDatetime: new Date(data.recordDatetime),
      entryType: data.entryType,
      category: data.category,
      volumeMl: data.volumeMl,
      fluidDescription: data.fluidDescription,
      ivLineId: data.ivLineId,
      notes: data.notes,
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  return row;
}

export async function listIntakeOutput(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.intakeOutputRecord.findMany({
      where,
      skip,
      take,
      orderBy: { recordDatetime: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.intakeOutputRecord.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Wound Care
// ──────────────────────────────────────────────────────────

export async function createWoundCare(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateWoundCareInput,
) {
  assertCanWriteForms(roles);
  const { visitId } = await resolveVisitContext(tenantId, data.patientId, data);

  const row = await prisma.woundCareRecord.create({
    data: {
      visitId,
      patientId: data.patientId,
      nurseId: userId,
      woundLocation: data.woundLocation,
      woundType: data.woundType,
      woundStage: data.woundStage,
      lengthCm: data.lengthCm,
      widthCm: data.widthCm,
      depthCm: data.depthCm,
      exudateType: data.exudateType,
      exudateAmount: data.exudateAmount,
      dressingApplied: data.dressingApplied,
      treatmentNotes: data.treatmentNotes,
      photoUrl: data.photoUrl,
      assessedAt: new Date(data.assessedAt),
      nextAssessmentDue: data.nextAssessmentDue ? new Date(data.nextAssessmentDue) : undefined,
      status: data.status ?? 'active',
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  return row;
}

export async function listWoundCare(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.woundCareRecord.findMany({
      where,
      skip,
      take,
      orderBy: { assessedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.woundCareRecord.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Nursing Daily Note
// ──────────────────────────────────────────────────────────

export async function createNursingNote(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateNursingNoteInput,
) {
  assertCanWriteForms(roles);

  // NursingNote.visit is optional in schema, so fall back to verifying the
  // patient is in the tenant when a visit is not supplied.
  if (data.visitId) {
    await assertVisitInTenant(tenantId, data.visitId, data.patientId);
  } else {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
      select: { id: true },
    });
    if (!patient) throw AppError.notFound('Patient not found');
  }

  const row = await prisma.nursingNote.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      nurseId: userId,
      admissionId: data.admissionId,
      noteType: data.noteType ?? 'general',
      content: data.content,
      metadata: data.metadata ?? undefined,
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  return row;
}

export async function listNursingNotes(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  // NursingNote may have no visit (visitId nullable) — scope through the
  // patient's tenant in that case.
  const where: any = {
    OR: [{ visit: { tenantId } }, { visit: null, patient: { tenantId } }],
  };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.nursingNote.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.nursingNote.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Aggregate "patient summary" — one query, six form types.
// Powers the doctor's read-only Nursing Forms panel: latest entry per
// form type plus a small recent-history slice for trend display.
// ──────────────────────────────────────────────────────────

export async function getPatientFormsSummary(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const where = { patientId, visit: { tenantId } } as const;
  const nurseInclude = {
    nurse: { select: { id: true, firstName: true, lastName: true } },
  };

  const [
    admission,
    pain,
    fallRisk,
    intakeOutput,
    woundCare,
    nursingNote,
    counts,
  ] = await Promise.all([
    prisma.nursingAdmissionAssessment.findFirst({
      where, orderBy: { assessedAt: 'desc' }, include: nurseInclude,
    }),
    prisma.painAssessment.findMany({
      where, orderBy: { assessedAt: 'desc' }, take: 5, include: nurseInclude,
    }),
    prisma.fallRiskAssessment.findFirst({
      where, orderBy: { assessedAt: 'desc' }, include: nurseInclude,
    }),
    prisma.intakeOutputRecord.findMany({
      where, orderBy: { recordDatetime: 'desc' }, take: 10, include: nurseInclude,
    }),
    prisma.woundCareRecord.findMany({
      where, orderBy: { assessedAt: 'desc' }, take: 5, include: nurseInclude,
    }),
    prisma.nursingNote.findFirst({
      where: {
        patientId,
        OR: [{ visit: { tenantId } }, { visit: null, patient: { tenantId } }],
      },
      orderBy: { createdAt: 'desc' },
      include: nurseInclude,
    }),
    Promise.all([
      prisma.nursingAdmissionAssessment.count({ where }),
      prisma.painAssessment.count({ where }),
      prisma.fallRiskAssessment.count({ where }),
      prisma.intakeOutputRecord.count({ where }),
      prisma.woundCareRecord.count({ where }),
      prisma.nursingNote.count({
        where: {
          patientId,
          OR: [{ visit: { tenantId } }, { visit: null, patient: { tenantId } }],
        },
      }),
    ]),
  ]);

  return {
    admissionAssessment: { latest: admission, total: counts[0] },
    pain: { recent: pain, total: counts[1] },
    fallRisk: { latest: fallRisk, total: counts[2] },
    intakeOutput: { recent: intakeOutput, total: counts[3] },
    woundCare: { recent: woundCare, total: counts[4] },
    nursingNote: { latest: nursingNote, total: counts[5] },
  };
}
