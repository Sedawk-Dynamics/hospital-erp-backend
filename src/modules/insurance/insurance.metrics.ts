import type { Prisma } from '@prisma/client';
import { istDayNumber, istDayStart, istDayEnd, istDateStr, formatDateIST } from '../../shared/date.utils';

// ============================================================
// One written definition per headline insurance figure.
//
// Gap 290: the dashboard and the reports each counted these their own way
// (96.05% vs 45.06% approval; an outstanding that matched no formula). Every
// screen now gets them from the helpers below, and the wording the UI shows
// in its tooltip is served from here so it can never describe a different sum.
// ============================================================

type Money = Prisma.Decimal | number | string | null | undefined;

function num(value: Money): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Payer said yes, in full or in part — including claims already paid. */
export const CLAIM_APPROVED_STATUSES = ['approved', 'partially_approved', 'settled', 'partially_settled'] as const;
/** Payer has decided: the approved family plus rejections. */
export const CLAIM_DECIDED_STATUSES = [...CLAIM_APPROVED_STATUSES, 'rejected'] as const;
/** Still with the payer for a decision. */
export const CLAIM_AWAITING_DECISION_STATUSES = ['submitted', 'under_review', 'query_raised', 'response_submitted'] as const;
/** Approved and not fully paid: the only claims that can carry an outstanding. */
export const CLAIM_RECEIVABLE_STATUSES = ['approved', 'partially_approved', 'partially_settled'] as const;
/**
 * No longer a live claim (gap 291). A cancelled claim is withdrawn; a
 * `resubmitted` claim is the frozen original whose replacement carries the
 * money. Neither may count in any total, or the same rupee is counted twice.
 */
export const CLAIM_VOID_STATUSES = ['cancelled', 'resubmitted'] as const;
/** Claims whose TPA filing deadline (expiryDate) still matters (gap 296). */
export const CLAIM_DEADLINE_OPEN_STATUSES = [...CLAIM_AWAITING_DECISION_STATUSES, 'partially_approved'] as const;

export const INSURANCE_METRIC_DEFINITIONS = {
  approvalRate:
    'Approval rate (by count) = number of claims approved in full or in part (including settled and part-settled) ÷ number of claims the payer has decided (those plus rejected). Claims still awaiting a decision, cancelled claims and claims replaced by a resubmission are not counted.',
  // Gap 290: the money view of the same decisions, shown beside the count.
  amountApprovalRate:
    'Approval rate (by amount) = approved amount ÷ claimed amount, both summed over the claims the payer has decided (approved in full or in part, settled, part-settled and rejected; a rejected claim adds its claimed amount and nothing approved). Claims awaiting a decision, cancelled claims and claims replaced by a resubmission are not counted.',
  outstanding:
    'Outstanding = approved amount − amount received − approved write-offs, summed over approved and part-settled claims (never below zero per claim). Claims awaiting a decision, rejected, settled, cancelled or replaced by a resubmission owe nothing.',
  awaitingDecision:
    'Awaiting decision = claimed amount of claims still with the payer (submitted, under review, query raised or response sent).',
  totals:
    'Claimed, approved and paid totals leave out cancelled claims and claims replaced by a resubmission.',
  claimExpiry:
    'A claim is expired once its TPA deadline date (IST) has passed while it is still awaiting a decision or partially approved; "expiring in 7 days" counts deadlines from today to 7 days ahead.',
} as const;

const has = (list: readonly string[], status: string) => list.includes(status);

export function isVoidClaim(status: string): boolean {
  return has(CLAIM_VOID_STATUSES, status);
}

export interface ClaimMoneyFields {
  status: string;
  claimAmount: Money;
  approvedAmount?: Money;
  paidAmount?: Money;
  writtenOffAmount?: Money;
}

/**
 * What the payer still owes on one claim. Computed from the amounts rather than
 * read from the stored `outstandingAmount`, because rows written before gap 291
 * (e.g. a claim cancelled after approval) still hold a stale figure there.
 */
export function claimOutstanding(c: ClaimMoneyFields): number {
  if (!has(CLAIM_RECEIVABLE_STATUSES, c.status)) return 0;
  const approved = num(c.approvedAmount ?? c.claimAmount);
  return round2(Math.max(0, approved - num(c.paidAmount) - num(c.writtenOffAmount)));
}

/** Claimed amount still waiting on the payer's decision. */
export function claimAwaitingDecision(c: ClaimMoneyFields): number {
  return has(CLAIM_AWAITING_DECISION_STATUSES, c.status) ? round2(num(c.claimAmount)) : 0;
}

export interface ApprovalRate {
  decided: number;
  approved: number;
  rejected: number;
  awaitingDecision: number;
  /** null when nothing has been decided yet — "no data", not 0%. */
  approvalRate: number | null;
}

