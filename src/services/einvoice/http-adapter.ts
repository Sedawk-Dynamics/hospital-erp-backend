import type {
  EInvoiceProvider,
  EwayBillCancelled,
  EwayBillGenerated,
  GstPortal,
  IrnCancelled,
  IrnGenerated,
  PortalCredentials,
  PortalFailure,
  PortalResult,
} from './types';

// ---------------------------------------------------------------------------
// One configurable adapter for a GSP's e-invoice and e-way bill API (gap #266).
//
// GSPs wrap the NIC portals differently — the base URL, the paths, where the
// token comes back — but the invoice JSON and the reply fields are NIC's own
// (Irn, AckNo, AckDt, SignedQRCode; ewayBillNo, ewayBillDate, validUpto). So,
// like the GSTIN adapter, this one is driven by env rather than written per
// vendor.
//
// Flow: POST <auth path> with the hospital's portal login in headers → a token;
// then POST the document with the token. The hospital's credentials go in
// headers only, never in a URL, a log line, an error message or a result.
// ---------------------------------------------------------------------------

export interface HttpEInvoiceConfig {
  label: string;
  /** https only, except for localhost. No trailing slash. */
  baseUrl: string;
  paths: {
    einvoiceAuth: string;
    irnGenerate: string;
    irnCancel: string;
    ewayAuth: string;
    ewayGenerate: string;
    ewayCancel: string;
  };
  /** Static headers some GSPs need (their own API key, ASP id). Secrets — never logged. */
  extraHeaders: Record<string, string>;
  timeoutMs: number;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: 'error' | 'follow' | 'manual' },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

const MAX_BODY = 512 * 1024;

export const DEFAULT_EINVOICE_PATHS: HttpEInvoiceConfig['paths'] = {
  einvoiceAuth: '/einvoice/authenticate',
  irnGenerate: '/einvoice/irn',
  irnCancel: '/einvoice/irn/cancel',
  ewayAuth: '/ewaybill/authenticate',
  ewayGenerate: '/ewaybill/generate',
  ewayCancel: '/ewaybill/cancel',
};

