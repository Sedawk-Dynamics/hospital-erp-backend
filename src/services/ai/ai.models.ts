import type { AiProvider } from './ai.types';

// Catalog of selectable LLM models per provider, with free-tier guidance so the
// super-admin panel can show what each costs. Limits researched June 2026 —
// Google revises free-tier quotas without notice, so treat the numbers as
// guidance, not guarantees. OpenAI has no free tier (pay-per-token).
//
// The model `id` is passed straight through to the provider API, so adding a
// newly released model here is enough to make it selectable.
//
// Two rules learned the hard way (2026-09-12, checked against the live API):
// a model whose free-tier quota has NOT been verified is marked `free: false`
// — telling a hospital something is free when it is not is the costlier
// mistake — and a model the provider has withdrawn is marked `retired`, never
// deleted, so a config that still names it keeps validating.

export interface AiModelInfo {
  id: string;
  label: string;
  provider: AiProvider;
  /** Available on the provider's free tier. */
  free: boolean;
  /** Human-readable free-tier limits (or pricing note for paid-only). */
  limits: string;
  notes?: string;
  /** Sensible default for its provider. */
  recommended?: boolean;
  /**
   * Set when the provider has withdrawn the model. Kept in the catalog rather
   * than deleted: a hospital may already have it saved, and dropping the id
   * would make its config fail validation on the next save. The panel stops
   * offering it and the fallback resolver skips it.
   */
  retired?: string;
}

export const AI_MODELS: AiModelInfo[] = [
  // ── Google Gemini ──────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'gemini',
    free: true,
    limits: 'Free: ~10 RPM · 250K TPM · 1,500 req/day',
    notes: 'Best price/performance; supports JSON + system instructions. Default.',
    recommended: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    provider: 'gemini',
    free: true,
    limits: 'Free: ~15 RPM · 250K TPM · 1,000 req/day',
    notes: 'Fastest, most budget-friendly 2.5 model.',
    retired: 'Withdrawn by Google — use Gemini 3.5 Flash-Lite instead.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'gemini',
    free: false,
    limits: 'Paid only (removed from free tier Apr 2026)',
    notes: 'Deepest reasoning; use for hard cases when quality matters.',
    retired: 'Withdrawn by Google — use Gemini 3.1 Pro instead.',
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'gemini',
    free: true,
    limits: 'Free: ~15 RPM · 1M TPM · 1,500 req/day',
    notes: 'Stable, widely available.',
    retired: 'Withdrawn by Google — use Gemini 3.6 Flash instead.',
  },
  {
    id: 'gemini-2.0-flash-lite',
    label: 'Gemini 2.0 Flash-Lite',
    provider: 'gemini',
    free: true,
    limits: 'Free: ~30 RPM · 1M TPM · 1,500 req/day',
    notes: 'Cheapest/fastest 2.0 model.',
    retired: 'Withdrawn by Google — use Gemini 3.5 Flash-Lite instead.',
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    provider: 'gemini',
    free: true,
    limits: 'Free: limits vary by key (often ~5 RPM · 250K TPM · 20 req/day)',
    notes: 'Preview model; API id is gemini-3-flash-preview. Verify quota on your key.',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'gemini',
    free: true,
    limits: 'Free tier (limits vary; check AI Studio)',
    notes: 'Most intelligent flash-class model; verify availability on your key.',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    provider: 'gemini',
    free: true,
    limits: 'Free: ~15 RPM · 250K TPM · up to 500 req/day',
    notes: 'Best free-tier daily quota (500 RPD) — recommended primary for free keys. Supports system instructions + JSON.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    provider: 'gemini',
    free: false,
    limits: 'Quota varies by key — check AI Studio',
    notes: "Google's named replacement for 2.5 / 2.0 Flash-Lite.",
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    provider: 'gemini',
    free: false,
    limits: 'Quota varies by key — check AI Studio',
    notes: "Google's named replacement for 2.0 Flash.",
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    provider: 'gemini',
    free: false,
    limits: 'Paid — check AI Studio',
    notes: "Google's named replacement for 2.5 Pro. Deepest reasoning, highest cost.",
  },

  // ── OpenAI (no free tier — pay per token) ───────────────────────────────
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    free: false,
    limits: 'Paid: low cost; chat-completions compatible',
    notes: 'Cheap, stable default for OpenAI.',
    recommended: true,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    free: false,
    limits: 'Paid: mid cost',
    notes: 'Strong general model.',
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    provider: 'openai',
    free: false,
    limits: 'Paid: low cost',
    notes: 'Good instruction-following; chat-completions compatible.',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'openai',
    free: false,
    limits: 'Paid: mid cost',
    notes: 'Stronger coding/instruction following than 4o.',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    provider: 'openai',
    free: false,
    limits: 'Paid: low cost (2026)',
    notes: 'Newer small reasoning model; uses max_completion_tokens.',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    free: false,
    limits: 'Paid: $5/1M in · $30/1M out (2026)',
    notes: 'Flagship reasoning model; higher cost.',
  },
];

