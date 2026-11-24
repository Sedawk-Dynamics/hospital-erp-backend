import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Gap 297 — My Account: phone change with a one-time code, 2FA on/off on the
// row sign-in checks, and audit rows for password / phone / 2FA changes.

vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'new-hash'), compare: vi.fn() } }));
vi.mock('otplib', () => ({
  authenticator: { generateSecret: vi.fn(() => 'NEWSECRET'), verify: vi.fn(), keyuri: vi.fn(() => 'otpauth://x') },
}));
vi.mock('../../../../src/services/email.service', () => ({ sendEmail: vi.fn(async () => true) }));

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import {
  authService,
  parseIndianMobile,
  maskEmail,
  PHONE_CHANGE_MAX_ATTEMPTS,
  PHONE_CHANGE_TTL_SECONDS,
} from '../../../../src/modules/auth/auth.service';
import { prisma } from '../../../../src/config/database';
import { redis } from '../../../../src/config/redis';
import { sendEmail } from '../../../../src/services/email.service';
import { AppError } from '../../../../src/shared/appError';

// ── A tiny in-memory Redis with TTLs, enough for get/set(EX, NX)/del/incr/expire.
const store = new Map<string, { v: string; exp?: number }>();
function live(key: string) {
  const e = store.get(key);
  if (e && e.exp !== undefined && e.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return e;
}
function installFakeRedis() {
  const r = redis as unknown as Record<string, ReturnType<typeof vi.fn>>;
  r.get.mockImplementation(async (k: string) => live(k)?.v ?? null);
  r.set.mockImplementation(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && live(k)) return null;
    const exIdx = args.indexOf('EX');
    const exp = exIdx >= 0 ? Date.now() + Number(args[exIdx + 1]) * 1000 : undefined;
    store.set(k, { v, exp });
    return 'OK';
  });
  r.del.mockImplementation(async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n++;
    return n;
  });
  r.incr.mockImplementation(async (k: string) => {
    const e = live(k);
    const n = (e ? Number(e.v) : 0) + 1;
    store.set(k, { v: String(n), exp: e?.exp });
    return n;
  });
  r.expire.mockImplementation(async (k: string, s: number) => {
    const e = live(k);
    if (!e) return 0;
    e.exp = Date.now() + s * 1000;
    return 1;
  });
}

const ME = {
  id: 'user-1',
  email: 'asha@example.com',
  phone: '+919800000001',
  firstName: 'Asha',
  tenantId: 'tenant-hosp',
  passwordHash: 'hash',
  is2faEnabled: false,
  twoFaSecret: null as string | null,
};

const user = prisma.user as unknown as Record<string, ReturnType<typeof vi.fn>>;
const patient = prisma.patient as unknown as Record<string, ReturnType<typeof vi.fn>>;
const auditCreate = (prisma.auditLog as unknown as Record<string, ReturnType<typeof vi.fn>>).create;

/** The code the user "received" — pulled from the email, the only place it goes. */
function sentCode(): string {
  const call = vi.mocked(sendEmail).mock.calls.at(-1);
  const m = call?.[0].text?.match(/\b(\d{6})\b/);
  if (!m) throw new Error('no code was emailed');
  return m[1];
}

async function expectAppError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(status);
    if (code) expect((err as AppError).code).toBe(code);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  installFakeRedis();
  user.findUnique.mockResolvedValue({ ...ME });
  user.findFirst.mockResolvedValue(null);
  user.findMany.mockResolvedValue([]);
  user.update.mockResolvedValue({});
  user.updateMany.mockResolvedValue({ count: 1 });
  patient.findFirst.mockResolvedValue(null);
  auditCreate.mockResolvedValue({});
  vi.mocked(sendEmail).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseIndianMobile / maskEmail', () => {
  it('accepts Indian mobiles in common forms and rejects others', () => {
    expect(parseIndianMobile('98765 43210')).toBe('+919876543210');
    expect(parseIndianMobile('+91-98765-43210')).toBe('+919876543210');
    expect(parseIndianMobile('09876543210')).toBe('+919876543210');
    expect(parseIndianMobile('5876543210')).toBeNull(); // must start 6-9
    expect(parseIndianMobile('987654321')).toBeNull();
    expect(parseIndianMobile('+1 415 555 0100')).toBeNull();
  });

  it('masks the email local part', () => {
    expect(maskEmail('asha@example.com')).toBe('a***@example.com');
  });
});

