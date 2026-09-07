// ---------------------------------------------------------------------------
// GST arithmetic and identity — the one place tax is computed.
//
// Everything that puts a rupee of tax on a document goes through here: the
// front desk bill, the pharmacy counter, the IP ledger, the lab and radiology
// counters, the PDFs, and every report. They agree because they share this
// file, not because four call sites were written carefully.
//
// Three things this file exists to stop:
//
//   1. Drift. `billing.service.ts` rounds with a local `r2`, the pharmacy with
//      a local `round2`, and the reports re-derive tax from a bill total. The
//      three disagree by paise, and paise are exactly what an audit notices.
//
//   2. Tax charged twice. A medicine price is MRP — the GST is already inside
//      it — while a room rate is entered without tax. Applying the wrong one
//      turned a ₹100 strip into ₹112 on an IP bill for the identical item.
//      The caller states which it is; the maths follows from that.
//
//   3. A split that does not add up. CGST and SGST must sum to the tax exactly,
//      to the paisa, because all three are reported separately and the return
//      will not balance otherwise.
//
// Deliberately pure: no Prisma, no clock, no config. What rate applies is a
// question about master data and the context of a supply, and it is answered
// elsewhere. This file only knows what to do once the rate is known.
// ---------------------------------------------------------------------------

/**
 * How a supply is treated, which is NOT the same question as what rate it
 * carries. Three of these are zero-rate and the return reports each on its own
 * line, so collapsing them all to "0%" — which is what the system does today —
 * throws away the distinction GSTR-1 and GSTR-3B ask for.
 */
export type GstTreatment =
  /** Tax is charged at the stated rate. */
  | 'taxable'
  /** The law exempts this supply. Consultation, surgery, IP treatment. */
  | 'exempt'
  /** The rate itself is nil. Notified life-saving drugs, ORS. */
  | 'nil_rated'
  /** Outside GST altogether. */
  | 'non_gst'
  /** Export or SEZ supply. */
  | 'zero_rated';

export const GST_TREATMENTS: readonly GstTreatment[] = [
  'taxable',
  'exempt',
  'nil_rated',
  'non_gst',
  'zero_rated',
] as const;

/**
 * What a treatment is CALLED on a document a patient reads.
 *
 * A bill prints these where a rate would otherwise go, so they have to be the
 * words a patient and an auditor both recognise — not the enum.
 */
export const GST_TREATMENT_LABELS: Record<GstTreatment, string> = {
  taxable: 'Taxable',
  exempt: 'Exempt',
  nil_rated: 'Nil rated',
  non_gst: 'Non-GST',
  zero_rated: 'Zero rated',
};

export function isGstTreatment(v: unknown): v is GstTreatment {
  return typeof v === 'string' && (GST_TREATMENTS as readonly string[]).includes(v);
}

/** Only a `taxable` line can carry a rate above zero. */
export function treatmentAllowsTax(t: GstTreatment): boolean {
  return t === 'taxable';
}

// ── Rounding ───────────────────────────────────────────────────────────────
//
// One rule, stated once:
//   1. tax per line, rounded to paise
//   2. sum the lines to get the invoice totals
//   3. round the grand total to the rupee, and keep the difference visible
//   4. never re-derive tax backwards from a total
//
// Money is held as a number here because the columns are Decimal(12,2) and the
// values are rupees, far inside the range where a double is exact to the paisa.
// Rounding goes through paise integers so that half-way cases land the same way
// every time rather than following the platform's float representation.

/** Round to paise. */
export function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Whole paise, for arithmetic that must not lose a fraction. */
export function toPaise(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100);
}

export function fromPaise(p: number): number {
  return Math.round(p) / 100;
}

/**
 * The invoice's round-off line: what the grand total becomes, and the
 * difference that has to be shown so the arithmetic on the page adds up.
 *
 * Never applied to the tax figures themselves — those are what get reported.
 */
export function roundOffTotal(total: number): { rounded: number; roundOff: number } {
  const rounded = Math.round(total);
  return { rounded, roundOff: r2(rounded - total) };
}

// ── The split ──────────────────────────────────────────────────────────────

export interface TaxSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Split a line's tax into the heads that will be reported.
 *
 * Intra-state is CGST + SGST, half each. Inter-state is IGST, all of it. The
 * halves are taken in paise so they always sum back to the tax exactly; an odd
 * paisa goes to CGST, consistently, so the same input never produces two
 * different answers.
 */
export function splitTax(taxAmount: number, interState: boolean): TaxSplit {
  const paise = toPaise(taxAmount);
  if (paise === 0) return { cgst: 0, sgst: 0, igst: 0 };
  if (interState) return { cgst: 0, sgst: 0, igst: fromPaise(paise) };
  const cgstPaise = Math.ceil(paise / 2);
  return {
    cgst: fromPaise(cgstPaise),
    sgst: fromPaise(paise - cgstPaise),
    igst: 0,
  };
}

