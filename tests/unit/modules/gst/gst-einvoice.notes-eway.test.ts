import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import { prisma } from '../../../../src/config/database';
import { encryptCredentials, EINVOICE_SANDBOX_FIXTURES } from '../../../../src/services/einvoice';
import {
  buildNoteIrnPayload,
  generateIrnForNote,
  cancelIrnForNote,
  generateEwayBillForReturn,
  cancelEwayBillForReturn,
} from '../../../../src/modules/gst/gst-einvoice.service';

vi.mock('../../../../src/middleware/authenticate', () => ({
  authenticate: (_req: unknown, _res: unknown, next: NextFunction) => next(),
}));

// Gap #266 (GST bug G-5), the parts left after the invoice IRN:
//   - IRN for B2B credit / debit notes (CRN / DBN, naming the original invoice)
//   - e-way bill cancellation inside the window, refused after it
//   - a failed e-way attempt persisted on the return, with Retry
//   - idempotency, audit, and the GST-manager-only permission on every route

const TENANT = 'tenant-1';
const USER = 'user-1';
const HOSPITAL_GSTIN = '33AAACS2601K1ZR';
const BUYER_GSTIN = '27AAPFU0939F1ZV';
const HOUR = 60 * 60 * 1000;

const ENV_KEYS = ['EINVOICE_PROVIDER', 'EINVOICE_CANCEL_WINDOW_HOURS', 'EWAY_CANCEL_WINDOW_HOURS', 'GST_PORTAL_CREDENTIALS_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

function mockTenant() {
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: {
      gst: {
        registered: true,
        gstin: HOSPITAL_GSTIN,
        legalName: 'Test Hospital Private Limited',
        eInvoiceApplicable: true,
        eWayBillApplicable: true,
      },
    },
    name: 'Test Hospital',
    address: '1 Main Road, Chennai 600001',
    city: 'Chennai',
    state: 'Tamil Nadu',
    phone: '044-1234567',
    email: 'accounts@example.test',
  });
}

