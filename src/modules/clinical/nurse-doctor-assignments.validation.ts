import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const createNurseDoctorAssignmentSchema = z.object({
  body: z.object({
    nurseId: z.string().uuid('Invalid nurse ID'),
    doctorIds: z
      .array(z.string().uuid('Invalid doctor ID'))
      .min(1, 'At least one doctor is required')
      .max(50),
    notes: z.string().max(2000).optional(),
  }),
});

export const getNurseDoctorAssignmentsQuerySchema = z.object({
  query: paginationSchema.extend({
    nurseId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    isActive: z.enum(['true', 'false', 'all']).optional(),
  }),
});

export const nurseDoctorAssignmentIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
});

export const endNurseDoctorAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
  body: z.object({
    reason: z.string().max(500).optional(),
  }),
});

export const myPatientsQuerySchema = z.object({
  query: paginationSchema.extend({
    // 'admitted' means "still on the ward" and covers ready_to_discharge too.
    status: z.enum(['admitted', 'discharged', 'all']).optional(),
    type: z.enum(['ip', 'op', 'all']).optional(),
    search: z.string().optional(),
    // OPD: defaults to today. Set explicitly (yyyy-MM-dd) to scope to a different
    // day. Ignored for the IPD branch, which always returns currently-admitted
    // patients regardless of date.
    date: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' })
      .optional(),
  }),
});

export type CreateNurseDoctorAssignmentInput = z.infer<typeof createNurseDoctorAssignmentSchema>['body'];
export type GetNurseDoctorAssignmentsQuery = z.infer<typeof getNurseDoctorAssignmentsQuerySchema>['query'];
export type EndNurseDoctorAssignmentInput = z.infer<typeof endNurseDoctorAssignmentSchema>['body'];
export type MyPatientsQuery = z.infer<typeof myPatientsQuerySchema>['query'];
