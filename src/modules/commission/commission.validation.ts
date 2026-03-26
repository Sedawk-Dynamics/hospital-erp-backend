import { z } from 'zod';

export const updateDefaultCommissionSchema = z.object({
  body: z.object({
    defaultPercent: z.coerce.number().min(0).max(50),
    minPercent: z.coerce.number().min(0).max(50).optional(),
    maxPercent: z.coerce.number().min(0).max(100).optional(),
  }),
});

export const setHospitalCommissionSchema = z.object({
  body: z.object({
    commissionPercent: z.coerce.number().min(0).max(50),
    notes: z.string().optional(),
  }),
  params: z.object({
    tenantId: z.string().uuid(),
  }),
});

export const hospitalCommissionParamsSchema = z.object({
  params: z.object({
    tenantId: z.string().uuid(),
  }),
});

export type UpdateDefaultCommissionInput = z.infer<typeof updateDefaultCommissionSchema>['body'];
export type SetHospitalCommissionInput = z.infer<typeof setHospitalCommissionSchema>['body'];
