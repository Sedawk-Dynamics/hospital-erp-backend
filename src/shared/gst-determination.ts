// ---------------------------------------------------------------------------
// Tax determination — deciding WHAT treatment and WHICH rate a supply carries.
//
// The tempting one-liner is "the HSN code decides the rate". It is wrong, and
// this hospital is the counter-example: the same paracetamol strip is EXEMPT
// when a nurse gives it to an admitted patient and TAXABLE at 5% when the
// counter sells it to a walk-in. Same product, same code, same price, two
// answers. So the rule this file implements is:
//
//   the treatment follows from the NATURE and the CONTEXT of the supply,
//   using HSN/SAC codes and the applicable rules and master data
//
// Context is checked before codes, because context is what the law keys on.
//
// The order below is the whole design, and it is deliberate:
//
//   1. not registered / before cut-over — nothing is taxable, full stop
//   2. room rent          — its own statutory rule, and it beats the composite
//                           rule because the government taxes room rent above
//                           the threshold even for an inpatient
//   3. inpatient composite — medicines and consumables used ON an admitted
//                           patient follow the treatment, which is exempt
//   4. cosmetic            — a non-therapeutic procedure is taxable however the
//                           rest of the surgery list is classified
//   5. the item's own approved classification
//   6. the HSN master (goods) / the SAC master (services)
//   7. the category default — a FALLBACK, never an override
//
// Rule 7 carries a safety condition that matters more than it looks. A default
// may only fill a blank; it may never overrule a classification the hospital's
// auditor approved. And when a default is the ONLY thing that made a line
// taxable, the line is marked unresolved so it can be stopped before it reaches
// an invoice — a guessed taxable rate is the one outcome nobody can defend.
//
// Pure by design: every master lookup is done by the caller and handed in, so
// this can be reasoned about and tested without a database.
// ---------------------------------------------------------------------------

import type { GstTreatment } from './gst';
import type { GstProfile } from './gst-profile';
import { gstAppliesOn } from './gst-profile';

/** What is being supplied. Decides which branch of the rule set applies. */
export type SupplyKind =
  | 'medicine'
  | 'consumable'
  | 'room'
  | 'procedure'
  | 'consultation'
  | 'lab'
  | 'imaging'
  | 'nursing'
  | 'registration'
  | 'other';

/** Goods that can form a composite supply with inpatient treatment. */
const COMPOSITE_KINDS: ReadonlySet<SupplyKind> = new Set(['medicine', 'consumable']);

/**
 * The bill's own category, translated into what the rules need to know.
 *
 * `BillItemCategory` describes where a charge came from — which department
 * raised it. `SupplyKind` describes what was supplied, which is a different
 * question and the one the law asks. They mostly line up; the two that do not
 * are `radiology`, which is imaging rather than a department name, and
 * `surgery`, which is a procedure and can be therapeutic or cosmetic.
 */
const CATEGORY_TO_KIND: Record<string, SupplyKind> = {
  consultation: 'consultation',
  registration: 'registration',
  surgery: 'procedure',
  procedure: 'procedure',
  room: 'room',
  lab: 'lab',
  radiology: 'imaging',
  imaging: 'imaging',
  pharmacy: 'medicine',
  consumable: 'consumable',
  nursing: 'nursing',
  other: 'other',
};

export function supplyKindForCategory(category: string | null | undefined): SupplyKind {
  return CATEGORY_TO_KIND[String(category ?? '').toLowerCase()] ?? 'other';
}

/** Which rule actually decided the answer. Recorded on the line, and reported. */
export type TaxSource =
  | 'not_registered'
  | 'room_rule'
  | 'inpatient_composite'
  | 'cosmetic'
  | 'item_master'
  | 'hsn_master'
  | 'sac_master'
  | 'category_default'
  | 'no_rule';

/**
 * Non-ICU room rent above this per-day figure attracts GST — and on the WHOLE
 * day's rent, not merely the part above the line. At or below it, and in
 * critical care at any rate, room rent is exempt.
 *
 * Both figures are defaults. They are thresholds set by notification, so they
 * move, and the hospital's own configured rate wins where it has one.
 */
