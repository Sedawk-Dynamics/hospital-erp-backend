import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Drug Categories
// ============================================================

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Category name is required').max(100),
    description: z.string().max(500).optional(),
  }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional().nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid category ID'),
  }),
});

export const categoryIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid category ID'),
  }),
});

export const getCategoriesQuerySchema = z.object({
  query: paginationSchema,
});

// ============================================================
// Formulary
// ============================================================

export const createFormularySchema = z.object({
  body: z.object({
    drugName: z.string().min(1, 'Drug name is required').max(255),
    genericName: z.string().max(255).optional(),
    categoryId: z.string().uuid('Invalid category ID').optional(),
    manufacturer: z.string().max(255).optional(),
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional(),
    strength: z.string().max(100).optional(),
    unitOfMeasurement: z.string().max(20).optional(),
    price: z.number().nonnegative('Price must be non-negative').optional(),
    indications: z.string().optional(),
    contraindications: z.string().optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateFormularySchema = z.object({
  body: z.object({
    drugName: z.string().min(1).max(255).optional(),
    genericName: z.string().max(255).optional().nullable(),
    categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
    manufacturer: z.string().max(255).optional().nullable(),
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional()
      .nullable(),
    strength: z.string().max(100).optional().nullable(),
    unitOfMeasurement: z.string().max(20).optional().nullable(),
    price: z.number().nonnegative().optional().nullable(),
    indications: z.string().optional().nullable(),
    contraindications: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
    isRecalled: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid formulary item ID'),
  }),
});

export const formularyIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid formulary item ID'),
  }),
});

// Import a drug from the platform DrugMaster catalog into this tenant's
// formulary. Optional overrides let the hospital set its own selling price /
// category at import time.
export const importFormularySchema = z.object({
  body: z.object({
    drugMasterId: z.string().uuid('Invalid drug catalog ID'),
    categoryId: z.string().uuid('Invalid category ID').optional(),
    price: z.number().nonnegative('Price must be non-negative').optional(),
  }),
});

