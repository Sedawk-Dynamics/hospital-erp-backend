import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { resolveFallbacks } from './ai.models';
import type { AiProvider, ResolvedAiConfig } from './ai.types';

// Resolves the active AI configuration for a hospital by merging that hospital's
// AiConfig row (or the platform default row) with env (API keys + fallbacks).
// A row with tenantId=null is the platform default; it is created lazily so the
// super-admin panel always has a row to edit.

export async function getOrCreatePlatformDefault() {
  const existing = await prisma.aiConfig.findFirst({
    where: { tenantId: null },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;
  return prisma.aiConfig.create({
    data: {
      tenantId: null,
      provider: env.AI_PROVIDER,
      textModel: env.AI_PROVIDER === 'openai' ? env.OPENAI_MODEL : env.GEMINI_MODEL,
    },
  });
}

/** The hospital's own override row, or null if it inherits the default. */
export function getTenantConfigRow(tenantId: string) {
  return prisma.aiConfig.findUnique({ where: { tenantId } });
}

function apiKeyFor(provider: AiProvider): string {
  if (provider === 'openai') return env.OPENAI_API_KEY;
  if (provider === 'gemini') return env.GEMINI_API_KEY;
  return '';
}

/**
 * The resolved, ready-to-use config for a hospital. Uses the hospital's own row
 * when present, else the platform default. Exposed (minus the key) to the
 * frontend status endpoint.
 */
export async function resolveAiConfig(tenantId?: string | null): Promise<ResolvedAiConfig> {
  const tenantRow = tenantId ? await getTenantConfigRow(tenantId) : null;
  const row = tenantRow ?? (await getOrCreatePlatformDefault());

  const provider = row.provider as AiProvider;
  const apiKey = apiKeyFor(provider);

  return {
    provider,
    textModel: row.textModel,
    fallbackModels: resolveFallbacks(row.textModel, row.fallbackModels),
    temperature: Number(row.temperature),
    maxOutputTokens: row.maxOutputTokens,
    apiKey,
    ready: provider !== 'disabled' && apiKey.length > 0,
    // Only meaningful for a hospital scope: true = falling back to the default.
    inherited: tenantId ? !tenantRow : false,
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
