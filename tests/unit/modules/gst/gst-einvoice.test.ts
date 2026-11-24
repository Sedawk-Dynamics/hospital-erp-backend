import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import { prisma } from '../../../../src/config/database';
import { encryptCredentials, EINVOICE_SANDBOX_FIXTURES } from '../../../../src/services/einvoice';
import {
  generateIrnForBill,
  cancelIrnForBill,
  generateEwayBillForReturn,
} from '../../../../src/modules/gst/gst-einvoice.service';
import { getPortalReadiness, savePortalCredentials } from '../../../../src/modules/gst/gst-portal.credentials';
import { updateGstProfile } from '../../../../src/modules/hospital-settings/hospital-settings.service';

vi.mock('../../../../src/middleware/authenticate', () => ({
  authenticate: (_req: unknown, _res: unknown, next: NextFunction) => next(),
}));

// Gap #266 (GST bug G-5): e-invoice generate / idempotency / failure + retry /
// cancel window, the e-way bill path, and the readiness gate on the switches.

const TENANT = 'tenant-1';
const USER = 'user-1';
const HOSPITAL_GSTIN = '33AAACS2601K1ZR';
const BUYER_GSTIN = '27AAPFU0939F1ZV';
const HOUR = 60 * 60 * 1000;

const ENV_KEYS = ['EINVOICE_PROVIDER', 'EINVOICE_CANCEL_WINDOW_HOURS', 'GST_PORTAL_CREDENTIALS_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

const gst = (over: Record<string, unknown> = {}) => ({
  registered: true,
  gstin: HOSPITAL_GSTIN,
  legalName: 'Test Hospital Private Limited',
  eInvoiceApplicable: true,
  eWayBillApplicable: true,
  ...over,
});

function mockTenant(gstOver: Record<string, unknown> = {}) {
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { gst: gst(gstOver) },
    name: 'Test Hospital',
    address: '1 Main Road, Chennai 600001',
    city: 'Chennai',
    state: 'Tamil Nadu',
    phone: '044-1234567',
    email: 'accounts@example.test',
  });
}

function mockCredentials(portal: 'einvoice' | 'eway' = 'einvoice') {
  (prisma.gstPortalCredential.findUnique as any).mockImplementation(async (args: any) => {
    const p = args.where.tenantId_portal.portal;
    if (portal !== p && portal !== ('both' as never)) return null;
    return {
      secretCipher: encryptCredentials(
        { username: 'hospital01', password: 'pw', clientId: null, clientSecret: null },
        `gst-portal:${TENANT}:${p}`,
      ),
      usernameHint: 'ho******01',
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      lastTestProvider: null,
      updatedAt: new Date(),
    };
  });
}

const bill = (over: Record<string, unknown> = {}) => ({
  id: 'bill-1',
  tenantId: TENANT,
  status: 'paid',
  billDate: new Date('2026-11-24T05:00:00Z'),
  invoiceNumber: 'INV/26-27/0001',
  billOfSupplyNumber: null,
  gstDocumentType: 'tax_invoice',
  supplierGstin: HOSPITAL_GSTIN,
  supplierStateCode: '33',
  recipientGstin: BUYER_GSTIN,
  recipientLegalName: 'Acme Insurance Ltd',
  recipientAddress: '5 Marine Drive, Mumbai 400001',
  placeOfSupplyStateCode: '27',
  isInterState: true,
  roundOff: 0,
  irn: null,
  irnAckNo: null,
  irnAckDate: null,
  irnQrPayload: null,
  irnStatus: null,
  irnError: null,
  irnAttemptedAt: null,
  irnCancelledAt: null,
  billItems: [
    {
      description: 'Health check package',
      category: 'other',
      quantity: 1,
      discountAmount: 0,
      hsnSacCode: '999312',
      gstTreatment: 'taxable',
      taxableValue: 1000,
      cgstRate: 0,
      cgstAmount: 0,
      sgstRate: 0,
      sgstAmount: 0,
      igstRate: 18,
      igstAmount: 180,
      cessAmount: 0,
    },
  ],
  ...over,
});

