// ---------------------------------------------------------------------------
// The resolver — what a bill writer actually calls.
//
// `determineTax` is pure and knows the rules; this is the piece that fetches
// what the rules need and hands back both the classification and the money for
// one line. Ten different places in this codebase create BillItem rows, each
// with its own copy of the tax arithmetic, and this exists so that after the
// wiring work there is exactly one.
//
// Batch by default. A forty-line bill must load the masters ONCE, not forty
// times, so the normal shape is `const resolve = await taxResolverFor(tenant,
// date)` followed by forty synchronous calls. The single-shot `resolveTaxFor`
// is a convenience for the paths that genuinely post one line.
//
// The masters are platform reference data — thirty-odd rows that change when a
// super admin edits them and never otherwise — so they are cached in process
// for a short while. The hospital's profile is read once per resolver, not
// cached, because it is one indexed lookup and staleness there would mean
// billing under a registration the hospital has just changed.
// ---------------------------------------------------------------------------

import { logger } from '../../config/logger';
import { computeLineTax, isInterState, type LineTax } from '../../shared/gst';
import { DEFAULT_GST_PROFILE, type GstProfile } from '../../shared/gst-profile';
import {
  determineTax,
  type SupplyContext,
  type TaxDetermination,
  type TaxMasters,
} from '../../shared/gst-determination';
import { getGstProfile } from '../hospital-settings/hospital-settings.service';
import { getHsnRows, getSacRows, matchLongestPrefix } from './gst-master.service';

// ── Master cache ───────────────────────────────────────────────────────────

interface MasterRow {
  code: string;
  gstRate: unknown;
  treatment: string | null;
  description: string | null;
}

interface CachedMasters {
  hsn: MasterRow[];
  sac: MasterRow[];
  loadedAt: number;
}

/**
 * Short enough that a super admin's edit shows up while they are still looking
 * at the screen, long enough that a busy counter is not re-reading two tiny
 * reference tables on every line.
 */
const MASTER_TTL_MS = 60_000;
let masterCache: CachedMasters | null = null;

/** Called after any master edit, and by tests. */
export function clearGstMasterCache(): void {
  masterCache = null;
}

async function loadMasters(now: number): Promise<CachedMasters> {
  if (masterCache && now - masterCache.loadedAt < MASTER_TTL_MS) return masterCache;
  const [hsn, sac] = await Promise.all([getHsnRows(), getSacRows()]);
  masterCache = { hsn, sac, loadedAt: now };
  return masterCache;
}

// ── The resolver ───────────────────────────────────────────────────────────

/**
 * Everything except the tenant and the date, which the resolver already holds.
 *
 * `placeOfSupplyStateCode` is carried here rather than in `SupplyContext`
 * because it decides the SPLIT — CGST+SGST against IGST — and not the treatment
 * or the rate. Where a supply is taxed is a different question from whether it
 * is taxed at all, and the rules engine only answers the second.
 */
export type LineContext = Omit<SupplyContext, 'on'> & {
  on?: Date;
  /** Defaults to the hospital's own state, which is where a patient is served. */
  placeOfSupplyStateCode?: string | null;
};

export interface PricedLine {
  determination: TaxDetermination;
  money: LineTax;
}

export interface TaxResolver {
  profile: GstProfile;
  /** Classify one line. */
  determine(ctx: LineContext): TaxDetermination;
  /** Classify one line and compute its money in the same step. */
  price(
    ctx: LineContext,
    money: { unitPrice: number; quantity: number; discountAmount?: number },
  ): PricedLine;
}

/**
 * Build a resolver bound to one hospital and one document date.
 *
 * The date is the DOCUMENT's date, not now: a bill being corrected next month
 * must resolve under the rules that applied when it was raised, and the cut-over
 * check depends on it.
 */
export async function taxResolverFor(tenantId: string, on: Date = new Date()): Promise<TaxResolver> {
  const now = Date.now();
  let profile: GstProfile;
  try {
    profile = await getGstProfile(tenantId);
  } catch (err) {
    // Billing must never fail because a settings read did. Unregistered is the
    // safe fallback: no tax charged, bill of supply issued.
    logger.warn({ err, tenantId }, 'GST profile unreadable — treating the hospital as unregistered');
    profile = DEFAULT_GST_PROFILE;
  }

  let masters: CachedMasters;
  try {
    masters = await loadMasters(now);
  } catch (err) {
    // Same reasoning. With no masters every line falls through to the rules
    // that do not need them, which for healthcare means exempt.
    logger.warn({ err, tenantId }, 'GST masters unreadable — resolving without them');
    masters = { hsn: [], sac: [], loadedAt: now };
  }

  const determine = (ctx: LineContext): TaxDetermination => {
    const full: SupplyContext = { ...ctx, on: ctx.on ?? on };
    const bundle: TaxMasters = {
      profile,
      hsnMatch: full.hsnCode ? matchLongestPrefix(full.hsnCode, masters.hsn) : null,
      sacMatch: full.sacCode ? matchLongestPrefix(full.sacCode, masters.sac) : null,
      categoryDefault: null,
      roomRule: null,
    };
    return determineTax(full, bundle);
  };

  return {
    profile,
    determine,
    price: (ctx, money) => {
      const determination = determine(ctx);
      return {
        determination,
        money: computeLineTax({
          unitPrice: money.unitPrice,
          quantity: money.quantity,
          discountAmount: money.discountAmount,
          ratePercent: determination.ratePercent,
          treatment: determination.treatment,
          taxInclusive: determination.taxInclusive,
          interState: isInterState(profile.stateCode, ctx.placeOfSupplyStateCode ?? profile.stateCode),
        }),
      };
    },
  };
}

/** One line, one call. Prefer {@link taxResolverFor} inside a loop. */
export async function resolveTaxFor(
  tenantId: string,
  ctx: LineContext,
  on: Date = new Date(),
): Promise<TaxDetermination> {
  const resolver = await taxResolverFor(tenantId, on);
  return resolver.determine(ctx);
}
