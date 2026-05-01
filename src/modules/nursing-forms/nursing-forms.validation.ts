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

// Either visitId or admissionId must be provided. The service resolves the
// missing side via the Admission ↔ Visit join, so the nurse UI only needs to
// know whichever id it has on hand. Use `requireVisitOrAdmission` on the body.
function requireVisitOrAdmission<T extends { visitId?: string; admissionId?: string }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((d) => !!d.visitId || !!d.admissionId, {
    message: 'Either visitId or admissionId is required',
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
      patientId: z.string().uuid('Invalid patient ID'),
      recordDatetime: dateString,
      entryType: ioEntryType,
      category: ioCategory,
      volumeMl: z.number().int().min(0).max(10000),
      fluidDescription: z.string().max(255).optional(),
      ivLineId: z.string().uuid().optional(),
      notes: z.string().max(2000).optional(),
    }),
  ),
});

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

// Inferred types
export type CreateAdmissionAssessmentInput = z.infer<typeof createAdmissionAssessmentSchema>['body'];
export type CreatePainAssessmentInput = z.infer<typeof createPainAssessmentSchema>['body'];
export type CreateFallRiskInput = z.infer<typeof createFallRiskSchema>['body'];
export type CreateIntakeOutputInput = z.infer<typeof createIntakeOutputSchema>['body'];
export type CreateWoundCareInput = z.infer<typeof createWoundCareSchema>['body'];
export type CreateNursingNoteInput = z.infer<typeof createNursingNoteSchema>['body'];
export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>['query'];
