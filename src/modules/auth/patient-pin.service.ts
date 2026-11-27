import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { getRequestContext } from '../../config/request-context';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { checkOtp, consumeOtp } from '../../shared/one-time-code';
import { phoneE164 } from '../../shared/phone-identity';
import { revokeTrustedDevices } from '../../shared/trusted-devices';
import { issueAndDeliverOtp, signInCodeEmail, type OtpDeliveryReceipt } from '../../services/otp-delivery/dispatch';
import { authService } from './auth.service';
import { loadPatientAccount, type PatientAccount } from './patient-account';
import { consumePinSetupTicket } from './pin-setup-ticket';
import { pinProblem } from './pin-rules';
import type { ChangePinInput, PinLoginInput, SetPinInput } from './auth.validation';

// ---------------------------------------------------------------------------
// A patient's own PIN, for one device, "like a phone".
//
// Two things are needed to sign in: the random token this device was given (it
// lives only on the device; we keep its hash) and the 6-digit PIN. A PIN is
// worth nothing on another device, and a stolen token is worth five guesses,
// after which the device needs a one-time code again.
// ---------------------------------------------------------------------------

export const PIN_MAX_ATTEMPTS = 5;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * What bcrypt sees: the PIN keyed with a server secret and tied to its device
 * row. There are only a million PINs, so without the secret a leaked database
 * would give every one of them away.
 */
const pepper = (deviceId: string, pin: string) =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`patient-pin:${deviceId}:${pin}`).digest('base64');

let dummyHash: Promise<string> | null = null;
/** Compared against when there is no device, so a miss costs the same as a hit. */
const getDummyHash = () =>
  (dummyHash ??= bcrypt.hash(crypto.randomBytes(32).toString('base64'), env.BCRYPT_SALT_ROUNDS));

const unavailable = () =>
  new AppError('PIN sign-in is not available on this device. Sign in with a code instead.', 401, 'PIN_UNAVAILABLE');
const locked = () =>
  new AppError('Too many wrong PINs. Sign in with a code instead.', 401, 'PIN_LOCKED');

/** "Chrome on Android", from the user agent. A label for the owner, not evidence. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iPhone or iPad'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

async function requirePatient(userId: string): Promise<PatientAccount> {
  const account = await loadPatientAccount(userId);
  if (!account) throw new AppError('A sign-in PIN is for patient accounts only', 403, 'PATIENTS_ONLY');
  return account;
}

async function assertPinAllowed(account: PatientAccount, pin: string) {
  const patients =
    (await prisma.patient.findMany({
      where: { userId: account.id, isActive: true },
      select: { dateOfBirth: true, phone: true },
    })) ?? [];
  const problem = pinProblem(pin, {
    phones: [account.phone, ...patients.map((p) => p.phone)],
    datesOfBirth: patients.map((p) => p.dateOfBirth),
  });
  if (problem) throw AppError.badRequest(problem, 'PIN_WEAK');
}

type Device = NonNullable<Awaited<ReturnType<typeof prisma.patientTrustedDevice.findUnique>>>;
type PinCheck = { ok: true } | { ok: false; locked: boolean; attemptsLeft: number };

/**
 * Compare a PIN with a device's. The attempt is taken off the device's budget
 * in one conditional UPDATE before comparing, so parallel guesses cannot get
 * more than {@link PIN_MAX_ATTEMPTS}. A match does not give the attempts back;
 * {@link acceptPin} does, once everything else has passed too.
 */
async function checkDevicePin(device: Device, pin: string): Promise<PinCheck> {
  const reserved = await prisma.patientTrustedDevice.updateMany({
    where: { id: device.id, revokedAt: null, lockedAt: null, failedAttempts: { lt: PIN_MAX_ATTEMPTS } },
    data: { failedAttempts: { increment: 1 } },
  });
  // Compared whether or not an attempt was left, so a locked device answers in the same time.
  const matches = await bcrypt.compare(pepper(device.id, pin), device.pinHash);
  if (reserved.count === 1 && matches) return { ok: true };

  const now = await prisma.patientTrustedDevice.findUnique({
    where: { id: device.id },
    select: { failedAttempts: true, lockedAt: true },
  });
  const used = now?.failedAttempts ?? PIN_MAX_ATTEMPTS;
  if (reserved.count === 1 && used < PIN_MAX_ATTEMPTS) {
    return { ok: false, locked: false, attemptsLeft: PIN_MAX_ATTEMPTS - used };
  }
  const nowLocked = await prisma.patientTrustedDevice.updateMany({
    where: { id: device.id, lockedAt: null, failedAttempts: { gte: PIN_MAX_ATTEMPTS } },
    data: { lockedAt: new Date() },
  });
  if (nowLocked.count === 1) await auditDevice(device.userId, device.id, 'update', 'Sign-in PIN locked after too many wrong PINs');
  return { ok: false, locked: true, attemptsLeft: 0 };
}

