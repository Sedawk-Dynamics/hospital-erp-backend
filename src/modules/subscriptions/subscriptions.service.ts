import crypto from 'crypto';
import { prisma } from '../../config/database';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getEffectiveSubscription } from '../../shared/subscription-utils';
import { formatDateIST } from '../../shared/date.utils';

// ============================================================
// Helpers
// ============================================================

function isDevMode(): boolean {
  return env.NODE_ENV !== 'production';
}

function mockId(prefix: string): string {
  return `${prefix}_dev_${crypto.randomBytes(6).toString('hex')}`;
}

// ============================================================
// Service
// ============================================================

export class SubscriptionsService {
  // ─── Plan CRUD ────────────────────────────────────────────

  async listActivePlans() {
    return prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceMonthly: 'asc' },
    });
  }

  async listAllPlans() {
    return prisma.subscriptionPlan.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Super admin: list all subscriptions with user, plan, and hospital details.
   * Subscriptions are user-owned, so we resolve hospitals from TenantOwner.
   */
  async listAllSubscriptions() {
    const subscriptions = await prisma.userSubscription.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        plan: { select: { id: true, name: true, priceMonthly: true, priceYearly: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const results: any[] = [];

    for (const sub of subscriptions) {
      const resolvedUser = sub.user;

      // Resolve hospitals from user's TenantOwner records
      let hospitals: { id: string; name: string; slug: string }[] = [];
      const allUserIds = await prisma.user.findMany({
        where: { email: resolvedUser.email },
        select: { id: true },
      });
      const ownerships = await prisma.tenantOwner.findMany({
        where: {
          userId: { in: allUserIds.map((u) => u.id) },
          tenant: { slug: { not: '__platform__' } },
        },
        select: { tenant: { select: { id: true, name: true, slug: true } } },
      });
      hospitals = ownerships.map((o) => o.tenant);

      const isDemoTrial =
        sub.plan.name.toLowerCase() === 'demo' ||
        (!sub.plan.priceMonthly && !sub.plan.priceYearly);

      results.push({
        id: sub.id,
        plan: sub.plan,
        status: sub.status,
        billingCycle: sub.billingCycle,
        startDate: sub.startDate,
        endDate: sub.endDate,
        autoRenew: sub.autoRenew,
        subscriptionPaymentMethod: sub.subscriptionPaymentMethod,
        createdAt: sub.createdAt,
        user: resolvedUser,
        hospitals,
        isDemoTrial,
      });
    }

    return results;
  }

  async createPlan(data: {
    name: string;
    description?: string;
    priceMonthly?: number;
    priceYearly?: number;
    maxUsers?: number;
    maxHospitals?: number;
    features?: any;
    isActive?: boolean;
    allowAutopay?: boolean;
    allowManual?: boolean;
    trialDays?: number;
  }) {
    const plan = await prisma.subscriptionPlan.create({ data });

    // Auto-create Razorpay plans
    await this.syncRazorpayPlans(plan.id, plan.name, data.priceMonthly, data.priceYearly);

    return prisma.subscriptionPlan.findUnique({ where: { id: plan.id } });
  }

  async updatePlan(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      priceMonthly: number | null;
      priceYearly: number | null;
      maxUsers: number | null;
      maxHospitals: number | null;
      features: any;
      isActive: boolean;
      allowAutopay: boolean;
      allowManual: boolean;
      trialDays: number | null;
    }>,
  ) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Plan not found');

    const plan = await prisma.subscriptionPlan.update({ where: { id }, data });

    // If pricing changed, create new Razorpay plans (they're immutable)
    const monthlyChanged = data.priceMonthly !== undefined &&
      Number(data.priceMonthly) !== Number(existing.priceMonthly);
    const yearlyChanged = data.priceYearly !== undefined &&
      Number(data.priceYearly) !== Number(existing.priceYearly);

    if (monthlyChanged || yearlyChanged) {
      await this.syncRazorpayPlans(
        id,
        plan.name,
        monthlyChanged ? (data.priceMonthly ?? undefined) : undefined,
        yearlyChanged ? (data.priceYearly ?? undefined) : undefined,
      );
    }

    return prisma.subscriptionPlan.findUnique({ where: { id } });
  }

  // ─── Razorpay Plan Sync ───────────────────────────────────

  private async syncRazorpayPlans(
    planId: string,
    planName: string,
    priceMonthly?: number | null,
    priceYearly?: number | null,
  ) {
    const updates: Record<string, string> = {};

    if (priceMonthly && Number(priceMonthly) > 0) {
      try {
        const rzpPlan = await (razorpay as any).plans.create({
          period: 'monthly',
          interval: 1,
          item: {
            name: `${planName} - Monthly`,
            amount: Math.round(Number(priceMonthly) * 100),
            currency: 'INR',
          },
        });
        updates.razorpayMonthlyPlanId = rzpPlan.id;
        logger.info({ planId, rzpPlanId: rzpPlan.id }, 'Razorpay monthly plan created');
      } catch (err) {
        if (isDevMode()) {
          updates.razorpayMonthlyPlanId = mockId('plan_monthly');
          logger.warn({ planId, err }, 'Razorpay Plans API failed in dev — using mock');
        } else {
          logger.error({ planId, err }, 'Failed to create Razorpay monthly plan');
        }
      }
    }

    if (priceYearly && Number(priceYearly) > 0) {
      try {
        const rzpPlan = await (razorpay as any).plans.create({
          period: 'yearly',
          interval: 1,
          item: {
            name: `${planName} - Yearly`,
            amount: Math.round(Number(priceYearly) * 100),
            currency: 'INR',
          },
        });
        updates.razorpayYearlyPlanId = rzpPlan.id;
        logger.info({ planId, rzpPlanId: rzpPlan.id }, 'Razorpay yearly plan created');
      } catch (err) {
        if (isDevMode()) {
          updates.razorpayYearlyPlanId = mockId('plan_yearly');
          logger.warn({ planId, err }, 'Razorpay Plans API failed in dev — using mock');
        } else {
          logger.error({ planId, err }, 'Failed to create Razorpay yearly plan');
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.subscriptionPlan.update({ where: { id: planId }, data: updates });
    }
  }

  // ─── Manual Payment Flow (existing) ───────────────────────

  async createOrder(userId: string, planId: string, billingCycle: 'monthly' | 'yearly') {
    // Block if user already has an active subscription
    const existingSub = await getEffectiveSubscription(userId);
    if (existingSub && existingSub.status === 'active') {
      throw AppError.badRequest(
        'You already have an active subscription. Please cancel your current subscription before purchasing a new one.',
      );
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw AppError.notFound('Plan not found');
    if (!plan.allowManual) throw AppError.badRequest('Manual payment is not available for this plan');

    const amount = billingCycle === 'monthly' ? plan.priceMonthly : plan.priceYearly;
    if (!amount) throw AppError.badRequest('This plan requires contacting sales');

    if (!env.RAZORPAY_KEY_ID || env.RAZORPAY_KEY_ID.includes('your_key')) {
      throw AppError.badRequest('Payment gateway is not configured. Please contact administrator.');
    }

    const amountInPaise = Math.round(Number(amount) * 100);

    let orderId: string;
    try {
      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `sub_${userId.slice(0, 8)}_${Date.now()}`,
        notes: { userId, planId, billingCycle },
      });
      orderId = order.id;
    } catch (err) {
      if (isDevMode()) {
        orderId = mockId('order');
        logger.warn({ err }, 'Razorpay Orders API failed in dev — using mock');
      } else {
        throw AppError.badRequest('Failed to create payment order');
      }
    }

    await prisma.subscriptionPayment.create({
      data: {
        userId,
        razorpayOrderId: orderId,
        amount: Number(amount),
        currency: 'INR',
        status: 'created',
        planId,
        billingCycle,
      },
    });

    return {
      orderId,
      amount: amountInPaise,
      currency: 'INR',
      keyId: env.RAZORPAY_KEY_ID,
      planName: plan.name,
    };
  }

  async verifyPayment(
    userId: string,
    data: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  ) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = data;

    // Dev mode: skip signature verification for mock orders
    if (!razorpay_order_id.startsWith('order_dev_')) {
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        throw AppError.badRequest('Payment verification failed: Invalid signature');
      }
    }

    const payment = await prisma.subscriptionPayment.findUnique({
      where: { razorpayOrderId: razorpay_order_id },
      include: { plan: true },
    });

    if (!payment) throw AppError.notFound('Payment record not found');
    if (payment.userId !== userId) throw AppError.forbidden('Unauthorized');
    if (payment.status === 'paid') throw AppError.badRequest('Payment already processed');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.notFound('User not found');

    const startDate = new Date();
    const endDate = new Date();
    if (payment.billingCycle === 'yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { razorpayPaymentId: razorpay_payment_id, razorpaySignature: razorpay_signature, status: 'paid' },
      });

      const subscription = await tx.userSubscription.create({
        data: {
          userId,
          planId: payment.planId,
          startDate,
          endDate,
          status: 'active',
          billingCycle: payment.billingCycle === 'yearly' ? 'yearly' : 'monthly',
          subscriptionPaymentMethod: 'manual',
          autoRenew: false,
        },
      });

      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { userSubscriptionId: subscription.id },
      });

      // Sync features to all hospitals owned by this user
      if (payment.plan.features && typeof payment.plan.features === 'object') {
        await this.syncAllUserHospitalFeatures(tx, userId, payment.plan.features as Record<string, boolean>);
      }

      return subscription;
    });

    // After payment: sync features to all hospitals owned by the user and reactivate them
    const payingUser = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (payingUser) {
      await this.syncUserHospitalFeatures(payingUser.email, payment.plan);
    }

    logger.info({ userId, subscriptionId: result.id }, 'Manual subscription activated');

    return {
      subscriptionId: result.id,
      planName: payment.plan.name,
      startDate: result.startDate,
      endDate: result.endDate,
      status: result.status,
    };
  }

  // ─── AutoPay Flow (Razorpay Subscriptions API) ────────────

  async createAutoPaySubscription(userId: string, planId: string, billingCycle: 'monthly' | 'yearly') {
    // Block if user already has an active subscription
    const existingSub = await getEffectiveSubscription(userId);
    if (existingSub && existingSub.status === 'active') {
      throw AppError.badRequest(
        'You already have an active subscription. Please cancel your current subscription before purchasing a new one.',
      );
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw AppError.notFound('Plan not found');
    if (!plan.allowAutopay) throw AppError.badRequest('AutoPay is not available for this plan');

    const rzpPlanId = billingCycle === 'monthly'
      ? plan.razorpayMonthlyPlanId
      : plan.razorpayYearlyPlanId;

    if (!rzpPlanId) {
      throw AppError.badRequest(`No Razorpay plan configured for ${billingCycle} billing. Contact admin.`);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.notFound('User not found');

    let razorpaySubscriptionId: string;
    let shortUrl: string;

    try {
      const totalCount = billingCycle === 'monthly' ? 120 : 10; // up to 10 years
      const sub = await (razorpay as any).subscriptions.create({
        plan_id: rzpPlanId,
        total_count: totalCount,
        customer_notify: 1,
        notes: { userId, planId, billingCycle },
      });
      razorpaySubscriptionId = sub.id;
      shortUrl = sub.short_url;
    } catch (err) {
      if (isDevMode()) {
        razorpaySubscriptionId = mockId('sub');
        shortUrl = `${env.FRONTEND_URL}/select-hospital?mock_sub=1`;
        logger.warn({ err, planId }, 'Razorpay Subscriptions API failed in dev — using mock');
      } else {
        const msg = (err as any)?.error?.description || (err as Error)?.message || 'Failed to create subscription';
        logger.error({ err, planId, userId }, 'Razorpay subscription creation failed');
        throw AppError.badRequest(`AutoPay setup failed: ${msg}`);
      }
    }

    const startDate = new Date();
    const endDate = new Date();
    if (billingCycle === 'yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const subscription = await prisma.userSubscription.create({
      data: {
        userId,
        planId,
        startDate,
        endDate,
        status: 'active',
        billingCycle,
        razorpaySubscriptionId,
        subscriptionPaymentMethod: 'autopay',
        autoRenew: true,
      },
    });

    // Sync features to all hospitals owned by the user
    if (plan.features && typeof plan.features === 'object') {
      await this.syncUserHospitalFeatures(user.email, plan);
    }

    logger.info({ userId, subscriptionId: subscription.id, razorpaySubscriptionId }, 'AutoPay subscription created');

    return {
      subscriptionId: subscription.id,
      razorpaySubscriptionId,
      shortUrl,
      planName: plan.name,
    };
  }

  // ─── Subscription Webhooks ────────────────────────────────

  async handleSubscriptionWebhook(rawBody: Buffer | string, signature: string) {
    // Verify webhook signature
    if (env.RAZORPAY_WEBHOOK_SECRET) {
      const expectedSig = crypto
        .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

      if (expectedSig !== signature) {
        throw AppError.unauthorized('Invalid webhook signature');
      }
    }

    const payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString());
    const event = payload.event as string;

    logger.info({ event }, 'Subscription webhook received');

    switch (event) {
      case 'subscription.charged':
        await this.handleSubscriptionCharged(payload);
        break;
      case 'subscription.cancelled':
        await this.handleSubscriptionCancelled(payload);
        break;
      case 'subscription.halted':
        await this.handleSubscriptionHalted(payload);
        break;
      case 'payment.failed': {
        const subId = payload.payload?.payment?.entity?.subscription_id;
        if (subId) await this.handleSubscriptionPaymentFailed(payload, subId);
        break;
      }
      case 'payment.captured': {
        const subId = payload.payload?.payment?.entity?.subscription_id;
        if (subId) await this.handleSubscriptionCharged(payload);
        break;
      }
      default:
        logger.info({ event }, 'Unhandled subscription webhook event');
    }

    return { received: true };
  }

  private async handleSubscriptionCharged(payload: any) {
    const rzpSubId = payload.payload?.subscription?.entity?.id ||
      payload.payload?.payment?.entity?.subscription_id;
    if (!rzpSubId) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpaySubscriptionId: rzpSubId },
      include: { plan: true },
    });

    if (!sub) {
      logger.warn({ rzpSubId }, 'Subscription not found for webhook charge event');
      return;
    }

    // Extend end date
    const newEndDate = new Date(sub.endDate || new Date());
    if (sub.billingCycle === 'yearly') {
      newEndDate.setFullYear(newEndDate.getFullYear() + 1);
    } else {
      newEndDate.setMonth(newEndDate.getMonth() + 1);
    }

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { endDate: newEndDate, status: 'active', lastReminderDays: null },
    });

    // Create payment record
    const paymentEntity = payload.payload?.payment?.entity;
    if (paymentEntity) {
      await prisma.subscriptionPayment.create({
        data: {
          userId: sub.userId,
          razorpayOrderId: paymentEntity.order_id || `webhook_${Date.now()}`,
          razorpayPaymentId: paymentEntity.id,
          amount: paymentEntity.amount / 100,
          currency: paymentEntity.currency || 'INR',
          status: 'paid',
          planId: sub.planId,
          billingCycle: sub.billingCycle || 'monthly',
          userSubscriptionId: sub.id,
        },
      }).catch((err) => {
        logger.warn({ err, rzpSubId }, 'Failed to create payment record from webhook (possible duplicate)');
      });
    }

    // Send notification
    await this.createUserSubscriptionNotification(
      sub.userId,
      'Payment Successful',
      `Your ${sub.plan.name} subscription payment was successful. Next billing: ${formatDateIST(newEndDate)}.`,
      sub.id,
    );

    logger.info({ subscriptionId: sub.id, newEndDate }, 'Subscription charged — extended');
  }

  private async handleSubscriptionCancelled(payload: any) {
    const rzpSubId = payload.payload?.subscription?.entity?.id;
    if (!rzpSubId) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpaySubscriptionId: rzpSubId },
      include: { plan: true },
    });
    if (!sub) return;

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { autoRenew: false, cancelledAt: new Date() },
    });

    await this.createUserSubscriptionNotification(
      sub.userId,
      'Subscription Cancelled',
      `Your ${sub.plan.name} subscription has been cancelled. Access continues until ${sub.endDate ? formatDateIST(new Date(sub.endDate)) : 'further notice'}.`,
      sub.id,
    );

    logger.info({ subscriptionId: sub.id }, 'Subscription cancelled via webhook');
  }

  private async handleSubscriptionHalted(payload: any) {
    const rzpSubId = payload.payload?.subscription?.entity?.id;
    if (!rzpSubId) return;

    const sub = await prisma.userSubscription.findUnique({
      where: { razorpaySubscriptionId: rzpSubId },
      include: { plan: true },
    });
    if (!sub) return;

    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { status: 'expired', autoRenew: false },
    });

    await this.createUserSubscriptionNotification(
      sub.userId,
      'Subscription Expired',
      `Your ${sub.plan.name} subscription has expired due to payment failures. Please renew to continue access.`,
      sub.id,
    );

    logger.info({ subscriptionId: sub.id }, 'Subscription halted — expired');
  }

  private async handleSubscriptionPaymentFailed(payload: any, rzpSubId: string) {
    const sub = await prisma.userSubscription.findUnique({
      where: { razorpaySubscriptionId: rzpSubId },
      include: { plan: true },
    });
    if (!sub) return;

    await this.createUserSubscriptionNotification(
      sub.userId,
      'Payment Failed',
      `A payment for your ${sub.plan.name} subscription failed. Razorpay will retry automatically. Please ensure your payment method is valid.`,
      sub.id,
    );

    logger.warn({ subscriptionId: sub.id }, 'Subscription payment failed — will retry');
  }

  private async createUserSubscriptionNotification(
    userId: string,
    title: string,
    message: string,
    subscriptionId: string,
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!user) return;

    await prisma.notification.create({
      data: {
        tenantId: user.tenantId,
        userId,
        title,
        message,
        notificationType: 'subscription',
        channel: 'in_app',
        referenceType: 'subscription',
        referenceId: subscriptionId,
      },
    }).catch((err) => {
      logger.warn({ err, userId }, 'Failed to create subscription notification');
    });
  }

  // ─── Plan Change (Upgrade/Downgrade) ──────────────────────

  async changePlan(
    userId: string,
    newPlanId: string,
    billingCycle: 'monthly' | 'yearly',
    paymentMethod: 'manual' | 'autopay',
  ) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.notFound('User not found');

    const newPlan = await prisma.subscriptionPlan.findUnique({ where: { id: newPlanId } });
    if (!newPlan || !newPlan.isActive) throw AppError.notFound('Plan not found or inactive');

    // Get current active subscription (user-owned)
    const currentSub = await getEffectiveSubscription(userId);

    // Cancel current autopay subscription on Razorpay
    if (currentSub?.razorpaySubscriptionId && currentSub.subscriptionPaymentMethod === 'autopay') {
      try {
        await (razorpay as any).subscriptions.cancel(currentSub.razorpaySubscriptionId);
      } catch (err) {
        logger.warn({ err, subId: currentSub.razorpaySubscriptionId }, 'Failed to cancel Razorpay subscription');
      }
    }

    // Expire current subscription
    if (currentSub) {
      await prisma.userSubscription.update({
        where: { id: currentSub.id },
        data: { status: 'cancelled', cancelledAt: new Date(), autoRenew: false },
      });
    }

    // Calculate pro-rated credit
    let creditDays = 0;
    if (currentSub?.endDate) {
      const now = new Date();
      const end = new Date(currentSub.endDate);
      creditDays = Math.max(0, Math.floor((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    // Create new subscription based on payment method
    if (paymentMethod === 'autopay') {
      return this.createAutoPaySubscription(userId, newPlanId, billingCycle);
    } else {
      return this.createOrder(userId, newPlanId, billingCycle);
    }
  }

  // ─── User Management Endpoints ────────────────────────────

  async getMySubscription(userId: string) {
    const subscription = await getEffectiveSubscription(userId);
    if (!subscription) {
      return { active: false, subscription: null, daysRemaining: 0 };
    }

    const now = new Date();
    const endDate = subscription.endDate ? new Date(subscription.endDate) : null;
    const daysRemaining = endDate
      ? Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      active: subscription.status === 'active',
      subscription: {
        id: subscription.id,
        planId: subscription.planId,
        plan: subscription.plan,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        status: subscription.status,
        billingCycle: subscription.billingCycle,
        subscriptionPaymentMethod: subscription.subscriptionPaymentMethod,
        autoRenew: subscription.autoRenew,
      },
      daysRemaining,
    };
  }

  async cancelSubscription(userId: string) {
    const sub = await getEffectiveSubscription(userId);
    if (!sub || sub.status !== 'active') {
      throw AppError.badRequest('No active subscription to cancel');
    }

    // Cancel autopay on Razorpay
    if (sub.razorpaySubscriptionId && sub.subscriptionPaymentMethod === 'autopay') {
      try {
        await (razorpay as any).subscriptions.cancel(sub.razorpaySubscriptionId);
        logger.info({ rzpSubId: sub.razorpaySubscriptionId }, 'Razorpay subscription cancelled');
      } catch (err) {
        if (!isDevMode()) {
          logger.error({ err, rzpSubId: sub.razorpaySubscriptionId }, 'Failed to cancel Razorpay subscription');
          throw AppError.badRequest('Failed to cancel subscription on payment gateway. Please try again or contact support.');
        }
      }
    }

    // Mark subscription as cancelled immediately in our DB
    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'cancelled',
        autoRenew: false,
        cancelledAt: new Date(),
      },
    });

    await this.createUserSubscriptionNotification(
      userId,
      'Subscription Cancelled',
      `Your ${sub.plan.name} subscription has been cancelled. You can purchase a new plan anytime from Manage Subscription.`,
      sub.id,
    );

    logger.info({ userId, subscriptionId: sub.id }, 'Subscription cancelled by user');

    return { message: 'Subscription cancelled successfully. You can purchase a new plan anytime.' };
  }

  /**
   * Turn off auto-renew: cancels the Razorpay recurring subscription but keeps
   * the plan active until endDate. After endDate it will expire naturally.
   */
  async turnOffAutoRenew(userId: string) {
    const sub = await getEffectiveSubscription(userId);
    if (!sub || sub.status !== 'active') {
      throw AppError.badRequest('No active subscription');
    }
    if (!sub.autoRenew) {
      throw AppError.badRequest('Auto-renew is already off');
    }

    // Cancel recurring subscription on Razorpay
    if (sub.razorpaySubscriptionId && sub.subscriptionPaymentMethod === 'autopay') {
      try {
        await (razorpay as any).subscriptions.cancel(sub.razorpaySubscriptionId);
        logger.info({ rzpSubId: sub.razorpaySubscriptionId }, 'Razorpay auto-renew cancelled');
      } catch (err) {
        if (!isDevMode()) {
          logger.error({ err, rzpSubId: sub.razorpaySubscriptionId }, 'Failed to cancel Razorpay auto-renew');
          throw AppError.badRequest('Failed to turn off auto-renew on payment gateway. Please try again or contact support.');
        }
      }
    }

    // Keep subscription active but stop auto-renew
    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { autoRenew: false },
    });

    await this.createUserSubscriptionNotification(
      userId,
      'Auto-Renew Turned Off',
      `Auto-renew has been turned off for your ${sub.plan.name} plan. Your subscription will remain active until ${sub.endDate ? formatDateIST(new Date(sub.endDate)) : 'the end of your billing period'}.`,
      sub.id,
    );

    logger.info({ userId, subscriptionId: sub.id }, 'Auto-renew turned off');

    return {
      message: `Auto-renew turned off. Your plan remains active until ${sub.endDate ? formatDateIST(new Date(sub.endDate)) : 'the end of your billing period'}.`,
    };
  }

  /**
   * Get plans offered to the current user by super admin.
   * Reads the latest 'subscription' notification with referenceType='offered_plans'.
   */
  /**
   * Super admin: list all users who have been offered plans.
   */
  async listPlanAssignments() {
    const notifications = await prisma.notification.findMany({
      where: { referenceType: 'offered_plans', notificationType: 'subscription' },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    // Deduplicate by userId (latest only)
    const seen = new Set<string>();
    const unique = notifications.filter((n) => {
      if (seen.has(n.userId)) return false;
      seen.add(n.userId);
      return true;
    });

    // Resolve plan names for each
    const results = [];
    for (const n of unique) {
      const planIds = (n.referenceId || '').split(',').filter(Boolean);
      if (planIds.length === 0) continue;

      const plans = await prisma.subscriptionPlan.findMany({
        where: { id: { in: planIds } },
        select: { id: true, name: true },
      });

      results.push({
        userId: n.user.id,
        userName: `${n.user.firstName} ${n.user.lastName || ''}`.trim(),
        email: n.user.email,
        plans,
        assignedAt: n.createdAt,
      });
    }

    return results;
  }

  async getOfferedPlans(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, tenantId: true } });
    if (!user) return [];

    // Find platform user to check notifications on platform tenant
    const platformUser = await prisma.user.findFirst({
      where: { email: user.email, tenant: { slug: '__platform__' } },
      select: { id: true, tenantId: true },
    });

    const targetUserId = platformUser?.id || userId;
    const targetTenantId = platformUser?.tenantId || user.tenantId;

    // Find the latest offered_plans notification
    const notification = await prisma.notification.findFirst({
      where: {
        userId: targetUserId,
        tenantId: targetTenantId,
        notificationType: 'subscription',
        referenceType: 'offered_plans',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!notification?.referenceId) return [];

    const planIds = notification.referenceId.split(',').filter(Boolean);
    if (planIds.length === 0) return [];

    const plans = await prisma.subscriptionPlan.findMany({
      where: { id: { in: planIds } },
      orderBy: { priceMonthly: 'asc' },
    });

    return plans;
  }

  async getPaymentHistory(userId: string) {
    return prisma.subscriptionPayment.findMany({
      where: { userId, status: { in: ['paid', 'created', 'failed'] } },
      include: { plan: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ─── Dev Helper ───────────────────────────────────────────

  async devActivateSubscription(userId: string, planId: string, days: number) {
    if (!isDevMode()) throw AppError.forbidden('Only available in development mode');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw AppError.notFound('User not found');

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw AppError.notFound('Plan not found');

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    await prisma.userSubscription.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'expired' },
    });

    const sub = await prisma.userSubscription.create({
      data: {
        userId,
        planId,
        startDate,
        endDate,
        status: 'active',
        billingCycle: 'monthly',
        subscriptionPaymentMethod: 'manual',
      },
    });

    if (plan.features && typeof plan.features === 'object') {
      await this.syncUserHospitalFeatures(user.email, plan);
    }

    return sub;
  }

  // ─── Super Admin: Assign Plan to User ─────────────────────

  /**
   * Super admin offers 1 or more plans to a user.
   * The user then picks their preferred plan, chooses billing cycle (monthly/yearly),
   * and completes payment to activate.
   * A notification is sent with the plan options.
   */
  async adminAssignPlan(data: {
    userId: string;
    planIds: string[];
  }) {
    if (!data.planIds.length) throw AppError.badRequest('At least one plan is required');

    const user = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { id: true, email: true, firstName: true, lastName: true, tenantId: true },
    });
    if (!user) throw AppError.notFound('User not found');

    const plans = await prisma.subscriptionPlan.findMany({
      where: { id: { in: data.planIds } },
    });
    if (plans.length === 0) throw AppError.notFound('No valid plans found');

    // Resolve platform tenant
    const platformUser = await prisma.user.findFirst({
      where: { email: user.email, tenant: { slug: '__platform__' } },
      select: { id: true, tenantId: true },
    });
    const targetTenantId = platformUser?.tenantId || user.tenantId;

    const planNames = plans.map((p) => p.name).join(', ');

    // Store offered plans as a notification with referenceType 'offered_plans'
    const targetUserId = platformUser?.id || user.id;
    await prisma.notification.create({
      data: {
        tenantId: targetTenantId,
        userId: targetUserId,
        title: 'New Plans Available',
        message: `Your administrator has offered you the following plan${plans.length > 1 ? 's' : ''}: ${planNames}. Please go to Manage Subscription to choose a plan and complete payment.`,
        notificationType: 'subscription',
        channel: 'in_app',
        referenceType: 'offered_plans',
        referenceId: data.planIds.join(','),
      },
    }).catch(() => {});

    // Also reactivate hospitals so user can log in and see the plans page
    const allUserIds = await prisma.user.findMany({
      where: { email: user.email },
      select: { id: true },
    });
    const ownerships = await prisma.tenantOwner.findMany({
      where: { userId: { in: allUserIds.map((u) => u.id) }, tenant: { slug: { not: '__platform__' } } },
      select: { tenantId: true },
    });
    if (ownerships.length > 0) {
      await prisma.tenant.updateMany({
        where: { id: { in: ownerships.map((o) => o.tenantId) }, isActive: false },
        data: { isActive: true },
      });
    }

    logger.info(
      { userId: data.userId, planIds: data.planIds, planNames },
      'Super admin offered plans to user',
    );

    return { plans, user };
  }

  /**
   * Helper: Sync plan features to all hospitals owned by a user (by email) and reactivate them.
   */
  private async syncUserHospitalFeatures(email: string, plan: { features: any }) {
    if (!plan.features || typeof plan.features !== 'object') return;

    const features = plan.features as Record<string, boolean>;
    const allUserIds = await prisma.user.findMany({
      where: { email },
      select: { id: true },
    });
    const ownerships = await prisma.tenantOwner.findMany({
      where: { userId: { in: allUserIds.map((u) => u.id) }, tenant: { slug: { not: '__platform__' } } },
      select: { tenantId: true },
    });

    for (const ownership of ownerships) {
      for (const [featureKey, isEnabled] of Object.entries(features)) {
        await prisma.featureToggle.upsert({
          where: { tenantId_featureKey: { tenantId: ownership.tenantId, featureKey } },
          update: { isEnabled },
          create: { tenantId: ownership.tenantId, featureKey, isEnabled, config: {} },
        });
      }
    }

    if (ownerships.length > 0) {
      await prisma.tenant.updateMany({
        where: { id: { in: ownerships.map((o) => o.tenantId) }, isActive: false },
        data: { isActive: true },
      });
    }
  }

  /**
   * Transaction-aware version: Sync plan features to all hospitals owned by a user.
   * Used inside $transaction blocks.
   */
  private async syncAllUserHospitalFeatures(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
    features: Record<string, boolean>,
  ) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return;

    const allUserIds = await tx.user.findMany({
      where: { email: user.email },
      select: { id: true },
    });
    const ownerships = await tx.tenantOwner.findMany({
      where: { userId: { in: allUserIds.map((u) => u.id) }, tenant: { slug: { not: '__platform__' } } },
      select: { tenantId: true },
    });

    for (const ownership of ownerships) {
      for (const [featureKey, isEnabled] of Object.entries(features)) {
        await tx.featureToggle.upsert({
          where: { tenantId_featureKey: { tenantId: ownership.tenantId, featureKey } },
          update: { isEnabled },
          create: { tenantId: ownership.tenantId, featureKey, isEnabled, config: {} },
        });
      }
    }

    // Reactivate hospitals
    if (ownerships.length > 0) {
      await tx.tenant.updateMany({
        where: { id: { in: ownerships.map((o) => o.tenantId) }, isActive: false },
        data: { isActive: true },
      });
    }
  }
}
