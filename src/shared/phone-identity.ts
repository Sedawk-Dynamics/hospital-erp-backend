import crypto from 'crypto';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Phone numbers as a SIGN-IN identity.
//
// account-holder.ts matches numbers by their last 10 digits, which is right for
// finding a record at the front desk and wrong for signing somebody in: a
// one-time code sent to +1 650 xxx xxxx would otherwise open the account of
// +91 650xxxxxxx. Here the country code counts. A number stored without one is
// Indian.
// ---------------------------------------------------------------------------

/**
 * E.164 form of a number typed at sign-in or stored on a record, or null when
 * it is not a usable number. `98765 43210`, `09876543210`, `919876543210` and
 * `+91 98765-43210` are all `+919876543210`.
 */
export function phoneE164(raw: string | null | undefined): string | null {
  let compact = (raw ?? '').replace(/[\s()\-.]/g, '');
  if (/^00\d/.test(compact)) compact = `+${compact.slice(2)}`;
  if (compact.startsWith('+')) {
    if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
    if (compact.startsWith('+91') && compact.length !== 13) return null;
    return compact;
  }
  const m = compact.match(/^(?:91|0)?(\d{10})$/);
  return m ? `+91${m[1]}` : null;
}

/** Whether a stored number is exactly this E.164 number (country code included). */
export function isSamePhone(stored: string | null | undefined, e164: string): boolean {
  return phoneE164(stored) === e164;
}

/** `+91 ******3210` - enough to recognise, not to harvest. */
export function maskPhone(e164: string): string {
  const cc = e164.startsWith('+91') ? '+91' : e164.slice(0, 2);
  return `${cc} ******${e164.slice(-4)}`;
}

/** Keyed digest of a number, for Redis keys, so keys do not list patients' numbers. */
export function phoneSubject(e164: string): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`phone-subject:${e164}`)
    .digest('hex')
    .slice(0, 32);
}
