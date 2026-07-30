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
