import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireRoles, requirePermission } from '../../../src/middleware/authorize';
import { mockRequest, mockResponse, mockNext, testUser } from '../../helpers';
import { AppError } from '../../../src/shared/appError';
import { prisma } from '../../../src/config/database';

describe('authorize middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── requireRoles ───────────────────────────────────────────────

  describe('requireRoles', () => {
    it('should call next with unauthorized error when no user on request', () => {
      const req = mockRequest(); // no user set
      const res = mockResponse();
      const next = mockNext();

      const middleware = requireRoles('admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(401);
    });

    it('should call next with forbidden error when user has no matching role', () => {
      const req = mockRequest({ user: testUser({ roles: ['nurse'] }) });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requireRoles('admin', 'doctor');
      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Insufficient role');
    });

    it('should call next() when user has a matching role', () => {
      const req = mockRequest({ user: testUser({ roles: ['admin'] }) });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requireRoles('admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should work with multiple allowed roles (user matches one of them)', () => {
      const req = mockRequest({ user: testUser({ roles: ['doctor'] }) });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requireRoles('admin', 'doctor', 'super_admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should work when user has multiple roles and one matches', () => {
      const req = mockRequest({ user: testUser({ roles: ['nurse', 'receptionist', 'admin'] }) });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requireRoles('admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  // ─── requirePermission ──────────────────────────────────────────

  describe('requirePermission', () => {
    it('should call next with unauthorized error when no user on request', async () => {
      const req = mockRequest(); // no user
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('patients', 'read');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(401);
    });

    it('should bypass permission check for super_admin role', async () => {
      const req = mockRequest({
        user: testUser({ roles: ['super_admin'] }),
      });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('patients', 'delete');
      await middleware(req, res, next);

      // prisma should never be called for super_admin
      expect(prisma.rolePermission.findFirst).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith();
    });

    it('should call next with forbidden error when permission is not found', async () => {
      vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue(null);

      const req = mockRequest({
        user: testUser({ roles: ['nurse'] }),
      });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('patients', 'delete');
      await middleware(req, res, next);

      expect(prisma.rolePermission.findFirst).toHaveBeenCalledWith({
        where: {
          role: {
            userRoles: { some: { userId: 'user-1' } },
            tenantId: 'tenant-1',
          },
          permission: { module: 'patients', action: 'delete' },
        },
      });
      expect(next).toHaveBeenCalledOnce();
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Missing permission: patients:delete');
    });

    it('should call next() when permission exists', async () => {
      vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue({
        id: 'rp-1',
        roleId: 'role-1',
        permissionId: 'perm-1',
      } as any);

      const req = mockRequest({
        user: testUser({ roles: ['doctor'] }),
      });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('patients', 'read');
      await middleware(req, res, next);

      expect(prisma.rolePermission.findFirst).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
    });

    it('should handle database errors by passing them to next', async () => {
      const dbError = new Error('Connection refused');
      vi.mocked(prisma.rolePermission.findFirst).mockRejectedValue(dbError);

      const req = mockRequest({
        user: testUser({ roles: ['doctor'] }),
      });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('patients', 'read');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(dbError);
    });

    it('should not bypass permission check when user has super_admin alongside other roles', async () => {
      // super_admin should still bypass even if user has other roles
      const req = mockRequest({
        user: testUser({ roles: ['doctor', 'super_admin'] }),
      });
      const res = mockResponse();
      const next = mockNext();

      const middleware = requirePermission('billing', 'write');
      await middleware(req, res, next);

      expect(prisma.rolePermission.findFirst).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith();
    });
  });
});
