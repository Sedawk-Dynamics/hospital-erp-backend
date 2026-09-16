import { z } from 'zod';
import { paginationSchema, booleanQueryParam } from '../../shared/pagination';

// ── Time Slot Master ─────────────────────────────────────────

export const createTimeSlotSchema = z.object({
  body: z.object({
    code: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:mm'),
    sortOrder: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
  }),
});

export const updateTimeSlotSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    code: z.string().min(1).max(40).optional(),
    label: z.string().min(1).max(80).optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const timeSlotIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ── Frequency Master ─────────────────────────────────────────

export const createFrequencySchema = z.object({
  body: z.object({
    code: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    type: z.enum(['slot', 'interval', 'once', 'prn']),
    slotCodes: z.array(z.string().max(40)).default([]),
    intervalHours: z.number().int().min(1).max(48).optional(),
    minPrnIntervalMinutes: z.number().int().min(0).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateFrequencySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    code: z.string().min(1).max(40).optional(),
    label: z.string().min(1).max(120).optional(),
    type: z.enum(['slot', 'interval', 'once', 'prn']).optional(),
    slotCodes: z.array(z.string().max(40)).optional(),
    intervalHours: z.number().int().min(1).max(48).optional().nullable(),
    minPrnIntervalMinutes: z.number().int().min(0).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
});

export const frequencyIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ── Settings ─────────────────────────────────────────────────

export const updateSettingsSchema = z.object({
  body: z.object({
    gracePeriodMinutes: z.number().int().min(0).max(1440).optional(),
    defaultPrnMinIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  }),
});

// ── Schedule listing ─────────────────────────────────────────

export const listSchedulesQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    status: z
      .union([
        z.enum(['pending', 'due', 'overdue', 'given', 'given_late', 'missed', 'held', 'refused', 'cancelled']),
        z.array(z.enum(['pending', 'due', 'overdue', 'given', 'given_late', 'missed', 'held', 'refused', 'cancelled'])),
      ])
      .optional(),
    includePrn: booleanQueryParam.optional(),
  }),
});

export const scheduleIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const prescriptionItemIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ── Dose actions ─────────────────────────────────────────────

export const ndpsPatientDoseSchema = z.object({
  drugBatchId: z.string().uuid('Select the administered batch'),
  ndpsLocationId: z.string().uuid('Select the NDPS custody location'),
  labelledQuantity: z.number().positive().max(1_000_000),
  administeredQuantity: z.number().positive().max(1_000_000),
  quantityUnit: z.string().trim().min(1).max(20),
  containerQuantity: z.number().int().positive().max(100).default(1),
  disposition: z.enum(['none', 'quarantined']).optional(),
  residualHandling: z.enum(['pending_destruction', 'sealed_quarantine']).optional(),
  quarantineLocation: z.string().trim().min(1).max(160).optional(),
  prescriberRegistrationNumber: z.string().trim().min(1).max(100).optional(),
  emergencyUse: z.boolean().optional(),
  emergencyReason: z.string().trim().min(1).max(1000).optional(),
  notes: z.string().max(1000).optional(),
});

export const giveDoseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    actualGivenTime: z.string().datetime().optional(), // server-side default = now
    notes: z.string().max(1000).optional(),
    ndps: ndpsPatientDoseSchema.optional(),
  }),
});

export const holdRefuseDoseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().min(1, 'Reason is required').max(500),
    notes: z.string().max(1000).optional(),
  }),
});

export const missedDoseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

/// Amend a previously logged dose (e.g., missed → given_late, or correct an earlier action).
/// `actualGivenTime` is mandatory when amending to given/given_late so delayMinutes can be computed.
export const amendDoseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    toStatus: z.enum(['given', 'given_late', 'missed', 'held', 'refused']),
    actualGivenTime: z.string().datetime().optional(),
    reason: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
    ndps: ndpsPatientDoseSchema.optional(),
  }),
});

// ── PRN trigger ──────────────────────────────────────────────

export const triggerPrnSchema = z.object({
  params: z.object({ prescriptionItemId: z.string().uuid() }),
  body: z.object({
    actualGivenTime: z.string().datetime().optional(),
    notes: z.string().max(1000).optional(),
    ndps: ndpsPatientDoseSchema.optional(),
  }),
});

// ── Catch-up dose (materialize a skipped slot + record its outcome) ──

export const catchUpDoseSchema = z.object({
  body: z.object({
    prescriptionItemId: z.string().uuid(),
    slotCode: z.string().min(1).max(40),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    action: z.enum(['give', 'hold', 'refuse', 'missed']),
    actualGivenTime: z.string().datetime().optional(),
    reason: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
    ndps: ndpsPatientDoseSchema.optional(),
  }),
});

// ── Regenerate schedules ─────────────────────────────────────

export const regenerateSchedulesSchema = z.object({
  params: z.object({ prescriptionId: z.string().uuid() }),
});

export const auditQuerySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ── Type exports ─────────────────────────────────────────────

export type CreateTimeSlotInput = z.infer<typeof createTimeSlotSchema>['body'];
export type UpdateTimeSlotInput = z.infer<typeof updateTimeSlotSchema>['body'];
export type CreateFrequencyInput = z.infer<typeof createFrequencySchema>['body'];
export type UpdateFrequencyInput = z.infer<typeof updateFrequencySchema>['body'];
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>['body'];
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>['query'];
export type GiveDoseInput = z.infer<typeof giveDoseSchema>['body'];
export type HoldRefuseDoseInput = z.infer<typeof holdRefuseDoseSchema>['body'];
export type MissedDoseInput = z.infer<typeof missedDoseSchema>['body'];
export type AmendDoseInput = z.infer<typeof amendDoseSchema>['body'];
export type TriggerPrnInput = z.infer<typeof triggerPrnSchema>['body'];
export type CatchUpDoseInput = z.infer<typeof catchUpDoseSchema>['body'];
