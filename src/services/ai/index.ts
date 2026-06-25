// Barrel for the platform AI/LLM layer.
export * from './ai.types';
export { generateText, generateJson, complete } from './ai.service';
export type { AiCallContext } from './ai.service';
export {
  resolveAiConfig,
  getOrCreatePlatformDefault,
  getTenantConfigRow,
  providerKeyStatus,
} from './ai.config';
export {
  AI_MODELS,
  modelsForProvider,
  isKnownModel,
  DEFAULT_MODEL,
  DEFAULT_FALLBACKS,
  resolveFallbacks,
  type AiModelInfo,
} from './ai.models';
export { AiProviderError } from './ai.errors';
