import type { GstinProvider, GstinVerifyResult } from './types';

// ---------------------------------------------------------------------------
// One configurable adapter for a GSP/ASP "search taxpayer" API (gap #311).
//
// Every GSP wraps the GST system's taxpayer search differently — the URL, the
// auth header, whether the fields sit at the top level or under `data` — but
// the fields themselves are the GST system's own (lgnm, tradeNam, sts, gstin).
// So rather than one adapter per vendor, this one is driven entirely by env:
// a URL template, an auth header, and the JSON paths to read.
//
// Two rules hold whatever the configuration:
//   - the ONLY hospital data sent is the GSTIN being checked;
//   - the API key never appears in a log line, an error message or a result.
//     (The URL can carry credentials as query parameters on some GSPs, so it is
//     never echoed either.)
// ---------------------------------------------------------------------------

export interface HttpGstinConfig {
  /** Short name shown as the provider, e.g. the GSP's name. */
  label: string;
  /** Must contain {gstin} for GET. https only, except for localhost. */
  urlTemplate: string;
  method: 'GET' | 'POST';
  /** For POST: the JSON body is `{ [bodyField]: gstin }`. */
  bodyField: string;
  apiKey: string | null;
  apiKeyHeader: string;
  /** e.g. "Bearer " when the key goes in an Authorization header. */
  apiKeyPrefix: string;
  /** Static headers some GSPs need (client id, username). Secrets too — never logged. */
  extraHeaders: Record<string, string>;
  timeoutMs: number;
  paths: {
    legalName: string[];
    tradeName: string[];
    status: string[];
    gstin: string[];
  };
  /** Registration-status values that count as active. Case-insensitive. */
  activeValues: string[];
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: 'error' | 'follow' | 'manual' },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** Where the GST system's own field names usually sit inside a GSP reply. */
const WRAPPERS = ['', 'data.', 'result.', 'taxpayerInfo.', 'data.data.', 'response.'];
const withWrappers = (field: string) => WRAPPERS.map((w) => `${w}${field}`);

export const DEFAULT_PATHS: HttpGstinConfig['paths'] = {
  legalName: withWrappers('lgnm'),
  tradeName: withWrappers('tradeNam'),
  status: withWrappers('sts'),
  gstin: withWrappers('gstin'),
};

/** Phrases GSPs use for "no such taxpayer", often with HTTP 200 or 400. */
const NOT_FOUND_TEXT = /no\s+records?\s+found|not\s+found|does\s+not\s+exist|invalid\s+gstin|no\s+such\s+gstin/i;

const MAX_BODY = 256 * 1024;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pickString(obj: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Some GSPs return `data` as a JSON string rather than an object. */
function unwrapStringData(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const d = (body as Record<string, unknown>).data;
    if (typeof d === 'string' && d.trim().startsWith('{')) {
      try {
        return { ...(body as object), data: JSON.parse(d) };
      } catch {
        /* leave it as it came */
      }
    }
  }
  return body;
}

function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    // Plain http only to the local machine (a mock GSP during development).
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Why this configuration cannot be used, or null when it can. */
export function httpConfigProblem(cfg: HttpGstinConfig): string | null {
  if (!cfg.urlTemplate) return 'GSTIN_VERIFY_URL is not set';
  if (cfg.method === 'GET' && !cfg.urlTemplate.includes('{gstin}')) {
    return 'GSTIN_VERIFY_URL must contain {gstin}';
  }
  if (!isAllowedUrl(cfg.urlTemplate.replace('{gstin}', 'X'))) {
    return 'GSTIN_VERIFY_URL must be an https:// URL';
  }
  if (!cfg.apiKey) return 'GSTIN_VERIFY_API_KEY is not set';
  return null;
}

