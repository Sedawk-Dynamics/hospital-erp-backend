import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/config/database';
import { usersWithRoles } from '../../../src/shared/notify';
import { runInsuranceSlaJob } from '../../../src/jobs/insurance-expiry';

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
