import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

// ============================================================
// Inventory notifications — "alert inventory manager".
//
// Low-stock / reorder / expiry alerts are delivered as in-app Notification
// rows to every active user whose role is in the tenant's configured
// `alertRecipientRoles` allowlist. When the allowlist is empty we fall back
// to the operational roles that own stock.
//
// Failures here must never abort the underlying stock workflow — every entry
// point is best-effort and swallows errors (logged at warn).
// ============================================================

export const DEFAULT_ALERT_RECIPIENT_ROLES = ['inventory_manager', 'pharmacy_admin', 'admin'];

/** Resolve the user IDs that should receive inventory alerts for a tenant. */
export async function getAlertRecipientUserIds(
  tenantId: string,
  roleSlugs: string[],
): Promise<string[]> {
  const roles = roleSlugs.length > 0 ? roleSlugs : DEFAULT_ALERT_RECIPIENT_ROLES;
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      isActive: true,
      userRoles: { some: { role: { name: { in: roles } } } },
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Send an inventory alert to all configured recipients. Returns the number of
 * notifications dispatched. Never throws.
 */
export async function notifyInventoryRecipients(params: {
  tenantId: string;
  recipientRoles: string[];
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
}): Promise<number> {
  try {
    const userIds = await getAlertRecipientUserIds(params.tenantId, params.recipientRoles);
    if (userIds.length === 0) return 0;

    await prisma.notification.createMany({
      data: userIds.map((userId) => ({
        tenantId: params.tenantId,
        userId,
        title: params.title,
        message: params.message,
        notificationType: 'alert' as const,
        channel: 'in_app' as const,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      })),
    });
    return userIds.length;
  } catch (err) {
    logger.warn({ err, tenantId: params.tenantId }, 'Failed to dispatch inventory notification');
    return 0;
  }
}

/**
 * True when an unread alert with the same reference already exists — used to
 * avoid re-spamming managers about the same low-stock item / expiring batch on
 * every scheduled run. Returns false on any error so a check failure can never
 * suppress a genuine alert.
 */
export async function hasOpenInventoryAlert(
  tenantId: string,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  try {
    const existing = await prisma.notification.findFirst({
      where: {
        tenantId,
        referenceType,
        referenceId,
        notificationType: 'alert',
        isRead: false,
      },
      select: { id: true },
    });
    return existing != null;
  } catch (err) {
    logger.warn({ err, tenantId, referenceType, referenceId }, 'Failed to check existing inventory alert');
    return false;
  }
}
