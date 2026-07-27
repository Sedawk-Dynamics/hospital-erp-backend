/**
 * Account-holder helpers.
 *
 * Every registered patient belongs to a phone-keyed account (a `User`). When the
 * front desk registers a patient for a number that nobody owns yet, it
 * auto-creates a *placeholder* account holder: a platform-tenant User with a
 * random (unusable) password and a synthetic email on {@link AUTO_ACCOUNT_EMAIL_DOMAIN}.
 *
 * That placeholder cannot be logged into. When the real owner later signs up on
 * the patient portal with the same phone number, the signup *claims* the
 * placeholder (real email + password + name are written onto it) instead of
 * creating a second account — so every patient already linked to it (the owner
 * plus any relatives the desk registered) immediately shows up in their portal.
 *
 * (Phone ownership is taken on trust for now; OTP verification of the number is
 * a planned hardening step that will gate the claim.)
 */

/** Synthetic-email domain that marks an unclaimed, auto-created account holder. */
export const AUTO_ACCOUNT_EMAIL_DOMAIN = 'auto.hospital.local';

/** True when `email` is the synthetic address of an unclaimed placeholder account. */
export function isPlaceholderAccountEmail(email?: string | null): boolean {
  return !!email && email.toLowerCase().endsWith(`@${AUTO_ACCOUNT_EMAIL_DOMAIN}`);
}

/**
 * Collapse phone formatting (spaces, dashes, brackets, dots) so the same number
 * always resolves to the same account holder however it was typed. Keeps a
 * leading + and the digits.
 */
export function normalizeAccountPhone(phone: string): string {
  return phone.replace(/[\s()\-.]/g, '').trim();
}

/** Just the digits of a phone number. */
export function phoneDigits(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/** The last 10 digits — the stable identity of an Indian mobile number. */
export function phoneLast10(phone: string): string {
  return phoneDigits(phone).slice(-10);
}

/**
 * Canonical storage form: `+<countryCode><nationalNumber>`, digits only after
 * the plus. The country code is preserved when the caller provides one (so
 * international numbers survive); a bare 10-digit number defaults to +91 (India).
 * Everything captured (front desk, portal signup) is stored this way so numbers
 * are consistent, while equivalence is still judged by the last 10 digits.
 */
export function canonicalPhone(phone: string): string {
  const trimmed = (phone || '').trim();
  const digits = phoneDigits(trimmed);
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`; // explicit country code kept
  if (digits.length <= 10) return `+91${digits}`; // bare national → default +91
  return `+${digits}`; // already includes a country code
}

/**
 * Prisma string filter that matches a number regardless of the format it was
 * stored in (+91…, 0…, bare 10 digits) by comparing the last 10 digits.
 * Falls back to a few exact variants when the input isn't a full 10-digit number.
 */
export function phoneMatchFilter(phone: string): { endsWith: string } | { in: string[] } {
  const last10 = phoneLast10(phone);
  if (last10.length === 10) return { endsWith: last10 };
  const d = phoneDigits(phone);
  return { in: [phone.trim(), d, `+${d}`].filter(Boolean) };
}

/** Build the synthetic placeholder email for a (normalised) phone number. */
export function placeholderAccountEmail(normalizedPhone: string): string {
  const digits = normalizedPhone.replace(/\D/g, '') || 'unknown';
  return `phone-${digits}@${AUTO_ACCOUNT_EMAIL_DOMAIN}`;
}

/**
 * Prefix that marks an auto-assigned (placeholder) phone number. Patients now
 * sign in only by phone, so every patient account needs one; when a legacy
 * account has none we assign a random number carrying this prefix. The prefix
 * keeps it obviously synthetic and out of the real Indian mobile range (6-9),
 * so it never collides with a genuine number a new patient might use.
 */
export const AUTO_PHONE_PREFIX = '+910000';

/** True when a phone number was auto-assigned (not a real number the patient knows). */
export function isAutoAssignedPhone(phone?: string | null): boolean {
  return !!phone && phone.startsWith(AUTO_PHONE_PREFIX);
}

/** Generate a random, obviously-synthetic placeholder phone (+91 + 10 digits, 0000-prefixed). */
export function randomAutoPhone(): string {
  const suffix = Math.floor(100_000 + Math.random() * 900_000); // 6 digits
  return `${AUTO_PHONE_PREFIX}${suffix}`; // +910000 + 6 = +91 followed by 10 digits
}
