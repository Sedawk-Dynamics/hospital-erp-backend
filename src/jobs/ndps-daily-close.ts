import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { runDailyClose } from '../modules/ndps/ndps.service';

/** YYYY-MM-DD for a Date (local), for the runDailyClose date argument. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Nightly NDPS Form 3H cutoff. For every active tenant it closes the day's
 * narcotic books — opening + received − dispensed − disposed = closing — and
 * hard-writes one Form 3H row per Essential Narcotic Drug for the day. Idempotent
 * (re-running a date overwrites it), so it is safe on any schedule.
 *
 * Because this runs hourly (not exactly at 23:59:59), it closes BOTH the current
 * date AND the previous date. Re-closing today keeps it current through the day;
 * re-closing yesterday guarantees the just-ended day's final hour (any 23:00–23:59
 * activity, plus anything booked after the last pre-midnight run) is captured on
 * the correct date's Form 3H once the clock rolls past midnight.
 */
export async function runNdpsDailyCloseJob() {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const now = new Date();
  const today = ymd(now);
  const yesterday = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  let processed = 0;
  for (const tenant of tenants) {
    try {
      // Backfill the previous day's tail first, then re-close today.
      const prev = await runDailyClose(tenant.id, yesterday);
      const result = await runDailyClose(tenant.id, today);
      const drugs = Math.max(result.count ?? 0, prev.count ?? 0);
      if (drugs > 0) {
        logger.info({ tenantId: tenant.id, drugs }, 'NDPS Form 3H daily close written (today + yesterday tail)');
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'NDPS daily close failed for tenant');
    }
  }
  return { tenants: processed };
}
