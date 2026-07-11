import { z } from 'zod';

const indentItem = z.object({
  drugFormularyId: z.string().uuid(),
  requestedQty: z.number().int().positive(),
  saleUnit: z.enum(['pack', 'loose']).optional(),
  notes: z.string().max(300).optional(),
});

export const raiseIndentSchema = z.object({
  body: z.object({
    patientId: z.string().uuid(),
    admissionId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    prescriptionId: z.string().uuid().optional(),
    isTto: z.boolean().optional(),
    priority: z.string().max(20).optional(),
    notes: z.string().max(1000).optional(),
    items: z.array(indentItem).min(1),
  }),
});

export const approveIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    approvals: z.array(z.object({ itemId: z.string().uuid(), approvedQty: z.number().int().min(0) })).optional(),
    override: z.boolean().optional(),
  }),
});

export const dispenseIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    batches: z.array(z.object({ itemId: z.string().uuid(), drugBatchId: z.string().uuid() })).optional(),
  }),
});

export const returnIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    items: z.array(z.object({ itemId: z.string().uuid(), returnQty: z.number().int().positive() })).min(1),
    reason: z.string().max(500).optional(),
  }),
});

export const confirmIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    items: z.array(indentItem).optional(),
    priority: z.string().max(20).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const acknowledgeIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ itemIds: z.array(z.string().uuid()).optional() }),
});

export const cancelIndentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(500).optional() }),
});

export const indentIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const ttoFromPrescriptionSchema = z.object({
  params: z.object({ prescriptionId: z.string().uuid() }),
});

export const listIndentsQuerySchema = z.object({
  query: z.object({
    status: z.enum(['draft', 'raised', 'approved', 'dispensed', 'delivered', 'acknowledged', 'cancelled']).optional(),
    patientId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    isTto: z.coerce.boolean().optional(),
  }),
});
