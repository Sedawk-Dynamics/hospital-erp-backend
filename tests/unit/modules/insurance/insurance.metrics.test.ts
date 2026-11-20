import { describe, it, expect } from 'vitest';
import {
  claimDeadlineState,
  claimExpiredBefore,
  claimExpiringWindow,
  claimOutstanding,
  computeApprovalRate,
  computeClaimTotals,
  describeClaimDeadline,
  groupByPayer,
  resolveClaimPayer,
} from '../../../../src/modules/insurance/insurance.metrics';

describe('approval rate — one definition (gap 290)', () => {
  it('divides approved-family claims by decided claims only', () => {
    // 3 approved-family + 1 rejected decided; pending/cancelled/superseded ignored.
    const r = computeApprovalRate([
      'approved', 'partially_approved', 'settled', 'rejected',
      'submitted', 'under_review', 'query_raised', 'cancelled', 'resubmitted',
    ]);
    expect(r).toMatchObject({ decided: 4, approved: 3, rejected: 1, awaitingDecision: 3, approvalRate: 75 });
  });

  it('is null, not 0%, when nothing is decided yet', () => {
    expect(computeApprovalRate(['submitted', 'cancelled']).approvalRate).toBeNull();
  });
});

describe('outstanding — one definition (gap 290/291)', () => {
  it('is approved − paid − written off on approved and part-settled claims', () => {
    expect(claimOutstanding({ status: 'approved', claimAmount: 1000, approvedAmount: 800, paidAmount: 0 })).toBe(800);
    expect(claimOutstanding({ status: 'partially_settled', claimAmount: 1000, approvedAmount: 800, paidAmount: 500, writtenOffAmount: 100 })).toBe(200);
  });

  it('is zero for cancelled, superseded, rejected, settled and undecided claims whatever the stored column says', () => {
    for (const status of ['cancelled', 'resubmitted', 'rejected', 'settled', 'submitted']) {
      expect(claimOutstanding({ status, claimAmount: 200001, approvedAmount: 200001, paidAmount: 0 })).toBe(0);
    }
  });

  it('never goes below zero', () => {
    expect(claimOutstanding({ status: 'approved', claimAmount: 100, approvedAmount: 100, paidAmount: 150 })).toBe(0);
  });

  it('totals leave out void claims so approved − paid − written off = outstanding', () => {
    const t = computeClaimTotals([
      { status: 'approved', claimAmount: 1000, approvedAmount: 900, paidAmount: 400, writtenOffAmount: 0 },
      { status: 'settled', claimAmount: 500, approvedAmount: 500, paidAmount: 500 },
      { status: 'submitted', claimAmount: 300 },
      // A cancelled claim that still stores ₹2,00,001 — must not appear anywhere.
      { status: 'cancelled', claimAmount: 200001, approvedAmount: 200001, paidAmount: 0 },
      { status: 'resubmitted', claimAmount: 700, approvedAmount: 600 },
    ]);
    expect(t).toEqual({
      count: 3,
      claimed: 1800,
      approved: 1400,
      paid: 900,
      writtenOff: 0,
      outstanding: 500,
      awaitingDecision: 300,
    });
    expect(t.approved - t.paid - t.writtenOff).toBe(t.outstanding);
  });
});

describe('payer resolution (gap 292)', () => {
  const insurer = { id: 'ins-1', name: 'Star Health' };
  it('reads the payer case first, then the policy', () => {
    expect(resolveClaimPayer({ insuranceCase: { insurer: { id: 'ins-case', name: 'Case Payer' } }, policy: { insurer } })).toEqual({ id: 'ins-case', name: 'Case Payer' });
    expect(resolveClaimPayer({ insuranceCase: { corporatePayer: { id: 'corp-1', name: 'Acme Corp' } } })).toEqual({ id: 'corp-1', name: 'Acme Corp' });
    expect(resolveClaimPayer({ insuranceCase: null, policy: { insurer } })).toEqual(insurer);
    expect(resolveClaimPayer({ insuranceCase: null, policy: null })).toBeNull();
  });

  it('groups claims without a payer under "Payer missing" so totals add up', () => {
    const rows = [
      { policy: { insurer }, amount: 100 },
      { policy: { insurer }, amount: 50 },
      { policy: null, insuranceCase: null, amount: 25 },
    ];
    const groups = groupByPayer(rows, (r) => r.amount);
    expect(groups).toEqual([
      { payerId: 'ins-1', payerName: 'Star Health', count: 2, amount: 150 },
      { payerId: null, payerName: 'Payer missing', count: 1, amount: 25 },
    ]);
    expect(groups.reduce((s, g) => s + g.amount, 0)).toBe(175);
  });
});

describe('claim deadline — one rule for dashboard and alerts (gap 296)', () => {
  // 19/11/2026 10:00 IST
  const now = new Date('2026-11-19T04:30:00.000Z');

  it('treats a claim due 09/11 as expired, not "expiring in 1 day"', () => {
    const due = new Date('2026-11-09T00:00:00.000Z');
    expect(claimDeadlineState(due, now)).toEqual({ state: 'expired', daysOverdue: 10 });
    const d = describeClaimDeadline({ id: 'c1', claimNumber: 'CLM-1', expiryDate: due }, 'Asha Rao', now);
    expect(d.title).toBe('Insurance claim expired');
    expect(d.message).toContain('09/11/2026');
    expect(d.message).not.toMatch(/expiring/i);
  });

  it('uses IST calendar days: 23:00 IST tomorrow is 1 day left, 00:30 IST today is due today', () => {
    expect(claimDeadlineState(new Date('2026-11-20T17:30:00.000Z'), now)).toEqual({ state: 'expiring', daysLeft: 1 });
    expect(claimDeadlineState(new Date('2026-11-18T19:00:00.000Z'), now)).toEqual({ state: 'due_today' });
  });

  it('the dashboard windows agree with the state function', () => {
    const win = claimExpiringWindow(7, now);
    expect(win.gte.toISOString()).toBe('2026-11-18T18:30:00.000Z');
    expect(win.lte.toISOString()).toBe('2026-11-26T18:29:59.999Z');
    expect(claimExpiredBefore(now).toISOString()).toBe('2026-11-18T18:30:00.000Z');
    // Last instant inside the window is 7 days left; the expired bound is day 0.
    expect(claimDeadlineState(win.lte, now)).toEqual({ state: 'expiring', daysLeft: 7 });
    expect(claimDeadlineState(new Date(claimExpiredBefore(now).getTime() - 1), now).state).toBe('expired');
  });
});
