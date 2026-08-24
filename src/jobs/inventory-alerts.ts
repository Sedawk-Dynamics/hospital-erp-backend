import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { runInventoryAlerts } from '../modules/inventory/inventory.service';
import { runPharmacyExpiryAlerts } from '../modules/pharmacy/pharmacy.service';
import { tenantOwnerUserIds } from '../shared/notify';

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
      // Fall back to the hospital's owner. This query is tenant-scoped and an
      // owner's account lives on the platform tenant, so a hospital whose only
      // administrator is its owner found nobody here — and the job then skipped
      // that hospital entirely, meaning no low-stock or expiry alerts at all.
      // Last resort on purpose: an existing hospital with staff in these roles
      // keeps attributing the job's stock writes to exactly who it did before.
      const actorId = actor?.id ?? (await tenantOwnerUserIds(tenant.id))[0];
      if (!actorId) continue;

      const result = await runInventoryAlerts(tenant.id, actorId);
      if (result.lowStockAlerts || result.expiryAlerts || result.expiredFlagged) {
        logger.info({ tenantId: tenant.id, ...result }, 'Inventory alerts dispatched');
      }

      // G5: pharmacy drug-batch expiry — auto-flag expired + near-expiry alerts.
      // Drug batches live in a separate store from inventory consumables, so they
      // need their own pass (honouring the same per-tenant expiry settings).
      const rxResult = await runPharmacyExpiryAlerts(tenant.id, actorId);
      if (rxResult.expiredFlagged || rxResult.expiryAlerts) {
        logger.info({ tenantId: tenant.id, ...rxResult }, 'Pharmacy expiry alerts dispatched');
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'Inventory alert run failed for tenant');
    }
  }

  return { tenants: processed };
}
