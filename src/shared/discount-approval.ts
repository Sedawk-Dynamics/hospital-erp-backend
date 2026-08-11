/**
 * When a concession at the counter needs a second pair of eyes.
 *
 * A cashier granting an unlimited discount is the classic revenue leak, and the
 * plan asks for discounts "with approval". Recording who granted one is already
 * done — this is the gate on top of it.
 *
 * OFF by default. A hospital that has been running without a limit does not
 * suddenly find its counter blocked; turning it on is a deliberate act in
 * Settings. When off, every concession is granted immediately exactly as before.
 *
 * Two limits, either of which can trip it: an absolute rupee figure, and a
 * share of the bill. A ₹500 concession is nothing on a ₹200,000 admission and
 * everything on a ₹600 consultation, so a hospital usually wants both.
 */
export interface DiscountApprovalSettings {
  /** Master switch. Off means concessions apply the moment they are entered. */
  enabled: boolean;
  /** A concession above this many rupees needs approval. 0 = no rupee limit. */
  maxAmountWithoutApproval: number;
  /** A concession above this share of the bill needs approval. 0 = no % limit. */
  maxPercentWithoutApproval: number;
}

export const DEFAULT_DISCOUNT_APPROVAL: DiscountApprovalSettings = {
  enabled: false,
  maxAmountWithoutApproval: 0,
  maxPercentWithoutApproval: 0,
};

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Merge a stored/patch object over a base, ignoring anything unrecognised. */
export function mergeDiscountApproval(
  base: DiscountApprovalSettings,
  patch: unknown,
): DiscountApprovalSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    maxAmountWithoutApproval: num(p.maxAmountWithoutApproval, base.maxAmountWithoutApproval),
    maxPercentWithoutApproval: num(p.maxPercentWithoutApproval, base.maxPercentWithoutApproval),
  };
}

/**
 * Does this concession need approving?
 *
 * `base` is what the discount is measured against — the bill's net before the
 * concession. A zero limit means that particular test is not configured, not
 * that everything trips it; a hospital that sets neither limit but switches the
 * feature on gets no gate rather than a counter that blocks every discount.
 */
export function discountNeedsApproval(
  settings: DiscountApprovalSettings,
  discountAmount: number,
  base: number,
): boolean {
  if (!settings.enabled) return false;
  if (discountAmount <= 0) return false;

  const { maxAmountWithoutApproval: maxAmt, maxPercentWithoutApproval: maxPct } = settings;
  if (maxAmt > 0 && discountAmount > maxAmt) return true;
  if (maxPct > 0 && base > 0 && (discountAmount / base) * 100 > maxPct) return true;
  return false;
}