/** Turn a provider reply into the common result. Exported for tests. */
export function parseTaxpayerReply(
  gstin: string,
  httpStatus: number,
  text: string,
  cfg: Pick<HttpGstinConfig, 'paths' | 'activeValues'>,
): Omit<GstinVerifyResult, 'checkedAt' | 'provider' | 'sandbox'> {
  const g = gstin.trim().toUpperCase();
  const fail = (status: GstinVerifyResult['status'], error: string, raw?: unknown) => ({
    status,
    gstin: g,
    legalName: null,
    tradeName: null,
    registrationStatus: null,
    stateCode: null,
    error,
    raw,
  });

  let body: unknown = undefined;
  try {
    body = text ? unwrapStringData(JSON.parse(text)) : undefined;
  } catch {
    body = undefined;
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return fail('error', `Lookup failed: the GST provider refused the credentials (HTTP ${httpStatus})`);
  }
  if (httpStatus === 404) return fail('not_found', 'Not found on the GST portal', body);
  if (httpStatus === 429) return fail('error', 'Lookup failed: the GST provider is rate-limiting requests (HTTP 429)');
  if (httpStatus < 200 || httpStatus >= 300) {
    if (httpStatus >= 400 && httpStatus < 500 && NOT_FOUND_TEXT.test(text)) {
      return fail('not_found', 'Not found on the GST portal', body);
    }
    return fail('error', `Lookup failed: the GST provider returned HTTP ${httpStatus}`);
  }
  if (body === undefined || body === null || typeof body !== 'object') {
    return fail('error', 'Lookup failed: the GST provider reply was not JSON');
  }

  // Verified only for the GSTIN that was asked about. A reply about any other
  // number — a GSP bug, a cached answer — proves nothing about this one.
  const returnedGstin = pickString(body, cfg.paths.gstin)?.toUpperCase() ?? null;
  if (returnedGstin && returnedGstin !== g) {
    return fail('error', `Lookup failed: the GST provider answered for a different GSTIN (${returnedGstin})`, body);
  }

  const legalName = pickString(body, cfg.paths.legalName);
  const tradeName = pickString(body, cfg.paths.tradeName);
  const registrationStatus = pickString(body, cfg.paths.status);
  const stateCode = (returnedGstin ?? g).slice(0, 2);

  if (!legalName && !registrationStatus) {
    if (NOT_FOUND_TEXT.test(text)) return fail('not_found', 'Not found on the GST portal', body);
    return fail(
      'error',
      'Lookup failed: the GST provider reply did not contain a legal name or registration status (check GSTIN_VERIFY_PATH_*)',
      body,
    );
  }
  if (!registrationStatus) {
    return fail('error', 'Lookup failed: the GST provider reply carried no registration status', body);
  }

  const active = cfg.activeValues.some((v) => v.toLowerCase() === registrationStatus.toLowerCase());
  if (!active) {
    return {
      status: 'inactive',
      gstin: g,
      legalName,
      tradeName,
      registrationStatus,
      stateCode,
      error: `Registration status is "${registrationStatus}"`,
      raw: body,
    };
  }
  if (!legalName) {
    return fail('error', 'Lookup failed: the GST provider reported an active registration but no legal name', body);
  }
  return {
    status: 'verified',
    gstin: g,
    legalName,
    tradeName,
    registrationStatus,
    stateCode,
    error: null,
    raw: body,
  };
}

export function createHttpProvider(cfg: HttpGstinConfig, fetchImpl?: FetchLike): GstinProvider {
  const name = `http:${cfg.label}`;
  const doFetch: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  return {
    name,
    sandbox: false,
    async verify(gstin: string): Promise<GstinVerifyResult> {
      const g = gstin.trim().toUpperCase();
      const checkedAt = new Date();
      const wrap = (r: Omit<GstinVerifyResult, 'checkedAt' | 'provider' | 'sandbox'>): GstinVerifyResult => ({
        ...r,
        checkedAt,
        provider: name,
        sandbox: false,
      });

      const url = cfg.urlTemplate.replace('{gstin}', encodeURIComponent(g));
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...cfg.extraHeaders,
      };
      if (cfg.apiKey) headers[cfg.apiKeyHeader] = `${cfg.apiKeyPrefix}${cfg.apiKey}`;
      let body: string | undefined;
      if (cfg.method === 'POST') {
        headers['Content-Type'] = 'application/json';
        // The GSTIN and nothing else — no hospital name, PAN, address or user.
        body = JSON.stringify({ [cfg.bodyField]: g });
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await doFetch(url, {
          method: cfg.method,
          headers,
          body,
          signal: ctrl.signal,
          // A redirect could carry the key header to another host.
          redirect: 'error',
        });
        const text = (await res.text()).slice(0, MAX_BODY);
        return wrap(parseTaxpayerReply(g, res.status, text, cfg));
      } catch (err) {
        const aborted =
          ctrl.signal.aborted || (err as { name?: string })?.name === 'AbortError';
        if (aborted) {
          return wrap({
            status: 'error',
            gstin: g,
            legalName: null,
            tradeName: null,
            registrationStatus: null,
            stateCode: null,
            error: `Lookup failed: the GST provider did not answer within ${Math.round(cfg.timeoutMs / 1000)}s`,
          });
        }
        // Only the error CODE — a message can quote the URL, which can hold credentials.
        const code =
          (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? 'network error';
        return wrap({
          status: 'error',
          gstin: g,
          legalName: null,
          tradeName: null,
          registrationStatus: null,
          stateCode: null,
          error: `Lookup failed: could not reach the GST provider (${code})`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
