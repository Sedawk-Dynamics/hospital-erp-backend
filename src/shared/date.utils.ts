/**
 * Date utilities — all display dates use dd/MM/yyyy format and IST (Asia/Kolkata) timezone.
 *
 * The hospital's time zone. There is no per-hospital time-zone setting, so every
 * "today", day boundary and printed timestamp is IST. Instants are stored in UTC;
 * convert only when deciding a calendar day or rendering for a person.
 */

export const IST_TIMEZONE = 'Asia/Kolkata';

/** Get current date/time in IST */
export function nowIST(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: IST_TIMEZONE }),
  );
}

/** Format a Date as dd/MM/yyyy in IST */
export function formatDateIST(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const ist = new Date(
    d.toLocaleString('en-US', { timeZone: IST_TIMEZONE }),
  );
  const day = ist.getDate().toString().padStart(2, '0');
  const month = (ist.getMonth() + 1).toString().padStart(2, '0');
  const year = ist.getFullYear();
  return `${day}/${month}/${year}`;
}

/** Format a Date as dd/MM/yyyy HH:mm in IST */
export function formatDateTimeIST(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const ist = new Date(
    d.toLocaleString('en-US', { timeZone: IST_TIMEZONE }),
  );
  const day = ist.getDate().toString().padStart(2, '0');
  const month = (ist.getMonth() + 1).toString().padStart(2, '0');
  const year = ist.getFullYear();
  const hours = ist.getHours().toString().padStart(2, '0');
  const minutes = ist.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

/**
 * Integer index of a date's IST *calendar day* (days since the Unix epoch,
 * counted in the Asia/Kolkata timezone). Two timestamps on the same IST date
 * share the same number; each IST midnight increments it by one. Used for
 * calendar-day billing (e.g. room/bed charges that add a day at 12 AM IST).
 */
export function istDayNumber(date: Date | string): number {
  const d = typeof date === 'string' ? new Date(date) : date;
  // 'en-CA' yields YYYY-MM-DD; formatting in IST gives the IST calendar date.
  const ymd = d.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
  const [y, m, day] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
}

/**
 * The UTC instants that bound an IST *calendar day*, for use as Prisma
 * `{ gte, lte }` filters.
 *
 * The naive `new Date('2026-08-10')` parses to midnight **UTC**, so using it for
 * both ends of a range makes the range one millisecond wide instead of one day —
 * a single-day query then returns nothing. Passing it as only the upper bound is
 * just as wrong: it cuts the chosen end date off entirely.
 *
 * Accepts either `YYYY-MM-DD` (what the UI sends) or the compact `YYYYMMDD`
 * that `getISTDateStr()` returns. Anything unparseable falls back to today in
 * IST, so a bad query string degrades to "today" rather than to an empty result.
 *
 * @example
 *   const { start, end } = istDayRange('2026-08-10');
 *   where.paymentDate = { gte: start, lte: end };  // the whole IST day
 */
export function istDayRange(dateStr?: string): { start: Date; end: Date } {
  let ymd = toISODateStr(dateStr);
  let start = new Date(`${ymd}T00:00:00.000+05:30`);

  // Date-shaped but not a real date — '2026-13-45' passes the pattern and then
  // parses to Invalid Date. Fall back to today so a malformed query string
  // returns today's rows rather than silently returning none.
  if (isNaN(start.getTime())) {
    ymd = toISODateStr(undefined);
    start = new Date(`${ymd}T00:00:00.000+05:30`);
  }

  return { start, end: new Date(`${ymd}T23:59:59.999+05:30`) };
}

/** The first instant of an IST day — for a `gte` lower bound on its own. */
export function istDayStart(dateStr?: string): Date {
  return istDayRange(dateStr).start;
}

/** The last instant of an IST day — for an `lte` upper bound on its own. */
export function istDayEnd(dateStr?: string): Date {
  return istDayRange(dateStr).end;
}

/**
 * Normalise a date string to `YYYY-MM-DD`, accepting `YYYY-MM-DD`, `YYYYMMDD`,
 * or a full ISO timestamp. Falls back to today in IST.
 */
function toISODateStr(dateStr?: string): string {
  if (dateStr) {
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(dateStr);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

    // Only a bare date is taken literally. A longer string is a timestamp and
    // falls through, so its IST calendar date is read rather than the UTC date
    // sitting in its prefix (those differ after 18:30 UTC).
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

    // Anything else (e.g. an ISO timestamp) — read its IST calendar date.
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
    }
  }
  return new Date().toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
}

