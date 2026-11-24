import { describe, it, expect, vi } from 'vitest';
import {
  parseTaxpayerReply,
  resolveGstinProvider,
  verifyGstin,
  SANDBOX_FIXTURES,
  SANDBOX_LEGAL_NAME,
} from '../../../src/services/gstin-verification';
import { DEFAULT_PATHS } from '../../../src/services/gstin-verification/http-adapter';

// Gap #311: the GSTIN provider seam — the configurable GSP adapter, the QA
// sandbox, and the rule that anything short of an active, matching answer is
// NOT verified.

const GSTIN = '27AAPFU0939F1ZV';
const CFG = { paths: DEFAULT_PATHS, activeValues: ['Active'] };
const KEY = 'super-secret-key-123';

const HTTP_ENV = {
  GSTIN_VERIFY_PROVIDER: 'http',
  GSTIN_VERIFY_PROVIDER_NAME: 'test-gsp',
  GSTIN_VERIFY_URL: 'https://gsp.example/search?gstin={gstin}',
  GSTIN_VERIFY_API_KEY: KEY,
  GSTIN_VERIFY_API_KEY_HEADER: 'x-api-key',
  GSTIN_VERIFY_TIMEOUT_MS: '50',
};

const reply = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('parseTaxpayerReply — reading a GSP reply', () => {
  it('reads the GST system field names at the top level', () => {
    const r = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ gstin: GSTIN, lgnm: 'ACME HOSPITAL PVT LTD', tradeNam: 'Acme', sts: 'Active' }), CFG);
    expect(r).toMatchObject({ status: 'verified', legalName: 'ACME HOSPITAL PVT LTD', tradeName: 'Acme', registrationStatus: 'Active', stateCode: '27', error: null });
  });

  it('reads them under a data wrapper, including data sent as a JSON string', () => {
    const wrapped = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ data: { gstin: GSTIN, lgnm: 'A', sts: 'Active' } }), CFG);
    expect(wrapped.status).toBe('verified');
    const stringData = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ data: JSON.stringify({ lgnm: 'B', sts: 'ACTIVE' }) }), CFG);
    expect(stringData).toMatchObject({ status: 'verified', legalName: 'B' });
  });

  it('honours configured paths', () => {
    const r = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ taxpayer: { name: 'X', state: 'Active' } }), {
      paths: { legalName: ['taxpayer.name'], tradeName: [], status: ['taxpayer.state'], gstin: [] },
      activeValues: ['Active'],
    });
    expect(r).toMatchObject({ status: 'verified', legalName: 'X' });
  });

  it('calls a cancelled or suspended registration inactive, not verified', () => {
    const r = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ lgnm: 'A', sts: 'Cancelled' }), CFG);
    expect(r).toMatchObject({ status: 'inactive', registrationStatus: 'Cancelled' });
    expect(r.error).toMatch(/Cancelled/);
  });

  it('is not verified when the provider answered about a different GSTIN', () => {
    const r = parseTaxpayerReply(GSTIN, 200, JSON.stringify({ gstin: '29AAPFU0939F1ZR', lgnm: 'A', sts: 'Active' }), CFG);
    expect(r.status).toBe('error');
    expect(r.legalName).toBeNull();
  });

  it('maps 404 and "no records found" to not_found', () => {
    expect(parseTaxpayerReply(GSTIN, 404, '', CFG).status).toBe('not_found');
    expect(parseTaxpayerReply(GSTIN, 400, JSON.stringify({ error: { message: 'No records found' } }), CFG).status).toBe('not_found');
    expect(parseTaxpayerReply(GSTIN, 200, JSON.stringify({ status_cd: '0', error: { message: 'Invalid GSTIN / No such GSTIN' } }), CFG).status).toBe('not_found');
  });

  it('treats bad credentials, server errors and unrecognised replies as errors', () => {
    expect(parseTaxpayerReply(GSTIN, 401, '', CFG).status).toBe('error');
    expect(parseTaxpayerReply(GSTIN, 503, '', CFG).status).toBe('error');
    expect(parseTaxpayerReply(GSTIN, 200, '<html>oops</html>', CFG).status).toBe('error');
    expect(parseTaxpayerReply(GSTIN, 200, JSON.stringify({ something: 'else' }), CFG).status).toBe('error');
  });

  it('does not verify an active registration that came without a legal name', () => {
    expect(parseTaxpayerReply(GSTIN, 200, JSON.stringify({ sts: 'Active' }), CFG).status).toBe('error');
  });
});

