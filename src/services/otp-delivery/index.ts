import { logger } from '../../config/logger';
import {
  createOtpHttpProvider,
  DEFAULT_SMS_BODY,
  DEFAULT_WHATSAPP_BODY,
  otpChannelProblem,
  type OtpFetch,
  type OtpHttpChannelConfig,
} from './http-adapter';
import { createOtpSandboxProvider } from './sandbox-adapter';
import type { OtpChannel, OtpMessage, OtpProvider, OtpProviderInfo, OtpSendResult } from './types';

export * from './types';

// ---------------------------------------------------------------------------
// Which SMS / WhatsApp provider this deployment sends one-time codes with. Read
// from env on every call, so a configuration change needs no code change, and
// so tests can pass their own env.
//
//   OTP_PROVIDER unset / "none"  -> not configured (the default)
//   OTP_PROVIDER=http            -> the configurable SMS / WhatsApp adapter
//   OTP_PROVIDER=sandbox         -> no message; the code goes to the server
//                                   console. Only with NODE_ENV=development/test.
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

function parseJsonObject(raw: string | undefined, what: string): { value?: object; problem: string | null } {
  if (!raw?.trim()) return { problem: null };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return { value, problem: null };
  } catch {
    return { problem: `${what} is not a JSON object` };
  }
}

function channelFromEnv(env: Env, channel: OtpChannel): { cfg: OtpHttpChannelConfig; problem: string | null } {
  const prefix = channel === 'sms' ? 'OTP_SMS' : 'OTP_WHATSAPP';
  const v = (name: string) => (env[`${prefix}_${name}`] ?? '').trim();
  const headers = parseJsonObject(env[`${prefix}_EXTRA_HEADERS`], `${prefix}_EXTRA_HEADERS`);
  const body = parseJsonObject(env[`${prefix}_BODY`], `${prefix}_BODY`);
  const timeout = Number(env.OTP_TIMEOUT_MS);
  const cfg: OtpHttpChannelConfig = {
    channel,
    url: v('URL'),
    method: v('METHOD').toUpperCase() === 'GET' ? 'GET' : 'POST',
    bodyType: v('BODY_TYPE').toLowerCase() === 'form' ? 'form' : 'json',
    body: body.value ?? (channel === 'sms' ? DEFAULT_SMS_BODY : DEFAULT_WHATSAPP_BODY),
    authHeader: v('AUTH_HEADER') || 'Authorization',
    authValue: v('AUTH_VALUE') || null,
    extraHeaders: Object.fromEntries(Object.entries(headers.value ?? {}).map(([k, x]) => [k, String(x)])),
    fixed: {
      sender_id: v('SENDER_ID'),
      ...(channel === 'sms'
        ? { dlt_entity_id: v('DLT_ENTITY_ID'), dlt_template_id: v('DLT_TEMPLATE_ID') }
        : { template_name: v('TEMPLATE_NAME'), template_lang: v('TEMPLATE_LANG') || 'en' }),
    },
    text: v('TEXT'),
    successText: v('SUCCESS_TEXT') || null,
    // Bounded: a hung provider must not hold a sign-in open.
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 8000,
  };
  return { cfg, problem: headers.problem ?? body.problem ?? otpChannelProblem(cfg) };
}

export function resolveOtpProvider(
  env: Env = process.env,
  fetchImpl?: OtpFetch,
): { provider: OtpProvider | null; info: OtpProviderInfo } {
  const kind = (env.OTP_PROVIDER ?? '').trim().toLowerCase();
  const none = (reason: string, provider: string | null = null, sandbox = false) => ({
    provider: null,
    info: { configured: false, provider, sandbox, reason },
  });

  if (!kind || kind === 'none' || kind === 'off') return none('No SMS / WhatsApp provider is configured');
  if (kind === 'sandbox') {
    // It prints codes. Anything that is not explicitly a development or test
    // server counts as production here, including an unset NODE_ENV.
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      return none('The sandbox code provider is disabled in production', 'sandbox', true);
    }
    const provider = createOtpSandboxProvider();
    return { provider, info: { configured: true, provider: provider.name, sandbox: true, reason: null } };
  }
  if (kind === 'http') {
    const label = (env.OTP_PROVIDER_NAME || 'sms').trim().slice(0, 40);
    const order = (env.OTP_CHANNELS || 'sms')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const unknown = order.find((c) => c !== 'sms' && c !== 'whatsapp');
    if (unknown) return none(`OTP_CHANNELS has an unknown channel "${unknown.slice(0, 20)}"`, `http:${label}`);
    const channels: OtpHttpChannelConfig[] = [];
    for (const c of [...new Set(order)] as OtpChannel[]) {
      const { cfg, problem } = channelFromEnv(env, c);
      if (problem) return none(`Code provider not configured: ${problem}`, `http:${label}`);
      channels.push(cfg);
    }
    const provider = createOtpHttpProvider(label, channels, fetchImpl);
    return { provider, info: { configured: true, provider: provider.name, sandbox: false, reason: null } };
  }
  return none(`Code provider not configured: unknown OTP_PROVIDER "${kind.slice(0, 20)}"`);
}

/**
 * Countries the provider may be used for. India only unless widened: a DLT
 * sender cannot reach other countries, and an open list lets anyone run up the
 * hospital's bill on expensive foreign numbers.
 */
export function isOtpCountryAllowed(e164: string, env: Env = process.env): boolean {
  return (env.OTP_ALLOWED_COUNTRY_CODES || '91')
    .split(',')
    .map((c) => c.replace(/\D/g, ''))
    .some((c) => c && e164.startsWith(`+${c}`));
}

/** Whether a code can be sent to this number by SMS / WhatsApp on this deployment. */
export function canSendOtpToPhone(e164: string, env: Env = process.env): boolean {
  const { provider, info } = resolveOtpProvider(env);
  if (!provider) {
    if (info.provider) logger.warn({ reason: info.reason }, 'One-time code provider is set but unusable');
    return false;
  }
  return isOtpCountryAllowed(e164, env);
}

/** Send a code. Never throws: anything other than status 'sent' means it did not go. */
export async function sendOtpToPhone(
  message: OtpMessage,
  opts: { env?: Env; fetchImpl?: OtpFetch } = {},
): Promise<OtpSendResult> {
  const { provider, info } = resolveOtpProvider(opts.env ?? process.env, opts.fetchImpl);
  let result: OtpSendResult;
  if (!provider) {
    result = {
      status: 'failed',
      channel: null,
      provider: info.provider ?? 'none',
      sandbox: info.sandbox,
      error: info.reason,
    };
  } else {
    try {
      result = await provider.send(message);
    } catch {
      result = {
        status: 'failed',
        channel: null,
        provider: provider.name,
        sandbox: provider.sandbox,
        error: 'unexpected error',
      };
    }
  }
  // The outcome only: never the code, the number, the URL or the reply.
  if (result.status === 'sent') logger.info(result, 'One-time code sent');
  else logger.error(result, 'One-time code could not be sent');
  return result;
}
