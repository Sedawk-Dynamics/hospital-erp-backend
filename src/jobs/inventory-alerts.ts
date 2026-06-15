import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { runInventoryAlerts } from '../modules/inventory/inventory.service';

/**
 * Daily inventory alert sweep across all active tenants. For each tenant it
 * scans low-stock items and soon-to-expire batches and notifies the configured
 * recipient roles ("alert inventory manager"), optionally auto-flagging fully
 * expired batches when the tenant has that switch on.
 *
 * Alerts are de-duplicated against existing unread notifications inside
 * runInventoryAlerts, so this can run on a schedule without spamming.
 *
 * An actor user id is required for any auto-flag stock writes; we pick an
 * active admin / inventory_manager / pharmacy_admin for the tenant and skip the
 * tenant if none exists.
 */
export async function runInventoryAlertsJob() {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  let processed = 0;
  for (const tenant of tenants) {
    try {
      const actor = await prisma.user.findFirst({
        where: {
          tenantId: tenant.id,
          isActive: true,
          userRoles: { some: { role: { name: { in: ['admin', 'inventory_manager', 'pharmacy_admin'] } } } },
        },
        select: { id: true },
      });
      if (!actor) continue;

      const result = await runInventoryAlerts(tenant.id, actor.id);
      if (result.lowStockAlerts || result.expiryAlerts || result.expiredFlagged) {
        logger.info({ tenantId: tenant.id, ...result }, 'Inventory alerts dispatched');
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'Inventory alert run failed for tenant');
    }
  }

  return { tenants: processed };
}
