import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { mergePayers, previewPayerMerge } from '../../../../src/modules/insurance/insurance.merge.service';
import { updateInsurer, deleteInsurer } from '../../../../src/modules/insurance/insurance.service';
import { insuranceRoutes } from '../../../../src/modules/insurance/insurance.routes';

// Gap 293 criteria 2-3: merge duplicates, move every reference, audit it.

const T = 'tenant-1';
const ADMIN = { userId: 'admin-1', roles: ['admin'] };
const DUP = { id: 'ins-dup', tenantId: T, name: 'M5 Insurer A.', gstin: null, isActive: true, mergedIntoId: null };
const KEEP = { id: 'ins-keep', tenantId: T, name: 'M5 Insurer A', gstin: '27AAPFU0939F1ZV', isActive: true, mergedIntoId: null };

/** findFirst that honours id AND tenant, like the real query. */
function payerTable(rows: Array<typeof DUP>) {
  return (async (args: any) =>
    rows.find((r) => r.id === args.where.id && r.tenantId === args.where.tenantId) ?? null) as never;
}

/**
 * A transaction double with real commit/rollback semantics: writes made
 * through `tx` are staged and only become `committed` if the callback
 * resolves. Reads go to the normal mocks.
 */
function transactionalDb(failOn?: string) {
  const committed: Array<{ op: string; args: any }> = [];
  vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: (tx: unknown) => Promise<unknown>) => {
    const staged: Array<{ op: string; args: any }> = [];
    const tx = new Proxy({}, {
      get: (_t, model: string) => {
        if (model === '$queryRaw') return async () => [];
        return new Proxy({}, {
          get: (_m, method: string) => async (args: any) => {
            const op = `${model}.${method}`;
            if (/^(update|create|delete|upsert)/.test(method)) {
              if (op === failOn) throw new Error(`${op} failed`);
              staged.push({ op, args });
              return method.endsWith('Many') ? { count: 1 } : {};
            }
            return (prisma as any)[model][method](args);
          },
        });
      },
    });
    const out = await fn(tx);
    committed.push(...staged);
    return out;
  }) as never);
  return committed;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.insurer.findFirst).mockImplementation(payerTable([DUP, KEEP]));
  vi.mocked(prisma.tpaProvider.findFirst).mockImplementation(payerTable([
    { ...DUP, id: 'tpa-dup', name: 'MediAssist ' },
    { ...KEEP, id: 'tpa-keep', name: 'MediAssist' },
  ]));
  vi.mocked(prisma.insurancePolicy.count).mockResolvedValue(4 as never);
  vi.mocked(prisma.insuranceCase.count).mockResolvedValue(2 as never);
  vi.mocked(prisma.payerContract.count).mockResolvedValue(1 as never);
  vi.mocked(prisma.insuranceClaim.count).mockResolvedValue(3 as never);
  vi.mocked(prisma.preAuthorizationRequest.count).mockResolvedValue(2 as never);
  vi.mocked(prisma.claimSettlement.count).mockResolvedValue(1 as never);
  vi.mocked(prisma.tpaCommunicationLog.count).mockResolvedValue(5 as never);
  vi.mocked(prisma.payerContract.findMany).mockResolvedValue([] as never);
});

