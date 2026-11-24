// ---------------------------------------------------------------------------
// The hospital's own GST identity.
//
// Nothing else in the GST work can start without this. Whether a line carries
// CGST+SGST or IGST is decided by comparing the hospital's state against the
// place of supply, and there is no hospital state anywhere in the system today
// — the GSTIN exists only as a line of text on the PDF letterhead, which is a
// caption, not a tax identity.
//
// A hospital that has not filled this in is not broken. It is simply not
// registered as far as the system is concerned: every document it issues is a
// Bill of Supply, no tax is charged, and nothing about today's behaviour
// changes. That is the honest default and it is also the safe one — inventing
// a GSTIN or a state would produce invoices that look valid and are not.
//
// Two of these settings are the hospital's auditor's call rather than the
// platform's, which is why they live here and not in the platform masters:
// whether discharge medicines are taxed, and how a room upgrade is classified.
// ---------------------------------------------------------------------------

import { checkGstin, stateNameForCode } from './gst';

export type GstRegistrationType = 'regular' | 'composition' | 'unregistered';

const REGISTRATION_TYPES: readonly GstRegistrationType[] = [
  'regular',
  'composition',
  'unregistered',
] as const;

/** How a room charged above the medical need is classified. The auditor decides. */
export type RoomUpgradeTreatment = 'accommodation' | 'other_service' | 'exempt';

const ROOM_UPGRADE_TREATMENTS: readonly RoomUpgradeTreatment[] = [
  'accommodation',
  'other_service',
  'exempt',
] as const;

export interface GstProfile {
  /**
   * Off by default. A hospital that never fills this in keeps behaving exactly
   * as it does today — no tax, no tax invoices, nothing to file.
   */
  registered: boolean;
  gstin: string | null;
  /** Always derived from the GSTIN, never typed separately — they cannot disagree. */
  stateCode: string | null;
  stateName: string | null;
  /** The hospital's PAN. When stored, the GSTIN's characters 3–12 must match it (gap item 311). */
  pan: string | null;
  /**
   * Whether the CURRENT GSTIN has been confirmed through the hospital's GST
   * service provider (gap item 311). True only when the stored lookup was for
   * this exact number and came back active — see applyGstinVerification. It is
   * never stored in the profile JSON; it is overlaid on every read from the
   * GstinVerification row. Passing the local checks below is NOT verification.
   */
  gstinVerified: boolean;
  /**
   * What the last provider lookup said, for the settings screen and the
   * reports. Absent on a profile built without reading the verification row.
   */
  gstinVerification?: GstinVerificationState | null;
  /** The local checks the GSTIN passed, recomputed on every read. */
  gstinChecks: GstinChecks | null;
  /** The name on the registration, which is often not the name on the signboard. */
  legalName: string | null;
  tradeName: string | null;
  registrationType: GstRegistrationType;
  /**
   * The cut-over: the first day this system's figures are the ones filed from.
   * Bills dated before it are left exactly as they are — the hospital decides
   * when it starts, and history is not rewritten underneath it.
   */
  effectiveFrom: string | null;

  // ── Applicability, driven by the hospital's actual turnover ──
  //
  // Deliberately flags rather than a rupee threshold compiled into the code.
  // Thresholds move, and a hard-coded five crore makes the software wrong the
  // day the rule changes rather than the day the hospital's turnover does.
  /** GSTR-1 Table 12 wants 6-digit HSN above the reporting threshold, 4 below. */
  sixDigitHsn: boolean;
  eInvoiceApplicable: boolean;
  eWayBillApplicable: boolean;
  /**
   * How many days after the document date an invoice may still be registered
   * with the portal. Report D-2 measures its deadline against this.
   *
   * A number here rather than in the report for the same reason as everything
   * else in this block: the window has already moved once — thirty days for
   * larger filers, none before that — and a report that hard-codes it starts
   * lying the day the rule changes rather than the day the hospital does.
   */
  eInvoiceUploadDays: number;
  /**
   * The consignment value above which goods moving on a public road need an
   * e-way bill. Report D-3 lists the movements that cross it.
   */
  eWayBillThreshold: number;

