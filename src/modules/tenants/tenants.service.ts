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

    const baseFilter = { slug: { not: '__platform__' } };
    const where = search
      ? {
          AND: [
            baseFilter,
            {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { slug: { contains: search, mode: 'insensitive' as const } },
                { email: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ],
        }
      : baseFilter;

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

    // Resolve user subscription for each tenant from the owner
    const { getEffectiveSubscriptionByTenantId } = await import('../../shared/subscription-utils');
    const enrichedTenants = await Promise.all(
      tenants.map(async (t) => {
        const ownerSub = await getEffectiveSubscriptionByTenantId(t.id);
        (t as any).userSubscription = ownerSub || null;
        return t;
      }),
    );

    return { tenants: enrichedTenants, total, page, limit };
  },

  async findById(id: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: {
        featureToggles: true,
        _count: {
          select: { users: true },
        },
      },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    // Resolve the owner's user subscription
    if (tenant.slug !== '__platform__') {
      const { getEffectiveSubscriptionByTenantId } = await import('../../shared/subscription-utils');
      const ownerSub = await getEffectiveSubscriptionByTenantId(id);
      (tenant as any).userSubscription = ownerSub || null;
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

  async activate(id: string) {
    const existing = await prisma.tenant.findUnique({
      where: { id },
    });

    if (!existing) {
      throw AppError.notFound('Tenant not found');
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        isActive: true,
        offboardedAt: null,
      },
    });

    logger.info({ tenantId: id }, 'Tenant activated');

    return tenant;
  },

  /**
   * Hard delete a tenant and ALL related data.
   * This is irreversible — use with extreme caution.
   */
  async hardDelete(id: string) {
    const existing = await prisma.tenant.findUnique({
      where: { id },
    });

    if (!existing) {
      throw AppError.notFound('Tenant not found');
    }

    if (existing.slug === '__platform__') {
      throw AppError.forbidden('Cannot delete the platform tenant');
    }

    // Delete everything in a transaction, in dependency order
    await prisma.$transaction(async (tx) => {
      const tenantId = id;

      // 1. Move super_admin users to __platform__ BEFORE deleting anything
      const platformTenant = await tx.tenant.findUnique({ where: { slug: '__platform__' } });
      if (platformTenant) {
        // Find users in this tenant who hold ANY super_admin role (could be in this or platform tenant)
        const superAdmins = await tx.user.findMany({
          where: { tenantId, userRoles: { some: { role: { name: 'super_admin' } } } },
          select: { id: true },
        });
        if (superAdmins.length > 0) {
          const saIds = superAdmins.map((u) => u.id);

          // Ensure a super_admin role exists in __platform__ tenant
          let platformSaRole = await tx.role.findFirst({
            where: { name: 'super_admin', tenantId: platformTenant.id },
          });
          if (!platformSaRole) {
            platformSaRole = await tx.role.create({
              data: {
                tenantId: platformTenant.id,
                name: 'super_admin',
                description: 'System role: super admin',
                isSystemRole: true,
              },
            });
          }

          // Delete their userRoles that point to THIS tenant's roles
          await tx.userRole.deleteMany({
            where: { userId: { in: saIds }, role: { tenantId } },
          });

          // Assign the platform super_admin role to each moved user
          for (const saId of saIds) {
            const existingPlatformRole = await tx.userRole.findFirst({
              where: { userId: saId, roleId: platformSaRole.id },
            });
            if (!existingPlatformRole) {
              await tx.userRole.create({
                data: { userId: saId, roleId: platformSaRole.id },
              });
            }
          }

          // Move them to platform tenant
          await tx.user.updateMany({
            where: { id: { in: saIds } },
            data: { tenantId: platformTenant.id },
          });
        }
      }

      // 2. Delete subscription payments (linked to users in this tenant)
      await tx.subscriptionPayment.deleteMany({ where: { user: { tenantId } } });

      // 3. Delete user-related records — both by user.tenantId AND by role.tenantId
      await tx.userRole.deleteMany({ where: { user: { tenantId } } });
      await tx.userRole.deleteMany({ where: { role: { tenantId } } });
      await tx.loginAuditLog.deleteMany({ where: { tenantId } });

      // 3. Delete clinical data (dependent records first)
      await tx.dispensingRecord.deleteMany({ where: { tenantId } });
      await tx.drugReturn.deleteMany({ where: { tenantId } });
      await tx.drugBatch.deleteMany({ where: { tenantId } });
      await tx.drugFormulary.deleteMany({ where: { tenantId } });
      await tx.drugCategory.deleteMany({ where: { tenantId } });

      await tx.labOrder.deleteMany({ where: { tenantId } });
      await tx.labTestCatalog.deleteMany({ where: { tenantId } });
      await tx.labDepartment.deleteMany({ where: { tenantId } });

      await tx.imagingRequest.deleteMany({ where: { tenantId } });

      await tx.transfusion.deleteMany({ where: { tenantId } });
      await tx.crossMatchTest.deleteMany({ where: { tenantId } });
      await tx.bloodInventory.deleteMany({ where: { tenantId } });
      await tx.bloodDonation.deleteMany({ where: { tenantId } });
      await tx.bloodDonor.deleteMany({ where: { tenantId } });

      await tx.insuranceClaim.deleteMany({ where: { tenantId } });
      await tx.preAuthorizationRequest.deleteMany({ where: { tenantId } });
      await tx.tpaCommunicationLog.deleteMany({ where: { tenantId } });
      await tx.insurancePolicy.deleteMany({ where: { tenantId } });
      await tx.tpaProvider.deleteMany({ where: { tenantId } });
      await tx.insurer.deleteMany({ where: { tenantId } });

      await tx.refund.deleteMany({ where: { tenantId } });
      await tx.discount.deleteMany({ where: { tenantId } });
      await tx.receipt.deleteMany({ where: { tenantId } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.bill.deleteMany({ where: { tenantId } });
      await tx.serviceTariff.deleteMany({ where: { tenantId } });

      await tx.prescription.deleteMany({ where: { tenantId } });
      await tx.patientTransfer.deleteMany({ where: { tenantId } });
      await tx.admission.deleteMany({ where: { tenantId } });
      await tx.visit.deleteMany({ where: { tenantId } });
      await tx.queueToken.deleteMany({ where: { tenantId } });
      await tx.appointment.deleteMany({ where: { tenantId } });

      await tx.otRequest.deleteMany({ where: { tenantId } });
      await tx.mrdRequest.deleteMany({ where: { tenantId } });

      await tx.abhaSyncLog.deleteMany({ where: { tenantId } });
      await tx.patient.deleteMany({ where: { tenantId } });

      // 4. Delete inventory & supply
      await tx.stockTransaction.deleteMany({ where: { tenantId } });
      await tx.supplyRequest.deleteMany({ where: { tenantId } });
      await tx.purchaseOrder.deleteMany({ where: { tenantId } });
      await tx.inventoryItem.deleteMany({ where: { tenantId } });
      await tx.supplier.deleteMany({ where: { tenantId } });

      // 5. Delete HR
      await tx.payroll.deleteMany({ where: { tenantId } });
      await tx.leaveRequest.deleteMany({ where: { tenantId } });
      await tx.attendance.deleteMany({ where: { tenantId } });
      await tx.dutyRoster.deleteMany({ where: { tenantId } });
      await tx.staffProfile.deleteMany({ where: { tenantId } });
      await tx.doctorProfile.deleteMany({ where: { tenantId } });

      // 6. Delete infrastructure
      await tx.bed.deleteMany({ where: { tenantId } });
      await tx.room.deleteMany({ where: { tenantId } });
      await tx.ward.deleteMany({ where: { tenantId } });
      await tx.operatingTheater.deleteMany({ where: { tenantId } });
      await tx.hospitalResource.deleteMany({ where: { tenantId } });
      await tx.department.deleteMany({ where: { tenantId } });

      // 7. Delete communication & misc
      await tx.notification.deleteMany({ where: { tenantId } });
      await tx.message.deleteMany({ where: { tenantId } });
      await tx.shiftHandoverNote.deleteMany({ where: { tenantId } });
      await tx.ticket.deleteMany({ where: { tenantId } });
      await tx.feedback.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.complianceDocument.deleteMany({ where: { tenantId } });
      await tx.incidentReport.deleteMany({ where: { tenantId } });
      await tx.savedReport.deleteMany({ where: { tenantId } });
      await tx.scheduledReport.deleteMany({ where: { tenantId } });
      await tx.supportTicket.deleteMany({ where: { tenantId } });

      // 9. Delete roles & permissions
      await tx.rolePermission.deleteMany({ where: { role: { tenantId } } });
      await tx.role.deleteMany({ where: { tenantId } });

      // 10. Delete remaining users in this hospital tenant only
      //     (super_admins moved out in step 1; platform users in __platform__ are unaffected)
      //     Also preserve users who own this hospital via TenantOwner (they live in __platform__)
      const ownerUserIds = (
        await tx.tenantOwner.findMany({
          where: { tenantId },
          select: { userId: true },
        })
      ).map((o) => o.userId);

      await tx.user.deleteMany({
        where: {
          tenantId,
          id: { notIn: ownerUserIds },
        },
      });

      // 11. Delete tenant-level records
      await tx.featureToggle.deleteMany({ where: { tenantId } });
      await tx.tenantOwner.deleteMany({ where: { tenantId } });

      // 12. Delete tenant itself
      await tx.tenant.delete({ where: { id: tenantId } });
    });

    logger.info({ tenantId: id, slug: existing.slug }, 'Tenant hard-deleted with all data');

    return { message: `Hospital "${existing.name}" and all its data have been permanently deleted` };
  },

  async createSubscription(tenantId: string, data: CreateSubscriptionInput) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    // Resolve the tenant owner — subscription belongs to the user
    const owner = await prisma.tenantOwner.findFirst({
      where: { tenantId },
      select: { userId: true },
    });

    if (!owner) {
      throw AppError.badRequest('Tenant has no owner — cannot create subscription');
    }

    // Deactivate any existing active subscription for this user
    await prisma.userSubscription.updateMany({
      where: {
        userId: owner.userId,
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

    const subscription = await prisma.userSubscription.create({
      data: {
        userId: owner.userId,
        planId: plan.id,
        startDate: data.startDate,
        endDate: data.endDate,
        billingCycle,
        status: 'active',
      },
    });

    logger.info({ userId: owner.userId, subscriptionId: subscription.id }, 'Subscription created for tenant owner');

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

  /**
   * Get comprehensive statistics for a hospital (super admin view).
   * Aggregates patients, appointments, billing, beds, staff, departments, lab, pharmacy data.
   */
  async getComprehensiveStats(tenantId: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw AppError.notFound('Tenant not found');

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      // Patient stats
      totalPatients,
      todayNewPatients,
      activeAdmissions,
      // Appointment stats
      totalAppointments,
      todayAppointments,
      completedAppointments,
      pendingAppointments,
      cancelledAppointments,
      // Billing stats
      totalBills,
      pendingBills,
      todayPayments,
      allPayments,
      // Infrastructure
      totalDepartments,
      totalWards,
      totalBeds,
      occupiedBeds,
      totalOTs,
      // Staff
      totalUsers,
      doctorCount,
      staffCount,
      // Lab
      totalLabOrders,
      pendingLabOrders,
      // Pharmacy
      totalDrugItems,
      lowStockItems,
      // Insurance
      totalInsuranceClaims,
      pendingClaims,
      // Recent departments
      departments,
    ] = await Promise.all([
      prisma.patient.count({ where: { tenantId } }),
      prisma.patient.count({ where: { tenantId, createdAt: { gte: today, lt: tomorrow } } }),
      prisma.admission.count({ where: { tenantId, status: 'admitted' } }),

      prisma.appointment.count({ where: { tenantId } }),
      prisma.appointment.count({ where: { tenantId, appointmentDate: { gte: today, lt: tomorrow } } }),
      prisma.appointment.count({ where: { tenantId, status: 'completed' } }),
      prisma.appointment.count({ where: { tenantId, status: { in: ['booked', 'confirmed'] } } }),
      prisma.appointment.count({ where: { tenantId, status: 'cancelled' } }),

      prisma.bill.count({ where: { tenantId } }),
      prisma.bill.count({ where: { tenantId, status: { in: ['pending', 'partially_paid'] } } }),
      prisma.payment.aggregate({ where: { tenantId, status: 'completed', paymentDate: { gte: today, lt: tomorrow } }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { tenantId, status: 'completed' }, _sum: { amount: true } }),

      prisma.department.count({ where: { tenantId } }),
      prisma.ward.count({ where: { tenantId } }),
      prisma.bed.count({ where: { tenantId } }),
      prisma.bed.count({ where: { tenantId, status: 'occupied' } }),
      prisma.operatingTheater.count({ where: { tenantId } }),

      prisma.user.count({ where: { tenantId } }),
      prisma.doctorProfile.count({ where: { tenantId } }),
      prisma.staffProfile.count({ where: { tenantId } }),

      prisma.labOrder.count({ where: { tenantId } }),
      prisma.labOrder.count({ where: { tenantId, status: { in: ['ordered', 'sample_collected'] } } }),

      prisma.drugFormulary.count({ where: { tenantId } }),
      prisma.drugBatch.count({ where: { tenantId, quantityInStock: { lte: 10 } } }),

      prisma.insuranceClaim.count({ where: { tenantId } }),
      prisma.insuranceClaim.count({ where: { tenantId, status: { in: ['submitted', 'under_review'] } } }),

      prisma.department.findMany({
        where: { tenantId },
        select: { id: true, name: true, _count: { select: { doctorProfiles: true, wards: true } } },
        take: 20,
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      patients: {
        total: totalPatients,
        todayNew: todayNewPatients,
        activeAdmissions,
      },
      appointments: {
        total: totalAppointments,
        today: todayAppointments,
        completed: completedAppointments,
        pending: pendingAppointments,
        cancelled: cancelledAppointments,
      },
      billing: {
        totalBills,
        pendingBills,
        todayRevenue: todayPayments._sum.amount ? Number(todayPayments._sum.amount) : 0,
        totalRevenue: allPayments._sum.amount ? Number(allPayments._sum.amount) : 0,
      },
      infrastructure: {
        departments: totalDepartments,
        wards: totalWards,
        beds: { total: totalBeds, occupied: occupiedBeds, available: totalBeds - occupiedBeds },
        operatingTheaters: totalOTs,
      },
      staff: {
        totalUsers,
        doctors: doctorCount,
        staff: staffCount,
      },
      lab: {
        totalOrders: totalLabOrders,
        pending: pendingLabOrders,
      },
      pharmacy: {
        totalDrugs: totalDrugItems,
        lowStock: lowStockItems,
      },
      insurance: {
        totalClaims: totalInsuranceClaims,
        pending: pendingClaims,
      },
      departmentList: departments,
    };
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