const auditDescriptions = () =>
  (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.description as string);

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EINVOICE_PROVIDER = 'sandbox';
  mockTenant();
  mockCredentials();
  (prisma.gstinVerification.findUnique as any).mockResolvedValue(null);
  (prisma.bill.updateMany as any).mockResolvedValue({ count: 1 });
  (prisma.bill.update as any).mockResolvedValue({});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('generateIrnForBill', () => {
  it('registers a finalised B2B invoice and stores IRN, ack no, ack date and the signed QR', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    const out = await generateIrnForBill(TENANT, USER, 'bill-1');
    expect(out).toMatchObject({ status: 'registered', sandbox: true, alreadyRegistered: false, signedQrCode: true });
    expect(out.irn).toMatch(/^[0-9a-f]{64}$/);

    // Claimed first (pending), only when no IRN is held.
    const claim = (prisma.bill.updateMany as any).mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 'bill-1', tenantId: TENANT, irn: null });
    expect(claim.data.irnStatus).toBe('pending');

    const saved = (prisma.bill.update as any).mock.calls[0][0].data;
    expect(saved).toMatchObject({ irn: out.irn, irnStatus: 'registered', irnError: null });
    expect(saved.irnAckNo).toMatch(/^\d{15}$/);
    expect(saved.irnAckDate).toBeInstanceOf(Date);
    expect(saved.irnQrPayload).toMatch(/SANDBOX-NOT-SIGNED$/);
    expect(auditDescriptions().some((d: string) => /IRN generated for invoice INV\/26-27\/0001/.test(d) && /SANDBOX/.test(d))).toBe(true);
  });

  it('is idempotent: an invoice holding an IRN is never sent again', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(
      bill({ irn: 'f'.repeat(64), irnAckNo: '1', irnAckDate: new Date(), irnStatus: 'registered', irnQrPayload: 'qr' }),
    );
    const out = await generateIrnForBill(TENANT, USER, 'bill-1');
    expect(out).toMatchObject({ alreadyRegistered: true, irn: 'f'.repeat(64), status: 'registered' });
    expect(prisma.bill.updateMany).not.toHaveBeenCalled();
    expect(prisma.bill.update).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent send (claim lost)', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    (prisma.bill.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(generateIrnForBill(TENANT, USER, 'bill-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.bill.update).not.toHaveBeenCalled();
  });

  it('stores a portal refusal in the portal\'s words, and Retry then registers it', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill({ recipientGstin: EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin }));
    const failed = await generateIrnForBill(TENANT, USER, 'bill-1');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^3028: /);
    expect((prisma.bill.update as any).mock.calls[0][0].data).toMatchObject({ irnStatus: 'failed', irnError: failed.error });
    expect(auditDescriptions().some((d: string) => /failed/.test(d) && /3028/.test(d))).toBe(true);

    vi.clearAllMocks();
    mockTenant();
    mockCredentials();
    (prisma.bill.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.bill.update as any).mockResolvedValue({});
    (prisma.bill.findFirst as any).mockResolvedValue(bill({ irnStatus: 'failed', irnError: failed.error, irnAttemptedAt: new Date() }));
    const retried = await generateIrnForBill(TENANT, USER, 'bill-1', 'retry');
    expect(retried.status).toBe('registered');
    expect(auditDescriptions().some((d: string) => /generated on retry/.test(d))).toBe(true);
  });

  it('Retry refuses a document that has not failed', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    await expect(generateIrnForBill(TENANT, USER, 'bill-1', 'retry')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records a local data problem (no HSN) as a failure without calling the portal', async () => {
    const b = bill();
    (b.billItems[0] as any).hsnSacCode = null;
    (prisma.bill.findFirst as any).mockResolvedValue(b);
    const out = await generateIrnForBill(TENANT, USER, 'bill-1');
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/Not sent to the portal — .*HSN/);
    expect((prisma.bill.updateMany as any).mock.calls[0][0].data.irnStatus).toBe('failed');
  });

  it.each([
    ['a B2C bill', { recipientGstin: null }],
    ['an unfinalised draft', { invoiceNumber: null }],
    ['a cancelled bill', { status: 'cancelled' }],
  ])('refuses %s', async (_label, over) => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill(over));
    await expect(generateIrnForBill(TENANT, USER, 'bill-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.bill.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when the integration is not ready (no provider)', async () => {
    delete process.env.EINVOICE_PROVIDER;
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    await expect(generateIrnForBill(TENANT, USER, 'bill-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'EINVOICE_NOT_AVAILABLE',
    });
  });

  it('refuses when credentials are not saved', async () => {
    (prisma.gstPortalCredential.findUnique as any).mockResolvedValue(null);
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    await expect(generateIrnForBill(TENANT, USER, 'bill-1')).rejects.toMatchObject({ code: 'EINVOICE_NOT_AVAILABLE' });
  });
});

