import { logger } from '../../../config/logger';
import { AiProviderError, isRetriableStatus, providerErrorReason } from '../ai.errors';
import type { AiGenerateOptions, AiProviderClient } from '../ai.types';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google Gemini provider. Talks to the Generative Language REST API with the
// built-in fetch (Node 18+). Mirrors the proven call shape already used by the
// progress-notes smart-suggestions feature, generalised to system instruction
// + multi-turn chat + optional strict JSON.
export const geminiProvider: AiProviderClient = {
  provider: 'gemini',

  async generate(opts: AiGenerateOptions, model: string, apiKey: string): Promise<string> {
    // Gemini uses "model" for assistant turns; the system prompt goes in its
    // own systemInstruction field.
    const contents = opts.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxOutputTokens ?? 1024,
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (opts.system) {
      body.systemInstruction = { parts: [{ text: opts.system }] };
    }

    const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header (not query string) keeps the key out of URLs and logs.
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.error({ err }, 'Gemini API request failed');
      // Network failures are worth retrying on a fallback model/endpoint.
      throw new AiProviderError('gemini', 'AI service unreachable', undefined, true);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error({ status: res.status, model, body: errText.slice(0, 500) }, 'Gemini API error');
      const reason = providerErrorReason(errText);
      throw new AiProviderError(
        'gemini',
        `Gemini API error (${res.status})${reason ? `: ${reason}` : ''}`,
        res.status,
        isRetriableStatus(res.status),
      );
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };

    if (data.promptFeedback?.blockReason) {
      logger.warn({ blockReason: data.promptFeedback.blockReason }, 'Gemini blocked prompt');
      // A safety block won't change on another model — fatal.
      throw new AiProviderError('gemini', 'AI service blocked the request', 400, false);
    }

    return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  },
};
