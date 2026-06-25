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
