import { z } from 'zod';
import { booleanQueryParam } from '../../shared/pagination';

const templateItem = z.object({
  drugFormularyId: z.string().uuid(),
  defaultQuantity: z.number().int().positive(),
  notes: z.string().max(300).optional(),
});

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(160),
    procedureName: z.string().max(200).optional(),
    doctorId: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
    items: z.array(templateItem).min(1),
  }),
});

export const updateTemplateSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).max(160).optional(),
    procedureName: z.string().max(200).nullable().optional(),
    doctorId: z.string().uuid().nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    items: z.array(templateItem).min(1).optional(),
  }),
});

export const templateIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const listTemplatesQuerySchema = z.object({
  query: z.object({
    search: z.string().optional(),
    doctorId: z.string().uuid().optional(),
    includeInactive: booleanQueryParam.optional(),
  }),
});

export const requestKitSchema = z.object({
  body: z.object({
    otRequestId: z.string().uuid().optional(),
    patientId: z.string().uuid(),
    visitId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const issueKitSchema = z.object({
  body: z
    .object({
      issueId: z.string().uuid().optional(),
      otRequestId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      visitId: z.string().uuid().optional(),
      templateId: z.string().uuid().optional(),
      items: z
        .array(z.object({ drugFormularyId: z.string().uuid(), quantity: z.number().int().positive() }))
        .optional(),
      notes: z.string().max(1000).optional(),
    })
    .refine((b) => b.issueId || b.patientId, { message: 'issueId or patientId is required' }),
});

export const reconcileKitSchema = z.object({
  body: z.object({
    issueId: z.string().uuid(),
    returns: z
      .array(z.object({ itemId: z.string().uuid(), returnedQty: z.number().int().min(0) }))
      .optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const cancelKitSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(500).optional() }),
});

export const issueIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const listIssuesQuerySchema = z.object({
  query: z.object({
    status: z.enum(['requested', 'issued', 'reconciled', 'cancelled']).optional(),
    patientId: z.string().uuid().optional(),
    otRequestId: z.string().uuid().optional(),
  }),
});
