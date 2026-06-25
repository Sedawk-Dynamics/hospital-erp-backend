import { z } from 'zod';

export const searchIcdSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1, 'Search query is required').max(120),
    limit: z.coerce.number().int().positive().max(50).optional(),
  }),
});

export const listIcdSchema = z.object({
  query: z.object({
    q: z.string().trim().max(120).optional(),
    category: z.string().trim().max(255).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    includeInactive: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const icdCodeBody = z.object({
  code: z.string().trim().min(1, 'Code is required').max(20),
  title: z.string().trim().min(1, 'Title is required').max(500),
  category: z.string().trim().max(255).optional(),
  chapter: z.string().trim().max(255).optional(),
  isBillable: z.boolean().optional(),
  keywords: z.array(z.string().trim().max(60)).max(20).optional(),
});

export const createIcdSchema = z.object({ body: icdCodeBody });

export const updateIcdSchema = z.object({
  body: icdCodeBody.partial().extend({
    isActive: z.boolean().optional(),
  }),
  params: z.object({ id: z.string().uuid('Invalid ICD id') }),
});

export const icdIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ICD id') }),
});

// Hospital-level custom code (tenant-scoped).
export const createCustomIcdSchema = z.object({ body: icdCodeBody });

export type IcdCodeInput = z.infer<typeof icdCodeBody>;
export type UpdateIcdInput = z.infer<typeof updateIcdSchema>['body'];
