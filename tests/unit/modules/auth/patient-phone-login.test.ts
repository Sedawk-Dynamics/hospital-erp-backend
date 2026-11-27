import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Patient phone sign-in: a real one-time code, only ever for patient accounts.

vi.mock('otplib', () => ({ authenticator: { verify: vi.fn(() => false), generateSecret: vi.fn(), keyuri: vi.fn() } }));
vi.mock('../../../../src/services/email.service', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../../../src/modules/patient-portal/patient-portal.service', () => ({
  createPatientInTenant: vi.fn(async () => 'pat-new'),
}));

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { authService } from '../../../../src/modules/auth/auth.service';
import { requestOtpSchema, verifyOtpSchema } from '../../../../src/modules/auth/auth.validation';
import { sendEmail } from '../../../../src/services/email.service';
import { AppError } from '../../../../src/shared/appError';
import { OTP_MAX_ATTEMPTS, OTP_SENDS_PER_HOUR, OTP_TTL_SECONDS } from '../../../../src/shared/one-time-code';
import {
  addPatient,
  addUser,
  db,
  installFakeDb,
  installFakeRedis,
  loggedText,
  otherCode,
  sandboxCode,
  store,
  tenants,
} from './patient-auth.fakes';

const PHONE = '+919000000011';
const OTHER_PHONE = '+919000000022';

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('should have failed');
}
async function expectFailure(p: Promise<unknown>, status: number, code?: string) {
  const err = await failure(p);
  expect([err.statusCode, err.code]).toEqual([status, code ?? err.code]);
  return err;
}

const login = (otp: string, over: object = {}) =>
  authService.loginWithPhoneOtp({ phone: PHONE, otp, intent: 'login', ...over });
