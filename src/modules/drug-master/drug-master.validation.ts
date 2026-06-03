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
  }),
});

export const drugMasterIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid drug ID') }),
});

export const createDrugMasterSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Drug name is required').max(255),
    genericName: z.string().max(500).optional().nullable(),
    manufacturer: z.string().max(255).optional().nullable(),
    type: z.string().max(50).optional().nullable(),
    dosageForm: dosageFormEnum.optional().nullable(),
    strength: z.string().max(100).optional().nullable(),
    packSizeLabel: z.string().max(255).optional().nullable(),
    mrp: z.number().nonnegative('Price must be non-negative').optional().nullable(),
    isDiscontinued: z.boolean().optional(),
    schedule: z.string().max(10).optional().nullable(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    isPublished: z.boolean().optional(),
  }),
});

export const updateDrugMasterSchema = z.object({
  body: createDrugMasterSchema.shape.body.partial(),
  params: z.object({ id: z.string().uuid('Invalid drug ID') }),
});

export type SearchDrugMasterQuery = z.infer<typeof searchDrugMasterSchema>['query'];
export type ListDrugMasterQuery = z.infer<typeof listDrugMasterSchema>['query'];
export type CreateDrugMasterInput = z.infer<typeof createDrugMasterSchema>['body'];
export type UpdateDrugMasterInput = z.infer<typeof updateDrugMasterSchema>['body'];
