// ---------------------------------------------------------------------------
// GST checks a bill goes through on its way to becoming a document.
//
//   * G-4 — the buyer. A bill with a valid GSTIN on it is a B2B supply: the
//     invoice names the buyer.
//   * #265 — the place of supply. Health services are supplied where they are
//     performed (IGST Act s.12(4)), so it is the HOSPITAL's state whatever the
//     buyer's is, and the tax is CGST + SGST. Only an explicit exception on the
//     draft bill (goods shipped out, a service performed off site) changes it.
//   * #264 — a service line with no SAC code. Warned and allowed at 0%; a bill
//     is refused when such a line carries GST.
//
// Pure, so the rules can be tested without a database.
// ---------------------------------------------------------------------------

import { AppError } from '../../shared/appError';
import { checkGstin, r2, stateNameForCode } from '../../shared/gst';

export interface BuyerInput {
  gstin?: string | null;
  legalName?: string | null;
  address?: string | null;
}

export interface BuyerFields {
  recipientGstin: string | null;
  recipientLegalName: string | null;
  recipientAddress: string | null;
  /** The GSTIN's own state code — the first two digits ARE the state. */
  buyerStateCode: string | null;
}

/**
 * Validate and normalise a buyer (G-4). A blank GSTIN clears the buyer, which
 * makes the bill B2C again. An invalid one is refused, check digit included —
 * a wrong GSTIN is an invoice the portal will reject, not a value to tidy up.
 */
export function normalizeBuyer(input: BuyerInput | null | undefined): BuyerFields {
  const raw = String(input?.gstin ?? '').trim().toUpperCase();
  const legalName = String(input?.legalName ?? '').trim() || null;
  const address = String(input?.address ?? '').trim() || null;
  if (!raw) {
    return { recipientGstin: null, recipientLegalName: legalName, recipientAddress: address, buyerStateCode: null };
  }
  const check = checkGstin(raw);
  if (!check.valid || !check.normalized) {
    throw AppError.badRequest(`Buyer GSTIN ${raw} is not valid — ${check.reason ?? 'check the number'}`);
  }
  // Rule 46(e): a tax invoice to a registered person carries their name.
  if (!legalName) {
    throw AppError.badRequest('Enter the buyer\'s legal name as registered with the GSTIN');
  }
  return {
    recipientGstin: check.normalized,
    recipientLegalName: legalName.slice(0, 200),
    recipientAddress: address ? address.slice(0, 500) : null,
    buyerStateCode: check.normalized.slice(0, 2),
  };
}

/** Bill categories that are goods; everything else is a service and wants a SAC. */
const GOODS_CATEGORIES = new Set(['pharmacy', 'consumable', 'product', 'equipment', 'surgical_supply']);

export const isGoodsCategory = (category: string | null | undefined): boolean =>
  GOODS_CATEGORIES.has(String(category ?? '').toLowerCase());

/** The part of a bill line these checks read. */
export interface SacCheckLine {
  description?: string | null;
  category?: string | null;
  hsnSacCode?: string | null;
  taxPercent?: unknown;
  taxAmount?: unknown;
  gstTreatment?: string | null;
}

const missingSac = (i: SacCheckLine) => !isGoodsCategory(i.category) && !String(i.hsnSacCode ?? '').trim();

/**
 * Whether a line carries GST above 0%: a positive rate on a line that is not
 * exempt, or tax in rupees however it got there.
 */
export function lineCarriesGst(i: SacCheckLine): boolean {
  if (Number(i.taxAmount ?? 0) > 0) return true;
  if (!(Number(i.taxPercent ?? 0) > 0)) return false;
  return !i.gstTreatment || i.gstTreatment === 'taxable';
}

/**
 * Service lines with no SAC code on a registered hospital's bill (G-3 / #264).
 *
 * At 0% this is a WARNING, not a refusal (the client's decision): the bill is
 * issued and the service shows on the Missing SAC codes report.
 */
export function serviceLinesWithoutSac(items: SacCheckLine[], registered: boolean): string[] {
  if (!registered) return [];
  return items.filter(missingSac).map((i) => i.description || 'Unnamed service');
}

/** The exception to that (#264): service lines with no SAC that DO carry GST. */
export function taxedServiceLinesWithoutSac(items: SacCheckLine[], registered: boolean): string[] {
  if (!registered) return [];
  return items
    .filter((i) => missingSac(i) && lineCarriesGst(i))
    .map((i) => i.description || 'Unnamed service');
}