describe('merging a duplicate insurer (gap 293)', () => {
  it('re-points every reference to the kept record, deactivates the duplicate and audits it in one transaction', async () => {
    const committed = transactionalDb();
    const result = await mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id);

    const ops = committed.map((c) => c.op);
    const find = (op: string, pred: (a: any) => boolean = () => true) => committed.find((c) => c.op === op && pred(c.args))?.args;

    expect(find('insurancePolicy.updateMany')).toEqual({ where: { tenantId: T, insurerId: DUP.id }, data: { insurerId: KEEP.id } });
    expect(find('insuranceCase.updateMany', (a) => 'insurerId' in a.where)).toEqual({ where: { tenantId: T, insurerId: DUP.id }, data: { insurerId: KEEP.id } });
    expect(find('insuranceCase.updateMany', (a) => 'paymentResponsibleId' in a.where)).toEqual({
      where: { tenantId: T, paymentResponsibleType: 'insurer', paymentResponsibleId: DUP.id },
      data: { paymentResponsibleId: KEEP.id },
    });
    expect(find('insuranceCase.updateMany', (a) => 'claimAdministratorId' in a.where)).toEqual({
      where: { tenantId: T, claimAdministratorType: 'insurer', claimAdministratorId: DUP.id },
      data: { claimAdministratorId: KEEP.id },
    });
    expect(find('payerContract.updateMany')).toEqual({
      where: { tenantId: T, payerType: 'insurer', payerId: DUP.id },
      data: { payerId: KEEP.id },
    });

    // Deactivated, stamped, never deleted.
    expect(find('insurer.updateMany')).toMatchObject({
      where: { id: DUP.id, tenantId: T, mergedIntoId: null },
      data: { isActive: false, mergedIntoId: KEEP.id },
    });
    expect(ops.some((op) => op.endsWith('.delete') || op.endsWith('.deleteMany'))).toBe(false);

    // Audit: both ids and names, who, when, counts — on both records.
    const audit = find('auditLog.createMany');
    expect(audit.data).toHaveLength(2);
    expect(audit.data.map((r: any) => r.entityId).sort()).toEqual([DUP.id, KEEP.id].sort());
    expect(audit.data[0]).toMatchObject({ tenantId: T, userId: ADMIN.userId, entityType: 'insurer', action: 'update' });
    expect(audit.data[0].newValues).toMatchObject({
      event: 'payer.merged',
      duplicate: { id: DUP.id, name: DUP.name },
      kept: { id: KEEP.id, name: KEEP.name },
      mergedBy: ADMIN.userId,
      moved: { policies: 1, cases: 2, claims: 3, preAuths: 2, settlements: 1 },
    });
    expect(audit.data[0].newValues.mergedAt).toEqual(expect.any(String));

    expect(result).toMatchObject({ kept: { id: KEEP.id }, duplicate: { id: DUP.id, isActive: false, mergedIntoId: KEEP.id } });
    // Nothing was written outside the transaction.
    expect(prisma.insurancePolicy.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('deactivates a moved contract that overlaps an active contract of the kept record', async () => {
    vi.mocked(prisma.payerContract.findMany).mockImplementation((async (args: any) =>
      args.where.payerId === DUP.id
        ? [{ id: 'c-dup', name: 'Dup 2026', contractNumber: null, validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), isActive: true },
           { id: 'c-old', name: 'Dup 2024', contractNumber: null, validFrom: new Date('2024-01-01'), validTo: new Date('2024-12-31'), isActive: true }]
        : [{ id: 'c-keep', name: 'Keep 2026', contractNumber: null, validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31'), isActive: true }]) as never);
    const committed = transactionalDb();

    const result = await mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id);

    const collision = committed.find((c) => c.op === 'payerContract.updateMany' && c.args.where.id)?.args;
    expect(collision).toEqual({ where: { tenantId: T, id: { in: ['c-dup'] } }, data: { payerId: KEEP.id, isActive: false } });
    expect(result.deactivatedContractIds).toEqual(['c-dup']);
    expect(result.moved.contractsDeactivated).toBe(1);
  });

  it('rolls everything back when a step fails — nothing is partially moved', async () => {
    const committed = transactionalDb('payerContract.updateMany');

    await expect(mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id)).rejects.toThrow('payerContract.updateMany failed');

    expect(committed).toEqual([]);
    expect(prisma.insurancePolicy.updateMany).not.toHaveBeenCalled();
    expect(prisma.insurer.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('fails (and rolls back) when the audit row cannot be written', async () => {
    const committed = transactionalDb('auditLog.createMany');
    await expect(mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id)).rejects.toThrow();
    expect(committed).toEqual([]);
  });

  it('refuses a non-admin before touching the database', async () => {
    await expect(mergePayers('insurer', T, { userId: 'u2', roles: ['insurance_staff'] }, DUP.id, KEEP.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a record from another hospital', async () => {
    vi.mocked(prisma.insurer.findFirst).mockImplementation(payerTable([DUP, { ...KEEP, tenantId: 'tenant-2' }]));
    transactionalDb();
    await expect(mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.insurancePolicy.updateMany).not.toHaveBeenCalled();
  });

  it('refuses merging into itself or into an inactive record', async () => {
    transactionalDb();
    await expect(mergePayers('insurer', T, ADMIN, KEEP.id, KEEP.id)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(prisma.insurer.findFirst).mockImplementation(payerTable([DUP, { ...KEEP, isActive: false }]));
    transactionalDb();
    await expect(mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id)).rejects.toThrow(/inactive/);
  });

  it('refuses a duplicate that was already merged', async () => {
    vi.mocked(prisma.insurer.findFirst).mockImplementation(payerTable([{ ...DUP, isActive: false, mergedIntoId: 'other' } as never, KEEP]));
    transactionalDb();
    await expect(mergePayers('insurer', T, ADMIN, DUP.id, KEEP.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('merging a duplicate TPA (gap 293)', () => {
  it('also moves the communication logs and tpa links', async () => {
    const committed = transactionalDb();
    const result = await mergePayers('tpa', T, ADMIN, 'tpa-dup', 'tpa-keep');
    const ops = committed.map((c) => c.op);
    expect(committed.find((c) => c.op === 'tpaCommunicationLog.updateMany')?.args).toEqual({ where: { tenantId: T, tpaId: 'tpa-dup' }, data: { tpaId: 'tpa-keep' } });
    expect(committed.find((c) => c.op === 'insurancePolicy.updateMany')?.args).toEqual({ where: { tenantId: T, tpaId: 'tpa-dup' }, data: { tpaId: 'tpa-keep' } });
    expect(ops).toContain('tpaProvider.updateMany');
    expect(committed.find((c) => c.op === 'auditLog.createMany')?.args.data[0].entityType).toBe('tpa_provider');
    expect(result.moved.communicationLogs).toBe(1);
  });
});

describe('merge preview (gap 293)', () => {
  it('shows what will move without writing anything', async () => {
    const preview = await previewPayerMerge('insurer', T, DUP.id, KEEP.id);
    expect(preview.counts).toMatchObject({ policies: 4, cases: 2, contracts: 1, claims: 3, preAuths: 2, settlements: 1, contractsDeactivated: 0 });
    expect(preview.keep).toMatchObject({ id: KEEP.id, name: KEEP.name });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('a merged record stays merged (gap 293)', () => {
  it('cannot be reactivated or deleted', async () => {
    vi.mocked(prisma.insurer.findFirst).mockResolvedValue({ ...DUP, isActive: false, mergedIntoId: KEEP.id, insurancePolicies: [] } as never);
    await expect(updateInsurer(T, DUP.id, { isActive: true } as never)).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteInsurer(T, DUP.id)).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.insurer.delete).not.toHaveBeenCalled();
  });
});

describe('merge routes are Hospital Admin only (gap 293)', () => {
  function guard(method: string, path: string) {
    const layer = (insuranceRoutes as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    expect(layer).toBeDefined();
    // [authenticate, role guard, validate, handler]
    return layer.route.stack[1].handle as (req: any, res: any, next: (err?: any) => void) => void;
  }
  const run = (handler: ReturnType<typeof guard>, roles: string[]) =>
    new Promise<any>((resolve) => handler({ user: { userId: 'u', tenantId: T, roles } }, {}, resolve));

  it.each([
    ['post', '/insurers/:id/merge'],
    ['get', '/insurers/:id/merge-preview'],
    ['post', '/tpa/:id/merge'],
    ['get', '/tpa/:id/merge-preview'],
  ])('%s %s denies insurance staff and allows admin', async (method, path) => {
    const handler = guard(method, path);
    expect(await run(handler, ['insurance_staff'])).toMatchObject({ statusCode: 403 });
    expect(await run(handler, ['admin'])).toBeUndefined();
  });
});