describe('requestPhoneChange', () => {
  it('emails a 6-digit code, stores only a hash with a TTL, and never returns the code', async () => {
    const result = await authService.requestPhoneChange('user-1', { phone: '9876543210' });

    expect(result).toEqual({ channel: 'email', sentTo: 'a***@example.com', expiresInSeconds: PHONE_CHANGE_TTL_SECONDS });
    const code = sentCode();
    expect(JSON.stringify(result)).not.toContain(code);
    expect(vi.mocked(sendEmail).mock.calls[0][0].to).toBe('asha@example.com');

    const stored = store.get('phone-change:user-1');
    expect(stored).toBeDefined();
    expect(stored!.v).not.toContain(code);
    expect(stored!.exp! - Date.now()).toBeGreaterThan((PHONE_CHANGE_TTL_SECONDS - 5) * 1000);
    expect(redis.set).toHaveBeenCalledWith('phone-change:user-1', expect.any(String), 'EX', PHONE_CHANGE_TTL_SECONDS);
  });

  it('rejects a number that is not an Indian mobile', async () => {
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '12345678901' }), 400, 'INVALID_PHONE');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a number another active account already uses', async () => {
    user.findFirst.mockResolvedValue({ id: 'someone-else' });
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9876543210' }), 409, 'PHONE_IN_USE');
    expect(user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phone: { endsWith: '9876543210' }, isActive: true, NOT: { email: 'asha@example.com' } },
      }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a number on a patient record linked to another account', async () => {
    user.findMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-1-platform' }]);
    patient.findFirst.mockResolvedValue({ id: 'pat-9' });
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9876543210' }), 409, 'PHONE_IN_USE');
    expect(patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { not: null, notIn: ['user-1', 'user-1-platform'] } }),
      }),
    );
  });

  it('refuses the number the user already has', async () => {
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9800000001' }), 400, 'SAME_PHONE');
  });

  it('refuses when there is no real email to deliver to', async () => {
    user.findUnique.mockResolvedValue({ ...ME, email: 'phone-919800000001@auto.hospital.local' });
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9876543210' }), 400, 'NO_DELIVERY_CHANNEL');
  });

  it('fails closed and discards the code when the email cannot be sent', async () => {
    vi.mocked(sendEmail).mockResolvedValue(false);
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9876543210' }), 503, 'OTP_DELIVERY_FAILED');
    expect(store.has('phone-change:user-1')).toBe(false);
  });

  it('enforces a resend cooldown', async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    await expectAppError(authService.requestPhoneChange('user-1', { phone: '9876543210' }), 429, 'OTP_COOLDOWN');
  });
});

describe('verifyPhoneChange', () => {
  it('changes the phone on a correct code, burns the code, and audits it', async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const code = sentCode();

    const result = await authService.verifyPhoneChange('user-1', { phone: '9876543210', code }, { tenantId: 'tenant-hosp' });

    expect(result.phone).toBe('+919876543210');
    expect(user.updateMany).toHaveBeenCalledWith({ where: { email: 'asha@example.com' }, data: { phone: '+919876543210' } });
    expect(store.has('phone-change:user-1')).toBe(false);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-hosp',
        userId: 'user-1',
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        oldValues: { phone: '+919800000001' },
        newValues: { phone: '+919876543210' },
      }),
    });
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(code);

    // Single use.
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code }), 400, 'OTP_EXPIRED');
  });

  it('rejects a wrong code without changing anything', async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const wrong = sentCode() === '000000' ? '111111' : '000000';
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code: wrong }), 400, 'OTP_INVALID');
    expect(user.updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('rejects the right code for a different number', async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const code = sentCode();
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9123456789', code }), 400, 'OTP_INVALID');
    expect(user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const code = sentCode();
    vi.setSystemTime(Date.now() + (PHONE_CHANGE_TTL_SECONDS + 1) * 1000);
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code }), 400, 'OTP_EXPIRED');
    expect(user.updateMany).not.toHaveBeenCalled();
  });

  it(`locks the code after ${PHONE_CHANGE_MAX_ATTEMPTS} wrong attempts, even if the right code follows`, async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const code = sentCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i < PHONE_CHANGE_MAX_ATTEMPTS; i++) {
      await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code: wrong }), 400, 'OTP_INVALID');
    }
    await expectAppError(
      authService.verifyPhoneChange('user-1', { phone: '9876543210', code: wrong }),
      429,
      'OTP_ATTEMPTS_EXCEEDED',
    );
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code }), 400, 'OTP_EXPIRED');
    expect(user.updateMany).not.toHaveBeenCalled();
  });

  it('re-checks uniqueness at verify time', async () => {
    await authService.requestPhoneChange('user-1', { phone: '9876543210' });
    const code = sentCode();
    user.findFirst.mockResolvedValue({ id: 'someone-else' }); // taken meanwhile
    await expectAppError(authService.verifyPhoneChange('user-1', { phone: '9876543210', code }), 409, 'PHONE_IN_USE');
    expect(user.updateMany).not.toHaveBeenCalled();
  });
});

