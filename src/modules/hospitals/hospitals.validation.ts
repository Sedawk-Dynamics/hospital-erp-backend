import { z } from 'zod';

export const createHospitalSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(2, 'Hospital name must be at least 2 characters')
      .max(255, 'Hospital name must be at most 255 characters'),
    slug: z
      .string()
      .min(2, 'Slug must be at least 2 characters')
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens')
      .optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('Invalid email address').optional(),
    website: z.string().optional(),
    licenseNumber: z.string().optional(),
  }),
});

export const updateHospitalSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(255).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('Invalid email address').optional(),
    website: z.string().optional(),
    licenseNumber: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid hospital ID'),
  }),
});

export const hospitalIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid hospital ID'),
  }),
});

export type CreateHospitalInput = z.infer<typeof createHospitalSchema>['body'];
export type UpdateHospitalInput = z.infer<typeof updateHospitalSchema>['body'];
