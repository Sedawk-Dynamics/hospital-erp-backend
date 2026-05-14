import { z } from 'zod';

export const validatePrescriptionSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    items: z
      .array(
        z.object({
          drugName: z.string().min(1, 'Drug name required'),
          dosage: z.string().optional(),
          frequency: z.string().optional(),
          route: z.string().optional(),
        }),
      )
      .min(1, 'At least one item required'),
  }),
});

export const orderSuggestionsSchema = z.object({
  query: z.object({
    icdCode: z.string().optional(),
    diagnosisName: z.string().optional(),
  }),
});

export const evaluateLabResultsSchema = z.object({
  body: z.object({
    labOrderId: z.string().uuid('Invalid lab order ID').optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    results: z
      .array(
        z.object({
          parameterName: z.string().min(1),
          value: z.union([z.string(), z.number()]),
          unit: z.string().optional(),
        }),
      )
      .min(1),
  }),
});

export const alertsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
    type: z.enum(['critical_value', 'drug_interaction', 'allergy', 'dosage', 'all']).default('all'),
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export type ValidatePrescriptionInput = z.infer<typeof validatePrescriptionSchema>['body'];
export type OrderSuggestionsQuery = z.infer<typeof orderSuggestionsSchema>['query'];
export type EvaluateLabResultsInput = z.infer<typeof evaluateLabResultsSchema>['body'];
export type AlertsQuery = z.infer<typeof alertsQuerySchema>['query'];
