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

/** Generate a random, obviously-synthetic placeholder phone number. */
export function randomAutoPhone(): string {
  const suffix = Math.floor(1_000_000 + Math.random() * 9_000_000); // 7 digits
  return `${AUTO_PHONE_PREFIX}${suffix}`;
}
