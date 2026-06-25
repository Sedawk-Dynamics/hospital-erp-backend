import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { resolveAiConfig } from './ai.config';
import { geminiProvider } from './providers/gemini.provider';
import { openaiProvider } from './providers/openai.provider';
import type {
  AiGenerateOptions,
  AiGenerateResult,
  AiMessage,
  AiProviderClient,
} from './ai.types';

const PROVIDERS: Record<string, AiProviderClient> = {
  gemini: geminiProvider,
  openai: openaiProvider,
};

/**
 * Low-level text generation. Resolves the active provider/model/key from the
 * platform config and dispatches. Throws a clear badRequest when AI is not
 * configured so callers/UI can degrade gracefully.
 */
export async function generateText(opts: AiGenerateOptions): Promise<AiGenerateResult> {
  const cfg = await resolveAiConfig();
  if (!cfg.ready) {
    throw AppError.badRequest(
      'AI is not configured on this server. A super-admin must select a provider and set its API key.',
    );
  }

  const client = PROVIDERS[cfg.provider];
  if (!client) throw AppError.badRequest(`Unsupported AI provider: ${cfg.provider}`);

  const text = await client.generate(
    {
      ...opts,
      temperature: opts.temperature ?? cfg.temperature,
      maxOutputTokens: opts.maxOutputTokens ?? cfg.maxOutputTokens,
    },
    cfg.textModel,
    cfg.apiKey,
  );

  return { text: text.trim(), provider: cfg.provider, model: cfg.textModel };
}

/**
 * Generate and parse a strict JSON object. Defensive against models that wrap
 * the JSON in prose or code fences despite responseMimeType.
 */
export async function generateJson<T = unknown>(opts: AiGenerateOptions): Promise<T> {
  const { text } = await generateText({ ...opts, json: true });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn({ preview: text.slice(0, 200) }, 'AI JSON response had no object');
    throw AppError.internal('AI returned an unexpected format');
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch (err) {
    logger.warn({ err: (err as Error).message, preview: text.slice(0, 200) }, 'AI JSON parse failed');
    throw AppError.internal('AI returned an unexpected format');
  }
}

/** Convenience for a single-prompt, single-turn completion. */
export async function complete(prompt: string, system?: string): Promise<string> {
  const { text } = await generateText({ system, messages: [{ role: 'user', content: prompt }] });
  return text;
}

export type { AiMessage };
