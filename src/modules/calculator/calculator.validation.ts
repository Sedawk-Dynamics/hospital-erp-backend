import { z } from 'zod';

const calculatorVariableSchema = z.object({
  variableId: z
    .string()
    .trim()
    .min(1, 'Variable ID is required')
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Use letters, numbers and underscore; must not start with a number'),
  name: z.string().trim().min(1, 'Variable name is required'),
  unit: z.string().trim().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.number().optional(),
});


const calculatorBandSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  label: z.string().trim().min(1, 'Band label is required'),
  color: z.enum(['emerald', 'amber', 'rose', 'sky', 'gray']),
  recommendation: z.string().trim().optional(),
});

const calculatorFields = {
  name: z.string().trim().min(1, 'Name is required').max(255),
  description: z.string().trim().optional(),
  expression: z.string().trim().min(1, 'Expression is required'),
  resultUnit: z.string().trim().max(50).optional(),
  resultDecimals: z.number().int().min(0).max(6).default(2),
  scope: z.enum(['personal', 'shared']).default('personal'),
  variables: z.array(calculatorVariableSchema).min(1, 'Add at least one variable'),
  bands: z.array(calculatorBandSchema).default([]),
};

export const createCalculatorSchema = z.object({
  body: z.object(calculatorFields),
});

export const updateCalculatorSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid calculator id') }),
  body: z.object(calculatorFields).partial(),
});

export const listCalculatorsSchema = z.object({
  query: z.object({
    scope: z.enum(['personal', 'shared']).optional(),
    specialty: z.string().trim().optional(),
    search: z.string().trim().optional(),
  }),
});

export type CreateCalculatorInput = z.infer<typeof createCalculatorSchema>['body'];
export type UpdateCalculatorInput = z.infer<typeof updateCalculatorSchema>['body'];
export type ListCalculatorsQuery = z.infer<typeof listCalculatorsSchema>['query'];