export const ROOM_GST_THRESHOLD_PER_DAY = 5000;
export const ROOM_GST_RATE_ABOVE_THRESHOLD = 5;

/** A non-therapeutic procedure is an ordinary service, not healthcare. */
export const COSMETIC_DEFAULT_RATE = 18;

/**
 * Critical care is exempt whatever it costs.
 *
 * CCU is matched as well as the three the ward enum names, because a hospital
 * that records a coronary care unit as a free-text bed type would otherwise be
 * taxed on rent that is plainly exempt. Erring toward exempt here can only ever
 * under-charge the patient, never over-charge them.
 */
export function isCriticalCareAccommodation(
  bedType?: string | null,
  wardType?: string | null,
): boolean {
  const b = String(bedType ?? '').toLowerCase();
  const w = String(wardType ?? '').toLowerCase();
  const critical = (v: string) => v === 'icu' || v === 'nicu' || v === 'picu' || v === 'ccu';
  return critical(b) || critical(w);
}

/**
 * GST on a day of room rent, by the rule that actually applies rather than by
 * whatever the room category averages out to.
 *
 * Reading this off a category default was wrong in a way that costs patients
 * money: a hospital whose tariffs are mostly deluxe AC rooms at 5% would have
 * had that 5% applied to a ₹1,500 general-ward bed billed off the ward's own
 * daily charge — rent that is plainly exempt.
 */
export function roomTaxRate(
  dailyRate: number,
  opts: {
    bedType?: string | null;
    wardType?: string | null;
    configuredRate?: number | null;
    thresholdPerDay?: number;
    rateAboveThreshold?: number;
  } = {},
): number {
  if (isCriticalCareAccommodation(opts.bedType, opts.wardType)) return 0;
  const threshold = opts.thresholdPerDay ?? ROOM_GST_THRESHOLD_PER_DAY;
  if (dailyRate <= threshold) return 0;
  return opts.configuredRate != null && opts.configuredRate > 0
    ? opts.configuredRate
    : (opts.rateAboveThreshold ?? ROOM_GST_RATE_ABOVE_THRESHOLD);
}

/** A resolved row from one of the rate masters. */
export interface MasterMatch {
  code: string;
  ratePercent: number;
  treatment: GstTreatment;
}

export interface SupplyContext {
  kind: SupplyKind;
  /** When the document is dated. Decides whether the cut-over has passed. */
  on: Date;

  // ── the item's own identity and classification ──
  hsnCode?: string | null;
  sacCode?: string | null;
  /** A rate carried by the item itself (formulary, batch, tariff, test). */
  itemRatePercent?: number | null;
  itemTreatment?: GstTreatment | null;
  /**
   * The hospital's auditor has signed this classification off. An approved
   * classification is never overridden by a master or a default.
   */
  itemApproved?: boolean;

  // ── the context of the supply ──
  /** The patient has an active admission — IP, emergency or day care. */
  patientAdmitted?: boolean;
  /** Used ON the patient as part of the treatment, rather than sold to them. */
  issuedForTreatment?: boolean;
  /** Discharge medicine. The patient carries it out, so it looks like a sale. */
  isTakeHome?: boolean;
  /** A non-therapeutic procedure. */
  isCosmetic?: boolean;

  // ── room specifics ──
  dailyRate?: number;
  bedType?: string | null;
  wardType?: string | null;

  /** MRP pricing, where the tax is already inside the price. */
  taxInclusive?: boolean;
}

export interface TaxMasters {
  profile: GstProfile;
  /** Longest-prefix match already done by the caller. */
  hsnMatch?: MasterMatch | null;
  sacMatch?: MasterMatch | null;
  /** The super-admin default for this kind. A fallback, never an override. */
  categoryDefault?: { ratePercent: number; treatment: GstTreatment } | null;
  roomRule?: { thresholdPerDay: number; ratePercent: number } | null;
}

