import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  DEFAULT_ESCALATION,
  closeStalePreAuth,
  closeStaleClaimQuery,
  getEscalationSettings,
  resolveEscalationRules,
  updateEscalationSettings,
} from '../../../../src/modules/insurance/insurance.escalation';
import {
  closeStalePreAuthSchema,
  closeStaleClaimQuerySchema,
  updateEscalationSettingsSchema,
} from '../../../../src/modules/insurance/insurance.admin.validation';
import { insuranceRoutes } from '../../../../src/modules/insurance/insurance.routes';

const T = 'tenant-1';
const ROLES = [{ name: 'admin', description: null }, { name: 'billing_admin', description: null }, { name: 'insurance_staff', description: null }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.role.findMany).mockResolvedValue(ROLES as never);
  vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([] as never);
});

describe('SLA escalation settings (gap 294)', () => {
  it('falls back to defaults for every request type until configured', async () => {
    const rules = await resolveEscalationRules(T);
    expect(rules).toEqual(DEFAULT_ESCALATION);
    const view = await getEscalationSettings(T);
    expect(view.settings.map((s) => s.requestType)).toEqual(['preauth', 'final_discharge', 'claim_query']);
    expect(view.settings.every((s) => s.isDefault)).toBe(true);
    // Only staff roles are offered.
    expect((vi.mocked(prisma.role.findMany).mock.calls[0][0] as any).where).toEqual({ tenantId: T, name: { notIn: ['patient', 'super_admin'] } });
  });

  it('uses the configured hours and role', async () => {
    vi.mocked(prisma.insuranceEscalationSetting.findMany).mockResolvedValue([
      { requestType: 'preauth', escalateAfterHours: 4, targetRole: 'billing_admin' },
    ] as never);
    const rules = await resolveEscalationRules(T);
    expect(rules.preauth).toEqual({ escalateAfterHours: 4, targetRole: 'billing_admin' });
    expect(rules.claim_query).toEqual(DEFAULT_ESCALATION.claim_query);
  });

  it('validates hours > 0 (whole number, capped) and a known request type', () => {
    const body = (h: unknown, requestType = 'preauth') => ({ body: { settings: [{ requestType, escalateAfterHours: h, targetRole: 'admin' }] } });
    expect(updateEscalationSettingsSchema.safeParse(body(0)).success).toBe(false);
    expect(updateEscalationSettingsSchema.safeParse(body(-2)).success).toBe(false);
    expect(updateEscalationSettingsSchema.safeParse(body(1.5)).success).toBe(false);
    expect(updateEscalationSettingsSchema.safeParse(body(721)).success).toBe(false);
    expect(updateEscalationSettingsSchema.safeParse(body(2, 'discharge_summary')).success).toBe(false);
    expect(updateEscalationSettingsSchema.safeParse(body(2)).success).toBe(true);
  });

  it('refuses a role that is not a staff role of this hospital', async () => {
    await expect(updateEscalationSettings(T, 'admin-1', [{ requestType: 'preauth', escalateAfterHours: 2, targetRole: 'patient' }]))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not a staff role') });
    await expect(updateEscalationSettings(T, 'admin-1', [{ requestType: 'preauth', escalateAfterHours: 2, targetRole: 'made_up' }]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(updateEscalationSettings(T, 'admin-1', [{ requestType: 'preauth', escalateAfterHours: 0, targetRole: 'admin' }]))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.insuranceEscalationSetting.upsert).not.toHaveBeenCalled();
  });

  it('saves per tenant and request type, and audits the change', async () => {
    await updateEscalationSettings(T, 'admin-1', [{ requestType: 'claim_query', escalateAfterHours: 6, targetRole: 'billing_admin' }]);
    expect(prisma.insuranceEscalationSetting.upsert).toHaveBeenCalledWith({
      where: { tenantId_requestType: { tenantId: T, requestType: 'claim_query' } },
      create: { tenantId: T, requestType: 'claim_query', escalateAfterHours: 6, targetRole: 'billing_admin', updatedBy: 'admin-1' },
      update: { escalateAfterHours: 6, targetRole: 'billing_admin', updatedBy: 'admin-1' },
    });
    const audit = vi.mocked(prisma.auditLog.create).mock.calls[0][0].data as any;
    expect(audit).toMatchObject({ tenantId: T, userId: 'admin-1', entityType: 'insurance_escalation_setting', action: 'update' });
    expect(audit.newValues).toEqual({ claim_query: { escalateAfterHours: 6, targetRole: 'billing_admin' } });
    expect(audit.oldValues).toEqual({ claim_query: DEFAULT_ESCALATION.claim_query });
  });
});

describe('closing a stale request with a reason (gap 294)', () => {
  const overdue = {
    id: 'pa-1', tenantId: T, requestNumber: 'PA-1', status: 'pending', insuranceCaseId: 'case-1',
    decisionDueAt: new Date(Date.now() - 3 * 24 * 3600_000), escalatedAt: null,
  };

  it('requires a reason (server-side)', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(overdue as never);
    await expect(closeStalePreAuth(T, 'u1', 'pa-1', '   ')).rejects.toMatchObject({ statusCode: 400 });
    await expect(closeStalePreAuth(T, 'u1', 'pa-1', undefined)).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.preAuthorizationRequest.updateMany).not.toHaveBeenCalled();
    const p = { id: '6f1c1f43-4b6a-4b85-8b0e-6a3c1f0a2b11' };
    expect(closeStalePreAuthSchema.safeParse({ params: p, body: {} }).success).toBe(false);
    expect(closeStalePreAuthSchema.safeParse({ params: p, body: { reason: 'short' } }).success).toBe(false);
    expect(closeStalePreAuthSchema.safeParse({ params: p, body: { reason: 'Payer never responded; patient paid cash' } }).success).toBe(true);
  });

  it('only closes an overdue pending request', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue({ ...overdue, decisionDueAt: new Date(Date.now() + 3600_000) } as never);
    await expect(closeStalePreAuth(T, 'u1', 'pa-1', 'Payer never responded at all')).rejects.toThrow(/not overdue/);
    vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue({ ...overdue, status: 'approved' } as never);
    await expect(closeStalePreAuth(T, 'u1', 'pa-1', 'Payer never responded at all')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('stores who/when/why, leaves the overdue list, and writes history + audit', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(overdue as never);
    vi.mocked(prisma.preAuthorizationRequest.updateMany).mockResolvedValue({ count: 1 } as never);

    await closeStalePreAuth(T, 'u1', 'pa-1', '  Patient discharged as cash; payer silent  ');

    const update = vi.mocked(prisma.preAuthorizationRequest.updateMany).mock.calls[0][0] as any;
    expect(update.where).toEqual({ id: 'pa-1', tenantId: T, status: { in: ['pending', 'on_hold'] } });
    // cancelled is outside the queue's pending/on_hold filter.
    expect(update.data).toMatchObject({ status: 'cancelled', closedBy: 'u1', closeReason: 'Patient discharged as cash; payer silent' });
    expect(update.data.closedAt).toBeInstanceOf(Date);

    const history = vi.mocked(prisma.insuranceAuditEvent.create).mock.calls[0][0].data as any;
    expect(history).toMatchObject({ preAuthId: 'pa-1', actorId: 'u1', eventType: 'preauth.closed_stale', fromStatus: 'pending', toStatus: 'cancelled' });
    expect(history.details.reason).toBe('Patient discharged as cash; payer silent');

    const audit = vi.mocked(prisma.auditLog.create).mock.calls[0][0].data as any;
    expect(audit).toMatchObject({ entityType: 'pre_authorization_request', entityId: 'pa-1', userId: 'u1' });
    expect(audit.description).toContain('Reason: Patient discharged as cash');
  });

  it('fails instead of overwriting a decision that landed meanwhile', async () => {
    vi.mocked(prisma.preAuthorizationRequest.findFirst).mockResolvedValue(overdue as never);
    vi.mocked(prisma.preAuthorizationRequest.updateMany).mockResolvedValue({ count: 0 } as never);
    await expect(closeStalePreAuth(T, 'u1', 'pa-1', 'Payer never responded at all')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.insuranceAuditEvent.create).not.toHaveBeenCalled();
  });
});

