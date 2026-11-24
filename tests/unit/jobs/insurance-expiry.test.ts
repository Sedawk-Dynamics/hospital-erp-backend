import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/config/database';
import { usersWithRoles } from '../../../src/shared/notify';
import { runInsuranceExpiryJob, runInsuranceSlaJob } from '../../../src/jobs/insurance-expiry';

vi.mock('../../../src/shared/notify', () => ({ usersWithRoles: vi.fn() }));

describe('insurance SLA job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersWithRoles).mockResolvedValue(['manager-1']);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'notification-1' } as never);
    vi.mocked(prisma.preAuthorizationRequest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.claimQuery.update).mockResolvedValue({} as never);
  });

  it('alerts authorization owners and escalates overdue payer queries', async () => {
    const now = new Date('2026-09-21T12:00:00.000Z');
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([{
      id: 'preauth-1', tenantId: 'tenant-1', requestNumber: 'PA-1', requestType: 'finalDischarge',
      submittedBy: 'submitter-1', decisionDueAt: new Date('2026-09-21T11:55:00.000Z'),
      alertAt: new Date('2026-09-21T11:30:00.000Z'), escalatedAt: null,
      patient: { firstName: 'Asha', lastName: 'Rao' },
    }] as never);
    vi.mocked(prisma.claimQuery.findMany).mockResolvedValue([{
      id: 'query-1', tenantId: 'tenant-1', claimId: 'claim-1', subject: 'Discharge summary',
      raisedBy: 'owner-1', responseDueAt: new Date('2026-09-21T11:00:00.000Z'), escalationLevel: 0,
      claim: { claimNumber: 'CLM-1', patient: { firstName: 'Asha', lastName: 'Rao' } },
    }] as never);

    const result = await runInsuranceSlaJob(now);

    expect(result).toEqual({ authorizationAlerts: 2, queryAlerts: 2 });
    expect(prisma.preAuthorizationRequest.update).toHaveBeenCalledWith({
      where: { id: 'preauth-1' }, data: { escalatedAt: now },
    });
    expect(prisma.claimQuery.update).toHaveBeenCalledWith({
      where: { id: 'query-1' }, data: { escalationLevel: 2 },
    });
  });
});

describe('insurance expiry job (gap 295/296)', () => {
  const now = new Date('2026-11-19T04:30:00.000Z'); // 19/11/2026 10:00 IST

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersWithRoles).mockResolvedValue(['manager-1']);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'n' } as never);
    // The SLA suite above leaves its pre-auth fixture installed.
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.insurancePolicy.findMany).mockResolvedValue([] as never);
  });

  it('writes one "expired" alert for a claim past its deadline, worded from the due date', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.insuranceClaim.findMany).mockImplementation((async (args: any) =>
      args.where.expiryDate.lt
        ? [{ id: 'c1', tenantId: 't1', claimNumber: 'CLM-1', submittedBy: 'u1', reviewedBy: null,
            expiryDate: new Date('2026-11-09T00:00:00.000Z'), patient: { firstName: 'Asha', lastName: 'Rao' } }]
        : []) as never);

    await runInsuranceExpiryJob(now);

    const created = vi.mocked(prisma.notification.create).mock.calls.map((c) => (c[0] as any).data);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: 'u1', title: 'Insurance claim expired', referenceId: 'c1' });
    expect(created[0].message).not.toMatch(/expiring/i);
  });

  it('does not write a second copy when the job runs again (e.g. on restart)', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: 'existing' } as never);
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([
      { id: 'c1', tenantId: 't1', claimNumber: 'CLM-1', submittedBy: 'u1', reviewedBy: null,
        expiryDate: new Date('2026-11-20T00:00:00.000Z'), patient: { firstName: 'Asha', lastName: 'Rao' } },
    ] as never);
    vi.mocked(prisma.insurancePolicy.findMany).mockResolvedValue([
      { id: 'p1', tenantId: 't1', policyNumber: 'POL-1', validTo: new Date('2026-11-22T00:00:00.000Z'), patient: { firstName: 'A', lastName: 'B' } },
    ] as never);

    await runInsuranceExpiryJob(now);

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('looks up reminder windows by IST calendar day', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([] as never);

    await runInsuranceExpiryJob(now);

    const windows = vi.mocked(prisma.insuranceClaim.findMany).mock.calls
      .map((c) => (c[0] as any).where.expiryDate)
      .filter((w) => w.gte && w.lte);
    // 1-day reminder = the whole of 20/11 IST.
    expect(windows.map((w) => [w.gte.toISOString(), w.lte.toISOString()])).toContainEqual([
      '2026-11-19T18:30:00.000Z',
      '2026-11-20T18:29:59.999Z',
    ]);
  });
});
