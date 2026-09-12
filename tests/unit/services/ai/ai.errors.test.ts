import { describe, it, expect } from 'vitest';
import { providerErrorReason, isRetriableStatus } from '../../../../src/services/ai/ai.errors';

/**
 * A failed AI call used to say only "Gemini API error (429)" — the status and
 * nothing else, while the sentence that actually explains it ("Your prepayment
 * credits are depleted") went to the log and no further. Whoever saw the
 * message went looking at models and quotas instead of at billing.
 */
describe('providerErrorReason', () => {
  it('pulls the message out of a Gemini error body', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Your prepayment credits are depleted. Please purchase more to continue.',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    expect(providerErrorReason(body)).toBe(
      'Your prepayment credits are depleted. Please purchase more to continue.',
    );
  });

  it('pulls the message out of an OpenAI error body', () => {
    const body = JSON.stringify({
      error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' },
    });
    expect(providerErrorReason(body)).toBe('Incorrect API key provided.');
  });

  it('accepts a bare string error field', () => {
    expect(providerErrorReason('{"error":"model is overloaded"}')).toBe('model is overloaded');
  });

  it('falls back to the raw body when it is not JSON', () => {
    expect(providerErrorReason('  502 Bad Gateway\n\n')).toBe('502 Bad Gateway');
  });

  it('collapses whitespace and caps a runaway body', () => {
    const long = `x${' y'.repeat(400)}`;
    const reason = providerErrorReason(long)!;
    expect(reason.length).toBe(200);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason).not.toContain('  ');
  });

  it('returns undefined for an empty body', () => {
    expect(providerErrorReason('')).toBeUndefined();
    expect(providerErrorReason('   \n ')).toBeUndefined();
  });
});

describe('isRetriableStatus', () => {
  it('retries rate limits, missing models and server errors', () => {
    expect(isRetriableStatus(429)).toBe(true);
    expect(isRetriableStatus(404)).toBe(true);
    expect(isRetriableStatus(503)).toBe(true);
  });

  it('does not retry a bad key or a bad request', () => {
    expect(isRetriableStatus(400)).toBe(false);
    expect(isRetriableStatus(401)).toBe(false);
    expect(isRetriableStatus(403)).toBe(false);
  });
});
