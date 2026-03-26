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

/** Get YYYYMMDD string in IST (for bill numbers, IDs, etc.) */
export function getISTDateStr(): string {
  const ist = nowIST();
  return (
    ist.getFullYear().toString() +
    (ist.getMonth() + 1).toString().padStart(2, '0') +
    ist.getDate().toString().padStart(2, '0')
  );
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
