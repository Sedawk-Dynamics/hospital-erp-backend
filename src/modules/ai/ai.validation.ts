import { z } from 'zod';

// Super-admin update of the platform AI config. All fields optional (partial).
export const updateAiConfigSchema = z.object({
  body: z.object({
    provider: z.enum(['gemini', 'openai', 'disabled']).optional(),
    textModel: z.string().trim().min(1).max(100).optional(),
    temperature: z.coerce.number().min(0).max(2).optional(),
    maxOutputTokens: z.coerce.number().int().min(64).max(8192).optional(),
    patientChatEnabled: z.boolean().optional(),
    platformChatEnabled: z.boolean().optional(),
    dischargeAiEnabled: z.boolean().optional(),
    radiologyAiEnabled: z.boolean().optional(),
  }),
});

export type UpdateAiConfigInput = z.infer<typeof updateAiConfigSchema>['body'];

// UC3 — platform-wide support chatbot (read-only). A user question plus an
// optional short prior-turn history for follow-ups.
export const platformChatSchema = z.object({
  body: z.object({
    message: z.string().trim().min(1, 'Message is required').max(2000),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(4000),
        }),
      )
      .max(20)
      .optional(),
  }),
});

export type PlatformChatInput = z.infer<typeof platformChatSchema>['body'];

// UC2 (Lvl 1) — patient AI chatbot for the doctor.
export const patientChatSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('A valid patient is required'),
    message: z.string().trim().min(1, 'Message is required').max(2000),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(4000),
        }),
      )
      .max(20)
      .optional(),
  }),
});

export type PatientChatInput = z.infer<typeof patientChatSchema>['body'];

// UC2.2 — blood report (lab) analysis with a score.
export const bloodReportAnalysisSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('A valid patient is required'),
    labOrderId: z.string().uuid().optional(),
  }),
});

export type BloodReportAnalysisInput = z.infer<typeof bloodReportAnalysisSchema>['body'];