// ── The line ───────────────────────────────────────────────────────────────

export interface LineTaxInput {
  /** Price for ONE unit. MRP when `taxInclusive`, ex-tax otherwise. */
  unitPrice: number;
  quantity: number;
  /** Money off, before tax is worked out. GST is charged on the net. */
  discountAmount?: number;
  /** The rate that applies, e.g. 5 for 5%. Ignored unless treatment is taxable. */
  ratePercent: number;
  treatment: GstTreatment;
  /** True when the tax is already inside the price — a medicine at MRP. */
  taxInclusive: boolean;
  /** True when the place of supply is a different state from the supplier. */
  interState?: boolean;
}

export interface LineTax extends TaxSplit {
  /** qty × unitPrice, before discount. */
  grossAmount: number;
  discountAmount: number;
  /** What the tax is charged on. */
  taxableValue: number;
  /** The rate actually applied — forced to 0 for a non-taxable treatment. */
  ratePercent: number;
  taxAmount: number;
  /** What the patient pays for this line. */
  totalAmount: number;
  taxInclusive: boolean;
}

/**
 * The money on one line.
 *
 * Tax-EXCLUSIVE (services, rooms, procedures): the price is the taxable value
 * and the tax is added on top.
 *
 * Tax-INCLUSIVE (medicines at MRP): the price is the total and the tax is dug
 * out of it. The taxable value is rounded first and the tax is then taken as
 * the remainder, so the two always add back to the price the patient was
 * quoted — deriving both independently is what lets a bill end a paisa away
 * from the printed MRP.
 */
export function computeLineTax(input: LineTaxInput): LineTax {
  const quantity = Number.isFinite(input.quantity) ? input.quantity : 0;
  const unitPrice = Number.isFinite(input.unitPrice) ? input.unitPrice : 0;
  const grossAmount = r2(unitPrice * quantity);

  // A discount cannot take a line below zero, and it cannot exceed the line.
  const discountAmount = Math.min(
    Math.max(0, r2(input.discountAmount ?? 0)),
    Math.max(0, grossAmount),
  );
  const net = r2(grossAmount - discountAmount);

  const taxable = treatmentAllowsTax(input.treatment);
  const ratePercent = taxable ? Math.max(0, input.ratePercent || 0) : 0;
  const interState = input.interState ?? false;

  if (ratePercent <= 0) {
    return {
      grossAmount,
      discountAmount,
      taxableValue: net,
      ratePercent: 0,
      taxAmount: 0,
      totalAmount: net,
      taxInclusive: input.taxInclusive,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
  }

  let taxableValue: number;
  let taxAmount: number;
  let totalAmount: number;

  if (input.taxInclusive) {
    taxableValue = r2(net / (1 + ratePercent / 100));
    taxAmount = r2(net - taxableValue);
    totalAmount = net;
  } else {
    taxableValue = net;
    taxAmount = r2(net * (ratePercent / 100));
    totalAmount = r2(net + taxAmount);
  }

  return {
    grossAmount,
    discountAmount,
    taxableValue,
    ratePercent,
    taxAmount,
    totalAmount,
    taxInclusive: input.taxInclusive,
    ...splitTax(taxAmount, interState),
  };
}

/**
 * Scale a line's embedded tax when a discount is applied to the WHOLE bill
 * after the lines are priced — the pharmacy counter's bill-level discount.
 *
 * The tax has to come down in the same proportion as the money, or the invoice
 * reports tax on value the patient was never charged.
 */
export function scaleInclusiveTax(taxAmount: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  return r2(taxAmount * Math.min(1, ratio));
}

// ── Documents ──────────────────────────────────────────────────────────────

/**
 * What the document is called is decided by what is on it, never by a person.
 *
 * Today every bill in the system prints the word "Bill", which is not one of
 * the documents the law recognises.
 */
export type GstDocumentType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'invoice_cum_bill_of_supply'
  | 'credit_note'
  | 'debit_note'
  /** Rule 50 — issued when an advance is received. */
  | 'receipt_voucher'
  /** Rule 51 — issued when an advance is returned without a supply. */
  | 'refund_voucher';

export interface DocumentTypeInput {
  hasTaxable: boolean;
  hasExempt: boolean;
  /** True when the recipient has a GSTIN — a corporate, insurer or TPA. */
  recipientIsRegistered?: boolean;
}

export interface DocumentTypeResult {
  documentType: GstDocumentType;
  /**
   * Rule 46A allows ONE document for a mixed bill only when the recipient is
   * unregistered. A registered recipient with both kinds of line is strictly
   * owed a tax invoice AND a separate bill of supply, so the caller is told.
   */
  requiresSeparateBillOfSupply: boolean;
}

export function resolveDocumentType(input: DocumentTypeInput): DocumentTypeResult {
  const { hasTaxable, hasExempt } = input;
  const registered = input.recipientIsRegistered ?? false;

  // Nothing taxable — including a bill with no lines at all — is a bill of
  // supply. A hospital whose whole day is consultations issues these all day.
  if (!hasTaxable) {
    return { documentType: 'bill_of_supply', requiresSeparateBillOfSupply: false };
  }
  if (!hasExempt) {
    return { documentType: 'tax_invoice', requiresSeparateBillOfSupply: false };
  }
  if (registered) {
    return { documentType: 'tax_invoice', requiresSeparateBillOfSupply: true };
  }
  return { documentType: 'invoice_cum_bill_of_supply', requiresSeparateBillOfSupply: false };
}

export const DOCUMENT_TYPE_LABELS: Record<GstDocumentType, string> = {
  tax_invoice: 'Tax Invoice',
  bill_of_supply: 'Bill of Supply',
  invoice_cum_bill_of_supply: 'Invoice-cum-Bill of Supply',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  receipt_voucher: 'Receipt Voucher',
  refund_voucher: 'Refund Voucher',
};

// ── Identity: GSTIN and place of supply ────────────────────────────────────

/**
 * The GST state codes, as they appear in the first two digits of every GSTIN.
 * Needed twice over: to print "place of supply" on the invoice the way the law
 * asks for it, and to decide CGST+SGST against IGST.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

export function stateNameForCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return GST_STATE_CODES[String(code).padStart(2, '0')] ?? null;
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export interface GstinCheck {
  valid: boolean;
  normalized: string | null;
  stateCode: string | null;
  stateName: string | null;
  /** Why it failed, for the supplier-GSTIN exception report. */
  reason: string | null;
}

