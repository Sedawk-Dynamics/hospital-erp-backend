import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createInsurer,
  updateInsurer,
  createTPA,
  cancelClaim,
  getDashboard,
  getClaims,
  getApprovalRateReport,
  getOutstandingReport,
  getAgingReport,
  normalizePayerName,
} from '../../../../src/modules/insurance/insurance.service';
import { averageDecisionMinutes, latestSlaAction } from '../../../../src/modules/insurance/insurance.workflow.service';

const T = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('duplicate payers are refused (gap 293)', () => {
  it('normalises case, spacing and punctuation', () => {
    expect(normalizePayerName('  M5  Insurer-A. ')).toBe(normalizePayerName('m5 insurer a'));
  });

  it('blocks a second insurer with the same normalised name and names the existing one', async () => {
    vi.mocked(prisma.insurer.findMany).mockResolvedValue([
      { id: 'ins-1', name: 'M5 Insurer A', gstin: null, isActive: true },
    ] as never);
    await expect(createInsurer(T, { name: 'm5 insurer a' } as never)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('"M5 Insurer A" already exists'),
    });
    expect(prisma.insurer.create).not.toHaveBeenCalled();
    // Scoped to this hospital.
    expect((vi.mocked(prisma.insurer.findMany).mock.calls[0][0] as any).where.tenantId).toBe(T);
  });

  it('blocks a duplicate GSTIN', async () => {
    vi.mocked(prisma.insurer.findMany).mockResolvedValue([
      { id: 'ins-1', name: 'Star Health', gstin: '27AAPFU0939F1ZV', isActive: false },
    ] as never);
    await expect(createInsurer(T, { name: 'Star Health TN', gstin: '27AAPFU0939F1ZV' } as never)).rejects.toThrow(
      /GSTIN 27AAPFU0939F1ZV already exists: "Star Health".*inactive/,
    );
  });

  it('lets an insurer keep its own name on update', async () => {
    vi.mocked(prisma.insurer.findFirst).mockResolvedValue({ id: 'ins-1', tenantId: T, name: 'M5 Insurer A' } as never);
    vi.mocked(prisma.insurer.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.insurer.update).mockResolvedValue({ id: 'ins-1' } as never);
    await updateInsurer(T, 'ins-1', { name: 'M5 Insurer A' } as never);
    expect((vi.mocked(prisma.insurer.findMany).mock.calls[0][0] as any).where.id).toEqual({ not: 'ins-1' });
  });

  it('applies the same rule to TPAs', async () => {
    vi.mocked(prisma.tpaProvider.findMany).mockResolvedValue([
      { id: 'tpa-1', name: 'MediAssist', gstin: null, isActive: true },
    ] as never);
    await expect(createTPA(T, { name: 'mediassist' } as never)).rejects.toThrow(/A TPA named "MediAssist"/);
  });
});

describe('cancelling a claim (gap 291)', () => {
  it('zeroes the outstanding', async () => {
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({
      id: 'c1', tenantId: T, status: 'approved', billId: 'b1', claimAmount: 200001, claimNumber: 'CLM-1',
    } as never);
    vi.mocked(prisma.insuranceClaim.update).mockResolvedValue({ id: 'c1', status: 'cancelled' } as never);
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(null as never);
    await cancelClaim(T, 'c1', 'u1', { reason: 'Duplicate' } as never).catch(() => undefined);
    const data = vi.mocked(prisma.insuranceClaim.update).mock.calls[0][0].data as any;
    expect(data).toMatchObject({ status: 'cancelled', outstandingAmount: 0 });
  });
});

const claimRows = [
  { id: 'a', claimNumber: 'A', status: 'approved', claimAmount: 1000, approvedAmount: 800, paidAmount: 300, writtenOffAmount: 0, submissionDate: new Date(), approvalDate: new Date(), patient: null, insuranceCase: null, policy: { id: 'p', policyNumber: 'P1', insurer: { id: 'ins-1', name: 'Star' } } },
  { id: 'b', claimNumber: 'B', status: 'rejected', claimAmount: 500, approvedAmount: null, paidAmount: 0, writtenOffAmount: 0, submissionDate: new Date(), approvalDate: null, patient: null, insuranceCase: null, policy: null },
  { id: 'c', claimNumber: 'C', status: 'submitted', claimAmount: 400, approvedAmount: null, paidAmount: 0, writtenOffAmount: 0, submissionDate: new Date(), approvalDate: null, patient: null, insuranceCase: { insurer: null, corporatePayer: { id: 'corp', name: 'Acme' }, governmentSchemePayer: null }, policy: null },
];

