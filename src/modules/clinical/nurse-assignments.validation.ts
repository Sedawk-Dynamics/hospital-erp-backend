import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

const shiftType = z.enum(['morning', 'afternoon', 'night', 'general']);

const dateString = z.string().refine((val) => !isNaN(Date.parse(val)), {
  message: 'Invalid date',
});

export const createNurseAssignmentSchema = z.object({
  body: z.object({
    admissionId: z.string().uuid('Invalid admission ID'),
    nurseId: z.string().uuid('Invalid nurse ID'),
    shiftDate: dateString,
    shiftType,
    bedId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const getNurseAssignmentsQuerySchema = z.object({
  query: paginationSchema.extend({
    wardId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    nurseId: z.string().uuid().optional(),
    shiftDate: z.string().optional(),
    shiftType: shiftType.optional(),
    status: z.enum(['active', 'ended', 'handed_over', 'cancelled']).optional(),
  }),
});

export const nurseAssignmentIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
});

export const updateNurseAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
  body: z.object({
    nurseId: z.string().uuid().optional(),
    bedId: z.string().uuid().nullable().optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const endNurseAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
  body: z.object({
    reason: z.string().max(500).optional(),
  }),
});

export const handoverNurseAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
  body: z.object({
    toNurseId: z.string().uuid('Invalid recipient nurse ID'),
    toShiftType: shiftType,
    toShiftDate: dateString.optional(),
    handoverNoteId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const handoverFeedQuerySchema = z.object({
  query: z.object({
    shiftDate: z.string().optional(),
    shiftType: shiftType.optional(),
    lookbackHours: z.coerce.number().int().min(1).max(168).optional(),
    // Admin can pass a userId to inspect another nurse's feed; falls back to
    // the authenticated user when omitted.
    userId: z.string().uuid().optional(),
  }),
});

export const bulkHandoverSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    shiftDate: dateString,
    fromShiftType: shiftType,
    toShiftType: shiftType,
    toShiftDate: dateString.optional(),
    handoverNoteId: z.string().uuid().optional(),
    mapping: z
      .array(
        z.object({
          fromNurseId: z.string().uuid(),
          toNurseId: z.string().uuid(),
        }),
      )
      .min(1)
      .max(100),
  }),
});

export type CreateNurseAssignmentInput = z.infer<typeof createNurseAssignmentSchema>['body'];
export type GetNurseAssignmentsQuery = z.infer<typeof getNurseAssignmentsQuerySchema>['query'];
export type UpdateNurseAssignmentInput = z.infer<typeof updateNurseAssignmentSchema>['body'];
export type EndNurseAssignmentInput = z.infer<typeof endNurseAssignmentSchema>['body'];
export type HandoverNurseAssignmentInput = z.infer<typeof handoverNurseAssignmentSchema>['body'];
export type BulkHandoverInput = z.infer<typeof bulkHandoverSchema>['body'];
export type HandoverFeedQuery = z.infer<typeof handoverFeedQuerySchema>['query'];
