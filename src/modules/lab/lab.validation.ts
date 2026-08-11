import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Parameter spec (shared between LabTestTemplate.parameters and
// LabTestCatalog.parameters). One row per result field in a lab
// report — e.g. CBC has 22 of these (Hemoglobin, WBC count, ...).
//
// `refLow`/`refHigh` are the numeric reference range used for auto-
// abnormal flagging in result entry; `refRangeText` is a free-text
// fallback for tests that report categorical results (Blood group,
// Widal titres, Pap smear classification). Pick one — the seed
// helpers below set whichever is appropriate.
// ============================================================

export const parameterSpecSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(150),
  code: z.string().max(50).optional().nullable(),
  unit: z.string().max(50).optional().nullable(),
  // Unit group code (e.g. "concentration_mass", "hematology_counts"). Lets
  // the parameter builder filter the unit picker to the relevant units and
  // — eventually — enables unit conversion. Optional for backwards-compat
  // with templates seeded before the unit-groups migration.
  unitGroupCode: z.string().max(80).optional().nullable(),
  // Numeric reference range — used to flag abnormals when present.
  refLow: z.number().optional().nullable(),
  refHigh: z.number().optional().nullable(),
  // Free-text reference range for non-numeric results (e.g. "Negative",
  // "A/B/AB/O", "Titre <1:80").
  refRangeText: z.string().max(200).optional().nullable(),
  // Display precision for numeric results (decimals).
  decimals: z.number().int().min(0).max(4).optional().nullable(),
  // Section label — parameters with the same group render together on the
  // report (e.g. RBC indices, WBC differential).
  group: z.string().max(100).optional().nullable(),
  // Input control. `number` is the default for biochem/hematology; `text`
  // is used for descriptive results (morphology); `select` is used for
  // categorical results with a fixed option list.
  inputType: z.enum(['number', 'text', 'select']).default('number'),
  options: z
    .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(150) }))
    .optional()
    .nullable(),
  // Per-parameter helper text shown under the input (e.g. "Reflex only").
  notes: z.string().max(500).optional().nullable(),
});

export type ParameterSpec = z.infer<typeof parameterSpecSchema>;

export const parametersArraySchema = z
  .array(parameterSpecSchema)
  .max(100, 'A test cannot have more than 100 parameters');

// ============================================================
// Lab Test Templates (super-admin only writes; everyone reads)
// ============================================================

// Aliases / tags — capped so the searchTokens column stays a sane size.
// Both arrays are deduplicated + lowercased by the service before persist.
const aliasesField = z.array(z.string().min(1).max(120)).max(25).default([]);
const tagsField = z.array(z.string().min(1).max(60)).max(40).default([]);

export const createLabTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    code: z.string().max(50).optional().nullable(),
    sampleType: z.string().max(50).optional().nullable(),
    specimen: z.string().max(255).optional().nullable(),
    instructions: z.string().max(5000).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    defaultPrice: z.number().nonnegative().optional().nullable(),
    turnaroundHours: z.number().int().positive().optional().nullable(),
    parameters: parametersArraySchema.default([]),
    interpretation: z.string().max(5000).optional().nullable(),
    aliases: aliasesField,
    tags: tagsField,
    isPublished: z.boolean().default(true),
  }),
});

export const updateLabTemplateSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid template ID') }),
  body: createLabTemplateSchema.shape.body.partial(),
});

export const labTemplateIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid template ID') }),
});

