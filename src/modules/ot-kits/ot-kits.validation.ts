import { z } from 'zod';

const kitItem = z.object({
  drugFormularyId: z.string().uuid('Invalid drug ID'),
  quantity: z.number().int().positive('Quantity must be positive'),
});

export const createKitTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Kit name is required').max(160),
    surgeryType: z.string().max(160).optional(),
    doctorId: z.string().uuid().optional(),
    description: z.string().max(1000).optional(),
    items: z.array(kitItem).min(1, 'A kit needs at least one item'),
  }),
});

export const updateKitTemplateSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid template id') }),
  body: z.object({
    name: z.string().min(1).max(160).optional(),
    surgeryType: z.string().max(160).optional().nullable(),
    doctorId: z.string().uuid().optional().nullable(),
    description: z.string().max(1000).optional().nullable(),
    isActive: z.boolean().optional(),
    items: z.array(kitItem).min(1).optional(),
  }),
});

export const issueKitSchema = z.object({
  body: z
    .object({
      patientId: z.string().uuid('Invalid patient'),
      admissionId: z.string().uuid().optional(),
      templateId: z.string().uuid().optional(),
      surgeryName: z.string().min(1, 'A surgery name is required').max(200),
      items: z.array(kitItem).optional(),
    })
    .refine((b) => !!b.templateId || (b.items?.length ?? 0) > 0, {
      message: 'Provide a kit template or at least one custom item',
      path: ['templateId'],
    }),
});

export const reconcileKitSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid issue id') }),
  body: z.object({
    returns: z
      .array(z.object({ itemId: z.string().uuid('Invalid item id'), returnedQty: z.number().int().nonnegative() }))
      .optional(),
  }),
});

export const listIssuesQuerySchema = z.object({
  query: z.object({
    status: z.enum(['issued', 'reconciled', 'cancelled']).optional(),
    patientId: z.string().uuid().optional(),
  }),
});