describe('dashboard and reports agree (gap 290)', () => {
  it('serve the same approval rate and outstanding', async () => {
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue(claimRows as never);
    const dash = await getDashboard(T);
    const report = await getApprovalRateReport(T, {});
    const out = await getOutstandingReport(T, {});

    // 1 approved of 2 decided.
    expect(dash.claims.approvalRate).toBe(50);
    expect(report.overall.approvalRate).toBe(50);
    expect(dash.settlement.totalOutstanding).toBe(500);
    expect(out.totalOutstanding).toBe(500);
    expect(dash.definitions.approvalRate).toBe(report.definitions.approvalRate);
    // Dashboard money sums leave out cancelled/superseded claims at the query.
    const moneyQuery = vi.mocked(prisma.insuranceClaim.findMany).mock.calls.find(
      (c) => (c[0] as any)?.select?.writtenOffAmount && !(c[0] as any)?.select?.patient,
    )![0] as any;
    expect(moneyQuery.where.status).toEqual({ notIn: ['cancelled', 'resubmitted'] });
  });

  it('counts already-expired claims on the dashboard (gap 296)', async () => {
    vi.mocked(prisma.insuranceClaim.count).mockResolvedValue(0 as never);
    await getDashboard(T);
    const expiredCall = vi.mocked(prisma.insuranceClaim.count).mock.calls.find(
      (c) => (c[0] as any)?.where?.expiryDate?.lt,
    );
    expect(expiredCall).toBeDefined();
  });

  it('the claims list ?expiry= filter selects the claims the dashboard counted (gap 296)', async () => {
    vi.mocked(prisma.insuranceClaim.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([] as never);
    await getDashboard(T);
    const dashWheres = vi.mocked(prisma.insuranceClaim.count).mock.calls
      .map((c) => (c[0] as any)?.where)
      .filter((w) => w?.expiryDate);
    vi.mocked(prisma.insuranceClaim.count).mockClear();

    for (const kind of ['expired', 'expiring'] as const) {
      await getClaims(T, { expiry: kind });
      const listWhere = (vi.mocked(prisma.insuranceClaim.count).mock.calls.at(-1)![0] as any).where;
      const dash = dashWheres.find((w) => (kind === 'expired' ? w.expiryDate.lt : w.expiryDate.gte));
      expect(listWhere.tenantId).toBe(T);
      expect(listWhere.AND).toEqual([{ status: dash.status, expiryDate: dash.expiryDate }]);
    }
  });

  it('groups claims without a payer as "Payer missing" in the reports (gap 292)', async () => {
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue(claimRows as never);
    const rate = await getApprovalRateReport(T, {});
    expect(rate.byInsurer.map((r) => r.insurerName)).toEqual(['Star', 'Acme', 'Payer missing']);
    expect(rate.byInsurer.reduce((s, r) => s + r.total, 0)).toBe(rate.overall.total);

    const aging = await getAgingReport(T, {});
    // Approved claim owes 500, the submitted one awaits 400; the rejected one never ages.
    expect(aging.total.amount).toBe(900);
    expect(aging.byPayer.reduce((s, g) => s + g.amount, 0)).toBe(900);
    const agedClaims = aging.buckets.flatMap((b) => b.claims);
    expect(agedClaims.find((c) => c.id === 'c')?.insurer).toEqual({ id: 'corp', name: 'Acme' });
  });

  it('filters the payer through the payer case as well as the policy (gap 292)', async () => {
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([] as never);
    await getOutstandingReport(T, { insurerId: 'ins-1', toDate: '2026-11-13' });
    const where = (vi.mocked(prisma.insuranceClaim.findMany).mock.calls[0][0] as any).where;
    expect(where.AND[0].OR).toEqual([{ insuranceCase: { insurerId: 'ins-1' } }, { policy: { insurerId: 'ins-1' } }]);
    // End date inclusive in IST.
    expect(where.submissionDate.lte.toISOString()).toBe('2026-11-13T18:29:59.999Z');
  });
});

describe('SLA deadline centre (gap 294)', () => {
  it('averages only requests with both times, and is null when there are none', () => {
    expect(averageDecisionMinutes([])).toBeNull();
    expect(averageDecisionMinutes([{ submittedAt: null, decidedAt: new Date() }])).toBeNull();
    expect(
      averageDecisionMinutes([
        { submittedAt: new Date('2026-11-01T10:00:00Z'), decidedAt: new Date('2026-11-01T11:00:00Z') },
        { submittedAt: new Date('2026-11-01T10:00:00Z'), decidedAt: new Date('2026-11-01T10:30:00Z') },
        { submittedAt: new Date('2026-11-01T10:00:00Z'), decidedAt: null },
      ]),
    ).toBe(45);
  });

  it('reports the newer of the last audit event and payer communication', () => {
    const by = { id: 'u1', firstName: 'Ravi', lastName: null };
    expect(
      latestSlaAction(
        { eventType: 'preauth.submitted', occurredAt: new Date('2026-11-01T10:00:00Z'), actor: by },
        { subject: 'Called TPA', createdAt: new Date('2026-11-02T10:00:00Z'), communicator: by },
      ),
    ).toMatchObject({ label: 'Called TPA' });
    expect(latestSlaAction(null, null)).toBeNull();
  });
});
