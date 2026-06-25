import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { AiProviderError, isRetriableStatus } from '../ai.errors';
import type { AiGenerateOptions, AiProviderClient } from '../ai.types';

// Reasoning-family models (o-series, gpt-5.x) use `max_completion_tokens` and
// reject a custom `temperature`. Detect them so the chat-completions call stays
// valid across the whole catalog.
function isReasoningModel(model: string): boolean {
  return /^o\d/i.test(model) || /^gpt-5/i.test(model);
}

// OpenAI (chat completions) provider. Present so the platform can switch
// providers from the super-admin panel without code changes, per the meeting
// decision to keep the architecture flexible. Gemini stays the cost-efficient
// default; this is the upgrade path when output quality demands it.
export const openaiProvider: AiProviderClient = {
  provider: 'openai',

  async generate(opts: AiGenerateOptions, model: string, apiKey: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    for (const m of opts.messages) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }

    const reasoning = isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages,
      ...(reasoning
        ? { max_completion_tokens: opts.maxOutputTokens ?? 1024 }
        : { temperature: opts.temperature ?? 0.4, max_tokens: opts.maxOutputTokens ?? 1024 }),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${env.OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.error({ err }, 'OpenAI API request failed');
      throw new AiProviderError('openai', 'AI service unreachable', undefined, true);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error({ status: res.status, model, body: errText.slice(0, 500) }, 'OpenAI API error');
      throw new AiProviderError(
        'openai',
        `OpenAI API error (${res.status})`,
        res.status,
        isRetriableStatus(res.status),
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  },
};
