import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const createDoctorProfileSchema = z.object({
  body: z.object({
    userId: z.string().uuid('Invalid user ID'),
    departmentId: z.string().uuid('Invalid department ID'),
    specialization: z.string().min(1, 'Specialization is required').max(200),
    qualification: z.string().min(1, 'Qualification is required').max(500),
    experience: z.number().int().min(0).max(70).optional(),
    registrationNumber: z.string().min(1, 'Registration number is required').max(100),
    consultationFee: z.number().positive('Consultation fee must be positive'),
    followUpFee: z.number().positive('Follow-up fee must be positive').optional(),
    bio: z.string().max(2000).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateDoctorScheduleSchema = z.object({
  body: z.object({
    schedules: z.array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6), // 0=Sunday, 6=Saturday
        startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
        endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
        slotDurationMinutes: z.coerce.number().int().min(5).max(120).default(15),
        maxPatients: z.coerce.number().int().positive().max(200).optional().nullable().transform((v) => v ?? undefined),
        isActive: z.boolean().default(true),
      }),
    ).min(1, 'At least one schedule slot is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
});

export const createDoctorLeaveSchema = z.object({
  body: z.object({
    startDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid start date',
    }),
    endDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid end date',
    }),
    reason: z.string().min(1, 'Reason is required').max(500),
    leaveType: z.enum(['vacation', 'sick', 'casual', 'maternity', 'paternity', 'unpaid', 'other']).default('casual'),
    dayType: z.enum(['full_day', 'half_day_morning', 'half_day_afternoon', 'custom_hours']).default('full_day'),
    // Required when dayType === 'custom_hours'. Ignored for other dayTypes.
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format').optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format').optional(),
  }).refine(
    (v) => v.dayType !== 'custom_hours' || (v.startTime && v.endTime && v.startTime < v.endTime),
    { message: 'Custom hours leave requires startTime < endTime', path: ['startTime'] },
  ),
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
});

export const getDoctorLeavesQuerySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const listAllDoctorLeavesQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    doctorId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const doctorLeaveIdParamSchema = z.object({
  params: z.object({
    leaveId: z.string().uuid('Invalid leave ID'),
  }),
});

export const reviewDoctorLeaveSchema = z.object({
  body: z.object({
    reason: z.string().max(500).optional(),
  }),
  params: z.object({
    leaveId: z.string().uuid('Invalid leave ID'),
  }),
});

// ── Schedule Overrides ─────────────────────────────────────

const overrideShiftSchema = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  slotDurationMinutes: z.coerce.number().int().min(5).max(120).default(15),
  maxPatients: z.coerce.number().int().positive().max(200).optional().nullable()
    .transform((v) => v ?? undefined),
});

export const upsertScheduleOverrideSchema = z.object({
  body: z.object({
    date: z.string().refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    isDayOff: z.boolean().default(false),
    note: z.string().max(500).optional(),
    shifts: z.array(overrideShiftSchema).default([]),
  }).refine(
    (v) => v.isDayOff || v.shifts.length > 0,
    { message: 'Either mark as day-off or provide at least one shift', path: ['shifts'] },
  ),
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
});

export const bulkOverrideSchema = z.object({
  body: z.object({
    fromDate: z.string().refine((v) => !isNaN(Date.parse(v))),
    toDate: z.string().refine((v) => !isNaN(Date.parse(v))),
    // Days to apply: 0=Sun..6=Sat. If empty, applies to every date in range.
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    isDayOff: z.boolean().default(false),
    note: z.string().max(500).optional(),
    shifts: z.array(overrideShiftSchema).default([]),
    // If true, skip dates that already have overrides. If false, replace them.
    skipExisting: z.boolean().default(false),
  }).refine(
    (v) => v.isDayOff || v.shifts.length > 0,
    { message: 'Either mark as day-off or provide at least one shift', path: ['shifts'] },
  ),
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
});

export const listOverridesQuerySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const overrideIdParamSchema = z.object({
  params: z.object({
    overrideId: z.string().uuid('Invalid override ID'),
  }),
});