export function computeApprovalRate(statuses: Iterable<string>): ApprovalRate {
  let approved = 0;
  let rejected = 0;
  let awaitingDecision = 0;
  for (const s of statuses) {
    if (has(CLAIM_APPROVED_STATUSES, s)) approved += 1;
    else if (s === 'rejected') rejected += 1;
    else if (has(CLAIM_AWAITING_DECISION_STATUSES, s)) awaitingDecision += 1;
  }
  const decided = approved + rejected;
  return {
    decided,
    approved,
    rejected,
    awaitingDecision,
    approvalRate: decided > 0 ? round2((approved / decided) * 100) : null,
  };
}

export interface AmountApprovalRate {
  /** Numerator: approved amount of decided claims (rejected add 0). */
  decidedApprovedAmount: number;
  /** Denominator: claimed amount of decided claims. */
  decidedClaimedAmount: number;
  /** null when nothing has been decided (or nothing claimed) — "no data", not 0%. */
  amountApprovalRate: number | null;
}

/**
 * Gap 290: approval by amount — approved ÷ claimed over DECIDED claims only,
 * the same claim set the count-based rate uses. A part-approval of ₹600 on a
 * ₹1,000 claim is 1 of 1 by count but 60% by amount.
 */
export function computeAmountApprovalRate(claims: Iterable<ClaimMoneyFields>): AmountApprovalRate {
  let approved = 0;
  let claimed = 0;
  for (const c of claims) {
    if (has(CLAIM_APPROVED_STATUSES, c.status)) {
      claimed += num(c.claimAmount);
      approved += num(c.approvedAmount ?? c.claimAmount);
    } else if (c.status === 'rejected') {
      claimed += num(c.claimAmount);
    }
  }
  const decidedClaimedAmount = round2(claimed);
  const decidedApprovedAmount = round2(approved);
  return {
    decidedApprovedAmount,
    decidedClaimedAmount,
    amountApprovalRate: decidedClaimedAmount > 0 ? round2((decidedApprovedAmount / decidedClaimedAmount) * 100) : null,
  };
}

export interface ClaimMoneyTotals {
  count: number;
  claimed: number;
  approved: number;
  paid: number;
  writtenOff: number;
  outstanding: number;
  awaitingDecision: number;
}

/** The money totals every screen shows, over live (non-void) claims only. */
export function computeClaimTotals(claims: Iterable<ClaimMoneyFields>): ClaimMoneyTotals {
  const t: ClaimMoneyTotals = { count: 0, claimed: 0, approved: 0, paid: 0, writtenOff: 0, outstanding: 0, awaitingDecision: 0 };
  for (const c of claims) {
    if (isVoidClaim(c.status)) continue;
    t.count += 1;
    t.claimed += num(c.claimAmount);
    if (has(CLAIM_APPROVED_STATUSES, c.status)) t.approved += num(c.approvedAmount ?? c.claimAmount);
    t.paid += num(c.paidAmount);
    t.writtenOff += num(c.writtenOffAmount);
    t.outstanding += claimOutstanding(c);
    t.awaitingDecision += claimAwaitingDecision(c);
  }
  return {
    count: t.count,
    claimed: round2(t.claimed),
    approved: round2(t.approved),
    paid: round2(t.paid),
    writtenOff: round2(t.writtenOff),
    outstanding: round2(t.outstanding),
    awaitingDecision: round2(t.awaitingDecision),
  };
}

// ------------------------------------------------------------
// Payer resolution (gap 292)
// ------------------------------------------------------------

type NamedRef = { id: string; name: string } | null | undefined;

export interface ClaimPayerSource {
  insuranceCase?: {
    insurer?: NamedRef;
    corporatePayer?: NamedRef;
    governmentSchemePayer?: NamedRef;
  } | null;
  policy?: { insurer?: NamedRef } | null;
}

export const PAYER_MISSING = { id: null, name: 'Payer missing' } as const;

/**
 * The payer on a claim: the payer case first (it names who actually pays —
 * insurer, corporate or government scheme), then the policy's insurer.
 * Returns null when neither names one, so reports can group those claims
 * under "Payer missing" instead of rendering "—".
 */
export function resolveClaimPayer(c: ClaimPayerSource): { id: string; name: string } | null {
  const pc = c.insuranceCase;
  const fromCase = pc?.insurer ?? pc?.corporatePayer ?? pc?.governmentSchemePayer;
  if (fromCase?.id) return { id: fromCase.id, name: fromCase.name };
  const fromPolicy = c.policy?.insurer;
  if (fromPolicy?.id) return { id: fromPolicy.id, name: fromPolicy.name };
  return null;
}

