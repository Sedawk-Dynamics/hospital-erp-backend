import { z } from 'zod';

export const searchSnomedSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1, 'Search query is required').max(120),
    limit: z.coerce.number().int().positive().max(50).optional(),
  }),
});

export const mapSnomedSchema = z.object({
  params: z.object({
    conceptId: z.string().regex(/^\d{6,32}$/, 'Invalid SNOMED concept ID'),
  }),
});
