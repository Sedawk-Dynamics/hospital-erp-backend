import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(1000).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export function getPaginationParams(query: PaginationQuery) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const skip = (page - 1) * limit;

  return { skip, take: limit, page, limit };
}

/**
 * A boolean carried in a QUERY STRING.
 *
 * `z.coerce.boolean()` is wrong here and silently inverts the filter:
 * `Boolean("false")` is `true`, and so is `Boolean("0")` and `Boolean("no")` —
 * only the empty string is falsy. `?flag=false` therefore filtered for `true`.
 * config/env.ts already documents the same trap for env vars.
 *
 * Accepts the usual truthy/falsy tokens and leaves anything else undefined so
 * the filter is simply not applied.
 */
export const booleanQueryParam = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return undefined;
  });
