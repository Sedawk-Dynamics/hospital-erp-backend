// ---------------------------------------------------------------------------
// The filed-period lock.
//
// Section 6.10: "Once a return period is marked filed, the whole period is
// locked. A late entry has to be posted in the current period, which is what
// the law expects." Section 12 says it again, and acceptance scenario 24 is
// exactly this — editing a bill in a filed period is refused, and the user is
// told to raise a credit note in the current period instead.
//
// Nothing enforced it. `gst_filed_periods` was an archive of the figures as
// filed and no bill mutation anywhere consulted it, so a September bill could
// be edited in November and the books would quietly stop matching the return
// the hospital had already submitted.
//
// TWO SEPARATE ACTS. Filing archives the figures; locking shuts the doors. A
// hospital wants the snapshot the moment it files and may not want the period
// closed until it has checked, so a period is only locked when somebody locks
// it. Nothing that works today starts failing because of this file.
// ---------------------------------------------------------------------------

import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { AppError } from './appError';

/** A short cache: the lock list changes when an accountant closes a month. */
const TTL_MS = 30_000;
const cache = new Map<string, { rows: Array<{ from: Date; to: Date; period: string }>; at: number }>();

/** Called after a period is locked or unlocked, and by tests. */
export function clearPeriodLockCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function lockedPeriods(tenantId: string) {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < TTL_MS) return hit.rows;
  const rows = (
    await prisma.gstFiledPeriod.findMany({
      where: { tenantId, lockedAt: { not: null } },
      select: { periodFrom: true, periodTo: true, returnPeriod: true },
    })
  ).map((r) => ({ from: r.periodFrom, to: r.periodTo, period: r.returnPeriod }));
  cache.set(tenantId, { rows, at: now });
  return rows;
}

/** The locked period a date falls in, or null. */
export async function lockedPeriodFor(
  tenantId: string,
  on: Date,
): Promise<{ period: string; from: Date; to: Date } | null> {
  let rows;
  try {
    rows = await lockedPeriods(tenantId);
  } catch (err) {
    // A guard that cannot read must not block the hospital from billing.
    logger.warn({ err, tenantId }, 'Could not read the filed-period locks — the guard is skipped');
    return null;
  }
  // Compared on the calendar day, so a bill raised at 23:30 on the last day of
  // a locked month is inside it.
  const day = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate()));
  const hit = rows.find((r) => {
    const from = new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), r.from.getUTCDate()));
    const to = new Date(Date.UTC(r.to.getUTCFullYear(), r.to.getUTCMonth(), r.to.getUTCDate()));
    return day >= from && day <= to;
  });
  return hit ? { period: hit.period, from: hit.from, to: hit.to } : null;
}

/**
 * Refuse a write that would change a bill inside a locked return period.
 *
 * The message says what to do instead, because "refused" on its own leaves the
 * counter stuck: the correction is a credit note in the CURRENT period, which
 * is what the law expects and what the system can already issue.
 */
export async function assertPeriodOpen(
  tenantId: string,
  on: Date | null | undefined,
  what = 'this bill',
): Promise<void> {
  if (!on) return;
  const locked = await lockedPeriodFor(tenantId, on);
  if (!locked) return;
  throw AppError.conflict(
    `Return period ${locked.period} has been filed and locked, so ${what} cannot be changed. ` +
      'Raise a credit note in the current period instead — that is how a correction to a filed ' +
      'month is made.',
  );
}
