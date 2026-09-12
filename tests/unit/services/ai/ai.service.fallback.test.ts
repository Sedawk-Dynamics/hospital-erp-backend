import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A hospital's config names a primary model and a chain of fallbacks. When the
 * whole chain fails, ONE of those failures is the one worth telling the caller
 * about — and it is almost never the last.
 *
 * This happened for real: the account ran out of credits, so the primary came
 * back 429 "Your prepayment credits are depleted"; the chain then walked three
 * retired models that answered 404. The message said "404 — model no longer
 * available", so the obvious next move was to go and fix the model list, which
 * would never have helped.
 */

const resolveAiConfig = vi.fn();
const generate = vi.fn();

vi.mock('../../../../src/services/ai/ai.config', () => ({
  resolveAiConfig: (...args: unknown[]) => resolveAiConfig(...args),
}));
vi.mock('../../../../src/services/ai/providers/gemini.provider', () => ({
  geminiProvider: { generate: (...args: unknown[]) => generate(...args) },
}));

import { generateText } from '../../../../src/services/ai/ai.service';
import { AiProviderError } from '../../../../src/services/ai/ai.errors';

const CONFIG = {
  provider: 'gemini' as const,
  textModel: 'gemini-3.1-flash-lite',
  fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash'],
  temperature: 0.2,
  maxOutputTokens: 1024,
  apiKey: 'test-key',
  ready: true,
  inherited: false,
  features: {} as never,
};

const ask = () => generateText({ prompt: 'hello' } as never, {});

beforeEach(() => {
  vi.clearAllMocks();
  resolveAiConfig.mockResolvedValue(CONFIG);
});

describe('generateText — which failure gets reported', () => {
  it('reports the depleted-credits 429, not the trailing 404s', async () => {
    generate
      .mockRejectedValueOnce(
        new AiProviderError('gemini', 'Gemini API error (429): Your prepayment credits are depleted.', 429, true),
      )
      .mockRejectedValue(
        new AiProviderError('gemini', 'Gemini API error (404): model is no longer available', 404, true),
      );

    await expect(ask()).rejects.toThrow(/prepayment credits are depleted/);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it('reports a fatal failure over a retriable one, wherever it lands', async () => {
    generate
      .mockRejectedValueOnce(new AiProviderError('gemini', 'Gemini API error (429): rate limited', 429, true))
      .mockRejectedValueOnce(
        new AiProviderError('gemini', 'Gemini API error (401): API key not valid', 401, false),
      );

    await expect(ask()).rejects.toThrow(/API key not valid/);
    // Fatal stops the chain — the remaining fallbacks are not tried.
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('reports the primary model when every model fails the same way', async () => {
    generate.mockImplementation((_opts: unknown, model: string) =>
      Promise.reject(new AiProviderError('gemini', `Gemini API error (503) on ${model}`, 503, true)),
    );

    await expect(ask()).rejects.toThrow(/on gemini-3\.1-flash-lite/);
  });

  it('still falls back to a working model', async () => {
    generate
      .mockRejectedValueOnce(new AiProviderError('gemini', 'Gemini API error (429): rate limited', 429, true))
      .mockResolvedValueOnce('  answered  ');

    await expect(ask()).resolves.toEqual({
      text: 'answered',
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });
  });

  it('falls back to a generic message when the failure is not a provider error', async () => {
    generate.mockRejectedValue(new TypeError('boom'));

    await expect(ask()).rejects.toThrow(/^AI request failed$/);
    // A non-provider error is not retriable — the chain stops at the first.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
