import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// Form types — covers both new models and existing nursing-care models
// (nursing notes, intake/output, wound care). The unified API lets the
// frontend hit one router for any nursing form.
export const FORM_TYPES = [
  'admission_assessment',
  'pain',
  'fall_risk',
  'intake_output',
  'wound_care',
  'nursing_note',
] as const;
export type FormType = (typeof FORM_TYPES)[number];

const dateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });

// Either visitId, admissionId, or appointmentId must be provided. The service
// resolves the missing pieces (Admission ↔ Visit join for IPD, Appointment →
// Visit lookup/creation for OPD), so the nurse UI only needs to pass whichever
// id it has on hand. Use `requireVisitOrAdmission` on the body.
function requireVisitOrAdmission<
  T extends { visitId?: string; admissionId?: string; appointmentId?: string },
>(schema: z.ZodType<T>) {
  return schema.refine((d) => !!d.visitId || !!d.admissionId || !!d.appointmentId, {
    message: 'Either visitId, admissionId, or appointmentId is required',
    path: ['visitId'],
  });
}

// ── Admission Assessment ─────────────────────────────────

export const arrivalMode = z.enum(['ambulance', 'walk_in', 'wheelchair', 'stretcher', 'other']);
export const consciousnessLevel = z.enum(['alert', 'drowsy', 'confused', 'unresponsive']);

export const createAdmissionAssessmentSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid('Invalid admission ID').optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      arrivalMode: arrivalMode.optional(),
      consciousnessLevel: consciousnessLevel.optional(),
      chiefComplaint: z.string().max(2000).optional(),
      allergies: z.string().max(2000).optional(),
      currentMedications: z.string().max(2000).optional(),
      skinCondition: z.string().max(2000).optional(),
      mobility: z.string().max(500).optional(),
      nutritionStatus: z.string().max(500).optional(),
      elimination: z.string().max(500).optional(),
      preferredLanguage: z.string().max(50).optional(),
      religiousNeeds: z.string().max(500).optional(),
      nextOfKin: z
        .object({
          name: z.string().max(100).optional(),
          relationship: z.string().max(50).optional(),
          phone: z.string().max(20).optional(),
        })
        .partial()
        .optional(),
      notes: z.string().max(4000).optional(),
      assessedAt: dateString.optional(),
    }),
  ),
});

// ── Pain Assessment ──────────────────────────────────────

export const painScale = z.enum(['numeric', 'faces', 'flacc', 'pqrst']);

export const createPainAssessmentSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      painScore: z.number().int().min(0).max(10),
      painScale: painScale.default('numeric'),
      painLocation: z.string().max(255).optional(),
      painCharacter: z.string().max(255).optional(),
      painOnsetAt: dateString.optional(),
      aggravatingFactors: z.string().max(2000).optional(),
      relievingFactors: z.string().max(2000).optional(),
      intervention: z.string().max(2000).optional(),
      reassessmentDueAt: dateString.optional(),
      notes: z.string().max(2000).optional(),
      assessedAt: dateString.optional(),
    }),
  ),
});

// ── Fall Risk (Morse) ────────────────────────────────────

// Subscores keyed to the published Morse weights so the client can render
// a "select one of these" UI without re-encoding the rules. Anything outside
// these values is rejected — keeps total/risk-level calculation deterministic.
export const createFallRiskSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      historyOfFalling: z.union([z.literal(0), z.literal(25)]),
      secondaryDiagnosis: z.union([z.literal(0), z.literal(15)]),
      ambulatoryAid: z.union([z.literal(0), z.literal(15), z.literal(30)]),
      ivOrSalineLock: z.union([z.literal(0), z.literal(20)]),
      gait: z.union([z.literal(0), z.literal(10), z.literal(20)]),
      mentalStatus: z.union([z.literal(0), z.literal(15)]),
      intervention: z.string().max(2000).optional(),
      notes: z.string().max(2000).optional(),
      assessedAt: dateString.optional(),
    }),
  ),
});

// ── Intake/Output ────────────────────────────────────────

export const ioEntryType = z.enum(['intake', 'output']);
export const ioCategory = z.enum([
  'oral',
  'iv_fluid',
  'blood_product',
  'tube_feed',
  'urine',
  'drain',
  'vomit',
  'stool',
  'other',
]);

export const createIntakeOutputSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      recordDatetime: dateString,
      entryType: ioEntryType,
      category: ioCategory,
      volumeMl: z.number().int().min(0).max(10000),
      fluidDescription: z.string().max(255).optional(),
      ivLineId: z.string().uuid().optional(),
      // Source-specific extras (urine color, drain type, vomit count …)
      subType: z.string().max(100).optional(),
      color: z.string().max(50).optional(),
      frequencyCount: z.number().int().min(0).max(100).optional(),
      notes: z.string().max(2000).optional(),
    }),
  ),
});

