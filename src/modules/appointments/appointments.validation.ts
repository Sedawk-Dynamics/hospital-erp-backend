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
        slotDurationMinutes: z.number().int().min(5).max(120).default(15),
        maxPatients: z.number().int().positive().max(200).optional(),
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
    leaveType: z.enum(['full_day', 'half_day_morning', 'half_day_afternoon']).default('full_day'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid doctor ID'),
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
  }),
});

export const updateAppointmentStatusSchema = z.object({
  body: z.object({
    status: z.enum([
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

export const getAppointmentsQuerySchema = z.object({
  query: paginationSchema.extend({
    date: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    doctorId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    status: z
      .enum([
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
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>['body'];
export type UpdateAppointmentStatusInput = z.infer<typeof updateAppointmentStatusSchema>['body'];
export type GetAppointmentsQuery = z.infer<typeof getAppointmentsQuerySchema>['query'];
export type GetDoctorProfilesQuery = z.infer<typeof getDoctorProfilesQuerySchema>['query'];
