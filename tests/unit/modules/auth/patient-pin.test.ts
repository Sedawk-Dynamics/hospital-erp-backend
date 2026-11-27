import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A patient's own PIN on one device.

vi.mock('otplib', () => ({ authenticator: { verify: vi.fn(() => false), generateSecret: vi.fn(), keyuri: vi.fn() } }));
vi.mock('../../../../src/services/email.service', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../../../../src/modules/patient-portal/patient-portal.service', () => ({ createPatientInTenant: vi.fn() }));

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { authService } from '../../../../src/modules/auth/auth.service';
import { pinProblem } from '../../../../src/modules/auth/pin-rules';
import { deviceLabel, patientPinService, PIN_MAX_ATTEMPTS } from '../../../../src/modules/auth/patient-pin.service';
import { usersService } from '../../../../src/modules/users/users.service';
import { AppError } from '../../../../src/shared/appError';
import { addPatient, addUser, db, installFakeDb, installFakeRedis, loggedText, sandboxCode, store, tenants } from './patient-auth.fakes';

const PHONE = '+919000000011';
const PIN = '480193';
const WRONG = '915038';

async function expectFailure(p: Promise<unknown>, status: number, code?: string): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect([e.statusCode, e.code]).toEqual([status, code ?? e.code]);
    return e;
  }
  throw new Error('should have failed');
}

let patient: Record<string, any>;

async function otpLogin() {
  await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' });
  return authService.loginWithPhoneOtp({ phone: PHONE, otp: sandboxCode(), intent: 'login' });
}
async function setUpDevice(pin = PIN, deviceToken?: string) {
  const { pinSetupToken } = await otpLogin();
  return patientPinService.setPin(patient.id, { pin, setupToken: pinSetupToken, deviceToken });
}
const pinLogin = (deviceToken: string, pin: string, twoFactorCode?: string) =>
  patientPinService.login({ deviceToken, pin, twoFactorCode });
