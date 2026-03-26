import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { formatDateIST } from '../shared/date.utils';

/**
 * Check for subscriptions expiring in 7, 3, or 1 days and create reminder notifications.
 * Uses lastReminderDays to prevent duplicate notifications.
 */
export async function checkSubscriptionReminders() {
  const reminders = [7, 3, 1];

  for (const days of reminders) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const subs = await prisma.userSubscription.findMany({
      where: {
        status: 'active',
        endDate: { gte: startOfDay, lte: endOfDay },
        OR: [
          { lastReminderDays: null },
          { lastReminderDays: { gt: days } },
        ],
      },
      include: {
        plan: { select: { name: true } },
        user: { select: { id: true, tenantId: true } },
      },
    });

    for (const sub of subs) {
      await prisma.notification.create({
        data: {
          tenantId: sub.user.tenantId,
          userId: sub.userId,
          title: `Subscription expiring in ${days} day${days > 1 ? 's' : ''}`,
          message: `Your ${sub.plan.name} plan expires on ${sub.endDate ? formatDateIST(new Date(sub.endDate)) : 'soon'}. Renew now to avoid service interruption.`,
          notificationType: 'subscription',
          channel: 'in_app',
          referenceType: 'subscription',
          referenceId: sub.id,
        },
      }).catch(() => {});

      await prisma.userSubscription.update({
        where: { id: sub.id },
        data: { lastReminderDays: days },
      });
    }

    if (subs.length > 0) {
      logger.info({ days, count: subs.length }, `Sent ${days}-day subscription reminders`);
    }
  }
}

/**
 * Auto-expire subscriptions that are past their end date.
 */
export async function checkExpiredSubscriptions() {
  const now = new Date();

  // Find subs about to expire (so we can auto-offer plans)
  const expiringSubs = await prisma.userSubscription.findMany({
    where: {
      status: 'active',
      endDate: { lt: now },
      autoRenew: false,
    },
    include: {
      plan: { select: { name: true, priceMonthly: true } },
      user: { select: { id: true, email: true, tenantId: true } },
    },
  });

  if (expiringSubs.length === 0) return;

  // Expire them
  await prisma.userSubscription.updateMany({
    where: {
      status: 'active',
      endDate: { lt: now },
      autoRenew: false,
    },
    data: { status: 'expired' },
  });

  logger.info({ count: expiringSubs.length }, 'Auto-expired subscriptions past end date');

  // Auto-offer plans to users whose demo/free subs just expired
  const autoOfferPlans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true, priceMonthly: { not: null } },
    select: { id: true, name: true },
  });

  if (autoOfferPlans.length === 0) return;

  const planIds = autoOfferPlans.map((p) => p.id).join(',');
  const planNames = autoOfferPlans.map((p) => p.name).join(', ');

  for (const sub of expiringSubs) {
    // Only auto-offer for demo/free plans (no price)
    if (sub.plan.priceMonthly && Number(sub.plan.priceMonthly) > 0) continue;

    // Check if already offered recently
    const existingOffer = await prisma.notification.findFirst({
      where: {
        userId: sub.userId,
        referenceType: 'offered_plans',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (existingOffer) continue;

    await prisma.notification.create({
      data: {
        tenantId: sub.user.tenantId,
        userId: sub.userId,
        title: 'Choose a Plan to Continue',
        message: `Your trial has ended. Available plans: ${planNames}. Go to Manage Subscription to choose a plan.`,
        notificationType: 'subscription',
        channel: 'in_app',
        referenceType: 'offered_plans',
        referenceId: planIds,
      },
    }).catch(() => {});
  }
}

/**
 * Run all subscription maintenance tasks.
 */
export async function runSubscriptionJobs() {
  await checkExpiredSubscriptions();
  await checkSubscriptionReminders();
}
