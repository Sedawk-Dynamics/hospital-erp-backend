import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams, PaginationQuery } from '../../shared/pagination';
import { SYSTEM_ROLE_NAMES, getRolePermissions } from '../../shared/role-permissions';
import type {
  CreateTenantInput,
  UpdateTenantInput,
  CreateSubscriptionInput,
  UpdateFeatureToggleInput,
} from './tenants.validation';

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

export const tenantsService = {
  async create(data: CreateTenantInput) {
    const existing = await prisma.tenant.findUnique({
      where: { slug: data.slug },
    });

    if (existing) {
      throw AppError.conflict('A tenant with this slug already exists');
    }

    const tenant = await prisma.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        logoUrl: data.logoUrl,
        address: data.address,
        city: data.city,
        state: data.state,
        country: data.country,
        phone: data.phone,
        email: data.email,
        isActive: true,
        featureToggles: {
          create: DEFAULT_FEATURE_TOGGLES,
        },
      },
      include: {
        featureToggles: true,
      },
    });

    // Bootstrap system roles and their permission mappings for this tenant
    await this.bootstrapRolesAndPermissions(tenant.id);

    logger.info({ tenantId: tenant.id, slug: tenant.slug }, 'Tenant created');

    return tenant;
  },

  async findAll(query: PaginationQuery) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const search = query.search;

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { slug: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        include: {
          _count: {
            select: { users: true },
          },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    return { tenants, total, page, limit };
  },

  async findById(id: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: {
        tenantSubscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        featureToggles: true,
        _count: {
          select: { users: true },
        },
      },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    return tenant;
  },

  async findBySlug(slug: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      include: {
        featureToggles: true,
      },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    return tenant;
  },

  async update(id: string, data: UpdateTenantInput) {
    const existing = await prisma.tenant.findUnique({
      where: { id },
    });

    if (!existing) {
      throw AppError.notFound('Tenant not found');
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
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

    logger.info({ tenantId: id }, 'Tenant updated');

    return tenant;
  },

  async deactivate(id: string) {
    const existing = await prisma.tenant.findUnique({
      where: { id },
    });

    if (!existing) {
      throw AppError.notFound('Tenant not found');
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        isActive: false,
        offboardedAt: new Date(),
      },
    });

    logger.info({ tenantId: id }, 'Tenant deactivated');

    return tenant;
  },

  async createSubscription(tenantId: string, data: CreateSubscriptionInput) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    // Deactivate any existing active subscription
    await prisma.tenantSubscription.updateMany({
      where: {
        tenantId,
        status: 'active',
      },
      data: {
        status: 'cancelled',
      },
    });

    // Find or create a subscription plan matching the requested plan name
    let plan = await prisma.subscriptionPlan.findFirst({
      where: { name: { equals: data.plan, mode: 'insensitive' } },
    });

    if (!plan) {
      plan = await prisma.subscriptionPlan.create({
        data: {
          name: data.plan,
          isActive: true,
        },
      });
    }

    // Map billing cycle - 'quarterly' is not in schema, map to 'monthly'
    const billingCycle = (data.billingCycle === 'quarterly' ? 'monthly' : data.billingCycle) as any;

    const subscription = await prisma.tenantSubscription.create({
      data: {
        tenantId,
        planId: plan.id,
        startDate: data.startDate,
        endDate: data.endDate,
        billingCycle,
        status: 'active',
      },
    });

    logger.info({ tenantId, subscriptionId: subscription.id }, 'Subscription created');

    return subscription;
  },

  /**
   * Create the 18 system roles and map their permissions for a new tenant.
   * This is required so that users in this tenant can pass requirePermission() checks.
   */
  async bootstrapRolesAndPermissions(tenantId: string) {
    // Fetch all global permissions once
    const allPermissions = await prisma.permission.findMany();
    const permissionMap: Record<string, string> = {};
    for (const p of allPermissions) {
      permissionMap[`${p.module}:${p.action}`] = p.id;
    }

    const rolePermissionsDef = getRolePermissions();

    for (const roleName of SYSTEM_ROLE_NAMES) {
      // Skip super_admin — it's a platform-level role, not tenant-scoped
      if (roleName === 'super_admin') continue;

      // Idempotent: find existing or create
      let role = await prisma.role.findFirst({
        where: { tenantId, name: roleName },
      });

      if (!role) {
        role = await prisma.role.create({
          data: {
            tenantId,
            name: roleName,
            description: `System role: ${roleName.replace(/_/g, ' ')}`,
            isSystemRole: true,
          },
        });
      }

      const perms = rolePermissionsDef[roleName] || [];
      const rolePermData = perms
        .map((p) => {
          const permId = permissionMap[`${p.module}:${p.action}`];
          return permId ? { roleId: role.id, permissionId: permId } : null;
        })
        .filter((d): d is { roleId: string; permissionId: string } => d !== null);

      if (rolePermData.length > 0) {
        await prisma.rolePermission.createMany({
          data: rolePermData,
          skipDuplicates: true,
        });
      }
    }

    logger.info({ tenantId }, 'System roles and permissions bootstrapped');
  },

  async updateFeatureToggle(
    tenantId: string,
    featureKey: string,
    enabled: boolean,
    config?: Record<string, unknown>,
  ) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    const toggle = await prisma.featureToggle.upsert({
      where: {
        tenantId_featureKey: {
          tenantId,
          featureKey,
        },
      },
      update: {
        isEnabled: enabled,
        ...(config !== undefined && { config: config as any }),
      },
      create: {
        tenantId,
        featureKey,
        isEnabled: enabled,
        config: (config ?? {}) as any,
      },
    });

    logger.info({ tenantId, featureKey, enabled }, 'Feature toggle updated');

    return toggle;
  },
};
