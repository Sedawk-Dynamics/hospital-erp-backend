import { Response, NextFunction } from 'express';
import { AppError } from '../shared/appError';
import { AuthenticatedRequest } from '../shared/types';
import { prisma } from '../config/database';

/**
 * Check if user has one of the required roles
 */
export function requireRoles(...roles: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized());
    }

    const hasRole = req.user.roles.some((r) => roles.includes(r));
    if (!hasRole) {
      return next(AppError.forbidden('Insufficient role'));
    }
    next();
  };
}

/**
 * Check if user has a specific permission (module:action)
 */
export function requirePermission(module: string, action: string) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized());
    }

    // Super admin bypasses permission checks
    if (req.user.roles.includes('super_admin')) {
      return next();
    }

    try {
      const userPermission = await prisma.rolePermission.findFirst({
        where: {
          role: {
            userRoles: { some: { userId: req.user.userId } },
            tenantId: req.user.tenantId,
          },
          permission: { module, action },
        },
      });

      if (!userPermission) {
        return next(AppError.forbidden(`Missing permission: ${module}:${action}`));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
