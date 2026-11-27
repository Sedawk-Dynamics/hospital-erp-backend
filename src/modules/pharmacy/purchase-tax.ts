// ---------------------------------------------------------------------------
// Purchase-side GST: the input tax on a goods receipt, and the input tax to
// reverse when those goods go back (vendor return) or are written off.
//
// G-9 / G-10 / G-12. Receipts used to record one tax figure with no head split,
// so an inter-state supplier's IGST was booked as CGST+SGST; PO receipts stored
// the PO number as the "invoice"; and vendor returns carried no rate at all, so
// the tax to reverse came out as ₹0. Everything here is pure except
// `homeStateCode`, which only reads the hospital's GST profile.
// ---------------------------------------------------------------------------

import { AppError } from '../../shared/appError';
import { isInterState, splitTax, r2 } from '../../shared/gst';

export interface SupplierTaxIdentity {
  name?: string | null;
  gstNumber?: string | null;
  stateCode?: string | null;
}

/** The supplier's state: the stored code, else the GSTIN's first two digits. */
export function supplierStateOf(s: SupplierTaxIdentity | null | undefined): string | null {
  if (!s) return null;
  if (s.stateCode && /^\d{2}$/.test(s.stateCode)) return s.stateCode;
  const g = String(s.gstNumber ?? '').trim();
  return /^\d{2}/.test(g) ? g.slice(0, 2) : null;
}

/** A supplier with a GSTIN is registered, and issues a tax invoice. */
export function isRegisteredSupplier(s: SupplierTaxIdentity | null | undefined): boolean {
  return !!String(s?.gstNumber ?? '').trim();
}

/**
 * G-9: input credit can only be claimed against the supplier's own invoice, so
 * a receipt from a GST-registered supplier must carry its number and date.
 */
export function assertSupplierInvoice(
  supplier: SupplierTaxIdentity | null | undefined,
  invoiceNumber: string | null | undefined,
  invoiceDate: string | Date | null | undefined,
): void {
  if (!isRegisteredSupplier(supplier)) return;
  const missing = [
    !String(invoiceNumber ?? '').trim() ? 'invoice number' : null,
    !invoiceDate ? 'invoice date' : null,
  ].filter(Boolean);
  if (missing.length) {
    throw AppError.badRequest(
      `${supplier?.name ?? 'This supplier'} is GST-registered — enter the supplier ${missing.join(' and ')} ` +
        'from their tax invoice so the input tax can be claimed.',
    );
  }
}

export interface InputTaxSplit {
  taxableValue: number;
  gstPercent: number | null;
  taxAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  interState: boolean;
}

/**
 * G-10: the tax on one receipt line, split by comparing the supplier's state
 * with the hospital's. Either side unknown → intra-state (the shared rule).
 */
export function purchaseLineTax(input: {
  taxableValue: number;
  ratePercent: number | null | undefined;
  supplierState: string | null | undefined;
  homeState: string | null | undefined;
}): InputTaxSplit {
  const rate = input.ratePercent != null && Number.isFinite(Number(input.ratePercent))
    ? Number(input.ratePercent)
    : null;
  const taxableValue = r2(Math.max(0, input.taxableValue));
  const taxAmount = rate != null ? r2(taxableValue * (rate / 100)) : 0;
  const interState = isInterState(input.supplierState, input.homeState);
  const s = splitTax(taxAmount, interState);
  return { taxableValue, gstPercent: rate, taxAmount, cgst: s.cgst, sgst: s.sgst, igst: s.igst, interState };
}

export interface PurchasedBatchTax {
  purchasePrice?: unknown;
  purchaseDiscountPercent?: unknown;
  gstPercent?: unknown;
  inputCgst?: unknown;
  inputSgst?: unknown;
  inputIgst?: unknown;
  supplier?: SupplierTaxIdentity | null;
}

