import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const RELATIONSHIPS = [
  'self',
  'spouse',
  'child',
  'parent',
  'sibling',
  'guardian',
  'other',
] as const;

export const createPatientSchema = z.object({
  body: z.object({
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    dateOfBirth: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid date of birth',
    }).optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']),
    bloodGroup: z
      .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])
      .optional(),
    maritalStatus: z
      .enum(['single', 'married', 'divorced', 'widowed', 'separated'])
      .optional(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    phone: z.string().min(7, 'Phone number is too short').max(20),
    secondaryPhone: z.string().max(20).optional(),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
    nationality: z.string().max(100).optional(),
    occupation: z.string().max(200).optional(),
    religion: z.string().max(100).optional(),
    preferredLanguage: z.string().max(50).optional(),
    nationalId: z.string().max(100).optional(),
    insurancePolicyNumber: z.string().max(100).optional(),
    referredBy: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    abhaNumber: z.string().max(20).optional(),
    // Link this profile to an account-holder User. If omitted the patient is standalone.
    userId: z.string().uuid('Invalid user ID').optional(),
    // Relationship of this patient profile to the account-holder user.
    // Defaults to 'self' when a user link is provided for the first time.
    relationship: z.enum(RELATIONSHIPS).optional(),
    isSelf: z.boolean().optional(),
  }),
});

export const updatePatientSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    dateOfBirth: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: 'Invalid date of birth',
      })
      .optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
    bloodGroup: z
      .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])
      .optional()
      .nullable(),
    maritalStatus: z
      .enum(['single', 'married', 'divorced', 'widowed', 'separated'])
      .optional()
      .nullable(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    phone: z.string().min(7).max(20).optional(),
    secondaryPhone: z.string().max(20).optional().nullable(),
    address: z.string().max(500).optional().nullable(),
    city: z.string().max(100).optional().nullable(),
    state: z.string().max(100).optional().nullable(),
    zipCode: z.string().max(20).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    nationality: z.string().max(100).optional().nullable(),
    occupation: z.string().max(200).optional().nullable(),
    religion: z.string().max(100).optional().nullable(),
    preferredLanguage: z.string().max(50).optional().nullable(),
    nationalId: z.string().max(100).optional().nullable(),
    insurancePolicyNumber: z.string().max(100).optional().nullable(),
    referredBy: z.string().max(200).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    abhaNumber: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export const searchPatientsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
    bloodGroup: z
      .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])
      .optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Front Desk patient directory tabs: all | registered (permanent MRN) |
    // temporary (TEMP-… MRN, not yet registered/merged).
    category: z.enum(['all', 'registered', 'temporary']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ── Temporary (provisional) patient ─────────────────────────

/** Create a temp patient from whatever is known — everything is optional. */
export const createTemporaryPatientSchema = z.object({
  body: z.object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
    dateOfBirth: z.string().optional(),
    age: z.coerce.number().int().min(0).max(150).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').max(255).optional().or(z.literal('')),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
    address: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
    notes: z.string().max(1000).optional(),
    /**
     * The account this patient belongs under — the attender who brought them
     * in. Pass it explicitly, or leave it out and let the phone resolve to an
     * existing account holder.
     */
    userId: z.string().uuid('Invalid account holder ID').optional(),
    /** How the patient relates to that account holder. */
    relationship: z
      .enum(['self', 'spouse', 'child', 'parent', 'sibling', 'guardian', 'other'])
      .optional(),
  }),
});

/** Register a temp patient in place — a real first name is now required. */
export const registerTemporaryPatientSchema = z.object({
  body: z.object({
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().max(100).optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
    dateOfBirth: z.string().optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').max(255).optional().or(z.literal('')),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
    address: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
  }),
  params: z.object({ id: z.string().uuid('Invalid patient ID') }),
});

/** Merge a temp patient into an existing registered one. */
export const mergeTemporaryPatientSchema = z.object({
  body: z.object({
    targetPatientId: z.string().uuid('Invalid target patient ID'),
  }),
  params: z.object({ id: z.string().uuid('Invalid patient ID') }),
});

export const addEmergencyContactSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Contact name is required').max(200),
    relationship: z.string().min(1, 'Relationship is required').max(100),
    phone: z.string().min(7, 'Phone number is too short').max(20),
    secondaryPhone: z.string().max(20).optional(),
    email: z.string().email().optional().or(z.literal('')),
    address: z.string().max(500).optional(),
    isPrimary: z.boolean().default(false),
  }),
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export const addAllergySchema = z.object({
  body: z.object({
    allergen: z.string().min(1, 'Allergen is required').max(200),
    type: z.enum(['drug', 'food', 'environmental', 'other']),
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']),
    reaction: z.string().max(500).optional(),
    onsetDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: 'Invalid onset date',
      })
      .optional(),
    notes: z.string().max(1000).optional(),
    isActive: z.boolean().default(true),
  }),
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export const addDocumentSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Document title is required').max(300),
    type: z.enum([
      'lab_report',
      'prescription',
      'discharge_summary',
      'imaging',
      'insurance',
      'consent',
      'identification',
      'other',
    ]),
    fileUrl: z.string().url('Invalid file URL'),
    fileName: z.string().min(1).max(500),
    fileSizeBytes: z.number().int().positive().optional(),
    mimeType: z.string().max(100).optional(),
    description: z.string().max(1000).optional(),
    uploadedBy: z.string().uuid().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export const addFamilyHistorySchema = z.object({
  body: z.object({
    relationship: z.string().min(1, 'Relationship is required').max(100),
    condition: z.string().min(1, 'Condition is required').max(300),
    ageOfOnset: z.number().int().min(0).max(150).optional(),
    notes: z.string().max(1000).optional(),
    isDeceased: z.boolean().default(false),
    causeOfDeath: z.string().max(300).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export const patientIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid patient ID'),
  }),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>['body'];
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>['body'];
export type SearchPatientsQuery = z.infer<typeof searchPatientsSchema>['query'];
export type CreateTemporaryPatientInput = z.infer<typeof createTemporaryPatientSchema>['body'];
export type RegisterTemporaryPatientInput = z.infer<typeof registerTemporaryPatientSchema>['body'];
export type AddEmergencyContactInput = z.infer<typeof addEmergencyContactSchema>['body'];
export type AddAllergyInput = z.infer<typeof addAllergySchema>['body'];
export type AddDocumentInput = z.infer<typeof addDocumentSchema>['body'];
export type AddFamilyHistoryInput = z.infer<typeof addFamilyHistorySchema>['body'];
