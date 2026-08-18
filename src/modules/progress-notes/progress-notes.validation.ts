import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// --- Progress Note Schemas ---

const progressNoteTypeEnum = z.enum([
  'complaint',
  'vitals',
  'investigation',
  'discussion',
  'impression',
  'advice',
  'general',
]);

const customFieldSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(5000).optional().default(''),
});

// SOAP fields accept a record of string→any; the frontend SOAP
// form enforces detailed shape, server stores as JSON verbatim.
const soapSchema = z.record(z.string(), z.any());

// Pin sections — covers IP discharge sections AND OP consultation summary
// sections. The latter were added when the consultation form switched from
// a single bulk discharge-pin block to per-section pin toggles.
const dischargeSectionEnum = z.enum([
  'diagnosis',
  'hospital_course',
  'procedure',
  'medication',
  'follow_up',
  'advice',
  'general',
  'chief_complaint',
  'examination',
  'investigation',
  'impression',
]);

const pinInputSchema = z.object({
  dischargeSection: dischargeSectionEnum,
  content: z.string().min(1).max(10000),
});

export const createProgressNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    admissionId: z.string().uuid('Invalid admission ID').optional().nullable(),
    patientId: z.string().uuid('Invalid patient ID'),
    // Optional: link this note to a prescription so prescription viewers see it.
    prescriptionId: z.string().uuid('Invalid prescription ID').optional().nullable(),
    noteType: progressNoteTypeEnum.optional(),
    content: z.string().min(1, 'Content is required').max(10000),
    impressions: z.string().max(10000).optional().nullable(),
    discussions: z.string().max(10000).optional().nullable(),
    conclusions: z.string().max(10000).optional().nullable(),
    subjective: soapSchema.optional().nullable(),
    objective: soapSchema.optional().nullable(),
    assessment: soapSchema.optional().nullable(),
    plan: soapSchema.optional().nullable(),
    customFields: z.array(customFieldSchema).max(50).optional(),
    weightKgAtEntry: z.number().positive().max(999.99).optional().nullable(),
    pinToDischargeSummary: z.boolean().default(false),
    pins: z.array(pinInputSchema).max(20).optional(),
    // @mentioned doctors (User ids) — each gets a notification linking to the patient.
    mentionedUserIds: z.array(z.string().uuid()).max(20).optional(),
  }),
});

export const updateProgressNoteSchema = z.object({
  body: z.object({
    noteType: progressNoteTypeEnum.optional(),
    content: z.string().min(1).max(10000).optional(),
    impressions: z.string().max(10000).optional().nullable(),
    discussions: z.string().max(10000).optional().nullable(),
    conclusions: z.string().max(10000).optional().nullable(),
    subjective: soapSchema.optional().nullable(),
    objective: soapSchema.optional().nullable(),
    assessment: soapSchema.optional().nullable(),
    plan: soapSchema.optional().nullable(),
    customFields: z.array(customFieldSchema).max(50).optional(),
    weightKgAtEntry: z.number().positive().max(999.99).optional().nullable(),
    pinToDischargeSummary: z.boolean().optional(),
    pins: z.array(pinInputSchema).max(20).optional(),
    // Reason for the amendment. Required by service when note is signed/locked
    // or was previously unlocked; always stored on each ProgressNoteAmendment row.
    amendmentReason: z.string().min(1).max(2000).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

export const listProgressNotesSchema = z.object({
  query: paginationSchema.extend({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    noteType: progressNoteTypeEnum.optional(),
    status: z.enum(['active', 'finalized', 'archived']).optional(),
    includeArchived: z
      .union([z.boolean(), z.string()])
      .transform((v) => v === true || v === 'true')
      .optional(),
  }),
});

// --- Progress Note Template Schemas ---

const templateFieldSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'textarea', 'number']).default('text'),
  defaultValue: z.string().max(1000).optional(),
});

export const createProgressNoteTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    fields: z.array(templateFieldSchema).min(1).max(50),
    isDefault: z.boolean().optional().default(false),
  }),
});

export const updateProgressNoteTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120).optional(),
    fields: z.array(templateFieldSchema).min(1).max(50).optional(),
    isDefault: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid template ID'),
  }),
});

export const templateIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid template ID'),
  }),
});

export const progressNoteIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

export const signProgressNoteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

// --- Nursing Note Schemas ---

export const createNursingNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
    content: z.string().min(1, 'Content is required').max(10000),
    metadata: z.any().optional(),
  }),
});

export const updateNursingNoteSchema = z.object({
  body: z.object({
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
    content: z.string().min(1).max(10000).optional(),
    metadata: z.any().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid nursing note ID'),
  }),
});

export const listNursingNotesSchema = z.object({
  query: paginationSchema.extend({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
  }),
});

