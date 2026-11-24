import { createHttpEInvoiceProvider, DEFAULT_EINVOICE_PATHS, httpEInvoiceConfigProblem, type HttpEInvoiceConfig } from './http-adapter';
import { createEInvoiceSandboxProvider } from './sandbox-adapter';
import type { EInvoiceProvider, EInvoiceProviderInfo } from './types';

export * from './types';
export { EINVOICE_SANDBOX_FIXTURES } from './sandbox-adapter';
export { parseIrnReply, parseCancelReply, parseEwayReply, parseEwayCancelReply, parsePortalDate, portalError } from './http-adapter';
export { credentialKeyInfo, encryptCredentials, decryptCredentials, maskUsername, CredentialCryptoError } from './credential-crypto';
export type { CredentialKeyInfo } from './credential-crypto';

// ---------------------------------------------------------------------------
// Which e-invoice / e-way bill provider this deployment uses (gap #266). Read
// from env on every call, so tests can pass their own env and a config change
// needs no code change.
//
//   EINVOICE_PROVIDER unset / "none"  → not configured (the default): the
//                                       e-invoice and e-way switches read
//                                       "Not available" and cannot be turned on
//   EINVOICE_PROVIDER=http            → the configurable GSP adapter
//   EINVOICE_PROVIDER=sandbox         → deterministic QA fixtures, labelled
//                                       SANDBOX, refused in production
//
// The hospital's own portal login is NOT here: it is entered in GST settings
// and stored encrypted per hospital (see credential-crypto.ts).
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;
type FetchImpl = Parameters<typeof createHttpEInvoiceProvider>[1];

/** Hours after the acknowledgement within which the portal accepts an IRN cancellation. */
export const IRN_CANCEL_WINDOW_HOURS_DEFAULT = 24;

export function irnCancelWindowHours(env: Env = process.env): number {
  const n = Number(env.EINVOICE_CANCEL_WINDOW_HOURS);
  // Bounded: the portal's rule is 24 hours; a misconfiguration must not open
  // a window the portal will refuse anyway, nor shut it entirely.
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 30) : IRN_CANCEL_WINDOW_HOURS_DEFAULT;
}

/** Hours after generation within which the e-way bill portal accepts a cancellation. */
export const EWAY_CANCEL_WINDOW_HOURS_DEFAULT = 24;

export function ewayCancelWindowHours(env: Env = process.env): number {
  const n = Number(env.EWAY_CANCEL_WINDOW_HOURS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 30) : EWAY_CANCEL_WINDOW_HOURS_DEFAULT;
}

function httpConfigFromEnv(env: Env): { cfg: HttpEInvoiceConfig; problem: string | null } {
  let extraHeaders: Record<string, string> = {};
  let extraProblem: string | null = null;
  if (env.EINVOICE_EXTRA_HEADERS?.trim()) {
    try {
      const parsed = JSON.parse(env.EINVOICE_EXTRA_HEADERS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      extraHeaders = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      extraProblem = 'EINVOICE_EXTRA_HEADERS is not a JSON object';
    }
  }
  const timeout = Number(env.EINVOICE_TIMEOUT_MS);
  const path = (v: string | undefined, d: string) => {
    const t = (v ?? '').trim();
    return t ? (t.startsWith('/') ? t : `/${t}`) : d;
  };
  const cfg: HttpEInvoiceConfig = {
    label: (env.EINVOICE_PROVIDER_NAME || 'gsp').trim().slice(0, 40),
    baseUrl: (env.EINVOICE_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    paths: {
      einvoiceAuth: path(env.EINVOICE_PATH_AUTH, DEFAULT_EINVOICE_PATHS.einvoiceAuth),
      irnGenerate: path(env.EINVOICE_PATH_GENERATE, DEFAULT_EINVOICE_PATHS.irnGenerate),
      irnCancel: path(env.EINVOICE_PATH_CANCEL, DEFAULT_EINVOICE_PATHS.irnCancel),
      ewayAuth: path(env.EWAY_PATH_AUTH, DEFAULT_EINVOICE_PATHS.ewayAuth),
      ewayGenerate: path(env.EWAY_PATH_GENERATE, DEFAULT_EINVOICE_PATHS.ewayGenerate),
      ewayCancel: path(env.EWAY_PATH_CANCEL, DEFAULT_EINVOICE_PATHS.ewayCancel),
    },
    extraHeaders,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 60_000) : 20_000,
  };
  return { cfg, problem: extraProblem ?? httpEInvoiceConfigProblem(cfg) };
}

export function resolveEInvoiceProvider(
  env: Env = process.env,
  fetchImpl?: FetchImpl,
): { provider: EInvoiceProvider | null; info: EInvoiceProviderInfo } {
  const kind = (env.EINVOICE_PROVIDER ?? '').trim().toLowerCase();
  const none = (reason: string, provider: string | null = null, sandbox = false) => ({
    provider: null,
    info: { configured: false, provider, sandbox, reason },
  });

  if (!kind || kind === 'none' || kind === 'off') {
    return none('No e-invoice / e-way bill provider (GSP) is configured on this server');
  }
  if (kind === 'sandbox') {
    // Fake IRNs must never reach a real hospital's invoices.
    if (env.NODE_ENV === 'production') {
      return none('The sandbox e-invoice provider is disabled in production', 'sandbox', true);
    }
    const provider = createEInvoiceSandboxProvider();
    return { provider, info: { configured: true, provider: provider.name, sandbox: true, reason: null } };
  }
  if (kind === 'http') {
    const { cfg, problem } = httpConfigFromEnv(env);
    if (problem) return none(`E-invoice provider not configured: ${problem}`, `http:${cfg.label}`);
    const provider = createHttpEInvoiceProvider(cfg, fetchImpl);
    return { provider, info: { configured: true, provider: provider.name, sandbox: false, reason: null } };
  }
  return none(`E-invoice provider not configured: unknown EINVOICE_PROVIDER "${kind.slice(0, 20)}"`);
}

export function getEInvoiceProviderInfo(env: Env = process.env): EInvoiceProviderInfo {
  return resolveEInvoiceProvider(env).info;
}