export const listLabTemplatesSchema = z.object({
  query: paginationSchema.extend({
    isPublished: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const cloneOneLabTemplateSchema = z.object({
  params: z.object({ templateId: z.string().uuid('Invalid template ID') }),
  body: z
    .object({
      overridePrice: z.number().nonnegative().optional(),
      overrideTurnaroundHours: z.number().int().positive().optional(),
    })
    .default({}),
});

export const cloneAllLabTemplatesSchema = z.object({
  body: z
    .object({
      // When true, re-clone templates that already have a catalog clone for
      // this tenant (snapshot-overwrites the parameters). Default false: skip
      // already-cloned templates so the hospital admin's edits aren't lost.
      overwriteExisting: z.boolean().default(false),
    })
    .default({}),
});

// ============================================================
// Test Catalog
// ============================================================

export const createTestSchema = z.object({
  body: z.object({
    testName: z.string().min(1, 'Test name is required').max(255),
    testCode: z.string().max(50).optional(),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().max(50).optional(),
    price: z.number().positive('Price must be positive').optional(),
    turnaroundHours: z.number().int().positive().optional(),
    sampleType: z.string().max(50).optional(),
    specimen: z.string().max(255).optional(),
    instructions: z.string().max(5000).optional(),
    parameters: parametersArraySchema.optional(),
    interpretation: z.string().max(5000).optional(),
    aliases: aliasesField.optional(),
    tags: tagsField.optional(),
    // `true` when the hospital is authoring a custom test from scratch
    // (no platform template). The service force-sets templateId to null
    // for these so re-clone-all skips them.
    isCustom: z.boolean().optional(),
    isActive: z.boolean().default(true),
  }),
});

export const getTestsSchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    sampleType: z.string().optional(),
  }),
});

export const testIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid test ID'),
  }),
});

export const updateTestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid test ID'),
  }),
  body: z.object({
    testName: z.string().min(1).max(255).optional(),
    testCode: z.string().max(50).optional(),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().max(50).optional(),
    price: z.number().positive().optional(),
    turnaroundHours: z.number().int().positive().optional(),
    sampleType: z.string().max(50).optional(),
    specimen: z.string().max(255).optional(),
    instructions: z.string().max(5000).optional(),
    parameters: parametersArraySchema.nullable().optional(),
    interpretation: z.string().max(5000).optional(),
    aliases: aliasesField.optional(),
    tags: tagsField.optional(),
    isActive: z.boolean().optional(),
  }),
});

// Narrow PATCH for lab_supervisor: only price + TAT. Stricter than
// updateTestSchema so the route can be reused without leaking schema /
// parameter edits to the supervisor role.
export const updateTestPriceSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid test ID'),
  }),
  body: z.object({
    price: z.number().positive().optional(),
    turnaroundHours: z.number().int().positive().optional(),
  }).refine((b) => b.price != null || b.turnaroundHours != null, {
    message: 'price or turnaroundHours is required',
  }),
});

// ============================================================
// Lab Orders
// ============================================================

export const createLabOrderSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    urgency: z.enum(['routine', 'urgent', 'stat']).default('routine'),
    isThirdParty: z.boolean().default(false),
    thirdPartyLabName: z.string().max(255).optional(),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          testId: z.string().uuid('Invalid test ID'),
        }),
      )
      .min(1, 'At least one test item is required'),
  }),
});

export const getLabOrdersSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    status: z
      .enum([
        'ordered',
        'sample_collected',
        'in_transit',
        'received',
        'in_progress',
        'completed',
        'cancelled',
      ])
      .optional(),
    // Several statuses at once, comma separated — a worklist wants "everything
    // still open", which a single enum cannot express.
    statuses: z.string().optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    /** Open >24h with no report signed or published. */
    overdue: z.coerce.boolean().optional(),
    /** Not yet picked up by a technician — the supervisor's triage queue. */
    unassigned: z.coerce.boolean().optional(),
    assignedTo: z.string().optional(),
    outsourced: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    isThirdParty: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    accepted: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Money side of the intake queue: false = the lab admin still has to
    // collect (or accept on credit), true = cleared to run.
    paymentVerified: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    date: z.string().optional(),
  }),
});

export const labOrderIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
});

export const updateLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    notes: z.string().optional(),
    status: z
      .enum([
        'ordered',
        'sample_collected',
        'in_transit',
        'received',
        'in_progress',
        'completed',
        'cancelled',
      ])
      .optional(),
  }),
});

export const cancelLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    reason: z.string().max(500).optional(),
  }).optional(),
});

/**
 * Money collected at the department's own counter. Shared shape between the lab
 * and radiology accept endpoints so one dialog drives both.
 */
