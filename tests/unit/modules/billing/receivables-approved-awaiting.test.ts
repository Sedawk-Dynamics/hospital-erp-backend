// Gap 287: Receivables separates the insurer's APPROVED receivable (the same
// figure, by the same helper, as Insurance → Outstanding) from what is still
// AWAITING a payer decision, and every headline opens the bills behind it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  classifyPayerOutstanding,
  getCreditSettlements,
  getReceivableLines,
} from '../../../../src/modules/billing/billing.service';
import { getOutstandingReport } from '../../../../src/modules/insurance/insurance.service';

const T = 'tenant-1';
const insurer = { id: 'ins-1', name: 'Star Health' };
const patient = { id: 'pat-1', firstName: 'Asha', lastName: 'Rao', mrn: 'MRN1', phone: '9000000000' };

// QA fixture: ₹1,000 bill with ₹800 approved (patient owes ₹200), and a ₹110
// bill whose claim is still with the payer.
const approvedClaim = {
  id: 'c-approved', claimNumber: 'CLM-1', status: 'approved', claimAmount: 1000, approvedAmount: 800,
  paidAmount: 0, writtenOffAmount: 0, disallowedAmount: 0, policy: { insurer, tpa: null },
};
const awaitingClaim = {
  id: 'c-awaiting', claimNumber: 'CLM-2', status: 'submitted', claimAmount: 110, approvedAmount: null,
  paidAmount: 0, writtenOffAmount: 0, disallowedAmount: 0, policy: { insurer, tpa: null },
};
const bills = [
  {
    id: 'b-1', billNumber: 'B-1', patientId: 'pat-1', patient, status: 'pending', createdAt: new Date('2026-11-01T05:00:00Z'),
    totalAmount: 1000, insuranceCoveredAmount: 800, patientPayableAmount: 200, insuranceClaims: [approvedClaim],
  },
  {
    id: 'b-2', billNumber: 'B-2', patientId: 'pat-1', patient, status: 'pending', createdAt: new Date('2026-11-05T05:00:00Z'),
    totalAmount: 110, insuranceCoveredAmount: 0, patientPayableAmount: 0, insuranceClaims: [awaitingClaim],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.bill.findMany).mockResolvedValue(bills as never);
  vi.mocked(prisma.insuranceClaim.findMany).mockImplementation((async (args: any) => {
    const wanted: string[] | undefined = args?.where?.status?.in;
    const all = [approvedClaim, awaitingClaim].map((c) => ({
      ...c, submissionDate: new Date(), approvalDate: null, patient: null, insuranceCase: null,
      policy: { id: 'pol', policyNumber: 'P1', insurer },
    }));
    return wanted ? all.filter((c) => wanted.includes(c.status)) : all;
  }) as never);
});

describe('classifyPayerOutstanding (gap 287)', () => {
  it('splits a payer outstanding into approved, awaiting and other — always adding back up', () => {
    expect(classifyPayerOutstanding(800, [approvedClaim as never])).toEqual({ approvedReceivable: 800, awaitingDecision: 0, otherPayer: 0 });
    expect(classifyPayerOutstanding(110, [awaitingClaim as never])).toEqual({ approvedReceivable: 0, awaitingDecision: 110, otherPayer: 0 });
    // A settled claim owes nothing by Insurance's definition; the ledger balance shows as "other".
    const r = classifyPayerOutstanding(50, [{ status: 'settled', claimAmount: 500, approvedAmount: 500, paidAmount: 450 }]);
    expect(r).toEqual({ approvedReceivable: 0, awaitingDecision: 0, otherPayer: 50 });
    // Void claims never count.
    expect(classifyPayerOutstanding(0, [{ status: 'cancelled', claimAmount: 900, approvedAmount: 900 }]).approvedReceivable).toBe(0);
  });
});

describe('Receivables approved vs awaiting decision (gap 287)', () => {
  it('shows ₹800 approved (= Insurance → Outstanding) and ₹110 awaiting as separate figures', async () => {
    const res = await getCreditSettlements(T, {});
    const row = res.settlements.find((s) => s.id === 'ins:ins-1')!;

    expect(row.outstandingAmount).toBe(910);
    expect(row.approvedReceivableAmount).toBe(800);
    expect(row.awaitingDecisionAmount).toBe(110);
    expect(row.otherPayerAmount).toBe(0);

    const out = await getOutstandingReport(T, {});
    expect(res.stats.totalApprovedReceivable).toBe(out.totalOutstanding);
    expect(res.stats.insuranceOutstanding).toBe(800);
  });

  it('totals still reconcile internally', async () => {
    const { stats } = await getCreditSettlements(T, {});
    expect(stats.totalOutstanding).toBe(1110);
    expect(stats.totalPatientOutstanding).toBe(200);
    expect(stats.totalPayerOutstanding).toBe(910);
    expect(stats.reconciliationDifference).toBe(0);
    expect(stats.payerReconciliationDifference).toBe(0);
    expect(r2(stats.totalPatientOutstanding + stats.totalApprovedReceivable + stats.totalAwaitingDecision + stats.totalOtherPayer))
      .toBe(stats.totalOutstanding);
  });

  it('each headline opens the bills behind it, and their sum is the headline', async () => {
    const { stats } = await getCreditSettlements(T, {});
    const cases: Array<[any, number]> = [
      ['billed', stats.totalClaim],
      ['received', stats.totalReceived],
      ['outstanding', stats.totalOutstanding],
      ['approvedReceivable', stats.totalApprovedReceivable],
      ['awaitingDecision', stats.totalAwaitingDecision],
      ['patientOutstanding', stats.totalPatientOutstanding],
    ];
    for (const [figure, headline] of cases) {
      const d = await getReceivableLines(T, { figure });
      expect(d.total, figure).toBe(headline);
    }
    const approved = await getReceivableLines(T, { figure: 'approvedReceivable' });
    expect(approved.lines.map((l) => l.billNumber)).toEqual(['B-1']);
    const awaiting = await getReceivableLines(T, { figure: 'awaitingDecision' });
    expect(awaiting.lines.map((l) => [l.billNumber, l.claimStatus])).toEqual([['B-2', 'submitted']]);
  });

  it('drill-downs honour the same payer-type and search filters as the list', async () => {
    const list = await getCreditSettlements(T, { type: 'patient' });
    const lines = await getReceivableLines(T, { type: 'patient', figure: 'outstanding' });
    expect(lines.total).toBe(list.stats.totalOutstanding);
    expect(lines.total).toBe(200);
    const none = await getReceivableLines(T, { search: 'nobody', figure: 'billed' });
    expect(none.count).toBe(0);
  });
});

function r2(n: number) {
  return Math.round(n * 100) / 100;
}
