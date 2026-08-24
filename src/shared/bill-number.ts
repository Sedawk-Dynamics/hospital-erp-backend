// ---------------------------------------------------------------------------
// Allocating a number in a dated bill series (`IPW-20260824-0001`).
//
// `Bill.billNumber` is `@unique` — GLOBALLY, not per tenant. Four ward charge
// paths built the sequence from a TENANT-SCOPED count:
//
//     const seq = await tx.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
//
// which is wrong twice over:
//
//   • Two hospitals dispensing on the same day both see no `IPW-` bills of
//     their own, both compute `…-0001`, and the second one violates the unique
//     index. The enclosing transaction rolls back and the nurse gets a 500.
//     Reproduced against the dev database with two real tenants.
//   • Within one tenant, a count repeats a live number as soon as the sequence
//     has a gap — which any deleted bill leaves behind.
//
// Both are fixed by taking the MAXIMUM existing number for the day ACROSS ALL
// TENANTS, which is the scope the constraint actually has. That is what
// `getOrCreateRunningIpBill` and the OT kit path already do.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not retry after a collision.
// `getOrCreateRunningIpBill` can, because it runs on `prisma` outside a
// transaction. Every caller here runs inside `$transaction`, and in Postgres a
// unique violation ABORTS the transaction — every later statement on that
// connection fails with "current transaction is aborted", so a retry loop
// inside the transaction cannot work. Verified against the dev database rather
// than assumed.
//
// So a same-instant race between two dispenses in the same hospital can still
// lose: both read the same maximum inside their own transactions and the second
// commit is refused. The outcome is safe — the whole transaction rolls back, so
// no stock moves and no charge is posted — and {@link isBillNumberClash} lets
// the caller turn it into a plain "please retry" instead of a 500. Closing that
// window properly needs either an `INSERT … ON CONFLICT DO NOTHING` reservation
// or retrying the whole transaction from outside, the way the pharmacy POS does
// (`runSaleTx(attempt)`); neither is done here.
//
// The day part comes from `getISTDateStr()` — the hospital's own calendar day,
// independent of the host's timezone.
// ---------------------------------------------------------------------------

import { AppError } from './appError';
import { getISTDateStr } from './date.utils';

/** Width of the sequence part, so `billNumber desc` sorts numerically. */
const SEQ_WIDTH = 4;

/**
 * The `SERIES-YYYYMMDD-` prefix a number in this series is built on, for today
 * in IST. Exported so a caller that needs to look the series up (a day's bills,
 * a report) uses the same string the allocator does.
 */
export function billSeriesPrefix(series: string): string {
  return `${series}-${getISTDateStr()}-`;
}

/**
 * The next free number in a dated series.
 *
 * The maximum is read across ALL tenants, because `bill_number` is unique
 * across all tenants. Reading it per tenant is the bug this replaces.
 *
 * @param tx      Prisma client or transaction client — works on either.
 * @param series  series code, e.g. `IPW` (ward/IP) or `OTK` (OT kit).
 */
export async function nextBillNumberInSeries(tx: any, series: string): Promise<string> {
  const prefix = billSeriesPrefix(series);
  // Ordering by the string works because the sequence is zero-padded to a fixed
  // width, so lexicographic order is numeric order.
  const last = await tx.bill.findFirst({
    where: { billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  });
  const lastSeq = last ? parseInt(last.billNumber.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(lastSeq + 1).padStart(SEQ_WIDTH, '0')}`;
}

/** True for the unique-constraint error raised by two bills claiming a number. */
export function isBillNumberClash(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f.includes('bill_number') || f.includes('billNumber'));
}

/**
 * Create a bill with the next free number in a dated series.
 *
 * A lost race surfaces as a retriable 400 rather than an unhandled constraint
 * error — the transaction is rolling back either way, so the only question is
 * whether the nurse is told something useful.
 *
 * @param data  the bill to create, minus `billNumber`.
 */
export async function createBillInSeries(
  tx: any,
  series: string,
  data: Record<string, unknown>,
): Promise<any> {
  const billNumber = await nextBillNumberInSeries(tx, series);
  try {
    return await tx.bill.create({ data: { ...data, billNumber } });
  } catch (err) {
    if (isBillNumberClash(err)) {
      throw AppError.badRequest(
        'Another bill claimed this number at the same moment. Nothing was saved — please retry.',
      );
    }
    throw err;
  }
}
