// ---------------------------------------------------------------------------
// The hospital's one-time registration fee.
//
// Charged when a patient first attends THIS hospital — "first" meaning first
// encounter here, not first time on the platform. A patient who already has a
// portal account, or who is a long-standing patient of another hospital on the
// same ERP, is still opening a new file here and is still chargeable.
//
// One fee per hospital, so it lives as a SETTING rather than a row in the
// service catalog: a catalog would happily let an admin create three
// "Registration" services and leave the desk guessing which one applies.
// Stored in `Tenant.themeConfig.registrationFee`, the same migration-free JSON
// column the PDF letterhead and templates already use.
// ---------------------------------------------------------------------------

export interface RegistrationFeeSettings {
  /** Off by default — a hospital that does not charge one sees nothing change. */
  enabled: boolean;
  amount: number;
  /** Added on top of `amount`; 0 for most hospitals. */
  gstRatePercent: number;
  /** What the patient sees on the bill. */
  label: string;
  /**
   * When true (the default) the fee can only ever be taken once per patient at
   * this hospital. Turning it off lets the desk charge it again — some
   * hospitals re-register a file after a long absence.
   */
  oncePerPatient: boolean;
}

export const DEFAULT_REGISTRATION_FEE: RegistrationFeeSettings = {
  enabled: false,
  amount: 0,
  gstRatePercent: 0,
  label: 'Registration Fee',
  oncePerPatient: true,
};

/** Marks the bill item so it can be found again, counted, and never doubled. */
export const REGISTRATION_FEE_REFERENCE_TYPE = 'registration';

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

/**
 * Fold an untrusted patch over the current settings, clamping anything that
 * would produce a nonsensical charge. The values come off the wire and out of a
 * JSON column, so a bad one must not be able to reach a patient's bill.
 */
export function mergeRegistrationFee(
  base: RegistrationFeeSettings,
  patch: unknown,
): RegistrationFeeSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 120) : base.label;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    // Capped well above any real registration fee, but not unbounded — a
    // mis-typed amount should not be able to become a six-figure charge.
    amount: num(p.amount, base.amount, 0, 100000),
    gstRatePercent: num(p.gstRatePercent, base.gstRatePercent, 0, 28),
    label,
    oncePerPatient: typeof p.oncePerPatient === 'boolean' ? p.oncePerPatient : base.oncePerPatient,
  };
}

/** Money on the bill for these settings: base + GST, rounded to paise. */
export function registrationFeeTotals(s: RegistrationFeeSettings): {
  unitPrice: number;
  taxAmount: number;
  totalAmount: number;
} {
  const unitPrice = Math.round(s.amount * 100) / 100;
  const taxAmount = Math.round(unitPrice * (s.gstRatePercent / 100) * 100) / 100;
  return { unitPrice, taxAmount, totalAmount: Math.round((unitPrice + taxAmount) * 100) / 100 };
}

/**
 * Is the fee actually chargeable right now?
 *
 * `deskChoice` is what the front desk ticked. Null means they never said, so
 * the rule decides — which is what makes the fee work for appointments booked
 * from the portal or by a route that has no checkbox.
 */
export function shouldChargeRegistrationFee(params: {
  settings: RegistrationFeeSettings;
  isFirstVisit: boolean;
  alreadyCharged: boolean;
  deskChoice: boolean | null;
}): boolean {
  const { settings, isFirstVisit, alreadyCharged, deskChoice } = params;
  if (!settings.enabled || settings.amount <= 0) return false;
  // An explicit "no" from the desk always wins — they are looking at the
  // patient and may know something the records do not.
  if (deskChoice === false) return false;
  // …but an explicit "yes" cannot override the once-per-patient rule, or a
  // slow double-click would bill the fee twice.
  if (settings.oncePerPatient && alreadyCharged) return false;
  if (deskChoice === true) return true;
  return isFirstVisit;
}
