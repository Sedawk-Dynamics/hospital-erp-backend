// ---------------------------------------------------------------------------
// GSTIN verification through the hospital's GST service provider (gap #311).
//
// The local checks (format, state code, check digit, PAN part) prove a GSTIN is
// well-formed, not that it is registered. Only the GST system can say that, and
// a hospital reaches it through a GSP/ASP's "search taxpayer" API. This module
// is the seam: one result shape, whatever provider answered.
// ---------------------------------------------------------------------------

export type GstinVerifyStatus =
  /** The provider found the GSTIN and its registration is active. */
  | 'verified'
  /** The provider has no such GSTIN. */
  | 'not_found'
  /** Found, but cancelled / suspended / anything other than active. */
  | 'inactive'
  /** The lookup itself failed — timeout, network, bad credentials, odd reply. */
  | 'error'
  /** No provider is set up on this deployment. */
  | 'not_configured';

export interface GstinVerifyResult {
  status: GstinVerifyStatus;
  /** The exact GSTIN that was asked about, normalised. */
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  /** The status string as the provider gave it, e.g. "Active", "Cancelled". */
  registrationStatus: string | null;
  stateCode: string | null;
  /** Why it is not verified, in words fit for the settings screen. Never carries a credential. */
  error: string | null;
  checkedAt: Date;
  /** Who answered, e.g. "http:my-gsp" or "sandbox". */
  provider: string;
  /** True for the local QA sandbox — NOT a real government check. */
  sandbox: boolean;
  /** The provider's parsed reply, for debugging. Not persisted, not sent to the browser. */
  raw?: unknown;
}

export interface GstinProvider {
  readonly name: string;
  readonly sandbox: boolean;
  verify(gstin: string): Promise<GstinVerifyResult>;
}

/** What the settings screen is told about the provider, before anyone clicks Verify. */
export interface GstinProviderInfo {
  configured: boolean;
  provider: string | null;
  sandbox: boolean;
  /** Why it is not configured, when it is not. */
  reason: string | null;
}

/** The label every sandbox result carries, on screen and on paper. */
export const SANDBOX_LABEL = 'SANDBOX — not a real government check';
