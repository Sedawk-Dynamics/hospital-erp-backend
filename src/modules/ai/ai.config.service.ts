import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  getOrCreateAiConfigRow,
  providerKeyStatus,
  resolveAiConfig,
} from '../../services/ai';
import type { UpdateAiConfigInput } from './ai.validation';

// Shapes the AiConfig row for the super-admin panel. Never returns API keys;
// instead reports which providers have a key present in env so the UI can warn
// the admin when the selected provider is missing its key.
export async function getAiConfigForAdmin() {
  const row = await getOrCreateAiConfigRow();
  return {
    provider: row.provider,
    textModel: row.textModel,
    temperature: Number(row.temperature),
    maxOutputTokens: row.maxOutputTokens,
    features: {
      patientChatEnabled: row.patientChatEnabled,
      platformChatEnabled: row.platformChatEnabled,
      dischargeAiEnabled: row.dischargeAiEnabled,
      radiologyAiEnabled: row.radiologyAiEnabled,
    },
    providerKeys: providerKeyStatus(),
    updatedAt: row.updatedAt,
  };
}

export async function updateAiConfig(userId: string, data: UpdateAiConfigInput) {
  const row = await getOrCreateAiConfigRow();

  // If switching provider without a key, allow it but the resolved config will
  // simply be "not ready" — keep the guardrail at call time, not here, so the
  // admin can stage a provider change before the key is added.
  const updated = await prisma.aiConfig.update({
    where: { id: row.id },
    data: {
      provider: data.provider ?? undefined,
      textModel: data.textModel ?? undefined,
      temperature: data.temperature ?? undefined,
      maxOutputTokens: data.maxOutputTokens ?? undefined,
      patientChatEnabled: data.patientChatEnabled ?? undefined,
      platformChatEnabled: data.platformChatEnabled ?? undefined,
      dischargeAiEnabled: data.dischargeAiEnabled ?? undefined,
      radiologyAiEnabled: data.radiologyAiEnabled ?? undefined,
      updatedById: userId,
    },
  });

  return getAiConfigForAdmin().then(() => ({
    provider: updated.provider,
    textModel: updated.textModel,
  }));
}

/**
 * Lightweight status for any authenticated user — drives whether the frontend
 * shows AI buttons/panels. Booleans only; no keys or models leaked beyond the
 * (non-sensitive) active model name.
 */
export async function getAiStatus() {
  const cfg = await resolveAiConfig();
  return {
    enabled: cfg.ready,
    provider: cfg.provider,
    model: cfg.ready ? cfg.textModel : null,
    features: {
      // A feature is "on" only when AI is configured AND its flag is enabled.
      patientChat: cfg.ready && cfg.features.patientChat,
      platformChat: cfg.ready && cfg.features.platformChat,
      dischargeAi: cfg.ready && cfg.features.dischargeAi,
      // Radiology image diagnosis (UC2.1) is deferred — surfaced as "coming soon".
      radiologyAi: cfg.ready && cfg.features.radiologyAi,
    },
  };
}

/** Guard used by AI feature endpoints; throws when the feature is off. */
export async function assertFeatureEnabled(
  feature: 'patientChat' | 'platformChat' | 'dischargeAi',
): Promise<void> {
  const status = await getAiStatus();
  if (!status.enabled) {
    throw AppError.badRequest(
      'AI is not configured on this server. Ask a super-admin to enable it.',
    );
  }
  if (!status.features[feature]) {
    throw AppError.badRequest('This AI feature has been disabled by your administrator.');
  }
}
