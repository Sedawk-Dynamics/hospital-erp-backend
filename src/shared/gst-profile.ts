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

export const DEFAULT_GST_PROFILE: GstProfile = {
  registered: false,
  gstin: null,
  stateCode: null,
  stateName: null,
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