/** Prisma select fragment that loads everything resolveClaimPayer reads. */
export const CLAIM_PAYER_SELECT = {
  insuranceCase: {
    select: {
      insurer: { select: { id: true, name: true } },
      corporatePayer: { select: { id: true, name: true } },
      governmentSchemePayer: { select: { id: true, name: true } },
    },
  },
  policy: { select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } } },
} as const;

export interface PayerGroup {
  payerId: string | null;
  payerName: string;
  count: number;
  amount: number;
}

/** Group rows by payer; rows with no payer land in one "Payer missing" group so totals still add up. */
export function groupByPayer<T extends ClaimPayerSource>(rows: T[], amountOf: (row: T) => number): PayerGroup[] {
  const groups = new Map<string, PayerGroup>();
  for (const row of rows) {
    const payer = resolveClaimPayer(row);
    const key = payer?.id ?? '__missing__';
    const g = groups.get(key) ?? {
      payerId: payer?.id ?? null,
      payerName: payer?.name ?? PAYER_MISSING.name,
      count: 0,
      amount: 0,
    };
    g.count += 1;
    g.amount = round2(g.amount + amountOf(row));
    groups.set(key, g);
  }
  // Named payers by amount, "Payer missing" always last.
  return Array.from(groups.values()).sort((a, b) => {
    if (!a.payerId) return 1;
    if (!b.payerId) return -1;
    return b.amount - a.amount;
  });
}

// ------------------------------------------------------------
// Claim deadline (gap 296) — one rule for the dashboard and the alerts
// ------------------------------------------------------------

export type ClaimDeadlineState =
  | { state: 'expired'; daysOverdue: number }
  | { state: 'due_today' }
  | { state: 'expiring'; daysLeft: number };

/** Days are IST calendar days, so "due 09/11" is expired from 10/11 00:00 IST. */
export function claimDeadlineState(expiryDate: Date | string, now: Date = new Date()): ClaimDeadlineState {
  const diff = istDayNumber(expiryDate) - istDayNumber(now);
  if (diff < 0) return { state: 'expired', daysOverdue: -diff };
  if (diff === 0) return { state: 'due_today' };
  return { state: 'expiring', daysLeft: diff };
}

/** IST-day window the dashboard counts for "expiring within N days" (today .. today+N). */
export function claimExpiringWindow(withinDays: number, now: Date = new Date()): { gte: Date; lte: Date } {
  const today = istDateStr(now);
  const ahead = istDateStr(new Date(istDayStart(today).getTime() + withinDays * 86_400_000 + 3_600_000));
  return { gte: istDayStart(today), lte: istDayEnd(ahead) };
}

/** First instant that is no longer expired: today 00:00 IST. Expired = expiryDate < this. */
export function claimExpiredBefore(now: Date = new Date()): Date {
  return istDayStart(istDateStr(now));
}

/**
 * Gap 296: which claims the dashboard's "expired" / "expiring in N days"
 * counts cover. The claims list filters with the same clause (`?expiry=`), so
 * the number on the dashboard is the number of rows its link opens.
 */
export function claimDeadlineWhere(
  kind: 'expired' | 'expiring',
  withinDays = 7,
  now: Date = new Date(),
): Prisma.InsuranceClaimWhereInput {
  return {
    status: { in: [...CLAIM_DEADLINE_OPEN_STATUSES] },
    expiryDate:
      kind === 'expired'
        ? { not: null, lt: claimExpiredBefore(now) }
        : { not: null, ...claimExpiringWindow(withinDays, now) },
  };
}

/**
 * Title + message for a claim-deadline alert, built from the due date at the
 * moment it is shown — a stored "expiring in 1 day" goes stale the next day.
 */
export function describeClaimDeadline(
  claim: { claimNumber?: string | null; id: string; expiryDate: Date | string },
  patientName: string,
  now: Date = new Date(),
): { title: string; message: string; state: ClaimDeadlineState['state'] } {
  const ref = claim.claimNumber ?? claim.id;
  const due = formatDateIST(claim.expiryDate);
  const s = claimDeadlineState(claim.expiryDate, now);
  if (s.state === 'expired') {
    return {
      state: s.state,
      title: 'Insurance claim expired',
      message: `Claim ${ref} for ${patientName} passed its TPA deadline on ${due} (${s.daysOverdue} day${s.daysOverdue > 1 ? 's' : ''} ago). Follow up with the TPA or close the claim.`,
    };
  }
  if (s.state === 'due_today') {
    return {
      state: s.state,
      title: 'Insurance claim due today',
      message: `Claim ${ref} for ${patientName} is due by ${due} (today). Follow up with the TPA.`,
    };
  }
  return {
    state: s.state,
    title: `Insurance claim expiring in ${s.daysLeft} day${s.daysLeft > 1 ? 's' : ''}`,
    message: `Claim ${ref} for ${patientName} is due by ${due}. Follow up with the TPA.`,
  };
}
