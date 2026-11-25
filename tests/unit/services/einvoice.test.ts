import { describe, it, expect } from 'vitest';
import {
  resolveEInvoiceProvider,
  irnCancelWindowHours,
  encryptCredentials,
  decryptCredentials,
  credentialKeyInfo,
  maskUsername,
  parseIrnReply,
  parseEwayReply,
  parseEwayCancelReply,
  ewayCancelWindowHours,
  parsePortalDate,
  EINVOICE_SANDBOX_FIXTURES,
  EINVOICE_SANDBOX_LABEL,
  type IrnPayload,
} from '../../../src/services/einvoice';

// Gap #266 (GST bug G-5): the e-invoice / e-way bill provider seam.

const CREDS = { username: 'hospital01', password: 'pw', clientId: null, clientSecret: null, gstin: '33AAACS2601K1ZR' };

const payload = (buyer = '27AAPFU0939F1ZV'): IrnPayload => ({
  Version: '1.1',
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
  DocDtls: { Typ: 'INV', No: 'INV/26-27/0001', Dt: '24/11/2026' },
  SellerDtls: { Gstin: '33AAACS2601K1ZR', LglNm: 'H', Addr1: 'Addr', Loc: 'Chennai', Pin: 600001, Stcd: '33' },
  BuyerDtls: { Gstin: buyer, LglNm: 'B', Addr1: 'Addr', Loc: 'Mumbai', Pin: 400001, Stcd: '27', Pos: '27' },
  ItemList: [],
  ValDtls: { AssVal: 100, CgstVal: 0, SgstVal: 0, IgstVal: 18, CesVal: 0, Discount: 0, RndOffAmt: 0, TotInvVal: 118 },
});

describe('resolveEInvoiceProvider', () => {
  it('is not configured by default', () => {
    const { provider, info } = resolveEInvoiceProvider({});
    expect(provider).toBeNull();
    expect(info).toMatchObject({ configured: false, sandbox: false });
    expect(info.reason).toMatch(/not configured|No e-invoice/);
  });

  it('refuses the sandbox in production', () => {
    const { provider, info } = resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'sandbox', NODE_ENV: 'production' });
    expect(provider).toBeNull();
    expect(info).toMatchObject({ configured: false, sandbox: true });
    expect(info.reason).toMatch(/disabled in production/);
  });

  it('offers the sandbox outside production, flagged as sandbox', () => {
    const { provider, info } = resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'sandbox', NODE_ENV: 'development' });
    expect(provider?.sandbox).toBe(true);
    expect(info).toMatchObject({ configured: true, provider: 'sandbox', sandbox: true });
  });

  it('needs an https base URL for the http adapter', () => {
    expect(resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'http' }).info.reason).toMatch(/EINVOICE_BASE_URL is not set/);
    expect(resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'http', EINVOICE_BASE_URL: 'http://gsp.example' }).info.reason).toMatch(/https/);
    const ok = resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'http', EINVOICE_BASE_URL: 'https://gsp.example', EINVOICE_PROVIDER_NAME: 'x' });
    expect(ok.info).toMatchObject({ configured: true, provider: 'http:x', sandbox: false });
  });

  it('cancel window defaults to 24 hours and is configurable', () => {
    expect(irnCancelWindowHours({})).toBe(24);
    expect(irnCancelWindowHours({ EINVOICE_CANCEL_WINDOW_HOURS: '12' })).toBe(12);
    expect(irnCancelWindowHours({ EINVOICE_CANCEL_WINDOW_HOURS: 'nonsense' })).toBe(24);
  });
});