export const diagnosticPaymentSchema = z.object({
  paymentMethod: z.enum([
    'cash',
    'credit_card',
    'debit_card',
    'upi',
    'net_banking',
    'cheque',
    'insurance',
    'other',
  ]),
  /** Omitted means "the whole balance" — the counter's normal case. */
  amount: z.coerce.number().positive('Enter an amount to collect').optional(),
  referenceNumber: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
});

export const acceptLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    assignedToId: z.string().uuid('Invalid technician user ID').optional(),
    notes: z.string().max(500).optional(),
    /** Collect at the lab counter as part of accepting. */
    payment: diagnosticPaymentSchema.optional(),
    /**
     * Admit the order without collecting — TPA / insurance / credit / pay later.
     * Required when there is a balance and no payment is being taken, so an
     * unpaid order always carries the reason it was let through.
     */
    deferReason: z.string().min(2).max(300).optional(),
  }),
});

// ============================================================
// Samples
// ============================================================

export const collectSampleSchema = z.object({
  body: z.object({
    labOrderId: z.string().uuid('Invalid order ID'),
    sampleType: z.string().min(1, 'Sample type is required').max(50),
    barcode: z.string().max(100).optional(),
    notes: z.string().optional(),
  }),
});

export const getSamplesSchema = z.object({
  query: paginationSchema.extend({
    labOrderId: z.string().uuid().optional(),
    status: z
      .enum(['collected', 'in_transit', 'received', 'processing', 'completed', 'rejected'])
      .optional(),
  }),
});

export const updateSampleStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid sample ID'),
  }),
  body: z.object({
    status: z.enum(['collected', 'in_transit', 'received', 'processing', 'completed', 'rejected']),
  }),
});

export const rejectSampleSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid sample ID'),
  }),
  body: z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(500),
  }),
});

// ============================================================
// Results
// ============================================================

export const enterResultsSchema = z.object({
  body: z.object({
    labOrderItemId: z.string().uuid('Invalid order item ID'),
    labOrderId: z.string().uuid('Invalid order ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    results: z
      .array(
        z.object({
          parameterName: z.string().min(1, 'Parameter name is required').max(255),
          value: z.string().max(255).optional(),
          unit: z.string().max(50).optional(),
          normalRange: z.string().max(100).optional(),
          isAbnormal: z.boolean().default(false),
        }),
      )
      .min(1, 'At least one result entry is required'),
  }),
});

export const getResultsSchema = z.object({
  query: paginationSchema.extend({
    labOrderId: z.string().uuid().optional(),
    labOrderItemId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
  }),
});

export const completeLabOrderItemSchema = z.object({
  params: z.object({
    orderId: z.string().uuid('Invalid order ID'),
    itemId: z.string().uuid('Invalid order item ID'),
  }),
});

export const verifyResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid result ID'),
  }),
  body: z
    .object({
      action: z.enum(['approve', 'request_correction']).default('approve'),
      correctionNotes: z.string().max(1000).optional(),
    })
    .optional(),
});

// ============================================================
// Reports
// ============================================================

export const generateLabReportSchema = z.object({
  params: z.object({
    orderId: z.string().uuid('Invalid order ID'),
  }),
  body: z
    .object({
      reportContent: z.string().optional(),
      hospitalBranding: z
        .object({
          name: z.string().optional(),
          logoUrl: z.string().optional(),
          address: z.string().optional(),
          phone: z.string().optional(),
          accreditation: z.string().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export const signLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
});

export const publishLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z
    .object({
      notify: z.boolean().default(true),
    })
    .optional(),
});

/** The other half of the approval decision: send a submitted report back. */
export const rejectLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z
    .object({
      reason: z.string().max(500).optional(),
    })
    .optional(),
});

export const correctLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z.object({
    correctionNotes: z.string().min(1, 'Correction reason is required').max(2000),
    reportContent: z.string().optional(),
    notify: z.boolean().default(true),
  }),
});