/** The code the refusal carries, so a screen can offer the fix rather than print it. */
export const SAC_REQUIRED = 'SAC_REQUIRED';

/**
 * Refuse a bill whose taxed service lines have no SAC (#264). Called BEFORE
 * anything on the bill is changed, so a refusal leaves it exactly as it was.
 */
export function assertTaxedServicesHaveSac(items: SacCheckLine[], registered: boolean): void {
  const blocked = [...new Set(taxedServiceLinesWithoutSac(items, registered))];
  if (!blocked.length) return;
  const one = blocked.length === 1;
  throw AppError.conflict(
    `This bill cannot be issued: ${blocked.join(', ')} ${one ? 'carries GST but has' : 'carry GST but have'} no SAC code. ` +
      'Ask the hospital admin to set the code in Settings → GST classification (for the registration fee: ' +
      'Settings → Registration fee), then issue the bill again.',
    SAC_REQUIRED,
    { services: blocked },
  );
}

export function sacWarningFor(missing: string[]): string | null {
  if (!missing.length) return null;
  const names = missing.slice(0, 3).join(', ');
  return (
    `${missing.length} service line(s) have no SAC code: ${names}${missing.length > 3 ? '…' : ''}. ` +
    'The invoice is issued, but map these services in Settings → GST classification so the code prints and GSTR-1 can group them.'
  );
}

// ── Place of supply (#265) ─────────────────────────────────────────────────

export const SUPPLY_TYPES = ['performed_at_hospital', 'goods_shipped', 'off_site_service'] as const;
export type SupplyType = (typeof SUPPLY_TYPES)[number];

export const SUPPLY_TYPE_LABELS: Record<SupplyType, string> = {
  performed_at_hospital: 'Performed at the hospital',
  goods_shipped: 'Goods shipped to another place',
  off_site_service: 'Service performed off site',
};

export function supplyTypeOf(v: unknown): SupplyType {
  return (SUPPLY_TYPES as readonly unknown[]).includes(v) ? (v as SupplyType) : 'performed_at_hospital';
}

/**
 * Where a bill is supplied. The hospital's own state unless the draft carries an
 * explicit exception; the buyer's state is never read.
 */
export function placeOfSupplyFor(
  bill: { supplyType?: string | null; supplyDestinationStateCode?: string | null },
  hospitalStateCode: string | null | undefined,
): string | null {
  const type = supplyTypeOf(bill.supplyType);
  if (type !== 'performed_at_hospital' && bill.supplyDestinationStateCode) return bill.supplyDestinationStateCode;
  return hospitalStateCode ?? null;
}

/** Services that can only be performed in the hospital's own building. */
const PERFORMED_HERE_CATEGORIES = new Set(['room', 'surgery', 'procedure', 'lab', 'radiology', 'nursing', 'registration']);
/** A line raised by something that happened here (a visit, an order, a bed day). */
const ENCOUNTER_REFERENCES =
  /^(visit|appointment|registration|lab_order|imaging_request|ot_|room|bed|ward|doctor_visit|manual_clinical|admission)/;

export interface SupplyLine {
  description?: string | null;
  category?: string | null;
  referenceType?: string | null;
}

/**
 * Refuse an exception its own lines contradict. One bill has ONE place of
 * supply: lines that belong somewhere else go on a bill of their own.
 */
export function assertSupplyTypeFitsLines(
  supplyType: SupplyType,
  lines: SupplyLine[],
  opts: { admissionId?: string | null } = {},
): void {
  if (supplyType === 'performed_at_hospital') return;
  if (opts.admissionId) {
    throw AppError.conflict(
      'This is an inpatient bill: its charges are performed at the hospital. Raise a separate bill for anything shipped out or done off site.',
      'SUPPLY_TYPE_CONFLICT',
    );
  }
  const fromEncounter = (l: SupplyLine) => ENCOUNTER_REFERENCES.test(String(l.referenceType ?? ''));
  const bad =
    supplyType === 'goods_shipped'
      ? lines.filter((l) => !isGoodsCategory(l.category) || fromEncounter(l))
      : lines.filter(
          (l) =>
            isGoodsCategory(l.category) ||
            PERFORMED_HERE_CATEGORIES.has(String(l.category ?? '').toLowerCase()) ||
            fromEncounter(l),
        );
  if (!bad.length) return;
  const names = [...new Set(bad.map((l) => l.description || 'Unnamed line'))];
  const shown = names.slice(0, 5).join(', ');
  throw AppError.conflict(
    supplyType === 'goods_shipped'
      ? `"Goods shipped" cannot be used on this bill, because it carries what was supplied at the hospital: ${shown}. Put the shipped goods on a bill of their own.`
      : `"Service performed off site" cannot be used on this bill, because it carries goods or services supplied at the hospital: ${shown}. Put the off-site service on a bill of its own.`,
    'SUPPLY_TYPE_CONFLICT',
    { lines: names },
  );
}

