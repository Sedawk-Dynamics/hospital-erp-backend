import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import { prisma } from '../../../../src/config/database';
import {
  getGstProfile,
  updateGstProfile,
  verifyHospitalGstin,
} from '../../../../src/modules/hospital-settings/hospital-settings.service';
import { SANDBOX_FIXTURES } from '../../../../src/services/gstin-verification';

// The route test runs the real guard chain; only token parsing is stubbed.
vi.mock('../../../../src/middleware/authenticate', () => ({
  authenticate: (_req: unknown, _res: unknown, next: NextFunction) => next(),
}));

// Gap #311: Verify checks the SAVED GSTIN through the provider, stores the
// answer against that exact number, audits every attempt, and a GSTIN change
// clears it.

const TENANT = 'tenant-1';
const USER = 'user-1';
const ACTIVE = SANDBOX_FIXTURES.active;
const OTHER = '27AAPFU0939F1ZV';

const savedGst = (gstin: string | null) =>
  (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { gst: { registered: !!gstin, gstin } } });

const auditDescriptions = () =>
  (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.description as string);

const ENV_KEYS = ['GSTIN_VERIFY_PROVIDER', 'GSTIN_VERIFY_URL', 'GSTIN_VERIFY_API_KEY'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('verifyHospitalGstin', () => {
  it('refuses with 503 when no provider is configured, stores nothing, and audits the attempt', async () => {
    savedGst(ACTIVE);
    await expect(verifyHospitalGstin(TENANT, USER)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/not configured/),
    });
    expect(prisma.gstinVerification.upsert).not.toHaveBeenCalled();
    expect(auditDescriptions().some((d: string) => /provider not configured/.test(d))).toBe(true);
  });

  it('stores a sandbox pass against the exact GSTIN checked, labelled sandbox', async () => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    savedGst(ACTIVE);
    await verifyHospitalGstin(TENANT, USER, ACTIVE);
    const call = (prisma.gstinVerification.upsert as any).mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: TENANT });
    expect(call.create).toMatchObject({
      tenantId: TENANT,
      checkedGstin: ACTIVE,
      verifiedGstin: ACTIVE,
      resultStatus: 'verified',
      provider: 'sandbox',
      sandbox: true,
      registrationStatus: 'Active',
      checkedBy: USER,
    });
    expect(call.create.verifiedAt).toBeInstanceOf(Date);
    expect(auditDescriptions().some((d: string) => /SANDBOX/.test(d) && d.includes(ACTIVE))).toBe(true);
  });

  it('keeps a not-found lookup explicitly unverified', async () => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    savedGst(OTHER);
    const out = await verifyHospitalGstin(TENANT, USER);
    expect(out.result.status).toBe('not_found');
    const call = (prisma.gstinVerification.upsert as any).mock.calls[0][0];
    expect(call.create).toMatchObject({ checkedGstin: OTHER, verifiedGstin: null, resultStatus: 'not_found', verifiedAt: null });
    expect(out.profile.gstinVerified).toBe(false);
  });

  it('keeps a failed lookup unverified', async () => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    savedGst(SANDBOX_FIXTURES.error);
    const out = await verifyHospitalGstin(TENANT, USER);
    expect(out.result.status).toBe('error');
    expect((prisma.gstinVerification.upsert as any).mock.calls[0][0].create.verifiedGstin).toBeNull();
  });

  it('refuses to verify a number other than the saved one', async () => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    savedGst(OTHER);
    await expect(verifyHospitalGstin(TENANT, USER, ACTIVE)).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.gstinVerification.upsert).not.toHaveBeenCalled();
  });

  it('discards the answer if the GSTIN changed during the lookup', async () => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    (prisma.tenant.findFirst as any)
      .mockResolvedValueOnce({ themeConfig: { gst: { registered: true, gstin: ACTIVE } } })
      .mockResolvedValue({ themeConfig: { gst: { registered: true, gstin: OTHER } } });
    await expect(verifyHospitalGstin(TENANT, USER)).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.gstinVerification.upsert).not.toHaveBeenCalled();
  });

  it('needs a saved GSTIN', async () => {
    savedGst(null);
    await expect(verifyHospitalGstin(TENANT, USER)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('reading the verification back', () => {
  const stored = (over: Record<string, unknown> = {}) =>
    (prisma.gstinVerification.findUnique as any).mockResolvedValue({
      checkedGstin: ACTIVE,
      verifiedGstin: ACTIVE,
      resultStatus: 'verified',
      provider: 'http:gsp',
      sandbox: false,
      legalName: 'X',
      tradeName: null,
      registrationStatus: 'Active',
      lastError: null,
      lastCheckedAt: new Date(),
      verifiedAt: new Date(),
      ...over,
    });

  it('is verified only when the stored answer is for the current GSTIN', async () => {
    stored();
    savedGst(ACTIVE);
    expect((await getGstProfile(TENANT)).gstinVerified).toBe(true);
    savedGst(OTHER);
    expect((await getGstProfile(TENANT)).gstinVerified).toBe(false);
  });

  it('a failed verification read leaves the hospital registered, just unverified', async () => {
    (prisma.gstinVerification.findUnique as any).mockRejectedValue(new Error('relation does not exist'));
    savedGst(ACTIVE);
    const p = await getGstProfile(TENANT);
    expect(p).toMatchObject({ registered: true, gstin: ACTIVE, gstinVerified: false });
  });
});

describe('changing the GSTIN', () => {
  it('clears the previous verification and audits old → new with the user', async () => {
    savedGst(ACTIVE);
    const p = await updateGstProfile(TENANT, { gstin: OTHER }, USER);
    expect(prisma.gstinVerification.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    expect(p.gstinVerified).toBe(false);
    const audit = (prisma.auditLog.create as any).mock.calls[0][0].data;
    expect(audit).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      entityType: 'gst_registration',
      oldValues: { gstin: ACTIVE },
      newValues: { gstin: OTHER },
    });
  });

  it('leaves the verification alone when the GSTIN is unchanged', async () => {
    savedGst(ACTIVE);
    await updateGstProfile(TENANT, { sixDigitHsn: true }, USER);
    expect(prisma.gstinVerification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /gst/verify-gstin permission', () => {
  async function runRoute(roles: string[]) {
    const { hospitalSettingsRoutes } = await import(
      '../../../../src/modules/hospital-settings/hospital-settings.routes'
    );
    const layer = (hospitalSettingsRoutes as any).stack.find(
      (l: any) => l.route?.path === '/gst/verify-gstin' && l.route.methods.post,
    );
    expect(layer).toBeTruthy();
    const handlers = layer.route.stack.map((s: any) => s.handle);
    const req: any = { user: { userId: USER, tenantId: TENANT, email: 'a@b.c', roles }, body: {} };
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
    savedGst(ACTIVE);
    const { error } = await runRoute([role]);
    expect(error?.statusCode).toBe(403);
    expect(prisma.gstinVerification.upsert).not.toHaveBeenCalled();
  });

  it.each(['admin', 'billing_admin'])('lets %s through to the provider', async (role) => {
    process.env.GSTIN_VERIFY_PROVIDER = 'sandbox';
    savedGst(ACTIVE);
    const { error, res } = await runRoute([role]);
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.gstinVerification.upsert).toHaveBeenCalled();
  });
});
