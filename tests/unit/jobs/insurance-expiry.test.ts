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
    vi.mocked(prisma.preAuthorizationRequest.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.claimQuery.update).mockResolvedValue({} as never);
    vi.mocked(prisma.claimQuery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.claimQuery.findMany).mockResolvedValue([] as never);
  });

  const preAuth = (overdueMinutes: number, extra: Record<string, unknown> = {}) => ({
    id: 'preauth-1', tenantId: 'tenant-1', requestNumber: 'PA-1', requestType: 'initial', status: 'pending',
    insuranceCaseId: 'case-1', submittedBy: 'submitter-1',
    decisionDueAt: new Date(now.getTime() - overdueMinutes * 60_000),
    alertAt: new Date(now.getTime() - (overdueMinutes + 15) * 60_000), escalatedAt: null,
    patient: { firstName: 'Asha', lastName: 'Rao' }, ...extra,
  });
  const now = new Date('2026-09-21T12:00:00.000Z');
  const stages = () => vi.mocked(prisma.notification.create).mock.calls.map((c) => (c[0] as any).data);

  it('alerts the owner and the insurance desk on breach, but does not escalate before the configured hours', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([preAuth(5, { requestType: 'finalDischarge' })] as never);

    const result = await runInsuranceSlaJob(now);

    expect(result.authorizationAlerts).toBe(2);
    expect(result.escalations).toBe(0);
    expect(vi.mocked(usersWithRoles).mock.calls).toEqual([['tenant-1', ['insurance_staff']]]);
    expect(prisma.preAuthorizationRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.insuranceAuditEvent.create).not.toHaveBeenCalled();
  });

  it('escalates to the configured role after the configured hours and records the escalation', async () => {
    vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([
      { requestType: 'preauth', escalateAfterHours: 3, targetRole: 'billing_admin' },
    ] as never);
    vi.mocked(usersWithRoles).mockImplementation((async (_t: string, roles: string[]) =>
      roles[0] === 'billing_admin' ? ['billing-head'] : ['desk-1']) as never);

    // 2h overdue: not yet (rule says 3h).
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([preAuth(120)] as never);
    await runInsuranceSlaJob(now);
    expect(usersWithRoles).not.toHaveBeenCalledWith('tenant-1', ['billing_admin']);

    // 3h overdue: escalated.
    vi.mocked(prisma.notification.create).mockClear();
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([preAuth(180)] as never);
    const result = await runInsuranceSlaJob(now);

    expect(result.escalations).toBe(1);
    expect(usersWithRoles).toHaveBeenCalledWith('tenant-1', ['billing_admin']);
    const escalated = stages().filter((n) => n.title.includes('escalated'));
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ userId: 'billing-head', referenceId: 'preauth-1' });
    expect(prisma.preAuthorizationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'preauth-1', escalatedAt: null }, data: { escalatedAt: now, escalatedToRole: 'billing_admin' },
    });
    const history = vi.mocked(prisma.insuranceAuditEvent.create).mock.calls[0][0].data as any;
    expect(history).toMatchObject({ preAuthId: 'preauth-1', eventType: 'preauth.sla_escalated' });
    expect(history.details).toMatchObject({ targetRole: 'billing_admin', escalateAfterHours: 3, recipients: 1 });
  });

  it('does not escalate the same request twice', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([preAuth(600, { escalatedAt: new Date(now.getTime() - 60_000) })] as never);
    const result = await runInsuranceSlaJob(now);
    expect(result.escalations).toBe(0);
    expect(prisma.preAuthorizationRequest.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to the administrator when nobody holds the configured role', async () => {
    vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([
      { requestType: 'preauth', escalateAfterHours: 1, targetRole: 'billing_admin' },
    ] as never);
    vi.mocked(usersWithRoles).mockImplementation((async (_t: string, roles: string[]) =>
      roles[0] === 'admin' ? ['admin-1'] : roles[0] === 'billing_admin' ? [] : ['desk-1']) as never);
    vi.mocked(prisma.preAuthorizationRequest.findMany).mockResolvedValue([preAuth(90)] as never);

    await runInsuranceSlaJob(now);

    expect(stages().find((n) => n.title.includes('escalated'))).toMatchObject({ userId: 'admin-1' });
    expect((vi.mocked(prisma.insuranceAuditEvent.create).mock.calls[0][0].data as any).details.fallbackToAdmin).toBe(true);
  });

  it('escalates overdue payer queries by the claim-query rule', async () => {
    vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([
      { requestType: 'claim_query', escalateAfterHours: 2, targetRole: 'insurance_staff' },
    ] as never);
    const query = (overdueHours: number) => ({
      id: 'query-1', tenantId: 'tenant-1', claimId: 'claim-1', subject: 'Discharge summary',
      raisedBy: 'owner-1', responseDueAt: new Date(now.getTime() - overdueHours * 3600_000), escalationLevel: 0,
      claim: { claimNumber: 'CLM-1', insuranceCaseId: 'case-1', patient: { firstName: 'Asha', lastName: 'Rao' } },
    });

    // 1h overdue → overdue alert only (level 2).
    vi.mocked(prisma.claimQuery.findMany).mockResolvedValue([query(1)] as never);
    await runInsuranceSlaJob(now);
    expect(prisma.claimQuery.update).toHaveBeenCalledWith({ where: { id: 'query-1' }, data: { escalationLevel: 2 } });
    expect(prisma.claimQuery.updateMany).not.toHaveBeenCalled();

    // 2h overdue → escalated to the configured role (level 3).
    vi.mocked(prisma.claimQuery.findMany).mockResolvedValue([{ ...query(2), escalationLevel: 2 }] as never);
    const result = await runInsuranceSlaJob(now);
    expect(result.escalations).toBe(1);
    expect(usersWithRoles).toHaveBeenCalledWith('tenant-1', ['insurance_staff']);
    expect(prisma.claimQuery.updateMany).toHaveBeenCalledWith({
      where: { id: 'query-1', escalationLevel: { lt: 3 } },
      data: { escalationLevel: 3, escalatedAt: now, escalatedToRole: 'insurance_staff' },
    });
    expect(vi.mocked(prisma.insuranceAuditEvent.create).mock.calls[0][0].data).toMatchObject({
      claimId: 'claim-1', eventType: 'claim_query.sla_escalated',
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
