import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ---- Shared helpers ----

const bloodGroupEnum = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
const genderEnum = z.enum(['male', 'female', 'other']);
const dateString = z.string().refine((val) => !isNaN(Date.parse(val)), {
  message: 'Invalid date',
});
const uuidParam = z.string().uuid('Invalid ID');

const donationTypeEnum = z.enum(['whole_blood', 'plasma', 'platelets', 'double_red_cells']);
const screeningResultEnum = z.enum(['pass', 'fail', 'pending']);
const componentTypeEnum = z.enum([
  'whole_blood',
  'packed_rbc',
  'plasma',
  'platelets',
  'cryoprecipitate',
]);
const inventoryStatusEnum = z.enum(['available', 'reserved', 'issued', 'expired', 'discarded']);
const crossMatchResultEnum = z.enum(['compatible', 'incompatible', 'pending']);

// ---- ID param schema (reusable) ----

export const idParamSchema = z.object({
  params: z.object({
    id: uuidParam,
  }),
});

// ============================================================
// DONORS
// ============================================================

export const registerDonorSchema = z.object({
  body: z.object({
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().max(100).optional(),
    dateOfBirth: dateString.optional(),
    gender: genderEnum.optional(),
    bloodGroup: bloodGroupEnum,
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    address: z.string().max(500).optional(),
    healthStatus: z.string().max(500).optional(),
    isEligible: z.boolean().optional(),
  }),
});

export const updateDonorSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().max(100).optional().nullable(),
    dateOfBirth: dateString.optional().nullable(),
    gender: genderEnum.optional().nullable(),
    bloodGroup: bloodGroupEnum.optional(),
    phone: z.string().max(20).optional().nullable(),
    email: z.string().email('Invalid email').optional().nullable().or(z.literal('')),
    address: z.string().max(500).optional().nullable(),
    healthStatus: z.string().max(500).optional().nullable(),
    isEligible: z.boolean().optional(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

export const listDonorsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    bloodGroup: bloodGroupEnum.optional(),
    isEligible: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const donorHistorySchema = z.object({
  params: z.object({
    id: uuidParam,
  }),
});

// ============================================================
// DONATIONS
// ============================================================

export const recordDonationSchema = z.object({
  body: z.object({
    donorId: uuidParam,
    donationDate: dateString,
    donationType: donationTypeEnum,
    volumeMl: z.number().int().positive('Volume must be positive'),
    bagNumber: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
    collectedBy: uuidParam.optional(),
  }),
});

export const updateDonationSchema = z.object({
  body: z.object({
    donationDate: dateString.optional(),
    donationType: donationTypeEnum.optional(),
    volumeMl: z.number().int().positive().optional(),
    bagNumber: z.string().max(50).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

export const listDonationsSchema = z.object({
  query: paginationSchema.extend({
    donorId: uuidParam.optional(),
    screeningResult: screeningResultEnum.optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const screenDonationSchema = z.object({
  body: z.object({
    screeningResult: z.enum(['pass', 'fail']),
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

// ============================================================
// BLOOD INVENTORY
// ============================================================

export const listInventorySchema = z.object({
  query: paginationSchema.extend({
    bloodGroup: bloodGroupEnum.optional(),
    componentType: componentTypeEnum.optional(),
    status: inventoryStatusEnum.optional(),
    storageLocation: z.string().optional(),
  }),
});

export const addBloodUnitSchema = z.object({
  body: z.object({
    donationId: uuidParam.optional(),
    componentType: componentTypeEnum,
    bloodGroup: bloodGroupEnum,
    bagNumber: z.string().max(50).optional(),
    volumeMl: z.number().int().positive('Volume must be positive'),
    collectionDate: dateString,
    expiryDate: dateString,
    storageLocation: z.string().max(100).optional(),
  }),
});

export const updateBloodUnitSchema = z.object({
  body: z.object({
    componentType: componentTypeEnum.optional(),
    bloodGroup: bloodGroupEnum.optional(),
    volumeMl: z.number().int().positive().optional(),
    expiryDate: dateString.optional(),
    status: inventoryStatusEnum.optional(),
    storageLocation: z.string().max(100).optional().nullable(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

export const discardBloodUnitSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Discard reason is required').max(500),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

export const expiringUnitsSchema = z.object({
  query: z.object({
    days: z.coerce.number().int().positive().default(7),
  }),
});

// ============================================================
// CROSS-MATCH
// ============================================================

export const requestCrossMatchSchema = z.object({
  body: z.object({
    patientId: uuidParam,
    bloodInventoryId: uuidParam,
    notes: z.string().max(2000).optional(),
  }),
});

export const listCrossMatchesSchema = z.object({
  query: paginationSchema.extend({
    patientId: uuidParam.optional(),
    result: crossMatchResultEnum.optional(),
  }),
});

export const completeCrossMatchSchema = z.object({
  body: z.object({
    result: z.enum(['compatible', 'incompatible']),
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

// ============================================================
// TRANSFUSIONS
// ============================================================

export const requestTransfusionSchema = z.object({
  body: z.object({
    patientId: uuidParam,
    visitId: uuidParam,
    bloodInventoryId: uuidParam,
    crossMatchId: uuidParam,
    volumeMl: z.number().int().positive('Volume must be positive'),
    transfusionDate: dateString,
    orderedBy: uuidParam,
    administeredBy: uuidParam,
    notes: z.string().max(2000).optional(),
  }),
});

export const listTransfusionsSchema = z.object({
  query: paginationSchema.extend({
    patientId: uuidParam.optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const startTransfusionSchema = z.object({
  params: z.object({
    id: uuidParam,
  }),
});

export const completeTransfusionSchema = z.object({
  body: z.object({
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

export const reportReactionSchema = z.object({
  body: z.object({
    reactionDetails: z.string().min(1, 'Reaction details are required').max(2000),
  }),
  params: z.object({
    id: uuidParam,
  }),
});

// ---- Inferred types ----

export type RegisterDonorInput = z.infer<typeof registerDonorSchema>['body'];
export type UpdateDonorInput = z.infer<typeof updateDonorSchema>['body'];
export type ListDonorsQuery = z.infer<typeof listDonorsSchema>['query'];

export type RecordDonationInput = z.infer<typeof recordDonationSchema>['body'];
export type UpdateDonationInput = z.infer<typeof updateDonationSchema>['body'];
export type ListDonationsQuery = z.infer<typeof listDonationsSchema>['query'];
export type ScreenDonationInput = z.infer<typeof screenDonationSchema>['body'];

export type ListInventoryQuery = z.infer<typeof listInventorySchema>['query'];
export type AddBloodUnitInput = z.infer<typeof addBloodUnitSchema>['body'];
export type UpdateBloodUnitInput = z.infer<typeof updateBloodUnitSchema>['body'];
export type DiscardBloodUnitInput = z.infer<typeof discardBloodUnitSchema>['body'];

export type RequestCrossMatchInput = z.infer<typeof requestCrossMatchSchema>['body'];
export type ListCrossMatchesQuery = z.infer<typeof listCrossMatchesSchema>['query'];
export type CompleteCrossMatchInput = z.infer<typeof completeCrossMatchSchema>['body'];

export type RequestTransfusionInput = z.infer<typeof requestTransfusionSchema>['body'];
export type ListTransfusionsQuery = z.infer<typeof listTransfusionsSchema>['query'];
export type CompleteTransfusionInput = z.infer<typeof completeTransfusionSchema>['body'];
export type ReportReactionInput = z.infer<typeof reportReactionSchema>['body'];
