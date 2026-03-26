import jwt from 'jsonwebtoken';
import { prisma } from '../../config/database';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { REDIS_PREFIXES } from '../../shared/constants';
import { tenantsService } from '../tenants/tenants.service';
import type { CreateHospitalInput, UpdateHospitalInput } from './hospitals.validation';

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
  if (!match) return 7 * 24 * 60 * 60;
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

const DEFAULT_FEATURE_TOGGLES = [
  { featureKey: 'appointments', isEnabled: true, config: {} },
  { featureKey: 'lab', isEnabled: true, config: {} },
  { featureKey: 'pharmacy', isEnabled: true, config: {} },
  { featureKey: 'billing', isEnabled: true, config: {} },
  { featureKey: 'inventory', isEnabled: true, config: {} },
  { featureKey: 'blood_bank', isEnabled: false, config: {} },
  { featureKey: 'imaging', isEnabled: false, config: {} },
  { featureKey: 'insurance', isEnabled: false, config: {} },
  { featureKey: 'hr', isEnabled: false, config: {} },
  { featureKey: 'compliance', isEnabled: false, config: {} },
];

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const hospitalsService = {
  async createHospital(userId: string, data: CreateHospitalInput) {
    // ── Hospital limit enforcement ──
    // Resolve all user IDs sharing the same email (platform + hospital users)
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const allUserIds = callerUser
      ? (await prisma.user.findMany({
          where: { email: callerUser.email },
          select: { id: true },
        })).map((u) => u.id)
      : [userId];

    // Super admins bypass the limit check
    const isSuperAdmin = await prisma.userRole.findFirst({
      where: { userId: { in: allUserIds }, role: { name: 'super_admin' } },
    });

    if (!isSuperAdmin) {
      const currentCount = await prisma.tenantOwner.count({
        where: { userId: { in: allUserIds }, tenant: { slug: { not: '__platform__' } } },
      });

      // Find user's active subscription plan (subscriptions are user-owned)
      const activeSub = await prisma.userSubscription.findFirst({
        where: {
          userId: { in: allUserIds },
          status: 'active',
        },
        include: { plan: { select: { maxHospitals: true } } },
        orderBy: { createdAt: 'desc' },
      });

      const maxHospitals = activeSub?.plan?.maxHospitals ?? null;

      if (maxHospitals !== null && currentCount >= maxHospitals) {
        throw AppError.forbidden(
          `Hospital limit reached. Your plan allows up to ${maxHospitals} hospital${maxHospitals === 1 ? '' : 's'}. Please upgrade your plan.`,
        );
      }
    }

    const slug = data.slug || generateSlug(data.name);

    if (!slug || slug.length < 2) {
      throw AppError.badRequest('Could not generate a valid slug from the hospital name');
    }

    // Check slug uniqueness
    const existing = await prisma.tenant.findUnique({
      where: { slug },
    });

    if (existing) {
      throw AppError.conflict('A hospital with this slug already exists');
    }

    // Create tenant + owner + feature toggles in a transaction
    const tenant = await prisma.$transaction(async (tx) => {
      // 1. Create tenant
      // Generate unique 6-char hospital code
      let hospitalCode: string | undefined;
      const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let attempt = 0; attempt < 10; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) code += codeChars[Math.floor(Math.random() * codeChars.length)];
        const exists = await tx.tenant.findUnique({ where: { hospitalCode: code } });
        if (!exists) { hospitalCode = code; break; }
      }

      const newTenant = await tx.tenant.create({
        data: {
          name: data.name,
          slug,
          hospitalCode,
          address: data.address,
          city: data.city,
          state: data.state,
          country: data.country,
          phone: data.phone,
          email: data.email,
          isActive: true,
          onboardedAt: new Date(),
          featureToggles: {
            create: DEFAULT_FEATURE_TOGGLES,
          },
        },
        include: {
          featureToggles: true,
        },
      });

      // 2. Create TenantOwner linking userId to new tenant
      await tx.tenantOwner.create({
        data: {
          userId,
          tenantId: newTenant.id,
        },
      });

      return newTenant;
    });

    // 3. Bootstrap 18 system roles for this tenant (outside transaction for performance)
    await tenantsService.bootstrapRolesAndPermissions(tenant.id);

    // 4. Sync plan features to the new hospital (subscription is user-owned)
    try {
      const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
      const userSub = await getEffectiveSubscription(userId);

      if (userSub?.plan?.features && typeof userSub.plan.features === 'object') {
        const planFeatures = userSub.plan.features as Record<string, boolean>;
        for (const [featureKey, isEnabled] of Object.entries(planFeatures)) {
          await prisma.featureToggle.upsert({
            where: {
              tenantId_featureKey: { tenantId: tenant.id, featureKey },
            },
            update: { isEnabled },
            create: { tenantId: tenant.id, featureKey, isEnabled, config: {} },
          });
        }

        logger.info(
          { tenantId: tenant.id, planId: userSub.planId },
          'Synced plan features to new hospital from owner subscription',
        );
      }
    } catch (err) {
      logger.error({ err, tenantId: tenant.id, userId }, 'Failed to sync plan features to new hospital');
    }

    logger.info(
      { tenantId: tenant.id, slug: tenant.slug, ownerId: userId },
      'Hospital created by platform admin',
    );

    return tenant;
  },

  async listMyHospitals(userId: string) {
    // The caller may be logged in as a hospital-scoped user (after switchHospital).
    // TenantOwner links the *platform* user to hospitals they own.
    // Look up all user records sharing the same email to find ownership records.
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!callerUser) return [];

    const allUserIds = await prisma.user.findMany({
      where: { email: callerUser.email },
      select: { id: true },
    });

    // Find the owner's subscription (user-owned, shared across all hospitals)
    const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
    const ownerSub = await getEffectiveSubscription(userId);

    const ownerships = await prisma.tenantOwner.findMany({
      where: { userId: { in: allUserIds.map((u) => u.id) } },
      include: {
        tenant: {
          include: {
            _count: {
              select: { users: true },
            },
          },
        },
      },
    });

    // Filter out __platform__ tenant and deduplicate by tenant ID
    const seen = new Set<string>();
    const hospitals = ownerships
      .filter((o) => {
        if (o.tenant.slug === '__platform__' || seen.has(o.tenant.id)) return false;
        seen.add(o.tenant.id);
        return true;
      })
      .map((o) => {
        const tenant = o.tenant as any;
        // Attach the owner's user subscription for frontend display
        tenant.userSubscription = ownerSub || null;
        return tenant;
      });

    return hospitals;
  },

  async getMyHospital(userId: string, tenantId: string) {
    // Resolve all user IDs sharing the same email (handles hospital-scoped JWT)
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const allUserIds = callerUser
      ? (await prisma.user.findMany({
          where: { email: callerUser.email },
          select: { id: true },
        })).map((u) => u.id)
      : [userId];

    // Verify ownership via any of the user's identities
    const ownership = await prisma.tenantOwner.findFirst({
      where: { userId: { in: allUserIds }, tenantId },
    });

    if (!ownership) {
      throw AppError.forbidden('You do not own this hospital');
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        featureToggles: true,
        _count: {
          select: { users: true },
        },
      },
    });

    if (!tenant) {
      throw AppError.notFound('Hospital not found');
    }

    // Attach the owner's user subscription
    const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
    const ownerSub = await getEffectiveSubscription(userId);
    (tenant as any).userSubscription = ownerSub || null;

    return tenant;
  },

  async switchHospital(userId: string, tenantId: string) {
    // 1. Resolve the platform user (may be called with a hospital-scoped userId)
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, isActive: true },
    });

    if (!callerUser) {
      throw AppError.notFound('User not found');
    }

    // Find all user IDs with the same email to check ownership across identities
    const allUserIds = (
      await prisma.user.findMany({
        where: { email: callerUser.email },
        select: { id: true },
      })
    ).map((u) => u.id);

    // Verify the caller owns this hospital via TenantOwner
    const ownership = await prisma.tenantOwner.findFirst({
      where: { userId: { in: allUserIds }, tenantId },
    });

    if (!ownership) {
      throw AppError.forbidden('You do not own this hospital');
    }

    // Check active subscription before allowing hospital access
    const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
    const sub = await getEffectiveSubscription(userId);
    if (!sub || sub.status !== 'active' || (sub.endDate && new Date(sub.endDate) < new Date())) {
      throw AppError.forbidden('SUBSCRIPTION_EXPIRED');
    }

    // 2. Load the target hospital tenant
    const targetTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!targetTenant) {
      throw AppError.notFound('Hospital not found');
    }

    if (!targetTenant.isActive) {
      throw AppError.unauthorized('Hospital is not active');
    }

    // 3. Resolve the platform user (the one in __platform__ tenant) — this is the single identity
    const platformUser = await prisma.user.findFirst({
      where: { email: callerUser.email, tenant: { slug: '__platform__' } },
      include: {
        userRoles: {
          include: { role: { select: { id: true, name: true } } },
        },
      },
    });

    const effectiveUser = platformUser || callerUser;

    // Collect roles from platform user + admin role for hospital context
    const platformRoles = platformUser?.userRoles.map((ur) => ur.role.name) ?? [];

    // Find the admin role in the target tenant to include it
    const adminRole = await prisma.role.findFirst({
      where: { tenantId, name: 'admin' },
      select: { id: true, name: true },
    });

    // Combine: platform roles + admin role for the hospital
    const roles = [...new Set([...platformRoles, ...(adminRole ? ['admin'] : [])])];

    // 4. Generate tokens with the platform user's ID but the hospital's tenantId
    const tokenPayload: TokenPayload = {
      userId: effectiveUser.id,
      tenantId,
      email: effectiveUser.email,
      roles,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // 5. Store refresh token in Redis (same key format as login so refresh works)
    const redisKey = `${REDIS_PREFIXES.REFRESH_TOKEN}${effectiveUser.id}`;
    const ttl = getRefreshTokenTTL();
    await redis.set(redisKey, refreshToken, 'EX', ttl);

    logger.info(
      { platformUserId: effectiveUser.id, tenantId },
      'Platform admin switched to hospital',
    );

    // 6. Return same shape as login response
    const primaryRole = adminRole || (platformUser?.userRoles[0]?.role ?? null);

    return {
      accessToken,
      refreshToken,
      user: {
        id: effectiveUser.id,
        email: effectiveUser.email,
        firstName: (effectiveUser as any).firstName ?? callerUser.firstName,
        lastName: (effectiveUser as any).lastName ?? callerUser.lastName,
        phone: (effectiveUser as any).phone ?? callerUser.phone,
        tenantId,
        isActive: true,
        roles,
        role: primaryRole
          ? { id: primaryRole.id, name: primaryRole.name, slug: primaryRole.name }
          : null,
        tenant: {
          id: targetTenant.id,
          name: targetTenant.name,
          slug: targetTenant.slug,
          isActive: targetTenant.isActive,
          createdAt: targetTenant.createdAt,
          updatedAt: targetTenant.updatedAt,
        },
      },
      tenant: {
        id: targetTenant.id,
        name: targetTenant.name,
        slug: targetTenant.slug,
        hospitalCode: targetTenant.hospitalCode,
        isActive: targetTenant.isActive,
        createdAt: targetTenant.createdAt,
        updatedAt: targetTenant.updatedAt,
      },
    };
  },

  async updateMyHospital(userId: string, tenantId: string, data: UpdateHospitalInput) {
    // Resolve all user IDs sharing the same email (handles hospital-scoped JWT)
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const allUserIds = callerUser
      ? (await prisma.user.findMany({
          where: { email: callerUser.email },
          select: { id: true },
        })).map((u) => u.id)
      : [userId];

    // Verify ownership via any of the user's identities
    const ownership = await prisma.tenantOwner.findFirst({
      where: { userId: { in: allUserIds }, tenantId },
    });

    if (!ownership) {
      throw AppError.forbidden('You do not own this hospital');
    }

    const existing = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!existing) {
      throw AppError.notFound('Hospital not found');
    }

    // slug is immutable — only update allowed fields
    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.address !== undefined && { address: data.address }),
        ...(data.city !== undefined && { city: data.city }),
        ...(data.state !== undefined && { state: data.state }),
        ...(data.country !== undefined && { country: data.country }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email }),
      },
      include: {
        featureToggles: true,
      },
    });

    logger.info({ tenantId, ownerId: userId }, 'Hospital updated by owner');

    return tenant;
  },

  async getHospitalLimit(userId: string) {
    // Resolve all user IDs sharing the same email (platform + hospital users)
    const callerUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!callerUser) return { current: 0, max: null, canCreate: true };

    const allUserIds = (
      await prisma.user.findMany({
        where: { email: callerUser.email },
        select: { id: true },
      })
    ).map((u) => u.id);

    // Count hospitals owned (excluding __platform__)
    const current = await prisma.tenantOwner.count({
      where: { userId: { in: allUserIds }, tenant: { slug: { not: '__platform__' } } },
    });

    // Check if super_admin (unlimited)
    const isSuperAdmin = await prisma.userRole.findFirst({
      where: { userId: { in: allUserIds }, role: { name: 'super_admin' } },
    });

    if (isSuperAdmin) {
      return { current, max: null, canCreate: true };
    }

    // Find user's active subscription plan (user-owned)
    let max: number | null = null;

    const activeSub = await prisma.userSubscription.findFirst({
      where: {
        userId: { in: allUserIds },
        status: 'active',
      },
      include: { plan: { select: { maxHospitals: true } } },
      orderBy: { createdAt: 'desc' },
    });

    max = activeSub?.plan?.maxHospitals ?? null;

    const canCreate = max === null || current < max;

    return { current, max, canCreate };
  },
};