// One-shot submit (generate + sign + publish). Mirrors generate's body so
// callers can optionally pass branding overrides + report notes.
export const submitLabReportSchema = z.object({
  params: z.object({
    orderId: z.string().uuid('Invalid order ID'),
  }),
  body: z
    .object({
      notify: z.boolean().default(true),
      reportContent: z.string().optional(),
      hospitalBranding: z
        .object({
          name: z.string().optional(),
          logoUrl: z.string().optional(),
          address: z.string().optional(),
          phone: z.string().optional(),
          accreditation: z.string().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export const getLabReportsSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    status: z.enum(['draft', 'review', 'approved', 'published', 'corrected']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const labReportIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
});

// ============================================================
// Inferred types
// ============================================================

export type CreateTestInput = z.infer<typeof createTestSchema>['body'];
export type UpdateTestInput = z.infer<typeof updateTestSchema>['body'];
export type GetTestsQuery = z.infer<typeof getTestsSchema>['query'];

export type CreateLabOrderInput = z.infer<typeof createLabOrderSchema>['body'];
export type UpdateLabOrderInput = z.infer<typeof updateLabOrderSchema>['body'];
export type GetLabOrdersQuery = z.infer<typeof getLabOrdersSchema>['query'];
export type AcceptLabOrderInput = z.infer<typeof acceptLabOrderSchema>['body'];
export type VerifyResultInput = NonNullable<z.infer<typeof verifyResultSchema>['body']>;

export type CollectSampleInput = z.infer<typeof collectSampleSchema>['body'];
export type GetSamplesQuery = z.infer<typeof getSamplesSchema>['query'];
export type UpdateSampleStatusInput = z.infer<typeof updateSampleStatusSchema>['body'];
export type RejectSampleInput = z.infer<typeof rejectSampleSchema>['body'];

export type EnterResultsInput = z.infer<typeof enterResultsSchema>['body'];
export type GetResultsQuery = z.infer<typeof getResultsSchema>['query'];

export type GetLabReportsQuery = z.infer<typeof getLabReportsSchema>['query'];
export type CorrectLabReportInput = z.infer<typeof correctLabReportSchema>['body'];

export type CreateLabTemplateInput = z.infer<typeof createLabTemplateSchema>['body'];
export type UpdateLabTemplateInput = z.infer<typeof updateLabTemplateSchema>['body'];
export type ListLabTemplatesQuery = z.infer<typeof listLabTemplatesSchema>['query'];
export type CloneOneLabTemplateInput = z.infer<typeof cloneOneLabTemplateSchema>['body'];
export type CloneAllLabTemplatesInput = z.infer<typeof cloneAllLabTemplatesSchema>['body'];
export type UpdateTestPriceInput = z.infer<typeof updateTestPriceSchema>['body'];

// ============================================================
// Lab Unit Groups + Units
// ============================================================

export const createUnitGroupSchema = z.object({
  body: z.object({
    code: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    sortOrder: z.number().int().optional(),
    // super_admin only — adds to the platform-wide catalogue. Hospital
    // admins always create local groups regardless of this flag.
    isGlobal: z.boolean().optional(),
  }),
});

export const updateUnitGroupSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid unit group ID') }),
  body: z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    sortOrder: z.number().int().optional(),
  }),
});

export const unitGroupIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid unit group ID') }),
});

export const createUnitSchema = z.object({
  body: z.object({
    unitGroupId: z.string().uuid('Invalid unit group ID'),
    symbol: z.string().min(1).max(60),
    name: z.string().max(120).optional().nullable(),
    conversionFactor: z.number().positive().optional().nullable(),
    isBase: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const updateUnitSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid unit ID') }),
  body: z.object({
    symbol: z.string().min(1).max(60).optional(),
    name: z.string().max(120).optional().nullable(),
    conversionFactor: z.number().positive().optional().nullable(),
    isBase: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const unitIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid unit ID') }),
});

export type CreateUnitGroupInput = z.infer<typeof createUnitGroupSchema>['body'];
export type UpdateUnitGroupInput = z.infer<typeof updateUnitGroupSchema>['body'];
export type CreateUnitInput = z.infer<typeof createUnitSchema>['body'];
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>['body'];
