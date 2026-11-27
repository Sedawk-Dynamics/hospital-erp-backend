import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../../src/config/logger';
import { isOtpCountryAllowed, resolveOtpProvider, sendOtpToPhone } from '../../../src/services/otp-delivery';
import { isSamePhone, maskPhone, phoneE164 } from '../../../src/shared/phone-identity';

// Sending one-time codes: provider selection, the http adapter, and what never leaks.

const MSG = { to: '+919000000011', code: '731904', expiresInMinutes: 5 };
const SECRET = 'Bearer very-secret';

const SMS = {
  OTP_PROVIDER: 'http',
  OTP_PROVIDER_NAME: 'test-gw',
  OTP_SMS_URL: 'https://sms.example.com/send',
  OTP_SMS_AUTH_HEADER: 'x-api-key',
  OTP_SMS_AUTH_VALUE: SECRET,
  OTP_SMS_SENDER_ID: 'TESTHS',
  OTP_SMS_DLT_ENTITY_ID: 'ENT1',
  OTP_SMS_DLT_TEMPLATE_ID: 'TPL1',
  OTP_SMS_TEXT: 'Your code is {code}, valid {minutes} minutes.',
};
const WHATSAPP = {
  OTP_WHATSAPP_URL: 'https://wa.example.com/messages',
  OTP_WHATSAPP_AUTH_VALUE: SECRET,
  OTP_WHATSAPP_TEMPLATE_NAME: 'signin_code',
};

const reply = (status = 200, text = '{"ok":true}') => ({ status, ok: status < 300, text: async () => text });

beforeEach(() => vi.clearAllMocks());