/** Get YYYYMMDD string in IST (for bill numbers, IDs, etc.) */
export function getISTDateStr(): string {
  const ist = nowIST();
  return (
    ist.getFullYear().toString() +
    (ist.getMonth() + 1).toString().padStart(2, '0') +
    ist.getDate().toString().padStart(2, '0')
  );
}

/** Format a Date as HH:mm in IST (24-hour) */
export function formatTimeIST(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const ist = new Date(
    d.toLocaleString('en-US', { timeZone: IST_TIMEZONE }),
  );
  const hours = ist.getHours().toString().padStart(2, '0');
  const minutes = ist.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** Get IST ISO string for API responses */
export function toISTISOString(date?: Date): string {
  const d = date ?? new Date();
  return d.toLocaleString('en-GB', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ── Time-zone helpers (gap 329 / 330 / 342 / 359 / 362) ─────────────────────
//
// Anything that reads the HOST clock's calendar (getHours, setHours,
// toLocaleString without a timeZone) is wrong on a server running in UTC: the
// hospital's 13:30 is the host's 08:00. Use these instead.

/**
 * The IST calendar date of an instant, as `YYYY-MM-DD`. A bare `YYYY-MM-DD`
 * string is returned as-is (it already IS a calendar date). Defaults to today.
 */
export function istDateStr(date?: Date | string): string {
  if (date instanceof Date) {
    if (isNaN(date.getTime())) return toISODateStr(undefined);
    return date.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
  }
  return toISODateStr(date);
}

/** Minutes since IST midnight for an instant (default: now). 13:30 IST → 810. */
export function istMinutesOfDay(date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/**
 * True when a calendar date (e.g. a date of birth) lies after today in IST.
 * Today itself is not in the future — a newborn registered on the day of birth
 * is valid. Unparseable input is not "future" (let the date validator say so).
 */
export function isFutureISTDate(value: string | Date, now: Date = new Date()): boolean {
  if (typeof value === 'string' && isNaN(Date.parse(value))) return false;
  return istDateStr(value) > istDateStr(now);
}

/**
 * Turn a date the UI sent for an event (admission, discharge…) into the instant
 * to store.
 *
 * Date pickers send a bare `YYYY-MM-DD` — or `new Date('YYYY-MM-DD').toISOString()`,
 * which is UTC midnight. Stored as-is, that instant prints as 05:30 AM IST no
 * matter when the action happened (gap 342). A date-only value for TODAY means
 * "now"; for another day it means the start of that IST day. A real timestamp
 * is kept exactly.
 */
export function toEventInstant(value?: string | Date | null, now: Date = new Date()): Date {
  if (value == null || value === '') return now;
  if (value instanceof Date) return isNaN(value.getTime()) ? now : value;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00))?$/.exec(value);
  if (dateOnly) {
    const ymd = dateOnly[1];
    if (ymd === istDateStr(now)) return now;
    const start = new Date(`${ymd}T00:00:00.000+05:30`);
    return isNaN(start.getTime()) ? now : start;
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? now : parsed;
}

/**
 * `toLocaleString` pinned to IST — for PDFs, receipts and messages. Same
 * options as Intl.DateTimeFormat; `timeZone` is always Asia/Kolkata (gap 362).
 */
export function formatIST(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  },
  locale = 'en-IN',
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, { ...options, timeZone: IST_TIMEZONE });
}