export function modelsForProvider(provider: AiProvider): AiModelInfo[] {
  return AI_MODELS.filter((m) => m.provider === provider);
}

export function isKnownModel(id: string): boolean {
  return AI_MODELS.some((m) => m.id === id);
}

export const DEFAULT_MODEL: Record<'gemini' | 'openai', string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

// Default same-provider fallback chains used when a config doesn't set its own.
// Chosen so each fallback is a DIFFERENT model with its own free-tier quota
// bucket, which is what actually rescues a rate-limited primary.
export const DEFAULT_FALLBACKS: Record<string, string[]> = {
  'gemini-2.5-flash': ['gemini-3.1-flash-lite', 'gemini-3.5-flash'],
  // Retired primaries still get a live chain — a hospital that never re-picked
  // its model should degrade to a working one, not to a row of 404s.
  'gemini-2.5-flash-lite': ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  'gemini-2.5-pro': ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  'gemini-2.0-flash': ['gemini-3.6-flash', 'gemini-3.1-flash-lite'],
  'gemini-2.0-flash-lite': ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  'gemini-3-flash-preview': ['gemini-3.1-flash-lite', 'gemini-3.5-flash'],
  'gemini-3.5-flash': ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  'gemini-3.5-flash-lite': ['gemini-3.1-flash-lite', 'gemini-3.5-flash'],
  'gemini-3.6-flash': ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  'gemini-3.1-pro-preview': ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  'gemini-3.1-flash-lite': ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
  'gpt-4o-mini': ['gpt-4.1-mini'],
  'gpt-4o': ['gpt-4o-mini'],
  'gpt-4.1-mini': ['gpt-4o-mini'],
  'gpt-4.1': ['gpt-4.1-mini', 'gpt-4o-mini'],
  'gpt-5.4-mini': ['gpt-4o-mini'],
  'gpt-5.5': ['gpt-4.1', 'gpt-4o-mini'],
};

export function isRetiredModel(id: string): boolean {
  return AI_MODELS.some((m) => m.id === id && m.retired);
}

/**
 * Resolve the fallback chain for a model: explicit list wins, else defaults.
 *
 * Retired models are dropped from the chain — they can only answer 404, and
 * each one costs a round-trip before the real answer arrives. The PRIMARY is
 * left exactly as chosen: quietly answering on a model nobody picked would be
 * worse than a clear failure. If dropping empties an explicit chain, the
 * defaults for that primary take over.
 */
export function resolveFallbacks(primary: string, explicit?: string[]): string[] {
  const live = (list: string[]) => list.filter((m) => m && m !== primary && !isRetiredModel(m));
  const chosen = explicit && explicit.length > 0 ? live(explicit) : [];
  const chain = chosen.length > 0 ? chosen : live(DEFAULT_FALLBACKS[primary] ?? []);
  return [...new Set(chain)];
}
