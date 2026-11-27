// GSTR-1 Table 5 (B2C large): an inter-State invoice to an unregistered buyer is
// reported invoice-wise when its value is ABOVE this limit, otherwise it goes in
// the Table 7 summary. The limit was Rs 2,50,000 and is Rs 1,00,000 for invoices
// from 1 August 2024 (Notification 12/2024-Central Tax). The invoice date
// decides, so a period filed under the old limit is not restated.

export const B2CL_LIMIT_FROM = '2024-08-01';
const OLD_LIMIT = 250000;
const NEW_LIMIT = 100000;

/** The invoice date in India, as YYYY-MM-DD. */
function istDay(date: Date): string {
  return new Date(date.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** The Table 5 limit for an invoice dated `billDate`. */
export function b2clThreshold(billDate: Date | string | null | undefined): number {
  if (billDate == null) return NEW_LIMIT;
  const day = typeof billDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(billDate) ? billDate : istDay(new Date(billDate));
  return day >= B2CL_LIMIT_FROM ? NEW_LIMIT : OLD_LIMIT;
}

/** True when this inter-State B2C invoice belongs in Table 5. */
export function isB2cLarge(isInterState: boolean, invoiceValue: number, billDate: Date | string | null | undefined): boolean {
  return isInterState && invoiceValue > b2clThreshold(billDate);
}