  // ── The auditor's calls ──
  /**
   * Medicines an inpatient takes home. Taxable by default: the patient carries
   * them out, so it looks like a counter sale rather than part of the
   * treatment. Flip it only on the auditor's advice.
   */
  dischargeMedicinesTaxable: boolean;
  /**
   * Medicines and consumables used ON an admitted patient are part of an
   * exempt composite supply. On by default because that is the law; an
   * off-switch exists so a hospital whose auditor disagrees is not stuck.
   */
  inpatientCompositeExempt: boolean;
  /**
   * Round the grand total to the nearest rupee and show the difference as a
   * round-off line, per section 6.9 of the GST report.
   *
   * On by default because that is what the report specifies and what every
   * Indian invoice does. The off-switch exists because it changes what the
   * patient actually pays — by up to fifty paise — and that is a decision a
   * hospital is entitled to make for itself.
   *
   * The round-off NEVER touches the tax figures. Those are what get reported.
   */
  roundOffToRupee: boolean;
  roomUpgradeTreatment: RoomUpgradeTreatment;
  /**
   * The room-rent rule, as DATA rather than as constants in the engine.
   *
   * Section 7.1 lists it under Standard Rules: the Rs 5,000-per-day threshold
   * and its 5% rate. Both were compiled in, so a Council change meant a code
   * change. The defaults are the statutory ones, so a hospital that never
   * touches this behaves exactly as it does today.
   *
   * ICU is deliberately NOT configurable here — critical-care accommodation is
   * exempt at any rate under the notification itself, not by anyone's choice.
   */
  roomRule: {
    thresholdPerDay: number;
    ratePercent: number;
    /** What the room is supplied under. Defaults to SAC 996311. */
    sacCode: string | null;
  };
}

export interface GstinChecks {
  format: boolean;
  checkDigit: boolean;
  stateCode: boolean;
  /** null when no hospital PAN is stored to compare against. */
  panMatches: boolean | null;
  /** A documentation / placeholder GSTIN, or a PAN part made of repeats. */
  looksLikeSample: boolean;
}

/**
 * GSTINs printed in GST documentation and tutorials. Each passes the check
 * digit, which is exactly why one ends up saved as a hospital's own number.
 */
const SAMPLE_GSTINS = new Set(['27AAPFU0939F1ZV']);

/** The local checks on a GSTIN. A pass is still not portal verification. */
export function gstinChecksFor(gstin: string | null, pan: string | null): GstinChecks | null {
  if (!gstin) return null;
  const g = gstin.trim().toUpperCase();
  const check = checkGstin(g);
  const format = g.length === 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
  const panPart = g.slice(2, 12);
  return {
    format,
    stateCode: !!stateNameForCode(g.slice(0, 2)),
    checkDigit: check.valid,
    panMatches: pan ? panPart === pan.trim().toUpperCase() : null,
    looksLikeSample:
      SAMPLE_GSTINS.has(g) ||
      /^(.)\1{4}/.test(panPart) ||
      /0000|1234/.test(panPart.slice(5, 9)) ||
      /^ABCDE/.test(panPart),
  };
}

