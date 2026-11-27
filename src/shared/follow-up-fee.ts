// ---------------------------------------------------------------------------
// Follow-up fee rules (gap items #331 and #019) — the pure part.
//
// The hospital admin decides how long a return visit is free and what it costs
// afterwards; nothing here is a hospital's number. This file knows how three
// layers of settings combine (doctor over department over hospital), how a
// visit is priced under the result, and how that is worded. It reads nothing
// and writes nothing: `follow-up-rules.service.ts` supplies the facts.
//
// Day counting is by calendar day in IST. The qualifying visit is day 0, so a
// 7-day rule covers the visit date plus 7 days: day 7 is free, day 8 is not.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { istDayNumber } from './date.utils';

export type AfterWindowMode = 'full' | 'fixed';
export type FollowUpScope = 'same_doctor' | 'same_department';
export type RuleLevel = 'hospital' | 'department' | 'doctor';
export type RuleSource = RuleLevel | 'built_in';

export const MAX_FREE_FOLLOW_UP_DAYS = 90;
export const MAX_FOLLOW_UP_FEE = 1_000_000;

/** One level's settings. Null means "use the level above". */
export interface FollowUpRuleLayer {
  freeDays: number | null;
  afterWindow: AfterWindowMode | null;
  /** Only with `afterWindow: 'fixed'`. */
  fixedFee: number | null;
  scope: FollowUpScope | null;
  dischargeStartsWindow: boolean | null;
}

/** The complete rule that applies to one doctor. */
export interface FollowUpRule {
  /**
   * False when the admin has set nothing at any level for this doctor. Pricing
   * then follows the behaviour from before the rules existed.
   */
  configured: boolean;
  freeDays: number;
  afterWindow: AfterWindowMode;
  fixedFee: number | null;
  scope: FollowUpScope;
  dischargeStartsWindow: boolean;
  sources: {
    freeDays: RuleSource;
    afterWindow: RuleSource;
    scope: RuleSource;
    dischargeStartsWindow: RuleSource;
  };
}

// ── Input ──────────────────────────────────────────────────────────────────

const freeDaysInput = z
  .number({ message: 'Enter the free follow-up days as a whole number' })
  .int('Free follow-up days must be a whole number')
  .min(0, 'Free follow-up days cannot be negative')
  .max(MAX_FREE_FOLLOW_UP_DAYS, `Free follow-up days cannot be more than ${MAX_FREE_FOLLOW_UP_DAYS}`);

const fixedFeeInput = z
  .number({ message: 'Enter the follow-up fee as an amount' })
  .min(0, 'The follow-up fee cannot be negative')
  .max(MAX_FOLLOW_UP_FEE, 'The follow-up fee is too large')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most two decimal places');

const afterWindowInput = z.enum(['full', 'fixed']);
const scopeInput = z.enum(['same_doctor', 'same_department']);

const feeMatchesMode = (v: { afterWindow: AfterWindowMode | null; fixedFee: number | null }) =>
  v.afterWindow !== 'fixed' || v.fixedFee !== null;

/** The hospital default is complete: there is nothing above it to inherit. */
export const hospitalRuleSchema = z
  .object({
    freeDays: freeDaysInput,
    afterWindow: afterWindowInput,
    fixedFee: fixedFeeInput.nullable().default(null),
    scope: scopeInput,
    dischargeStartsWindow: z.boolean(),
  })
  .refine(feeMatchesMode, { message: 'Enter the follow-up fee', path: ['fixedFee'] });

/** A department or doctor override: null in a field means "use the level above". */
export const overrideRuleSchema = z
  .object({
    freeDays: freeDaysInput.nullable(),
    afterWindow: afterWindowInput.nullable(),
    fixedFee: fixedFeeInput.nullable().default(null),
    scope: scopeInput.nullable(),
    dischargeStartsWindow: z.boolean().nullable(),
  })
  .refine(feeMatchesMode, { message: 'Enter the follow-up fee', path: ['fixedFee'] });

/** The fee belongs to the fixed mode only, so a stale amount cannot linger. */
export function normaliseLayer(layer: FollowUpRuleLayer): FollowUpRuleLayer {
  return { ...layer, fixedFee: layer.afterWindow === 'fixed' ? layer.fixedFee : null };
}

export const isEmptyLayer = (l: FollowUpRuleLayer): boolean =>
  l.freeDays === null && l.afterWindow === null && l.scope === null && l.dischargeStartsWindow === null;

// ── Combining the levels ───────────────────────────────────────────────────

const LEVEL_ORDER: RuleLevel[] = ['doctor', 'department', 'hospital'];

/**
 * Doctor beats department beats hospital, field by field. A fixed fee travels
 * with the mode that asked for it, never on its own.
 *
 * The last resort, when a doctor has an override but the hospital has no
 * default: no free days, full fee, same doctor, discharge does not count.
 */
export function combineRuleLayers(
  layers: Array<{ level: RuleLevel; layer: FollowUpRuleLayer }>,
  configured: boolean,
): FollowUpRule {
  const sorted = [...layers].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  const pick = (key: keyof FollowUpRuleLayer) =>
    sorted.find((l) => l.layer[key] !== null && l.layer[key] !== undefined);

  const days = pick('freeDays');
  const mode = pick('afterWindow');
  const scope = pick('scope');
  const discharge = pick('dischargeStartsWindow');

  return {
    configured,
    freeDays: days?.layer.freeDays ?? 0,
    afterWindow: mode?.layer.afterWindow ?? 'full',
    fixedFee: mode?.layer.afterWindow === 'fixed' ? (mode.layer.fixedFee ?? 0) : null,
    scope: scope?.layer.scope ?? 'same_doctor',
    dischargeStartsWindow: discharge?.layer.dischargeStartsWindow ?? false,
    sources: {
      freeDays: days?.level ?? 'built_in',
      afterWindow: mode?.level ?? 'built_in',
      scope: scope?.level ?? 'built_in',
      dischargeStartsWindow: discharge?.level ?? 'built_in',
    },
  };
}

