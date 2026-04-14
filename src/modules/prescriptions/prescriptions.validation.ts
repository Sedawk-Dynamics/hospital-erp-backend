import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// --- Prescriptions ---

export const createPrescriptionSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    prescriptionType: z.enum(['op', 'ip']).default('op'),
    notes: z.string().max(2000).optional(),
    followUpDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid follow-up date' })
      .optional()
      .nullable(),
    items: z
      .array(
        z.object({
          drugId: z.string().uuid('Invalid drug ID').optional(),
          drugName: z.string().min(1, 'Drug name is required').max(255),
          dosage: z.string().min(1, 'Dosage is required').max(100),
          frequency: z.string().min(1, 'Frequency is required').max(100),
          duration: z.string().max(100).optional(),
          route: z
            .enum(['oral', 'iv', 'im', 'topical', 'sublingual', 'inhalation', 'other'])
            .default('oral'),
          instructions: z.string().max(1000).optional(),
          quantity: z.number().int().positive().optional(),
          isPrn: z.boolean().default(false),
        }),
      )
      .optional(),
  }),
});

export const updatePrescriptionSchema = z.object({
  body: z.object({
    status: z.enum(['active', 'dispensed', 'partially_dispensed', 'cancelled']).optional(),
    notes: z.string().max(2000).optional(),
    followUpDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid follow-up date' })
      .optional()
      .nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
  }),
});

export const cancelPrescriptionSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
  }),
  body: z
    .object({
      reason: z.string().max(500).optional(),
    })
    .optional(),
});

export const getPrescriptionsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    status: z.enum(['active', 'dispensed', 'partially_dispensed', 'cancelled']).optional(),
    prescriptionType: z.enum(['op', 'ip']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const prescriptionIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
  }),
});

// --- Prescription Items ---

export const addPrescriptionItemSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
  }),
  body: z.object({
    drugId: z.string().uuid('Invalid drug ID').optional(),
    drugName: z.string().min(1, 'Drug name is required').max(255),
    dosage: z.string().min(1, 'Dosage is required').max(100),
    frequency: z.string().min(1, 'Frequency is required').max(100),
    duration: z.string().max(100).optional(),
    route: z
      .enum(['oral', 'iv', 'im', 'topical', 'sublingual', 'inhalation', 'other'])
      .default('oral'),
    instructions: z.string().max(1000).optional(),
    quantity: z.number().int().positive().optional(),
    isPrn: z.boolean().default(false),
  }),
});

export const updatePrescriptionItemSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
    itemId: z.string().uuid('Invalid item ID'),
  }),
  body: z.object({
    drugId: z.string().uuid('Invalid drug ID').optional().nullable(),
    drugName: z.string().min(1).max(255).optional(),
    dosage: z.string().min(1).max(100).optional(),
    frequency: z.string().min(1).max(100).optional(),
    duration: z.string().max(100).optional().nullable(),
    route: z
      .enum(['oral', 'iv', 'im', 'topical', 'sublingual', 'inhalation', 'other'])
      .optional(),
    instructions: z.string().max(1000).optional().nullable(),
    quantity: z.number().int().positive().optional().nullable(),
    isPrn: z.boolean().optional(),
  }),
});

export const removePrescriptionItemSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
    itemId: z.string().uuid('Invalid item ID'),
  }),
});

// --- Medication Administration ---

export const recordAdministrationSchema = z.object({
  body: z.object({
    prescriptionItemId: z.string().uuid('Invalid prescription item ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    administeredAt: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid administration date/time',
    }),
    doseGiven: z.string().max(100).optional(),
    status: z.enum(['given', 'missed', 'refused', 'held']),
    notes: z.string().max(2000).optional(),
  }),
});

export const getAdministrationRecordsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    prescriptionItemId: z.string().uuid().optional(),
    status: z.enum(['given', 'missed', 'refused', 'held']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const getAdministrationScheduleQuerySchema = z.object({
  query: z.object({
    patientId: z.string().uuid('Patient ID is required'),
    date: z.string().optional(),
  }),
});

// --- Allergy Check & Formulary Search ---

export const allergyCheckQuerySchema = z.object({
  query: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    drugName: z.string().min(1, 'Drug name is required').max(255),
  }),
});

export const formularySearchQuerySchema = z.object({
  query: z.object({
    search: z.string().min(1, 'Search term is required').max(255),
  }),
});

// --- Inferred Types ---

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>['body'];
export type UpdatePrescriptionInput = z.infer<typeof updatePrescriptionSchema>['body'];
export type GetPrescriptionsQuery = z.infer<typeof getPrescriptionsQuerySchema>['query'];
export type AddPrescriptionItemInput = z.infer<typeof addPrescriptionItemSchema>['body'];
export type UpdatePrescriptionItemInput = z.infer<typeof updatePrescriptionItemSchema>['body'];
export type RecordAdministrationInput = z.infer<typeof recordAdministrationSchema>['body'];
export type GetAdministrationRecordsQuery = z.infer<typeof getAdministrationRecordsQuerySchema>['query'];
export type GetAdministrationScheduleQuery = z.infer<typeof getAdministrationScheduleQuerySchema>['query'];
export type AllergyCheckQuery = z.infer<typeof allergyCheckQuerySchema>['query'];
export type FormularySearchQuery = z.infer<typeof formularySearchQuerySchema>['query'];