describe('sandbox provider', () => {
  const sandbox = resolveEInvoiceProvider({ EINVOICE_PROVIDER: 'sandbox', NODE_ENV: 'test' }).provider!;

  it('generates a deterministic 64-hex IRN, an ack number and a QR labelled SANDBOX', async () => {
    const a = await sandbox.generateIrn(CREDS, payload());
    const b = await sandbox.generateIrn(CREDS, payload());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(a.irn).toBe(b.irn);
    expect(a.ackNo).toMatch(/^\d{15}$/);
    expect(a.signedQrCode).toMatch(/\.SANDBOX-NOT-SIGNED$/);
    const body = JSON.parse(Buffer.from(a.signedQrCode!.split('.')[1], 'base64url').toString('utf8'));
    expect(JSON.parse(body.data).Note).toBe(EINVOICE_SANDBOX_LABEL);
  });

  it('rejects the fixture buyer GSTIN with the portal-style message', async () => {
    const r = await sandbox.generateIrn(CREDS, payload(EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('3028');
    expect(r.message).toMatch(/SANDBOX/);
  });

  it('cancels a 12-digit e-way bill, and refuses the fixture remark and a bad number', async () => {
    const ok = await sandbox.cancelEwayBill(CREDS, { ewayBillNo: '125644998983', reasonCode: '2', remark: 'Order cancelled' });
    expect(ok).toMatchObject({ ok: true, ewayBillNo: '125644998983' });
    if (ok.ok) expect(ok.cancelledAt).toBeInstanceOf(Date);
    const refused = await sandbox.cancelEwayBill(CREDS, {
      ewayBillNo: '125644998983',
      reasonCode: '4',
      remark: EINVOICE_SANDBOX_FIXTURES.refuseCancelRemark,
    });
    expect(refused).toMatchObject({ ok: false, code: '315' });
    if (!refused.ok) expect(refused.message).toMatch(/SANDBOX/);
    expect(await sandbox.cancelEwayBill(CREDS, { ewayBillNo: '12', reasonCode: '1', remark: 'Dup' })).toMatchObject({ ok: false, code: '312' });
  });

  it('fails Test connection for the fixture bad password', async () => {
    expect((await sandbox.testConnection('einvoice', CREDS)).ok).toBe(true);
    const bad = await sandbox.testConnection('eway', { ...CREDS, password: EINVOICE_SANDBOX_FIXTURES.badPassword });
    expect(bad.ok).toBe(false);
  });
});

describe('http adapter', () => {
  it('logs in, then sends the invoice with the token, and reads the NIC reply', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const text = url.endsWith('/authenticate')
        ? JSON.stringify({ Status: 1, Data: { AuthToken: 'tok' } })
        : JSON.stringify({
            Status: 1,
            Data: JSON.stringify({ Irn: 'a'.repeat(64), AckNo: 112010000000123, AckDt: '2026-11-24 10:15:00', SignedQRCode: 'eyJ.x.y' }),
          });
      return { status: 200, ok: true, text: async () => text };
    };
    const { provider } = resolveEInvoiceProvider(
      { EINVOICE_PROVIDER: 'http', EINVOICE_BASE_URL: 'https://gsp.example' },
      fetchImpl as never,
    );
    const r = await provider!.generateIrn(CREDS, payload());
    expect(r).toMatchObject({ ok: true, irn: 'a'.repeat(64), ackNo: '112010000000123', signedQrCode: 'eyJ.x.y', duplicate: false });
    if (r.ok) expect(r.ackDate.toISOString()).toBe('2026-11-24T04:45:00.000Z'); // IST → UTC
    expect(calls[0].url).toBe('https://gsp.example/einvoice/authenticate');
    expect(calls[1].headers.authtoken).toBe('tok');
    // Credentials travel in headers only — never in the URL.
    expect(calls.every((c) => !c.url.includes('hospital01') && !c.url.includes('pw'))).toBe(true);
  });

  it('reports the portal error verbatim', () => {
    const r = parseIrnReply(200, JSON.stringify({ Status: 0, ErrorDetails: [{ ErrorCode: '2172', ErrorMessage: 'Buyer PIN is invalid' }] }));
    expect(r).toMatchObject({ ok: false, code: '2172', message: '2172: Buyer PIN is invalid' });
  });

  it('treats a duplicate IRN reply as the existing registration', () => {
    const r = parseIrnReply(
      200,
      JSON.stringify({
        Status: 0,
        ErrorDetails: [{ ErrorCode: '2150', ErrorMessage: 'Duplicate IRN' }],
        InfoDtls: [{ InfCd: 'DUPIRN', Desc: { AckNo: 1, AckDt: '2026-11-24 10:00:00', Irn: 'b'.repeat(64) } }],
      }),
    );
    expect(r).toMatchObject({ ok: true, irn: 'b'.repeat(64), duplicate: true, signedQrCode: null });
  });

  it('turns a timeout into an uncertain failure', async () => {
    const fetchImpl = (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    const { provider } = resolveEInvoiceProvider(
      { EINVOICE_PROVIDER: 'http', EINVOICE_BASE_URL: 'https://gsp.example', EINVOICE_TIMEOUT_MS: '20' },
      fetchImpl as never,
    );
    const r = await provider!.testConnection('einvoice', CREDS);
    expect(r.ok).toBe(false);
  });

  it('cancels an e-way bill on the e-way login with NIC field names', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body });
      const text = url.endsWith('/authenticate')
        ? JSON.stringify({ status: 1, data: { authToken: 'tok' } })
        : JSON.stringify({ status: 1, data: { ewayBillNo: 125644998983, cancelDate: '24/11/2026 11:00:00 AM' } });
      return { status: 200, ok: true, text: async () => text };
    };
    const { provider } = resolveEInvoiceProvider(
      { EINVOICE_PROVIDER: 'http', EINVOICE_BASE_URL: 'https://gsp.example', EWAY_PATH_CANCEL: 'ewb/cancel' },
      fetchImpl as never,
    );
    const r = await provider!.cancelEwayBill(CREDS, { ewayBillNo: '125644998983', reasonCode: '3', remark: 'Wrong vehicle' });
    expect(r).toMatchObject({ ok: true, ewayBillNo: '125644998983' });
    if (r.ok) expect(r.cancelledAt.toISOString()).toBe('2026-11-24T05:30:00.000Z');
    expect(calls[0].url).toBe('https://gsp.example/ewaybill/authenticate');
    expect(calls[1].url).toBe('https://gsp.example/ewb/cancel');
    expect(JSON.parse(calls[1].body!)).toEqual({ ewbNo: 125644998983, cancelRsnCode: 3, cancelRmrk: 'Wrong vehicle' });
  });

  it('reports an e-way cancellation refusal verbatim', () => {
    expect(parseEwayCancelReply(200, JSON.stringify({ status: 0, error: { errorCodes: '315', message: 'Cannot cancel, verified' } }), '1'))
      .toMatchObject({ ok: false, message: expect.stringMatching(/Cannot cancel, verified/) });
  });

  it('e-way cancel window defaults to 24 hours and is configurable', () => {
    expect(ewayCancelWindowHours({})).toBe(24);
    expect(ewayCancelWindowHours({ EWAY_CANCEL_WINDOW_HOURS: '6' })).toBe(6);
    expect(ewayCancelWindowHours({ EWAY_CANCEL_WINDOW_HOURS: '-1' })).toBe(24);
  });

  it('reads e-way bill replies and IST dates', () => {
    expect(parseEwayReply(200, JSON.stringify({ status: '1', data: { ewayBillNo: 321012345678, ewayBillDate: '24/11/2026 10:15:00 AM', validUpto: '25/11/2026 11:59:00 PM' } })))
      .toMatchObject({ ok: true, ewayBillNo: '321012345678' });
    expect(parsePortalDate('24/11/2026 12:30:00 PM')?.toISOString()).toBe('2026-11-24T07:00:00.000Z');
  });
});

describe('credential encryption', () => {
  const env = { GST_PORTAL_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64') };

  it('round-trips and is bound to the tenant + portal', () => {
    const blob = encryptCredentials({ username: 'u', password: 'secret' }, 't1:einvoice', env);
    expect(blob).not.toContain('secret');
    expect(decryptCredentials(blob, 't1:einvoice', env)).toEqual({ username: 'u', password: 'secret' });
    expect(() => decryptCredentials(blob, 't2:einvoice', env)).toThrow(/cannot be decrypted/);
  });

  it('refuses to store without a key in production, falls back to a dev key elsewhere', () => {
    expect(credentialKeyInfo({ NODE_ENV: 'production' })).toMatchObject({ available: false });
    expect(credentialKeyInfo({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'x'.repeat(20) })).toMatchObject({
      available: true,
      source: 'development-fallback',
    });
    expect(credentialKeyInfo({ GST_PORTAL_CREDENTIALS_KEY: 'short' })).toMatchObject({ available: false });
  });

  it('masks the username', () => {
    expect(maskUsername('hospital01')).toBe('ho******01');
    expect(maskUsername('abc')).toBe('a***');
  });
});
