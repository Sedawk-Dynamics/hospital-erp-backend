import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../shared/appError';
import { AuthenticatedRequest, AuthenticatedUser } from '../shared/types';
import { prisma } from '../config/database';

export async function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  // Skip if already authenticated (e.g. router-level + route-level)
  if (req.user) return next();

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(AppError.unauthorized('No token provided'));
  }

  const token = authHeader.split(' ')[1];

  // 1. Verify JWT — synchronous, must fail fast on invalid token
  let payload: AuthenticatedUser;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AuthenticatedUser;
  } catch {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  req.user = {
    userId: payload.userId,
    tenantId: payload.tenantId,
    email: payload.email,
    roles: payload.roles,
  };

  // 2. Resolve tenant override (async) — non-blocking, errors are silently skipped
  //    so a DB hiccup doesn't break auth for every request.
  const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
  if (
    headerTenantId &&
    headerTenantId !== payload.tenantId &&
    payload.roles.some((r) => r === 'super_admin' || r === 'admin')
  ) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: headerTenantId },
        select: { id: true, isActive: true },
      });

      if (tenant && tenant.isActive) {
        req.user.tenantId = headerTenantId;
      }
    } catch {
      // Tenant resolution is best-effort; fall back to JWT tenantId
    }
  }

  next();
}
