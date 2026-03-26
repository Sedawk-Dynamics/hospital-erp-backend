import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams, PaginationQuery } from '../../shared/pagination';
import { tenantsService } from '../tenants/tenants.service';
import type { SubmitDemoRequestInput, ApproveDemoRequestInput } from './demo-requests.validation';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const demoRequestsService = {
  /**
   * Public: submit a "Book a Free Demo" request.
   */
  async submit(data: SubmitDemoRequestInput) {
    // Check for duplicate pending request from same email
    const existing = await prisma.demoRequest.findFirst({
      where: { email: data.email, status: { in: ['pending', 'approved', 'trial_active'] } },
    });

    if (existing) {
      throw AppError.conflict(
        'A demo request with this email is already being processed. Please wait for our team to contact you.',
      );
    }

    const demoRequest = await prisma.demoRequest.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        hospitalName: data.hospitalName,
        designation: data.designation,
        city: data.city,
        message: data.message,
      },
    });

    logger.info({ demoRequestId: demoRequest.id, email: data.email }, 'Demo request submitted');

    return demoRequest;
  },

  /**
   * Super admin: list all demo requests with pagination and filters.
   */
  async list(query: PaginationQuery & { status?: string }) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const search = query.search;

    const where = {
      ...(query.status && { status: query.status as any }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { hospitalName: { contains: search, mode: 'insensitive' as const } },
          { city: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [requests, total] = await Promise.all([
      prisma.demoRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          approvedBy: { select: { id: true, firstName: true, lastName: true } },
          trialPlan: { select: { id: true, name: true } },
        },
      }),
      prisma.demoRequest.count({ where }),
    ]);

    return { requests, total, page, limit };
  },

  /**
   * Super admin: approve a demo request.
   * Creates: hospital tenant, admin user, free trial subscription.
   * Super admin picks any plan as the demo plan + sets trial days.
   */
  async approve(id: string, approvedById: string, data: ApproveDemoRequestInput) {
    const demoReq = await prisma.demoRequest.findUnique({ where: { id } });

    if (!demoReq) throw AppError.notFound('Demo request not found');
    if (demoReq.status !== 'pending') {
      throw AppError.badRequest(`Cannot approve a request with status "${demoReq.status}"`);
    }

    // Super admin selects which plan to use for the demo trial
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: data.planId } });
    if (!plan) throw AppError.notFound('Subscription plan not found');

    // Generate slug from hospital name
    let slug = generateSlug(demoReq.hospitalName);
    const existingSlug = await prisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Generate hospital code
    const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let hospitalCode: string | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += codeChars[Math.floor(Math.random() * codeChars.length)];
      const exists = await prisma.tenant.findUnique({ where: { hospitalCode: code } });
      if (!exists) { hospitalCode = code; break; }
    }

    const hashedPassword = await bcrypt.hash(data.password, env.BCRYPT_SALT_ROUNDS);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + data.trialDays);

    // Get platform tenant for the admin user
    const platformTenant = await prisma.tenant.findFirst({ where: { slug: '__platform__' } });
    if (!platformTenant) throw AppError.internal('Platform tenant not found');

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the hospital tenant with default feature toggles
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
        { featureKey: 'ip_management', isEnabled: true, config: {} },
        { featureKey: 'reports', isEnabled: true, config: {} },
      ];

      const tenant = await tx.tenant.create({
        data: {
          name: demoReq.hospitalName,
          slug,
          hospitalCode,
          city: demoReq.city,
          email: demoReq.email,
          phone: demoReq.phone,
          isActive: true,
          onboardedAt: new Date(),
          featureToggles: { create: DEFAULT_FEATURE_TOGGLES },
        },
      });

      // 2. Create admin user on the platform tenant
      //    (same pattern as hospital registration — platform user + TenantOwner)
      let platformUser = await tx.user.findFirst({
        where: { email: demoReq.email, tenantId: platformTenant.id },
      });

      if (!platformUser) {
        const [firstName, ...lastParts] = demoReq.name.split(' ');
        const lastName = lastParts.join(' ') || '';

        platformUser = await tx.user.create({
          data: {
            tenantId: platformTenant.id,
            email: demoReq.email,
            passwordHash: hashedPassword,
            firstName,
            lastName,
            phone: demoReq.phone,
            isActive: true,
          },
        });

        // Assign admin role on platform
        const adminRole = await tx.role.findFirst({
          where: { tenantId: platformTenant.id, name: 'admin' },
        });

        if (adminRole) {
          await tx.userRole.create({
            data: { userId: platformUser.id, roleId: adminRole.id },
          });
        }
      }

      // 3. Create TenantOwner linking platform user to hospital
      await tx.tenantOwner.create({
        data: { userId: platformUser.id, tenantId: tenant.id },
      });

      // 4. Create trial subscription for the user (user-owned)
      const startDate = new Date();
      await tx.userSubscription.create({
        data: {
          userId: platformUser.id,
          planId: plan.id,
          startDate,
          endDate: trialEndsAt,
          status: 'active',
          billingCycle: 'monthly',
        },
      });

      // 5. Sync Demo plan features to the hospital
      if (plan.features && typeof plan.features === 'object') {
        const planFeatures = plan.features as Record<string, boolean>;
        for (const [featureKey, isEnabled] of Object.entries(planFeatures)) {
          await tx.featureToggle.upsert({
            where: { tenantId_featureKey: { tenantId: tenant.id, featureKey } },
            update: { isEnabled },
            create: { tenantId: tenant.id, featureKey, isEnabled, config: {} },
          });
        }
      }

      // 6. Update demo request status
      const updated = await tx.demoRequest.update({
        where: { id },
        data: {
          status: 'trial_active',
          trialDays: data.trialDays,
          trialEndsAt,
          trialPlanId: plan.id,
          approvedById,
          createdTenantId: tenant.id,
          createdUserId: platformUser.id,
        },
        include: {
          trialPlan: { select: { id: true, name: true } },
        },
      });

      return { demoRequest: updated, tenant, user: platformUser };
    });

    // Bootstrap roles outside transaction (heavy operation)
    await tenantsService.bootstrapRolesAndPermissions(result.tenant.id);

    logger.info(
      {
        demoRequestId: id,
        tenantId: result.tenant.id,
        userId: result.user.id,
        trialDays: data.trialDays,
        planId: plan.id,
      },
      'Demo request approved — hospital and trial created',
    );

    return result;
  },

  /**
   * Super admin: reject a demo request.
   */
  async reject(id: string, approvedById: string, rejectionNote?: string) {
    const demoReq = await prisma.demoRequest.findUnique({ where: { id } });

    if (!demoReq) throw AppError.notFound('Demo request not found');
    if (demoReq.status !== 'pending') {
      throw AppError.badRequest(`Cannot reject a request with status "${demoReq.status}"`);
    }

    const updated = await prisma.demoRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        approvedById,
        rejectionNote,
      },
    });

    logger.info({ demoRequestId: id }, 'Demo request rejected');

    return updated;
  },

  /**
   * Super admin: end a trial early.
   * Deactivates the hospital and expires the subscription.
   */
  async endTrial(id: string) {
    const demoReq = await prisma.demoRequest.findUnique({
      where: { id },
      include: { createdTenant: true },
    });

    if (!demoReq) throw AppError.notFound('Demo request not found');
    if (demoReq.status !== 'trial_active') {
      throw AppError.badRequest('This request does not have an active trial');
    }

    await prisma.$transaction(async (tx) => {
      // Deactivate hospital
      if (demoReq.createdTenantId) {
        await tx.tenant.update({
          where: { id: demoReq.createdTenantId },
          data: { isActive: false, offboardedAt: new Date() },
        });
      }

      // Expire the user's subscription related to this trial
      if (demoReq.createdUserId) {
        await tx.userSubscription.updateMany({
          where: { userId: demoReq.createdUserId, status: 'active' },
          data: { status: 'expired', endDate: new Date() },
        });
      }

      // Update demo request
      await tx.demoRequest.update({
        where: { id },
        data: {
          status: 'trial_ended',
          trialEndsAt: new Date(),
        },
      });
    });

    // Auto-offer all plans marked as isActive (auto-offer) to the user
    if (demoReq.createdUserId) {
      await this.autoOfferPlans(demoReq.createdUserId, demoReq.createdTenantId);
    }

    logger.info({ demoRequestId: id }, 'Trial ended early');

    return { success: true };
  },

  /**
   * Auto-offer all plans marked as isActive to a user after their demo ends.
   * These plans appear on the user's /manage-subscription page.
   */
  async autoOfferPlans(userId: string, tenantId: string | null) {
    const autoOfferPlans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true, priceMonthly: { not: null } },
      select: { id: true, name: true },
    });

    if (autoOfferPlans.length === 0) return;

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!targetUser) return;

    const platformUser = await prisma.user.findFirst({
      where: { email: targetUser.email, tenant: { slug: '__platform__' } },
      select: { id: true, tenantId: true },
    });

    const targetTenantId = platformUser?.tenantId || tenantId;
    const targetUserId = platformUser?.id || userId;
    if (!targetTenantId) return;

    const planNames = autoOfferPlans.map((p) => p.name).join(', ');

    await prisma.notification.create({
      data: {
        tenantId: targetTenantId,
        userId: targetUserId,
        title: 'Choose a Plan to Continue',
        message: `Your demo trial has ended. The following plans are available: ${planNames}. Go to Manage Subscription to choose a plan and continue using Hospital ERP.`,
        notificationType: 'subscription',
        channel: 'in_app',
        referenceType: 'offered_plans',
        referenceId: autoOfferPlans.map((p) => p.id).join(','),
      },
    }).catch(() => {});

    // Reactivate hospitals so user can log in
    if (tenantId) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { isActive: true },
      }).catch(() => {});
    }

    logger.info({ userId, planCount: autoOfferPlans.length }, 'Auto-offered plans after demo end');
  },

  /**
   * Super admin: permanently delete a demo request.
   */
  async delete(id: string) {
    const demoReq = await prisma.demoRequest.findUnique({ where: { id } });
    if (!demoReq) throw AppError.notFound('Demo request not found');

    await prisma.demoRequest.delete({ where: { id } });

    logger.info({ demoRequestId: id, status: demoReq.status }, 'Demo request deleted');

    return { success: true };
  },
};
