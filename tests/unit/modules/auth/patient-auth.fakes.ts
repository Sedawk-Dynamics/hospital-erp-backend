import { vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { redis } from '../../../../src/config/redis';
import { logger } from '../../../../src/config/logger';

// In-memory Redis and just enough of the users / patients / devices tables for
// the patient sign-in tests. Phone numbers are made up.

type Fn = ReturnType<typeof vi.fn>;
type Row = Record<string, any>;

export const store = new Map<string, { v: string; exp?: number }>();

function live(key: string) {
  const e = store.get(key);
  if (e && e.exp !== undefined && e.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return e;
}

export function installFakeRedis() {
  store.clear();
  const r = redis as unknown as Record<string, Fn>;
  r.get.mockImplementation(async (k: string) => live(k)?.v ?? null);
  r.set.mockImplementation(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && live(k)) return null;
    const i = args.indexOf('EX');
    store.set(k, { v, exp: i >= 0 ? Date.now() + Number(args[i + 1]) * 1000 : undefined });
    return 'OK';
  });
  r.del.mockImplementation(async (...keys: string[]) => keys.filter((k) => store.delete(k)).length);
  r.incr.mockImplementation(async (k: string) => {
    const e = live(k);
    const n = (e ? Number(e.v) : 0) + 1;
    store.set(k, { v: String(n), exp: e?.exp });
    return n;
  });
  r.expire.mockImplementation(async (k: string, s: number) => {
    const e = live(k);
    if (!e) return 0;
    e.exp = Date.now() + s * 1000;
    return 1;
  });
}

export const db = { users: [] as Row[], patients: [] as Row[], devices: [] as Row[], owners: [] as Row[], audits: [] as Row[], loginAudits: [] as Row[] };

const PLATFORM = { id: 't-platform', name: 'Platform', slug: '__platform__', isActive: true };
const HOSPITAL = { id: 't-hosp', name: 'Green City', slug: 'green-city', isActive: true };
export const tenants = { PLATFORM, HOSPITAL };

let seq = 0;
export function addUser(over: Row & { roles: string[] }): Row {
  const { roles, ...rest } = over;
  const n = ++seq;
  const row = {
    id: `user-${n}`,
    email: `person${n}@example.com`,
    firstName: 'Asha',
    lastName: null,
    phone: null,
    tenant: PLATFORM,
    isActive: true,
    is2faEnabled: false,
    twoFaSecret: null,
    passwordHash: 'x',
    doctorProfile: null,
    staffProfile: null,
    createdAt: new Date(2026, 0, n),
    ...rest,
    userRoles: roles.map((name) => ({ role: { id: `role-${name}`, name } })),
  } as Row;
  row.tenantId = row.tenant.id;
  db.users.push(row);
  return row;
}

export function addPatient(over: Row): Row {
  const row = { id: `pat-${++seq}`, userId: null, firstName: 'Asha', lastName: 'Rao', phone: null, isActive: true, dateOfBirth: null, tenantId: HOSPITAL.id, createdAt: new Date(2026, 0, seq), ...over } as Row;
  db.patients.push(row);
  return row;
}

/** The subset of Prisma `where` these services use. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    const v = row[k];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return v === cond;
    if ('endsWith' in cond) return typeof v === 'string' && v.endsWith(cond.endsWith);
    if ('equals' in cond) return String(v).toLowerCase() === String(cond.equals).toLowerCase();
    if ('in' in cond) return cond.in.includes(v);
    if ('not' in cond || 'notIn' in cond) {
      return (!('not' in cond) || v !== cond.not) && (!('notIn' in cond) || !cond.notIn.includes(v));
    }
    if ('lt' in cond) return v < cond.lt;
    if ('gte' in cond) return v >= cond.gte;
    if (k === 'tenant') return matches(v, cond);
    throw new Error(`unsupported where: ${k} ${JSON.stringify(cond)}`);
  });
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
  }
}

const model = (name: string) => (prisma as unknown as Record<string, Record<string, Fn>>)[name];

export function installFakeDb() {
  db.users = [];
  db.patients = [];
  db.devices = [];
  db.owners = [];
  db.audits = [];
  db.loginAudits = [];
  const table = (name: string, key: 'users' | 'patients' | 'devices' | 'owners') => {
    const m = model(name);
    const sorted = (where?: Row) =>
      db[key].filter((r) => matches(r, where)).sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    // Snapshots, as Prisma returns: a caller must not see later writes.
    m.findMany.mockImplementation(async (a: Row = {}) => sorted(a.where).map((r) => ({ ...r })));
    m.findFirst.mockImplementation(async (a: Row = {}) => { const r = sorted(a.where)[0]; return r ? { ...r } : null; });
    m.findUnique.mockImplementation(async (a: Row) => { const r = db[key].find((x) => matches(x, a.where)); return r ? { ...r } : null; });
    m.updateMany.mockImplementation(async (a: Row) => {
      const rows = db[key].filter((r) => matches(r, a.where));
      rows.forEach((r) => apply(r, a.data));
      return { count: rows.length };
    });
    m.update.mockImplementation(async (a: Row) => {
      const r = db[key].find((x) => matches(x, a.where));
      if (!r) throw new Error('not found');
      apply(r, a.data);
      return { ...r };
    });
  };
  table('user', 'users');
  table('patient', 'patients');
  table('patientTrustedDevice', 'devices');
  table('tenantOwner', 'owners');
  model('user').create.mockImplementation(async (a: Row) => {
    const { userRoles, tenantId, ...rest } = a.data;
    const tenant = tenantId === HOSPITAL.id ? HOSPITAL : PLATFORM;
    const name = userRoles?.create?.roleId?.replace('role-', '');
    return addUser({ ...rest, tenant, roles: name ? [name] : [] });
  });
  model('patientTrustedDevice').create.mockImplementation(async (a: Row) => {
    db.devices.push({ failedAttempts: 0, lockedAt: null, revokedAt: null, revokedReason: null, createdAt: new Date(), ...a.data });
    return a.data;
  });
  model('tenant').findFirst.mockImplementation(async (a: Row) =>
    [PLATFORM, HOSPITAL].find((t) => t.slug === a.where.slug) ?? null);
  model('role').findFirst.mockResolvedValue({ id: 'role-patient', name: 'patient' });
  model('auditLog').create.mockImplementation(async (a: Row) => { db.audits.push(a.data); return a.data; });
  model('loginAuditLog').create.mockImplementation(async (a: Row) => { db.loginAudits.push(a.data); return a.data; });
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** Everything logged at any level, as text. */
export function loggedText(): string {
  const l = logger as unknown as Record<string, Fn>;
  return JSON.stringify(LEVELS.flatMap((x) => l[x].mock.calls));
}

/** The code the sandbox provider wrote to the console for the last send. */
export function sandboxCode(): string {
  const call = (logger as unknown as Record<string, Fn>).debug.mock.calls.at(-1);
  const code = call?.[0]?.code;
  if (!/^\d{6}$/.test(code ?? '')) throw new Error('no code in the sandbox log');
  return code;
}

export const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
