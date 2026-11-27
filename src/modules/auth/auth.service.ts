import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { prisma } from '../../config/database';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { REDIS_PREFIXES } from '../../shared/constants';
import {
  AUTO_ACCOUNT_EMAIL_DOMAIN,
  isPlaceholderAccountEmail,
  phoneLast10,
  phoneMatchFilter,
  placeholderAccountEmail,
} from '../../shared/account-holder';
import { checkOtp, consumeOtp, OTP_MAX_ATTEMPTS, OTP_RESEND_SECONDS, type OtpPurpose } from '../../shared/one-time-code';
import { phoneE164, phoneSubject } from '../../shared/phone-identity';
import { revokeTrustedDevices, revokeTrustedDevicesByEmail } from '../../shared/trusted-devices';
import { assertNotLockedOut, recordFailedLogin, clearLoginFailures } from '../../middleware/rateLimiter';
import {
  findOrphanPatients,
  isPatientOnly,
  loadPatientAccount,
  resolvePatientAccountByPhone,
  twoFactorGuard,
} from './patient-account';
import { issuePinSetupTicket, PIN_SETUP_TICKET_SECONDS } from './pin-setup-ticket';
import type {
  RegisterInput,
  LoginInput,
  RequestOtpInput,
  VerifyOtpInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  Verify2FAInput,
  ChangePasswordInput,
  Disable2FAInput,
  RequestPhoneChangeInput,
  VerifyPhoneChangeInput,
} from './auth.validation';
import { createPatientInTenant } from '../patient-portal/patient-portal.service';
import { writeAudit } from '../../shared/audit';
import { getRequestContext } from '../../config/request-context';
import { canSendOtpToPhone } from '../../services/otp-delivery';
import { sendPasswordResetEmail } from '../../services/email.service';
import {
  escapeHtml,
  issueAndDeliverOtp,
  maskEmail,
  signInCodeEmail,
  type OtpDeliveryReceipt,
} from '../../services/otp-delivery/dispatch';

export { maskEmail };

/** Only the hash is stored: a database reader must not be able to use a link. */
const hashResetToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Who is acting, for audit rows: the session's tenant (hospital or platform). */
export interface AccountActionContext {
  tenantId?: string;
}

// ── Gap 297: phone change with a one-time code ───────────────────
// Same one-time-code helpers as patient sign-in (shared/one-time-code.ts), under
// its own purpose: a sign-in code cannot change a phone and vice versa.
export const PHONE_CHANGE_TTL_SECONDS = 10 * 60;
export const PHONE_CHANGE_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;
export const PHONE_CHANGE_RESEND_SECONDS = OTP_RESEND_SECONDS;

/**
 * An Indian mobile number in canonical `+91XXXXXXXXXX` form, or null. Accepts
 * an optional +91 / 91 / 0 prefix and the usual separators; the 10-digit number
 * must start with 6-9.
 */
export function parseIndianMobile(raw: string): string | null {
  const compact = (raw || '').replace(/[\s()\-.]/g, '');
  const m = compact.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  return m ? `+91${m[1]}` : null;
}

/** Tenant to file an account audit row under: the session's, else the user's own. */
function auditTenant(ctx: AccountActionContext | undefined, fallback: string): string {
  return ctx?.tenantId || getRequestContext()?.tenantId || fallback;
}

/** Patient phone codes: login and signup codes are not interchangeable. */
function phoneSignInPurpose(intent?: 'login' | 'signup'): OtpPurpose {
  return intent === 'login' ? 'patient-login' : intent === 'signup' ? 'patient-signup' : 'patient-auth';
}

const invalidPhone = () => AppError.badRequest('Enter a valid phone number', 'INVALID_PHONE');

interface TokenPayload {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  /**
   * Set when the session came from a phone code or a device PIN rather than a
   * password. Such a session is a patient's for as long as it lives: if the
   * account is later given a staff role, refreshing it is refused.
   */
  via?: 'phone';
}

function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
  } as jwt.SignOptions);
}

function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
  } as jwt.SignOptions);
}

function getRefreshTokenTTL(): number {
  const match = env.JWT_REFRESH_EXPIRY.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60; // default 7 days
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 60 * 60;
    case 'd': return value * 24 * 60 * 60;
    default: return 7 * 24 * 60 * 60;
  }
}

