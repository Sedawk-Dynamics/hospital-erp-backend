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

export const patientIdParamSchema = z.object({
  params: z.object({ patientId: z.string().uuid('Invalid patient ID') }),
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
    // "After 3 months" — an interval instead of a fixed day. Nullable so a
    // doctor switching back to a real date can clear it.
    followUpAfterValue: z.number().int().positive().max(365).optional().nullable(),
    followUpAfterUnit: z.enum(['days', 'weeks', 'months']).optional().nullable(),
    followUpInstructions: z.string().optional(),
  }),
});

export const dischargeSummaryIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid discharge summary ID'),
  }),
});

export const signDischargeSummarySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid discharge summary ID'),
  }),
  body: z
    .object({
      signatureName: z.string().trim().min(1).max(255).optional(),
    })
    .optional(),
});