describe('choosing a provider', () => {
  it('is not configured by default', async () => {
    for (const kind of [undefined, '', 'none', 'off']) {
      expect(resolveOtpProvider({ OTP_PROVIDER: kind }).info).toMatchObject({ configured: false, provider: null });
    }
    expect((await sendOtpToPhone(MSG, { env: {} })).status).toBe('failed');
  });

  it('an unknown provider or channel is not configured', () => {
    expect(resolveOtpProvider({ OTP_PROVIDER: 'carrier-pigeon' }).provider).toBeNull();
    expect(resolveOtpProvider({ ...SMS, OTP_CHANNELS: 'sms,fax' }).provider).toBeNull();
  });

  it.each(['production', undefined, 'staging'])('refuses the sandbox with NODE_ENV=%s', async (NODE_ENV) => {
    const env = { OTP_PROVIDER: 'sandbox', NODE_ENV };
    expect(resolveOtpProvider(env)).toMatchObject({ provider: null, info: { configured: false, sandbox: true } });
    expect((await sendOtpToPhone(MSG, { env })).status).toBe('failed');
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('the sandbox writes the code at debug level only, with the number masked', async () => {
    const res = await sendOtpToPhone(MSG, { env: { OTP_PROVIDER: 'sandbox', NODE_ENV: 'development' } });
    expect(res).toMatchObject({ status: 'sent', sandbox: true });
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).toContain(MSG.code);
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('9000000011');
    for (const level of ['info', 'warn', 'error'] as const) {
      expect(JSON.stringify(vi.mocked(logger[level]).mock.calls)).not.toContain(MSG.code);
    }
  });

  it.each([
    ['OTP_SMS_URL', ''],
    ['OTP_SMS_URL', 'http://sms.example.com/send'],
    ['OTP_SMS_URL', 'https://{code}.example.com/'],
    ['OTP_SMS_URL', 'not a url'],
    ['OTP_SMS_AUTH_VALUE', ''],
    ['OTP_SMS_SENDER_ID', ''],
    ['OTP_SMS_DLT_ENTITY_ID', ''],
    ['OTP_SMS_DLT_TEMPLATE_ID', ''],
    ['OTP_SMS_TEXT', 'no code here'],
    ['OTP_SMS_BODY', 'not json'],
    ['OTP_SMS_BODY', '{"message":"{message}"}'],
    ['OTP_SMS_EXTRA_HEADERS', '[1]'],
  ])('is not configured with %s=%s', (key, value) => {
    const { provider, info } = resolveOtpProvider({ ...SMS, [key]: value });
    expect(provider).toBeNull();
    expect(info.reason).not.toContain(SECRET);
  });

  it('allows plain http to localhost only', () => {
    expect(resolveOtpProvider({ ...SMS, OTP_SMS_URL: 'http://localhost:9999/send' }).provider).not.toBeNull();
  });

  it('WhatsApp needs a template name', () => {
    expect(resolveOtpProvider({ OTP_PROVIDER: 'http', OTP_CHANNELS: 'whatsapp', ...WHATSAPP }).provider).not.toBeNull();
    expect(
      resolveOtpProvider({ OTP_PROVIDER: 'http', OTP_CHANNELS: 'whatsapp', ...WHATSAPP, OTP_WHATSAPP_TEMPLATE_NAME: '' }).provider,
    ).toBeNull();
  });

  it('India only unless widened', () => {
    expect(isOtpCountryAllowed('+919000000011', {})).toBe(true);
    expect(isOtpCountryAllowed('+16502530000', {})).toBe(false);
    expect(isOtpCountryAllowed('+16502530000', { OTP_ALLOWED_COUNTRY_CODES: '91, +1' })).toBe(true);
  });
});

describe('the http adapter', () => {
  it('sends the number, the code and the registered ids, and nothing else', async () => {
    const fetchImpl = vi.fn(async () => reply());
    expect(await sendOtpToPhone(MSG, { env: SMS, fetchImpl })).toEqual({
      status: 'sent', channel: 'sms', provider: 'http:test-gw', sandbox: false, error: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(url).toBe('https://sms.example.com/send');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers['x-api-key']).toBe(SECRET);
    expect(JSON.parse(init.body)).toEqual({
      to: '919000000011', sender: 'TESTHS', entityId: 'ENT1', templateId: 'TPL1',
      message: 'Your code is 731904, valid 5 minutes.',
    });
  });

  it('supports GET and form bodies, with values encoded', async () => {
    const fetchImpl = vi.fn(async () => reply());
    await sendOtpToPhone(MSG, {
      env: { ...SMS, OTP_SMS_METHOD: 'GET', OTP_SMS_URL: 'https://sms.example.com/s?to={to}&text={message}' }, fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(url).toBe('https://sms.example.com/s?to=%2B919000000011&text=Your%20code%20is%20731904%2C%20valid%205%20minutes.');
    expect(init.body).toBeUndefined();
    await sendOtpToPhone(MSG, { env: { ...SMS, OTP_SMS_BODY_TYPE: 'form' }, fetchImpl });
    expect((fetchImpl.mock.calls[1] as unknown as [string, { body: string }])[1].body).toContain('message=Your+code+is+731904');
  });

  it('uses the WhatsApp authentication template', async () => {
    const fetchImpl = vi.fn(async () => reply());
    const env = { OTP_PROVIDER: 'http', OTP_CHANNELS: 'whatsapp', ...WHATSAPP };
    expect((await sendOtpToPhone(MSG, { env, fetchImpl })).channel).toBe('whatsapp');
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.template.name).toBe('signin_code');
    expect(body.template.components[0].parameters[0].text).toBe(MSG.code);
  });

  it('falls back to the next channel in order', async () => {
    const fetchImpl = vi.fn(async (url: string) => reply(url.includes('wa.') ? 500 : 200));
    const env = { ...SMS, ...WHATSAPP, OTP_CHANNELS: 'whatsapp,sms' };
    expect(await sendOtpToPhone(MSG, { env, fetchImpl })).toMatchObject({ status: 'sent', channel: 'sms' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a 200 that does not confirm the message is a failure when a success text is set', async () => {
    const fetchImpl = vi.fn(async () => reply(200, '{"status":"rejected"}'));
    expect((await sendOtpToPhone(MSG, { env: { ...SMS, OTP_SMS_SUCCESS_TEXT: '"accepted"' }, fetchImpl })).status).toBe('failed');
  });

  it('gives up after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    );
    const res = await sendOtpToPhone(MSG, { env: { ...SMS, OTP_TIMEOUT_MS: '20' }, fetchImpl });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('no answer');
  });

  it('never logs or returns the code, the number, the URL, the key or the reply', async () => {
    const replies = [
      async () => reply(200, `${MSG.code} sent to ${MSG.to}`),
      async () => reply(500, `${MSG.code} ${SECRET}`),
      async () => { throw Object.assign(new Error(`https://sms.example.com/send ${MSG.code}`), { cause: { code: 'ECONNREFUSED' } }); },
    ];
    for (const fetchImpl of replies) {
      const res = await sendOtpToPhone(MSG, { env: SMS, fetchImpl });
      const text = JSON.stringify([res, ...(['debug', 'info', 'warn', 'error'] as const).map((l) => vi.mocked(logger[l]).mock.calls)]);
      for (const secret of [MSG.code, '9000000011', SECRET, 'sms.example.com']) expect(text).not.toContain(secret);
    }
  });
});

describe('phone identity', () => {
  it('reads Indian numbers in any form and keeps other countries apart', () => {
    for (const raw of ['9000000011', '09000000011', '919000000011', '+91 90000-00011', '0091 9000000011']) {
      expect(phoneE164(raw)).toBe('+919000000011');
    }
    expect(phoneE164('+1 (650) 253-0000')).toBe('+16502530000');
    for (const bad of ['', null, '12345', '+91123', 'abc', '+0123456789']) expect(phoneE164(bad)).toBeNull();
    expect(isSamePhone('6502530000', '+16502530000')).toBe(false);
    expect(maskPhone('+919000000011')).toBe('+91 ******0011');
  });
});
