import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// --- Progress Note Schemas ---

export const createProgressNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    noteType: z
      .enum([
        'complaint',
        'vitals',
        'investigation',
        'discussion',
        'impression',
        'advice',
        'general',
      ])
      .optional(),
    content: z.string().min(1, 'Content is required').max(10000),
    pinToDischargeSummary: z.boolean().default(false),
  }),
});

export const updateProgressNoteSchema = z.object({
  body: z.object({
    noteType: z
      .enum([
        'complaint',
        'vitals',
        'investigation',
        'discussion',
        'impression',
        'advice',
        'general',
      ])
      .optional(),
    content: z.string().min(1).max(10000).optional(),
    pinToDischargeSummary: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

export const listProgressNotesSchema = z.object({
  query: paginationSchema.extend({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    noteType: z
      .enum([
        'complaint',
        'vitals',
        'investigation',
        'discussion',
        'impression',
        'advice',
        'general',
      ])
      .optional(),
    status: z.enum(['active', 'finalized']).optional(),
  }),
});

export const progressNoteIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

export const signProgressNoteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid progress note ID'),
  }),
});

// --- Nursing Note Schemas ---

export const createNursingNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    noteType: z.enum(['observation', 'wound_care', 'general']).optional(),
    content: z.string().min(1, 'Content is required').max(10000),
  }),
});

export const updateNursingNoteSchema = z.object({
  body: z.object({
    noteType: z.enum(['observation', 'wound_care', 'general']).optional(),
    content: z.string().min(1).max(10000).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid nursing note ID'),
  }),
});

export const listNursingNotesSchema = z.object({
  query: paginationSchema.extend({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    noteType: z.enum(['observation', 'wound_care', 'general']).optional(),
  }),
});

export const nursingNoteIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid nursing note ID'),
  }),
});

// --- Exported Types ---

export type CreateProgressNoteInput = z.infer<typeof createProgressNoteSchema>['body'];
export type UpdateProgressNoteInput = z.infer<typeof updateProgressNoteSchema>['body'];
export type ListProgressNotesQuery = z.infer<typeof listProgressNotesSchema>['query'];

export type CreateNursingNoteInput = z.infer<typeof createNursingNoteSchema>['body'];
export type UpdateNursingNoteInput = z.infer<typeof updateNursingNoteSchema>['body'];
export type ListNursingNotesQuery = z.infer<typeof listNursingNotesSchema>['query'];
