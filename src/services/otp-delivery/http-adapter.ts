import type { OtpChannel, OtpMessage, OtpProvider, OtpSendResult } from './types';

// ---------------------------------------------------------------------------
// One configurable adapter for SMS and WhatsApp HTTP APIs.
//
// Every aggregator wraps the same send differently, so the request is a
// template from env: URL, method, auth header, body. Placeholders are filled
// inside parsed JSON string values (never by pasting text into JSON), and
// URL-encoded inside the URL.
//
// Rules that hold whatever the configuration:
//   - the only things sent are the number, the code and the registered
//     sender / template ids: no name, hospital record or account id;
//   - the code, the number, the URL, the credentials and the reply body never
//     appear in a log line or an error.
// ---------------------------------------------------------------------------

export interface OtpHttpChannelConfig {
  channel: OtpChannel;
  url: string;
  method: 'GET' | 'POST';
  bodyType: 'json' | 'form';
  /** Parsed JSON template with {placeholders} in string values. POST only. */
  body: unknown;
  authHeader: string;
  authValue: string | null;
  extraHeaders: Record<string, string>;
  /** Placeholder values that do not change per message. */
  fixed: Record<string, string>;
  /** SMS text (the DLT-approved wording), with {code} and optionally {minutes}. */
  text: string;
  /** When set, the reply must contain this text to count as sent. */
  successText: string | null;
  timeoutMs: number;
}

export type OtpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

const MAX_BODY = 64 * 1024;

export const DEFAULT_SMS_BODY = {
  to: '{to_digits}',
  sender: '{sender_id}',
  entityId: '{dlt_entity_id}',
  templateId: '{dlt_template_id}',
  message: '{message}',
};

/** WhatsApp Cloud API authentication template (the code is also the copy-code button). */
export const DEFAULT_WHATSAPP_BODY = {
  messaging_product: 'whatsapp',
  to: '{to_digits}',
  type: 'template',
  template: {
    name: '{template_name}',
    language: { code: '{template_lang}' },
    components: [
      { type: 'body', parameters: [{ type: 'text', text: '{code}' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '{code}' }] },
    ],
  },
};

function fill(s: string, values: Record<string, string>, encode: (v: string) => string = (v) => v): string {
  return s.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? encode(values[key]) : whole,
  );
}

function fillDeep(node: unknown, values: Record<string, string>): unknown {
  if (typeof node === 'string') return fill(node, values);
  if (Array.isArray(node)) return node.map((n) => fillDeep(n, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillDeep(v, values)]));
  }
  return node;
}

/** https only, except plain http to the local machine (a mock provider in development). */
function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function messageValues(cfg: OtpHttpChannelConfig, message: OtpMessage): Record<string, string> {
  const digits = message.to.replace(/\D/g, '');
  const values: Record<string, string> = {
    ...cfg.fixed,
    to: message.to,
    to_digits: digits,
    to_national: digits.slice(-10),
    code: message.code,
    minutes: String(message.expiresInMinutes),
  };
  values.message = fill(cfg.text, values);
  return values;
}

/** Why this channel cannot be used, or null when it can. Names variables, never values. */
export function otpChannelProblem(cfg: OtpHttpChannelConfig): string | null {
  const p = cfg.channel === 'sms' ? 'OTP_SMS' : 'OTP_WHATSAPP';
  if (!cfg.url) return `${p}_URL is not set`;
  const sample = messageValues(cfg, { to: '+910000000000', code: '0', expiresInMinutes: 1 });
  // The host itself must be fixed: a placeholder there would let a number pick the server.
  if (!isAllowedUrl(fill(cfg.url, sample, encodeURIComponent)) || /^[a-z]+:\/\/[^/?#]*\{/i.test(cfg.url)) {
    return `${p}_URL must be an https:// URL`;
  }
  if (!cfg.authValue) return `${p}_AUTH_VALUE is not set`;
  if (cfg.channel === 'sms') {
    // Indian carriers drop an SMS, codes included, without these three.
    if (!cfg.fixed.sender_id) return 'OTP_SMS_SENDER_ID is not set';
    if (!cfg.fixed.dlt_entity_id) return 'OTP_SMS_DLT_ENTITY_ID is not set';
    if (!cfg.fixed.dlt_template_id) return 'OTP_SMS_DLT_TEMPLATE_ID is not set';
  } else if (!cfg.fixed.template_name) {
    return 'OTP_WHATSAPP_TEMPLATE_NAME is not set';
  }
  const template = cfg.method === 'POST' ? `${JSON.stringify(cfg.body)}${cfg.url}` : cfg.url;
  if (template.includes('{message}') && !cfg.text.includes('{code}')) return `${p}_TEXT must contain {code}`;
  if (!template.includes('{code}') && !template.includes('{message}')) {
    return `${cfg.method === 'POST' ? `${p}_BODY` : `${p}_URL`} must contain {code} or {message}`;
  }
  if (!/\{to(_digits|_national)?\}/.test(template)) {
    return `${cfg.method === 'POST' ? `${p}_BODY` : `${p}_URL`} must contain {to}, {to_digits} or {to_national}`;
  }
  return null;
}

/** One attempt on one channel: null when accepted, else a reason that is safe to log. */
async function sendOnce(cfg: OtpHttpChannelConfig, message: OtpMessage, doFetch: OtpFetch): Promise<string | null> {
  const values = messageValues(cfg, message);
  const headers: Record<string, string> = { Accept: 'application/json', ...cfg.extraHeaders };
  if (cfg.authValue) headers[cfg.authHeader] = cfg.authValue;

  let body: string | undefined;
  if (cfg.method === 'POST') {
    const filled = fillDeep(cfg.body, values);
    if (cfg.bodyType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(
        Object.entries((filled ?? {}) as Record<string, unknown>).map(([k, v]): [string, string] => [
          k,
          typeof v === 'string' ? v : JSON.stringify(v),
        ]),
      ).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(filled);
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(fill(cfg.url, values, encodeURIComponent), {
      method: cfg.method,
      headers,
      body,
      signal: ctrl.signal,
      // A redirect could carry the auth header and the code to another host.
      redirect: 'error',
    });
    const text = (await res.text()).slice(0, MAX_BODY);
    if (res.status < 200 || res.status >= 300) return `HTTP ${res.status}`;
    if (cfg.successText && !text.includes(cfg.successText)) return 'the provider did not confirm the message';
    return null;
  } catch (err) {
    if (ctrl.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      return `no answer within ${Math.round(cfg.timeoutMs / 1000)}s`;
    }
    // Only the error CODE: a message can quote the URL, which can hold credentials.
    return (
      (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? 'network error'
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Tries each channel in order and stops at the first that accepts the message. */
export function createOtpHttpProvider(
  label: string,
  channels: OtpHttpChannelConfig[],
  fetchImpl?: OtpFetch,
): OtpProvider {
  const name = `http:${label}`;
  const doFetch: OtpFetch = fetchImpl ?? (globalThis.fetch as unknown as OtpFetch);
  return {
    name,
    sandbox: false,
    async send(message: OtpMessage): Promise<OtpSendResult> {
      const errors: string[] = [];
      let last: OtpChannel | null = null;
      for (const cfg of channels) {
        last = cfg.channel;
        const error = await sendOnce(cfg, message, doFetch);
        if (!error) return { status: 'sent', channel: cfg.channel, provider: name, sandbox: false, error: null };
        errors.push(`${cfg.channel}: ${error}`);
      }
      return { status: 'failed', channel: last, provider: name, sandbox: false, error: errors.join('; ') };
    },
  };
}