async function codeFor(phone = PHONE, intent: 'login' | 'signup' | undefined = 'login') {
  await authService.requestPhoneOtp({ phone, intent });
  return sandboxCode();
}
const nextMinute = () => vi.setSystemTime(Date.now() + 61_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T06:00:00Z') });
  installFakeRedis();
  installFakeDb();
  vi.mocked(sendEmail).mockResolvedValue(true);
  vi.mocked(authenticator.verify).mockReturnValue(false);
  vi.stubEnv('OTP_PROVIDER', 'sandbox');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the code itself', () => {
  beforeEach(() => void addUser({ roles: ['patient'], phone: '9000000011' }));

  it('never accepts the old fixed code', async () => {
    vi.spyOn(crypto, 'randomInt').mockImplementation((() => 654087) as never);
    await expectFailure(login('123123'), 400, 'OTP_EXPIRED'); // none sent
    await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' });
    await expectFailure(login('123123'), 400, 'OTP_INVALID');
    expect((await login('654087')).accessToken).toBeTruthy();
  });

  it('keeps only a hash, for five minutes, and returns only channel and masked destination', async () => {
    const res = await authService.requestPhoneOtp({ phone: '90000 00011', intent: 'login' });
    const code = sandboxCode();
    expect(res).toEqual({ channel: 'sms', sentTo: '+91 ******0011', expiresInSeconds: OTP_TTL_SECONDS, resendInSeconds: 60 });
    const dump = JSON.stringify([...store.entries()]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain('9000000011');
    const entry = [...store.entries()].find(([k]) => k.startsWith('patient-login:'))!;
    expect(entry[1].exp! - Date.now()).toBe(OTP_TTL_SECONDS * 1000);
    expect(OTP_TTL_SECONDS).toBe(300);
  });

  it('expires', async () => {
    const code = await codeFor();
    vi.setSystemTime(Date.now() + (OTP_TTL_SECONDS + 1) * 1000);
    await expectFailure(login(code), 400, 'OTP_EXPIRED');
  });

  it('works once', async () => {
    const code = await codeFor();
    await login(code);
    await expectFailure(login(code), 400, 'OTP_EXPIRED');
  });

  it('works once even when used twice at the same moment', async () => {
    const code = await codeFor();
    const results = await Promise.allSettled([login(code), login(code), login(code)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('is burned after five wrong attempts, even if the right one follows', async () => {
    const code = await codeFor();
    const wrong = otherCode(code);
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) await expectFailure(login(wrong), 400, 'OTP_INVALID');
    await expectFailure(login(wrong), 429, 'OTP_ATTEMPTS_EXCEEDED');
    await expectFailure(login(code), 400, 'OTP_EXPIRED');
  });

  it('gives parallel guesses no more than five comparisons between them', async () => {
    const code = await codeFor();
    const wrong = otherCode(code);
    // 20 wrong guesses in flight with the right code last: it must be too late.
    const results = await Promise.allSettled([...Array(20).fill(wrong), code].map((c) => login(c)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const codes = results.map((r) => ((r as PromiseRejectedResult).reason as AppError).code);
    expect(codes.filter((c) => c === 'OTP_INVALID')).toHaveLength(OTP_MAX_ATTEMPTS - 1);
  });

  it('is bound to the number it was sent to', async () => {
    addUser({ roles: ['patient'], phone: '9000000022' });
    const code = await codeFor(PHONE);
    await expectFailure(login(code, { phone: OTHER_PHONE }), 400, 'OTP_EXPIRED');
  });

  it('is bound to its purpose: login, signup, phone change and PIN setup codes do not mix', async () => {
    const code = await codeFor(PHONE, 'login');
    await expectFailure(login(code, { intent: 'signup' }), 400, 'OTP_EXPIRED');
    await expectFailure(login(code, { intent: undefined }), 400, 'OTP_EXPIRED');
    await expectFailure(authService.verifyPhoneChange(db.users[0].id, { phone: OTHER_PHONE, code }), 400, 'OTP_EXPIRED');
    // Even with the stored record moved under another purpose's key.
    const [key, value] = [...store.entries()].find(([k]) => k.startsWith('patient-login:'))!;
    store.set(key.replace('patient-login', 'patient-signup'), value);
    await expectFailure(login(code, { intent: 'signup' }), 400, 'OTP_INVALID');
  });

  it('has a 60-second resend cooldown and an hourly limit per phone', async () => {
    await codeFor();
    await expectFailure(codeFor(), 429, 'OTP_COOLDOWN');
    for (let i = 1; i < OTP_SENDS_PER_HOUR; i++) {
      nextMinute();
      await codeFor();
    }
    nextMinute();
    await expectFailure(codeFor(), 429, 'OTP_SEND_LIMIT');
    // Switching to signup does not give a fresh budget.
    await expectFailure(codeFor(PHONE, 'signup'), 429, 'OTP_SEND_LIMIT');
  });

  it('locks the phone after repeated wrong codes across several codes', async () => {
    let wrongs = 0;
    while (wrongs < 7) {
      const code = await codeFor();
      for (let i = 0; i < 4 && wrongs < 7; i++, wrongs++) await failure(login(otherCode(code)));
      nextMinute();
    }
    const code = await codeFor();
    await expectFailure(login(code), 429, 'ACCOUNT_LOCKED');
  });

  it('a new code replaces the old one', async () => {
    const randomInt = vi.spyOn(crypto, 'randomInt');
    randomInt.mockImplementationOnce((() => 111222) as never).mockImplementationOnce((() => 333444) as never);
    const first = await codeFor();
    nextMinute();
    const second = await codeFor();
    await expectFailure(login(first), 400, 'OTP_INVALID');
    expect((await login(second)).user.phone).toBe('9000000011');
  });

  it('fails closed when Redis is down', async () => {
    const { redis } = await import('../../../../src/config/redis');
    vi.mocked(redis.get).mockRejectedValue(new Error('down'));
    await expect(login('000000')).rejects.toThrow();
  });

  it('only accepts six digits at the edge', () => {
    const ok = (otp: string) => verifyOtpSchema.safeParse({ body: { phone: PHONE, otp } }).success;
    expect(ok('012345')).toBe(true);
    for (const bad of ['1234', '12345678', 'abcdef', '']) expect(ok(bad)).toBe(false);
    expect(requestOtpSchema.safeParse({ body: { phone: PHONE, intent: 'reset' } }).success).toBe(false);
  });
});

describe('where the code goes', () => {
  it('without a provider, to the email the account was registered with', async () => {
    vi.stubEnv('OTP_PROVIDER', '');
    addUser({ roles: ['patient'], phone: PHONE, email: 'asha.rao@example.com' });
    const res = await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' });
    expect(res).toMatchObject({ channel: 'email', sentTo: 'a*******@example.com' });
    const mail = vi.mocked(sendEmail).mock.calls[0][0];
    expect(mail.to).toBe('asha.rao@example.com');
    const code = mail.text!.match(/\b\d{6}\b/)![0];
    expect(mail.subject).not.toContain(code); // the subject is logged
    expect(JSON.stringify(res)).not.toContain(code);
    expect((await login(code)).user.email).toBe('asha.rao@example.com');
  });

  it.each([
    ['a placeholder email', () => addUser({ roles: ['patient'], phone: PHONE, email: 'phone-919000000011@auto.hospital.local' })],
    ['nobody', () => undefined],
    ['a staff member', () => addUser({ roles: ['doctor'], phone: PHONE, email: 'doc@example.com' })],
    ['a patient record with no account', () => addPatient({ phone: PHONE })],
  ])('without a provider, a number of %s gets 503 and no usable code', async (_who, seed) => {
    vi.stubEnv('OTP_PROVIDER', 'none');
    vi.spyOn(crypto, 'randomInt').mockImplementation((() => 424242) as never);
    seed();
    await expectFailure(authService.requestPhoneOtp({ phone: PHONE, intent: 'login' }), 503, 'OTP_NOT_CONFIGURED');
    expect(sendEmail).not.toHaveBeenCalled();
    await expectFailure(login('424242'), 400, 'OTP_EXPIRED');
  });

  it('discards the code when the email cannot be sent', async () => {
    vi.stubEnv('OTP_PROVIDER', '');
    vi.spyOn(crypto, 'randomInt').mockImplementation((() => 424242) as never);
    vi.mocked(sendEmail).mockResolvedValue(false);
    addUser({ roles: ['patient'], phone: PHONE });
    await expectFailure(authService.requestPhoneOtp({ phone: PHONE, intent: 'login' }), 503, 'OTP_DELIVERY_FAILED');
    await expectFailure(login('424242'), 400, 'OTP_EXPIRED');
  });

  it('a code read in an inbox opens only the account whose inbox it is', async () => {
    vi.stubEnv('OTP_PROVIDER', '');
    const mine = addUser({ roles: ['patient'], phone: PHONE });
    await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' });
    const code = vi.mocked(sendEmail).mock.calls[0][0].text!.match(/\b\d{6}\b/)![0];
    // Meanwhile the number comes to mean somebody else.
    mine.isActive = false;
    addUser({ roles: ['patient'], phone: PHONE });
    await expectFailure(login(code), 400, 'OTP_EXPIRED');
  });

  it('refuses the sandbox in production and falls back to email', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    addUser({ roles: ['patient'], phone: PHONE });
    expect((await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' })).channel).toBe('email');
    expect(loggedText()).not.toContain('SANDBOX');
  });

  it('does not message foreign numbers unless allowed', async () => {
    await expectFailure(authService.requestPhoneOtp({ phone: '+16502530000' }), 503, 'OTP_NOT_CONFIGURED');
    vi.stubEnv('OTP_ALLOWED_COUNTRY_CODES', '91,1');
    expect((await authService.requestPhoneOtp({ phone: '+16502530000', intent: 'login' })).channel).toBe('sms');
  });

  it('answers a patient, a staff and an unknown number identically', async () => {
    addUser({ roles: ['patient'], phone: PHONE });
    addUser({ roles: ['admin'], phone: OTHER_PHONE });
    const shapes = [];
    for (const phone of [PHONE, OTHER_PHONE, '+919000000033']) {
      const { sentTo, ...rest } = await authService.requestPhoneOtp({ phone, intent: 'login' });
      expect(sentTo).toMatch(/^\+91 \*{6}\d{4}$/);
      shapes.push(rest);
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
});

describe('only patient accounts', () => {
  async function refusedLikeUnknown() {
    const before = JSON.stringify([db.users, db.patients]);
    const unknown = await (async () => {
      await authService.requestPhoneOtp({ phone: '+919000000099', intent: 'login' });
      return failure(login(sandboxCode(), { phone: '+919000000099' }));
    })();
    const err = await failure(login(await codeFor()));
    expect([err.statusCode, err.code, err.message]).toEqual([unknown.statusCode, unknown.code, unknown.message]);
    expect(err.statusCode).toBe(404);
    expect(JSON.stringify([db.users, db.patients])).toBe(before); // nothing touched
    expect(db.loginAudits).toHaveLength(0);
  }

  it.each(['super_admin', 'admin', 'doctor', 'nurse', 'front_desk', 'cashier', 'some_custom_role'])(
    'refuses a %s',
    async (role) => {
      addUser({ roles: [role], phone: PHONE });
      await refusedLikeUnknown();
    },
  );

  it('refuses a mixed patient + staff account', async () => {
    addUser({ roles: ['patient', 'nurse'], phone: PHONE });
    await refusedLikeUnknown();
  });

  it('refuses an account with no role at all', async () => {
    addUser({ roles: [], phone: PHONE });
    await refusedLikeUnknown();
  });

  it('refuses a patient account whose copy in another hospital is staff', async () => {
    addUser({ roles: ['patient'], phone: PHONE, email: 'both@example.com' });
    addUser({ roles: ['doctor'], phone: null, email: 'Both@example.com', tenant: tenants.HOSPITAL });
    await refusedLikeUnknown();
  });

  it('refuses a hospital copy that looks like a patient when the platform row is staff', async () => {
    addUser({ roles: ['admin'], email: 'both@example.com' });
    addUser({ roles: ['patient'], phone: PHONE, email: 'both@example.com', tenant: tenants.HOSPITAL });
    await refusedLikeUnknown();
  });

  it('refuses hospital owners and people with a doctor or HR profile, whatever their role rows say', async () => {
    const owner = addUser({ roles: ['patient'], phone: PHONE });
    db.owners.push({ id: 'o1', userId: owner.id });
    await refusedLikeUnknown();
    db.owners = [];
    owner.doctorProfile = { id: 'd1' };
    nextMinute();
    const err = await failure(login(await codeFor()));
    expect(err.code).toBe('NO_ACCOUNT');
  });

  it('refuses a patient record linked to a staff account, and leaves it alone', async () => {
    const staff = addUser({ roles: ['nurse'] });
    addPatient({ phone: PHONE, userId: staff.id });
    await refusedLikeUnknown();
  });

  it('refuses deactivated accounts, through the patient record too', async () => {
    const gone = addUser({ roles: ['patient'], isActive: false, phone: PHONE });
    addPatient({ phone: PHONE, userId: gone.id });
    await refusedLikeUnknown();
  });

  it('refuses a hospital copy when the platform row is deactivated, and an inactive hospital', async () => {
    addUser({ roles: ['patient'], email: 'p@example.com', isActive: false });
    addUser({ roles: ['patient'], email: 'p@example.com', phone: PHONE, tenant: tenants.HOSPITAL });
    await refusedLikeUnknown();
    db.users = [];
    addUser({ roles: ['patient'], phone: PHONE, tenant: { ...tenants.HOSPITAL, isActive: false } });
    nextMinute();
    expect((await failure(login(await codeFor()))).code).toBe('NO_ACCOUNT');
  });

  it('signs in the patient, not the staff member, when they share a number', async () => {
    addUser({ roles: ['doctor'], phone: PHONE });
    const patient = addUser({ roles: ['patient'], phone: PHONE });
    const res = await login(await codeFor());
    expect(res.user.id).toBe(patient.id);
    expect(res.user.roles).toEqual(['patient']);
  });

  it('prefers the platform copy of a patient', async () => {
    addUser({ roles: ['patient'], phone: PHONE, email: 'p@example.com', tenant: tenants.HOSPITAL });
    const platform = addUser({ roles: ['patient'], phone: PHONE, email: 'p@example.com' });
    expect((await login(await codeFor())).user.id).toBe(platform.id);
  });

  it('signs in through a patient record linked to a patient account, and backfills the phone', async () => {
    const acc = addUser({ roles: ['patient'] });
    addPatient({ phone: '09000000011', userId: acc.id });
    expect((await login(await codeFor())).user.id).toBe(acc.id);
    expect(db.users[0].phone).toBe(PHONE);
  });

  it('a foreign number with the same last ten digits is a different person', async () => {
    vi.stubEnv('OTP_ALLOWED_COUNTRY_CODES', '91,1');
    addUser({ roles: ['patient'], phone: '6502530000' });
    addPatient({ phone: '+916502530000' });
    await authService.requestPhoneOtp({ phone: '+16502530000', intent: 'login' });
    await expectFailure(login(sandboxCode(), { phone: '+16502530000' }), 404, 'NO_ACCOUNT');
  });

  it('signs nobody in if the account gains a staff role while the code is in flight', async () => {
    const acc = addUser({ roles: ['patient'], phone: PHONE });
    const code = await codeFor();
    acc.userRoles = [...acc.userRoles, { role: { id: 'r', name: 'admin' } }];
    await expectFailure(login(code), 404, 'NO_ACCOUNT');
  });
});

describe('signup and adoption', () => {
  const signup = (otp: string, over: object = {}) =>
    authService.loginWithPhoneOtp({ phone: PHONE, otp, intent: 'signup', firstName: 'Ravi', ...over });

  it('creates a patient account for a new number', async () => {
    const res = await signup(await codeFor(PHONE, 'signup'));
    expect(res.user.roles).toEqual(['patient']);
    expect(db.users[0]).toMatchObject({ firstName: 'Ravi', phone: '9000000011', email: 'phone-919000000011@auto.hospital.local' });
  });

  it('keeps the country code of a foreign number so it cannot pass for an Indian one', async () => {
    vi.stubEnv('OTP_ALLOWED_COUNTRY_CODES', '91,1');
    await signup(await codeFor('+16502530000', 'signup'), { phone: '+16502530000' });
    expect(db.users[0].phone).toBe('+16502530000');
    nextMinute();
    await expectFailure(login(await codeFor('+916502530000'), { phone: '+916502530000' }), 404, 'NO_ACCOUNT');
  });

  it('refuses a number that already has a patient account, after the code', async () => {
    addUser({ roles: ['patient'], phone: PHONE });
    const code = await codeFor(PHONE, 'signup');
    await expectFailure(signup(code), 409, 'ACCOUNT_EXISTS');
    await expectFailure(signup(code), 400, 'OTP_EXPIRED'); // spent
    expect(db.users).toHaveLength(1);
  });

  it('for a number only staff use, behaves as for a new number and never touches the staff account', async () => {
    const staff = addUser({ roles: ['doctor'], phone: PHONE, email: 'doc@example.com' });
    addPatient({ phone: PHONE, userId: staff.id });
    const before = JSON.stringify([staff, db.patients]);
    const res = await signup(await codeFor(PHONE, 'signup'));
    expect(res.user.id).not.toBe(staff.id);
    expect(res.user.roles).toEqual(['patient']);
    expect(JSON.stringify([db.users[0], db.patients])).toBe(before);
  });

  it('adopts unowned patient records for the number, and only those', async () => {
    const staff = addUser({ roles: ['doctor'], phone: OTHER_PHONE });
    const orphan = addPatient({ phone: '+91 90000 00011'.replace(/ /g, ''), firstName: 'Meena' });
    const owned = addPatient({ phone: PHONE, userId: staff.id });
    const res = await login(await codeFor());
    expect(orphan.userId).toBe(res.user.id);
    expect(owned.userId).toBe(staff.id);
    expect(res.user.firstName).toBe('Meena');
  });

  it('email registration can neither claim a number nor store it unproved', async () => {
    const placeholder = addUser({ roles: ['patient'], phone: PHONE, email: 'phone-919000000011@auto.hospital.local' });
    await authService.register({ email: 'stranger@example.com', password: 'Str0ng@pass', firstName: 'S', lastName: 'T', phone: PHONE });
    expect(placeholder.email).toBe('phone-919000000011@auto.hospital.local');
    expect(db.users[1]).toMatchObject({ email: 'stranger@example.com', phone: null });
    expect((await login(await codeFor())).user.id).toBe(placeholder.id);
  });
});

describe('two-factor and sessions', () => {
  it('does not bypass 2FA, on the row or on its platform copy', async () => {
    addUser({ roles: ['patient'], email: 'p@example.com', is2faEnabled: true, twoFaSecret: 'S3CRET' });
    const copy = addUser({ roles: ['patient'], email: 'p@example.com', phone: PHONE, tenant: tenants.HOSPITAL });
    const code = await codeFor();
    await expectFailure(login(code), 400, '2FA_REQUIRED');
    await expectFailure(login(code, { twoFactorCode: '000000' }), 401);
    vi.mocked(authenticator.verify).mockReturnValue(true);
    const res = await login(code, { twoFactorCode: '123456' });
    expect(res.user.id).toBe(copy.id);
    expect(authenticator.verify).toHaveBeenLastCalledWith({ token: '123456', secret: 'S3CRET' });
  });

  it('limits second-factor guesses to the code budget', async () => {
    addUser({ roles: ['patient'], phone: PHONE, is2faEnabled: true, twoFaSecret: 'S3CRET' });
    const code = await codeFor();
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await expectFailure(login(code, { twoFactorCode: '000000' }), 401);
    vi.mocked(authenticator.verify).mockReturnValue(true);
    await failure(login(code, { twoFactorCode: '123456' }));
    expect(db.loginAudits).toHaveLength(0);
  });

  it('a phone session does not become a staff session on refresh', async () => {
    const acc = addUser({ roles: ['patient'], phone: PHONE });
    const res = await login(await codeFor());
    expect(jwt.decode(res.refreshToken)).toMatchObject({ via: 'phone', roles: ['patient'] });
    const refreshed = await authService.refreshToken(res.refreshToken);
    expect(jwt.decode(refreshed.refreshToken)).toMatchObject({ via: 'phone' });
    acc.userRoles = [{ role: { id: 'r', name: 'admin' } }];
    await expectFailure(authService.refreshToken(refreshed.refreshToken), 401);
  });

  it('a mixed-role person signs in with their password; a patient still may not', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const passwordHash = await bcrypt.hash('Str0ng@pass', 4);
    addUser({ roles: ['patient', 'nurse'], email: 'mixed@example.com', passwordHash, tenant: tenants.HOSPITAL });
    addUser({ roles: ['patient'], email: 'pat@example.com', passwordHash });
    expect((await authService.login({ email: 'mixed@example.com', password: 'Str0ng@pass' })).accessToken).toBeTruthy();
    await expectFailure(authService.login({ email: 'pat@example.com', password: 'Str0ng@pass' }), 400, 'USE_PHONE_LOGIN');
  });
});

describe('nothing sensitive leaks', () => {
  it('no code or number in responses, audit rows, or any log above the sandbox line', async () => {
    addUser({ roles: ['patient'], phone: PHONE });
    const code = await codeFor();
    const sent = loggedText();
    const sandboxLine = JSON.stringify((await import('../../../../src/config/logger')).logger.debug.mock.calls);
    expect(sandboxLine).toContain(code);
    expect(sandboxLine).not.toContain('9000000011');
    vi.mocked((await import('../../../../src/config/logger')).logger.debug).mockClear();
    expect(sent).not.toContain('9000000011');
    const res = await login(code);
    for (const text of [loggedText(), JSON.stringify(res), JSON.stringify(db.audits), JSON.stringify(db.loginAudits)]) {
      expect(text).not.toContain(code);
    }
    expect(loggedText()).not.toContain('9000000011');
  });
});
