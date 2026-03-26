import { prisma } from '../config/database';

const PLAN_SELECT = {
  id: true,
  name: true,
  description: true,
  priceMonthly: true,
  priceYearly: true,
  maxUsers: true,
  maxHospitals: true,
  features: true,
  isActive: true,
};

const SUBSCRIPTION_INCLUDE = {
  plan: { select: PLAN_SELECT },
  subscriptionPayments: {
    take: 1,
    orderBy: { createdAt: 'desc' as const },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
};

/**
 * Resolve the effective subscription for a user.
 *
 * Subscriptions are owned by users, not tenants/hospitals.
 * A single subscription covers all hospitals the user creates.
 *
 * Resolution:
 *   1. Check if this userId has a direct active UserSubscription.
 *   2. If not, resolve the user's email → find all user records with
 *      that email → check if any of them has an active subscription.
 *
 * This handles the case where the caller is using a hospital-scoped
 * userId but the subscription was purchased under their platform userId.
 */
export async function getEffectiveSubscription(userId: string) {
  // 1. Direct subscription on this user
  const directSub = await prisma.userSubscription.findFirst({
    where: { userId, status: 'active' },
    include: SUBSCRIPTION_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  if (directSub) return directSub;

  // 2. Resolve email → find subscription on any of the user's accounts
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user) return null;

  const allUserIds = await prisma.user.findMany({
    where: { email: user.email },
    select: { id: true },
  });

  const otherIds = allUserIds.map((u) => u.id).filter((id) => id !== userId);
  if (otherIds.length === 0) return null;

  const sub = await prisma.userSubscription.findFirst({
    where: { userId: { in: otherIds }, status: 'active' },
    include: SUBSCRIPTION_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  return sub;
}

/**
 * Resolve the effective subscription for a tenant (hospital).
 *
 * Looks up the tenant owner and resolves their user subscription.
 * Used by middleware that only has tenantId context.
 */
export async function getEffectiveSubscriptionByTenantId(tenantId: string) {
  const owner = await prisma.tenantOwner.findFirst({
    where: { tenantId },
    select: { userId: true },
  });

  if (!owner) return null;

  return getEffectiveSubscription(owner.userId);
}
