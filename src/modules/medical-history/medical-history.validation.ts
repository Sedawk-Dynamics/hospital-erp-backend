import { z } from 'zod';

const nullableStr = (max = 1000) => z.string().max(max).optional().nullable();

export const upsertPersonalHistorySchema = z.object({
  body: z.object({
    appetite: nullableStr(500),
    diet: nullableStr(500),
    sleepPattern: nullableStr(500),
    disorders: nullableStr(2000),
    pastMedicalHistory: nullableStr(5000),
    pastSurgicalHistory: nullableStr(5000),
    exerciseHabits: nullableStr(500),
    smokingStatus: z.enum(['never', 'former', 'current']).optional().nullable(),
    alcoholConsumption: z.enum(['none', 'occasional', 'moderate', 'heavy']).optional().nullable(),
    notes: nullableStr(2000),
  }),
});

export const familyHistorySchema = z.object({
  body: z.object({
    conditionName: z.string().min(1).max(255),
    relationSide: z.enum(['maternal', 'paternal']),
    relationship: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const familyHistoryUpdateSchema = z.object({
  body: z.object({
    conditionName: z.string().min(1).max(255).optional(),
    relationSide: z.enum(['maternal', 'paternal']).optional(),
    relationship: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const allergySchema = z.object({
  body: z.object({
    allergen: z.string().min(1).max(255),
    allergyType: z.enum(['drug', 'food', 'environmental', 'other']),
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).optional(),
    reaction: z.string().max(500).optional(),
  }),
});

export const allergyUpdateSchema = z.object({
  body: z.object({
    allergen: z.string().min(1).max(255).optional(),
    allergyType: z.enum(['drug', 'food', 'environmental', 'other']).optional(),
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).optional(),
    reaction: z.string().max(500).optional(),
  }),
});

const dateStr = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid date' })
  .optional();

export const currentMedicationSchema = z.object({
  body: z.object({
    drugName: z.string().min(1).max(255),
    dosage: z.string().max(100).optional(),
    frequency: z.string().max(100).optional(),
    route: z.string().max(50).optional(),
    startedOn: dateStr,
    source: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const currentMedicationUpdateSchema = z.object({
  body: z.object({
    drugName: z.string().min(1).max(255).optional(),
    dosage: z.string().max(100).optional(),
    frequency: z.string().max(100).optional(),
    route: z.string().max(50).optional(),
    startedOn: dateStr,
    source: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
    isActive: z.boolean().optional(),
  }),
});
