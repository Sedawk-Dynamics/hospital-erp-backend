import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { resolveAiConfig } from './ai.config';
import { AiProviderError } from './ai.errors';
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

/** Context for an AI call — which hospital's config to resolve. */
export interface AiCallContext {
  tenantId?: string | null;
}

/**
 * Which of a run's failures is worth reporting?
 *
 * The loop used to surface the LAST one, which is the least useful answer it
 * could give: a depleted key or a dead network fails EVERY model, so the
 * sentence the caller saw came from whichever model happened to sit at the end
 * of the fallback chain. A real run here read "Gemini API error (404)" — model
 * no longer available — while the true cause was the FIRST attempt: no credits.
 * That sends people to fix the model list when the account needs topping up.
 *
 * So: a fatal failure is definitive (bad key, blocked prompt) and wins. Then a
 * 429, which is about the account and therefore about every model in the chain.
 * Otherwise the first failure, from the model the hospital actually chose.
 */
function mostInformative<T extends { err: unknown }>(failures: T[]): T | undefined {
  const rank = (err: unknown): number => {
    if (!(err instanceof AiProviderError)) return 0;
    if (!err.retriable) return 2;
    return err.status === 429 ? 1 : 0;
  };
  let best = failures[0];
  for (const f of failures) {
    if (best === undefined || rank(f.err) > rank(best.err)) best = f;
  }
  return best;
}

/**
 * Low-level text generation. Resolves the active provider/model/key for the
 * hospital and dispatches, trying the primary model then each fallback model on
 * retriable failures (rate limits, overload, model unavailable). Throws a clear
 * badRequest when AI is not configured so callers/UI can degrade gracefully.
 */
export async function generateText(
  opts: AiGenerateOptions,
  ctx: AiCallContext = {},
): Promise<AiGenerateResult> {
  const cfg = await resolveAiConfig(ctx.tenantId);
  if (!cfg.ready) {
    throw AppError.badRequest(
      'AI is not configured for this hospital. A super-admin must select a provider and set its API key.',
    );
  }

  const client = PROVIDERS[cfg.provider];
  if (!client) throw AppError.badRequest(`Unsupported AI provider: ${cfg.provider}`);

  const attempts = [cfg.textModel, ...cfg.fallbackModels];
  const merged: AiGenerateOptions = {
    ...opts,
    temperature: opts.temperature ?? cfg.temperature,
    maxOutputTokens: opts.maxOutputTokens ?? cfg.maxOutputTokens,
  };

  const failures: Array<{ model: string; err: unknown }> = [];
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    try {
      const text = await client.generate(merged, model, cfg.apiKey);
      if (i > 0) {
        logger.warn({ provider: cfg.provider, model, primary: cfg.textModel }, 'AI fell back to alternate model');
      }
      return { text: text.trim(), provider: cfg.provider, model };
    } catch (err) {
      failures.push({ model, err });
      const retriable = err instanceof AiProviderError ? err.retriable : false;
      const isLast = i === attempts.length - 1;
      if (!retriable || isLast) break;
      logger.warn(
        { provider: cfg.provider, model, next: attempts[i + 1] },
        'AI model failed (retriable) — trying fallback',
      );
    }
  }

  // Exhausted all attempts. Log the whole chain — one line showing every model
  // and why it refused — then report the one failure that explains the run.
  const reported = mostInformative(failures);
  logger.error(
    {
      provider: cfg.provider,
      reported: reported?.model,
      attempts: failures.map((f) => ({
        model: f.model,
        status: f.err instanceof AiProviderError ? f.err.status : undefined,
        message: f.err instanceof Error ? f.err.message : String(f.err),
      })),
    },
    'AI request failed on every configured model',
  );
  if (reported?.err instanceof AiProviderError) {
    throw AppError.internal(`AI request failed: ${reported.err.message}`);
  }
  throw AppError.internal('AI request failed');
}

/**
 * Structured output needs far more room than a chat reply, and the shared
 * `AiConfig.maxOutputTokens` defaults to 1024 — a limit chosen for
 * conversational answers. A blood-report analysis returning a per-parameter
 * note for a full panel blows through that easily, and the reply comes back
 * cut off mid-object. `JSON.parse` then fails and the doctor was told the model
 * "returned an unexpected format", which is true but useless: the model was
 * fine, it was simply not given enough room to finish.
 *
 * So JSON calls get their own floor. A hospital that has deliberately raised
 * the configured limit still wins.
 */
const JSON_OUTPUT_TOKEN_FLOOR = 4096;

/** Looks like a JSON object the model never got to close. */
function looksTruncated(text: string): boolean {
  const opens = (text.match(/\{/g) ?? []).length;
  const closes = (text.match(/\}/g) ?? []).length;
  return opens > closes;
}

/**
 * Generate and parse a strict JSON object. Defensive against models that wrap
 * the JSON in prose or code fences despite responseMimeType.
 */
export async function generateJson<T = unknown>(
  opts: AiGenerateOptions,
  ctx: AiCallContext = {},
): Promise<T> {
  const { text } = await generateText(
    {
      ...opts,
      json: true,
      maxOutputTokens: Math.max(opts.maxOutputTokens ?? 0, JSON_OUTPUT_TOKEN_FLOOR),
    },
    ctx,
  );

  // Say WHICH failure it was. "Cut off" is actionable — send less, or raise the
  // limit; "unexpected format" sends everyone looking at the wrong thing.
  if (looksTruncated(text)) {
    logger.warn(
      { length: text.length, preview: text.slice(-200) },
      'AI JSON response was truncated before the object closed',
    );
    throw AppError.internal(
      'The AI response was cut off before it finished. Try again with a narrower request — ' +
        'or raise the output token limit in AI settings if this keeps happening.',
    );
  }

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
export async function complete(prompt: string, system?: string, ctx: AiCallContext = {}): Promise<string> {
  const { text } = await generateText(
    { system, messages: [{ role: 'user', content: prompt }] },
    ctx,
  );
  return text;
}

export type { AiMessage };