const num = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * G-12: the input tax to reverse on `quantity` units leaving a purchase batch
 * (vendor return or write-off) — priced at the net rate PAID, at the batch's
 * own GST rate, split the way the batch was split when it came in. A batch
 * received before the split was stored falls back to the state comparison.
 *
 * `fallbackRatePercent` is the drug's rate, used only when the batch itself
 * recorded none (old receipts), so the reversal is not silently ₹0.
 */
export function inputTaxToReverse(
  batch: PurchasedBatchTax,
  quantity: number,
  homeState: string | null | undefined,
  fallbackRatePercent?: number | null,
): InputTaxSplit {
  const rate = num(batch.purchasePrice);
  const disc = num(batch.purchaseDiscountPercent) ?? 0;
  const netRate = rate != null ? r2(rate * (1 - disc / 100)) : 0;
  const taxableValue = r2(netRate * Math.max(0, quantity));
  const gst = num(batch.gstPercent) ?? (fallbackRatePercent != null ? fallbackRatePercent : null);

  const storedC = num(batch.inputCgst);
  const storedS = num(batch.inputSgst);
  const storedI = num(batch.inputIgst);
  const hasStored = storedC != null || storedS != null || storedI != null;
  const interState = hasStored
    ? (storedI ?? 0) > 0 && (storedC ?? 0) === 0
    : isInterState(supplierStateOf(batch.supplier), homeState);

  const taxAmount = gst != null ? r2(taxableValue * (gst / 100)) : 0;
  const s = splitTax(taxAmount, interState);
  return { taxableValue, gstPercent: gst, taxAmount, cgst: s.cgst, sgst: s.sgst, igst: s.igst, interState };
}

/**
 * #262: the rate to reverse at when the batch recorded none of its own — the
 * drug's rate AS IT STOOD when the stock came in. The drug's current rate alone
 * would move the reversal the day the drug is re-rated (12% → 5%), so a vendor
 * return of old stock would no longer match the supplier's document. The item
 * rate log answers what the rate was; with no logged change it never moved.
 */
export async function drugRateWhenReceived(
  tenantId: string,
  batch: { drugId?: string | null; gstPercent?: unknown; createdAt?: Date | null },
  currentRate: unknown,
): Promise<number | null> {
  const current = num(currentRate);
  if (num(batch.gstPercent) != null || !batch.drugId || !batch.createdAt) return current;
  try {
    const { prisma } = await import('../../config/database');
    const { ensureItemRateChangeTable } = await import('../gst/gst-rate-log');
    await ensureItemRateChangeTable();
    const firstChange = await prisma.gstItemRateChange.findFirst({
      where: {
        tenantId, itemType: 'drug', itemId: batch.drugId, action: 'update',
        changedAt: { gt: batch.createdAt },
      },
      orderBy: { changedAt: 'asc' },
      select: { previousRate: true },
    });
    return num(firstChange?.previousRate) ?? current;
  } catch {
    return current;
  }
}

/**
 * G-12: which negative stock adjustments are write-offs. An explicit type wins;
 * otherwise the reason decides, so the existing adjust dialog (reason only)
 * still records a damaged-stock write-off without a new field.
 */
export type WriteOffType = 'damaged' | 'expired' | 'other';
export function writeOffTypeFor(
  explicit: string | null | undefined,
  reason: string | null | undefined,
): WriteOffType | null {
  if (explicit === 'damaged' || explicit === 'expired' || explicit === 'other') return explicit;
  const r = String(reason ?? '').toLowerCase();
  if (/damag|broke|breakage|leak|spoil|spill|torn|crush|contaminat/.test(r)) return 'damaged';
  if (/expir/.test(r)) return 'expired';
  if (/write[\s-]?off|written off|destroy|discard/.test(r)) return 'other';
  return null;
}

/** The hospital's own GST state, or null when the profile cannot be read. */
export async function homeStateCode(tenantId: string): Promise<string | null> {
  try {
    const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
    return (await getGstProfile(tenantId)).stateCode ?? null;
  } catch {
    return null;
  }
}
