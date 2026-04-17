import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../config/database';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { REDIS_PREFIXES } from '../../shared/constants';
import { recordFailedLogin, clearLoginFailures } from '../../middleware/rateLimiter';
import type {
  RegisterInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  Verify2FAInput,
} from './auth.validation';

interface TokenPayload {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
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
      // Register under a specific hospital tenant
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

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
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
      select: {
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
      },
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

    const roles = user.userRoles.map((ur) => ur.role.name);

    const tokenPayload: TokenPayload = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles,
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

    logger.info({ userId: user.id, tenantId: user.tenantId }, 'User logged in');

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

    // Preserve the tenantId from the original token (not the DB user record).
    // After switchHospital the JWT carries the hospital tenantId, but the user
    // record in the DB still points to the platform tenant.  Using payload.tenantId
    // keeps the admin's hospital context alive across refreshes.
    const newPayload: TokenPayload = {
      userId: user.id,
      tenantId: payload.tenantId,
      email: user.email,
      roles,
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

  async forgotPassword(data: ForgotPasswordInput) {
    const user = await prisma.user.findFirst({
      where: {
        email: data.email,
      },
    });

    if (!user) {
      // Don't reveal whether user exists
      return { message: 'If the email exists, a reset link has been sent' };
    }

    const resetToken = uuidv4();
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetToken,
        passwordResetExpires: resetTokenExpiry,
      },
    });

    logger.info({ userId: user.id }, 'Password reset token generated');

    // In production, send email with reset link
    // For now, return the token (would be sent via email service)
    return {
      message: 'If the email exists, a reset link has been sent',
      resetToken, // Remove in production; use email service instead
    };
  },

  async resetPassword(data: ResetPasswordInput) {
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: data.token,
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

    // Invalidate any existing refresh tokens
    const redisKey = `${REDIS_PREFIXES.REFRESH_TOKEN}${user.id}`;
    await redis.del(redisKey);

    logger.info({ userId: user.id }, 'Password reset successful');

    return { message: 'Password has been reset successfully' };
  },

  async setup2FA(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (user.is2faEnabled) {
      throw AppError.badRequest('Two-factor authentication is already enabled');
    }

    const secret = authenticator.generateSecret();

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFaSecret: secret,
      },
    });

    const otpauthUrl = authenticator.keyuri(user.email, 'HospitalERP', secret);

    logger.info({ userId }, '2FA setup initiated');

    return {
      secret,
      otpauthUrl,
    };
  },

  async verify2FA(userId: string, data: Verify2FAInput) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (!user.twoFaSecret) {
      throw AppError.badRequest('Two-factor authentication has not been set up');
    }

    const isValid = authenticator.verify({
      token: data.code,
      secret: user.twoFaSecret,
    });

    if (!isValid) {
      throw AppError.badRequest('Invalid verification code');
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        is2faEnabled: true,
      },
    });

    logger.info({ userId }, '2FA enabled successfully');

    return { message: 'Two-factor authentication has been enabled' };
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

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      tenantId: user.tenantId,
      isActive: user.isActive,
      is2faEnabled: user.is2faEnabled,
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