describe('cancelIrnForBill', () => {
  const registered = (ackAgoMs: number) =>
    bill({ irn: 'a'.repeat(64), irnAckNo: '1', irnAckDate: new Date(Date.now() - ackAgoMs), irnStatus: 'registered', irnQrPayload: 'qr' });

  it('cancels within the window, with a reason, and audits it', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(registered(2 * HOUR));
    const out = await cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '2', remark: 'Wrong buyer' });
    expect(out.status).toBe('cancelled');
    const call = (prisma.bill.updateMany as any).mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'bill-1', irnStatus: 'registered' });
    expect(call.data.irnStatus).toBe('cancelled');
    expect(call.data.irnCancelledAt).toBeInstanceOf(Date);
    const audit = (prisma.auditLog.create as any).mock.calls.at(-1)[0].data.description as string;
    expect(audit).toMatch(/cancelled/);
    expect(audit).toMatch(/Data entry mistake — Wrong buyer/);
  });

  it('refuses after the window and changes nothing', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(registered(25 * HOUR));
    await expect(cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '2', remark: 'Wrong buyer' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IRN_CANCEL_WINDOW_CLOSED',
    });
    expect(prisma.bill.updateMany).not.toHaveBeenCalled();
  });

  it('honours a configured window', async () => {
    process.env.EINVOICE_CANCEL_WINDOW_HOURS = '1';
    (prisma.bill.findFirst as any).mockResolvedValue(registered(2 * HOUR));
    await expect(cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({
      code: 'IRN_CANCEL_WINDOW_CLOSED',
    });
  });

  it('needs a reason code and a remark', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(registered(HOUR));
    await expect(cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '9', remark: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '1', remark: '' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a document without a registered IRN', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill({ irnStatus: 'failed' }));
    await expect(cancelIrnForBill(TENANT, USER, 'bill-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({
      code: 'IRN_NOT_REGISTERED',
    });
  });
});

describe('generateEwayBillForReturn', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'ret-1',
    createdAt: new Date('2026-11-24T05:00:00Z'),
    quantity: 100,
    status: 'processed',
    returnNumber: 'VR-0001',
    creditAmount: 60000,
    ewayBillNumber: null,
    ewayBillDate: null,
    inputGstPercent: 12,
    inputTaxableValue: 60000,
    inputCgst: 0,
    inputSgst: 0,
    inputIgst: 7200,
    drug: { drugName: 'Paracetamol 500', hsnCode: '30049099' },
    drugBatch: null,
    supplier: { name: 'Pharma Distributors', gstNumber: BUYER_GSTIN, address: 'Mumbai 400001' },
    ...over,
  });

  beforeEach(() => {
    mockCredentials('eway');
    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
    (prisma.drugReturn.updateMany as any).mockResolvedValue({ count: 2 });
  });

  it('generates one e-way bill for the whole return and writes it on every line', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line(), line({ id: 'ret-2' })]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', { transMode: '1', distanceKm: 1300, vehicleNo: 'TN 01 AB 1234' });
    expect(out.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(out.sandbox).toBe(true);
    // Claimed first (pending, transport recorded), then the number written on every line.
    const claim = (prisma.drugReturn.updateMany as any).mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: { in: ['ret-1', 'ret-2'] }, ewayBillNumber: null });
    expect(claim.data).toMatchObject({ ewayBillStatus: 'pending', ewayBillTransport: { transMode: '1', distanceKm: 1300, vehicleNo: 'TN01AB1234' } });
    const call = (prisma.drugReturn.updateMany as any).mock.calls.at(-1)[0];
    expect(call.where).toMatchObject({ id: { in: ['ret-1', 'ret-2'] }, ewayBillNumber: null });
    expect(call.data.ewayBillNumber).toBe(out.ewayBillNumber);
    expect(call.data.ewayBillStatus).toBe('generated');
  });

  it('is idempotent', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ ewayBillNumber: '321000000001', ewayBillDate: new Date() })]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', { transMode: '1', distanceKm: 10, vehicleNo: 'TN01AB1234' });
    expect(out.alreadyGenerated).toBe(true);
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();
  });

  it('needs a vehicle or transporter for road transport', async () => {
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', { transMode: '1', distanceKm: 10 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses when e-way bills are not ready', async () => {
    (prisma.gstPortalCredential.findUnique as any).mockResolvedValue(null);
    (prisma.drugReturn.findMany as any).mockResolvedValue([line()]);
    await expect(
      generateEwayBillForReturn(TENANT, USER, 'ret-1', { transMode: '1', distanceKm: 10, vehicleNo: 'TN01AB1234' }),
    ).rejects.toMatchObject({ code: 'EINVOICE_NOT_AVAILABLE' });
  });
});

