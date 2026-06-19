import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { runDailyClose } from '../modules/ndps/ndps.service';

/**
 * Nightly NDPS Form 3H cutoff. For every active tenant it closes the day's
 * narcotic books — opening + received − dispensed − disposed = closing — and
 * hard-writes one Form 3H row per Essential Narcotic Drug for the day. Idempotent
 * (re-running a date overwrites it), so it is safe on any schedule.
 */
export async function runNdpsDailyCloseJob() {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  let processed = 0;
  for (const tenant of tenants) {
    try {
      const result = await runDailyClose(tenant.id);
      if (result.count > 0) {
        logger.info({ tenantId: tenant.id, drugs: result.count }, 'NDPS Form 3H daily close written');
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'NDPS daily close failed for tenant');
    }
  }
  return { tenants: processed };
}
