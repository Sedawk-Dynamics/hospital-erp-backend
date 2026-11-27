import { AppError } from '../../shared/appError';
import { isPlaceholderAccountEmail } from '../../shared/account-holder';
import { discardOtp, issueOtp, OTP_RESEND_SECONDS, OTP_TTL_SECONDS, type OtpPurpose } from '../../shared/one-time-code';
import { maskPhone } from '../../shared/phone-identity';
import { sendEmail } from '../email.service';
import { canSendOtpToPhone, sendOtpToPhone } from './index';

// ---------------------------------------------------------------------------
// Issue a one-time code and get it to the person: by SMS / WhatsApp when a
// provider is configured, else to the email address the account was registered
// with, else not at all. Whatever happens, a code that was not delivered is
// discarded.
// ---------------------------------------------------------------------------

/** `jane.doe@x.com` -> `j*******@x.com` - enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(local.length - 1, 8)))}@${domain}`;
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** All the caller, and so the browser, is told: how it went and roughly where. */
export interface OtpDeliveryReceipt {
  channel: 'sms' | 'whatsapp' | 'email';
  sentTo: string;
  expiresInSeconds: number;
  resendInSeconds: number;
}

export interface OtpEmail {
  to: string;
  subject: string;
  /** Must not be logged; the subject must never contain the code. */
  html: (code: string, minutes: number) => string;
  text: (code: string, minutes: number) => string;
}

export async function issueAndDeliverOtp(p: {
  purpose: OtpPurpose;
  subject: string;
  binding: string;
  limitSubject: string;
  /** E.164 number to message, or null when the account has none. */
  phone: string | null;
  /** Fallback address; ignored when missing or a synthetic placeholder. */
  email: OtpEmail | null;
  ttlSeconds?: number;
  /** Kept with the code. `viaEmail` says the code went to an inbox, not the phone. */
  data?: (viaEmail: boolean) => Record<string, unknown>;
}): Promise<OtpDeliveryReceipt> {
  const ttl = p.ttlSeconds ?? OTP_TTL_SECONDS;
  const minutes = Math.round(ttl / 60);
  const byPhone = !!p.phone && canSendOtpToPhone(p.phone);
  const email = !byPhone && p.email && !isPlaceholderAccountEmail(p.email.to) ? p.email : null;

  const code = await issueOtp({
    purpose: p.purpose,
    subject: p.subject,
    binding: p.binding,
    limitSubject: p.limitSubject,
    ttlSeconds: ttl,
    data: p.data?.(!byPhone),
  });

  if (!byPhone && !email) {
    await discardOtp(p.purpose, p.subject);
    throw new AppError(
      'Verification codes cannot be sent right now. Please contact the hospital.',
      503,
      'OTP_NOT_CONFIGURED',
    );
  }

  let channel: OtpDeliveryReceipt['channel'] | null = null;
  try {
    if (byPhone) {
      const sent = await sendOtpToPhone({ to: p.phone!, code, expiresInMinutes: minutes });
      if (sent.status === 'sent') channel = sent.channel ?? 'sms';
    } else if (email) {
      const ok = await sendEmail({
        to: email.to,
        subject: email.subject,
        html: email.html(code, minutes),
        text: email.text(code, minutes),
      });
      if (ok) channel = 'email';
    }
  } finally {
    if (!channel) await discardOtp(p.purpose, p.subject);
  }
  if (!channel) {
    throw new AppError('We could not send the verification code right now. Try again later.', 503, 'OTP_DELIVERY_FAILED');
  }

  return {
    channel,
    sentTo: channel === 'email' ? maskEmail(email!.to) : maskPhone(p.phone!),
    expiresInSeconds: ttl,
    resendInSeconds: OTP_RESEND_SECONDS,
  };
}

/** The email carrying a sign-in or PIN code. */
export function signInCodeEmail(to: string, firstName: string | null | undefined, what: string): OtpEmail {
  return {
    to,
    subject: 'Your verification code',
    html: (code, minutes) => `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Hello ${escapeHtml(firstName || '')},</p>
        <p>Use this code to ${escapeHtml(what)}:</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${code}</p>
        <p>It expires in ${minutes} minutes. Do not share it with anyone. If you did not ask for it, ignore this email.</p>
      </div>`,
    text: (code, minutes) =>
      `Your code to ${what} is ${code}. It expires in ${minutes} minutes. Do not share it with anyone. If you did not ask for it, ignore this email.`,
  };
}
