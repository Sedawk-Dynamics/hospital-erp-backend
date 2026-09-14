import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

const dosageFormEnum = z.enum([
  'tablet',
  'capsule',
  'syrup',
  'injection',
  'cream',
  'drops',
  'inhaler',
  'other',
]);
const gstTreatmentEnum = z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated']);

// Public search used by doctors / pharmacy to look up the platform catalog.
export const searchDrugMasterSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1, 'Search query is required').max(120),
    limit: z.coerce.number().int().positive().max(50).optional(),
    includeDiscontinued: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

// Super-admin paginated list / management.
export const listDrugMasterSchema = z.object({
  query: paginationSchema.extend({
    isPublished: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    includeDiscontinued: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // The schedule the classifier resolved. Declared here or validate() drops
    // it — it replaces req.query with the parsed object.
    // H2 is absent on purpose: it is a QR obligation, not a schedule, so no drug
    // ever resolves to it. Filter those with `qrTracked` instead.
    schedule: z.enum(['X', 'H1', 'H', 'G', 'OTC']).optional(),
    // Drugs the NDPS list names, whatever their schedule.
    controlled: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // Schedule H2 formulations — the pack must be QR-scanned at sale.
    qrTracked: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // The vendor catalogue's two halves: prescription drugs and OTC products.
    type: z.enum(['drug', 'otc']).optional(),
  }),
});

export const drugMasterIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid drug ID') }),
});

export const createDrugMasterSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Drug name is required').max(255),
    // One or more generic/molecule names (comma-separated when multiple).
    genericName: z.string().max(500).optional().nullable(),
    // Salt composition — a separate field from the generic name.
    saltComposition: z.string().max(500).optional().nullable(),
    // Structured composition. When present this is AUTHORITATIVE — no parsing
    // runs, the strength is a number and the unit is a unit. The text form is
    // derived from it. Absent, the text path works exactly as before, which is
    // what keeps bulk imports and older clients working.
    salts: z
      .array(
        z.object({
          name: z.string().trim().min(1, 'A molecule name is required').max(255),
          strengthValue: z.number().positive('Strength must be positive').optional().nullable(),
          strengthUnit: z.enum(['mg', 'mcg', 'g', 'ml', 'iu', '%']).optional().nullable(),
          perVolumeValue: z.number().positive().optional().nullable(),
          perVolumeUnit: z.enum(['ml', 'g']).optional().nullable(),
        }),
      )
      .max(20, 'A composition of more than 20 molecules is not a real medicine')
      .optional(),

    manufacturer: z.string().max(255).optional().nullable(),
    type: z.string().max(50).optional().nullable(),
    dosageForm: dosageFormEnum.optional().nullable(),
    strength: z.string().max(100).optional().nullable(),
    packSizeLabel: z.string().max(255).optional().nullable(),
    mrp: z.number().nonnegative('Price must be non-negative').optional().nullable(),
    isDiscontinued: z.boolean().optional(),
    schedule: z.string().max(10).optional().nullable(),
    // Product Resolution Engine / compliance identity.
    gtin: z.string().max(20).optional().nullable(),
    casePackGtin: z.string().max(20).optional().nullable(),
    unitsPerCase: z.number().int().positive().optional().nullable(),
    manufacturerCode: z.string().max(100).optional().nullable(),
    hsnCode: z.string().max(20).optional().nullable(),
    gstRate: z.number().min(0).max(100).optional().nullable(),
    gstTreatment: gstTreatmentEnum.optional().nullable(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    isPublished: z.boolean().optional(),
  }),
});

export const updateDrugMasterSchema = z.object({
  body: createDrugMasterSchema.shape.body.partial(),
  params: z.object({ id: z.string().uuid('Invalid drug ID') }),
});

// G11: a pharmacist's suggestion of an unlisted brand — the identity fields only;
// pricing / publish state are decided by the reviewing platform admin.
export const suggestDrugMasterSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Drug name is required').max(255),
    genericName: z.string().max(500).optional().nullable(),
    manufacturer: z.string().max(255).optional().nullable(),
    type: z.string().max(50).optional().nullable(),
    dosageForm: dosageFormEnum.optional().nullable(),
    strength: z.string().max(100).optional().nullable(),
    packSizeLabel: z.string().max(255).optional().nullable(),
    schedule: z.string().max(10).optional().nullable(),
  }),
});

// ── HSN → GST tax reference (super-admin management) ──
const hsnCategoryEnum = z.enum(['medicine', 'consumable', 'device', 'supplement', 'other']);

export const createHsnGstRateSchema = z.object({
  body: z.object({
    // Digits only; 4-digit heading acts as a chapter default, 6/8-digit overrides.
    hsnCode: z
      .string()
      .trim()
      .min(2, 'HSN code is required')
      .max(20)
      .regex(/^[0-9]+$/, 'HSN code must be digits only'),
    description: z.string().max(255).optional().nullable(),
    gstRate: z.number({ message: 'GST rate is required' }).min(0).max(100),
    treatment: gstTreatmentEnum.optional(),
    category: hsnCategoryEnum.optional().nullable(),
    isActive: z.boolean().optional(),
  }),
});

export const updateHsnGstRateSchema = z.object({
  body: createHsnGstRateSchema.shape.body.partial(),
  params: z.object({ id: z.string().uuid('Invalid HSN rate ID') }),
});

// Bulk create/update: each row is upserted by HSN code (existing rows updated).
export const bulkHsnGstRateSchema = z.object({
  body: z.object({
    rows: z
      .array(createHsnGstRateSchema.shape.body)
      .min(1, 'At least one row is required')
      .max(2000, 'At most 2000 rows at a time'),
  }),
});

export const hsnGstRateIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid HSN rate ID') }),
});

export type CreateHsnGstRateInput = z.infer<typeof createHsnGstRateSchema>['body'];
export type UpdateHsnGstRateInput = z.infer<typeof updateHsnGstRateSchema>['body'];
export type BulkHsnGstRateInput = z.infer<typeof bulkHsnGstRateSchema>['body'];

export type SearchDrugMasterQuery = z.infer<typeof searchDrugMasterSchema>['query'];
export type ListDrugMasterQuery = z.infer<typeof listDrugMasterSchema>['query'];
export type CreateDrugMasterInput = z.infer<typeof createDrugMasterSchema>['body'];
export type UpdateDrugMasterInput = z.infer<typeof updateDrugMasterSchema>['body'];
export type SuggestDrugMasterInput = z.infer<typeof suggestDrugMasterSchema>['body'];

/** Salt review queue. Declared or validate() drops the filters. */
export const listSaltsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    search: z.string().optional(),
    status: z.enum(['undecided', 'decided', 'all']).optional(),
    schedule: z.enum(['X', 'H1', 'H', 'G', 'OTC']).optional(),
    controlled: z.string().transform((v) => v === 'true').optional(),
  }),
});

export const decideSaltSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid salt ID') }),
  body: z.object({
    // Null is a legitimate answer — it puts the molecule back in the queue.
    scheduleCode: z.enum(['X', 'H1', 'H', 'G', 'OTC']).nullable(),
    controlledClass: z.enum(['narcotic', 'psychotropic']).nullable().optional(),
    vaultControlled: z.boolean().optional(),
    note: z.string().max(1000).nullable().optional(),
  }),
});