// ── Wording ────────────────────────────────────────────────────────────────

/** ₹300, ₹300.50 or ₹1,200 — paise only when there are any. */
export function rupees(n: number): string {
  const fraction = Number.isInteger(n) ? 0 : 2;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: fraction, maximumFractionDigits: fraction })}`;
}

const countDays = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** "Free for 7 days, then ₹300". */
export function describeRule(rule: Pick<FollowUpRule, 'freeDays' | 'afterWindow' | 'fixedFee'>): string {
  const after = rule.afterWindow === 'fixed' ? rupees(rule.fixedFee ?? 0) : 'full consultation fee';
  return rule.freeDays > 0
    ? `Free for ${countDays(rule.freeDays)}, then ${after}`
    : `No free days, follow-ups cost ${rule.afterWindow === 'fixed' ? after : `the ${after}`}`;
}

// ── Pricing ────────────────────────────────────────────────────────────────

export interface FollowUpAnchor {
  /** The paid consultation's date, or the date of discharge. */
  date: Date;
  kind: 'consultation' | 'discharge';
}

export type FeeKind =
  /** Not a return visit at all, or nothing earlier that counts. */
  | 'consultation'
  /** Inside the free period. */
  | 'free_follow_up'
  /** A follow-up after the free period. */
  | 'paid_follow_up'
  /** No rule is set: priced as it was before the rules existed. */
  | 'legacy';

export interface FeeResolution {
  fee: number;
  listFee: number;
  isFreeFollowUp: boolean;
  kind: FeeKind;
  /** Was this priced under a rule the admin set? */
  governed: boolean;
  /** The visit or discharge the days are counted from. */
  basedOn: Date | null;
  anchorKind: FollowUpAnchor['kind'] | null;
  dayNumber: number | null;
  windowDays: number;
  /** One line for the desk, the patient and the bill. Null under no rule. */
  label: string | null;
  /** "Free for 7 days, then ₹300". Null under no rule. */
  ruleSummary: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Price one visit under a configured rule. */
export function priceUnderRule(
  rule: FollowUpRule,
  visit: {
    listFee: number;
    /** The desk booked it as a follow-up. */
    declaredFollowUp: boolean;
    /** The day of the visit being priced. */
    date: Date | string;
    anchor: FollowUpAnchor | null;
  },
): FeeResolution {
  const listFee = Math.max(0, round2(visit.listFee));
  const base = {
    listFee,
    governed: true,
    windowDays: rule.freeDays,
    ruleSummary: describeRule(rule),
  };

  if (!visit.anchor) {
    const where = rule.scope === 'same_department' ? 'in this department' : 'with this doctor';
    return {
      ...base,
      fee: listFee,
      isFreeFollowUp: false,
      kind: 'consultation',
      basedOn: null,
      anchorKind: null,
      dayNumber: null,
      label: visit.declaredFollowUp
        ? `Full consultation fee (no earlier paid visit ${where} to follow up)`
        : null,
    };
  }

  const dayNumber = istDayNumber(visit.date) - istDayNumber(visit.anchor.date);
  const afterDischarge = visit.anchor.kind === 'discharge' ? ' after discharge' : '';
  const withAnchor = {
    ...base,
    basedOn: visit.anchor.date,
    anchorKind: visit.anchor.kind,
    dayNumber,
  };

  // There is something to waive when the visit has a price: the doctor's fee,
  // or the follow-up fee this visit was declared under.
  const inWindow = rule.freeDays > 0 && dayNumber >= 0 && dayNumber <= rule.freeDays;
  if (inWindow && (listFee > 0 || visit.declaredFollowUp)) {
    return {
      ...withAnchor,
      fee: 0,
      isFreeFollowUp: true,
      kind: 'free_follow_up',
      label:
        dayNumber === 0
          ? `Free follow-up, same day${afterDischarge} (free for ${countDays(rule.freeDays)})`
          : `Free follow-up, day ${dayNumber} of ${rule.freeDays}${afterDischarge}`,
    };
  }

  const ended =
    rule.freeDays > 0
      ? `day ${dayNumber}, free follow-up ended on day ${rule.freeDays}`
      : 'no free follow-up days';

  if (visit.declaredFollowUp) {
    const fixed = rule.afterWindow === 'fixed';
    const fee = fixed ? Math.max(0, round2(rule.fixedFee ?? 0)) : listFee;
    return {
      ...withAnchor,
      fee,
      isFreeFollowUp: false,
      kind: 'paid_follow_up',
      label: fixed ? `Follow-up fee ${rupees(fee)} (${ended})` : `Full consultation fee (${ended})`,
    };
  }

  return {
    ...withAnchor,
    fee: listFee,
    isFreeFollowUp: false,
    kind: 'consultation',
    label: rule.freeDays > 0 && listFee > 0 ? `Full consultation fee (${ended})` : null,
  };
}

/** The text of the consultation line on the bill. */
export function consultationLineDescription(resolution: FeeResolution, fallback: string): string {
  if (resolution.isFreeFollowUp && resolution.fee === 0) {
    const waived = 'Consultation Fee — Waived (Follow-up)';
    return resolution.label ? `${waived} — ${resolution.label}` : waived;
  }
  if (resolution.kind === 'paid_follow_up' && resolution.label) {
    return `Follow-up visit — ${resolution.label}`;
  }
  return fallback;
}