/** Saved (fake) logins for both portals. */
function mockCredentials() {
  (prisma.gstPortalCredential.findUnique as any).mockImplementation(async (args: any) => {
    const p = args.where.tenantId_portal.portal;
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

const audits = () => (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data);
const auditDescriptions = () => audits().map((d: any) => d.description as string);

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EINVOICE_PROVIDER = 'sandbox';
  mockTenant();
  mockCredentials();
  (prisma.gstinVerification.findUnique as any).mockResolvedValue(null);
  (prisma.creditNote.updateMany as any).mockResolvedValue({ count: 1 });
  (prisma.creditNote.update as any).mockResolvedValue({});
  (prisma.drugReturn.updateMany as any).mockResolvedValue({ count: 2 });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Credit / debit note IRN ────────────────────────────────────────────────

const note = (over: Record<string, unknown> = {}, billOver: Record<string, unknown> = {}) => ({
  id: 'cn-1',
  tenantId: TENANT,
  creditNoteNumber: 'CN/26-27/0001',
  noteType: 'credit',
  issueDate: new Date('2026-11-24T06:00:00Z'),
  supplierGstin: HOSPITAL_GSTIN,
  placeOfSupplyStateCode: '27',
  recipientGstin: BUYER_GSTIN,
  irn: null,
  irnAckNo: null,
  irnAckDate: null,
  irnQrPayload: null,
  irnStatus: null,
  irnError: null,
  irnAttemptedAt: null,
  irnCancelledAt: null,
  // Stored negative: a credit note takes value OFF the invoice.
  items: [
    {
      description: 'Health check package',
      hsnSacCode: '999312',
      gstTreatment: 'taxable',
      quantity: -1,
      taxableValue: -400,
      taxPercent: 18,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: -72,
      cessAmount: 0,
    },
  ],
  bill: {
    id: 'bill-1',
    invoiceNumber: 'INV/26-27/0001',
    billDate: new Date('2026-11-20T05:00:00Z'),
    billOfSupplyNumber: null,
    gstDocumentType: 'tax_invoice',
    recipientGstin: BUYER_GSTIN,
    recipientLegalName: 'Acme Insurance Ltd',
    recipientAddress: '5 Marine Drive, Mumbai 400001',
    supplierStateCode: '33',
    placeOfSupplyStateCode: '27',
    isInterState: true,
    ...billOver,
  },
  ...over,
});

/** The document the sandbox registered, read back out of its (unsigned) QR. */
function registeredDoc(qr: string) {
  return JSON.parse(JSON.parse(Buffer.from(qr.split('.')[1], 'base64url').toString('utf8')).data);
}

describe('buildNoteIrnPayload', () => {
  const seller = {
    gstin: HOSPITAL_GSTIN, legalName: 'Test Hospital', tradeName: null, address: '1 Main Road, Chennai 600001',
    city: 'Chennai', state: 'Tamil Nadu', phone: null, email: null,
  };

  it('builds a CRN in positive amounts naming the original invoice', () => {
    const out = buildNoteIrnPayload(note() as any, seller);
    expect('payload' in out).toBe(true);
    if (!('payload' in out)) return;
    const p = out.payload;
    expect(p.DocDtls).toEqual({ Typ: 'CRN', No: 'CN/26-27/0001', Dt: '24/11/2026' });
    expect(p.RefDtls).toEqual({ PrecDocDtls: [{ InvNo: 'INV/26-27/0001', InvDt: '20/11/2026' }] });
    expect(p.BuyerDtls).toMatchObject({ Gstin: BUYER_GSTIN, LglNm: 'Acme Insurance Ltd', Pos: '27' });
    expect(p.ItemList[0]).toMatchObject({ AssAmt: 400, IgstAmt: 72, GstRt: 18, Qty: 1, TotItemVal: 472 });
    expect(p.ValDtls).toMatchObject({ AssVal: 400, IgstVal: 72, TotInvVal: 472 });
  });

  it('builds a DBN for a debit note', () => {
    const out = buildNoteIrnPayload(note({ noteType: 'debit' }) as any, seller);
    expect('payload' in out && out.payload.DocDtls.Typ).toBe('DBN');
  });

  it('reports a missing HSN instead of building', () => {
    const n = note();
    (n.items[0] as any).hsnSacCode = null;
    const out = buildNoteIrnPayload(n as any, seller);
    expect('problems' in out && out.problems.join(' ')).toMatch(/HSN/);
  });
});

describe('generateIrnForNote', () => {
  it('registers a B2B credit note as CRN and stores IRN, ack, QR — audited against the note', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note());
    const out = await generateIrnForNote(TENANT, USER, 'cn-1');
    expect(out).toMatchObject({ status: 'registered', noteType: 'credit', sandbox: true, alreadyRegistered: false, signedQrCode: true });
    expect(out.irn).toMatch(/^[0-9a-f]{64}$/);

    const claim = (prisma.creditNote.updateMany as any).mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 'cn-1', tenantId: TENANT, irn: null });
    expect(claim.data.irnStatus).toBe('pending');

    const saved = (prisma.creditNote.update as any).mock.calls[0][0].data;
    expect(saved).toMatchObject({ irn: out.irn, irnStatus: 'registered', irnError: null });
    expect(saved.irnAckNo).toMatch(/^\d{15}$/);
    expect(registeredDoc(saved.irnQrPayload)).toMatchObject({ DocTyp: 'CRN', DocNo: 'CN/26-27/0001', TotInvVal: 472 });

    const a = audits().at(-1);
    expect(a.entityType).toBe('credit_note');
    expect(a.entityId).toBe('cn-1');
    expect(a.description).toMatch(/IRN generated for credit note CN\/26-27\/0001 \(against invoice INV\/26-27\/0001\)/);
    expect(prisma.bill.update).not.toHaveBeenCalled();
  });

  it('registers a debit note as DBN', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ noteType: 'debit', creditNoteNumber: 'DN/26-27/0001' }));
    const out = await generateIrnForNote(TENANT, USER, 'cn-1');
    expect(out).toMatchObject({ status: 'registered', noteType: 'debit' });
    expect(registeredDoc((prisma.creditNote.update as any).mock.calls[0][0].data.irnQrPayload).DocTyp).toBe('DBN');
  });

  it('stores a portal refusal in the portal\'s words, and Retry then registers it', async () => {
    const reject = EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin;
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ recipientGstin: reject }, { recipientGstin: reject }));
    const failed = await generateIrnForNote(TENANT, USER, 'cn-1');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^3028: /);
    expect((prisma.creditNote.update as any).mock.calls[0][0].data).toMatchObject({ irnStatus: 'failed', irnError: failed.error });
    expect(auditDescriptions().some((d: string) => /IRN generate for credit note .* failed/.test(d) && /3028/.test(d))).toBe(true);

    vi.clearAllMocks();
    mockTenant();
    mockCredentials();
    (prisma.creditNote.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.creditNote.update as any).mockResolvedValue({});
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ irnStatus: 'failed', irnError: failed.error, irnAttemptedAt: new Date() }));
    const retried = await generateIrnForNote(TENANT, USER, 'cn-1', 'retry');
    expect(retried.status).toBe('registered');
    expect((prisma.creditNote.updateMany as any).mock.calls[0][0].where.OR).toContainEqual({ irnStatus: 'failed' });
    expect(auditDescriptions().some((d: string) => /generated on retry/.test(d))).toBe(true);
  });

  it('Retry refuses a note that has not failed', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note());
    await expect(generateIrnForNote(TENANT, USER, 'cn-1', 'retry')).rejects.toMatchObject({ statusCode: 409, code: 'IRN_NOTHING_TO_RETRY' });
  });

  it('is idempotent: a note holding an IRN is never sent again', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(
      note({ irn: 'c'.repeat(64), irnAckNo: '1', irnAckDate: new Date(), irnStatus: 'registered', irnQrPayload: 'qr' }),
    );
    const out = await generateIrnForNote(TENANT, USER, 'cn-1');
    expect(out).toMatchObject({ alreadyRegistered: true, irn: 'c'.repeat(64) });
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
    expect(prisma.creditNote.update).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent send (claim lost)', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note());
    (prisma.creditNote.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(generateIrnForNote(TENANT, USER, 'cn-1')).rejects.toMatchObject({ statusCode: 409, code: 'IRN_IN_FLIGHT' });
    expect(prisma.creditNote.update).not.toHaveBeenCalled();
  });

  it('refuses a fresh send while one is in flight', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ irnStatus: 'pending', irnAttemptedAt: new Date() }));
    await expect(generateIrnForNote(TENANT, USER, 'cn-1')).rejects.toMatchObject({ code: 'IRN_IN_FLIGHT' });
  });

  it.each([
    ['a B2C note (no buyer GSTIN)', { recipientGstin: null }, {}, 'NOT_B2B'],
    ['a note against a B2C invoice', {}, { recipientGstin: null }, 'ORIGINAL_NOT_B2B'],
    ['a note against a bill of supply', {}, { gstDocumentType: 'bill_of_supply' }, 'ORIGINAL_NOT_B2B'],
    ['a note against an unfinalised bill', {}, { invoiceNumber: null }, 'ORIGINAL_NOT_B2B'],
  ])('refuses %s', async (_label, over, billOver, code) => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note(over, billOver));
    await expect(generateIrnForNote(TENANT, USER, 'cn-1')).rejects.toMatchObject({ statusCode: 409, code });
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a note whose IRN was cancelled', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(
      note({ irn: 'c'.repeat(64), irnStatus: 'cancelled', irnCancelledAt: new Date() }),
    );
    await expect(generateIrnForNote(TENANT, USER, 'cn-1')).rejects.toMatchObject({ code: 'IRN_CANCELLED' });
  });

  it('404s an unknown note', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(null);
    await expect(generateIrnForNote(TENANT, USER, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('cancelIrnForNote', () => {
  const registered = (ackAgoMs: number) =>
    note({ irn: 'a'.repeat(64), irnAckNo: '1', irnAckDate: new Date(Date.now() - ackAgoMs), irnStatus: 'registered', irnQrPayload: 'qr' });

  it('cancels within the window, stores cancelled-at, and audits the reason', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(registered(3 * HOUR));
    const out = await cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '2', remark: 'Wrong amount' });
    expect(out.status).toBe('cancelled');
    expect(out.cancelledAt).toBeTruthy();
    const call = (prisma.creditNote.updateMany as any).mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'cn-1', irnStatus: 'registered' });
    expect(call.data.irnStatus).toBe('cancelled');
    expect(call.data.irnCancelledAt).toBeInstanceOf(Date);
    const a = audits().at(-1);
    expect(a.entityType).toBe('credit_note');
    expect(a.description).toMatch(/cancelled/);
    expect(a.description).toMatch(/Data entry mistake — Wrong amount/);
  });

  it('refuses after the window (409) and changes nothing', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(registered(25 * HOUR));
    await expect(cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '2', remark: 'Wrong amount' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IRN_CANCEL_WINDOW_CLOSED',
      message: expect.stringMatching(/within 24 hours/),
    });
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a note without a registered IRN, and one already cancelled', async () => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ irnStatus: 'failed' }));
    await expect(cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({ code: 'IRN_NOT_REGISTERED' });
    (prisma.creditNote.findFirst as any).mockResolvedValue(note({ irn: 'a'.repeat(64), irnStatus: 'cancelled', irnCancelledAt: new Date() }));
    await expect(cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({ code: 'IRN_ALREADY_CANCELLED' });
  });

  it('needs a reason code and a remark', async () => {
    await expect(cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '7', remark: 'Duplicate' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cancelIrnForNote(TENANT, USER, 'cn-1', { reasonCode: '1', remark: '' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── E-way bill: failure persisted, retry, cancel ───────────────────────────

const line = (over: Record<string, unknown> = {}) => ({
  id: 'ret-1',
  createdAt: new Date('2026-11-24T05:00:00Z'),
  quantity: 100,
  status: 'processed',
  returnNumber: 'VR-0001',
  creditAmount: 60000,
  ewayBillNumber: null,
  ewayBillDate: null,
  ewayBillStatus: null,
  ewayBillError: null,
  ewayBillAttemptedAt: null,
  ewayBillValidUpto: null,
  ewayBillTransport: null,
  ewayBillCancelledAt: null,
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

const ROAD = { transMode: '1', distanceKm: 1300, vehicleNo: 'TN01AB1234' };

describe('e-way bill failure is persisted and retried', () => {
  beforeEach(() => {
    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
  });

  it('stores status=failed with the portal\'s words and attempted-at on every line, instead of only a 502', async () => {
    const reject = { name: 'Bad Co', gstNumber: EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin, address: 'Chennai 600002' };
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ supplier: reject }), line({ id: 'ret-2', supplier: reject })]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', ROAD);
    expect(out).toMatchObject({ status: 'failed', ewayBillNumber: null, sandbox: true });
    expect(out.error).toMatch(/^238: Invalid consignee GSTIN/);

    const [claim, fail] = (prisma.drugReturn.updateMany as any).mock.calls.map((c: any[]) => c[0]);
    expect(claim.where).toMatchObject({ id: { in: ['ret-1', 'ret-2'] }, ewayBillNumber: null });
    expect(claim.data).toMatchObject({ ewayBillStatus: 'pending', ewayBillError: null });
    expect(claim.data.ewayBillAttemptedAt).toBeInstanceOf(Date);
    expect(fail.where).toMatchObject({ id: { in: ['ret-1', 'ret-2'] }, ewayBillNumber: null });
    expect(fail.data).toEqual({ ewayBillStatus: 'failed', ewayBillError: out.error });
    const a = audits().at(-1);
    expect(a.entityType).toBe('drug_return');
    expect(a.description).toMatch(/E-way bill generate for vendor return VR-0001 failed/);
  });

  it('Retry resends the stored transport details and records the number', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      line({ ewayBillStatus: 'failed', ewayBillError: '238: x', ewayBillAttemptedAt: new Date(), ewayBillTransport: ROAD }),
    ]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', {}, 'retry');
    expect(out.status).toBe('generated');
    expect(out.ewayBillNumber).toMatch(/^\d{12}$/);
    const calls = (prisma.drugReturn.updateMany as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls[0].where.OR).toContainEqual({ ewayBillStatus: 'failed' });
    expect(calls.at(-1).data).toMatchObject({ ewayBillNumber: out.ewayBillNumber, ewayBillStatus: 'generated', ewayBillError: null });
    expect(calls.at(-1).data.ewayBillValidUpto).toBeInstanceOf(Date);
    expect(auditDescriptions().some((d: string) => /generated on retry/.test(d))).toBe(true);
  });

  it('Retry can take corrected transport details', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      line({ ewayBillStatus: 'failed', ewayBillAttemptedAt: new Date(), ewayBillTransport: ROAD }),
    ]);
    await generateEwayBillForReturn(TENANT, USER, 'ret-1', { transMode: '1', distanceKm: 20, vehicleNo: 'TN02CD5678' }, 'retry');
    expect((prisma.drugReturn.updateMany as any).mock.calls[0][0].data.ewayBillTransport).toMatchObject({ distanceKm: 20, vehicleNo: 'TN02CD5678' });
  });

  it('Retry refuses a return that has not failed', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line()]);
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', {}, 'retry')).rejects.toMatchObject({
      statusCode: 409,
      code: 'EWAY_NOTHING_TO_RETRY',
    });
  });

  it('refuses while a send is in flight, and when the claim is lost', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ ewayBillStatus: 'pending', ewayBillAttemptedAt: new Date() })]);
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', ROAD)).rejects.toMatchObject({ code: 'EWAY_IN_FLIGHT' });

    (prisma.drugReturn.findMany as any).mockResolvedValue([line()]);
    (prisma.drugReturn.updateMany as any).mockResolvedValue({ count: 0 });
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', ROAD)).rejects.toMatchObject({ statusCode: 409, code: 'EWAY_IN_FLIGHT' });
    // Only the (lost) claim was attempted — nothing was sent or written.
    expect((prisma.drugReturn.updateMany as any).mock.calls.every((c: any[]) => c[0].data.ewayBillStatus === 'pending')).toBe(true);
  });

  it('a stale pending (abandoned send) can be retried', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      line({ ewayBillStatus: 'pending', ewayBillAttemptedAt: new Date(Date.now() - HOUR), ewayBillTransport: ROAD }),
    ]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', {}, 'retry');
    expect(out.status).toBe('generated');
  });

  it('is idempotent: never a second e-way bill, not even after a cancellation', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ ewayBillNumber: '321000000001', ewayBillDate: new Date(), ewayBillStatus: 'generated' })]);
    const out = await generateEwayBillForReturn(TENANT, USER, 'ret-1', ROAD);
    expect(out).toMatchObject({ alreadyGenerated: true, ewayBillNumber: '321000000001' });
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();

    (prisma.drugReturn.findMany as any).mockResolvedValue([
      line({ ewayBillNumber: '321000000001', ewayBillDate: new Date(), ewayBillStatus: 'cancelled', ewayBillCancelledAt: new Date() }),
    ]);
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', ROAD)).rejects.toMatchObject({ statusCode: 409, code: 'EWAY_BILL_CANCELLED' });
    await expect(generateEwayBillForReturn(TENANT, USER, 'ret-1', {}, 'retry')).rejects.toMatchObject({ code: 'EWAY_BILL_CANCELLED' });
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();
  });
});

