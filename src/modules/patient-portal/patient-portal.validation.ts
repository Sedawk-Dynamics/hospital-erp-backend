import z from 'zod'

export const updateProfileSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid profile id'),
  }),
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().max(100).optional(),
    dateOfBirth: z.string().optional(),            // ISO date string
    gender: z.enum(['male', 'female', 'other']).optional(),
    bloodGroup: z.string().max(5).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email().optional(),
    addressLine1: z.string().max(255).optional(),
    addressLine2: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
    photoUrl: z.string().url().optional(),
    maritalStatus: z.string().max(20).optional(),
    nationality: z.string().max(100).optional(),
    occupation: z.string().max(100).optional(),
    religion: z.string().max(50).optional(),
    preferredLanguage: z.string().max(50).optional(),
  }),
});
