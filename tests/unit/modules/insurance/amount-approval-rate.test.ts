// Gap 290: approval by AMOUNT beside approval by count, and the dashboard
// taking the same date / insurer filters as Reports.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { computeAmountApprovalRate, INSURANCE_METRIC_DEFINITIONS } from '../../../../src/modules/insurance/insurance.metrics';
import { getDashboard, getApprovalRateReport } from '../../../../src/modules/insurance/insurance.service';

const T = 'tenant-1';

beforeEach(() => vi.clearAllMocks());

describe('computeAmountApprovalRate (gap 290)', () => {
  it('approved amount ÷ claimed amount of decided claims', () => {
    const r = computeAmountApprovalRate([
      { status: 'approved', claimAmount: 1000, approvedAmount: 600 },
      { status: 'settled', claimAmount: 500, approvedAmount: 500 },
      { status: 'rejected', claimAmount: 500, approvedAmount: null },
      // Not decided / void — left out of both numerator and denominator.
      { status: 'submitted', claimAmount: 9999 },
      { status: 'cancelled', claimAmount: 9999, approvedAmount: 9999 },
      { status: 'resubmitted', claimAmount: 9999, approvedAmount: 9999 },
    ]);
    expect(r).toEqual({ decidedApprovedAmount: 1100, decidedClaimedAmount: 2000, amountApprovalRate: 55 });
  });

  it('is null — not 0% — when nothing has been decided', () => {
    expect(computeAmountApprovalRate([{ status: 'submitted', claimAmount: 100 }]).amountApprovalRate).toBeNull();
  });

  it('a part-approval is 100% by count but less by amount', () => {
    expect(computeAmountApprovalRate([{ status: 'partially_approved', claimAmount: 1000, approvedAmount: 600 }]).amountApprovalRate).toBe(60);
  });

  it('both definitions are written down', () => {
    expect(INSURANCE_METRIC_DEFINITIONS.approvalRate).toMatch(/by count/i);
    expect(INSURANCE_METRIC_DEFINITIONS.amountApprovalRate).toMatch(/approved amount ÷ claimed amount/i);
  });
});

describe('dashboard filters match Reports (gap 290)', () => {
  const rows = [
    { id: 'a', claimNumber: 'A', status: 'partially_approved', claimAmount: 1000, approvedAmount: 600, paidAmount: 0, writtenOffAmount: 0, submissionDate: new Date(), approvalDate: null, patient: null, insuranceCase: null, policy: { id: 'p', policyNumber: 'P', insurer: { id: 'ins-1', name: 'Star' } } },
    { id: 'b', claimNumber: 'B', status: 'rejected', claimAmount: 1000, approvedAmount: null, paidAmount: 0, writtenOffAmount: 0, submissionDate: new Date(), approvalDate: null, patient: null, insuranceCase: null, policy: { id: 'p', policyNumber: 'P', insurer: { id: 'ins-1', name: 'Star' } } },
  ];

  it('passes the date range and insurer to the same claim query, and shows the same rates', async () => {
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue(rows as never);
    const filters = { fromDate: '2026-11-01', toDate: '2026-11-20', insurerId: '11111111-1111-4111-8111-111111111111' };

    const dash = await getDashboard(T, filters);
    const report = await getApprovalRateReport(T, filters);

    expect(dash.claims.approvalRate).toBe(50);
    expect(report.overall.approvalRate).toBe(50);
    expect(dash.claims.amountApprovalRate).toBe(30);
    expect(report.overall.amountApprovalRate).toBe(30);
    expect(dash.claims.decidedApprovedAmount).toBe(600);
    expect(dash.claims.decidedClaimedAmount).toBe(2000);
    expect(report.overall).toMatchObject({ decidedApprovedAmount: 600, decidedClaimedAmount: 2000 });

    // The dashboard's money query and the report's query carry the same filter clause.
    const calls = vi.mocked(prisma.insuranceClaim.findMany).mock.calls.map((c) => (c[0] as any).where);
    const dashMoney = calls.find((w) => w.status?.notIn && w.submissionDate);
    const reportWhere = calls[calls.length - 1];
    expect(dashMoney.submissionDate).toEqual(reportWhere.submissionDate);
    expect(dashMoney.AND).toEqual(reportWhere.AND);
    expect(JSON.stringify(dashMoney.AND)).toContain(filters.insurerId);

    // Status counts are scoped too.
    const counts = vi.mocked(prisma.insuranceClaim.count).mock.calls.map((c) => (c[0] as any).where);
    expect(counts.find((w) => w.status === 'rejected')?.submissionDate).toBeDefined();
    expect(dash.filters).toMatchObject({ fromDate: '2026-11-01', insurerId: filters.insurerId });
  });
});
