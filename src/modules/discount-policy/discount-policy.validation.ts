import { z } from 'zod';

// ============================================================
// Margin-based system-wide discount — validation (separate module)
// ============================================================

export const updateConfigSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    // 'cap' enforces the matched band's discount as a ceiling at the POS;
    // 'suggest' only displays it. (Decided design: cap + visual hint.)
    mode: z.enum(['cap', 'suggest']).optional(),
  }),
});

// Shared field validators for a margin→discount band.
const label = z.string().min(1, 'Label is required').max(80);
const marginPct = z.number().min(-100).max(10000);
const discountPct = z.number().min(0).max(100);

export const createRuleSchema = z.object({
  body: z
    .object({
      label,
      minMarginPercent: marginPct,
      // null / omitted = open-ended ("this margin and above").
      maxMarginPercent: marginPct.nullable().optional(),
      maxDiscountPercent: discountPct,
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().min(0).optional(),
    })
    .refine((d) => d.maxMarginPercent == null || d.maxMarginPercent >= d.minMarginPercent, {
      message: 'Upper margin must be greater than or equal to lower margin',
      path: ['maxMarginPercent'],
    }),
});

export const updateRuleSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid rule ID') }),
  body: z.object({
    label: label.optional(),
    minMarginPercent: marginPct.optional(),
    maxMarginPercent: marginPct.nullable().optional(),
    maxDiscountPercent: discountPct.optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  }),
});

export const ruleIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid rule ID') }),
});

export const evaluateQuerySchema = z.object({
  query: z.object({
    // The item's profit margin %, e.g. from batch economics. Coerced from string.
    margin: z.coerce.number(),
  }),
});

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>['body'];
export type CreateRuleInput = z.infer<typeof createRuleSchema>['body'];
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>['body'];