export interface SupplyTypeInput {
  supplyType?: unknown;
  destinationStateCode?: string | null;
  reason?: string | null;
}

/** Validate a supply-type choice against the bill it is for. */
export function normalizeSupplyType(
  input: SupplyTypeInput,
  bill: { recipientGstin?: string | null; admissionId?: string | null; billItems: SupplyLine[] },
): { supplyType: SupplyType; supplyDestinationStateCode: string | null; supplyTypeReason: string | null } {
  if (!(SUPPLY_TYPES as readonly unknown[]).includes(input.supplyType)) {
    throw AppError.badRequest('Choose where this bill is supplied: performed at the hospital, goods shipped, or off-site service');
  }
  const supplyType = input.supplyType as SupplyType;
  const reason = String(input.reason ?? '').trim().slice(0, 255) || null;
  if (supplyType === 'performed_at_hospital') {
    return { supplyType, supplyDestinationStateCode: null, supplyTypeReason: reason };
  }
  const raw = String(input.destinationStateCode ?? '').trim();
  const code = raw ? raw.padStart(2, '0') : '';
  if (!code || !stateNameForCode(code) || code === '99') {
    throw AppError.badRequest('Choose the destination state');
  }
  if (!reason || reason.length < 3) {
    throw AppError.badRequest('Give the reason this bill is not supplied at the hospital');
  }
  if (supplyType === 'off_site_service') {
    // A service to a registered person is supplied where they are registered
    // (IGST Act s.12(2)(a)), so the state has to be the GSTIN's own.
    if (!bill.recipientGstin) {
      throw AppError.badRequest(
        "Add the buyer's GSTIN first: an off-site service is billed to a registered buyer in that state",
      );
    }
    const buyerState = bill.recipientGstin.slice(0, 2);
    if (buyerState !== code) {
      throw AppError.badRequest(
        `The destination state must be the buyer's registered state (${stateNameForCode(buyerState) ?? buyerState})`,
      );
    }
  }
  assertSupplyTypeFitsLines(supplyType, bill.billItems, bill);
  return { supplyType, supplyDestinationStateCode: code, supplyTypeReason: reason };
}

/**
 * Re-split a line's tax for the place of supply. Lines are priced as intra-state
 * when they are raised; on a bill with an explicit out-of-state exception (#265)
 * the same tax is IGST, and the reverse when the exception is removed. The
 * amount never changes — only which head it sits under.
 */
export function resplitLine(
  line: {
    taxPercent?: unknown; taxAmount?: unknown;
    cgstAmount?: unknown; sgstAmount?: unknown; igstAmount?: unknown;
  },
  interState: boolean,
): {
  cgstRate: number; cgstAmount: number; sgstRate: number; sgstAmount: number; igstRate: number; igstAmount: number;
} | null {
  const rate = Number(line.taxPercent ?? 0);
  const tax = r2(Number(line.cgstAmount ?? 0) + Number(line.sgstAmount ?? 0) + Number(line.igstAmount ?? 0));
  const isIgst = Number(line.igstAmount ?? 0) > 0;
  if (tax <= 0 || isIgst === interState) return null;
  if (interState) {
    return { cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0, igstRate: rate, igstAmount: tax };
  }
  // In paise, odd paisa to CGST — the same rule as shared/gst splitTax.
  const paise = Math.round(tax * 100);
  const cg = Math.ceil(paise / 2);
  const half = Math.round((rate / 2) * 100) / 100;
  return { cgstRate: half, cgstAmount: cg / 100, sgstRate: half, sgstAmount: (paise - cg) / 100, igstRate: 0, igstAmount: 0 };
}
