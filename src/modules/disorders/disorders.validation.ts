import { z } from 'zod';

export const searchDisordersSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1, 'Search query is required').max(120),
    limit: z.coerce.number().int().positive().max(50).optional(),
  }),
});

export const listDisordersSchema = z.object({
  query: z.object({
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    // Deleting a disorder deactivates it rather than removing the row, so the
    // super admin needs a way to see what they have switched off.
    includeInactive: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const createDisorderSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(500),
    icdCode: z.string().trim().max(20).optional(),
    category: z.string().trim().max(255).optional(),
    keywords: z.array(z.string().trim().max(60)).max(20).optional(),
  }),
});

export const disorderIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid disorder id') }),
});

export type CreateDisorderInput = z.infer<typeof createDisorderSchema>['body'];