describe('resolveGstinProvider — what is configured', () => {
  it('is not configured by default', async () => {
    const { provider, info } = resolveGstinProvider({});
    expect(provider).toBeNull();
    expect(info).toMatchObject({ configured: false, sandbox: false });
    expect(info.reason).toMatch(/not configured/);
    const r = await verifyGstin(GSTIN, { env: {} });
    expect(r.status).toBe('not_configured');
  });

  it('never falls back to the sandbox — it must be asked for by name', () => {
    expect(resolveGstinProvider({ GSTIN_VERIFY_PROVIDER: 'sandbx' }).provider).toBeNull();
    expect(resolveGstinProvider({ GSTIN_VERIFY_PROVIDER: 'http' }).info.sandbox).toBe(false);
  });

  it('refuses the sandbox in production', () => {
    const { provider, info } = resolveGstinProvider({ GSTIN_VERIFY_PROVIDER: 'sandbox', NODE_ENV: 'production' });
    expect(provider).toBeNull();
    expect(info.configured).toBe(false);
  });

  it('needs a URL with {gstin}, https, and a key for the HTTP adapter', () => {
    expect(resolveGstinProvider({ ...HTTP_ENV, GSTIN_VERIFY_URL: '' }).info.reason).toMatch(/GSTIN_VERIFY_URL/);
    expect(resolveGstinProvider({ ...HTTP_ENV, GSTIN_VERIFY_URL: 'https://gsp.example/search' }).info.reason).toMatch(/\{gstin\}/);
    expect(resolveGstinProvider({ ...HTTP_ENV, GSTIN_VERIFY_URL: 'http://gsp.example/{gstin}' }).info.reason).toMatch(/https/);
    expect(resolveGstinProvider({ ...HTTP_ENV, GSTIN_VERIFY_API_KEY: '' }).info.reason).toMatch(/API_KEY/);
    expect(resolveGstinProvider(HTTP_ENV).info).toMatchObject({ configured: true, provider: 'http:test-gsp' });
  });
});

describe('the sandbox', () => {
  const env = { GSTIN_VERIFY_PROVIDER: 'sandbox', NODE_ENV: 'development' };

  it('verifies only its active fixture, and labels every result as sandbox', async () => {
    const ok = await verifyGstin(SANDBOX_FIXTURES.active, { env });
    expect(ok).toMatchObject({ status: 'verified', sandbox: true, provider: 'sandbox', legalName: SANDBOX_LEGAL_NAME });
    expect((await verifyGstin(SANDBOX_FIXTURES.inactive, { env })).status).toBe('inactive');
    expect((await verifyGstin(SANDBOX_FIXTURES.error, { env })).status).toBe('error');
    const other = await verifyGstin(GSTIN, { env });
    expect(other).toMatchObject({ status: 'not_found', sandbox: true });
    expect(other.error).toMatch(/SANDBOX/);
  });
});

describe('the HTTP adapter', () => {
  it('sends only the GSTIN, with the key in the configured header', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { gstin: GSTIN, lgnm: 'ACME', sts: 'Active' }));
    const r = await verifyGstin(GSTIN, { env: HTTP_ENV, fetchImpl });
    expect(r).toMatchObject({ status: 'verified', provider: 'http:test-gsp', sandbox: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body?: string }];
    expect(url).toBe(`https://gsp.example/search?gstin=${GSTIN}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['x-api-key']).toBe(KEY);
  });

  it('POSTs a body holding nothing but the GSTIN', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { lgnm: 'ACME', sts: 'Active' }));
    await verifyGstin(GSTIN, {
      env: { ...HTTP_ENV, GSTIN_VERIFY_METHOD: 'POST', GSTIN_VERIFY_URL: 'https://gsp.example/search', GSTIN_VERIFY_API_KEY_HEADER: 'Authorization', GSTIN_VERIFY_API_KEY_PREFIX: 'Bearer ' },
      fetchImpl,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }])[1];
    expect(JSON.parse(init.body)).toEqual({ gstin: GSTIN });
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('gives up after the timeout and stays unverified', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const r = await verifyGstin(GSTIN, { env: HTTP_ENV, fetchImpl: fetchImpl as never });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/did not answer/);
  });

  it('turns a network failure into an error that quotes neither the key nor the URL', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error(`fetch failed for https://gsp.example/?key=${KEY}`), { cause: { code: 'ECONNREFUSED' } });
    });
    const r = await verifyGstin(GSTIN, { env: HTTP_ENV, fetchImpl });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.error).not.toContain('gsp.example');
  });

  it('never puts the key into a result, even on a credential refusal', async () => {
    const fetchImpl = vi.fn(async () => reply(401, { message: 'bad key' }));
    const r = await verifyGstin(GSTIN, { env: HTTP_ENV, fetchImpl });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
