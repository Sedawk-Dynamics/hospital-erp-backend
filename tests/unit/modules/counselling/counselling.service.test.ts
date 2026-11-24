import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { prisma } from '../../../../src/config/database';
import * as service from '../../../../src/modules/counselling/counselling.service';
import { counsellingRoutes } from '../../../../src/modules/counselling/counselling.routes';
import { createCounsellingSessionSchema } from '../../../../src/modules/counselling/counselling.validation';
import { errorHandler } from '../../../../src/middleware/errorHandler';
import { getRolePermissions } from '../../../../src/shared/role-permissions';

// Gap #200: Counsellor Home listed an ordinary doctor OP follow-up as a
// counselling session. Gap #298: New Session opened New Appointment. These pin
// the counselling module that replaced both.

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PATIENT = '44444444-4444-4444-8444-444444444444';
const COUNSELLOR = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';

const m = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const validBody = {
  patientId: PATIENT,
  counsellorId: COUNSELLOR,
  sessionType: 'pre_admission_financial',
  scheduledAt: '2026-11-20T10:30:00.000+05:30',
  notes: 'Discuss package estimate',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSession', () => {
  beforeEach(() => {
    m.patient.findFirst.mockResolvedValue({ id: PATIENT, firstName: 'Ravi', lastName: 'Kumar', mrn: 'MRN-1' });
    m.user.findFirst.mockResolvedValue({ id: COUNSELLOR });
    m.counsellingSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: SESSION,
      ...data,
    }));
  });

  it('starts every new session as pending', async () => {
    const input = createCounsellingSessionSchema.parse({ body: validBody }).body;
    const s = await service.createSession(TENANT, USER, input);

    const { data } = m.counsellingSession.create.mock.calls[0][0];
    expect(data.status).toBe('pending');
    expect(data.kind).toBe('session');
    expect(data.tenantId).toBe(TENANT);
    expect(data.createdById).toBe(USER);
    expect(data.counsellorId).toBe(COUNSELLOR);
    expect(s.status).toBe('pending');
  });

  it('writes an audit row for the booking', async () => {
    const input = createCounsellingSessionSchema.parse({ body: validBody }).body;
    await service.createSession(TENANT, USER, input);
    await vi.waitFor(() => expect(m.auditLog.create).toHaveBeenCalled());
    const { data } = m.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({ tenantId: TENANT, action: 'create', entityType: 'counselling_session', entityId: SESSION });
  });

  it('refuses a patient from another hospital (tenant isolation)', async () => {
    m.patient.findFirst.mockResolvedValue(null);
    const input = createCounsellingSessionSchema.parse({ body: validBody }).body;

    await expect(service.createSession(TENANT, USER, input)).rejects.toMatchObject({
      statusCode: 400,
      details: { field: 'patientId' },
    });
    // The lookup itself is scoped to the caller's tenant.
    expect(m.patient.findFirst.mock.calls[0][0].where).toMatchObject({ id: PATIENT, tenantId: TENANT });
    expect(m.counsellingSession.create).not.toHaveBeenCalled();
  });

  it('refuses a counsellor who is not an active counsellor/admin of this hospital', async () => {
    m.user.findFirst.mockResolvedValue(null);
    const input = createCounsellingSessionSchema.parse({ body: validBody }).body;

    await expect(service.createSession(TENANT, USER, input)).rejects.toMatchObject({
      statusCode: 400,
      details: { field: 'counsellorId' },
    });
    const where = JSON.stringify(m.user.findFirst.mock.calls[0][0].where);
    expect(where).toContain('"isActive":true');
    expect(where).toContain('"counsellor"');
    expect(where).toContain(TENANT);
    expect(m.counsellingSession.create).not.toHaveBeenCalled();
  });

  it('records referral provenance only for a referral', async () => {
    const input = createCounsellingSessionSchema.parse({
      body: { ...validBody, kind: 'referral', referralSource: 'Dr. Mehta, Cardiology' },
    }).body;
    await service.createSession(TENANT, USER, input);
    const { data } = m.counsellingSession.create.mock.calls[0][0];
    expect(data.kind).toBe('referral');
    expect(data.referralSource).toBe('Dr. Mehta, Cardiology');
    expect(data.status).toBe('pending');
  });
});

describe('create validation', () => {
  const parse = (body: Record<string, unknown>) => createCounsellingSessionSchema.safeParse({ body });
  const fields = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.errors.map((e) => e.path.join('.')));

  it('accepts a complete session', () => {
    expect(parse(validBody).success).toBe(true);
  });

  it('requires patient, counsellor, session type and date-time', () => {
    const r = parse({});
    expect(fields(r)).toEqual(
      expect.arrayContaining(['body.patientId', 'body.counsellorId', 'body.sessionType', 'body.scheduledAt']),
    );
  });

  it('rejects a session type outside the list', () => {
    expect(fields(parse({ ...validBody, sessionType: 'consultation' }))).toContain('body.sessionType');
  });

  it('rejects an unparseable date-time', () => {
    expect(fields(parse({ ...validBody, scheduledAt: 'tomorrow-ish' }))).toContain('body.scheduledAt');
  });

  it('asks who referred a referral', () => {
    expect(fields(parse({ ...validBody, kind: 'referral' }))).toContain('body.referralSource');
  });
});

