// ---------------------------------------------------------------------------
// A rupee amount, written out.
//
// Section 10.1 item 8 of the GST report requires "Total tax in words", and the
// layout in 10.2 gives the amount in words its own block: "Grand total, and
// total tax, both in words". Nothing in this codebase could produce it — a grep
// for any number-to-words helper found nothing at all.
//
// It is not decoration. An amount in words is what stops a printed invoice
// being altered after it is handed over, which is why every Indian invoice
// carries one and why an auditor looks for it.
//
// INDIAN numbering, not international: lakh and crore, grouped 2-2-3, so
// 1234567 reads "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven"
// and never "One Million…". Paise are named separately because rupees and
// paise are different units, not a decimal fraction of one.
// ---------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

/** 0–999. */
function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = h ? `${ONES[h]} Hundred` : '';
  const tail = rest ? twoDigits(rest) : '';
  return head && tail ? `${head} ${tail}` : head || tail;
}

/**
 * A whole number in the Indian system: crore, lakh, thousand, then the last
 * three digits.
 *
 * Above 99,99,99,999 the groups keep going in crores — "One Thousand Crore" —
 * which is how the number is actually said, and a hospital will never reach it.
 */
export function numberToIndianWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';

  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;

  if (crore) {
    // Crores are themselves grouped in the Indian system once they pass 99.
    parts.push(`${crore > 99 ? numberToIndianWords(crore) : twoDigits(crore)} Crore`);
  }
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/**
 * The line an invoice prints: "Rupees Twelve Thousand Four Hundred and Fifty
 * Only", with paise named separately when there are any.
 *
 * A negative amount — a credit note — is prefixed rather than silently made
 * positive: the words have to say the same thing as the figures.
 */
export function amountInWords(value: number | string | null | undefined): string {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return '';
  const negative = raw < 0;
  const rounded = Math.round(Math.abs(raw) * 100) / 100;
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);

  const head = `Rupees ${numberToIndianWords(rupees)}`;
  const body = paise > 0 ? `${head} and ${numberToIndianWords(paise)} Paise` : head;
  return `${negative ? 'Minus ' : ''}${body} Only`;
}
