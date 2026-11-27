import { logger } from '../../config/logger';
import { createHttpProvider, DEFAULT_PATHS, httpConfigProblem, type HttpGstinConfig } from './http-adapter';
import { createSandboxProvider } from './sandbox-adapter';
import type { GstinProvider, GstinProviderInfo, GstinVerifyResult } from './types';

export * from './types';
export { SANDBOX_FIXTURES, SANDBOX_LEGAL_NAME } from './sandbox-adapter';
export { parseTaxpayerReply } from './http-adapter';

// ---------------------------------------------------------------------------
// Which GSTIN provider this deployment uses (gap #311). Read from env on every
// call, so a configuration change needs no code change — and so tests can pass
// their own env.
//
//   GSTIN_VERIFY_PROVIDER unset / "none"  → not configured (the default)
//   GSTIN_VERIFY_PROVIDER=http            → the configurable GSP adapter
//   GSTIN_VERIFY_PROVIDER=sandbox         → fixed QA fixtures, labelled, never in production
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;
type FetchImpl = Parameters<typeof createHttpProvider>[1];

function list(v: string | undefined, fallback: string[]): string[] {
  const parts = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
}

function httpConfigFromEnv(env: Env): { cfg: HttpGstinConfig; problem: string | null } {
  let extraHeaders: Record<string, string> = {};
  let extraProblem: string | null = null;
  if (env.GSTIN_VERIFY_EXTRA_HEADERS?.trim()) {
    try {
      const parsed = JSON.parse(env.GSTIN_VERIFY_EXTRA_HEADERS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      extraHeaders = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      extraProblem = 'GSTIN_VERIFY_EXTRA_HEADERS is not a JSON object';
    }
  }
  const timeout = Number(env.GSTIN_VERIFY_TIMEOUT_MS);
  const cfg: HttpGstinConfig = {
    label: (env.GSTIN_VERIFY_PROVIDER_NAME || 'gsp').trim().slice(0, 40),
    urlTemplate: (env.GSTIN_VERIFY_URL ?? '').trim(),
    method: (env.GSTIN_VERIFY_METHOD ?? '').trim().toUpperCase() === 'POST' ? 'POST' : 'GET',
    bodyField: (env.GSTIN_VERIFY_BODY_FIELD || 'gstin').trim(),
    apiKey: env.GSTIN_VERIFY_API_KEY?.trim() || null,
    apiKeyHeader: (env.GSTIN_VERIFY_API_KEY_HEADER || 'x-api-key').trim(),
    apiKeyPrefix: env.GSTIN_VERIFY_API_KEY_PREFIX ?? '',
    extraHeaders,
    // Bounded: a hung provider must not hold the settings request open.
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 8000,
    paths: {
      legalName: list(env.GSTIN_VERIFY_PATH_LEGAL_NAME, DEFAULT_PATHS.legalName),
      tradeName: list(env.GSTIN_VERIFY_PATH_TRADE_NAME, DEFAULT_PATHS.tradeName),
      status: list(env.GSTIN_VERIFY_PATH_STATUS, DEFAULT_PATHS.status),
      gstin: list(env.GSTIN_VERIFY_PATH_GSTIN, DEFAULT_PATHS.gstin),
    },
    activeValues: list(env.GSTIN_VERIFY_ACTIVE_VALUES, ['Active']),
  };
  return { cfg, problem: extraProblem ?? httpConfigProblem(cfg) };
}

export function resolveGstinProvider(
  env: Env = process.env,
  fetchImpl?: FetchImpl,
): { provider: GstinProvider | null; info: GstinProviderInfo } {
  const kind = (env.GSTIN_VERIFY_PROVIDER ?? '').trim().toLowerCase();
  const none = (reason: string, provider: string | null = null, sandbox = false) => ({
    provider: null,
    info: { configured: false, provider, sandbox, reason },
  });

  if (!kind || kind === 'none' || kind === 'off') {
    return none('GSTIN verification provider not configured');
  }
  if (kind === 'sandbox') {
    // Fixtures must never verify a real hospital's invoices.
    if (env.NODE_ENV === 'production') {
      return none('The sandbox GSTIN provider is disabled in production', 'sandbox', true);
    }
    const provider = createSandboxProvider();
    return { provider, info: { configured: true, provider: provider.name, sandbox: true, reason: null } };
  }
  if (kind === 'http') {
    const { cfg, problem } = httpConfigFromEnv(env);
    if (problem) return none(`GSTIN verification provider not configured: ${problem}`, `http:${cfg.label}`);
    const provider = createHttpProvider(cfg, fetchImpl);
    return { provider, info: { configured: true, provider: provider.name, sandbox: false, reason: null } };
  }
  return none(`GSTIN verification provider not configured: unknown GSTIN_VERIFY_PROVIDER "${kind.slice(0, 20)}"`);
}

export function getGstinProviderInfo(env: Env = process.env): GstinProviderInfo {
  return resolveGstinProvider(env).info;
}

/**
 * Ask the configured provider about one GSTIN. Never throws: every failure is
 * a result with a status other than 'verified', so a caller cannot mistake an
 * exception path for a pass.
 */
export async function verifyGstin(
  gstin: string,
  opts: { env?: Env; fetchImpl?: FetchImpl } = {},
): Promise<GstinVerifyResult> {
  const g = String(gstin ?? '').trim().toUpperCase();
  const { provider, info } = resolveGstinProvider(opts.env ?? process.env, opts.fetchImpl);
  const blank = {
    gstin: g,
    legalName: null,
    tradeName: null,
    registrationStatus: null,
    stateCode: null,
    checkedAt: new Date(),
  };
  if (!provider) {
    return { ...blank, status: 'not_configured', error: info.reason, provider: info.provider ?? 'none', sandbox: info.sandbox };
  }
  let result: GstinVerifyResult;
  try {
    result = await provider.verify(g);
  } catch {
    result = { ...blank, status: 'error', error: 'Lookup failed: unexpected error', provider: provider.name, sandbox: provider.sandbox };
  }
  // The outcome only — never the key, the URL or the reply body.
  logger.info(
    { provider: result.provider, sandbox: result.sandbox, status: result.status },
    'GSTIN verification lookup',
  );
  return result;
}