describe('stats use the same filter as the list', () => {
  const filter = { date: '2026-11-20', search: 'ravi', counsellorId: COUNSELLOR };

  it('passes the identical where to the list, its count and the stats', async () => {
    m.counsellingSession.findMany.mockResolvedValue([]);
    m.counsellingSession.count.mockResolvedValue(3);
    m.counsellingSession.groupBy.mockResolvedValue([
      { status: 'pending', _count: { _all: 1 } },
      { status: 'in_progress', _count: { _all: 1 } },
      { status: 'completed', _count: { _all: 1 } },
    ]);

    const list = await service.listSessions(TENANT, { ...filter, page: 1, limit: 20 });
    const stats = await service.getStats(TENANT, filter);

    const listWhere = m.counsellingSession.findMany.mock.calls[0][0].where;
    expect(m.counsellingSession.count.mock.calls[0][0].where).toEqual(listWhere);
    expect(m.counsellingSession.groupBy.mock.calls[0][0].where).toEqual(listWhere);

    expect(stats).toEqual({ total: 3, pending: 1, in_progress: 1, completed: 1, cancelled: 0, no_show: 0 });
    expect(stats.total).toBe(list.total);
  });

  it('scopes to the tenant and the IST day', () => {
    const where = service.buildCounsellingWhere(TENANT, { date: '2026-11-20' });
    expect(where.tenantId).toBe(TENANT);
    expect(where.scheduledAt).toEqual({
      gte: new Date('2026-11-20T00:00:00.000+05:30'),
      lte: new Date('2026-11-20T23:59:59.999+05:30'),
    });
  });

  it('never reads visits — eligibility is a counselling row (gap #200)', async () => {
    await service.listSessions(TENANT, { date: '2026-11-20', page: 1, limit: 20 });
    await service.getStats(TENANT, { date: '2026-11-20' });
    expect(m.visit.findMany).not.toHaveBeenCalled();
    expect(m.visit.count).not.toHaveBeenCalled();
  });
});

describe('status changes', () => {
  it('moves pending → in_progress and audits it', async () => {
    m.counsellingSession.findFirst
      .mockResolvedValueOnce({ id: SESSION, status: 'pending' })
      .mockResolvedValueOnce({ id: SESSION, status: 'in_progress' });
    m.counsellingSession.updateMany.mockResolvedValue({ count: 1 });

    const s = await service.updateStatus(TENANT, USER, SESSION, { status: 'in_progress' });
    expect(s.status).toBe('in_progress');
    const call = m.counsellingSession.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: SESSION, tenantId: TENANT, status: 'pending' });
    expect(call.data.status).toBe('in_progress');
    expect(call.data.startedAt).toBeInstanceOf(Date);
    await vi.waitFor(() => expect(m.auditLog.create).toHaveBeenCalled());
  });

  it('refuses to complete a session that never started', async () => {
    m.counsellingSession.findFirst.mockResolvedValue({ id: SESSION, status: 'pending' });
    await expect(service.updateStatus(TENANT, USER, SESSION, { status: 'completed' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(m.counsellingSession.updateMany).not.toHaveBeenCalled();
  });

  it("cannot touch another hospital's session", async () => {
    m.counsellingSession.findFirst.mockResolvedValue(null);
    await expect(service.updateStatus(OTHER_TENANT, USER, SESSION, { status: 'in_progress' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(m.counsellingSession.findFirst.mock.calls[0][0].where).toEqual({ id: SESSION, tenantId: OTHER_TENANT });
  });
});

describe('who may use counselling', () => {
  const matrix = getRolePermissions();
  const has = (role: string, action: string) =>
    (matrix[role] ?? []).some((p) => p.module === 'counselling' && p.action === action);

  it('grants counsellor, admin and super_admin read/create/update', () => {
    for (const role of ['counsellor', 'admin', 'super_admin']) {
      for (const action of ['read', 'create', 'update']) expect(has(role, action), `${role}:${action}`).toBe(true);
    }
  });

  it('grants no other role any counselling action', () => {
    for (const [role, perms] of Object.entries(matrix)) {
      if (['counsellor', 'admin', 'super_admin'].includes(role)) continue;
      expect(perms.some((p) => p.module === 'counselling'), role).toBe(false);
    }
  });

  // Direct API call by a role without the grant — e.g. Front Desk, which holds
  // appointments:create and used to reach New Session through it (#298).
  function appAs(roles: string[], tenantId = TENANT) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { userId: USER, tenantId, email: 'x@y.z', roles };
      next();
    });
    app.use('/counselling', counsellingRoutes);
    app.use(errorHandler);
    return app;
  }

  it('returns 403 to a non-counsellor role on every endpoint', async () => {
    m.rolePermission.findFirst.mockResolvedValue(null);
    const app = appAs(['front_desk']);
    const calls = [
      request(app).get('/counselling/sessions?date=2026-11-20'),
      request(app).get('/counselling/sessions/stats?date=2026-11-20'),
      request(app).get('/counselling/counsellors'),
      request(app).post('/counselling/sessions').send(validBody),
      request(app).patch(`/counselling/sessions/${SESSION}/status`).send({ status: 'in_progress' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    expect(m.counsellingSession.create).not.toHaveBeenCalled();
  });

  it('lets a permitted role through and scopes the query to its tenant', async () => {
    m.rolePermission.findFirst.mockResolvedValue({ id: 'rp' });
    m.counsellingSession.findMany.mockResolvedValue([]);
    m.counsellingSession.count.mockResolvedValue(0);
    const res = await request(appAs(['counsellor'])).get('/counselling/sessions?date=2026-11-20');
    expect(res.status).toBe(200);
    expect(m.counsellingSession.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT);
  });

  it('returns field errors for an invalid create', async () => {
    m.rolePermission.findFirst.mockResolvedValue({ id: 'rp' });
    const res = await request(appAs(['counsellor'])).post('/counselling/sessions').send({ patientId: PATIENT });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(['body.counsellorId', 'body.sessionType', 'body.scheduledAt']),
    );
    expect(m.counsellingSession.create).not.toHaveBeenCalled();
  });
});
