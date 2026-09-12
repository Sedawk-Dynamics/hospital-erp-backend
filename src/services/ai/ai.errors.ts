import type { AiProvider } from './ai.types';

// Error thrown by a provider when an API call fails. `retriable` marks errors
// where switching to a fallback model is worth trying (rate limits, overload,
// model-unavailable), versus fatal ones (bad/empty key, malformed request).
export class AiProviderError extends Error {
  readonly provider: AiProvider;
  readonly status?: number;
  readonly retriable: boolean;

  constructor(provider: AiProvider, message: string, status?: number, retriable = false) {
    super(message);
    this.name = 'AiProviderError';
    this.provider = provider;
    this.status = status;
    this.retriable = retriable;
  }
}

// 429 (rate limit), 500/502/503/504 (overload/transient), 404 (model not found
// for this key) → try the next fallback model. 400/401/403 → fatal (key/request).
export function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 404 || (status >= 500 && status <= 599);
}

/**
 * Pull the API's own explanation out of an error response body. Gemini and
 * OpenAI both answer with `{ error: { message } }`.
 *
 * Without this every failure reads "Gemini API error (429)" — true, and
 * useless. "Your prepayment credits are depleted" is the whole answer, and it
 * was only ever written to the log, where nobody looks first.
 */
export function providerErrorReason(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;

  let reason = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    const fromError = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (fromError) reason = fromError;
  } catch {
    // Not JSON — an HTML error page or plain text. Use it as it came, capped.
  }

  reason = reason.replace(/\s+/g, ' ').trim();
  if (!reason) return undefined;
  return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}
