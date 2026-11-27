// ---------------------------------------------------------------------------
// #358 — GST on a radiology study.
//
// The client's decision: a diagnostic scan done by a hospital is exempt (0%).
// Only a cosmetic or non-medical scan is taxable, and no rate was given for
// those, so there is no default: the admin enters the rate and the SAC.
//
// The scan PURPOSE is the tariff's existing `isCosmetic` flag — false is
// diagnostic, true is cosmetic / non-medical. It is the same flag the tax engine
// already reads for surgery; a second column saying the same thing could only
// ever disagree with it. What differs for a scan is the rate: a cosmetic
// PROCEDURE with no rate falls back to 18%, a cosmetic SCAN has no fallback.
//
//   diagnostic, approved       → the approved treatment (exempt 0%)
//   diagnostic, not approved   → billed exempt, with a warning. Never blocked.
//   cosmetic, approved         → its own rate and SAC
//   cosmetic, not approved     → the line is held for resolution, so the bill
//                                cannot be issued at 0% (or at any guess)
// ---------------------------------------------------------------------------

/** Medical laboratory and diagnostic-imaging services. */
export const DIAGNOSTIC_IMAGING_SAC = '999316';

/** Stored as the line's tax reason, so finalising can warn about it. */
export const DIAGNOSTIC_UNAPPROVED_REASON = 'Exempt diagnostic scan — GST not yet approved for this study';

export interface RadiologyTariff {
  serviceName?: string | null;
  sacCode?: string | null;
  gstTreatment?: string | null;
  gstRatePercent?: unknown;
  gstApproved?: boolean | null;
  isCosmetic?: boolean | null;
  gstEffectiveFrom?: Date | string | null;
}

export interface RadiologyTaxFacts {
  sacCode: string | null;
  taxRate: number;
  gstTreatment: string;
  gstApproved: boolean;
  isCosmetic: boolean;
  /** Shown where the scan is accepted or billed; null when nothing needs saying. */
  warning: string | null;
  /** The bill cannot be issued with this line until the admin acts. */
  blocked: boolean;
}

/** A tariff's GST is SET only once the finance / GST admin has approved it. */
export function radiologyGstIsSet(t: RadiologyTariff | null | undefined, on: Date = new Date()): boolean {
  if (!t?.gstApproved || !t.gstTreatment) return false;
  const from = t.gstEffectiveFrom ? new Date(t.gstEffectiveFrom) : null;
  return !from || Number.isNaN(from.getTime()) || on.getTime() >= from.getTime();
}

export function radiologyTaxFacts(
  tariff: RadiologyTariff | null | undefined,
  on: Date = new Date(),
): RadiologyTaxFacts {
  const name = tariff?.serviceName || 'this scan';
  const set = radiologyGstIsSet(tariff, on);
  const rate = Number(tariff?.gstRatePercent ?? 0);

  if (tariff?.isCosmetic) {
    const ok = set && rate > 0 && tariff.gstTreatment === 'taxable';
    return {
      // The diagnostic code is never borrowed for a scan that is not diagnostic.
      sacCode: tariff.sacCode ?? null,
      taxRate: ok ? rate : 0,
      gstTreatment: 'taxable',
      gstApproved: ok,
      isCosmetic: true,
      warning: ok
        ? null
        : `${name} is a cosmetic / non-medical scan and its GST rate and SAC are not set and approved. ` +
          'The bill cannot be issued until the finance / GST admin does so in Radiology → Settings or Settings → GST classification.',
      blocked: !ok,
    };
  }

  if (set) {
    return {
      sacCode: tariff!.sacCode ?? DIAGNOSTIC_IMAGING_SAC,
      taxRate: tariff!.gstTreatment === 'taxable' ? rate : 0,
      gstTreatment: tariff!.gstTreatment!,
      gstApproved: true,
      isCosmetic: false,
      warning: null,
      blocked: false,
    };
  }
  return {
    sacCode: tariff?.sacCode ?? DIAGNOSTIC_IMAGING_SAC,
    taxRate: 0,
    gstTreatment: 'exempt',
    gstApproved: false,
    isCosmetic: false,
    warning: `GST is not set for ${name}. It is billed as an exempt diagnostic scan until the finance / GST admin approves it.`,
    blocked: false,
  };
}

/**
 * Why a radiology classification cannot be approved, or null when it can.
 * `legalRate` is whether the rate is a slab in force today.
 */
export function radiologyApprovalProblem(t: RadiologyTariff, legalRate: boolean): string | null {
  const rate = Number(t.gstRatePercent ?? 0);
  if (t.isCosmetic) {
    if (t.gstTreatment !== 'taxable') return 'A cosmetic / non-medical scan is taxable: set its treatment to taxable';
    if (!(rate > 0)) return 'Enter the GST rate for this cosmetic / non-medical scan';
    if (!legalRate) return `${rate}% is not a legal GST slab`;
    if (!/^\d{6}$/.test(String(t.sacCode ?? ''))) return 'Enter the 6-digit SAC for this cosmetic / non-medical scan';
    return null;
  }
  if (t.gstTreatment === 'taxable' || rate > 0) {
    return 'A diagnostic scan is exempt (0%). If this scan is cosmetic or non-medical, change its purpose first';
  }
  return null;
}
