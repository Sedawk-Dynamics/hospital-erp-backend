import { prisma } from '../../config/database';
import { env } from '../../config/env';
import type { AiProvider, ResolvedAiConfig } from './ai.types';

// Resolves the active AI configuration by merging the platform AiConfig row
// (super-admin choices) with env (API keys + fallbacks). The single AiConfig
// row is created lazily on first read so the super-admin panel always has a
// row to edit.

export async function getOrCreateAiConfigRow() {
  const existing = await prisma.aiConfig.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.aiConfig.create({
    data: {
      provider: env.AI_PROVIDER,
      textModel: env.AI_PROVIDER === 'openai' ? env.OPENAI_MODEL : env.GEMINI_MODEL,
    },
  });
}

function apiKeyFor(provider: AiProvider): string {
  if (provider === 'openai') return env.OPENAI_API_KEY;
  if (provider === 'gemini') return env.GEMINI_API_KEY;
  return '';
}

/**
 * The resolved, ready-to-use config consumed by the AI service and exposed
 * (minus the key) to the frontend status endpoint.
 */
export async function resolveAiConfig(): Promise<ResolvedAiConfig> {
  const row = await getOrCreateAiConfigRow();
  const provider = row.provider as AiProvider;
  const apiKey = apiKeyFor(provider);

  return {
    provider,
    textModel: row.textModel,
    temperature: Number(row.temperature),
    maxOutputTokens: row.maxOutputTokens,
    apiKey,
    ready: provider !== 'disabled' && apiKey.length > 0,
    features: {
      patientChat: row.patientChatEnabled,
      platformChat: row.platformChatEnabled,
      dischargeAi: row.dischargeAiEnabled,
      radiologyAi: row.radiologyAiEnabled,
    },
  };
}

/** Which providers currently have an API key present in env (booleans only). */
export function providerKeyStatus(): Record<'gemini' | 'openai', boolean> {
  return {
    gemini: env.GEMINI_API_KEY.length > 0,
    openai: env.OPENAI_API_KEY.length > 0,
  };
}