export interface TaxDetermination {
  treatment: GstTreatment;
  ratePercent: number;
  hsnSacCode: string | null;
  taxInclusive: boolean;
  source: TaxSource;
  /** Plain words, printed on the line so the counter can answer a question. */
  reason: string;
  /**
   * A taxable rate that only a fallback produced. The line must not reach a
   * finalised invoice until somebody authorised resolves the classification.
   */
  requiresResolution: boolean;
}

const EXEMPT_HEALTHCARE_REASON =
  'Exempt: healthcare services under Notification 12/2017-Central Tax (Rate)';

/** Kinds that are healthcare services, and therefore exempt unless told otherwise. */
const HEALTHCARE_KINDS: ReadonlySet<SupplyKind> = new Set([
  'consultation',
  'lab',
  'imaging',
  'nursing',
  'procedure',
]);

/**
 * Decide the treatment and rate for one supply.
 *
 * Never throws: a line that cannot be classified comes back exempt and flagged,
 * because refusing to bill is worse than billing without tax and saying so.
 */
export function determineTax(ctx: SupplyContext, masters: TaxMasters): TaxDetermination {
  const taxInclusive = ctx.taxInclusive ?? false;
  const code = ctx.hsnCode ?? ctx.sacCode ?? null;

  const exempt = (source: TaxSource, reason: string, flag = false): TaxDetermination => ({
    treatment: 'exempt',
    ratePercent: 0,
    hsnSacCode: code,
    taxInclusive,
    source,
    reason,
    requiresResolution: flag,
  });

  // 1. The hospital is not charging GST at all — not registered, or the
  //    document falls before the cut-over month it chose.
  if (!gstAppliesOn(masters.profile, ctx.on)) {
    return exempt(
      'not_registered',
      masters.profile.registered
        ? 'No GST: dated before this hospital started filing from this system'
        : 'No GST: this hospital is not registered under GST',
    );
  }

  // 2. Room rent has its own statutory rule, and it is checked before the
  //    inpatient composite rule on purpose — room rent above the threshold is
  //    taxable even for an inpatient. It is the exception the exemption does
  //    not swallow.
  if (ctx.kind === 'room') {
    const rate = roomTaxRate(ctx.dailyRate ?? 0, {
      bedType: ctx.bedType,
      wardType: ctx.wardType,
      configuredRate: ctx.itemRatePercent ?? null,
      thresholdPerDay: masters.roomRule?.thresholdPerDay,
      rateAboveThreshold: masters.roomRule?.ratePercent,
    });
    if (rate <= 0) {
      return exempt(
        'room_rule',
        isCriticalCareAccommodation(ctx.bedType, ctx.wardType)
          ? 'Exempt: critical care accommodation'
          : `Exempt: room rent at or below the ₹${
              masters.roomRule?.thresholdPerDay ?? ROOM_GST_THRESHOLD_PER_DAY
            }/day threshold`,
      );
    }
    return {
      treatment: 'taxable',
      ratePercent: rate,
      hsnSacCode: code,
      taxInclusive,
      source: 'room_rule',
      reason: `Room rent above the ₹${
        masters.roomRule?.thresholdPerDay ?? ROOM_GST_THRESHOLD_PER_DAY
      }/day threshold — taxed on the whole day's rent`,
      requiresResolution: false,
    };
  }

  // 3. The rule that makes a hospital different from a shop. Medicines and
  //    consumables used ON an admitted patient are part of a composite supply
  //    whose principal supply is the treatment, and the treatment is exempt.
  //    A discharge medicine is excluded: the patient carries it out, so it
  //    looks like a counter sale — unless the hospital's auditor says not.
  if (
    COMPOSITE_KINDS.has(ctx.kind) &&
    masters.profile.inpatientCompositeExempt &&
    ctx.patientAdmitted &&
    ctx.issuedForTreatment &&
    !(ctx.isTakeHome && masters.profile.dischargeMedicinesTaxable)
  ) {
    return exempt(
      'inpatient_composite',
      'Exempt: composite supply of inpatient healthcare — the medicine follows the treatment',
    );
  }

  // 4. A procedure done to improve appearance rather than to treat is an
  //    ordinary taxable service, whatever the rest of the surgery list says.
  if (ctx.isCosmetic) {
    const rate =
      ctx.itemRatePercent && ctx.itemRatePercent > 0 ? ctx.itemRatePercent : COSMETIC_DEFAULT_RATE;
    return {
      treatment: 'taxable',
      ratePercent: rate,
      hsnSacCode: code,
      taxInclusive,
      source: 'cosmetic',
      reason: 'Taxable: cosmetic or non-therapeutic procedure, not healthcare',
      requiresResolution: false,
    };
  }

  // 5. What the item itself says. An APPROVED classification is authoritative
  //    and nothing below may override it — that is the whole point of having an
  //    auditor sign one off.
  if (ctx.itemTreatment) {
    const taxable = ctx.itemTreatment === 'taxable';
    return {
      treatment: ctx.itemTreatment,
      ratePercent: taxable ? Math.max(0, ctx.itemRatePercent ?? 0) : 0,
      hsnSacCode: code,
      taxInclusive,
      source: 'item_master',
      reason: ctx.itemApproved
        ? 'Classified on the item, approved by the hospital'
        : 'Classified on the item',
      // Taxable, from an item that nobody has signed off, and with no code
      // behind it — that is a rate somebody typed. It has to be resolved.
      requiresResolution: taxable && !ctx.itemApproved && !code,
    };
  }

  // 6. The masters. Goods resolve through HSN, services through SAC.
  const match = ctx.hsnCode ? masters.hsnMatch : masters.sacMatch;
  const matchSource: TaxSource = ctx.hsnCode ? 'hsn_master' : 'sac_master';
  if (match) {
    const taxable = match.treatment === 'taxable';
    return {
      treatment: match.treatment,
      ratePercent: taxable ? Math.max(0, match.ratePercent) : 0,
      // The ITEM's own code, not the master row that happened to price it. A
      // heading can price a dozen different items and GSTR-1 table 12 groups by
      // what the line reports, so reporting the heading would collapse them all
      // into one row. Which row supplied the rate is recorded in the reason.
      hsnSacCode: code,
      taxInclusive,
      source: matchSource,
      reason: taxable
        ? `${match.ratePercent}% under ${ctx.hsnCode ? 'HSN' : 'SAC'} ${match.code}`
        : `${match.treatment === 'nil_rated' ? 'Nil-rated' : 'Exempt'} under ${
            ctx.hsnCode ? 'HSN' : 'SAC'
          } ${match.code}`,
      requiresResolution: false,
    };
  }

  // 7. The fallback. It fills a blank; it never overrules anything above it.
  //    A TAXABLE answer produced only by a default is a guess, and a guessed
  //    tax rate on a patient's bill is indefensible — so it is flagged and the
  //    finalisation gate stops it.
  if (masters.categoryDefault) {
    const d = masters.categoryDefault;
    const taxable = d.treatment === 'taxable' && d.ratePercent > 0;
    return {
      treatment: d.treatment,
      ratePercent: taxable ? d.ratePercent : 0,
      hsnSacCode: code,
      taxInclusive,
      source: 'category_default',
      reason: taxable
        ? `${d.ratePercent}% from the ${ctx.kind} default — this item has no HSN or SAC code yet`
        : `${
            d.treatment === 'nil_rated' ? 'Nil-rated' : 'Exempt'
          } from the ${ctx.kind} default`,
      requiresResolution: taxable,
    };
  }

  // 8. Nothing decided. Healthcare is exempt by default in India, so that is
  //    the honest answer rather than a guessed rate — but goods with no code
  //    are still flagged, because a medicine with no HSN is an unfinished
  //    setup rather than an exempt supply.
  if (HEALTHCARE_KINDS.has(ctx.kind)) {
    return exempt('no_rule', EXEMPT_HEALTHCARE_REASON);
  }
  return exempt(
    'no_rule',
    `No HSN or SAC code on this ${ctx.kind}, and no default is configured for it`,
    true,
  );
}
