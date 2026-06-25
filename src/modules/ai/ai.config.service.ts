import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  getOrCreatePlatformDefault,
  getTenantConfigRow,
  providerKeyStatus,
  resolveAiConfig,
  AI_MODELS,
  resolveFallbacks,
  isKnownModel,
} from '../../services/ai';
import type { UpdateAiConfigInput } from './ai.validation';

// Shapes a config row (hospital override or platform default) for the
// super-admin panel. Never returns API keys; instead reports which providers
// have a key present in env so the UI can warn when a selection is unusable.
function shapeConfig(
  row: {
    provider: string;
    textModel: string;
    fallbackModels: string[];
    temperature: unknown;
    maxOutputTokens: number;
    patientChatEnabled: boolean;
    platformChatEnabled: boolean;
    dischargeAiEnabled: boolean;
    radiologyAiEnabled: boolean;
    updatedAt: Date;
  },
  scope: { tenantId: string | null; inherited: boolean },
) {
  return {
    tenantId: scope.tenantId,
    inherited: scope.inherited,
    provider: row.provider,
    textModel: row.textModel,
    fallbackModels: row.fallbackModels,
    resolvedFallbacks: resolveFallbacks(row.textModel, row.fallbackModels),
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

/**
 * Get the editable config for a scope. `tenantId=null` → platform default.
 * For a hospital with no override, returns the platform default flagged
 * `inherited: true` so the UI can offer "create an override".
 */
export async function getAiConfigForAdmin(tenantId: string | null) {
  if (!tenantId) {
    const row = await getOrCreatePlatformDefault();
    return shapeConfig(row, { tenantId: null, inherited: false });
  }
  const override = await getTenantConfigRow(tenantId);
  if (override) return shapeConfig(override, { tenantId, inherited: false });
  const fallback = await getOrCreatePlatformDefault();
  return shapeConfig(fallback, { tenantId, inherited: true });
}

/** Overview list: the platform default + every hospital override. */
export async function listAiConfigs() {
  const rows = await prisma.aiConfig.findMany({
    include: { tenant: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    tenantId: r.tenantId,
    hospitalName: r.tenant?.name ?? null,
    provider: r.provider,
    textModel: r.textModel,
    updatedAt: r.updatedAt,
  }));
}

export async function updateAiConfig(
  userId: string,
  tenantId: string | null,
  data: UpdateAiConfigInput,
) {
  // Reject unknown models so a typo can't silently break a hospital.
  if (data.textModel && !isKnownModel(data.textModel)) {
    throw AppError.badRequest(`Unknown model: ${data.textModel}`);
  }
  if (data.fallbackModels?.some((m) => !isKnownModel(m))) {
    throw AppError.badRequest('One or more fallback models are not recognised');
  }
  if (tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw AppError.notFound('Hospital not found');
  }

  const payload = {
    provider: data.provider ?? undefined,
    textModel: data.textModel ?? undefined,
    fallbackModels: data.fallbackModels ?? undefined,
    temperature: data.temperature ?? undefined,
    maxOutputTokens: data.maxOutputTokens ?? undefined,
    patientChatEnabled: data.patientChatEnabled ?? undefined,
    platformChatEnabled: data.platformChatEnabled ?? undefined,
    dischargeAiEnabled: data.dischargeAiEnabled ?? undefined,
    radiologyAiEnabled: data.radiologyAiEnabled ?? undefined,
    updatedById: userId,
  };

  // Upsert the row for this scope (platform default has tenantId=null and is
  // guaranteed to exist; a hospital override is created on first save).
  if (!tenantId) {
    const platform = await getOrCreatePlatformDefault();
    await prisma.aiConfig.update({ where: { id: platform.id }, data: payload });
  } else {
    await prisma.aiConfig.upsert({
      where: { tenantId },
      update: payload,
      create: { tenantId, ...payload },
    });
  }
  return getAiConfigForAdmin(tenantId);
}

/** Remove a hospital's override so it reverts to the platform default. */
export async function resetAiConfig(tenantId: string) {
  const existing = await getTenantConfigRow(tenantId);
  if (existing) await prisma.aiConfig.delete({ where: { tenantId } });
  return getAiConfigForAdmin(tenantId);
}

export function getModelCatalog() {
  return { models: AI_MODELS, providerKeys: providerKeyStatus() };
}

/**
 * Lightweight status for any authenticated user, resolved for THEIR hospital —
 * drives whether the frontend shows AI buttons/panels.
 */
export async function getAiStatus(tenantId?: string | null) {
  const cfg = await resolveAiConfig(tenantId);
  return {
    enabled: cfg.ready,
    provider: cfg.provider,
    model: cfg.ready ? cfg.textModel : null,
    features: {
      patientChat: cfg.ready && cfg.features.patientChat,
      platformChat: cfg.ready && cfg.features.platformChat,
      dischargeAi: cfg.ready && cfg.features.dischargeAi,
      // Radiology image diagnosis (UC2.1) deferred — surfaced as "coming soon".
      radiologyAi: cfg.ready && cfg.features.radiologyAi,
    },
  };
}

/** Guard used by AI feature endpoints; throws when the feature is off. */
export async function assertFeatureEnabled(
  feature: 'patientChat' | 'platformChat' | 'dischargeAi',
  tenantId?: string | null,
): Promise<void> {
  const status = await getAiStatus(tenantId);
  if (!status.enabled) {
    throw AppError.badRequest(
      'AI is not configured for this hospital. Ask a super-admin to enable it.',
    );
  }
  if (!status.features[feature]) {
    throw AppError.badRequest('This AI feature has been disabled by your administrator.');
  }
}