describe('readiness gate on the GST settings switches', () => {
  it('reports not ready without a provider', async () => {
    delete process.env.EINVOICE_PROVIDER;
    const r = await getPortalReadiness(TENANT, 'einvoice');
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/provider/i);
    // Never returns a secret.
    expect(JSON.stringify(r)).not.toContain('"pw"');
  });

  it('refuses to switch e-invoicing ON while not available (409)', async () => {
    delete process.env.EINVOICE_PROVIDER;
    mockTenant({ eInvoiceApplicable: false, eWayBillApplicable: false });
    await expect(updateGstProfile(TENANT, { eInvoiceApplicable: true }, USER)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EINVOICE_NOT_AVAILABLE',
      message: expect.stringMatching(/not available/),
    });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('refuses to switch e-way bills ON without saved e-way credentials', async () => {
    mockTenant({ eInvoiceApplicable: false, eWayBillApplicable: false });
    mockCredentials('einvoice');
    await expect(updateGstProfile(TENANT, { eWayBillApplicable: true }, USER)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows switching ON once provider and credentials are ready', async () => {
    mockTenant({ eInvoiceApplicable: false, eWayBillApplicable: false });
    const out = await updateGstProfile(TENANT, { eInvoiceApplicable: true }, USER);
    expect(out.eInvoiceApplicable).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalled();
  });

  it('does not block an unrelated save when a switch is already on in data', async () => {
    delete process.env.EINVOICE_PROVIDER;
    mockTenant({ eInvoiceApplicable: true });
    await expect(updateGstProfile(TENANT, { tradeName: 'New name' }, USER)).resolves.toBeTruthy();
  });

  it('saves credentials encrypted, masked in the answer, and audits without secrets', async () => {
    (prisma.gstPortalCredential.findUnique as any).mockResolvedValueOnce(null);
    await savePortalCredentials(TENANT, USER, 'einvoice', { username: 'hospital01', password: 'S3cret!pass', clientSecret: 'cs-123' });
    const up = (prisma.gstPortalCredential.upsert as any).mock.calls[0][0];
    expect(up.create.secretCipher).toMatch(/^v1\./);
    expect(JSON.stringify(up)).not.toContain('S3cret!pass');
    expect(up.create.usernameHint).toBe('ho******01');
    const audits = JSON.stringify((prisma.auditLog.create as any).mock.calls);
    expect(audits).not.toContain('S3cret!pass');
    expect(audits).not.toContain('cs-123');
  });
});

describe('IRN route permissions', () => {
  async function runRoute(path: string, roles: string[]) {
    const { gstEinvoiceRoutes } = await import('../../../../src/modules/gst/gst-einvoice.routes');
    const layer = (gstEinvoiceRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
    expect(layer).toBeTruthy();
    const handlers = layer.route.stack.map((s: any) => s.handle);
    const req: any = { user: { userId: USER, tenantId: TENANT, email: 'a@b.c', roles }, body: {}, params: { billId: 'bill-1' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    let error: any;
    for (const h of handlers) {
      let advanced = false;
      await h(req, res as Response, (e?: unknown) => {
        if (e) error = e;
        else advanced = true;
      });
      if (error || !advanced) break;
    }
    return { error, res };
  }

  it.each(['cashier', 'front_desk', 'doctor', 'insurance_staff'])('refuses %s with 403', async (role) => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    for (const p of ['/einvoice/bills/:billId/generate', '/einvoice/bills/:billId/retry', '/einvoice/bills/:billId/cancel']) {
      const { error } = await runRoute(p, [role]);
      expect(error?.statusCode).toBe(403);
    }
    expect(prisma.bill.updateMany).not.toHaveBeenCalled();
  });

  it.each(['admin', 'billing_admin'])('lets %s generate', async (role) => {
    (prisma.bill.findFirst as any).mockResolvedValue(bill());
    const { error, res } = await runRoute('/einvoice/bills/:billId/generate', [role]);
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('printed invoice', () => {
  it('prints a cancelled IRN as cancelled and a sandbox IRN as SANDBOX', async () => {
    const { buildGstBlock } = await import('../../../../src/modules/billing/billing.gst-layout');
    const header = {
      gstDocumentType: 'tax_invoice',
      invoiceNumber: 'INV/1',
      recipientGstin: BUYER_GSTIN,
      irn: 'a'.repeat(64),
      irnAckNo: '1',
      irnAckDate: new Date(),
      irnQrPayload: 'x.y.SANDBOX-NOT-SIGNED',
    };
    const live = buildGstBlock({ registered: true, gstin: HOSPITAL_GSTIN, eInvoiceApplicable: true }, [header], []);
    expect(live.irn).toBe('a'.repeat(64));
    expect(live.notes.some((n) => /SANDBOX IRN/.test(n))).toBe(true);
    expect(live.notes.some((n) => /CANCELLED/.test(n))).toBe(false);

    const cancelled = buildGstBlock(
      { registered: true, gstin: HOSPITAL_GSTIN, eInvoiceApplicable: true },
      [{ ...header, irnStatus: 'cancelled', irnCancelledAt: new Date() }],
      [],
    );
    expect(cancelled.notes.some((n) => /CANCELLED on the e-invoice portal/.test(n))).toBe(true);
  });
});