/** The PIN (and everything after it) passed. False if the device was revoked or locked meanwhile. */
async function acceptPin(deviceId: string): Promise<boolean> {
  const res = await prisma.patientTrustedDevice.updateMany({
    where: { id: deviceId, revokedAt: null, lockedAt: null },
    data: { failedAttempts: 0, lastUsedAt: new Date() },
  });
  return res.count === 1;
}

/** Audit under the patient's own tenant. Never carries a PIN, a token or a hash. */
async function auditDevice(
  userId: string,
  deviceId: string,
  action: 'create' | 'read' | 'update' | 'delete',
  description: string,
  newValues?: object,
) {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!owner) return;
  await writeAudit({
    tenantId: owner.tenantId,
    userId,
    action,
    entityType: 'patient_trusted_device',
    entityId: deviceId,
    description,
    newValues,
  });
}

function wrongPin(check: { locked: boolean; attemptsLeft: number }, status: 400 | 401): AppError {
  if (check.locked) return status === 401 ? locked() : new AppError(locked().message, 400, 'PIN_LOCKED');
  const n = check.attemptsLeft;
  return new AppError(`Wrong PIN. ${n} attempt${n === 1 ? '' : 's'} left.`, status, 'PIN_INVALID');
}

export const patientPinService = {
  /**
   * Sign in with this device's token and PIN. A device that is unknown,
   * revoked, or whose account is no longer an active patient's, all get the
   * same answer in the same time.
   */
  async login(data: PinLoginInput) {
    const device = await prisma.patientTrustedDevice.findUnique({
      where: { deviceTokenHash: hashToken(data.deviceToken) },
    });
    if (!device || device.revokedAt) {
      await bcrypt.compare(pepper('none', data.pin), await getDummyHash());
      throw unavailable();
    }

    const check = await checkDevicePin(device, data.pin);
    const account = await loadPatientAccount(device.userId);
    if (!account) {
      await revokeTrustedDevices([device.userId], 'not_eligible');
      throw unavailable();
    }
    if (!check.ok) {
      await prisma.loginAuditLog
        .create({
          data: {
            userId: account.id,
            tenantId: account.tenantId,
            status: 'failed',
            failureReason: check.locked ? 'PIN locked' : 'Wrong PIN',
            ipAddress: getRequestContext()?.ipAddress?.slice(0, 45),
            userAgent: getRequestContext()?.userAgent,
          },
        })
        .catch((err: unknown) => logger.warn({ err }, 'Failed to create login audit log'));
      throw wrongPin(check, 401);
    }

    // A wrong app code needs no counter of its own: the attempt taken above is
    // only given back by acceptPin, so five of them lock the device too.
    await authService.assertSecondFactor(account, data.twoFactorCode, async () => undefined);
    if (!(await acceptPin(device.id))) throw unavailable();

    logger.info({ userId: account.id, deviceId: device.id }, 'Patient signed in with a device PIN');
    await auditDevice(account.id, device.id, 'read', 'Signed in with a device PIN');
    return authService.buildAuthResult(account, { via: 'phone' });
  },

  /** Step-up code for setting a PIN when this session did not just sign in with one. */
  async requestSetupCode(userId: string): Promise<OtpDeliveryReceipt> {
    const account = await requirePatient(userId);
    const phone = phoneE164(account.phone);
    return issueAndDeliverOtp({
      purpose: 'pin-setup',
      subject: account.id,
      binding: phone ?? account.id,
      limitSubject: account.id,
      phone,
      email: signInCodeEmail(account.email, account.firstName, 'set a sign-in PIN'),
    });
  },

  /**
   * Set a PIN for this device. Needs proof of a one-time code: the ticket from
   * a code sign-in minutes ago, or a fresh code. The device token is returned
   * here and never again.
   */
  async setPin(userId: string, data: SetPinInput) {
    const account = await requirePatient(userId);
    // Before the proof is used up, so a refused PIN can simply be chosen again.
    await assertPinAllowed(account, data.pin);

    if (data.setupToken) {
      if (!(await consumePinSetupTicket(data.setupToken, account.id))) {
        throw AppError.badRequest('Confirm with a code to set a PIN', 'PIN_PROOF_REQUIRED');
      }
    } else if (data.code) {
      const challenge = await checkOtp({
        purpose: 'pin-setup',
        subject: account.id,
        binding: phoneE164(account.phone) ?? account.id,
        code: data.code,
      });
      await consumeOtp(challenge);
    } else {
      throw AppError.badRequest('Confirm with a code to set a PIN', 'PIN_PROOF_REQUIRED');
    }

    // Setting a PIN again on the same device replaces the old one.
    if (data.deviceToken) {
      await prisma.patientTrustedDevice.updateMany({
        where: { deviceTokenHash: hashToken(data.deviceToken), userId: account.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'replaced' },
      });
    }

    const id = crypto.randomUUID();
    const deviceToken = crypto.randomBytes(32).toString('base64url');
    const label = deviceLabel(getRequestContext()?.userAgent);
    await prisma.patientTrustedDevice.create({
      data: {
        id,
        userId: account.id,
        deviceTokenHash: hashToken(deviceToken),
        pinHash: await bcrypt.hash(pepper(id, data.pin), env.BCRYPT_SALT_ROUNDS),
        label,
        lastUsedAt: new Date(),
      },
    });
    logger.info({ userId: account.id, deviceId: id }, 'Patient set a device PIN');
    await auditDevice(account.id, id, 'create', 'Set a sign-in PIN for a device', { label });
    return { deviceId: id, deviceToken, label };
  },

  /** Change this device's PIN, given the current one. A wrong one counts towards the lock. */
  async changePin(userId: string, data: ChangePinInput) {
    const account = await requirePatient(userId);
    const device = await prisma.patientTrustedDevice.findUnique({
      where: { deviceTokenHash: hashToken(data.deviceToken) },
    });
    if (!device || device.revokedAt || device.userId !== account.id) {
      throw AppError.badRequest('There is no PIN on this device', 'PIN_UNAVAILABLE');
    }
    if (data.currentPin === data.newPin) {
      throw AppError.badRequest('Choose a PIN different from the current one', 'PIN_WEAK');
    }
    // 400, not 401: a 401 would make the client sign the patient out.
    const check = await checkDevicePin(device, data.currentPin);
    if (!check.ok) throw wrongPin(check, 400);
    if (!(await acceptPin(device.id))) {
      throw AppError.badRequest('There is no PIN on this device', 'PIN_UNAVAILABLE');
    }
    await assertPinAllowed(account, data.newPin);

    await prisma.patientTrustedDevice.update({
      where: { id: device.id },
      data: { pinHash: await bcrypt.hash(pepper(device.id, data.newPin), env.BCRYPT_SALT_ROUNDS) },
    });
    logger.info({ userId: account.id, deviceId: device.id }, 'Patient changed a device PIN');
    await auditDevice(account.id, device.id, 'update', 'Changed the sign-in PIN of a device');
    return { message: 'PIN changed' };
  },

  async listDevices(userId: string) {
    const account = await requirePatient(userId);
    const rows = await prisma.patientTrustedDevice.findMany({
      where: { userId: account.id, revokedAt: null },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true, lockedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      devices: rows.map((d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        locked: !!d.lockedAt,
      })),
    };
  },

  async revokeDevice(userId: string, deviceId: string) {
    // Own rows only; somebody else's id looks like one that does not exist.
    const res = await prisma.patientTrustedDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'removed' },
    });
    if (res.count !== 1) throw AppError.notFound('Device not found');
    await auditDevice(userId, deviceId, 'delete', 'Removed a device with a sign-in PIN');
    return { message: 'Device removed' };
  },

  async revokeAllDevices(userId: string) {
    const count = await revokeTrustedDevices([userId], 'removed');
    if (count) await auditDevice(userId, userId, 'delete', 'Removed all devices with a sign-in PIN', { count });
    return { message: 'All devices removed', count };
  },
};
