// ---------------------------------------------------------------------------
// Sending a one-time code to a phone, through whatever SMS / WhatsApp provider
// this deployment has. This module is the seam: one message shape, one result
// shape. It never decides who may have a code, only how it travels.
// ---------------------------------------------------------------------------

export type OtpChannel = 'sms' | 'whatsapp';

export interface OtpMessage {
  /** E.164, e.g. +91 followed by ten digits. */
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface OtpSendResult {
  status: 'sent' | 'failed';
  /** The channel that carried it (or the last one tried). */
  channel: OtpChannel | null;
  provider: string;
  sandbox: boolean;
  /** Safe to log: never the code, the number, the URL or a credential. */
  error: string | null;
}

export interface OtpProvider {
  readonly name: string;
  readonly sandbox: boolean;
  send(message: OtpMessage): Promise<OtpSendResult>;
}

export interface OtpProviderInfo {
  configured: boolean;
  provider: string | null;
  sandbox: boolean;
  /** Why it is not configured, when it is not. */
  reason: string | null;
}
