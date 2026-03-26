import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams, PaginationQuery } from '../../shared/pagination';
import type {
  CreateUserInput,
  UpdateUserInput,
  AssignRoleInput,
  CreateRoleInput,
  UpdateRoleInput,
  AssignPermissionsInput,
} from './users.validation';

export const usersService = {
  // ─── USER CRUD ───────────────────────────────────────────────────────

  async create(tenantId: string, data: CreateUserInput) {
    // Check subscription maxUsers limit (subscription may live on platform tenant)
    const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
    const subscription = await getEffectiveSubscription(tenantId);

    if (subscription?.plan?.maxUsers) {
      const activeUserCount = await prisma.user.count({
        where: { tenantId, isActive: true },
      });

      if (activeUserCount >= subscription.plan.maxUsers) {
        throw AppError.forbidden(
          `User limit reached (${subscription.plan.maxUsers}). Please upgrade your subscription plan.`,
        );
      }
    }

    const existing = await prisma.user.findFirst({
      where: {
        email: data.email,
        tenantId,
      },
    });

    if (existing) {
      throw AppError.conflict('User with this email already exists in this tenant');
    }

    // Validate that all role IDs belong to this tenant
    const roles = await prisma.role.findMany({
      where: {
        id: { in: data.roleIds },
        tenantId,
      },
    });

    if (roles.length !== data.roleIds.length) {
      throw AppError.badRequest('One or more role IDs are invalid for this tenant');
    }

    const hashedPassword = await bcrypt.hash(data.password, env.BCRYPT_SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        tenantId,
        isActive: true,
        userRoles: {
          create: data.roleIds.map((roleId) => ({ roleId })),
        },
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
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    logger.info({ userId: user.id, tenantId }, 'User created');

    return user;
  },

  async findAll(
    tenantId: string,
    query: PaginationQuery & { roleId?: string; isActive?: string },
  ) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const search = query.search;

    const where = {
      tenantId,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
      ...(query.roleId && {
        userRoles: { some: { roleId: query.roleId } },
      }),
      ...(query.isActive !== undefined && {
        isActive: query.isActive === 'true',
      }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          isActive: true,
          is2faEnabled: true,
          createdAt: true,
          updatedAt: true,
          userRoles: {
            select: {
              role: {
                select: { id: true, name: true },
              },
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return { users, total, page, limit };
  },

  /** List all users across all tenants (super_admin only) — excludes __platform__ tenant */
  async findAllGlobal(
    query: PaginationQuery & { roleId?: string; isActive?: string },
  ) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const search = query.search;

    const where = {
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
      ...(query.roleId && {
        userRoles: { some: { roleId: query.roleId } },
      }),
      ...(query.isActive !== undefined && {
        isActive: query.isActive === 'true',
      }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
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
            select: { id: true, name: true, slug: true },
          },
          userRoles: {
            select: {
              role: {
                select: { id: true, name: true },
              },
            },
          },
          tenantOwners: {
            select: {
              tenant: {
                select: { id: true, name: true, slug: true },
              },
            },
            where: { tenant: { slug: { not: '__platform__' } } },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    // For platform users, resolve their owned hospitals via email
    const enrichedUsers = await Promise.all(
      users.map(async (user) => {
        let ownedHospitals = user.tenantOwners.map((to) => to.tenant);

        // If user is on platform and has no direct ownership, check by email
        if (user.tenant.slug === '__platform__' && ownedHospitals.length === 0) {
          const otherUsers = await prisma.user.findMany({
            where: { email: user.email, id: { not: user.id } },
            select: { id: true },
          });
          if (otherUsers.length > 0) {
            const ownerRecords = await prisma.tenantOwner.findMany({
              where: {
                userId: { in: [user.id, ...otherUsers.map((u) => u.id)] },
                tenant: { slug: { not: '__platform__' } },
              },
              select: { tenant: { select: { id: true, name: true, slug: true } } },
            });
            ownedHospitals = ownerRecords.map((o) => o.tenant);
          }
        }

        return {
          ...user,
          ownedHospitals,
        };
      }),
    );

    return { users: enrichedUsers, total, page, limit };
  },

  async findById(tenantId: string, userId: string) {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        tenantId,
      },
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
        userRoles: {
          select: {
            role: {
              select: {
                id: true,
                name: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: {
                        id: true,
                        module: true,
                        action: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    return user;
  },

  async update(tenantId: string, userId: string, data: UpdateUserInput) {
    const existing = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('User not found');
    }

    // If email is being changed, check for uniqueness within tenant
    if (data.email && data.email !== existing.email) {
      const emailTaken = await prisma.user.findFirst({
        where: {
          email: data.email,
          tenantId,
          id: { not: userId },
        },
      });

      if (emailTaken) {
        throw AppError.conflict('Email is already in use by another user in this tenant');
      }
    }

    // If roleIds provided, validate and sync roles in a transaction
    if (data.roleIds && data.roleIds.length > 0) {
      const roles = await prisma.role.findMany({
        where: { id: { in: data.roleIds }, tenantId },
      });

      if (roles.length !== data.roleIds.length) {
        throw AppError.badRequest('One or more role IDs are invalid for this tenant');
      }

      await prisma.$transaction([
        prisma.userRole.deleteMany({ where: { userId } }),
        ...data.roleIds.map((roleId) =>
          prisma.userRole.create({ data: { userId, roleId } }),
        ),
      ]);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isActive: true,
        updatedAt: true,
        userRoles: {
          select: {
            role: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    logger.info({ userId, tenantId }, 'User updated');

    return user;
  },

  /** Hard-delete a user across any tenant (super_admin only) */
  async hardDeleteGlobal(userId: string, requestUserId: string) {
    if (userId === requestUserId) {
      throw AppError.badRequest('Cannot delete yourself');
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { slug: true } } },
    });

    if (!existing) {
      throw AppError.notFound('User not found');
    }

    if (existing.tenant.slug === '__platform__') {
      throw AppError.forbidden('Cannot delete platform tenant users through this endpoint');
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.loginAuditLog.deleteMany({ where: { userId } });
      await tx.subscriptionPayment.deleteMany({ where: { userId } });
      await tx.auditLog.deleteMany({ where: { userId } });
      await tx.tenantOwner.deleteMany({ where: { userId } });
      // Nullable user references — set null instead of deleting
      await tx.doctorProfile.deleteMany({ where: { userId } });
      await tx.staffProfile.deleteMany({ where: { userId } });
      await tx.patient.updateMany({ where: { userId }, data: { userId: null } });
      await tx.user.delete({ where: { id: userId } });
    });

    logger.info({ userId, email: existing.email }, 'User hard-deleted (global)');

    return { message: `User "${existing.firstName} ${existing.lastName}" has been permanently deleted` };
  },

  /** Toggle active status for a user across any tenant (super_admin only) */
  async toggleActiveGlobal(userId: string, isActive: boolean) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { slug: true } } },
    });

    if (!existing) {
      throw AppError.notFound('User not found');
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
      },
    });

    logger.info({ userId, isActive }, `User ${isActive ? 'activated' : 'deactivated'} (global)`);

    return user;
  },

  async deactivate(tenantId: string, userId: string) {
    const existing = await prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('User not found');
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
      },
    });

    logger.info({ userId, tenantId }, 'User deactivated');

    return user;
  },

  // ─── ROLE ASSIGNMENT ────────────────────────────────────────────────

  async assignRole(userId: string, data: AssignRoleInput) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    const role = await prisma.role.findFirst({
      where: {
        id: data.roleId,
        tenantId: user.tenantId,
      },
    });

    if (!role) {
      throw AppError.notFound('Role not found for this tenant');
    }

    const existingAssignment = await prisma.userRole.findFirst({
      where: {
        userId,
        roleId: data.roleId,
      },
    });

    if (existingAssignment) {
      throw AppError.conflict('User already has this role');
    }

    const userRole = await prisma.userRole.create({
      data: {
        userId,
        roleId: data.roleId,
      },
      include: {
        role: {
          select: { id: true, name: true },
        },
      },
    });

    logger.info({ userId, roleId: data.roleId }, 'Role assigned to user');

    return userRole;
  },

  async removeRole(userId: string, roleId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    const userRole = await prisma.userRole.findFirst({
      where: { userId, roleId },
    });

    if (!userRole) {
      throw AppError.notFound('User does not have this role');
    }

    // Ensure user has at least one role remaining
    const roleCount = await prisma.userRole.count({
      where: { userId },
    });

    if (roleCount <= 1) {
      throw AppError.badRequest('Cannot remove the last role from a user');
    }

    await prisma.userRole.delete({
      where: { id: userRole.id },
    });

    logger.info({ userId, roleId }, 'Role removed from user');

    return { message: 'Role removed successfully' };
  },

  // ─── ROLES CRUD ─────────────────────────────────────────────────────

  async getRoles(tenantId: string) {
    const roles = await prisma.role.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            userRoles: true,
            rolePermissions: true,
          },
        },
      },
    });

    return roles;
  },

  async createRole(tenantId: string, data: CreateRoleInput) {
    const existing = await prisma.role.findFirst({
      where: {
        name: data.name,
        tenantId,
      },
    });

    if (existing) {
      throw AppError.conflict('A role with this name already exists for this tenant');
    }

    const role = await prisma.role.create({
      data: {
        name: data.name,
        description: data.description,
        isSystemRole: data.isSystem ?? false,
        tenantId,
      },
    });

    logger.info({ roleId: role.id, tenantId }, 'Role created');

    return role;
  },

  async updateRole(tenantId: string, roleId: string, data: UpdateRoleInput) {
    const existing = await prisma.role.findFirst({
      where: { id: roleId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('Role not found');
    }

    if (existing.isSystemRole) {
      throw AppError.badRequest('System roles cannot be modified');
    }

    const role = await prisma.role.update({
      where: { id: roleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });

    logger.info({ roleId, tenantId }, 'Role updated');

    return role;
  },

  // ─── PERMISSIONS ────────────────────────────────────────────────────

  async getPermissions() {
    const permissions = await prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { action: 'asc' }],
    });

    return permissions;
  },

  async getStats(tenantId: string) {
    const { getEffectiveSubscription } = await import('../../shared/subscription-utils');
    const [activeCount, totalCount, subscription] = await Promise.all([
      prisma.user.count({ where: { tenantId, isActive: true } }),
      prisma.user.count({ where: { tenantId } }),
      getEffectiveSubscription(tenantId),
    ]);

    return {
      activeCount,
      totalCount,
      maxUsers: subscription?.plan?.maxUsers ?? null,
    };
  },

  async assignPermissionsToRole(roleId: string, data: AssignPermissionsInput) {
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw AppError.notFound('Role not found');
    }

    if (role.isSystemRole) {
      throw AppError.badRequest('Cannot modify permissions of system roles');
    }

    // Validate all permission IDs exist
    const permissions = await prisma.permission.findMany({
      where: { id: { in: data.permissionIds } },
    });

    if (permissions.length !== data.permissionIds.length) {
      throw AppError.badRequest('One or more permission IDs are invalid');
    }

    // Remove existing permissions and assign new ones in a transaction
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({
        where: { roleId },
      }),
      ...data.permissionIds.map((permissionId) =>
        prisma.rolePermission.create({
          data: { roleId, permissionId },
        }),
      ),
    ]);

    // Return the updated role with permissions
    const updatedRole = await prisma.role.findUnique({
      where: { id: roleId },
      include: {
        rolePermissions: {
          include: {
            permission: {
              select: { id: true, module: true, action: true },
            },
          },
        },
      },
    });

    logger.info({ roleId, permissionCount: data.permissionIds.length }, 'Permissions assigned to role');

    return updatedRole;
  },
};
