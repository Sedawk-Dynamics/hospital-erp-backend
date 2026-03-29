import { z } from 'zod';

// ==================== Discharge Summary ====================

export const generateDischargeSummarySchema = z.object({
  query: z.object({
    admissionId: z.string().uuid('Invalid admission ID'),
  }),
});

export const getDischargeSummaryByIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid discharge summary ID'),
  }),
});

export const getDischargeSummaryByAdmissionSchema = z.object({
  params: z.object({
    admissionId: z.string().uuid('Invalid admission ID'),
  }),
});

export const updateDischargeSummarySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid discharge summary ID'),
  }),
  body: z.object({
    diagnosesSummary: z.string().optional(),
    proceduresSummary: z.string().optional(),
    labResultsSummary: z.string().optional(),
    medicationReconciliation: z.string().optional(),
    dischargeInstructions: z.string().optional(),
    followUpDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid follow-up date' })
      .optional(),
    followUpInstructions: z.string().optional(),
  }),
});

export const dischargeSummaryIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid discharge summary ID'),
  }),
});