export const authService = {
  async register(data: RegisterInput) {
    let tenant;

    if (data.tenantSlug) {
      tenant = await prisma.tenant.findUnique({
        where: { slug: data.tenantSlug },
      });

      if (!tenant) {
        throw AppError.notFound('Tenant not found');
      }

      if (!tenant.isActive) {
        throw AppError.badRequest('Tenant is not active');
      }
    } else {
      // Patient self-signup: use platform tenant
      tenant = await prisma.tenant.findFirst({
        where: { slug: '__platform__' },
      });

      if (!tenant) {
        throw AppError.internal('Platform tenant not found');
      }
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        email: data.email,
        tenantId: tenant.id,
      },
    });

    if (existingUser) {
      throw AppError.conflict('User with this email already exists in this tenant');
    }

    const hashedPassword = await bcrypt.hash(data.password, env.BCRYPT_SALT_ROUNDS);

    // Find or create the default role (patient) for this tenant
    let defaultRole = await prisma.role.findFirst({
      where: {
        tenantId: tenant.id,
        name: 'patient',
      },
    });

    if (!defaultRole && !data.tenantSlug) {
      // Self-signup patient on platform — create patient role if missing
      defaultRole = await prisma.role.create({
        data: {
          name: 'patient',
          description: 'Patient user with access to patient portal',
          tenantId: tenant.id,
          isSystemRole: true,
        },
      });
    }

    const registeredUserSelect = {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      tenantId: true,
      isActive: true,
      createdAt: true,
      userRoles: {
        select: {
          role: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    } as const;

    // Nothing here proves the caller owns `data.phone`, and a phone number is a
    // patient's sign-in. So it is neither stored on the new account nor used to
    // claim the account a front desk created for that number: either would let
    // a stranger take over the number's account (and receive its codes at their
    // own email). Patients sign up with a code to their phone instead.
    if (data.phone) {
      logger.warn({ tenantId: tenant.id }, 'Unverified phone ignored at email registration');
    }

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        tenantId: tenant.id,
        isActive: true,
        ...(defaultRole && {
          userRoles: {
            create: {
              roleId: defaultRole.id,
            },
          },
        }),
      },
      select: registeredUserSelect,
    });

    logger.info({ userId: user.id, tenantId: tenant.id }, 'User registered');

    return user;
  },

  async login(data: LoginInput) {
    // Find all users with this email (could exist in multiple tenants after hospital creation)
    const users = await prisma.user.findMany({
      where: {
        email: data.email,
      },
      include: {
        tenant: true,
        userRoles: {
          include: {
            role: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    if (users.length === 0) {
      // Count email-not-found as a failed attempt to blunt email enumeration.
      await recordFailedLogin(data.email);
      throw AppError.unauthorized('Invalid credentials');
    }

    // Prefer the platform tenant user (the one who registered with their real password)
    // Hospital tenant copies have random password hashes and should not be used for login
    const platformUser = users.find((u) => u.tenant.slug === '__platform__');
    const user = platformUser || users[0];

    if (!user) {
      await recordFailedLogin(data.email);
      throw AppError.unauthorized('Invalid credentials');
    }

    if (!user.tenant.isActive) {
      throw AppError.unauthorized('Tenant is not active');
    }

    if (!user.isActive) {
      throw AppError.unauthorized('Account is deactivated');
    }

    const passwordValid = await bcrypt.compare(data.password, user.passwordHash);
    if (!passwordValid) {
      await recordFailedLogin(data.email);
      throw AppError.unauthorized('Invalid credentials');
    }

    // Check 2FA if enabled
    if (user.is2faEnabled) {
      if (!data.twoFactorCode) {
        // Not a credential failure — just a missing second factor input.
        throw AppError.badRequest('Two-factor authentication code is required', '2FA_REQUIRED');
      }

      const isValid = authenticator.verify({
        token: data.twoFactorCode,
        secret: user.twoFaSecret!,
      });

      if (!isValid) {
        await recordFailedLogin(data.email);
        throw AppError.unauthorized('Invalid two-factor authentication code');
      }
    }

    // Credentials (and 2FA if required) all passed — reset the counter.
    await clearLoginFailures(data.email);

    // Patients don't use email/password — they sign in with phone + code only.
    // Anyone who also holds a staff role is staff: phone sign-in refuses them,
    // so the password must work or they would have no way in at all.
    if (isPatientOnly(user.userRoles)) {
      throw AppError.badRequest(
        'Patients sign in with their phone number. Please use phone (OTP) login.',
        'USE_PHONE_LOGIN',
      );
    }

    logger.info({ userId: user.id, tenantId: user.tenantId }, 'User logged in');

    return this.buildAuthResult(user);
  },

  /**
   * Issue tokens and assemble the login response for an already-authenticated
   * user. Shared by password login, patient phone-OTP login and device PIN
   * login. `user` must include its `tenant` and `userRoles.role`.
   */
  async buildAuthResult(
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string | null;
      phone: string | null;
      tenantId: string;
      isActive: boolean;
      userRoles: { role: { id: string; name: string } }[];
      tenant: { id: string; name: string; slug: string };
    },
    opts: { via?: 'phone' } = {},
  ) {
    const roles = user.userRoles.map((ur) => ur.role.name);

    const tokenPayload: TokenPayload = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles,
      ...(opts.via && { via: opts.via }),
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store refresh token in Redis
    const redisKey = `${REDIS_PREFIXES.REFRESH_TOKEN}${user.id}`;
    const ttl = getRefreshTokenTTL();
    await redis.set(redisKey, refreshToken, 'EX', ttl);

    // Log in audit
    await prisma.loginAuditLog.create({
      data: {
        userId: user.id,
        tenantId: user.tenantId,
        status: 'success',
        ipAddress: 'unknown',
        userAgent: 'unknown',
      },
    }).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to create login audit log');
    });

    // Build a single role object the frontend expects (role.slug)
    const primaryRole = user.userRoles[0]?.role;
    const isPlatformTenant = user.tenant.slug === '__platform__';

    // Determine actual onboarding status for platform users
    // Skip onboarding flow for patients and super_admins — they don't need plans/hospitals
    const isSuperAdmin = roles.includes('super_admin');
    const isPatient = primaryRole?.name === 'patient';
    let onboardingStatus: string = 'active';
    if (isPlatformTenant && !isPatient && !isSuperAdmin) {
      const statusResult = await this.getOnboardingStatus(user.id, user.tenantId);
      onboardingStatus = statusResult.status;
    }

    return {
      accessToken,
      refreshToken,
      onboardingStatus,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        tenantId: user.tenantId,
        isActive: user.isActive,
        roles,
        role: primaryRole
          ? { id: primaryRole.id, name: primaryRole.name, slug: primaryRole.name }
          : null,
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          slug: user.tenant.slug,
        },
      },
    };
  },

  // ── Patient phone-OTP auth ─────────────────────────────────
  // Patients authenticate with their phone number + a one-time code, so a
  // number the front desk already registered (the owner + their relatives) is
  // reachable with no email/password. Only accounts that are a patient's and
  // nothing else can be reached this way — see patient-account.ts.

  /**
   * Send a one-time code to a phone number. The answer is the same whether the
   * number is a patient's, a staff member's or nobody's: where the code went
   * (masked) and how. Whether an account exists is only said to whoever
   * completes the code.
   */
  async requestPhoneOtp(data: RequestOtpInput): Promise<OtpDeliveryReceipt> {
    const phone = phoneE164(data.phone);
    if (!phone) throw invalidPhone();

    const account = await resolvePatientAccountByPhone(phone);
    const subject = phoneSubject(phone);
    const receipt = await issueAndDeliverOtp({
      purpose: phoneSignInPurpose(data.intent),
      subject,
      binding: phone,
      limitSubject: subject,
      phone,
      // Without an SMS / WhatsApp provider: the email the account registered with.
      email: account ? signInCodeEmail(account.email, account.firstName, 'sign in to your patient account') : null,
      // A code read in an inbox proves that inbox, not the phone: it may only
      // open the account whose inbox it is, and can never create or adopt one.
      data: (viaEmail) => (viaEmail ? { accountId: account?.id ?? null, viaEmail: true } : {}),
    });

    logger.info({ channel: receipt.channel }, 'Patient sign-in code sent');
    return receipt;
  },

  /** Check a second factor for an account that has one, as password login does. */
  async assertSecondFactor(
    account: Parameters<typeof twoFactorGuard>[0],
    twoFactorCode: string | undefined,
    onWrong: () => Promise<unknown>,
  ) {
    const guard = await twoFactorGuard(account);
    if (!guard) return;
    if (!twoFactorCode) {
      throw AppError.badRequest('Two-factor authentication code is required', '2FA_REQUIRED');
    }
    const ok = !!guard.twoFaSecret && authenticator.verify({ token: twoFactorCode, secret: guard.twoFaSecret });
    if (!ok) {
      await onWrong();
      throw AppError.unauthorized('Invalid two-factor authentication code');
    }
  },

  async loginWithPhoneOtp(data: VerifyOtpInput) {
    const phone = phoneE164(data.phone);
    if (!phone) throw invalidPhone();
    const subject = phoneSubject(phone);
    const lockId = `otp:${subject}`;
    await assertNotLockedOut(lockId);

    const challenge = await checkOtp({
      purpose: phoneSignInPurpose(data.intent),
      subject,
      binding: phone,
      code: data.otp,
    }).catch(async (err: unknown) => {
      const code = (err as AppError).code;
      if (code === 'OTP_INVALID' || code === 'OTP_ATTEMPTS_EXCEEDED') await recordFailedLogin(lockId);
      throw err;
    });

    const account = await resolvePatientAccountByPhone(phone);
    if (challenge.data.viaEmail && (!account || account.id !== challenge.data.accountId)) {
      await consumeOtp(challenge);
      throw AppError.badRequest('The code has expired. Ask for a new code.', 'OTP_EXPIRED');
    }

    // Second factor before the code is used up, so the same code can be sent
    // again with the app's code. Each try still counts against the code's limit.
    if (account && data.intent !== 'signup') {
      await this.assertSecondFactor(account, data.twoFactorCode, () => recordFailedLogin(lockId));
    }

    // From here on the code is spent, whatever happens next.
    await consumeOtp(challenge);
    await clearLoginFailures(lockId);

    const orphanPatients = account ? [] : await findOrphanPatients(phone);
    const hasExisting = !!account || orphanPatients.length > 0;

    // Enforce the separate patient flows.
    if (data.intent === 'login' && !hasExisting) {
      throw new AppError('No account found for this number. Please sign up first.', 404, 'NO_ACCOUNT');
    }
    if (data.intent === 'signup' && hasExisting) {
      throw AppError.conflict(
        'An account already exists for this number. Please sign in instead.',
        'ACCOUNT_EXISTS',
      );
    }

    let userId: string;
    if (account) {
      userId = account.id;
      // Backfill the phone if it was only on the patient record (so future
      // lookups are direct), and capture the owner's name on first login onto
      // an unnamed front-desk placeholder.
      const patch: { phone?: string; firstName?: string; lastName?: string } = {};
      if (!account.phone) patch.phone = phone;
      if (
        data.firstName?.trim() &&
        isPlaceholderAccountEmail(account.email) &&
        (!account.firstName || account.firstName === 'Patient')
      ) {
        patch.firstName = data.firstName.trim();
        if (data.lastName?.trim()) patch.lastName = data.lastName.trim();
      }
      if (Object.keys(patch).length) {
        await prisma.user.update({ where: { id: userId }, data: patch });
      }
    } else {
      const tenant = await prisma.tenant.findFirst({ where: { slug: data.tenantSlug || '__platform__' } });
      if (!tenant || !tenant.isActive) {
        throw data.tenantSlug
          ? AppError.badRequest('Hospital not found')
          : AppError.internal('Platform tenant not found');
      }
      let patientRole = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: 'patient' },
      });
      if (!patientRole) {
        patientRole = await prisma.role.create({
          data: {
            name: 'patient',
            description: 'Patient user with access to patient portal',
            tenantId: tenant.id,
            isSystemRole: true,
          },
        });
      }

      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), env.BCRYPT_SALT_ROUNDS);
      const synth = placeholderAccountEmail(phone);
      // Any tenant: rows sharing an email are one person, and this is a new one.
      const clash = await prisma.user.findFirst({
        where: { email: synth },
        select: { id: true },
      });
      const email = clash
        ? `phone-${phone.replace(/\D/g, '')}-${Date.now()}@${AUTO_ACCOUNT_EMAIL_DOMAIN}`
        : synth;

      // Name the account from signup details, else from an existing patient
      // record already carrying this number.
      const firstOrphan = orphanPatients[0];
      const created = await prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: data.firstName?.trim() || firstOrphan?.firstName || 'Patient',
          lastName: data.lastName?.trim() || firstOrphan?.lastName || null,
          // An Indian number is stored bare (10 digits) to match the format used
          // in the patients table. Any other country keeps its code: without it
          // the number would read as an Indian one at the next sign-in.
          phone: phone.startsWith('+91') ? phoneLast10(phone) : phone,
          tenantId: tenant.id,
          isActive: true,
          userRoles: { create: { roleId: patientRole.id } },
        },
        select: { id: true },
      });
      userId = created.id;

      if (firstOrphan) {
        // Adopt the existing standalone patient record(s) for this number into
        // the new account, so the person sees their history immediately. Still
        // unowned at the moment of writing — never taken from another account.
        await prisma.patient.updateMany({
          where: { id: { in: orphanPatients.map((p) => p.id) }, userId: null },
          data: { userId },
        });
        await prisma.patient.updateMany({
          where: { id: firstOrphan.id, userId },
          data: { relationship: 'self' as never, isSelf: true },
        });
        logger.info(
          { userId, adopted: orphanPatients.length },
          'Adopted standalone patient(s) into new phone account',
        );
      } else {
        // Brand-new number → the account holder is a User, and that is all.
        //
        // This used to also mint a Patient row on the PLATFORM tenant "so the
        // portal has content immediately". Platform is not a hospital: it has
        // no doctors, wards or bills, so that row could never hold a record.
        // What it did do was survive until the person booked somewhere real,
        // at which point createPatientInTenant made a SECOND row — same person,
        // same MRN, two entries in their profile switcher, one of them empty.
        // Selecting the empty one showed them nothing, because the portal
        // narrows to the single chosen row.
        //
        // A Patient row is a hospital's record of a person. It is created on
        // first contact with that hospital — booking already does this — so a
        // brand-new account correctly has none until then.
        logger.info({ userId }, 'Patient account created via phone OTP');
      }
      if (data.tenantSlug && data.tenantSlug !== '__platform__') {
        await createPatientInTenant(userId, email, tenant.id);
      }
    }

    // Loaded again under the same rule, so nothing but a patient account can be
    // signed in here even if a role was added while the code was in flight.
    const user = await loadPatientAccount(userId);
    if (!user) {
      throw new AppError('No account found for this number. Please sign up first.', 404, 'NO_ACCOUNT');
    }
    logger.info({ userId }, 'User logged in via phone OTP');
    return {
      ...(await this.buildAuthResult(user, { via: 'phone' })),
      // Lets this client offer "set a PIN for this device" straight away.
      pinSetupToken: await issuePinSetupTicket(userId),
      pinSetupExpiresInSeconds: PIN_SETUP_TICKET_SECONDS,
    };
  },

  async refreshToken(token: string) {
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
    } catch {
      throw AppError.unauthorized('Invalid refresh token');
    }

    // Check if refresh token exists in Redis
    const redisKey = `${REDIS_PREFIXES.REFRESH_TOKEN}${payload.userId}`;
    const storedToken = await redis.get(redisKey);

    if (!storedToken || storedToken !== token) {
      // Possible token reuse attack -- delete all tokens for this user
      await redis.del(redisKey);
      throw AppError.unauthorized('Invalid refresh token - possible reuse detected');
    }

    // Fetch fresh user data for the new token
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        userRoles: {
          include: {
            role: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      await redis.del(redisKey);
      throw AppError.unauthorized('User not found or deactivated');
    }

    const roles = user.userRoles.map((ur: { role: { name: string } }) => ur.role.name);

    // A session opened with a phone code or PIN must not turn into a staff one
    // because the account gained a role (or was deactivated) afterwards.
    if (payload.via === 'phone' && !(await loadPatientAccount(user.id))) {
      await redis.del(redisKey);
      throw AppError.unauthorized('Please sign in again');
    }

    // Preserve the tenantId from the original token (not the DB user record).
    // After switchHospital the JWT carries the hospital tenantId, but the user
    // record in the DB still points to the platform tenant.  Using payload.tenantId
    // keeps the admin's hospital context alive across refreshes.
    const newPayload: TokenPayload = {
      userId: user.id,
      tenantId: payload.tenantId,
      email: user.email,
      roles,
      ...(payload.via && { via: payload.via }),
    };

    const newAccessToken = generateAccessToken(newPayload);
    const newRefreshToken = generateRefreshToken(newPayload);

    // Rotate: delete old, store new
    const ttl = getRefreshTokenTTL();
    await redis.set(redisKey, newRefreshToken, 'EX', ttl);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  },

  async logout(userId: string) {
    const redisKey = `${REDIS_PREFIXES.REFRESH_TOKEN}${userId}`;
    await redis.del(redisKey);

    // Note: logout doesn't need audit log with the current schema
    logger.info({ userId }, 'User logged out');

    logger.info({ userId }, 'User logged out');
  },

  /**
   * Always the same answer, straight away: neither the reply nor how long it took
   * says whether the address has an account. The reset token leaves the server
   * only inside the email - it used to come back in this response, which let
   * anyone who knew a staff email take the account over.
   */
  async forgotPassword(data: ForgotPasswordInput) {
    void this.sendPasswordReset(data.email).catch((err) => logger.error({ err }, 'Password reset email failed'));
    return { message: 'If the email exists, a reset link has been sent' };
  },

  /** Email a one-hour, single-use reset link to the row sign-in checks. */
  async sendPasswordReset(email: string): Promise<boolean> {
    const rows = await prisma.user.findMany({
      where: { email },
      include: { tenant: { select: { slug: true, isActive: true } } },
    });
    // Login prefers the platform row (hospital copies carry random hashes), so a
    // reset of any other row would change a password nobody signs in with.
    const user = rows.find((u) => u.tenant?.slug === '__platform__') ?? rows[0];
    if (!user || !user.isActive || !user.tenant?.isActive || isPlaceholderAccountEmail(user.email)) return false;

    const token = crypto.randomBytes(32).toString('hex');
    const passwordResetToken = hashResetToken(token);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken, passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000) },
    });

    // In the fragment, so the token reaches no server log, proxy or Referer.
    const base = env.FRONTEND_URL.split(',')[0]!.trim().replace(/\/+$/, '');
    const sent = await sendPasswordResetEmail(user.email, escapeHtml(user.firstName ?? ''), `${base}/reset-password#token=${token}`);
    if (!sent) {
      // Nobody received it, so it must not stay usable.
      await prisma.user.updateMany({
        where: { id: user.id, passwordResetToken },
        data: { passwordResetToken: null, passwordResetExpires: null },
      });
      logger.warn({ userId: user.id }, 'Password reset link could not be emailed; the token was discarded');
      return false;
    }
    logger.info({ userId: user.id }, 'Password reset link emailed');
    return true;
  },

  async resetPassword(data: ResetPasswordInput) {
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashResetToken(data.token),
        passwordResetExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw AppError.badRequest('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, env.BCRYPT_SALT_ROUNDS);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    // Invalidate any existing refresh tokens. A hospital session runs as the
    // hospital copy of the user, so every row with this email is signed out.
    const copies = await prisma.user.findMany({ where: { email: user.email }, select: { id: true } });
    const ids = new Set([user.id, ...copies.map((u) => u.id)]);
    for (const id of ids) await redis.del(`${REDIS_PREFIXES.REFRESH_TOKEN}${id}`);
    await revokeTrustedDevicesByEmail(user.email, 'password_changed');

    logger.info({ userId: user.id }, 'Password reset successful');
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      description: 'Password reset with an emailed link',
      newValues: { passwordReset: true },
    });

    return { message: 'Password has been reset successfully' };
  },

  /**
   * Gap 297: change the signed-in user's password, given the current one.
   *
   * A hospital session may be running as the hospital-tenant COPY of the user,
   * whose password hash is random — login always checks the platform user with
   * the same email. So the check and the update both go to the row login uses,
   * otherwise "current password is wrong" for a correct password, or a change
   * that the next sign-in ignores.
   *
   * A wrong current password is a 400, not a 401: a 401 makes the client treat
   * the session as expired and sign the user out.
   */
  async changePassword(userId: string, data: ChangePasswordInput, ctx?: AccountActionContext) {
    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, tenantId: true },
    });
    if (!me) throw AppError.notFound('User not found');

    const sameEmail = await prisma.user.findMany({
      where: { email: me.email },
      select: { id: true, passwordHash: true, tenant: { select: { slug: true } } },
    });
    const target =
      sameEmail.find((u) => u.tenant.slug === '__platform__') ??
      sameEmail.find((u) => u.id === me.id);
    if (!target) throw AppError.notFound('User not found');

    const ok = await bcrypt.compare(data.currentPassword, target.passwordHash);
    if (!ok) throw AppError.badRequest('Current password is wrong', 'WRONG_PASSWORD');

    const passwordHash = await bcrypt.hash(data.newPassword, env.BCRYPT_SALT_ROUNDS);
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash } });
    await revokeTrustedDevices([me.id, ...sameEmail.map((u) => u.id)], 'password_changed');

    logger.info({ userId, credentialUserId: target.id }, 'Password changed');
    await writeAudit({
      tenantId: auditTenant(ctx, me.tenantId),
      userId,
      action: 'update',
      entityType: 'user',
      entityId: target.id,
      description: 'Changed own password (My Account)',
      // Never the password or its hash — only that it changed.
      newValues: { passwordChanged: true },
    });
    return { message: 'Password changed' };
  },

  /**
   * The row that sign-in checks for this person. Login looks up the PLATFORM
   * user with the same email (hospital-tenant copies carry random hashes), so
   * the password and the 2FA flag/secret must be read from and written to that
   * row — enabling 2FA on a hospital copy would never be enforced at login.
   * Falls back to the signed-in row itself.
   */
  async resolveCredentialUser(userId: string) {
    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) throw AppError.notFound('User not found');
    const sameEmail = await prisma.user.findMany({
      where: { email: me.email },
      include: { tenant: { select: { slug: true } } },
    });
    const platform = (sameEmail ?? []).find((u) => u.tenant?.slug === '__platform__');
    return { me, target: platform ?? me };
  },

  /**
   * Start 2FA setup: issue a fresh secret. Refused once 2FA is on, so an
   * enabled secret can never be silently replaced — turn it off first (which
   * needs the password and a current code). Calling it again while setup is
   * still pending just issues a new secret.
   */
  async setup2FA(userId: string) {
    const { target } = await this.resolveCredentialUser(userId);

    if (target.is2faEnabled) {
      throw AppError.badRequest('Two-factor authentication is already enabled', '2FA_ALREADY_ENABLED');
    }

    const secret = authenticator.generateSecret();

    await prisma.user.update({
      where: { id: target.id },
      data: {
        twoFaSecret: secret,
      },
    });

    const otpauthUrl = authenticator.keyuri(target.email, 'HospitalERP', secret);

    logger.info({ userId, credentialUserId: target.id }, '2FA setup initiated');

    return {
      secret,
      otpauthUrl,
    };
  },

  async verify2FA(userId: string, data: Verify2FAInput, ctx?: AccountActionContext) {
    const { me, target } = await this.resolveCredentialUser(userId);

    if (target.is2faEnabled) {
      throw AppError.badRequest('Two-factor authentication is already enabled', '2FA_ALREADY_ENABLED');
    }

    if (!target.twoFaSecret) {
      throw AppError.badRequest('Two-factor authentication has not been set up');
    }

    const isValid = authenticator.verify({
      token: data.code,
      secret: target.twoFaSecret,
    });

    if (!isValid) {
      throw AppError.badRequest('Invalid verification code');
    }

    await prisma.user.update({
      where: { id: target.id },
      data: {
        is2faEnabled: true,
      },
    });

    logger.info({ userId, credentialUserId: target.id }, '2FA enabled successfully');
    await writeAudit({
      tenantId: auditTenant(ctx, me.tenantId),
      userId,
      action: 'update',
      entityType: 'user',
      entityId: target.id,
      description: 'Turned on two-factor sign-in (My Account)',
      oldValues: { is2faEnabled: false },
      newValues: { is2faEnabled: true },
    });

    return { message: 'Two-factor authentication has been enabled' };
  },

  /**
   * Turn 2FA off. Needs BOTH the current password and a valid current code, so
   * neither an unattended session nor a stolen password alone can strip the
   * second factor. A wrong password/code is a 400 (a 401 would sign them out).
   */
  async disable2FA(userId: string, data: Disable2FAInput, ctx?: AccountActionContext) {
    const { me, target } = await this.resolveCredentialUser(userId);

    if (!target.is2faEnabled || !target.twoFaSecret) {
      throw AppError.badRequest('Two-factor authentication is not turned on', '2FA_NOT_ENABLED');
    }

    const passwordOk = await bcrypt.compare(data.currentPassword, target.passwordHash);
    if (!passwordOk) throw AppError.badRequest('Current password is wrong', 'WRONG_PASSWORD');

    const codeOk = authenticator.verify({ token: data.code, secret: target.twoFaSecret });
    if (!codeOk) throw AppError.badRequest('Invalid two-factor code', 'INVALID_2FA_CODE');

    await prisma.user.update({
      where: { id: target.id },
      data: { is2faEnabled: false, twoFaSecret: null },
    });

    logger.info({ userId, credentialUserId: target.id }, '2FA disabled');
    await writeAudit({
      tenantId: auditTenant(ctx, me.tenantId),
      userId,
      action: 'update',
      entityType: 'user',
      entityId: target.id,
      description: 'Turned off two-factor sign-in (My Account)',
      oldValues: { is2faEnabled: true },
      newValues: { is2faEnabled: false },
    });

    return { message: 'Two-factor authentication has been turned off' };
  },

  /**
   * Refuse a number that already belongs to someone else. Wider than sign-in's
   * notion of an owner (patient-account.ts): another active account of ANY kind
   * whose phone matches (by last 10 digits), or a patient record linked to
   * another account. The person's own per-tenant copies (same email) do not count.
   */
  async assertPhoneAvailable(phone: string, myEmail: string) {
    const filter = phoneMatchFilter(phone);
    const otherUser = await prisma.user.findFirst({
      where: { phone: filter, isActive: true, NOT: { email: myEmail } },
      select: { id: true },
    });
    if (otherUser) {
      throw AppError.conflict('This phone number is already used by another account', 'PHONE_IN_USE');
    }
    const myIds = ((await prisma.user.findMany({ where: { email: myEmail }, select: { id: true } })) ?? []).map(
      (u) => u.id,
    );
    const linkedPatient = await prisma.patient.findFirst({
      where: { phone: filter, isActive: true, userId: { not: null, notIn: myIds } },
      select: { id: true },
    });
    if (linkedPatient) {
      throw AppError.conflict('This phone number is already used by another account', 'PHONE_IN_USE');
    }
  },

  /**
   * Gap 297: step 1 of changing your phone. Sends a random 6-digit code to the
   * NEW number when an SMS / WhatsApp provider is configured, else to the
   * account's registered email. Only an HMAC of the code is kept, for
   * {@link PHONE_CHANGE_TTL_SECONDS}. The code is never returned or logged; the
   * response says where it went (masked).
   */
  async requestPhoneChange(userId: string, data: RequestPhoneChangeInput) {
    const phone = parseIndianMobile(data.phone);
    if (!phone) throw AppError.badRequest('Enter a valid 10-digit Indian mobile number', 'INVALID_PHONE');

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, firstName: true },
    });
    if (!me) throw AppError.notFound('User not found');

    if (me.phone && phoneLast10(me.phone) === phoneLast10(phone)) {
      throw AppError.badRequest('This is already your phone number', 'SAME_PHONE');
    }
    await this.assertPhoneAvailable(phone, me.email);

    if (!canSendOtpToPhone(phone) && isPlaceholderAccountEmail(me.email)) {
      throw AppError.badRequest(
        'There is no email address on your account to send a code to. Ask your administrator to update your phone number.',
        'NO_DELIVERY_CHANNEL',
      );
    }

    const last4 = phone.slice(-4);
    const { channel, sentTo, expiresInSeconds } = await issueAndDeliverOtp({
      purpose: 'phone-change',
      subject: userId,
      // The new number is part of the hash: a code for one cannot confirm another.
      binding: phone,
      limitSubject: userId,
      ttlSeconds: PHONE_CHANGE_TTL_SECONDS,
      phone,
      email: {
        to: me.email,
        subject: 'Your code to change your phone number',
        html: (code, minutes) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <p>Hello ${escapeHtml(me.firstName || '')},</p>
          <p>Use this code to change the phone number on your account to one ending in <strong>${last4}</strong>:</p>
          <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${code}</p>
          <p>It expires in ${minutes} minutes. If you did not ask for this, ignore this email and change your password.</p>
        </div>`,
        text: (code, minutes) =>
          `Your code to change the phone number on your account (to one ending in ${last4}) is ${code}. It expires in ${minutes} minutes. If you did not ask for this, change your password.`,
      },
    });

    logger.info({ userId, channel }, 'Phone change code sent');
    return { channel, sentTo, expiresInSeconds };
  },

  /** Step 2: check the code, then change the phone and burn the code. */
  async verifyPhoneChange(userId: string, data: VerifyPhoneChangeInput, ctx?: AccountActionContext) {
    const phone = parseIndianMobile(data.phone);
    if (!phone) throw AppError.badRequest('Enter a valid 10-digit Indian mobile number', 'INVALID_PHONE');

    const challenge = await checkOtp({
      purpose: 'phone-change',
      subject: userId,
      binding: phone,
      code: data.code,
      ttlSeconds: PHONE_CHANGE_TTL_SECONDS,
      maxAttempts: PHONE_CHANGE_MAX_ATTEMPTS,
    });
    // Single use, whatever happens next.
    await consumeOtp(challenge);

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, tenantId: true },
    });
    if (!me) throw AppError.notFound('User not found');

    // Re-check: the number may have been taken while the code was in flight.
    await this.assertPhoneAvailable(phone, me.email);

    // Every per-tenant copy of this person (same email) carries the same phone.
    await prisma.user.updateMany({ where: { email: me.email }, data: { phone } });
    // A PIN set under the old number does not carry over to the new one.
    await revokeTrustedDevicesByEmail(me.email, 'phone_changed');

    logger.info({ userId }, 'Phone number changed');
    await writeAudit({
      tenantId: auditTenant(ctx, me.tenantId),
      userId,
      action: 'update',
      entityType: 'user',
      entityId: me.id,
      description: 'Changed own phone number with a one-time code (My Account)',
      oldValues: { phone: me.phone },
      newValues: { phone },
    });

    return { phone, message: 'Phone number updated' };
  },

  async registerAdmin(data: { email: string; password: string; firstName: string; lastName: string; phone?: string }) {
    // 1. Find platform tenant by slug '__platform__'
    const platformTenant = await prisma.tenant.findUnique({ where: { slug: '__platform__' } });
    if (!platformTenant) {
      throw AppError.internal('Platform tenant not found. Run seed first.');
    }

    // 2. Check email uniqueness within platform tenant
    const existingUser = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: platformTenant.id, email: data.email } },
    });
    if (existingUser) {
      throw AppError.conflict('Email already registered');
    }

    // 3. Hash password
    const passwordHash = await bcrypt.hash(data.password, env.BCRYPT_SALT_ROUNDS);

    // 4. Find admin role (hospital admin — self-registered)
    const adminRole = await prisma.role.findFirst({
      where: { tenantId: platformTenant.id, name: 'admin' },
    });
    if (!adminRole) {
      throw AppError.internal('Admin role not found. Run seed first.');
    }

    // 5. Create user
    const user = await prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: data.email,
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone || null,
        isActive: true,
        userRoles: {
          create: { roleId: adminRole.id },
        },
      },
    });

    logger.info({ userId: user.id, tenantId: platformTenant.id }, 'Admin registered via self-signup');

    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName };
  },

  async getOnboardingStatus(userId: string, tenantId: string) {
    // Check if user is on platform tenant
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.slug !== '__platform__') {
      return { status: 'has_hospitals' as const };
    }

    // Super admins are always fully onboarded — they don't need plans or hospitals
    const isSuperAdmin = await prisma.userRole.findFirst({
      where: { userId, role: { name: 'super_admin' } },
    });
    if (isSuperAdmin) {
      return { status: 'active' as const };
    }

    // Check if user has any paid subscription payments
    const paidPayment = await prisma.subscriptionPayment.findFirst({
      where: {
        userId,
        status: 'paid',
      },
      orderBy: { createdAt: 'desc' },
      include: {
        plan: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!paidPayment) {
      return { status: 'needs_plan' as const };
    }

    const plan = {
      id: paidPayment.plan.id,
      name: paidPayment.plan.name,
    };

    // User has paid — check if they own any real tenants (hospitals)
    const ownedTenants = await prisma.tenantOwner.findMany({
      where: { userId },
      include: { tenant: true },
    });

    const realTenants = ownedTenants.filter((to) => to.tenant.slug !== '__platform__' && to.tenant.isActive);

    if (realTenants.length === 0) {
      return { status: 'needs_hospital' as const, plan };
    }

    return {
      status: 'has_hospitals' as const,
      plan,
      tenants: realTenants.map((t) => ({ id: t.tenant.id, name: t.tenant.name, slug: t.tenant.slug })),
    };
  },

  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        tenantId: true,
        isActive: true,
        is2faEnabled: true,
        createdAt: true,
        updatedAt: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    // Transform to match frontend User type (role.slug, tenant)
    const primaryRole = user.userRoles[0]?.role;
    const roles = user.userRoles.map((ur) => ur.role.name);

    // 2FA lives on the row sign-in checks (the platform copy) — report that.
    let is2faEnabled = user.is2faEnabled;
    if (user.tenant && user.tenant.slug !== '__platform__') {
      const credential = await prisma.user.findFirst({
        where: { email: user.email, tenant: { slug: '__platform__' } },
        select: { is2faEnabled: true },
      });
      if (credential) is2faEnabled = credential.is2faEnabled;
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      tenantId: user.tenantId,
      isActive: user.isActive,
      is2faEnabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles,
      role: primaryRole
        ? { id: primaryRole.id, name: primaryRole.name, slug: primaryRole.name }
        : null,
      tenant: user.tenant,
    };
  },
};
































