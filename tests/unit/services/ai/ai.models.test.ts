import { describe, it, expect } from 'vitest';
import {
  AI_MODELS,
  DEFAULT_FALLBACKS,
  DEFAULT_MODEL,
  isKnownModel,
  isRetiredModel,
  resolveFallbacks,
} from '../../../../src/services/ai/ai.models';

/**
 * Probed against the live Gemini API on 2026-09-12: four catalogued models now
 * answer 404 "no longer available", and the platform's own fallback chain led
 * with one of them. Every AI call therefore spent a round-trip on a model that
 * could never answer, and the failure that came back was the 404 rather than
 * the thing actually wrong.
 *
 * These hold the catalog to two promises: a retired model never appears in a
 * chain, and a retired model is never silently deleted (a saved config that
 * still names it has to keep validating).
 */

const RETIRED = ['gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];

describe('model catalog', () => {
  it('marks exactly the withdrawn models retired', () => {
    const retired = AI_MODELS.filter((m) => m.retired).map((m) => m.id).sort();
    expect(retired).toEqual([...RETIRED].sort());
  });

  it('keeps retired models known so a saved config still validates', () => {
    for (const id of RETIRED) {
      expect(isKnownModel(id)).toBe(true);
      expect(isRetiredModel(id)).toBe(true);
    }
  });

  it('names a live replacement for each retired model', () => {
    for (const m of AI_MODELS.filter((x) => x.retired)) {
      expect(m.retired).toMatch(/use /i);
    }
  });

  it('never routes a default fallback chain through a retired model', () => {
    for (const [primary, chain] of Object.entries(DEFAULT_FALLBACKS)) {
      for (const model of chain) {
        expect(isKnownModel(model), `${primary} → unknown ${model}`).toBe(true);
        expect(isRetiredModel(model), `${primary} → retired ${model}`).toBe(false);
      }
    }
  });

  it('gives every Gemini model a chain, retired primaries included', () => {
    for (const m of AI_MODELS.filter((x) => x.provider === 'gemini')) {
      expect(resolveFallbacks(m.id).length, m.id).toBeGreaterThan(0);
    }
  });

  it('defaults to a model that is still served', () => {
    expect(isRetiredModel(DEFAULT_MODEL.gemini)).toBe(false);
    expect(isRetiredModel(DEFAULT_MODEL.openai)).toBe(false);
  });
});

describe('resolveFallbacks', () => {
  it('drops retired models a hospital saved before they were withdrawn', () => {
    // The platform default row as it stands today.
    expect(
      resolveFallbacks('gemini-3.1-flash-lite', ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash']),
    ).toEqual(['gemini-2.5-flash', 'gemini-3.5-flash']);
  });

  it('falls through to the defaults when every chosen fallback is retired', () => {
    expect(resolveFallbacks('gemini-3.5-flash', ['gemini-2.0-flash', 'gemini-2.5-pro'])).toEqual(
      DEFAULT_FALLBACKS['gemini-3.5-flash'],
    );
  });

  it('leaves the primary alone even when it is retired', () => {
    // Answering on a model nobody picked would be worse than failing clearly.
    const chain = resolveFallbacks('gemini-2.5-pro', []);
    expect(chain).not.toContain('gemini-2.5-pro');
    expect(chain).toEqual(['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  });

  it('de-dupes and never repeats the primary', () => {
    expect(resolveFallbacks('gemini-3.5-flash', ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'])).toEqual([
      'gemini-3.1-flash-lite',
    ]);
  });
});
