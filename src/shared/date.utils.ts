/**
 * Date utilities — all display dates use dd/MM/yyyy format and IST (Asia/Kolkata) timezone.
 */

const IST_TIMEZONE = 'Asia/Kolkata';

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