const nextMinute = () => vi.setSystemTime(Date.now() + 61_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T06:00:00Z') });
  installFakeRedis();
  installFakeDb();
  vi.mocked(authenticator.verify).mockReturnValue(false);
  vi.stubEnv('OTP_PROVIDER', 'sandbox');
  patient = addUser({ roles: ['patient'], phone: PHONE });
  addPatient({ userId: patient.id, phone: PHONE, dateOfBirth: new Date('1987-04-19T00:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('PIN rules', () => {
  it.each([
    '000000', '111111', '123456', '654321', '890123', '210987', '135791', '123123', '123321', '121212', '112233',
    '111222', '445566', '696969', '100000', '111119', '010203', '101112', '102030', '302010', '147258', '159753', '786786',
  ])('refuses %s', (pin) => expect(pinProblem(pin)).toBeTruthy());

  it('refuses digits from the phone and every way of writing a date of birth', () => {
    const about = { phones: ['+91 98401 57362'], datesOfBirth: [new Date('1987-04-19T00:00:00Z')] };
    for (const pin of ['157362', '984015', '190487', '041987', '198704', '870419', '041987', '190419', '191987']) {
      expect([pin, pinProblem(pin, about)]).toEqual([pin, expect.any(String)]);
    }
  });

  it('accepts an ordinary PIN and only exactly six digits', () => {
    for (const ok of [PIN, WRONG, '730264', '058291']) expect(pinProblem(ok)).toBeNull();
    for (const bad of ['48019', '4801933', '48o193', '']) expect(pinProblem(bad)).toBeTruthy();
  });
});

describe('setting a PIN', () => {
  it('needs proof of a code: no proof, a used ticket and a stranger\'s ticket are all refused', async () => {
    await expectFailure(patientPinService.setPin(patient.id, { pin: PIN }), 400, 'PIN_PROOF_REQUIRED');
    const { pinSetupToken } = await otpLogin();
    const other = addUser({ roles: ['patient'], phone: '9000000022' });
    await expectFailure(patientPinService.setPin(other.id, { pin: PIN, setupToken: pinSetupToken }), 400, 'PIN_PROOF_REQUIRED');
    await patientPinService.setPin(patient.id, { pin: PIN, setupToken: pinSetupToken });
    await expectFailure(patientPinService.setPin(patient.id, { pin: PIN, setupToken: pinSetupToken }), 400, 'PIN_PROOF_REQUIRED');
    expect(db.devices).toHaveLength(1);
  });

  it('the ticket lasts fifteen minutes', async () => {
    const { pinSetupToken } = await otpLogin();
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    await expectFailure(patientPinService.setPin(patient.id, { pin: PIN, setupToken: pinSetupToken }), 400, 'PIN_PROOF_REQUIRED');
  });

  it('a refused PIN does not use up the ticket', async () => {
    const { pinSetupToken } = await otpLogin();
    for (const weak of ['123123', '000011', '190487']) {
      await expectFailure(patientPinService.setPin(patient.id, { pin: weak, setupToken: pinSetupToken }), 400, 'PIN_WEAK');
    }
    await patientPinService.setPin(patient.id, { pin: PIN, setupToken: pinSetupToken });
  });

  it('a fresh code works instead, and a sign-in code does not', async () => {
    await authService.requestPhoneOtp({ phone: PHONE, intent: 'login' });
    await expectFailure(patientPinService.setPin(patient.id, { pin: PIN, code: sandboxCode() }), 400, 'OTP_EXPIRED');
    const receipt = await patientPinService.requestSetupCode(patient.id);
    expect(receipt).toMatchObject({ channel: 'sms', sentTo: '+91 ******0011' });
    const code = sandboxCode();
    await expectFailure(authService.loginWithPhoneOtp({ phone: PHONE, otp: code }), 400, 'OTP_EXPIRED');
    expect((await patientPinService.setPin(patient.id, { pin: PIN, code })).deviceToken).toBeTruthy();
  });

  it('stores only hashes', async () => {
    const { deviceToken, deviceId } = await setUpDevice();
    const row = db.devices[0];
    expect(row.id).toBe(deviceId);
    expect(row.deviceTokenHash).not.toBe(deviceToken);
    expect(row.pinHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify([row, [...store]])).not.toContain(deviceToken);
    expect(JSON.stringify(row)).not.toContain(PIN);
    // Keyed with a server secret: the PIN alone does not match the stored hash.
    expect(await bcrypt.compare(PIN, row.pinHash)).toBe(false);
  });

  it('staff and mixed accounts cannot have one', async () => {
    for (const roles of [['doctor'], ['patient', 'nurse'], []]) {
      const u = addUser({ roles });
      await expectFailure(patientPinService.setPin(u.id, { pin: PIN, setupToken: 'x'.repeat(40) }), 403, 'PATIENTS_ONLY');
      await expectFailure(patientPinService.requestSetupCode(u.id), 403, 'PATIENTS_ONLY');
      await expectFailure(patientPinService.listDevices(u.id), 403, 'PATIENTS_ONLY');
    }
  });

  it('setting it again on the same device replaces the old one, but not somebody else\'s', async () => {
    const first = await setUpDevice();
    nextMinute();
    const second = await setUpDevice('730264', first.deviceToken);
    await expectFailure(pinLogin(first.deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
    expect((await pinLogin(second.deviceToken, '730264')).user.id).toBe(patient.id);

    const other = addUser({ roles: ['patient'], phone: '9000000022' });
    nextMinute();
    await patientPinService.requestSetupCode(other.id);
    await patientPinService.setPin(other.id, { pin: PIN, code: sandboxCode(), deviceToken: second.deviceToken });
    expect((await pinLogin(second.deviceToken, '730264')).user.id).toBe(patient.id);
  });

  it('labels the device from its user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1')).toBe('Safari on iPhone or iPad');
    expect(deviceLabel(undefined)).toBe('Unknown device');
  });
});

describe('signing in with a PIN', () => {
  it('needs both this device and its PIN', async () => {
    const a = await setUpDevice();
    nextMinute();
    const b = await setUpDevice('730264');
    const res = await pinLogin(a.deviceToken, PIN);
    expect(res.user).toMatchObject({ id: patient.id, roles: ['patient'] });
    expect(res).not.toHaveProperty('pinSetupToken'); // a PIN cannot mint another device
    await expectFailure(pinLogin(b.deviceToken, PIN), 401, 'PIN_INVALID'); // device A's PIN on device B
    await expectFailure(pinLogin('not-a-device-token-at-all', PIN), 401, 'PIN_UNAVAILABLE');
  });

  it('locks after five wrong PINs, and only a code sign-in helps', async () => {
    const { deviceToken } = await setUpDevice();
    for (let left = PIN_MAX_ATTEMPTS - 1; left > 0; left--) {
      const err = await expectFailure(pinLogin(deviceToken, WRONG), 401, 'PIN_INVALID');
      expect(err.message).toContain(`${left} attempt`);
    }
    await expectFailure(pinLogin(deviceToken, WRONG), 401, 'PIN_LOCKED');
    await expectFailure(pinLogin(deviceToken, PIN), 401, 'PIN_LOCKED'); // the right one no longer works
    expect(db.devices[0].lockedAt).toBeInstanceOf(Date);
    expect(db.audits.map((a) => a.description)).toContain('Sign-in PIN locked after too many wrong PINs');
    expect(db.loginAudits.filter((a) => a.status === 'failed').length).toBeGreaterThanOrEqual(5);

    nextMinute();
    const again = await setUpDevice('730264', deviceToken);
    expect((await pinLogin(again.deviceToken, '730264')).accessToken).toBeTruthy();
  });

  it('parallel guesses share the same five attempts', async () => {
    const { deviceToken } = await setUpDevice();
    const compare = vi.spyOn(bcrypt, 'compare');
    const results = await Promise.allSettled([...Array(12).fill(WRONG), PIN].map((p) => pinLogin(deviceToken, p)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(db.devices[0].failedAttempts).toBe(PIN_MAX_ATTEMPTS);
    expect(compare).toHaveBeenCalled();
  });

  it('a right PIN resets the count', async () => {
    const { deviceToken } = await setUpDevice();
    for (let i = 0; i < 4; i++) await expectFailure(pinLogin(deviceToken, WRONG), 401, 'PIN_INVALID');
    await pinLogin(deviceToken, PIN);
    expect(db.devices[0].failedAttempts).toBe(0);
    expect(db.devices[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('does a hash comparison for an unknown or revoked device too, with the same answer', async () => {
    const { deviceToken, deviceId } = await setUpDevice();
    await patientPinService.revokeDevice(patient.id, deviceId);
    const compare = vi.spyOn(bcrypt, 'compare');
    const revoked = await expectFailure(pinLogin(deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
    const unknown = await expectFailure(pinLogin('x'.repeat(43), PIN), 401, 'PIN_UNAVAILABLE');
    expect(compare).toHaveBeenCalledTimes(2);
    expect(revoked.message).toBe(unknown.message);
  });

  it('refuses an account that became staff, was deactivated, or is staff elsewhere, and revokes the device', async () => {
    const breakIt: (() => void)[] = [
      () => { patient.userRoles = [...patient.userRoles, { role: { id: 'r', name: 'nurse' } }]; },
      () => { patient.isActive = false; },
      () => { addUser({ roles: ['doctor'], email: patient.email, tenant: tenants.HOSPITAL }); },
    ];
    for (const change of breakIt) {
      const { deviceToken } = await setUpDevice();
      const saved = { userRoles: patient.userRoles, isActive: patient.isActive };
      change();
      const unknown = await expectFailure(pinLogin('x'.repeat(43), PIN), 401);
      const err = await expectFailure(pinLogin(deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
      expect(err.message).toBe(unknown.message);
      expect(db.devices.at(-1)).toMatchObject({ revokedReason: 'not_eligible' });
      Object.assign(patient, saved);
      db.users = [patient];
      nextMinute();
    }
  });

  it('does not bypass 2FA, and app-code guesses use the same five attempts', async () => {
    const { deviceToken } = await setUpDevice();
    Object.assign(patient, { is2faEnabled: true, twoFaSecret: 'S3CRET' });
    await expectFailure(pinLogin(deviceToken, PIN), 400, '2FA_REQUIRED');
    await expectFailure(pinLogin(deviceToken, PIN, '000000'), 401);
    vi.mocked(authenticator.verify).mockReturnValueOnce(true);
    expect((await pinLogin(deviceToken, PIN, '123456')).accessToken).toBeTruthy();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) await expectFailure(pinLogin(deviceToken, PIN, '000000'), 401);
    vi.mocked(authenticator.verify).mockReturnValue(true);
    await expectFailure(pinLogin(deviceToken, PIN, '123456'), 401, 'PIN_LOCKED');
  });
});

describe('changing, removing and revoking', () => {
  it('changes the PIN given the current one; wrong ones count towards the lock without a 401', async () => {
    const { deviceToken } = await setUpDevice();
    const change = (currentPin: string, newPin: string) => patientPinService.changePin(patient.id, { deviceToken, currentPin, newPin });
    await expectFailure(change(WRONG, '730264'), 400, 'PIN_INVALID');
    await expectFailure(change(PIN, '123123'), 400, 'PIN_WEAK');
    await change(PIN, '730264');
    await expectFailure(pinLogin(deviceToken, PIN), 401, 'PIN_INVALID');
    await pinLogin(deviceToken, '730264');
    const other = addUser({ roles: ['patient'] });
    await expectFailure(
      patientPinService.changePin(other.id, { deviceToken, currentPin: '730264', newPin: PIN }), 400, 'PIN_UNAVAILABLE');
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i++) await expectFailure(change(WRONG, PIN), 400, 'PIN_INVALID');
    await expectFailure(change(WRONG, PIN), 400, 'PIN_LOCKED');
  });

  it('lists and removes own devices only', async () => {
    const a = await setUpDevice();
    const list = await patientPinService.listDevices(patient.id);
    expect(list.devices).toEqual([expect.objectContaining({ id: a.deviceId, locked: false })]);
    expect(JSON.stringify(list)).not.toMatch(/hash/i);
    const other = addUser({ roles: ['patient'] });
    await expectFailure(patientPinService.revokeDevice(other.id, a.deviceId), 404);
    await patientPinService.revokeAllDevices(other.id);
    expect((await pinLogin(a.deviceToken, PIN)).accessToken).toBeTruthy();
    await patientPinService.revokeDevice(patient.id, a.deviceId);
    await expectFailure(pinLogin(a.deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
    expect((await patientPinService.listDevices(patient.id)).devices).toEqual([]);
  });

  it('revokes every device', async () => {
    const a = await setUpDevice();
    nextMinute();
    const b = await setUpDevice('730264');
    expect((await patientPinService.revokeAllDevices(patient.id)).count).toBe(2);
    await expectFailure(pinLogin(a.deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
    await expectFailure(pinLogin(b.deviceToken, '730264'), 401, 'PIN_UNAVAILABLE');
  });

  const reasons: [string, () => Promise<unknown>][] = [
    ['phone_changed', async () => {
      await authService.requestPhoneChange(patient.id, { phone: '9000000044' });
      await authService.verifyPhoneChange(patient.id, { phone: '9000000044', code: sandboxCode() });
    }],
    ['phone_changed', () => usersService.update(patient.tenantId, patient.id, { phone: '9000000055' } as never)],
    ['password_changed', async () => {
      patient.passwordHash = await bcrypt.hash('Old@12345', 4);
      await authService.changePassword(patient.id, { currentPassword: 'Old@12345', newPassword: 'New@12345' });
    }],
    ['password_changed', async () => {
      const { prisma } = await import('../../../../src/config/database');
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: patient.id, email: patient.email } as never);
      await authService.resetPassword({ token: 't', newPassword: 'New@12345' });
    }],
    ['deactivated', () => usersService.deactivate(patient.tenantId, patient.id)],
    ['deactivated', () => usersService.toggleActiveGlobal(patient.id, false)],
    ['deactivated', () => usersService.update(patient.tenantId, patient.id, { isActive: false } as never)],
  ];
  it.each(reasons)('all devices are revoked: %s', async (reason, act) => {
    const { deviceToken } = await setUpDevice();
    await act();
    expect(db.devices[0]).toMatchObject({ revokedAt: expect.any(Date), revokedReason: reason });
    await expectFailure(pinLogin(deviceToken, PIN), 401, 'PIN_UNAVAILABLE');
  });

  it('a phone change code goes to the new number when a provider is configured', async () => {
    const res = await authService.requestPhoneChange(patient.id, { phone: '9000000044' });
    expect(res).toMatchObject({ channel: 'sms', sentTo: '+91 ******0044' });
  });
});

describe('nothing sensitive leaks', () => {
  it('no PIN, device token or hash in logs, audit rows or login rows', async () => {
    const { deviceToken, deviceId } = await setUpDevice();
    const { pinHash, deviceTokenHash } = db.devices[0];
    await expectFailure(pinLogin(deviceToken, WRONG), 401);
    await pinLogin(deviceToken, PIN);
    await patientPinService.changePin(patient.id, { deviceToken, currentPin: PIN, newPin: '730264' });
    await patientPinService.revokeDevice(patient.id, deviceId);
    expect(db.audits.map((a) => a.action)).toEqual(['create', 'read', 'update', 'delete']);
    expect(db.audits.every((a) => a.entityType === 'patient_trusted_device' && a.userId === patient.id)).toBe(true);
    const text = loggedText() + JSON.stringify([db.audits, db.loginAudits]);
    for (const secret of [PIN, WRONG, '730264', deviceToken, pinHash, deviceTokenHash]) expect(text).not.toContain(secret);
  });
});