export const nursingNoteIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid nursing note ID'),
  }),
});

// --- Unlock / Relock ---

export const unlockProgressNoteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
  body: z
    .object({
      hours: z.coerce.number().int().min(1).max(24).optional(),
    })
    .optional(),
});

export const listUnlockedProgressNotesSchema = z.object({
  query: z.object({
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    mine: z
      .union([z.boolean(), z.string()])
      .transform((v) => v === true || v === 'true')
      .optional(),
  }),
});

// ============================================================
// Wound Care Records
// ============================================================

const woundTypeEnum = z.enum([
  'surgical',
  'pressure_ulcer',
  'laceration',
  'burn',
  'diabetic_ulcer',
  'other',
]);
const woundStageEnum = z.enum(['stage_1', 'stage_2', 'stage_3', 'stage_4', 'unstageable']);
const exudateTypeEnum = z.enum(['none', 'serous', 'sanguineous', 'purulent']);
const exudateAmountEnum = z.enum(['none', 'scant', 'moderate', 'heavy']);
const woundStatusEnum = z.enum(['active', 'healing', 'healed', 'worsening']);

export const createWoundCareSchema = z.object({
  body: z.object({
    // One of visitId or admissionId must be supplied; visit resolved from admission otherwise.
    visitId: z.string().uuid('Invalid visit ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    woundLocation: z.string().min(1, 'Wound location is required').max(100),
    woundType: woundTypeEnum.optional(),
    woundStage: woundStageEnum.optional(),
    lengthCm: z.number().positive().max(999.99).optional(),
    widthCm: z.number().positive().max(999.99).optional(),
    depthCm: z.number().positive().max(999.99).optional(),
    exudateType: exudateTypeEnum.optional(),
    exudateAmount: exudateAmountEnum.optional(),
    dressingApplied: z.string().max(255).optional(),
    treatmentNotes: z.string().max(10000).optional(),
    photoUrl: z.string().url().optional(),
    assessedAt: z.string().datetime().optional(),
    nextAssessmentDue: z.string().datetime().optional(),
    status: woundStatusEnum.optional(),
  }).refine((d) => d.visitId || d.admissionId, {
    message: 'Either visitId or admissionId is required',
    path: ['visitId'],
  }),
});

export const listWoundCareSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    status: woundStatusEnum.optional(),
  }),
});

// ============================================================
// IV Line Records
// ============================================================

const ivLineTypeEnum = z.enum([
  'peripheral',
  'central_picc',
  'central_subclavian',
  'central_jugular',
  'arterial',
  'midline',
]);
const ivRemovalReasonEnum = z.enum([
  'completed',
  'infiltration',
  'phlebitis',
  'dislodged',
  'infection',
  'scheduled_change',
]);
const ivLineStatusEnum = z.enum(['active', 'removed', 'replaced']);

export const createIvLineSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    lineType: ivLineTypeEnum,
    catheterGauge: z.string().max(10).optional(),
    insertionSite: z.string().min(1, 'Insertion site is required').max(100),
    insertedAt: z.string().datetime().optional(),
    dressingChangeFrequencyHours: z.number().int().min(1).max(336).optional(),
    lastDressingChangeAt: z.string().datetime().optional(),
    lastFlushedAt: z.string().datetime().optional(),
    fluidType: z.string().max(100).optional(),
    flowRateMlPerHr: z.number().int().min(0).max(10000).optional(),
    complications: z.string().max(10000).optional(),
    notes: z.string().max(10000).optional(),
  }).refine((d) => d.visitId || d.admissionId, {
    message: 'Either visitId or admissionId is required',
    path: ['visitId'],
  }),
});

export const listIvLinesSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    status: ivLineStatusEnum.optional(),
  }),
});

export const removeIvLineSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid IV line ID'),
  }),
  body: z.object({
    removedAt: z.string().datetime().optional(),
    removalReason: ivRemovalReasonEnum,
    status: z.enum(['removed', 'replaced']).default('removed'),
    notes: z.string().max(10000).optional(),
  }),
});

export const ivLineIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid IV line ID'),
  }),
});

// ============================================================
// Intake / Output Records
// ============================================================

const ioEntryTypeEnum = z.enum(['intake', 'output']);
const ioCategoryEnum = z.enum([
  'oral',
  'iv_fluid',
  'blood_product',
  'tube_feed',
  'urine',
  'drain',
  'vomit',
  'stool',
  'blood_loss',
  'other',
]);

export const createIntakeOutputSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    recordDatetime: z.string().datetime().optional(),
    entryType: ioEntryTypeEnum,
    category: ioCategoryEnum,
    volumeMl: z.number().int().min(0).max(100000),
    fluidDescription: z.string().max(255).optional(),
    ivLineId: z.string().uuid('Invalid IV line ID').optional(),
    notes: z.string().max(10000).optional(),
  }).refine((d) => d.visitId || d.admissionId, {
    message: 'Either visitId or admissionId is required',
    path: ['visitId'],
  }),
});

