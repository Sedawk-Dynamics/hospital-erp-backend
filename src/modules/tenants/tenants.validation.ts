import { z } from 'zod';

export const createTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Tenant name is required').max(255),
    slug: z
      .string()
      .min(2, 'Slug must be at least 2 characters')
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
    domain: z.string().optional(),
    logoUrl: z.string().url().optional().or(z.literal('')),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    settings: z.record(z.unknown()).optional(),
  }),
});

export const updateTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    domain: z.string().optional(),
    logoUrl: z.string().url().optional().or(z.literal('')),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    settings: z.record(z.unknown()).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid tenant ID'),
  }),
});

export const createSubscriptionSchema = z.object({
  body: z.object({
    plan: z.enum(['free', 'basic', 'professional', 'enterprise']),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    maxUsers: z.number().int().positive().optional(),
    maxStorage: z.number().int().positive().optional(),
    billingCycle: z.enum(['monthly', 'quarterly', 'yearly']).default('monthly'),
    amount: z.number().nonnegative().optional(),
    currency: z.string().length(3).default('USD'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid tenant ID'),
  }),
});

export const updateFeatureToggleSchema = z.object({
  body: z.object({
    featureKey: z.string().min(1, 'Feature key is required'),
    enabled: z.boolean(),
    config: z.record(z.unknown()).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid tenant ID'),
  }),
});

export const tenantIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid tenant ID'),
  }),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>['body'];
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>['body'];
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>['body'];
export type UpdateFeatureToggleInput = z.infer<typeof updateFeatureToggleSchema>['body'];
