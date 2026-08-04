import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authService } from '../../../../src/modules/auth/auth.service';
import { prisma } from '../../../../src/config/database';
import { redis } from '../../../../src/config/redis';
import { AppError } from '../../../../src/shared/appError';

// ─── Mock external libraries ───
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(),
    verify: vi.fn(),
  },
}));

vi.mock('otplib', () => ({
  authenticator: {
    generateSecret: vi.fn(),
    verify: vi.fn(),
    keyuri: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(),
}));

// Import mocked modules so we can control their return values
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { v4 as uuidv4 } from 'uuid';

// ─── Shared test fixtures ───

const mockTenant = {
  id: 'tenant-1',
  name: 'Test Hospital',
  slug: 'test-hospital',
  isActive: true,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const mockRole = {
  id: 'role-patient-1',
  name: 'patient',
  tenantId: 'tenant-1',
};

const mockUserRecord = {
  id: 'user-1',
  email: 'john@example.com',
  firstName: 'John',
  lastName: 'Doe',
  phone: '+1234567890',
  passwordHash: 'hashed-password-123',
  tenantId: 'tenant-1',
  isActive: true,
  is2faEnabled: false,
  twoFaSecret: null,
  passwordResetToken: null,
  passwordResetExpires: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

// login() resolves the user with prisma.user.findMany(): a person has one
// User row per tenant and login prefers the `__platform__` copy, because the
// hospital copies carry random password hashes. Mock findMany with an ARRAY
// here — findFirst is still correct for register / reset / 2FA / getMe.
// Staff variant for the login tests: patients sign in with phone OTP, so the
// service refuses an email login for a patient-role account.
const mockStaffUserWithRelations = {
  ...mockUserRecord,
  tenant: mockTenant,
  userRoles: [{ role: { id: 'role-doctor-1', name: 'doctor' } }],
};

const mockUserWithRelations = {
  ...mockUserRecord,
  tenant: mockTenant,
  userRoles: [
    {
      role: { id: 'role-patient-1', name: 'patient' },
    },
  ],
};

const mockCreatedUser = {
  id: 'user-1',
  email: 'john@example.com',
  firstName: 'John',
  lastName: 'Doe',
  phone: '+1234567890',
  tenantId: 'tenant-1',
  isActive: true,
  createdAt: new Date('2024-01-01'),
  userRoles: [
    {
      role: { id: 'role-patient-1', name: 'patient' },
    },
  ],
};

// ─── Tests ───

describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════
  // register
  // ═══════════════════════════════════════════
  describe('register', () => {
    const registerData = {
      email: 'john@example.com',
      password: 'StrongP@ss1',
      firstName: 'John',
      lastName: 'Doe',
      tenantSlug: 'test-hospital',
      phone: '+1234567890',
    };

    it('should register a new user successfully', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue(mockTenant as any);
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      vi.mocked(prisma.role.findFirst).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.user.create).mockResolvedValue(mockCreatedUser as any);

      const result = await authService.register(registerData);

      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { slug: 'test-hospital' },
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'john@example.com', tenantId: 'tenant-1' },
      });
      expect(bcrypt.hash).toHaveBeenCalledWith('StrongP@ss1', expect.any(Number));
      expect(prisma.role.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', name: 'patient' },
      });
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'john@example.com',
            passwordHash: 'hashed-password',
            firstName: 'John',
            lastName: 'Doe',
            phone: '+1234567890',
            tenantId: 'tenant-1',
            isActive: true,
            userRoles: {
              create: { roleId: 'role-patient-1' },
            },
          }),
        }),
      );
      expect(result).toEqual(mockCreatedUser);
    });

    it('should throw notFound if tenant does not exist', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);

      await expect(authService.register(registerData)).rejects.toThrow(AppError);
      await expect(authService.register(registerData)).rejects.toThrow('Tenant not found');

      // Verify we never tried to look up the user or create anything
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw badRequest if tenant is not active', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        ...mockTenant,
        isActive: false,
      } as any);

      await expect(authService.register(registerData)).rejects.toThrow(AppError);

      try {
        await authService.register(registerData);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('Tenant is not active');
      }

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw conflict if user already exists in tenant', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue(mockTenant as any);
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUserRecord as any);

      try {
        await authService.register(registerData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toBe(
          'User with this email already exists in this tenant',
        );
      }

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should assign default patient role if available', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue(mockTenant as any);
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      vi.mocked(prisma.role.findFirst).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.user.create).mockResolvedValue(mockCreatedUser as any);

      await authService.register(registerData);

      const createCall = vi.mocked(prisma.user.create).mock.calls[0][0];
      expect(createCall.data).toHaveProperty('userRoles');
      expect((createCall.data as any).userRoles).toEqual({
        create: { roleId: 'role-patient-1' },
      });
    });

    it('should create user without role assignment when default role is not found', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue(mockTenant as any);
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      vi.mocked(prisma.role.findFirst).mockResolvedValue(null); // no patient role
      vi.mocked(prisma.user.create).mockResolvedValue({
        ...mockCreatedUser,
        userRoles: [],
      } as any);

      await authService.register(registerData);

      const createCall = vi.mocked(prisma.user.create).mock.calls[0][0];
      expect(createCall.data).not.toHaveProperty('userRoles');
    });
  });

  // ═══════════════════════════════════════════
  // login
  // ═══════════════════════════════════════════
  describe('login', () => {
    const loginData = {
      email: 'john@example.com',
      password: 'StrongP@ss1',
    };

    it('should login successfully and return tokens + user', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockStaffUserWithRelations] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('access-token-123' as any)
        .mockReturnValueOnce('refresh-token-456' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);
      vi.mocked(prisma.loginAuditLog.create).mockResolvedValue({} as any);

      const result = await authService.login(loginData);

      // toMatchObject, not toEqual: the login payload is additive (it has since
      // gained onboardingStatus, phone, role…) and this test is about the
      // tokens and identity, not an exact snapshot of every field.
      expect(result).toMatchObject({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        user: {
          id: 'user-1',
          email: 'john@example.com',
          firstName: 'John',
          lastName: 'Doe',
          tenantId: 'tenant-1',
          roles: ['doctor'],
        },
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
        include: {
          tenant: true,
          userRoles: {
            include: {
              role: { select: { id: true, name: true } },
            },
          },
        },
      });
      expect(bcrypt.compare).toHaveBeenCalledWith('StrongP@ss1', 'hashed-password-123');
    });

    it('should throw unauthorized for non-existent user', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([] as any);

      try {
        await authService.login(loginData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe('Invalid credentials');
      }

      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('should throw unauthorized for inactive tenant', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([{
        ...mockStaffUserWithRelations,
        tenant: { ...mockTenant, isActive: false },
      }] as any);

      try {
        await authService.login(loginData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe('Tenant is not active');
      }
    });

    it('should throw unauthorized for inactive user', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([{
        ...mockStaffUserWithRelations,
        isActive: false,
      }] as any);

      try {
        await authService.login(loginData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe('Account is deactivated');
      }
    });

    it('should throw unauthorized for wrong password', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockStaffUserWithRelations] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      try {
        await authService.login(loginData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe('Invalid credentials');
      }

      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('should require 2FA code when 2FA is enabled and no code provided', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([{
        ...mockStaffUserWithRelations,
        is2faEnabled: true,
        twoFaSecret: 'totp-secret-abc',
      }] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      try {
        await authService.login(loginData); // no twoFactorCode
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Two-factor authentication code is required',
        );
        expect((err as AppError).code).toBe('2FA_REQUIRED');
      }
    });

    it('should throw unauthorized for invalid 2FA code', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([{
        ...mockStaffUserWithRelations,
        is2faEnabled: true,
        twoFaSecret: 'totp-secret-abc',
      }] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(authenticator.verify).mockReturnValue(false);

      try {
        await authService.login({
          ...loginData,
          twoFactorCode: '999999',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe(
          'Invalid two-factor authentication code',
        );
      }

      expect(authenticator.verify).toHaveBeenCalledWith({
        token: '999999',
        secret: 'totp-secret-abc',
      });
    });

    it('should login successfully with valid 2FA code', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([{
        ...mockStaffUserWithRelations,
        is2faEnabled: true,
        twoFaSecret: 'totp-secret-abc',
      }] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(authenticator.verify).mockReturnValue(true);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('access-token-2fa' as any)
        .mockReturnValueOnce('refresh-token-2fa' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);
      vi.mocked(prisma.loginAuditLog.create).mockResolvedValue({} as any);

      const result = await authService.login({
        ...loginData,
        twoFactorCode: '123456',
      });

      expect(authenticator.verify).toHaveBeenCalledWith({
        token: '123456',
        secret: 'totp-secret-abc',
      });
      expect(result.accessToken).toBe('access-token-2fa');
      expect(result.refreshToken).toBe('refresh-token-2fa');
    });

    it('should store refresh token in Redis with correct key and TTL', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockStaffUserWithRelations] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('access-token' as any)
        .mockReturnValueOnce('refresh-token' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);
      vi.mocked(prisma.loginAuditLog.create).mockResolvedValue({} as any);

      await authService.login(loginData);

      expect(redis.set).toHaveBeenCalledWith(
        'rt:user-1',
        'refresh-token',
        'EX',
        expect.any(Number),
      );
    });

    it('should create login audit log entry', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockStaffUserWithRelations] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('at' as any)
        .mockReturnValueOnce('rt' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);
      vi.mocked(prisma.loginAuditLog.create).mockResolvedValue({} as any);

      await authService.login(loginData);

      expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          tenantId: 'tenant-1',
          status: 'success',
        }),
      });
    });

    it('should generate tokens with correct payload', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockStaffUserWithRelations] as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('at' as any)
        .mockReturnValueOnce('rt' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);
      vi.mocked(prisma.loginAuditLog.create).mockResolvedValue({} as any);

      await authService.login(loginData);

      const expectedPayload = {
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: 'john@example.com',
        roles: ['doctor'],
      };

      // First call = access token
      expect(jwt.sign).toHaveBeenNthCalledWith(
        1,
        expectedPayload,
        expect.any(String),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
      // Second call = refresh token
      expect(jwt.sign).toHaveBeenNthCalledWith(
        2,
        expectedPayload,
        expect.any(String),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });
  });

  // ═══════════════════════════════════════════
  // refreshToken
  // ═══════════════════════════════════════════
  describe('refreshToken', () => {
    const tokenPayload = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      email: 'john@example.com',
      roles: ['patient'],
    };

    it('should refresh tokens successfully', async () => {
      vi.mocked(jwt.verify).mockReturnValue(tokenPayload as any);
      vi.mocked(redis.get).mockResolvedValue('old-refresh-token' as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        userRoles: [{ role: { id: 'role-patient-1', name: 'patient' } }],
      } as any);
      vi.mocked(jwt.sign)
        .mockReturnValueOnce('new-access-token' as any)
        .mockReturnValueOnce('new-refresh-token' as any);
      vi.mocked(redis.set).mockResolvedValue('OK' as any);

      const result = await authService.refreshToken('old-refresh-token');

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      expect(jwt.verify).toHaveBeenCalledWith('old-refresh-token', expect.any(String));
      expect(redis.get).toHaveBeenCalledWith('rt:user-1');
      // Ensure rotation: new token stored
      expect(redis.set).toHaveBeenCalledWith(
        'rt:user-1',
        'new-refresh-token',
        'EX',
        expect.any(Number),
      );
    });

    it('should throw unauthorized for invalid refresh token (JWT verification fails)', async () => {
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new Error('jwt expired');
      });

      try {
        await authService.refreshToken('expired-token');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toBe('Invalid refresh token');
      }

      // Should not attempt Redis lookup if JWT is invalid
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('should throw unauthorized if Redis token does not match (reuse detection)', async () => {
      vi.mocked(jwt.verify).mockReturnValue(tokenPayload as any);
      vi.mocked(redis.get).mockResolvedValue('different-stored-token' as any);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      try {
        await authService.refreshToken('reused-old-token');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toContain('reuse detected');
      }

      // Should delete all tokens for this user as a precaution
      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });

    it('should throw unauthorized if stored Redis token is null', async () => {
      vi.mocked(jwt.verify).mockReturnValue(tokenPayload as any);
      vi.mocked(redis.get).mockResolvedValue(null as any);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      try {
        await authService.refreshToken('some-token');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }

      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });

    it('should throw unauthorized if user is deactivated', async () => {
      vi.mocked(jwt.verify).mockReturnValue(tokenPayload as any);
      vi.mocked(redis.get).mockResolvedValue('valid-refresh-token' as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        isActive: false,
        userRoles: [],
      } as any);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      try {
        await authService.refreshToken('valid-refresh-token');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toContain('deactivated');
      }

      // Should clean up the Redis token
      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });

    it('should throw unauthorized if user no longer exists', async () => {
      vi.mocked(jwt.verify).mockReturnValue(tokenPayload as any);
      vi.mocked(redis.get).mockResolvedValue('valid-refresh-token' as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      try {
        await authService.refreshToken('valid-refresh-token');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }

      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });
  });

  // ═══════════════════════════════════════════
  // logout
  // ═══════════════════════════════════════════
  describe('logout', () => {
    it('should delete refresh token from Redis', async () => {
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      await authService.logout('user-1');

      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });

    it('should not throw even if no token existed in Redis', async () => {
      vi.mocked(redis.del).mockResolvedValue(0 as any);

      await expect(authService.logout('user-1')).resolves.toBeUndefined();

      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });
  });

  // ═══════════════════════════════════════════
  // forgotPassword
  // ═══════════════════════════════════════════
  describe('forgotPassword', () => {
    it('should return generic message regardless of user existence (user not found)', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      const result = await authService.forgotPassword({ email: 'nobody@example.com' });

      expect(result.message).toBe('If the email exists, a reset link has been sent');
      // Should NOT attempt to update any user
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should generate and store reset token for existing user', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUserRecord as any);
      vi.mocked(uuidv4).mockReturnValue('uuid-reset-token-1234');
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      const result = await authService.forgotPassword({ email: 'john@example.com' });

      expect(result.message).toBe('If the email exists, a reset link has been sent');
      expect(result.resetToken).toBe('uuid-reset-token-1234');
      expect(uuidv4).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          passwordResetToken: 'uuid-reset-token-1234',
          passwordResetExpires: expect.any(Date),
        },
      });

      // Verify the expiry is roughly 1 hour from now
      const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
      const expiry = (updateCall.data as any).passwordResetExpires as Date;
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      // Allow 5 seconds tolerance
      expect(expiry.getTime()).toBeGreaterThan(oneHourFromNow - 5000);
      expect(expiry.getTime()).toBeLessThanOrEqual(oneHourFromNow + 5000);
    });
  });

  // ═══════════════════════════════════════════
  // resetPassword
  // ═══════════════════════════════════════════
  describe('resetPassword', () => {
    const resetData = {
      token: 'valid-reset-token',
      newPassword: 'NewStr0ng@Pass',
    };

    it('should reset password successfully', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        ...mockUserRecord,
        passwordResetToken: 'valid-reset-token',
        passwordResetExpires: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      } as any);
      vi.mocked(bcrypt.hash).mockResolvedValue('new-hashed-password' as never);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      const result = await authService.resetPassword(resetData);

      expect(result.message).toBe('Password has been reset successfully');

      // Check user lookup uses token and expiry check
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          passwordResetToken: 'valid-reset-token',
          passwordResetExpires: { gt: expect.any(Date) },
        },
      });

      // Check password was hashed and reset fields cleared
      expect(bcrypt.hash).toHaveBeenCalledWith('NewStr0ng@Pass', expect.any(Number));
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          passwordHash: 'new-hashed-password',
          passwordResetToken: null,
          passwordResetExpires: null,
        },
      });
    });

    it('should throw badRequest for invalid/expired token', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      try {
        await authService.resetPassword(resetData);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('Invalid or expired reset token');
      }

      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should invalidate refresh tokens after password reset', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        ...mockUserRecord,
        passwordResetToken: 'valid-reset-token',
        passwordResetExpires: new Date(Date.now() + 30 * 60 * 1000),
      } as any);
      vi.mocked(bcrypt.hash).mockResolvedValue('new-hash' as never);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(redis.del).mockResolvedValue(1 as any);

      await authService.resetPassword(resetData);

      expect(redis.del).toHaveBeenCalledWith('rt:user-1');
    });
  });

  // ═══════════════════════════════════════════
  // setup2FA
  // ═══════════════════════════════════════════
  describe('setup2FA', () => {
    it('should generate 2FA secret and return otpauth URL', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        is2faEnabled: false,
      } as any);
      vi.mocked(authenticator.generateSecret).mockReturnValue('TOTP_SECRET_BASE32');
      vi.mocked(authenticator.keyuri).mockReturnValue(
        'otpauth://totp/HospitalERP:john%40example.com?secret=TOTP_SECRET_BASE32&issuer=HospitalERP',
      );
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      const result = await authService.setup2FA('user-1');

      expect(result).toEqual({
        secret: 'TOTP_SECRET_BASE32',
        otpauthUrl:
          'otpauth://totp/HospitalERP:john%40example.com?secret=TOTP_SECRET_BASE32&issuer=HospitalERP',
      });

      expect(authenticator.generateSecret).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { twoFaSecret: 'TOTP_SECRET_BASE32' },
      });
      expect(authenticator.keyuri).toHaveBeenCalledWith(
        'john@example.com',
        'HospitalERP',
        'TOTP_SECRET_BASE32',
      );
    });

    it('should throw notFound if user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      try {
        await authService.setup2FA('nonexistent-user');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
        expect((err as AppError).message).toBe('User not found');
      }

      expect(authenticator.generateSecret).not.toHaveBeenCalled();
    });

    it('should throw badRequest if 2FA is already enabled', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        is2faEnabled: true,
        twoFaSecret: 'existing-secret',
      } as any);

      try {
        await authService.setup2FA('user-1');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Two-factor authentication is already enabled',
        );
      }

      expect(authenticator.generateSecret).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // verify2FA
  // ═══════════════════════════════════════════
  describe('verify2FA', () => {
    it('should enable 2FA on valid code', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        twoFaSecret: 'TOTP_SECRET',
        is2faEnabled: false,
      } as any);
      vi.mocked(authenticator.verify).mockReturnValue(true);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      const result = await authService.verify2FA('user-1', { code: '123456' });

      expect(result.message).toBe('Two-factor authentication has been enabled');
      expect(authenticator.verify).toHaveBeenCalledWith({
        token: '123456',
        secret: 'TOTP_SECRET',
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { is2faEnabled: true },
      });
    });

    it('should throw badRequest on invalid code', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        twoFaSecret: 'TOTP_SECRET',
        is2faEnabled: false,
      } as any);
      vi.mocked(authenticator.verify).mockReturnValue(false);

      try {
        await authService.verify2FA('user-1', { code: '000000' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe('Invalid verification code');
      }

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should throw notFound if user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      try {
        await authService.verify2FA('nonexistent', { code: '123456' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
        expect((err as AppError).message).toBe('User not found');
      }
    });

    it('should throw badRequest if 2FA has not been set up', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserRecord,
        twoFaSecret: null,
        is2faEnabled: false,
      } as any);

      try {
        await authService.verify2FA('user-1', { code: '123456' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toBe(
          'Two-factor authentication has not been set up',
        );
      }
    });
  });

  // ═══════════════════════════════════════════
  // getMe
  // ═══════════════════════════════════════════
  describe('getMe', () => {
    it('should return user profile with roles', async () => {
      const fullProfile = {
        id: 'user-1',
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
        phone: '+1234567890',
        tenantId: 'tenant-1',
        isActive: true,
        is2faEnabled: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        userRoles: [
          { role: { id: 'role-patient-1', name: 'patient' } },
          { role: { id: 'role-admin-1', name: 'admin' } },
        ],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(fullProfile as any);

      const result = await authService.getMe('user-1');

      // getMe returns a SHAPED profile, not the raw row: it drops tenantId /
      // updatedAt / userRoles and flattens the role. Assert the fields the
      // caller actually relies on rather than snapshotting the DB record.
      expect(result).toMatchObject({
        id: fullProfile.id,
        email: fullProfile.email,
        firstName: fullProfile.firstName,
        lastName: fullProfile.lastName,
        isActive: fullProfile.isActive,
      });
      // Assert WHICH user is fetched, not the exact select-list — the profile
      // projection grows as fields are added and pinning it here just makes the
      // test fail on every additive change.
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' } }),
      );
    });

    it('should throw notFound if user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      try {
        await authService.getMe('nonexistent-user');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
        expect((err as AppError).message).toBe('User not found');
      }
    });
  });
});
