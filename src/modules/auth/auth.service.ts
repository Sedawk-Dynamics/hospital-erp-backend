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
    const tenant = await prisma.tenant.findUnique({
      where: { slug: data.tenantSlug },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    if (!tenant.isActive) {
      throw AppError.badRequest('Tenant is not active');
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

    // Find the default role (patient) for this tenant
    const defaultRole = await prisma.role.findFirst({
      where: {
        tenantId: tenant.id,
        name: 'patient',
      },
    });

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
    // Find user by email directly (no tenant slug needed)
    const user = await prisma.user.findFirst({
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

    if (!user) {
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
      throw AppError.unauthorized('Invalid credentials');
    }

    // Check 2FA if enabled
    if (user.is2faEnabled) {
      if (!data.twoFactorCode) {
        throw AppError.badRequest('Two-factor authentication code is required', '2FA_REQUIRED');
      }

      const isValid = authenticator.verify({
        token: data.twoFactorCode,
        secret: user.twoFaSecret!,
      });

      if (!isValid) {
        throw AppError.unauthorized('Invalid two-factor authentication code');
      }
    }

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

    return {
      accessToken,
      refreshToken,
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

    const newPayload: TokenPayload = {
      userId: user.id,
      tenantId: user.tenantId,
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
