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