describe('two-factor sign-in', () => {
  const PLATFORM = { ...ME, id: 'user-1-platform', tenantId: 'tenant-platform', tenant: { slug: '__platform__' } };

  it('setup and verify act on the platform row that login checks', async () => {
    user.findMany.mockResolvedValue([{ ...ME, tenant: { slug: 'hosp' } }, PLATFORM]);
    await authService.setup2FA('user-1');
    expect(user.update).toHaveBeenCalledWith({ where: { id: 'user-1-platform' }, data: { twoFaSecret: 'NEWSECRET' } });

    user.findMany.mockResolvedValue([{ ...PLATFORM, twoFaSecret: 'NEWSECRET' }]);
    vi.mocked(authenticator.verify).mockReturnValue(true);
    await authService.verify2FA('user-1', { code: '123456' }, { tenantId: 'tenant-hosp' });
    expect(user.update).toHaveBeenLastCalledWith({ where: { id: 'user-1-platform' }, data: { is2faEnabled: true } });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-hosp',
        entityId: 'user-1-platform',
        newValues: { is2faEnabled: true },
      }),
    });
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain('NEWSECRET');
  });

  it('setup refuses to overwrite an enabled secret', async () => {
    user.findMany.mockResolvedValue([{ ...PLATFORM, is2faEnabled: true, twoFaSecret: 'LIVE' }]);
    await expectAppError(authService.setup2FA('user-1'), 400, '2FA_ALREADY_ENABLED');
    expect(user.update).not.toHaveBeenCalled();
  });

  describe('disable2FA', () => {
    const ENABLED = { ...PLATFORM, is2faEnabled: true, twoFaSecret: 'LIVE' };

    it('needs the current password', async () => {
      user.findMany.mockResolvedValue([ENABLED]);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
      vi.mocked(authenticator.verify).mockReturnValue(true);
      await expectAppError(authService.disable2FA('user-1', { currentPassword: 'x', code: '123456' }), 400, 'WRONG_PASSWORD');
      expect(user.update).not.toHaveBeenCalled();
    });

    it('needs a valid current code', async () => {
      user.findMany.mockResolvedValue([ENABLED]);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(authenticator.verify).mockReturnValue(false);
      await expectAppError(
        authService.disable2FA('user-1', { currentPassword: 'right', code: '000000' }),
        400,
        'INVALID_2FA_CODE',
      );
      expect(user.update).not.toHaveBeenCalled();
    });

    it('refuses when 2FA is not on', async () => {
      user.findMany.mockResolvedValue([PLATFORM]);
      await expectAppError(authService.disable2FA('user-1', { currentPassword: 'right', code: '123456' }), 400, '2FA_NOT_ENABLED');
    });

    it('turns it off, clears the secret and audits it', async () => {
      user.findMany.mockResolvedValue([ENABLED]);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(authenticator.verify).mockReturnValue(true);
      await authService.disable2FA('user-1', { currentPassword: 'right', code: '123456' }, { tenantId: 'tenant-hosp' });
      expect(authenticator.verify).toHaveBeenCalledWith({ token: '123456', secret: 'LIVE' });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'user-1-platform' },
        data: { is2faEnabled: false, twoFaSecret: null },
      });
      expect(auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ oldValues: { is2faEnabled: true }, newValues: { is2faEnabled: false } }),
      });
      const audited = JSON.stringify(auditCreate.mock.calls);
      expect(audited).not.toContain('LIVE');
      expect(audited).not.toContain('right');
    });
  });
});

describe('changePassword audit', () => {
  it('writes an audit row without the password or hash', async () => {
    user.findUnique.mockResolvedValue({ id: 'user-1', email: ME.email, tenantId: 'tenant-hosp' });
    user.findMany.mockResolvedValue([{ id: 'user-1', passwordHash: 'old-hash', tenant: { slug: 'hosp' } }]);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    await authService.changePassword(
      'user-1',
      { currentPassword: 'Old@12345', newPassword: 'New@12345' },
      { tenantId: 'tenant-hosp' },
    );

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: 'tenant-hosp', userId: 'user-1', entityType: 'user', action: 'update' }),
    });
    const audited = JSON.stringify(auditCreate.mock.calls);
    for (const secret of ['Old@12345', 'New@12345', 'new-hash', 'old-hash']) expect(audited).not.toContain(secret);
  });

  it('does not audit a refused change', async () => {
    user.findUnique.mockResolvedValue({ id: 'user-1', email: ME.email, tenantId: 'tenant-hosp' });
    user.findMany.mockResolvedValue([{ id: 'user-1', passwordHash: 'old-hash', tenant: { slug: 'hosp' } }]);
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
    await expectAppError(
      authService.changePassword('user-1', { currentPassword: 'bad', newPassword: 'New@12345' }),
      400,
      'WRONG_PASSWORD',
    );
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