export const ioTotalsQuerySchema = z.object({
  query: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    fromDate: dateString.optional(),
    toDate: dateString.optional(),
  }),
});
export type IOTotalsQuery = z.infer<typeof ioTotalsQuerySchema>['query'];

// ── Wound Care ───────────────────────────────────────────

export const woundType = z.enum(['surgical', 'pressure_ulcer', 'laceration', 'burn', 'diabetic_ulcer', 'other']);
export const woundStage = z.enum(['stage_1', 'stage_2', 'stage_3', 'stage_4', 'unstageable']);
export const exudateType = z.enum(['none', 'serous', 'sanguineous', 'purulent']);
export const exudateAmount = z.enum(['none', 'scant', 'moderate', 'heavy']);
export const woundStatus = z.enum(['active', 'healing', 'healed', 'worsening']);

export const createWoundCareSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      woundLocation: z.string().min(1).max(100),
      woundType: woundType.optional(),
      woundStage: woundStage.optional(),
      lengthCm: z.number().min(0).max(999).optional(),
      widthCm: z.number().min(0).max(999).optional(),
      depthCm: z.number().min(0).max(999).optional(),
      exudateType: exudateType.optional(),
      exudateAmount: exudateAmount.optional(),
      dressingApplied: z.string().max(255).optional(),
      treatmentNotes: z.string().max(4000).optional(),
      photoUrl: z.string().url().optional(),
      assessedAt: dateString,
      nextAssessmentDue: dateString.optional(),
      status: woundStatus.default('active'),
    }),
  ),
});

// ── Nursing Daily Note ───────────────────────────────────

export const nursingNoteType = z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']);

export const createNursingNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid().optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    admissionId: z.string().uuid().optional(),
    noteType: nursingNoteType.default('general'),
    content: z.string().min(1).max(8000),
    metadata: z.record(z.string(), z.any()).optional(),
  }),
});

// ── Shared list/get schemas ──────────────────────────────

export const patientIdParamSchema = z.object({
  params: z.object({ patientId: z.string().uuid('Invalid patient ID') }),
});

export const formIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ID') }),
});

export const listFormsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
  }),
});

export const summaryQuerySchema = z.object({
  params: z.object({ patientId: z.string().uuid('Invalid patient ID') }),
});

// ── Clinical Observation ─────────────────────────────────

export const avpuLevel = z.enum(['alert', 'voice', 'pain', 'unresponsive']);
export const generalCondition = z.enum(['stable', 'critical', 'improving', 'deteriorating']);
export const mobilityLevel = z.enum(['bedridden', 'assisted', 'independent']);

export const createObservationSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid('Invalid admission ID').optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      observedAt: dateString.optional(),
      painScore: z.number().int().min(0).max(10).optional(),
      painLocation: z.string().max(255).optional(),
      consciousnessAvpu: avpuLevel.optional(),
      generalCondition: generalCondition.optional(),
      mobility: mobilityLevel.optional(),
      fluidIntakeMl: z.number().int().min(0).max(20000).optional(),
      foodIntakeNotes: z.string().max(2000).optional(),
      urineOutputMl: z.number().int().min(0).max(20000).optional(),
      stoolPassed: z.boolean().optional(),
      stoolCount: z.number().int().min(0).max(50).optional(),
      notes: z.string().max(4000).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    }),
  ),
});

// ── Clinical Device / Line ───────────────────────────────

export const clinicalDeviceType = z.enum([
  'iv_cannula',
  'central_line',
  'urinary_catheter',
  'oxygen_device',
  'drain',
  'ng_tube',
  'other',
]);
export const clinicalDeviceStatus = z.enum(['active', 'removed', 'replaced']);
export const devicePatency = z.enum(['patent', 'blocked']);
export const deviceSiteCondition = z.enum(['normal', 'redness', 'swelling', 'infection', 'leakage']);
export const deviceSecurement = z.enum(['secure', 'loose']);
export const deviceFlowStatus = z.enum(['running', 'stopped']);
export const urineFlow = z.enum(['adequate', 'reduced', 'none']);
export const urineColor = z.enum(['clear', 'yellow', 'amber', 'dark', 'bloody']);
export const oxygenMode = z.enum(['nasal_cannula', 'mask', 'venturi', 'rebreather', 'high_flow', 'none']);

export const createDeviceSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid().optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      deviceType: clinicalDeviceType,
      deviceSubtype: z.string().max(100).optional(),
      site: z.string().min(1).max(100),
      insertionTime: dateString,
      flowStatus: deviceFlowStatus.optional(),
      fluidType: z.string().max(100).optional(),
      flowRateMlPerHr: z.number().int().min(0).max(2000).optional(),
      oxygenMode: oxygenMode.optional(),
      oxygenFlowRate: z.number().min(0).max(60).optional(),
      createdByProcedureId: z.string().uuid().optional(),
      notes: z.string().max(4000).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    }),
  ),
});