/**
 * Validate a GSTIN properly — shape, a real state code, AND the check digit.
 *
 * The checksum matters more than it looks. A supplier GSTIN that is one
 * character wrong passes a regex, looks right on a purchase invoice, and then
 * silently fails to match anything in GSTR-2B — so the input credit is lost
 * without anybody being told why.
 */
export function checkGstin(input: string | null | undefined): GstinCheck {
  const fail = (reason: string): GstinCheck => ({
    valid: false,
    normalized: null,
    stateCode: null,
    stateName: null,
    reason,
  });

  if (input == null) return fail('No GSTIN provided');
  const g = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (!g) return fail('No GSTIN provided');
  if (g.length !== 15) return fail(`Must be 15 characters, got ${g.length}`);
  if (!GSTIN_SHAPE.test(g)) return fail('Does not match the GSTIN format');

  const stateCode = g.slice(0, 2);
  if (!GST_STATE_CODES[stateCode]) return fail(`"${stateCode}" is not a GST state code`);

  // Modulus-36 check digit over the first 14 characters, alternating weights.
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(g[i]!);
    if (value < 0) return fail('Contains a character that is not allowed');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = GSTIN_CHARSET[(36 - (sum % 36)) % 36];
  if (expected !== g[14]) return fail('Check digit does not match');

  return {
    valid: true,
    normalized: g,
    stateCode,
    stateName: GST_STATE_CODES[stateCode] ?? null,
    reason: null,
  };
}

/**
 * Intra-state or inter-state, which is the only question that decides whether
 * a line carries CGST+SGST or IGST.
 *
 * When either side is unknown we answer intra-state. A hospital serves the
 * patient in front of it, so that is the overwhelmingly common case, and it is
 * also the safer wrong answer: CGST+SGST paid where IGST was due is a
 * correctable misclassification, while IGST charged to a walk-in patient who
 * has no way to claim it is money simply taken from them.
 */
export function isInterState(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): boolean {
  if (!supplierStateCode || !placeOfSupplyStateCode) return false;
  return String(supplierStateCode).padStart(2, '0') !== String(placeOfSupplyStateCode).padStart(2, '0');
}

// ── HSN / SAC ──────────────────────────────────────────────────────────────

/** Strip everything but digits, the way the HSN master already stores codes. */
export function normalizeHsnSac(code: string | null | undefined): string | null {
  if (code == null) return null;
  const digits = String(code).replace(/\D/g, '');
  return digits.length ? digits : null;
}

/**
 * How many digits the return wants. Six once the hospital's turnover crosses
 * the reporting threshold, four below it — a per-hospital fact, so it is
 * passed in rather than assumed.
 */
export function hsnReportingDigits(sixDigitRequired: boolean): 4 | 6 {
  return sixDigitRequired ? 6 : 4;
}

/** The code as GSTR-1 Table 12 wants it, truncated to the required width. */
export function hsnForReturn(
  code: string | null | undefined,
  sixDigitRequired: boolean,
): string | null {
  const n = normalizeHsnSac(code);
  if (!n) return null;
  const want = hsnReportingDigits(sixDigitRequired);
  return n.length <= want ? n : n.slice(0, want);
}