describe('closing a stale payer query with a reason (gap 294 retest)', () => {
  const overdueQuery = {
    id: 'cq-1', tenantId: T, claimId: 'cl-1', subject: 'Discharge summary missing', status: 'open',
    responseDueAt: new Date(Date.now() - 2 * 24 * 3600_000), escalatedAt: null,
    claim: { id: 'cl-1', claimNumber: 'CLM-1', insuranceCaseId: 'case-1' },
  };

  it('requires a reason (server-side and in the schema)', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue(overdueQuery as never);
    await expect(closeStaleClaimQuery(T, 'u1', 'cq-1', '  ')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.claimQuery.updateMany).not.toHaveBeenCalled();
    const p = { queryId: '6f1c1f43-4b6a-4b85-8b0e-6a3c1f0a2b11' };
    expect(closeStaleClaimQuerySchema.safeParse({ params: p, body: {} }).success).toBe(false);
    expect(closeStaleClaimQuerySchema.safeParse({ params: p, body: { reason: 'short' } }).success).toBe(false);
    expect(closeStaleClaimQuerySchema.safeParse({ params: p, body: { reason: 'Payer closed the file without reply' } }).success).toBe(true);
  });

  it('an open query must be overdue; resolved or closed queries cannot be closed', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue({ ...overdueQuery, responseDueAt: new Date(Date.now() + 3600_000) } as never);
    await expect(closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer closed the file without reply')).rejects.toThrow(/not overdue/);
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue({ ...overdueQuery, status: 'resolved' } as never);
    await expect(closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer closed the file without reply')).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue(null as never);
    await expect(closeStaleClaimQuery(T, 'u1', 'cq-x', 'Payer closed the file without reply')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('an answered query waiting on the payer can be closed before any deadline', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue({ ...overdueQuery, status: 'responseSubmitted', responseDueAt: new Date(Date.now() + 3600_000) } as never);
    vi.mocked(prisma.claimQuery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.claimQuery.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({ status: 'response_submitted' } as never);
    await closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer accepted the response by phone');
    expect((vi.mocked(prisma.claimQuery.updateMany).mock.calls[0][0] as any).where.status).toBe('responseSubmitted');
  });

  it('stores who/when/why, writes history + audit, and returns the claim to review when nothing is left', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue(overdueQuery as never);
    vi.mocked(prisma.claimQuery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.claimQuery.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({ status: 'query_raised' } as never);

    await closeStaleClaimQuery(T, 'u1', 'cq-1', '  Payer closed the file without reply  ');

    const update = vi.mocked(prisma.claimQuery.updateMany).mock.calls[0][0] as any;
    expect(update.where).toEqual({ id: 'cq-1', tenantId: T, status: 'open' });
    expect(update.data).toMatchObject({ status: 'closed', closedBy: 'u1', closeReason: 'Payer closed the file without reply' });
    expect(update.data.closedAt).toBeInstanceOf(Date);
    expect(prisma.insuranceClaim.update).toHaveBeenCalledWith({ where: { id: 'cl-1' }, data: { status: 'under_review' } });
    expect(prisma.insuranceCase.update).toHaveBeenCalledWith({ where: { id: 'case-1' }, data: { status: 'claimSubmitted' } });

    const history = vi.mocked(prisma.insuranceAuditEvent.create).mock.calls[0][0].data as any;
    expect(history).toMatchObject({ claimId: 'cl-1', actorId: 'u1', eventType: 'claim_query.closed_stale', fromStatus: 'open', toStatus: 'closed' });
    expect(history.details.reason).toBe('Payer closed the file without reply');
    const audit = vi.mocked(prisma.auditLog.create).mock.calls[0][0].data as any;
    expect(audit).toMatchObject({ entityType: 'claim_query', entityId: 'cq-1', userId: 'u1' });
  });

  it('leaves the claim alone while other queries are outstanding or the claim has moved on', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue(overdueQuery as never);
    vi.mocked(prisma.claimQuery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.claimQuery.count).mockResolvedValueOnce(1 as never);
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({ status: 'query_raised' } as never);
    await closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer closed the file without reply');
    expect(prisma.insuranceClaim.update).not.toHaveBeenCalled();

    vi.mocked(prisma.claimQuery.count).mockResolvedValueOnce(0 as never);
    vi.mocked(prisma.insuranceClaim.findFirst).mockResolvedValue({ status: 'settled' } as never);
    await closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer closed the file without reply');
    expect(prisma.insuranceClaim.update).not.toHaveBeenCalled();
  });

  it('fails instead of overwriting a response or resolution that landed meanwhile', async () => {
    vi.mocked(prisma.claimQuery.findFirst).mockResolvedValue(overdueQuery as never);
    vi.mocked(prisma.claimQuery.updateMany).mockResolvedValue({ count: 0 } as never);
    await expect(closeStaleClaimQuery(T, 'u1', 'cq-1', 'Payer closed the file without reply')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.insuranceAuditEvent.create).not.toHaveBeenCalled();
  });
});

describe('route permissions (gap 294)', () => {
  function guard(method: string, path: string) {
    const layer = (insuranceRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    expect(layer).toBeDefined();
    return layer.route.stack[1].handle as (req: any, res: any, next: (err?: any) => void) => unknown;
  }
  const run = (handler: ReturnType<typeof guard>, roles: string[]) =>
    new Promise<any>((resolve) => { void handler({ user: { userId: 'u', tenantId: T, roles } }, {}, resolve); });

  it('only a Hospital Admin can change escalation settings', async () => {
    const handler = guard('put', '/sla-escalation-settings');
    expect(await run(handler, ['insurance_staff'])).toMatchObject({ statusCode: 403 });
    expect(await run(handler, ['admin'])).toBeUndefined();
  });

  it('closing needs insurance:approve', async () => {
    const handler = guard('patch', '/pre-auth/:id/close-stale');
    vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue(null as never);
    expect(await run(handler, ['front_desk'])).toMatchObject({ statusCode: 403, message: 'Missing permission: insurance:approve' });
    vi.mocked(prisma.rolePermission.findFirst).mockResolvedValueOnce({ id: 'rp' } as never);
    expect(await run(handler, ['insurance_staff'])).toBeUndefined();
  });

  it('closing a payer query needs insurance:approve too', async () => {
    const handler = guard('patch', '/claim-queries/:queryId/close-stale');
    vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue(null as never);
    expect(await run(handler, ['front_desk'])).toMatchObject({ statusCode: 403, message: 'Missing permission: insurance:approve' });
  });
});