export const updateDeviceSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid device ID') }),
  body: z.object({
    deviceSubtype: z.string().max(100).optional(),
    site: z.string().min(1).max(100).optional(),
    flowStatus: deviceFlowStatus.optional(),
    fluidType: z.string().max(100).optional(),
    flowRateMlPerHr: z.number().int().min(0).max(2000).optional(),
    oxygenMode: oxygenMode.optional(),
    oxygenFlowRate: z.number().min(0).max(60).optional(),
    notes: z.string().max(4000).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }),
});

export const removeDeviceSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid device ID') }),
  body: z.object({
    removalTime: dateString.optional(),
    status: z.enum(['removed', 'replaced']).default('removed'),
    notes: z.string().max(2000).optional(),
  }),
});

export const listDevicesQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    status: clinicalDeviceStatus.optional(),
    deviceType: clinicalDeviceType.optional(),
  }),
});

// ── Device Check (periodic monitoring) ───────────────────

export const createDeviceCheckSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid device ID') }),
  body: z.object({
    checkedAt: dateString.optional(),
    patency: devicePatency.optional(),
    siteCondition: deviceSiteCondition.optional(),
    painPresent: z.boolean().optional(),
    securement: deviceSecurement.optional(),
    flowStatus: deviceFlowStatus.optional(),
    urineFlow: urineFlow.optional(),
    urineColor: urineColor.optional(),
    infectionSuspected: z.boolean().optional(),
    dislodged: z.boolean().optional(),
    blocked: z.boolean().optional(),
    remarks: z.string().max(2000).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }),
});

export const listDeviceChecksQuerySchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid device ID') }),
  query: paginationSchema,
});

// ── Clinical Procedure ───────────────────────────────────

export const procedureStatus = z.enum(['successful', 'failed', 'partial']);
export const procedureSide = z.enum(['left', 'right', 'midline']);
export const procedureTolerance = z.enum(['well_tolerated', 'poorly_tolerated']);
export const procedureComplication = z.enum(['none', 'bleeding', 'pain', 'infection_risk', 'other']);

export const createProcedureSchema = z.object({
  body: requireVisitOrAdmission(
    z.object({
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid().optional(),
      appointmentId: z.string().uuid().optional(),
      patientId: z.string().uuid('Invalid patient ID'),
      procedureType: z.string().min(1).max(100),
      procedureSubtype: z.string().max(100).optional(),
      performedAt: dateString,
      site: z.string().max(100).optional(),
      side: procedureSide.optional(),
      status: procedureStatus.default('successful'),
      attemptCount: z.number().int().min(0).max(20).optional(),
      asepticTechnique: z.boolean().optional(),
      equipmentUsed: z.string().max(255).optional(),
      complications: procedureComplication.optional(),
      complicationNotes: z.string().max(2000).optional(),
      tolerance: procedureTolerance.optional(),
      painScore: z.number().int().min(0).max(10).optional(),
      // When `device` is provided, the service creates a ClinicalDevice and
      // links it back via createdByProcedureId.
      device: z
        .object({
          deviceType: clinicalDeviceType,
          deviceSubtype: z.string().max(100).optional(),
          site: z.string().min(1).max(100),
          flowStatus: deviceFlowStatus.optional(),
          fluidType: z.string().max(100).optional(),
          flowRateMlPerHr: z.number().int().min(0).max(2000).optional(),
          oxygenMode: oxygenMode.optional(),
          oxygenFlowRate: z.number().min(0).max(60).optional(),
        })
        .optional(),
      notes: z.string().max(4000).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    }),
  ),
});

export const listProceduresQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
  }),
});

// Inferred types
export type CreateAdmissionAssessmentInput = z.infer<typeof createAdmissionAssessmentSchema>['body'];
export type CreatePainAssessmentInput = z.infer<typeof createPainAssessmentSchema>['body'];
export type CreateFallRiskInput = z.infer<typeof createFallRiskSchema>['body'];
export type CreateIntakeOutputInput = z.infer<typeof createIntakeOutputSchema>['body'];
export type CreateWoundCareInput = z.infer<typeof createWoundCareSchema>['body'];
export type CreateNursingNoteInput = z.infer<typeof createNursingNoteSchema>['body'];
export type CreateObservationInput = z.infer<typeof createObservationSchema>['body'];
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>['body'];
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>['body'];
export type RemoveDeviceInput = z.infer<typeof removeDeviceSchema>['body'];
export type CreateDeviceCheckInput = z.infer<typeof createDeviceCheckSchema>['body'];
export type CreateProcedureInput = z.infer<typeof createProcedureSchema>['body'];
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>['query'];
export type ListProceduresQuery = z.infer<typeof listProceduresQuerySchema>['query'];
export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>['query'];