function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Why this configuration cannot be used, or null when it can. */
export function httpEInvoiceConfigProblem(cfg: HttpEInvoiceConfig): string | null {
  if (!cfg.baseUrl) return 'EINVOICE_BASE_URL is not set';
  if (!isAllowedUrl(cfg.baseUrl)) return 'EINVOICE_BASE_URL must be an https:// URL';
  return null;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pick(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

/** Some GSPs return `data`/`Data` as a JSON string rather than an object. */
function parseBody(text: string): unknown {
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
  if (body && typeof body === 'object') {
    for (const k of ['Data', 'data', 'result']) {
      const d = (body as Record<string, unknown>)[k];
      if (typeof d === 'string' && d.trim().startsWith('{')) {
        try {
          body = { ...(body as object), [k]: JSON.parse(d) };
        } catch {
          /* leave it */
        }
      }
    }
  }
  return body;
}

const DATA = ['Data.', 'data.', 'result.', 'data.data.', ''];
const at = (field: string) => DATA.map((w) => `${w}${field}`);

/**
 * The portal's date strings are IST without a zone ("2026-11-24 10:15:00" or
 * "24/11/2026 10:15:00 AM"). Read them as IST, never as the server's zone.
 */
export function parsePortalDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`);
  m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AP]M))?)?$/i.exec(s);
  if (m) {
    let h = Number(m[4] ?? 0);
    if (m[7]) {
      const pm = m[7].toUpperCase() === 'PM';
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    return new Date(`${m[3]}-${m[2]}-${m[1]}T${String(h).padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}+05:30`);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** The portal's error, in its own words. Exported for tests. */
export function portalError(httpStatus: number, body: unknown): PortalFailure {
  const details = pick(body, ['ErrorDetails', 'error.ErrorDetails', 'errorDetails', 'errors', 'error_details']);
  if (Array.isArray(details) && details.length) {
    const parts = details
      .map((d) => {
        const code = str(getPath(d, 'ErrorCode') ?? getPath(d, 'errorCode') ?? getPath(d, 'code'));
        const msg = str(getPath(d, 'ErrorMessage') ?? getPath(d, 'errorMessage') ?? getPath(d, 'message'));
        return msg ? (code ? `${code}: ${msg}` : msg) : null;
      })
      .filter((x): x is string => !!x);
    if (parts.length) {
      const code = str(getPath(details[0], 'ErrorCode') ?? getPath(details[0], 'errorCode') ?? getPath(details[0], 'code'));
      return { ok: false, code, message: parts.join('; ').slice(0, 1000) };
    }
  }
  const msg = str(pick(body, ['error.message', 'message', 'status_desc', 'error_description', 'error', 'Message']));
  const code = str(pick(body, ['error.code', 'errorCode', 'error_code', 'code']));
  if (msg) return { ok: false, code, message: (code && !msg.startsWith(code) ? `${code}: ${msg}` : msg).slice(0, 1000) };
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, code: 'AUTH', message: `The GST provider refused the credentials (HTTP ${httpStatus})` };
  }
  return { ok: false, code: null, message: `The GST provider returned HTTP ${httpStatus} without an error message` };
}

function succeeded(httpStatus: number, body: unknown): boolean {
  if (httpStatus < 200 || httpStatus >= 300 || !body || typeof body !== 'object') return false;
  const s = pick(body, ['Status', 'status', 'status_cd', 'success']);
  if (s === undefined) return true;
  return s === 1 || s === '1' || s === true || s === 'true' || String(s).toUpperCase() === 'SUCCESS';
}

/** Parse a generate-IRN reply. Exported for tests. */
export function parseIrnReply(httpStatus: number, text: string): PortalResult<IrnGenerated> {
  const body = parseBody(text);
  if (body === undefined) return { ok: false, code: null, message: `The GST provider reply was not JSON (HTTP ${httpStatus})` };
  if (succeeded(httpStatus, body)) {
    const irn = str(pick(body, at('Irn')));
    const ackNo = str(pick(body, at('AckNo')));
    const ackDate = parsePortalDate(pick(body, at('AckDt')));
    if (!irn || !ackNo || !ackDate) {
      return { ok: false, code: null, message: 'The GST provider reported success but the reply had no Irn / AckNo / AckDt' };
    }
    return { ok: true, irn, ackNo, ackDate, signedQrCode: str(pick(body, at('SignedQRCode'))), duplicate: false };
  }
  // 2150 Duplicate IRN: the portal already holds this document — typically a
  // retry after a timeout that had in fact succeeded. It returns the existing
  // IRN in InfoDtls, which is exactly what should be recorded.
  const info = pick(body, ['InfoDtls', 'info', 'Data.InfoDtls', 'data.InfoDtls']);
  if (Array.isArray(info)) {
    const dup = info.find((i) => /DUPIRN/i.test(String(getPath(i, 'InfCd') ?? '')));
    const desc = dup ? getPath(dup, 'Desc') : undefined;
    const irn = str(getPath(desc, 'Irn'));
    const ackNo = str(getPath(desc, 'AckNo'));
    const ackDate = parsePortalDate(getPath(desc, 'AckDt'));
    if (irn && ackNo && ackDate) return { ok: true, irn, ackNo, ackDate, signedQrCode: null, duplicate: true };
  }
  return portalError(httpStatus, body);
}

export function parseCancelReply(httpStatus: number, text: string, irn: string): PortalResult<IrnCancelled> {
  const body = parseBody(text);
  if (body === undefined) return { ok: false, code: null, message: `The GST provider reply was not JSON (HTTP ${httpStatus})` };
  if (!succeeded(httpStatus, body)) return portalError(httpStatus, body);
  return {
    ok: true,
    irn: str(pick(body, at('Irn'))) ?? irn,
    cancelledAt: parsePortalDate(pick(body, at('CancelDate'))) ?? new Date(),
  };
}

export function parseEwayReply(httpStatus: number, text: string): PortalResult<EwayBillGenerated> {
  const body = parseBody(text);
  if (body === undefined) return { ok: false, code: null, message: `The GST provider reply was not JSON (HTTP ${httpStatus})` };
  if (!succeeded(httpStatus, body)) return portalError(httpStatus, body);
  const no = str(pick(body, [...at('ewayBillNo'), ...at('EwbNo'), ...at('ewbNo')]));
  const date = parsePortalDate(pick(body, [...at('ewayBillDate'), ...at('EwbDt'), ...at('ewbDt')]));
  if (!no || !date) return { ok: false, code: null, message: 'The GST provider reported success but the reply had no e-way bill number / date' };
  return {
    ok: true,
    ewayBillNo: no,
    ewayBillDate: date,
    validUpto: parsePortalDate(pick(body, [...at('validUpto'), ...at('EwbValidTill')])),
  };
}

/** Parse a cancel-e-way-bill reply (NIC: ewayBillNo, cancelDate). Exported for tests. */
export function parseEwayCancelReply(httpStatus: number, text: string, ewayBillNo: string): PortalResult<EwayBillCancelled> {
  const body = parseBody(text);
  if (body === undefined) return { ok: false, code: null, message: `The GST provider reply was not JSON (HTTP ${httpStatus})` };
  if (!succeeded(httpStatus, body)) return portalError(httpStatus, body);
  return {
    ok: true,
    ewayBillNo: str(pick(body, [...at('ewayBillNo'), ...at('EwbNo'), ...at('ewbNo')])) ?? ewayBillNo,
    cancelledAt: parsePortalDate(pick(body, [...at('cancelDate'), ...at('CancelDate'), ...at('cancelledDate')])) ?? new Date(),
  };
}

export function createHttpEInvoiceProvider(cfg: HttpEInvoiceConfig, fetchImpl?: FetchLike): EInvoiceProvider {
  const name = `http:${cfg.label}`;
  const doFetch: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  function credHeaders(creds: PortalCredentials): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...cfg.extraHeaders,
      user_name: creds.username,
      password: creds.password,
    };
    if (creds.clientId) h.client_id = creds.clientId;
    if (creds.clientSecret) h.client_secret = creds.clientSecret;
    if (creds.gstin) h.gstin = creds.gstin;
    return h;
  }

  /** POST and read the reply. Network failures become a failure result naming only the error code. */
  async function post(
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ status: number; text: string } | PortalFailure> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await doFetch(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
        // A redirect could carry the credential headers to another host.
        redirect: 'error',
      });
      return { status: res.status, text: (await res.text()).slice(0, MAX_BODY) };
    } catch (err) {
      const aborted = ctrl.signal.aborted || (err as { name?: string })?.name === 'AbortError';
      if (aborted) {
        return {
          ok: false,
          code: 'TIMEOUT',
          message: `The GST provider did not answer within ${Math.round(cfg.timeoutMs / 1000)}s`,
          uncertain: true,
        };
      }
      // Only the error CODE — a message can quote the URL.
      const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? 'network error';
      return { ok: false, code: 'NETWORK', message: `Could not reach the GST provider (${code})`, uncertain: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate(portal: GstPortal, creds: PortalCredentials): Promise<{ token: string } | PortalFailure> {
    const path = portal === 'einvoice' ? cfg.paths.einvoiceAuth : cfg.paths.ewayAuth;
    const res = await post(path, credHeaders(creds), { UserName: creds.username, Password: creds.password });
    if ('ok' in res) return { ...res, uncertain: false };
    const body = parseBody(res.text);
    if (!succeeded(res.status, body)) return body === undefined
      ? { ok: false, code: null, message: `The GST provider reply was not JSON (HTTP ${res.status})` }
      : portalError(res.status, body);
    const token = str(pick(body, [...at('AuthToken'), ...at('authToken'), ...at('auth_token'), ...at('token'), ...at('access_token')]));
    if (!token) return { ok: false, code: null, message: 'The GST provider accepted the login but returned no auth token' };
    return { token };
  }

  async function call<T>(
    portal: GstPortal,
    path: string,
    creds: PortalCredentials,
    body: unknown,
    parse: (status: number, text: string) => PortalResult<T>,
  ): Promise<PortalResult<T>> {
    const auth = await authenticate(portal, creds);
    if ('ok' in auth) return auth;
    const res = await post(path, { ...credHeaders(creds), authtoken: auth.token, 'auth-token': auth.token }, body);
    if ('ok' in res) return res;
    return parse(res.status, res.text);
  }

  return {
    name,
    sandbox: false,
    async testConnection(portal, creds) {
      const auth = await authenticate(portal, creds);
      if ('ok' in auth) return auth;
      return { ok: true, message: `Connected: ${name} accepted the ${portal === 'einvoice' ? 'e-invoice' : 'e-way bill'} login` };
    },
    generateIrn(creds, payload) {
      return call('einvoice', cfg.paths.irnGenerate, creds, payload, parseIrnReply);
    },
    cancelIrn(creds, input) {
      return call(
        'einvoice',
        cfg.paths.irnCancel,
        creds,
        { Irn: input.irn, CnlRsn: input.reasonCode, CnlRem: input.remark },
        (s, t) => parseCancelReply(s, t, input.irn),
      );
    },
    generateEwayBill(creds, payload) {
      return call('eway', cfg.paths.ewayGenerate, creds, payload, parseEwayReply);
    },
    cancelEwayBill(creds, input) {
      // NIC's field names; the number goes as a number, as the portal expects.
      return call(
        'eway',
        cfg.paths.ewayCancel,
        creds,
        { ewbNo: Number(input.ewayBillNo), cancelRsnCode: Number(input.reasonCode), cancelRmrk: input.remark },
        (s, t) => parseEwayCancelReply(s, t, input.ewayBillNo),
      );
    },
  };
}
