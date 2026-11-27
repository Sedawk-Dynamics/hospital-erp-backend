import { z } from 'zod';
import { ESCALATION_REQUEST_TYPES, MAX_ESCALATION_HOURS, MIN_CLOSE_REASON_LENGTH } from './insurance.escalation';

// Gap 293 — merging a duplicate insurer / TPA into the record to keep.
export const mergePayerSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ID') }),
  body: z.object({ keepId: z.string().uuid('Pick the record to keep') }),
});

export const mergePayerPreviewSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ID') }),
  query: z.object({ keepId: z.string().uuid('Pick the record to keep') }),
});

// Gap 294 — per-hospital SLA escalation rules.
export const escalationSettingItemSchema = z.object({
  requestType: z.enum(ESCALATION_REQUEST_TYPES),
  escalateAfterHours: z.coerce
    .number()
    .int('Hours must be a whole number')
    .gt(0, 'Hours must be greater than 0')
    .max(MAX_ESCALATION_HOURS, `Hours cannot exceed ${MAX_ESCALATION_HOURS}`),
  targetRole: z.string().trim().min(1, 'Pick the role to escalate to').max(50),
});

export const updateEscalationSettingsSchema = z.object({
  body: z.object({
    settings: z.array(escalationSettingItemSchema).min(1, 'Nothing to save').max(ESCALATION_REQUEST_TYPES.length),
  }),
});

// Gap 294 — closing an overdue pre-authorisation as stale. Reason mandatory.
export const closeStalePreAuthSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid pre-auth request ID') }),
  body: z.object({
    reason: z
      .string({ required_error: 'A reason is required' })
      .trim()
      .min(MIN_CLOSE_REASON_LENGTH, `Give a reason of at least ${MIN_CLOSE_REASON_LENGTH} characters`)
      .max(1000),
  }),
});

/** Gap 294 (retest): close a stale payer query — reason required. */
export const closeStaleClaimQuerySchema = z.object({
  params: z.object({ queryId: z.string().uuid('Invalid claim query ID') }),
  body: z.object({
    reason: z
      .string({ required_error: 'A reason is required' })
      .trim()
      .min(MIN_CLOSE_REASON_LENGTH, `Give a reason of at least ${MIN_CLOSE_REASON_LENGTH} characters`)
      .max(1000),
  }),
});
