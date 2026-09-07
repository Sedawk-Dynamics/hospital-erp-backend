// ---------------------------------------------------------------------------
// GST on an advance.
//
// Tax normally attaches to the invoice, not to the tender. Cash, card, UPI and
// a split across three of them all carry identical tax, because the tax is on
// the supply. Asking "do we apply GST to each payment mode" is the wrong
// question — there is nothing there to apply.
//
// An advance is the one real exception. For a SERVICE the time of supply is the
// earlier of invoice or payment, so money taken before the supply happens fixes
// the liability at receipt, and Rule 50 requires a receipt voucher stating the
// rate and the tax.
//
// For a hospital the answer is usually EXEMPT — a deposit is money against
// treatment, and treatment is exempt under Notification 12/2017. But "usually
// exempt" has to be recorded rather than assumed. It is the figure the advances
// report and GSTR-1 table 11 read, and it is not always true: an advance taken
// specifically against a taxable supply, a deluxe room above the threshold or a
// cosmetic procedure, does attract tax when it is received.
//
// Deliberately NOT implementing the Rule 50 proviso — 18% where the rate is not
// determinable, inter-State where the nature of supply is not determinable. For
// a hospital both ARE determinable: the supply is treatment and the patient is
// standing in front of you. Applying the proviso here would invent 18% tax on
// an exempt deposit, which is the single worst outcome available.
// ---------------------------------------------------------------------------

import { logger } from '../../config/logger';
import { computeLineTax, isInterState, type GstTreatment } from '../../shared/gst';
import { gstAppliesOn, type GstProfile } from '../../shared/gst-profile';
import { allotDocumentNumber } from './gst-document.service';

/** What the money was taken against. Decides whether tax is due at receipt. */
export type AdvancePurpose =
  /** A deposit against treatment — the ordinary hospital advance. Exempt. */
  | 'treatment'
  /** Against a room the hospital knows will be over the threshold. */
  | 'accommodation'
  /** Against a cosmetic or other non-therapeutic service. */
  | 'non_therapeutic'
  /** Against something the hospital has classified itself. */
  | 'other';

export interface AdvanceTaxInput {
  amount: number;
  purpose?: AdvancePurpose;
  /** Only consulted for a purpose that is taxable. */
  ratePercent?: number | null;
  /** Defaults to the hospital's own state — a patient is served where they are. */
  placeOfSupplyStateCode?: string | null;
  on?: Date;
}

export interface AdvanceTax {
  gstTreatment: GstTreatment;
  taxRatePercent: number;
  taxableValue: number;
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** Plain words for the voucher and for anyone asking why. */
  reason: string;
}

/** Purposes that fix a liability at receipt, and their default rate. */
const TAXABLE_PURPOSES: Record<string, number> = {
  accommodation: 5,
  non_therapeutic: 18,
};

/**
 * What tax, if any, is due on an advance at the moment it is taken.
 *
 * An advance is money in hand, so it is treated as tax-INCLUSIVE: a patient
 * handing over ₹10,000 has handed over ₹10,000, and any tax inside it is dug
 * out rather than added on top. Adding it on top would mean collecting ₹10,500
 * from someone who agreed to pay ₹10,000.
 */
export function computeAdvanceTax(profile: GstProfile, input: AdvanceTaxInput): AdvanceTax {
  const on = input.on ?? new Date();
  const purpose = input.purpose ?? 'treatment';

  const exempt = (reason: string): AdvanceTax => ({
    gstTreatment: 'exempt',
    taxRatePercent: 0,
    taxableValue: Math.max(0, input.amount),
    taxAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    reason,
  });

  if (!gstAppliesOn(profile, on)) {
    return exempt(
      profile.registered
        ? 'No GST: taken before this hospital started filing from this system'
        : 'No GST: this hospital is not registered under GST',
    );
  }

  // The ordinary hospital advance. A deposit against treatment is a deposit
  // against an exempt supply, so nothing is due at receipt.
  const defaultRate = TAXABLE_PURPOSES[purpose];
  if (defaultRate == null) {
    return exempt(
      purpose === 'treatment'
        ? 'Exempt: advance against healthcare treatment, which is an exempt supply'
        : 'Exempt: no taxable supply identified for this advance',
    );
  }

  const ratePercent =
    input.ratePercent != null && input.ratePercent > 0 ? input.ratePercent : defaultRate;

  const money = computeLineTax({
    unitPrice: Math.max(0, input.amount),
    quantity: 1,
    ratePercent,
    treatment: 'taxable',
    // Money in hand. What the patient handed over is what they handed over.
    taxInclusive: true,
    interState: isInterState(
      profile.stateCode,
      input.placeOfSupplyStateCode ?? profile.stateCode,
    ),
  });

  return {
    gstTreatment: 'taxable',
    taxRatePercent: ratePercent,
    taxableValue: money.taxableValue,
    taxAmount: money.taxAmount,
    cgstAmount: money.cgst,
    sgstAmount: money.sgst,
    igstAmount: money.igst,
    reason:
      purpose === 'accommodation'
        ? `Taxable at ${ratePercent}%: advance against room accommodation above the exempt threshold`
        : `Taxable at ${ratePercent}%: advance against a non-therapeutic supply`,
  };
}

/**
 * The columns to write onto the advance's Payment row.
 *
 * A voucher number is allotted from the hospital's own series, the same
 * machinery an invoice number comes from, because Rule 50 wants a voucher that
 * is consecutive and unique for the financial year — which the daily-resetting,
 * cross-tenant receipt series is not.
 */
export async function advancePaymentTaxFields(
  tx: any,
  tenantId: string,
  profile: GstProfile,
  input: AdvanceTaxInput,
): Promise<Record<string, unknown>> {
  const tax = computeAdvanceTax(profile, input);
  const on = input.on ?? new Date();

  let voucherNumber: string | null = null;
  if (profile.registered) {
    try {
      const alloted = await allotDocumentNumber(tx, tenantId, 'receipt_voucher', on);
      voucherNumber = alloted.invoiceNumber;
    } catch (err) {
      // Taking the patient's money must not fail because a voucher number
      // could not be allotted. The tax position is still recorded either way.
      logger.warn({ err, tenantId }, 'Could not allot a receipt voucher number for an advance');
    }
  }

  return {
    gstTreatment: tax.gstTreatment,
    taxRatePercent: tax.taxRatePercent,
    taxableValue: tax.taxableValue,
    taxAmount: tax.taxAmount,
    cgstAmount: tax.cgstAmount,
    sgstAmount: tax.sgstAmount,
    igstAmount: tax.igstAmount,
    voucherType: 'receipt_voucher',
    voucherNumber,
  };
}