export const getFormularyQuerySchema = z.object({
  query: paginationSchema.extend({
    categoryId: z.string().uuid().optional(),
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

// ============================================================
// Batches
// ============================================================

export const createBatchSchema = z.object({
  body: z.object({
    drugId: z.string().uuid('Invalid drug ID'),
    batchNumber: z.string().min(1, 'Batch number is required').max(100),
    manufacturingDate: z.string().optional(),
    expiryDate: z.string().min(1, 'Expiry date is required'),
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    purchasePrice: z.number().nonnegative('Purchase price must be non-negative').optional(),
    sellingPrice: z.number().nonnegative('Selling price must be non-negative').optional(),
    quantityReceived: z.number().int().positive('Quantity received must be positive'),
  }),
});

export const updateBatchSchema = z.object({
  body: z.object({
    batchNumber: z.string().min(1).max(100).optional(),
    manufacturingDate: z.string().optional().nullable(),
    expiryDate: z.string().optional(),
    supplierId: z.string().uuid('Invalid supplier ID').optional().nullable(),
    purchasePrice: z.number().nonnegative().optional().nullable(),
    sellingPrice: z.number().nonnegative().optional().nullable(),
    quantityInStock: z.number().int().nonnegative('Stock quantity must be non-negative').optional(),
    isExpired: z.boolean().optional(),
    isRecalled: z.boolean().optional(),
    recallReason: z.string().optional().nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const batchIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const getBatchesQuerySchema = z.object({
  query: paginationSchema.extend({
    drugId: z.string().uuid().optional(),
    isExpired: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Convenience filter for the POS picker: only batches that are not
    // expired, not recalled, and have stock > 0. Trumps `isExpired`.
    availableOnly: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const getExpiringBatchesQuerySchema = z.object({
  query: paginationSchema.extend({
    days: z.coerce.number().int().positive().default(30),
  }),
});

// ============================================================
// Dispensing
// ============================================================

export const createDispenseSchema = z.object({
  body: z.object({
    prescriptionId: z.string().uuid('Invalid prescription ID'),
    prescriptionItemId: z.string().uuid('Invalid prescription item ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    quantityDispensed: z.number().int().positive('Quantity dispensed must be positive'),
    notes: z.string().max(1000).optional(),
    // NPPA price-control: set when authorising a sale above the DPCO ceiling.
    overrideCeiling: z.boolean().optional(),
    overrideReason: z.string().max(500).optional(),
  }),
});

export const dispensePriceCheckSchema = z.object({
  body: z.object({
    items: z
      .array(z.object({ drugBatchId: z.string().uuid('Invalid drug batch ID') }))
      .min(1, 'At least one item is required'),
  }),
});

export const dispenseIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid dispensing record ID'),
  }),
});

export const getDispenseQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ============================================================
// Returns
// ============================================================

export const createReturnSchema = z.object({
  body: z.object({
    returnType: z.enum(['patient_return', 'vendor_return']),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    quantity: z.number().int().positive('Quantity must be positive'),
    reason: z.string().max(1000).optional(),
  }),
});

// SOW-literal vendor-return endpoint (POST /pharmacy/vendor-returns): returnType
// is implied, supplier required. The controller injects returnType.
export const createVendorReturnSchema = z.object({
  body: z.object({
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    supplierId: z.string().uuid('Supplier is required for vendor returns'),
    quantity: z.number().int().positive('Quantity must be positive'),
    reason: z.string().max(1000).optional(),
  }),
});

export const returnIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid return ID'),
  }),
});

export const getReturnsQuerySchema = z.object({
  query: paginationSchema.extend({
    returnType: z.enum(['patient_return', 'vendor_return']).optional(),
    status: z.enum(['pending', 'processed', 'rejected']).optional(),
  }),
});

export const processReturnSchema = z.object({
  body: z.object({
    status: z.enum(['processed', 'rejected']),
  }),
  params: z.object({
    id: z.string().uuid('Invalid return ID'),
  }),
});

// ============================================================
// Recall Management
// ============================================================

export const recallBatchSchema = z.object({
  body: z.object({
    recallReason: z.string().min(1, 'Recall reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const unrecallBatchSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const recallDrugSchema = z.object({
  body: z.object({
    recallReason: z.string().min(1, 'Recall reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid drug ID'),
  }),
});

export const getRecalledItemsQuerySchema = z.object({
  query: paginationSchema.extend({
    type: z.enum(['batch', 'drug', 'all']).default('all'),
  }),
});

export const recallAffectedPatientsParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

// ============================================================
// GST
// ============================================================

export const getGstReportQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    gstRate: z.coerce.number().min(0).max(100).optional(),
  }),
});

// ============================================================
// Type exports
// ============================================================

export type CreateCategoryInput = z.infer<typeof createCategorySchema>['body'];
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>['body'];
export type CreateFormularyInput = z.infer<typeof createFormularySchema>['body'];
export type UpdateFormularyInput = z.infer<typeof updateFormularySchema>['body'];
export type ImportFormularyInput = z.infer<typeof importFormularySchema>['body'];
export type GetFormularyQuery = z.infer<typeof getFormularyQuerySchema>['query'];
export type CreateBatchInput = z.infer<typeof createBatchSchema>['body'];
export type UpdateBatchInput = z.infer<typeof updateBatchSchema>['body'];
export type GetBatchesQuery = z.infer<typeof getBatchesQuerySchema>['query'];
export type GetExpiringBatchesQuery = z.infer<typeof getExpiringBatchesQuerySchema>['query'];
export type CreateDispenseInput = z.infer<typeof createDispenseSchema>['body'];
export type GetDispenseQuery = z.infer<typeof getDispenseQuerySchema>['query'];
export type CreateReturnInput = z.infer<typeof createReturnSchema>['body'];
export type GetReturnsQuery = z.infer<typeof getReturnsQuerySchema>['query'];
export type ProcessReturnInput = z.infer<typeof processReturnSchema>['body'];
export type RecallBatchInput = z.infer<typeof recallBatchSchema>['body'];
export type RecallDrugInput = z.infer<typeof recallDrugSchema>['body'];
export type GetRecalledItemsQuery = z.infer<typeof getRecalledItemsQuerySchema>['query'];
export type GetGstReportQuery = z.infer<typeof getGstReportQuerySchema>['query'];
