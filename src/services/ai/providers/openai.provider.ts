import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { AppError } from '../../../shared/appError';
import type { AiGenerateOptions, AiProviderClient } from '../ai.types';

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

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxOutputTokens ?? 1024,
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
      throw AppError.internal('AI service unreachable');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error({ status: res.status, body: errText.slice(0, 500) }, 'OpenAI API error');
      throw AppError.internal('AI service returned an error');
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  },
};