export const bookAppointmentSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    appointmentDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid appointment date',
    }),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
    type: z.enum(['consultation', 'follow_up', 'emergency', 'procedure', 'telemedicine']).default('consultation'),
    reason: z.string().max(1000).optional(),
    notes: z.string().max(2000).optional(),
    priority: z.enum(['normal', 'urgent', 'emergency']).default('normal'),
    /**
     * The front desk's call on the one-time registration fee. Omit it and the
     * rule decides at bill time (charge iff this is the patient's first visit
     * here and it has not been taken before) — which is what happens for a
     * portal booking, where there is no desk to ask.
     */
    chargeRegistrationFee: z.boolean().optional(),
  }),
});

export const updateAppointmentStatusSchema = z.object({
  body: z.object({
    status: z.enum([
      'pending_payment',
      'booked',
      'confirmed',
      'checked_in',
      'in_consultation',
      'completed',
      'cancelled',
      'no_show',
    ]),
    notes: z.string().max(1000).optional(),
    cancellationReason: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid appointment ID'),
  }),
});

export const createQueueTokenSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid appointment ID'),
  }),
});

/**
 * In-place reschedule: move an existing appointment to a new date/slot without
 * cancelling + re-creating it, so the bill, queue token and history stay
 * attached to the same appointment row.
 */
export const rescheduleAppointmentSchema = z.object({
  body: z.object({
    appointmentDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid appointment date',
    }),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    reason: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid appointment ID'),
  }),
});

/**
 * Walk-in / register-patient checkout. `collectNow` false means the counter
 * raises the bill but takes the money later — it stays payable from the queue.
 */
export const frontdeskCheckoutSchema = z.object({
  body: z.object({
    collectNow: z.boolean().default(true),
    paymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'upi', 'net_banking', 'cheque', 'other'])
      .optional(),
    /** Defaults to the full balance due when omitted (part-payment otherwise). */
    amount: z.number().positive().optional(),
    referenceNumber: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid appointment ID'),
  }),
});

export const getAppointmentsQuerySchema = z.object({
  query: paginationSchema.extend({
    date: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    doctorId: z.string().uuid().optional(),
    doctorUserId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    search: z.string().optional(),
    status: z
      .enum([
        'pending_payment',
        'booked',
        'confirmed',
        'checked_in',
        'in_consultation',
        'completed',
        'cancelled',
        'no_show',
      ])
      .optional(),
    type: z
      .enum(['consultation', 'follow_up', 'emergency', 'procedure', 'telemedicine'])
      .optional(),
  }),
});

export const getDoctorProfilesQuerySchema = z.object({
  query: paginationSchema.extend({
    departmentId: z.string().uuid().optional(),
    specialization: z.string().optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const doctorIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
});

/**
 * Raising the counter bill, with the desk's explicit registration-fee call.
 * Omitting the flag leaves it to the rule (first visit + hospital setting).
 */
export const frontdeskPaymentSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid appointment ID') }),
  body: z
    .object({ chargeRegistrationFee: z.boolean().optional() })
    .optional()
    .default({}),
});

export const appointmentIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid appointment ID'),
  }),
});

export const slotsQuerySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
  }),
  query: z.object({
    date: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid date',
    }),
  }),
});

export const queueQuerySchema = z.object({
  params: z.object({
    doctorId: z.string().uuid('Invalid doctor ID'),
  }),
  query: z.object({
    date: z.string().optional(),
  }),
});

export type CreateDoctorProfileInput = z.infer<typeof createDoctorProfileSchema>['body'];
export type UpdateDoctorScheduleInput = z.infer<typeof updateDoctorScheduleSchema>['body'];
export type CreateDoctorLeaveInput = z.infer<typeof createDoctorLeaveSchema>['body'];
export type GetDoctorLeavesQuery = z.infer<typeof getDoctorLeavesQuerySchema>['query'];
export type ListAllDoctorLeavesQuery = z.infer<typeof listAllDoctorLeavesQuerySchema>['query'];
export type UpsertScheduleOverrideInput = z.infer<typeof upsertScheduleOverrideSchema>['body'];
export type BulkOverrideInput = z.infer<typeof bulkOverrideSchema>['body'];
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>['body'];
export type UpdateAppointmentStatusInput = z.infer<typeof updateAppointmentStatusSchema>['body'];
export type GetAppointmentsQuery = z.infer<typeof getAppointmentsQuerySchema>['query'];
export type GetDoctorProfilesQuery = z.infer<typeof getDoctorProfilesQuerySchema>['query'];
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>['body'];
export type FrontdeskCheckoutInput = z.infer<typeof frontdeskCheckoutSchema>['body'];