export const DEFAULT_GST_PROFILE: GstProfile = {
  registered: false,
  gstin: null,
  stateCode: null,
  stateName: null,
  pan: null,
  gstinVerified: false,
  gstinChecks: null,
  legalName: null,
  tradeName: null,
  registrationType: 'unregistered',
  effectiveFrom: null,
  sixDigitHsn: false,
  eInvoiceApplicable: false,
  eWayBillApplicable: false,
  eInvoiceUploadDays: 30,
  eWayBillThreshold: 50000,
  dischargeMedicinesTaxable: true,
  inpatientCompositeExempt: true,
  roundOffToRupee: true,
  roomUpgradeTreatment: 'accommodation',
  roomRule: { thresholdPerDay: 5000, ratePercent: 5, sacCode: null },
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function text(v: unknown, fallback: string | null, max: number): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** A plain YYYY-MM-DD, or null. Anything else is not a date the cut-over can use. */
function isoDate(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return fallback;
  const d = new Date(`${t}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? fallback : t;
}

/** A number a hospital sets, kept inside sane bounds rather than rejected. */
function clamp(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class GstProfileError extends Error {}

/**
 * Fold an untrusted patch over the current profile.
 *
 * The GSTIN is the one field that is checked rather than clamped: a wrong
 * GSTIN is not a value to be tidied up, it is an invoice that will be rejected,
 * so it is refused at the door. The state always comes out of the GSTIN, so the
 * two can never drift apart.
 */
export function mergeGstProfile(base: GstProfile, patch: unknown): GstProfile {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;

  let gstin = base.gstin;
  let stateCode = base.stateCode;
  let stateName = base.stateName;

  if ('gstin' in p) {
    const raw = p.gstin;
    if (raw === null || (typeof raw === 'string' && !raw.trim())) {
      gstin = null;
      stateCode = null;
      stateName = null;
    } else {
      const check = checkGstin(typeof raw === 'string' ? raw : String(raw));
      if (!check.valid) throw new GstProfileError(`GSTIN is not valid — ${check.reason}`);
      gstin = check.normalized;
      stateCode = check.stateCode;
      stateName = check.stateName;
    }
  } else if (gstin) {
    // Repair a profile written before the state was derived from the number.
    const check = checkGstin(gstin);
    if (check.valid) {
      stateCode = check.stateCode;
      stateName = check.stateName;
    }
  }

  const registrationType = REGISTRATION_TYPES.includes(p.registrationType as GstRegistrationType)
    ? (p.registrationType as GstRegistrationType)
    : base.registrationType;

  const roomUpgradeTreatment = ROOM_UPGRADE_TREATMENTS.includes(
    p.roomUpgradeTreatment as RoomUpgradeTreatment,
  )
    ? (p.roomUpgradeTreatment as RoomUpgradeTreatment)
    : base.roomUpgradeTreatment;

  let registered = bool(p.registered, base.registered);
  // The hospital's PAN, format-checked. Matching it against the GSTIN is done
  // where the profile is SAVED (updateGstProfile), not here, so a stored
  // mismatch can never make a read fall back to "unregistered".
  let pan = base.pan ?? null;
  if ('pan' in p) {
    const raw = p.pan;
    if (raw === null || (typeof raw === 'string' && !raw.trim())) pan = null;
    else {
      const t = String(raw).trim().toUpperCase();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(t)) throw new GstProfileError('PAN must be 5 letters, 4 digits and a letter (e.g. ABCPE1234F)');
      pan = t;
    }
  }

  // Asking to be registered without supplying a number is a request that would
  // produce invalid invoices, so it is refused rather than half-applied.
  if (p.registered === true && !gstin) {
    throw new GstProfileError('A GSTIN is required to mark the hospital as GST registered');
  }
  // Clearing the number de-registers instead of erroring: removing the
  // registration is a legitimate thing to do, and it is the number that
  // carries the registration, not the checkbox.
  if (!gstin) registered = false;

  return {
    registered,
    gstin,
    stateCode,
    stateName: stateName ?? stateNameForCode(stateCode),
    pan,
    // Never true from the profile alone: only applyGstinVerification, reading
    // the provider's stored answer for this exact GSTIN, can set it (gap 311).
    gstinVerified: false,
    gstinChecks: gstinChecksFor(gstin, pan),
    legalName: text(p.legalName, base.legalName, 200),
    tradeName: text(p.tradeName, base.tradeName, 200),
    registrationType: registered && registrationType === 'unregistered' ? 'regular' : registrationType,
    effectiveFrom: isoDate(p.effectiveFrom, base.effectiveFrom),
    sixDigitHsn: bool(p.sixDigitHsn, base.sixDigitHsn),
    eInvoiceApplicable: bool(p.eInvoiceApplicable, base.eInvoiceApplicable),
    eWayBillApplicable: bool(p.eWayBillApplicable, base.eWayBillApplicable),
    // Clamped, not refused — both are numbers a hospital sets from its own
    // circumstances, not identities like the GSTIN. Zero upload days is a
    // legitimate setting: it means the invoice must be registered the same day.
    eInvoiceUploadDays: clamp(p.eInvoiceUploadDays, base.eInvoiceUploadDays, 0, 365),
    eWayBillThreshold: clamp(p.eWayBillThreshold, base.eWayBillThreshold, 0, 10_000_000),
    dischargeMedicinesTaxable: bool(p.dischargeMedicinesTaxable, base.dischargeMedicinesTaxable),
    inpatientCompositeExempt: bool(p.inpatientCompositeExempt, base.inpatientCompositeExempt),
    roundOffToRupee: bool(p.roundOffToRupee, base.roundOffToRupee),
    roomUpgradeTreatment,
    roomRule: mergeRoomRule(base.roomRule, p.roomRule),
  };
}

/**
 * The room rule, clamped rather than refused.
 *
 * A threshold or a rate is a number a hospital sets, not an identity like the
 * GSTIN — a nonsensical one is tidied up rather than rejected at the door. A
 * threshold of zero would make every room taxable, so it is floored at zero and
 * the rate is bounded by the highest slab that has ever existed.
 */
function mergeRoomRule(base: GstProfile['roomRule'], patch: unknown): GstProfile['roomRule'] {
  const p = (patch ?? {}) as Record<string, unknown>;
  const numOr = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    thresholdPerDay: numOr(p.thresholdPerDay, base.thresholdPerDay, 0, 10_000_000),
    ratePercent: numOr(p.ratePercent, base.ratePercent, 0, 40),
    sacCode: text(p.sacCode, base.sacCode, 20),
  };
}

/**
 * Is this hospital charging GST on a document dated `on`?
 *
 * Both conditions have to hold: it must be registered, and the document must
 * fall on or after the cut-over it chose. A bill from before the cut-over is
 * left alone, which is what makes it safe to switch this on mid-year.
 */
export function gstAppliesOn(profile: GstProfile, on: Date): boolean {
  if (!profile.registered || !profile.gstin) return false;
  if (!profile.effectiveFrom) return true;
  const from = new Date(`${profile.effectiveFrom}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) return true;
  // Compare on the calendar day, so a bill raised at 09:00 IST on the cut-over
  // date counts as on it rather than before it.
  return on.getTime() >= from.getTime() - 5.5 * 60 * 60 * 1000;
}

/** What the invoice prints as the place of supply for an ordinary patient. */
export function defaultPlaceOfSupply(profile: GstProfile): {
  stateCode: string | null;
  stateName: string | null;
} {
  return { stateCode: profile.stateCode, stateName: profile.stateName };
}

// ── GSTIN verification through the GST service provider (gap item 311) ─────
//
// The provider's answer is kept in its own row (GstinVerification) and folded
// onto the profile on every read. Pure functions here, so the rule "verified
// only for the exact GSTIN that was checked, and only when it came back
// active" is decided in one place and tested without a database.

export type GstinVerificationStatus =
  | 'verified'
  | 'not_found'
  | 'inactive'
  | 'error'
  /** No lookup on record for this GSTIN. */
  | 'never_checked'
  /** A lookup is on record, but for a different GSTIN than the one saved now. */
  | 'stale'
  /** The verification record could not be read. */
  | 'unreadable';

export interface GstinVerificationState {
  status: GstinVerificationStatus;
  /** The GSTIN the stored lookup was about. */
  checkedGstin: string | null;
  legalName: string | null;
  tradeName: string | null;
  registrationStatus: string | null;
  provider: string | null;
  /** The QA sandbox answered — NOT a real government check. */
  sandbox: boolean;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Provider legal name vs the legal name entered here; null when either is missing. */
  legalNameMatches: boolean | null;
}

/** The stored row, as far as this logic needs it. */
export interface GstinVerificationRecord {
  checkedGstin: string;
  verifiedGstin: string | null;
  resultStatus: string;
  provider: string;
  sandbox: boolean;
  legalName: string | null;
  tradeName: string | null;
  registrationStatus: string | null;
  lastError: string | null;
  lastCheckedAt: Date;
  verifiedAt: Date | null;
}

const STORED_STATUSES = new Set(['verified', 'not_found', 'inactive', 'error']);

/**
 * Legal names compared loosely — case, punctuation and the usual
 * PVT/PRIVATE, LTD/LIMITED spellings — so a full stop is not a mismatch.
 */
export function normaliseLegalName(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\bPVT\b/g, 'PRIVATE')
    .replace(/\bLTD\b/g, 'LIMITED')
    .replace(/\bCO\b/g, 'COMPANY')
    .replace(/\s+/g, ' ')
    .trim();
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * Fold the stored provider answer onto a profile.
 *
 * `row === undefined` means the row could not be read: the profile is still
 * returned (billing must not fail), just unverified.
 */
export function applyGstinVerification(
  profile: GstProfile,
  row: GstinVerificationRecord | null | undefined,
): GstProfile {
  if (!profile.gstin) return { ...profile, gstinVerified: false, gstinVerification: null };
  const empty: GstinVerificationState = {
    status: 'never_checked',
    checkedGstin: null,
    legalName: null,
    tradeName: null,
    registrationStatus: null,
    provider: null,
    sandbox: false,
    lastCheckedAt: null,
    verifiedAt: null,
    lastError: null,
    legalNameMatches: null,
  };
  if (row === undefined) {
    return {
      ...profile,
      gstinVerified: false,
      gstinVerification: { ...empty, status: 'unreadable', lastError: 'The verification record could not be read' },
    };
  }
  if (!row) return { ...profile, gstinVerified: false, gstinVerification: empty };

  const sameNumber = row.checkedGstin === profile.gstin;
  const stored = STORED_STATUSES.has(row.resultStatus)
    ? (row.resultStatus as GstinVerificationStatus)
    : 'error';
  const verified = sameNumber && stored === 'verified' && row.verifiedGstin === profile.gstin;
  const legalNameMatches =
    sameNumber && row.legalName && profile.legalName
      ? normaliseLegalName(row.legalName) === normaliseLegalName(profile.legalName)
      : null;

  return {
    ...profile,
    gstinVerified: verified,
    gstinVerification: {
      status: sameNumber ? stored : 'stale',
      checkedGstin: row.checkedGstin,
      legalName: sameNumber ? row.legalName : null,
      tradeName: sameNumber ? row.tradeName : null,
      registrationStatus: sameNumber ? row.registrationStatus : null,
      provider: row.provider,
      sandbox: row.sandbox,
      lastCheckedAt: iso(row.lastCheckedAt),
      verifiedAt: verified ? iso(row.verifiedAt) : null,
      lastError: sameNumber ? row.lastError : 'The last lookup was for a different GSTIN',
      legalNameMatches,
    },
  };
}

/** True only when `gstin` is the profile's GSTIN and that GSTIN is verified. */
export function gstinVerifiedFor(
  profile: { gstin?: string | null; gstinVerified?: boolean },
  gstin: string | null | undefined,
): boolean {
  return !!gstin && !!profile.gstinVerified && profile.gstin === gstin.trim().toUpperCase();
}

/**
 * The caption printed beside the hospital's GSTIN on reports and bills, or
 * null when nothing needs saying. A sandbox pass still carries a caption: it
 * exercised the flow, it did not check anything with the government.
 */
export function gstinVerificationCaption(
  profile: {
    gstin?: string | null;
    gstinVerified?: boolean;
    gstinVerification?: { sandbox: boolean } | null;
  },
  gstin: string | null | undefined = profile.gstin,
): string | null {
  if (!gstin) return null;
  if (!gstinVerifiedFor(profile, gstin)) return 'not verified with the GST portal';
  if (profile.gstinVerification?.sandbox) return 'SANDBOX verification — not a real government check';
  return null;
}
