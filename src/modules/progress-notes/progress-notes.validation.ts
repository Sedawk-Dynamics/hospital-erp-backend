import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// --- Progress Note Schemas ---

const progressNoteTypeEnum = z.enum([
  'complaint',
  'vitals',
  'investigation',
  'discussion',
  'impression',
  'advice',
  'general',
]);

const customFieldSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(5000).optional().default(''),
});

export const createProgressNoteSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    noteType: progressNoteTypeEnum.optional(),
    content: z.string().min(1, 'Content is required').max(10000),
    impressions: z.string().max(10000).optional().nullable(),
    discussions: z.string().max(10000).optional().nullable(),
    conclusions: z.string().max(10000).optional().nullable(),
    customFields: z.array(customFieldSchema).max(50).optional(),
    weightKgAtEntry: z.number().positive().max(999.99).optional().nullable(),
    pinToDischargeSummary: z.boolean().default(false),
  }),
});

export const updateProgressNoteSchema = z.object({
  body: z.object({
    noteType: progressNoteTypeEnum.optional(),
    content: z.string().min(1).max(10000).optional(),
    impressions: z.string().max(10000).optional().nullable(),
    discussions: z.string().max(10000).optional().nullable(),
    conclusions: z.string().max(10000).optional().nullable(),
    customFields: z.array(customFieldSchema).max(50).optional(),
    weightKgAtEntry: z.number().positive().max(999.99).optional().nullable(),
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
    noteType: progressNoteTypeEnum.optional(),
    status: z.enum(['active', 'finalized', 'archived']).optional(),
    includeArchived: z
      .union([z.boolean(), z.string()])
      .transform((v) => v === true || v === 'true')
      .optional(),
  }),
});

// --- Progress Note Template Schemas ---

const templateFieldSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'textarea', 'number']).default('text'),
  defaultValue: z.string().max(1000).optional(),
});

export const createProgressNoteTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    fields: z.array(templateFieldSchema).min(1).max(50),
    isDefault: z.boolean().optional().default(false),
  }),
});

export const updateProgressNoteTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120).optional(),
    fields: z.array(templateFieldSchema).min(1).max(50).optional(),
    isDefault: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid template ID'),
  }),
});

export const templateIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid template ID'),
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
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
    content: z.string().min(1, 'Content is required').max(10000),
    metadata: z.any().optional(),
  }),
});

export const updateNursingNoteSchema = z.object({
  body: z.object({
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
    content: z.string().min(1).max(10000).optional(),
    metadata: z.any().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid nursing note ID'),
  }),
});

export const listNursingNotesSchema = z.object({
  query: paginationSchema.extend({
    visitId: z.string().uuid('Invalid visit ID').optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    noteType: z.enum(['observation', 'wound_care', 'iv_line', 'intake_output', 'general']).optional(),
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

export type CreateProgressNoteTemplateInput = z.infer<typeof createProgressNoteTemplateSchema>['body'];
export type UpdateProgressNoteTemplateInput = z.infer<typeof updateProgressNoteTemplateSchema>['body'];

export type CreateNursingNoteInput = z.infer<typeof createNursingNoteSchema>['body'];
export type UpdateNursingNoteInput = z.infer<typeof updateNursingNoteSchema>['body'];
export type ListNursingNotesQuery = z.infer<typeof listNursingNotesSchema>['query'];
