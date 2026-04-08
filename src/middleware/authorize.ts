import { Response, NextFunction } from 'express';
import { AppError } from '../shared/appError';
import { AuthenticatedRequest } from '../shared/types';
import { prisma } from '../config/database';
import { getEffectiveSubscription, getEffectiveSubscriptionByTenantId } from '../shared/subscription-utils';

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
 * Check if the tenant has a feature enabled (via FeatureToggle table).
 * Super admins bypass this check. If no toggle row exists, the feature
 * is assumed to be enabled (backwards compatibility).
 */
export function requireFeature(featureKey: string) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized());
    }

    // Super admin bypasses feature checks
    if (req.user.roles.includes('super_admin')) {
      return next();
    }

    try {
      const toggle = await prisma.featureToggle.findUnique({
        where: {
          tenantId_featureKey: {
            tenantId: req.user.tenantId,
            featureKey,
          },
        },
      });

      // If no toggle exists, allow access (not yet configured)
      if (toggle && !toggle.isEnabled) {
        return next(
          AppError.forbidden(
            `The "${featureKey}" module is not included in your subscription plan. Please upgrade your plan to access this feature.`,
          ),
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check if user has a specific permission (module:action).
 *
 * For platform admin/super_admin users operating on a hospital tenant
 * (via X-Tenant-Id header), we check if the hospital's matching role
 * (e.g. "admin") has the required permission, since the user's
 * userRole is linked to the platform role, not the hospital's role.
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
      // First: try direct check (user's own roles on the current tenant)
      const directPermission = await prisma.rolePermission.findFirst({
        where: {
          role: {
            userRoles: { some: { userId: req.user.userId } },
            tenantId: req.user.tenantId,
          },
          permission: { module, action },
        },
      });

      if (directPermission) {
        return next();
      }

      // Second: for platform admins operating on a hospital tenant,
      // check if the hospital's role (matching the user's role name)
      // has the required permission.
      const roleNames = req.user.roles; // e.g. ['admin']
      const roleNamePermission = await prisma.rolePermission.findFirst({
        where: {
          role: {
            name: { in: roleNames },
            tenantId: req.user.tenantId,
          },
          permission: { module, action },
        },
      });

      if (roleNamePermission) {
        return next();
      }

      return next(AppError.forbidden(`Missing permission: ${module}:${action}`));
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check if the user has an active subscription.
 *
 * Subscriptions are owned by admins (hospital owners), not by staff.
 * Resolution order:
 *   1. Check if the current user owns a subscription (admin flow).
 *   2. If not, resolve via the tenant owner (staff flow — doctors,
 *      nurses, etc. work under the admin's subscription).
 *
 * Super admins and platform-tenant users bypass this check.
 * Returns 403 with code SUBSCRIPTION_EXPIRED if no valid subscription.
 */
export function requireActiveSubscription() {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());

    // Super admin bypasses
    if (req.user.roles.includes('super_admin')) return next();

    // Platform tenant users (admins not yet in a hospital) bypass
    const platformTenant = await prisma.tenant.findFirst({ where: { slug: '__platform__' } });
    if (platformTenant && req.user.tenantId === platformTenant.id) return next();

    try {
      // 1. Try user-level subscription (admin who purchased)
      let sub = await getEffectiveSubscription(req.user.userId);

      // 2. Fall back to tenant owner's subscription (staff users)
      if (!sub) {
        sub = await getEffectiveSubscriptionByTenantId(req.user.tenantId);
      }

      if (!sub) {
        return next(AppError.forbidden('SUBSCRIPTION_EXPIRED'));
      }

      // Auto-expire if past endDate
      if (sub.endDate && new Date(sub.endDate) < new Date()) {
        await prisma.userSubscription.update({
          where: { id: sub.id },
          data: { status: 'expired' },
        });
        return next(AppError.forbidden('SUBSCRIPTION_EXPIRED'));
      }

      if (sub.status !== 'active') {
        return next(AppError.forbidden('SUBSCRIPTION_EXPIRED'));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
