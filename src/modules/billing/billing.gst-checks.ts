// ---------------------------------------------------------------------------
// GST checks a bill goes through on its way to becoming a document.
//
//   * G-4 — the buyer. A bill with a valid GSTIN on it is a B2B supply: the
//     invoice names the buyer, and for a SERVICE the place of supply is the
//     buyer's registered state (IGST Act s.12(2)(a)), which is what decides
//     CGST+SGST against IGST.
//   * G-3 — a service line with no SAC code. Rule 46 wants the code on a tax
//     invoice and GSTR-1 Table 12 groups by it.
//
// Pure apart from the Prisma calls in `resplitBillLines`, so the rules can be
// tested without a database.
// ---------------------------------------------------------------------------

import { AppError } from '../../shared/appError';
import { checkGstin, r2 } from '../../shared/gst';

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

/**
 * Service lines with no SAC code on a registered hospital's bill (G-3).
 *
 * A WARNING, deliberately, not a refusal: consultations, lab tests and most
 * IP charges are raised by paths that have no service master behind them yet
 * (46 of 79 sales lines in the QA data), so refusing here would stop the
 * hospital finalising almost any bill until every service is mapped.
 */
export function serviceLinesWithoutSac(
  items: Array<{ description?: string | null; category?: string | null; hsnSacCode?: string | null }>,
  registered: boolean,
): string[] {
  if (!registered) return [];
  return items
    .filter((i) => !GOODS_CATEGORIES.has(String(i.category ?? '').toLowerCase()) && !i.hsnSacCode)
    .map((i) => i.description || 'Unnamed service');
}

export function sacWarningFor(missing: string[]): string | null {
  if (!missing.length) return null;
  const names = missing.slice(0, 3).join(', ');
  return (
    `${missing.length} service line(s) have no SAC code: ${names}${missing.length > 3 ? '…' : ''}. ` +
    'The invoice is issued, but map these services in Settings → GST classification so the code prints and GSTR-1 can group them.'
  );
}

/**
 * Re-split a line's tax for the place of supply (G-4). Lines are priced as
 * intra-state when they are raised; once a registered buyer from another state
 * is on the bill the same tax is IGST, and the reverse when the buyer is
 * removed. The amount never changes — only which head it sits under.
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
