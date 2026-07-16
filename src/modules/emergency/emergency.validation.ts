import { z } from 'zod';

/**
 * Front-desk Emergency / Casualty flow validation.
 *
 * The front desk mints a temporary patient for a casualty case and routes it as
 * OP or IP. All identity fields are optional — a true Golden-Hour case is an
 * unidentified patient with no data.
 */

// Mint a temporary emergency patient and route it as OP or IP.
export const createEmergencyPatientSchema = z.object({
  body: z.object({
    type: z.enum(['op', 'ip']),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(20).optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    age: z.coerce.number().int().min(0).max(150).optional(),
    // DoctorProfile.id of the attending casualty doctor. Optional — an
    // unassigned emergency falls back to a placeholder doctor for the record's
    // required FK and can be reassigned later.
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    // IP-only placement (both optional — a "pending-placement" admission).
    wardId: z.string().uuid('Invalid ward ID').optional(),
    bedId: z.string().uuid('Invalid bed ID').optional(),
    billingCategory: z.enum(['cash', 'package', 'insurance', 'corporate']).optional(),
    chiefComplaint: z.string().max(500).optional(),
    notes: z.string().max(500).optional(),
  }),
});

// Register a temp emergency patient in place: fill real identity + issue a
// permanent MRN, keeping the whole emergency episode on the same record.
export const registerEmergencyPatientSchema = z.object({
  body: z.object({
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().max(100).optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    dateOfBirth: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid date of birth' })
      .optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
    address: z.string().max(500).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid emergency patient ID'),
  }),
});

// Connect a temp emergency patient to an already-registered patient: repoint the
// entire episode onto that patient and retire the temp record.
export const mergeEmergencyPatientSchema = z.object({
  body: z.object({
    targetPatientId: z.string().uuid('Invalid target patient ID'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid emergency patient ID'),
  }),
});

export type CreateEmergencyPatientInput = z.infer<typeof createEmergencyPatientSchema>['body'];
export type RegisterEmergencyPatientInput = z.infer<typeof registerEmergencyPatientSchema>['body'];