describe('cancelEwayBillForReturn', () => {
  const generated = (agoMs: number) =>
    line({ ewayBillNumber: '125644998983', ewayBillDate: new Date(Date.now() - agoMs), ewayBillStatus: 'generated' });

  beforeEach(() => {
    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
  });

  it('cancels inside the window with a reason code + remark, on every line, and audits it', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([generated(2 * HOUR), { ...generated(2 * HOUR), id: 'ret-2' }]);
    const out = await cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '2', remark: 'Supplier refused the goods' });
    expect(out).toMatchObject({ status: 'cancelled', ewayBillNumber: '125644998983', sandbox: true });
    expect(out.cancelledAt).toBeTruthy();
    const call = (prisma.drugReturn.updateMany as any).mock.calls[0][0];
    expect(call.where).toMatchObject({ id: { in: ['ret-1', 'ret-2'] }, ewayBillNumber: '125644998983' });
    expect(call.data).toMatchObject({ ewayBillStatus: 'cancelled', ewayBillCancelReasonCode: '2', ewayBillCancelRemark: 'Supplier refused the goods' });
    expect(call.data.ewayBillCancelledAt).toBeInstanceOf(Date);
    const a = audits().at(-1);
    expect(a.entityType).toBe('drug_return');
    expect(a.description).toMatch(/E-way bill 125644998983 for vendor return VR-0001 cancelled/);
    expect(a.description).toMatch(/Order cancelled — Supplier refused the goods/);
  });

  it('refuses after the window with a clear 409 and changes nothing', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([generated(25 * HOUR)]);
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '3', remark: 'Wrong vehicle' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'EWAY_CANCEL_WINDOW_CLOSED',
      message: expect.stringMatching(/can only be cancelled within 24 hours of its generation/),
    });
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();
  });

  it('honours a configured window', async () => {
    process.env.EWAY_CANCEL_WINDOW_HOURS = '1';
    (prisma.drugReturn.findMany as any).mockResolvedValue([generated(2 * HOUR)]);
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({
      code: 'EWAY_CANCEL_WINDOW_CLOSED',
    });
  });

  it('a portal refusal is a 502, audited, and nothing is stored', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([generated(HOUR)]);
    await expect(
      cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '4', remark: EINVOICE_SANDBOX_FIXTURES.refuseCancelRemark }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'EWAY_CANCEL_FAILED' });
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();
    expect(auditDescriptions().some((d: string) => /refused/.test(d) && /315/.test(d))).toBe(true);
  });

  it('refuses without a generated bill, when already cancelled, and without a reason', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ ewayBillStatus: 'failed' })]);
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({ code: 'EWAY_NOT_GENERATED' });
    (prisma.drugReturn.findMany as any).mockResolvedValue([{ ...generated(HOUR), ewayBillStatus: 'cancelled', ewayBillCancelledAt: new Date() }]);
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '1', remark: 'Duplicate' })).rejects.toMatchObject({ code: 'EWAY_ALREADY_CANCELLED' });
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '9', remark: 'Duplicate' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cancelEwayBillForReturn(TENANT, USER, 'ret-1', { reasonCode: '1', remark: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── Permissions: the same GST-manager gate as the invoice routes ───────────

describe('route permissions', () => {
  async function runRoute(path: string, roles: string[], params: Record<string, string>, body: unknown = {}) {
    const { gstEinvoiceRoutes } = await import('../../../../src/modules/gst/gst-einvoice.routes');
    const layer = (gstEinvoiceRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
    expect(layer).toBeTruthy();
    const handlers = layer.route.stack.map((s: any) => s.handle);
    const req: any = { user: { userId: USER, tenantId: TENANT, email: 'a@b.c', roles }, body, params };
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

  const NOTE_PATHS = ['/einvoice/notes/:noteId/generate', '/einvoice/notes/:noteId/retry', '/einvoice/notes/:noteId/cancel'];
  const EWAY_PATHS = ['/eway/returns/:returnId/generate', '/eway/returns/:returnId/retry', '/eway/returns/:returnId/cancel'];

  it.each(['cashier', 'front_desk', 'doctor', 'pharmacist', 'insurance_staff'])('refuses %s with 403 on every new route', async (role) => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note());
    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
    for (const p of NOTE_PATHS) {
      const { error } = await runRoute(p, [role], { noteId: 'cn-1' });
      expect(error?.statusCode).toBe(403);
    }
    for (const p of EWAY_PATHS) {
      const { error } = await runRoute(p, [role], { returnId: 'ret-1' }, ROAD);
      expect(error?.statusCode).toBe(403);
    }
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
    expect(prisma.drugReturn.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['admin', 'billing_admin'])('lets %s generate a note IRN and an e-way bill', async (role) => {
    (prisma.creditNote.findFirst as any).mockResolvedValue(note());
    const n = await runRoute('/einvoice/notes/:noteId/generate', [role], { noteId: 'cn-1' });
    expect(n.error).toBeUndefined();
    expect(n.res.status).toHaveBeenCalledWith(200);

    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
    (prisma.drugReturn.findMany as any).mockResolvedValue([line()]);
    const e = await runRoute('/eway/returns/:returnId/generate', [role], { returnId: 'ret-1' }, ROAD);
    expect(e.error).toBeUndefined();
    expect(e.res.status).toHaveBeenCalledWith(200);
  });

  it('answers a persisted e-way failure as 200 with status failed (D-3 then shows Retry)', async () => {
    const reject = { name: 'Bad Co', gstNumber: EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin, address: 'Chennai 600002' };
    (prisma.drugReturn.findFirst as any).mockResolvedValue({ id: 'ret-1', returnType: 'vendor_return', returnGroupId: 'g1' });
    (prisma.drugReturn.findMany as any).mockResolvedValue([line({ supplier: reject })]);
    const { error, res } = await runRoute('/eway/returns/:returnId/generate', ['admin'], { returnId: 'ret-1' }, ROAD);
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.status).toBe('failed');
    expect(body.message).toMatch(/E-way bill not generated: 238/);
  });
});