export const listIntakeOutputSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    entryType: ioEntryTypeEnum.optional(),
    category: ioCategoryEnum.optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// --- Exported Types ---

export type CreateProgressNoteInput = z.infer<typeof createProgressNoteSchema>['body'];
export type UpdateProgressNoteInput = z.infer<typeof updateProgressNoteSchema>['body'];
export type ListProgressNotesQuery = z.infer<typeof listProgressNotesSchema>['query'];
export type UnlockProgressNoteInput = z.infer<typeof unlockProgressNoteSchema>['body'];
export type ListUnlockedQuery = z.infer<typeof listUnlockedProgressNotesSchema>['query'];

export type CreateProgressNoteTemplateInput = z.infer<typeof createProgressNoteTemplateSchema>['body'];
export type UpdateProgressNoteTemplateInput = z.infer<typeof updateProgressNoteTemplateSchema>['body'];

export type CreateNursingNoteInput = z.infer<typeof createNursingNoteSchema>['body'];
export type UpdateNursingNoteInput = z.infer<typeof updateNursingNoteSchema>['body'];
export type ListNursingNotesQuery = z.infer<typeof listNursingNotesSchema>['query'];

export type CreateWoundCareInput = z.infer<typeof createWoundCareSchema>['body'];
export type ListWoundCareQuery = z.infer<typeof listWoundCareSchema>['query'];

export type CreateIvLineInput = z.infer<typeof createIvLineSchema>['body'];
export type ListIvLinesQuery = z.infer<typeof listIvLinesSchema>['query'];
export type RemoveIvLineInput = z.infer<typeof removeIvLineSchema>['body'];

export type CreateIntakeOutputInput = z.infer<typeof createIntakeOutputSchema>['body'];
export type ListIntakeOutputQuery = z.infer<typeof listIntakeOutputSchema>['query'];

// ============================================================
// Amendments (audit trail)
// ============================================================

export const listAmendmentsSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

// ============================================================
// Physical Observation Catalog
// ============================================================

const physicalObservationSystemEnum = z.enum([
  'general',
  'cardiovascular',
  'respiratory',
  'gastrointestinal',
  'neurological',
  'musculoskeletal',
  'skin',
  'ent',
  'eye',
  'genitourinary',
  'psychiatric',
  'other',
]);

export const listPhysicalObservationsSchema = z.object({
  query: z.object({
    system: physicalObservationSystemEnum.optional(),
    search: z.string().max(200).optional(),
    includeInactive: z
      .union([z.boolean(), z.string()])
      .transform((v) => v === true || v === 'true')
      .optional(),
  }),
});

export const createPhysicalObservationSchema = z.object({
  body: z.object({
    system: physicalObservationSystemEnum,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
  }),
});

export const updatePhysicalObservationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid catalog ID'),
  }),
  body: z.object({
    system: physicalObservationSystemEnum.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
});

export const physicalObservationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid catalog ID'),
  }),
});

export type ListPhysicalObservationsQuery = z.infer<typeof listPhysicalObservationsSchema>['query'];
export type CreatePhysicalObservationInput = z.infer<typeof createPhysicalObservationSchema>['body'];
export type UpdatePhysicalObservationInput = z.infer<typeof updatePhysicalObservationSchema>['body'];

// ============================================================
// AI Smart Suggestions
// ============================================================

export const smartSuggestionsSchema = z.object({
  body: z.object({
    chiefComplaints: z.string().max(5000).optional(),
    presentIllness: z.string().max(5000).optional(),
    vitalsSummary: z.string().max(2000).optional(),
    physicalObservations: z
      .array(
        z.object({
          value: z.string().max(500),
          system: z.string().max(50).optional(),
        }),
      )
      .max(50)
      .optional(),
    investigations: z.string().max(5000).optional(),
    diagnosis: z.string().max(2000).optional(),
    certainty: z.enum(['provisional', 'confirmed']).optional(),
    medications: z.string().max(5000).optional(),
    advice: z.string().max(5000).optional(),
    // Lets the server pull this patient's published lab results into the
    // context. Without it the model can only reason from what the doctor has
    // typed, which is why suggestions stayed on the general profile and never
    // mentioned the report sitting on the same screen.
    patientId: z.string().uuid().optional(),
    patientAge: z.number().int().min(0).max(150).nullable().optional(),
    patientSex: z.string().max(20).nullable().optional(),
    knownAllergies: z.array(z.string().max(200)).max(50).optional(),
  }),
});

export type SmartSuggestionsInput = z.infer<typeof smartSuggestionsSchema>['body'];
