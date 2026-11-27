// ---------------------------------------------------------------------------
// Gap #262 — a GST rate the law no longer recognises.
//
// 12% (and 28%) ended on 21 September 2025. An item still carrying one can be
// neither billed at it (the document would be wrong) nor quietly moved to some
// other rate (nobody has said which). So: a master cannot be GIVEN such a rate,
// and a sale of an item that still HAS one stops, naming the item and who can
// fix it. Anything already issued — and every return against it — keeps the
// rate it was issued at; nothing here is called on those paths.
// ---------------------------------------------------------------------------

import { AppError } from '../../shared/appError';
import { checkSlabRate, describeSlabs } from '../../shared/gst-slabs';

export const RETIRED_RATE_CODE = 'GST_RATE_RETIRED';
export const ILLEGAL_RATE_CODE = 'GST_RATE_NOT_ALLOWED';

/** Roles that may correct a medicine's GST rate — the formulary's own, plus finance. */
export const GST_RATE_EDIT_ROLES = [
  'super_admin', 'admin', 'pharmacy_admin', 'inventory_manager', 'billing_admin',
] as const;

export const WHO_CAN_FIX =
  'Ask the Pharmacy Admin, Hospital Admin or Finance (Billing Admin) to set the correct rate in ' +
  'Inventory → Retired GST rates (Finance: Hospital → Retired GST rates)';

export interface RetiredRateItem {
  drugName: string;
  ratePercent: number;
  hsnCode?: string | null;
  /** TaxSource of the rate — 'item_master', 'hsn_master', 'category_default', … */
  source?: string | null;
}

/** Where a resolved rate came from, in staff words. */
export function rateSourceLabel(source: string | null | undefined, hsnCode?: string | null): string {
  switch (source) {
    case 'item_master': return 'the medicine itself';
    case 'hsn_master': return hsnCode ? `the HSN default for ${hsnCode}` : 'the HSN default';
    case 'category_default': return 'the category default';
    case 'manual': return 'a rate typed on the line';
    default: return 'its GST setup';
  }
}

/** One sentence per item, then what happens next. Empty list → null. */
export function retiredRateMessage(items: RetiredRateItem[], allowed: string): string | null {
  if (!items.length) return null;
  const seen = new Set<string>();
  const named = items.filter((i) => {
    const k = `${i.drugName}|${i.ratePercent}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const list = named
    .slice(0, 5)
    .map((i) =>
      `${i.drugName} (${i.hsnCode ? `HSN ${i.hsnCode}, ` : ''}${i.ratePercent}% from ${rateSourceLabel(i.source, i.hsnCode)})`,
    )
    .join('; ');
  const more = named.length > 5 ? ` and ${named.length - 5} more` : '';
  return (
    `Cannot bill at a GST rate that is no longer legal: ${list}${more}. ` +
    `Allowed rates today: ${allowed}. The rate has not been changed for you. ${WHO_CAN_FIX}, then bill again.`
  );
}

/** The block itself. 422 with a code and the items, so a screen can act on it. */
export function retiredRateError(items: RetiredRateItem[], allowed: string): AppError {
  return new AppError(
    retiredRateMessage(items, allowed) ?? 'This item carries a GST rate that is no longer legal.',
    422,
    RETIRED_RATE_CODE,
    { items, allowed },
  );
}

/** The part of a TaxResolver this file needs. */
interface RateChecker {
  isLegalRate(ratePercent: number, on?: Date): boolean;
  describeLegalRates(on?: Date): string;
}

/**
 * Stop a supply whose RESOLVED rate is retired. Takes the determination, not
 * the drug's column, so an inpatient's exempt medicine is never stopped for a
 * rate that is not being charged.
 */
export function assertResolvedRateLegal(
  resolver: RateChecker,
  drugName: string,
  determination: { ratePercent: number; hsnSacCode?: string | null; source?: string | null },
): void {
  if (!(determination.ratePercent > 0)) return;
  if (resolver.isLegalRate(determination.ratePercent)) return;
  throw retiredRateError(
    [{
      drugName,
      ratePercent: determination.ratePercent,
      hsnCode: determination.hsnSacCode ?? null,
      source: determination.source ?? null,
    }],
    resolver.describeLegalRates(),
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Why a rate may not be set from `on`, or null when it may. */
export async function illegalRateReason(
  ratePercent: unknown,
  what: string,
  on: Date = new Date(),
): Promise<string | null> {
  if (ratePercent == null || ratePercent === '') return null;
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const { legal, slabs } = await checkSlabRate(rate, on);
  if (legal) return null;
  return (
    `${rate}% is not a legal GST rate on ${iso(on)}. ${what} must use one of ${describeSlabs(slabs)}.`
  );
}

/** Refuse to put a rate on a master that the law does not recognise on `on`. */
export async function assertMasterRateLegal(
  ratePercent: unknown,
  what: string,
  on: Date = new Date(),
): Promise<void> {
  const reason = await illegalRateReason(ratePercent, what, on);
  if (reason) throw AppError.badRequest(reason, ILLEGAL_RATE_CODE);
}

/**
 * A purchase keeps the rate on the supplier's document whatever it is. This
 * only says so when that rate was not legal on the invoice's date, so the
 * invoice can be queried with the supplier.
 */
export async function purchaseRateWarning(
  ratePercent: unknown,
  invoiceDate: Date | string | null | undefined,
): Promise<string | null> {
  const on = invoiceDate ? new Date(invoiceDate) : new Date();
  if (Number.isNaN(on.getTime())) return null;
  const rate = Number(ratePercent ?? 0);
  if (!(rate > 0)) return null;
  const { legal, slabs } = await checkSlabRate(rate, on);
  if (legal) return null;
  return (
    `Recorded at ${rate}% as on the supplier's document, but ${rate}% was not a legal GST rate on ${iso(on)} ` +
    `(legal: ${describeSlabs(slabs)}). Check the invoice with the supplier before claiming the input tax.`
  );
}
