import { z } from 'zod';

// ============================================================
// Counselling sessions & referrals — validation (gap #200 / #298)
// ============================================================

/**
 * What a counselling session is about. Kept as a validated string list (the
 * column is a VARCHAR) so a new type is a one-line change here plus a label on
 * the frontend, with no enum migration.
 */
export const COUNSELLING_SESSION_TYPES = [
  'pre_admission_financial',
  'package_insurance',
  'discharge',
  'follow_up',
  'other',
] as const;

export const COUNSELLING_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export const COUNSELLING_KINDS = ['session', 'referral'] as const;

export type CounsellingStatus = (typeof COUNSELLING_STATUSES)[number];

const isoDateTime = z
  .string({ required_error: 'Date and time is required' })
  .min(1, 'Date and time is required')
  .refine((v) => !isNaN(Date.parse(v)), 'Invalid date and time');

const optionalUuid = (label: string) => z.string().uuid(`Invalid ${label}`).optional().nullable();

export const createCounsellingSessionSchema = z.object({
  body: z
    .object({
      patientId: z.string({ required_error: 'Patient is required' }).uuid('Patient is required'),
      counsellorId: z.string({ required_error: 'Counsellor is required' }).uuid('Counsellor is required'),
      sessionType: z.enum(COUNSELLING_SESSION_TYPES, {
        errorMap: () => ({ message: 'Session type is required' }),
      }),
      scheduledAt: isoDateTime,
      notes: z.string().max(2000).optional().nullable(),
      kind: z.enum(COUNSELLING_KINDS).default('session'),
      // Referral provenance — ignored unless kind = referral.
      referralSource: z.string().trim().max(200).optional().nullable(),
      referredById: optionalUuid('referring user'),
      visitId: optionalUuid('visit'),
      appointmentId: optionalUuid('appointment'),
    })
    .refine((d) => d.kind !== 'referral' || !!(d.referralSource?.trim() || d.referredById), {
      message: 'Say who referred the patient',
      path: ['referralSource'],
    }),
});

/**
 * One filter shape for the list AND the stats endpoint, so the tiles can never
 * count a different set than the table shows (gap #200).
 */
const filterQuery = {
  // A single IST calendar day (YYYY-MM-DD) — what Counsellor Home sends.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  // Or an inclusive IST day range.
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  status: z.enum(COUNSELLING_STATUSES).optional(),
  kind: z.enum(COUNSELLING_KINDS).optional(),
  counsellorId: z.string().uuid('Invalid counsellor').optional(),
  patientId: z.string().uuid('Invalid patient').optional(),
  search: z.string().trim().max(100).optional(),
};

export const listCounsellingSessionsSchema = z.object({
  query: z.object({
    ...filterQuery,
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const counsellingStatsSchema = z.object({
  query: z.object(filterQuery),
});

const idParams = z.object({ id: z.string().uuid('Invalid session ID') });

export const sessionIdParamSchema = z.object({ params: idParams });

export const updateCounsellingStatusSchema = z.object({
  params: idParams,
  body: z
    .object({
      status: z.enum(['in_progress', 'completed', 'cancelled', 'no_show'], {
        errorMap: () => ({ message: 'Invalid status' }),
      }),
      reason: z.string().trim().max(500).optional(),
      notes: z.string().max(2000).optional(),
    })
    .refine((d) => d.status !== 'cancelled' || !!d.reason?.trim(), {
      message: 'A reason is required to cancel a session',
      path: ['reason'],
    }),
});

export const updateCounsellingSessionSchema = z.object({
  params: idParams,
  body: z
    .object({
      scheduledAt: isoDateTime.optional(),
      notes: z.string().max(2000).optional().nullable(),
      counsellorId: z.string().uuid('Invalid counsellor').optional(),
      sessionType: z.enum(COUNSELLING_SESSION_TYPES).optional(),
    })
    .refine((d) => Object.values(d).some((v) => v !== undefined), {
      message: 'Nothing to update',
    }),
});

export type CreateCounsellingSessionInput = z.infer<typeof createCounsellingSessionSchema>['body'];
export type CounsellingFilter = z.infer<typeof counsellingStatsSchema>['query'];
export type ListCounsellingSessionsQuery = z.infer<typeof listCounsellingSessionsSchema>['query'];
export type UpdateCounsellingStatusInput = z.infer<typeof updateCounsellingStatusSchema>['body'];
export type UpdateCounsellingSessionInput = z.infer<typeof updateCounsellingSessionSchema>['body'];
