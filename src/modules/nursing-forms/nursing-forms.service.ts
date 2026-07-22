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
  CreateObservationInput,
  CreateDeviceInput,
  UpdateDeviceInput,
  RemoveDeviceInput,
  CreateDeviceCheckInput,
  CreateProcedureInput,
  ListDevicesQuery,
  ListProceduresQuery,
  IOTotalsQuery,
  ListFormsQuery,
} from './nursing-forms.validation';

// Bedside charting (observations, devices, procedures) is primarily nursing
// work, but the treating doctor charts at the bedside too — they hold
// `forms:create` already, and blocking them here was the source of the 403 on
// the doctor-side charting screens. Every entry records its author.
// `super_admin` retains write access for support/data correction.
const FORM_WRITER_ROLES = new Set(['nurse', 'doctor', 'super_admin']);

function assertCanWriteForms(roles: string[]): void {
  if (!roles.some((r) => FORM_WRITER_ROLES.has(r))) {
    throw AppError.forbidden(
      'Only clinical staff (nursing or medical) can record patient charting.',
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

// Most callers know the admission id (IPD) or the appointment id (OPD), not
// the visit id. Resolve the missing side here so each form schema only has
// to require one of the three. Always validates that whatever the caller did
// pass is in the tenant + matches the patient — same guarantee
// assertVisitInTenant gives for visit-keyed callers.
//
// OPD nurses act on confirmed appointments before the doctor opens the
// consultation, so a Visit row may not exist yet. When `appointmentId` is
// passed and no Visit is attached, we create one automatically (visitType=op,
// status=active) so the form has somewhere to anchor.
async function resolveVisitContext(
  tenantId: string,
  patientId: string,
  raw: { visitId?: string; admissionId?: string; appointmentId?: string },
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
  if (raw.appointmentId) {
    const appt = await prisma.appointment.findFirst({
      where: { id: raw.appointmentId, tenantId, patientId },
      select: {
        id: true,
        doctorId: true,
        appointmentDate: true,
        visits: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
      },
    });
    if (!appt) throw AppError.notFound('Appointment not found');
    const existingVisitId = appt.visits[0]?.id;
    if (existingVisitId) return { visitId: existingVisitId };
    const visit = await prisma.visit.create({
      data: {
        tenantId,
        patientId,
        doctorId: appt.doctorId,
        appointmentId: appt.id,
        visitType: 'op',
        visitDate: appt.appointmentDate,
        status: 'active',
      },
      select: { id: true },
    });
    return { visitId: visit.id };
  }
  throw AppError.badRequest('Either visitId, admissionId, or appointmentId is required');
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
      subType: data.subType,
      color: data.color,
      frequencyCount: data.frequencyCount,
      notes: data.notes,
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  return row;
}

// Sums intake/output volume for a patient in a date window. Used by the
// charting UI's "Total intake / Total output" footer.
export async function getIntakeOutputTotals(tenantId: string, q: IOTotalsQuery) {
  const patient = await prisma.patient.findFirst({
    where: { id: q.patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const where: any = { patientId: q.patientId, visit: { tenantId } };
  if (q.visitId) where.visitId = q.visitId;
  if (q.fromDate || q.toDate) {
    where.recordDatetime = {};
    if (q.fromDate) where.recordDatetime.gte = new Date(q.fromDate);
    if (q.toDate) where.recordDatetime.lte = new Date(q.toDate);
  }

  const grouped = await prisma.intakeOutputRecord.groupBy({
    by: ['entryType', 'category'],
    where,
    _sum: { volumeMl: true },
  });

  let totalIntake = 0;
  let totalOutput = 0;
  const byCategory: Record<string, number> = {};
  for (const g of grouped) {
    const v = g._sum.volumeMl ?? 0;
    if (g.entryType === 'intake') totalIntake += v;
    else totalOutput += v;
    byCategory[`${g.entryType}:${g.category}`] = v;
  }
  return { totalIntake, totalOutput, balance: totalIntake - totalOutput, byCategory };
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

  // Charting additions — observations, active devices, recent procedures.
  const [observations, activeDevices, recentProcedures, chartingCounts] = await Promise.all([
    prisma.clinicalObservation.findMany({
      where, orderBy: { observedAt: 'desc' }, take: 10, include: nurseInclude,
    }),
    prisma.clinicalDevice.findMany({
      where: { ...where, status: 'active' },
      orderBy: { insertionTime: 'desc' },
      include: {
        inserter: { select: { id: true, firstName: true, lastName: true } },
        checks: { orderBy: { checkedAt: 'desc' }, take: 1 },
      },
    }),
    prisma.clinicalProcedure.findMany({
      where, orderBy: { performedAt: 'desc' }, take: 10, include: nurseInclude,
    }),
    Promise.all([
      prisma.clinicalObservation.count({ where }),
      prisma.clinicalDevice.count({ where }),
      prisma.clinicalProcedure.count({ where }),
    ]),
  ]);

  return {
    admissionAssessment: { latest: admission, total: counts[0] },
    pain: { recent: pain, total: counts[1] },
    fallRisk: { latest: fallRisk, total: counts[2] },
    intakeOutput: { recent: intakeOutput, total: counts[3] },
    woundCare: { recent: woundCare, total: counts[4] },
    nursingNote: { latest: nursingNote, total: counts[5] },
    observations: { recent: observations, total: chartingCounts[0] },
    devices: { active: activeDevices, total: chartingCounts[1] },
    procedures: { recent: recentProcedures, total: chartingCounts[2] },
  };
}

// ──────────────────────────────────────────────────────────
// Clinical Observation
// ──────────────────────────────────────────────────────────

export async function createObservation(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateObservationInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  const row = await prisma.clinicalObservation.create({
    data: {
      visitId,
      admissionId,
      patientId: data.patientId,
      nurseId: userId,
      observedAt: data.observedAt ? new Date(data.observedAt) : new Date(),
      painScore: data.painScore,
      painLocation: data.painLocation,
      consciousnessAvpu: data.consciousnessAvpu,
      generalCondition: data.generalCondition,
      mobility: data.mobility,
      fluidIntakeMl: data.fluidIntakeMl,
      foodIntakeNotes: data.foodIntakeNotes,
      urineOutputMl: data.urineOutputMl,
      stoolPassed: data.stoolPassed,
      stoolCount: data.stoolCount,
      notes: data.notes,
      metadata: data.metadata ?? undefined,
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
  logger.info({ id: row.id, patientId: data.patientId }, 'Clinical observation recorded');
  return row;
}

export async function listObservations(tenantId: string, query: ListFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.clinicalObservation.findMany({
      where,
      skip,
      take,
      orderBy: { observedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.clinicalObservation.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Clinical Device / Line
// ──────────────────────────────────────────────────────────

export async function createDevice(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateDeviceInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  // If linking to an existing procedure, verify it belongs to the same patient
  // and tenant — prevents a malformed payload from cross-linking records.
  if (data.createdByProcedureId) {
    const proc = await prisma.clinicalProcedure.findFirst({
      where: { id: data.createdByProcedureId, patientId: data.patientId, visit: { tenantId } },
      select: { id: true },
    });
    if (!proc) throw AppError.badRequest('Procedure not found for this patient');
  }

  const row = await prisma.clinicalDevice.create({
    data: {
      visitId,
      admissionId,
      patientId: data.patientId,
      deviceType: data.deviceType,
      deviceSubtype: data.deviceSubtype,
      site: data.site,
      insertionTime: new Date(data.insertionTime),
      insertedBy: userId,
      flowStatus: data.flowStatus,
      fluidType: data.fluidType,
      flowRateMlPerHr: data.flowRateMlPerHr,
      oxygenMode: data.oxygenMode,
      oxygenFlowRate: data.oxygenFlowRate,
      createdByProcedureId: data.createdByProcedureId,
      notes: data.notes,
      metadata: data.metadata ?? undefined,
    },
    include: {
      inserter: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  // If the device was created standalone (no parent procedure), keep the back-
  // link consistent — procedures linked here have deviceCreated=true.
  if (data.createdByProcedureId) {
    await prisma.clinicalProcedure.update({
      where: { id: data.createdByProcedureId },
      data: { deviceCreated: true },
    });
  }
  logger.info({ id: row.id, deviceType: data.deviceType }, 'Clinical device recorded');
  return row;
}

export async function listDevices(tenantId: string, query: ListDevicesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.status) where.status = query.status;
  if (query.deviceType) where.deviceType = query.deviceType;
  const [items, total] = await Promise.all([
    prisma.clinicalDevice.findMany({
      where,
      skip,
      take,
      orderBy: { insertionTime: 'desc' },
      include: {
        inserter: { select: { id: true, firstName: true, lastName: true } },
        remover: { select: { id: true, firstName: true, lastName: true } },
        checks: { orderBy: { checkedAt: 'desc' }, take: 1 },
      },
    }),
    prisma.clinicalDevice.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getDevice(tenantId: string, id: string) {
  const device = await prisma.clinicalDevice.findFirst({
    where: { id, visit: { tenantId } },
    include: {
      inserter: { select: { id: true, firstName: true, lastName: true } },
      remover: { select: { id: true, firstName: true, lastName: true } },
      createdByProcedure: true,
      checks: {
        orderBy: { checkedAt: 'desc' },
        include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });
  if (!device) throw AppError.notFound('Device not found');
  return device;
}

export async function updateDevice(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: UpdateDeviceInput,
) {
  assertCanWriteForms(roles);
  const existing = await prisma.clinicalDevice.findFirst({
    where: { id, visit: { tenantId } },
    select: { id: true, status: true },
  });
  if (!existing) throw AppError.notFound('Device not found');
  if (existing.status !== 'active') {
    throw AppError.badRequest('Cannot update a removed/replaced device');
  }
  void userId;
  const row = await prisma.clinicalDevice.update({
    where: { id },
    data: {
      deviceSubtype: data.deviceSubtype,
      site: data.site,
      flowStatus: data.flowStatus,
      fluidType: data.fluidType,
      flowRateMlPerHr: data.flowRateMlPerHr,
      oxygenMode: data.oxygenMode,
      oxygenFlowRate: data.oxygenFlowRate,
      notes: data.notes,
      metadata: data.metadata ?? undefined,
    },
  });
  return row;
}

export async function removeDevice(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: RemoveDeviceInput,
) {
  assertCanWriteForms(roles);
  const existing = await prisma.clinicalDevice.findFirst({
    where: { id, visit: { tenantId } },
    select: { id: true, status: true, notes: true },
  });
  if (!existing) throw AppError.notFound('Device not found');
  if (existing.status !== 'active') {
    throw AppError.badRequest('Device is not active');
  }
  return prisma.clinicalDevice.update({
    where: { id },
    data: {
      status: data.status,
      removalTime: data.removalTime ? new Date(data.removalTime) : new Date(),
      removedBy: userId,
      notes: data.notes ?? existing.notes,
    },
  });
}

// ──────────────────────────────────────────────────────────
// Device check (periodic monitoring)
// ──────────────────────────────────────────────────────────

export async function createDeviceCheck(
  tenantId: string,
  userId: string,
  roles: string[],
  deviceId: string,
  data: CreateDeviceCheckInput,
) {
  assertCanWriteForms(roles);
  const device = await prisma.clinicalDevice.findFirst({
    where: { id: deviceId, visit: { tenantId } },
    select: { id: true, visitId: true, patientId: true, status: true },
  });
  if (!device) throw AppError.notFound('Device not found');
  if (device.status !== 'active') {
    throw AppError.badRequest('Cannot check a removed/replaced device');
  }
  return prisma.clinicalDeviceCheck.create({
    data: {
      deviceId,
      visitId: device.visitId,
      patientId: device.patientId,
      nurseId: userId,
      checkedAt: data.checkedAt ? new Date(data.checkedAt) : new Date(),
      patency: data.patency,
      siteCondition: data.siteCondition,
      painPresent: data.painPresent,
      securement: data.securement,
      flowStatus: data.flowStatus,
      urineFlow: data.urineFlow,
      urineColor: data.urineColor,
      infectionSuspected: data.infectionSuspected,
      dislodged: data.dislodged,
      blocked: data.blocked,
      remarks: data.remarks,
      metadata: data.metadata ?? undefined,
    },
    include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
  });
}

export async function listDeviceChecks(
  tenantId: string,
  deviceId: string,
  query: any,
) {
  const device = await prisma.clinicalDevice.findFirst({
    where: { id: deviceId, visit: { tenantId } },
    select: { id: true },
  });
  if (!device) throw AppError.notFound('Device not found');
  const { skip, take, page, limit } = getPaginationParams(query);
  const [items, total] = await Promise.all([
    prisma.clinicalDeviceCheck.findMany({
      where: { deviceId },
      skip,
      take,
      orderBy: { checkedAt: 'desc' },
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.clinicalDeviceCheck.count({ where: { deviceId } }),
  ]);
  return { items, total, page, limit };
}

// ──────────────────────────────────────────────────────────
// Clinical Procedure
// ──────────────────────────────────────────────────────────

export async function createProcedure(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateProcedureInput,
) {
  assertCanWriteForms(roles);
  const { visitId, admissionId } = await resolveVisitContext(tenantId, data.patientId, data);

  // Procedure + (optional) device created in one tx so we don't end up with a
  // procedure flagged `deviceCreated=true` without a real device row, or vice
  // versa.
  return prisma.$transaction(async (tx) => {
    const proc = await tx.clinicalProcedure.create({
      data: {
        visitId,
        admissionId,
        patientId: data.patientId,
        nurseId: userId,
        procedureType: data.procedureType,
        procedureSubtype: data.procedureSubtype,
        performedAt: new Date(data.performedAt),
        site: data.site,
        side: data.side,
        status: data.status,
        attemptCount: data.attemptCount,
        asepticTechnique: data.asepticTechnique,
        equipmentUsed: data.equipmentUsed,
        complications: data.complications,
        complicationNotes: data.complicationNotes,
        tolerance: data.tolerance,
        painScore: data.painScore,
        deviceCreated: !!data.device,
        notes: data.notes,
        metadata: data.metadata ?? undefined,
      },
    });

    let device = null as any;
    if (data.device) {
      device = await tx.clinicalDevice.create({
        data: {
          visitId,
          admissionId,
          patientId: data.patientId,
          deviceType: data.device.deviceType,
          deviceSubtype: data.device.deviceSubtype,
          site: data.device.site,
          insertionTime: new Date(data.performedAt),
          insertedBy: userId,
          flowStatus: data.device.flowStatus,
          fluidType: data.device.fluidType,
          flowRateMlPerHr: data.device.flowRateMlPerHr,
          oxygenMode: data.device.oxygenMode,
          oxygenFlowRate: data.device.oxygenFlowRate,
          createdByProcedureId: proc.id,
        },
      });
    }
    return { procedure: proc, device };
  });
}

export async function listProcedures(tenantId: string, query: ListProceduresQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.visitId) where.visitId = query.visitId;
  const [items, total] = await Promise.all([
    prisma.clinicalProcedure.findMany({
      where,
      skip,
      take,
      orderBy: { performedAt: 'desc' },
      include: {
        nurse: { select: { id: true, firstName: true, lastName: true } },
        devices: { select: { id: true, deviceType: true, status: true } },
      },
    }),
    prisma.clinicalProcedure.count({ where }),
  ]);
  return { items, total, page, limit };
}

// Combined chronological feed across devices, checks, procedures and
// observations — drives the "Timeline" tab on the charting page.
export async function getChartingTimeline(tenantId: string, patientId: string, limit = 50) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const baseWhere = { patientId, visit: { tenantId } } as const;
  const [observations, devices, checks, procedures] = await Promise.all([
    prisma.clinicalObservation.findMany({
      where: baseWhere,
      orderBy: { observedAt: 'desc' },
      take: limit,
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.clinicalDevice.findMany({
      where: baseWhere,
      orderBy: { insertionTime: 'desc' },
      take: limit,
      include: { inserter: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.clinicalDeviceCheck.findMany({
      where: baseWhere,
      orderBy: { checkedAt: 'desc' },
      take: limit,
      include: {
        device: { select: { id: true, deviceType: true, site: true } },
        nurse: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.clinicalProcedure.findMany({
      where: baseWhere,
      orderBy: { performedAt: 'desc' },
      take: limit,
      include: { nurse: { select: { id: true, firstName: true, lastName: true } } },
    }),
  ]);

  type Item = { kind: string; at: Date; payload: any };
  const items: Item[] = [
    ...observations.map((o) => ({ kind: 'observation', at: o.observedAt, payload: o })),
    ...devices.map((d) => ({ kind: 'device_inserted', at: d.insertionTime, payload: d })),
    ...devices
      .filter((d) => d.removalTime)
      .map((d) => ({ kind: 'device_removed', at: d.removalTime as Date, payload: d })),
    ...checks.map((c) => ({ kind: 'device_check', at: c.checkedAt, payload: c })),
    ...procedures.map((p) => ({ kind: 'procedure', at: p.performedAt, payload: p })),
  ];
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return items.slice(0, limit);
}
