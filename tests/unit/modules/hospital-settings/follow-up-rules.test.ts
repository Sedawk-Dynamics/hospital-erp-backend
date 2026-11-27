import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import * as rules from '../../../../src/modules/hospital-settings/follow-up-rules.service';
import * as appointments from '../../../../src/modules/appointments/appointments.service';
import * as portal from '../../../../src/modules/patient-portal/patient-portal.service';
import { getPatientCharges } from '../../../../src/modules/billing/billing.service';
import { followUpRulesRoutes } from '../../../../src/modules/hospital-settings/follow-up-rules.routes';

// Gap #331 / #019: one resolver prices every consultation, under rules only the
// hospital admin can set.

vi.mock('../../../../src/modules/billing/billing.service', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  issueDocumentForExistingBill: vi.fn(async () => null),
}));
vi.mock('../../../../src/modules/gst/gst-resolver.service', () => ({
  taxResolverFor: vi.fn(async () => ({
    price: (_s: unknown, m: { unitPrice: number; quantity: number }) => ({
      money: { taxableValue: m.unitPrice * m.quantity, taxAmount: 0, totalAmount: m.unitPrice * m.quantity },
    }),
  })),
  billItemTaxFields: (t: { money: { totalAmount: number } }) => ({ totalAmount: t.money.totalAmount }),
}));

const T = 'tenant-1';
const DAY = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

type Row = Record<string, any>;
let db: {
  rules: Row[]; doctors: Row[]; departments: Row[]; appointments: Row[]; visits: Row[];
  admissions: Row[]; bills: Row[]; snapshots: Row[]; users: Row[]; owners: Row[]; audits: Row[];
};

const doctorOf = (id: string) => db.doctors.find((d) => d.id === id);

/** Enough of Prisma's filters for the queries under test. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'NOT') return !matches(row, cond as Row);
    if (key === 'doctor') return matches(doctorOf(row.doctorId) ?? {}, cond as Row);
    if (key === 'user') return matches(db.users.find((u) => u.id === row.userId) ?? {}, cond as Row);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return (value ?? null) === cond;
    const c = cond as Row;
    if ('in' in c && !c.in.includes(value)) return false;
    if ('notIn' in c && c.notIn.includes(value)) return false;
    if ('not' in c && (value ?? null) === c.not) return false;
    if ('lte' in c && !(value && value.getTime() <= c.lte.getTime())) return false;
    if ('gte' in c && !(value && value.getTime() >= c.gte.getTime())) return false;
    if ('equals' in c && String(value).toLowerCase() !== String(c.equals).toLowerCase()) return false;
    return true;
  });
}
const latest = (rows: Row[], key: string) => [...rows].sort((a, b) => b[key].getTime() - a[key].getTime())[0] ?? null;

function paidLines(where: Row) {
  return db.bills
    .filter((b) => b.patientId === where.bill.patientId && b.tenantId === where.bill.tenantId)
    .filter((b) => matches(b, { status: where.bill.status }))
    .flatMap((b) => b.items);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    rules: [], appointments: [], visits: [], admissions: [], bills: [], snapshots: [], audits: [], owners: [],
    users: [{ id: 'admin-1', tenantId: T, email: 'admin@h.in' }, { id: 'other-admin', tenantId: 'tenant-2', email: 'x@y.in' }],
    departments: [{ id: 'dept-1', tenantId: T, name: 'Cardiology', isActive: true }, { id: 'dept-x', tenantId: 'tenant-2', name: 'X', isActive: true }],
    doctors: [
      { id: 'doc-1', tenantId: T, departmentId: 'dept-1', consultationFee: 500, freeFollowUpDays: null, isAvailable: true, user: { firstName: 'Asha', lastName: 'Rao' } },
      { id: 'doc-2', tenantId: T, departmentId: 'dept-1', consultationFee: 800, freeFollowUpDays: null, isAvailable: true, user: { firstName: 'Ravi', lastName: 'K' } },
      { id: 'doc-x', tenantId: 'tenant-2', departmentId: 'dept-x', consultationFee: 900, freeFollowUpDays: null, isAvailable: true, user: { firstName: 'X', lastName: 'Y' } },
    ],
  };
  const m = prisma as any;
  m.followUpFeeRule.findMany.mockImplementation(async ({ where }: Row) => db.rules.filter((r) => matches(r, where)));
  m.followUpFeeRule.upsert.mockImplementation(async ({ where, update, create }: Row) => {
    const k = where.tenantId_level_targetId;
    const row = db.rules.find((r) => matches(r, k));
    if (row) return Object.assign(row, update);
    db.rules.push({ ...create, createdAt: new Date() });
  });
  m.followUpFeeRule.deleteMany.mockImplementation(async ({ where }: Row) => {
    db.rules = db.rules.filter((r) => !matches(r, where));
    return { count: 1 };
  });
  m.doctorProfile.findFirst.mockImplementation(async ({ where }: Row) => db.doctors.find((d) => matches(d, where)) ?? null);
  m.doctorProfile.findMany.mockImplementation(async ({ where }: Row) => db.doctors.filter((d) => matches(d, where)));
  m.doctorProfile.update.mockImplementation(async ({ where, data }: Row) => Object.assign(doctorOf(where.id)!, data));
  m.department.findFirst.mockImplementation(async ({ where }: Row) => db.departments.find((d) => matches(d, where)) ?? null);
  m.department.findMany.mockImplementation(async ({ where }: Row) => db.departments.filter((d) => matches(d, where)));
  m.appointment.findFirst.mockImplementation(async ({ where, include }: Row) => {
    const row = latest(db.appointments.filter((a) => matches(a, where)), 'appointmentDate');
    return row && include?.doctor ? { ...row, doctor: doctorOf(row.doctorId) } : row;
  });
  m.appointment.findUnique.mockImplementation(async ({ where }: Row) => db.appointments.find((a) => a.id === where.id) ?? null);
  m.appointment.findMany.mockResolvedValue([]);
  m.appointment.count.mockResolvedValue(1);
  m.appointment.update.mockResolvedValue({});
  m.visit.findFirst.mockImplementation(async ({ where }: Row) => latest(db.visits.filter((v) => matches(v, where)), 'visitDate'));
  m.visit.findMany.mockResolvedValue([]);
  m.visit.count.mockResolvedValue(1);
  m.admission.findFirst.mockImplementation(async ({ where }: Row) => latest(db.admissions.filter((a) => matches(a, where)), 'dischargeDate'));
  m.admission.findMany.mockResolvedValue([]);
  m.admission.count.mockResolvedValue(0);
  m.patient.findFirst.mockResolvedValue({ id: 'pat-1' });
  m.tenant.findFirst.mockResolvedValue({ themeConfig: {} });
  m.billItem.findMany.mockImplementation(async ({ where }: Row) =>
    where?.bill ? paidLines(where).filter((i: Row) => where.totalAmount?.gt === undefined || i.totalAmount > where.totalAmount.gt) : []);
  m.billItem.findFirst.mockImplementation(async ({ where }: Row) =>
    where?.referenceType === 'appointment'
      ? (db.bills.flatMap((b) => b.items).find((i: Row) => i.referenceId === where.referenceId) ?? null)
      : null);
  m.bill.findFirst.mockImplementation(async ({ where }: Row) =>
    // The bill-number allocator looks bills up too; it starts a new series here.
    !where?.billItems ? null : db.bills.find(
      (b) =>
        (where.status === undefined || matches(b, { status: where.status })) &&
        b.items.some((i: Row) => i.referenceId === where.billItems.some.referenceId),
    ) ?? null);
  m.bill.create.mockImplementation(async ({ data }: Row) => {
    const bill = { ...data, id: `bill-${db.bills.length + 1}`, items: [].concat(data.billItems.create) };
    db.bills.push(bill);
    return bill;
  });
  m.bill.findUnique.mockResolvedValue(null);
  m.appointmentFeeSnapshot.findFirst.mockImplementation(async ({ where }: Row) => db.snapshots.find((s) => matches(s, where)) ?? null);
  m.appointmentFeeSnapshot.findMany.mockImplementation(async ({ where }: Row) => db.snapshots.filter((s) => matches(s, where)));
  m.appointmentFeeSnapshot.create.mockImplementation(async ({ data }: Row) => void db.snapshots.push(data));
  m.appointmentFeeSnapshot.upsert.mockImplementation(async ({ where, update, create }: Row) => {
    const row = db.snapshots.find((s) => matches(s, where));
    if (row) Object.assign(row, update);
    else db.snapshots.push(create);
  });
  m.user.findUnique.mockImplementation(async ({ where }: Row) => db.users.find((u) => matches(u, where)) ?? null);
  m.tenantOwner.findFirst.mockImplementation(async ({ where }: Row) => db.owners.find((o) => matches(o, where)) ?? null);
  m.auditLog.create.mockImplementation(async ({ data }: Row) => void db.audits.push(data));
});
afterEach(() => { vi.useRealTimers(); });

const ADMIN = { userId: 'admin-1', roles: ['admin'] };
const DESK = { userId: 'desk-1', roles: ['front_desk'] };
const HOSPITAL_RULE = { freeDays: 7, afterWindow: 'fixed', fixedFee: 300, scope: 'same_doctor', dischargeStartsWindow: false };
const INHERIT = { freeDays: null, afterWindow: null, fixedFee: null, scope: null, dischargeStartsWindow: null };

const setHospital = (over: Row = {}) => rules.saveHospitalRule(T, ADMIN, { ...HOSPITAL_RULE, ...over });

let seq = 0;
/** An earlier visit whose bill is in the given state. */
function earlier(date: string, over: { doctorId?: string; billStatus?: string; amount?: number; status?: string } = {}) {
  const id = `prev-${++seq}`;
  db.appointments.push({
    id, tenantId: T, patientId: 'pat-1', doctorId: over.doctorId ?? 'doc-1',
    appointmentDate: DAY(date), status: over.status ?? 'completed', createdAt: DAY(date),
  });
  db.bills.push({
    id: `b-${id}`, tenantId: T, patientId: 'pat-1', status: over.billStatus ?? 'paid',
    items: [{ referenceType: 'appointment', referenceId: id, totalAmount: over.amount ?? 500 }],
  });
  return id;
}
const quote = (date: string, over: Row = {}, opts?: any) =>
  rules.resolveConsultationFee(
    T,
    { patientId: 'pat-1', doctorId: 'doc-1', consultationType: 'follow_up', date, doctor: doctorOf(over.doctorId ?? 'doc-1') as any, ...over },
    opts,
  );

describe('follow-up rules: who may set them', () => {
  it.each([['front_desk'], ['doctor'], ['billing_admin'], ['cashier']])('refuses %s', async (role) => {
    const actor = { userId: 'admin-1', roles: [role] };
    await expect(rules.saveHospitalRule(T, actor, HOSPITAL_RULE)).rejects.toMatchObject({ statusCode: 403 });
    await expect(rules.saveDoctorRule(T, actor, 'doc-1', INHERIT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(rules.saveDepartmentRule(T, actor, 'dept-1', INHERIT)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.rules).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses an admin of another hospital naming this one', async () => {
    await expect(
      rules.saveHospitalRule(T, { userId: 'other-admin', roles: ['admin'] }, HOSPITAL_RULE),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows the hospital’s owner, whose account sits elsewhere, and a super admin', async () => {
    db.users.push({ id: 'owner-1', tenantId: 'platform', email: 'owner@h.in' });
    db.owners.push({ id: 'o1', tenantId: T, userId: 'owner-1' });
    await rules.saveHospitalRule(T, { userId: 'owner-1', roles: ['admin'] }, HOSPITAL_RULE);
    await rules.saveHospitalRule(T, { userId: 'root', roles: ['super_admin'] }, { ...HOSPITAL_RULE, freeDays: 5 });
    expect(db.rules[0].freeDays).toBe(5);
  });

  it('cannot reach another hospital’s doctor or department', async () => {
    await expect(rules.saveDoctorRule(T, ADMIN, 'doc-x', { ...INHERIT, freeDays: 3 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(rules.saveDepartmentRule(T, ADMIN, 'dept-x', { ...INHERIT, freeDays: 3 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('gates every write route to admin and super_admin', () => {
    const layers = (followUpRulesRoutes as any).stack.filter((l: any) => l.route);
    const writes = layers.filter((l: any) => l.route.methods.put || l.route.methods.delete);
    expect(writes).toHaveLength(6);
    for (const l of writes) {
      const guard = l.route.stack[1].handle;
      const next = vi.fn();
      guard({ user: { roles: ['front_desk'] } }, {}, next);
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
      const ok = vi.fn();
      guard({ user: { roles: ['admin'] } }, {}, ok);
      expect(ok).toHaveBeenCalledWith();
    }
  });

  it('ignores free days from a non-admin on the doctor profile but saves the rest', async () => {
    await appointments.updateDoctorProfile(T, 'doc-1', { bio: 'Hello', freeFollowUpDays: 30 }, DESK);
    expect(doctorOf('doc-1')).toMatchObject({ bio: 'Hello', freeFollowUpDays: null });
    await appointments.updateDoctorProfile(T, 'doc-1', { freeFollowUpDays: 30 });
    expect(doctorOf('doc-1')!.freeFollowUpDays).toBeNull();
    expect(db.audits).toHaveLength(0);
  });

  it('lets an admin set them there, within the limits, audited', async () => {
    await appointments.updateDoctorProfile(T, 'doc-1', { freeFollowUpDays: 10 }, ADMIN);
    expect(doctorOf('doc-1')!.freeFollowUpDays).toBe(10);
    expect(db.audits[0]).toMatchObject({ entityType: 'follow_up_rule', entityId: 'doc-1', userId: 'admin-1', newValues: expect.objectContaining({ freeDays: 10 }) });
    await expect(appointments.updateDoctorProfile(T, 'doc-1', { freeFollowUpDays: 400 }, ADMIN)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('leaves an old out-of-range window alone when it is sent back unchanged', async () => {
    doctorOf('doc-1')!.freeFollowUpDays = 120;
    await appointments.updateDoctorProfile(T, 'doc-1', { freeFollowUpDays: 120, bio: 'x' }, ADMIN);
    expect(db.rules).toHaveLength(0);
    expect(doctorOf('doc-1')).toMatchObject({ freeFollowUpDays: 120, bio: 'x' });
  });
});

describe('follow-up rules: audit', () => {
  it('records who changed what, old and new, and nothing for a no-op', async () => {
    await setHospital();
    await setHospital({ fixedFee: 350 });
    await setHospital({ fixedFee: 350 });
    expect(db.audits).toHaveLength(2);
    expect(db.audits[0]).toMatchObject({ action: 'create', tenantId: T, userId: 'admin-1' });
    expect(db.audits[1]).toMatchObject({
      action: 'update',
      oldValues: expect.objectContaining({ level: 'hospital', fixedFee: 300 }),
      newValues: expect.objectContaining({ level: 'hospital', fixedFee: 350 }),
    });
    await rules.saveHospitalRule(T, ADMIN, null);
    expect(db.audits[2]).toMatchObject({ action: 'delete', oldValues: expect.objectContaining({ fixedFee: 350 }) });
  });

  it('audits a doctor override being set and cleared', async () => {
    await rules.saveDoctorRule(T, ADMIN, 'doc-1', { ...INHERIT, freeDays: 3, afterWindow: 'fixed', fixedFee: 200 });
    expect(doctorOf('doc-1')!.freeFollowUpDays).toBe(3);
    await rules.saveDoctorRule(T, ADMIN, 'doc-1', null);
    expect(doctorOf('doc-1')!.freeFollowUpDays).toBeNull();
    expect(db.rules).toHaveLength(0);
    expect(db.audits.map((a) => a.action)).toEqual(['create', 'delete']);
    expect(db.audits[0].description).toContain('Dr. Asha Rao');
  });
});

describe('follow-up rules: what a visit costs', () => {
  it('uses the hospital default, day N free and day N+1 charged', async () => {
    await setHospital();
    earlier('2026-11-01');
    expect(await quote('2026-11-08')).toMatchObject({ fee: 0, isFreeFollowUp: true, label: 'Free follow-up, day 7 of 7' });
    expect(await quote('2026-11-09')).toMatchObject({ fee: 300, kind: 'paid_follow_up' });
  });

  it('lets the doctor’s override beat the default and inherit the rest', async () => {
    await setHospital();
    await rules.saveDoctorRule(T, ADMIN, 'doc-1', { ...INHERIT, freeDays: 3 });
    earlier('2026-11-01');
    expect(await quote('2026-11-04')).toMatchObject({ fee: 0 });
    expect(await quote('2026-11-05')).toMatchObject({ fee: 300 });
  });

  it('keeps an existing freeFollowUpDays as the override, and 0 as none', async () => {
    await setHospital();
    earlier('2026-11-01');
    doctorOf('doc-1')!.freeFollowUpDays = 20;
    expect(await quote('2026-11-21')).toMatchObject({ fee: 0, windowDays: 20 });
    doctorOf('doc-1')!.freeFollowUpDays = 0;
    expect(await quote('2026-11-02')).toMatchObject({ fee: 300, isFreeFollowUp: false });
  });

  it('applies a department default between the two', async () => {
    await setHospital();
    await rules.saveDepartmentRule(T, ADMIN, 'dept-1', { ...INHERIT, freeDays: 2 });
    earlier('2026-11-01');
    expect(await quote('2026-11-04')).toMatchObject({ fee: 300, windowDays: 2 });
  });

  it('charges the doctor’s own full fee after the window in full mode', async () => {
    await setHospital({ afterWindow: 'full', fixedFee: null });
    earlier('2026-11-01');
    expect(await quote('2026-11-09')).toMatchObject({ fee: 500, kind: 'paid_follow_up' });
  });

  it('keeps to the same doctor, or the department when the rule says so', async () => {
    await setHospital();
    earlier('2026-11-01', { doctorId: 'doc-2' });
    expect(await quote('2026-11-03')).toMatchObject({ fee: 500, kind: 'consultation' });
    await setHospital({ scope: 'same_department' });
    expect(await quote('2026-11-03')).toMatchObject({ fee: 0, dayNumber: 2 });
  });

  it('counts a discharge only when the rule says so, from its IST day', async () => {
    await setHospital();
    // 00:10 IST on 2 Nov, still 1 Nov in UTC.
    db.admissions.push({ id: 'adm', tenantId: T, patientId: 'pat-1', doctorId: 'doc-1', status: 'discharged', dischargeDate: new Date('2026-11-01T18:40:00.000Z') });
    expect(await quote('2026-11-09')).toMatchObject({ fee: 500, kind: 'consultation' });
    await setHospital({ dischargeStartsWindow: true });
    expect(await quote('2026-11-09')).toMatchObject({ fee: 0, dayNumber: 7, anchorKind: 'discharge' });
    expect(await quote('2026-11-10')).toMatchObject({ fee: 300, dayNumber: 8 });
  });

  it.each(['pending', 'partially_paid', 'refunded', 'cancelled'])('ignores an earlier visit whose bill is %s', async (billStatus) => {
    await setHospital();
    earlier('2026-11-01', { billStatus });
    const out = await quote('2026-11-03');
    expect(out).toMatchObject({ fee: 500, isFreeFollowUp: false });
    expect(out.label).toContain('no earlier paid visit');
  });

  it('looks past an unpaid visit to the last paid one', async () => {
    await setHospital();
    earlier('2026-11-01');
    earlier('2026-11-04', { billStatus: 'pending' });
    expect(await quote('2026-11-08')).toMatchObject({ fee: 0, dayNumber: 7 });
  });

  it('does not let a free follow-up restart the period', async () => {
    await setHospital();
    earlier('2026-11-01');
    earlier('2026-11-06', { amount: 0 }); // a waived visit: its ₹0 bill reads `paid`
    expect(await quote('2026-11-10')).toMatchObject({ fee: 300, dayNumber: 9 });
  });

  it('ignores a cancelled or later visit, and another patient’s', async () => {
    await setHospital();
    earlier('2026-11-01', { status: 'cancelled' });
    earlier('2026-11-20');
    expect(await quote('2026-11-03')).toMatchObject({ fee: 500, kind: 'consultation' });
    expect(await quote('2026-11-21', { patientId: 'pat-2' })).toMatchObject({ fee: 500 });
  });

  it('counts a consultation billed from the visit, with no appointment', async () => {
    await setHospital();
    db.visits.push({ id: 'v1', tenantId: T, patientId: 'pat-1', doctorId: 'doc-1', visitType: 'op', visitDate: new Date('2026-11-01T09:00:00.000Z') });
    db.bills.push({ id: 'bv', tenantId: T, patientId: 'pat-1', status: 'paid', items: [{ referenceType: 'visit', referenceId: 'v1', totalAmount: 500 }] });
    expect(await quote('2026-11-08')).toMatchObject({ fee: 0, dayNumber: 7 });
  });

  it('treats a brand-new patient booked as follow-up as a consultation', async () => {
    await setHospital();
    expect(await quote('2026-11-03', { patientId: null })).toMatchObject({ fee: 500, kind: 'consultation' });
  });

  it('counts to today in IST when no date is given, across the midnight edge', async () => {
    await setHospital();
    earlier('2026-11-01');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T18:29:00.000Z')); // 23:59 IST, 8 Nov
    expect(await quote(undefined as any)).toMatchObject({ dayNumber: 7, fee: 0 });
    vi.setSystemTime(new Date('2026-11-08T18:31:00.000Z')); // 00:01 IST, 9 Nov
    expect(await quote(undefined as any)).toMatchObject({ dayNumber: 8, fee: 300 });
  });

  it('never uses another hospital’s rule', async () => {
    db.rules.push({ tenantId: 'tenant-2', level: 'hospital', targetId: 'tenant-2', ...HOSPITAL_RULE });
    expect((await quote('2026-11-03')).governed).toBe(false);
  });
});

describe('follow-up rules: nothing configured', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T06:00:00.000Z'));
  });

  it('still waives whatever the desk declares a follow-up', async () => {
    expect(await quote('2026-11-05')).toMatchObject({ fee: 0, isFreeFollowUp: true, governed: false, label: null });
    expect(await quote('2026-11-05', { patientId: null })).toMatchObject({ fee: 0, isFreeFollowUp: true });
  });

  it('still honours a doctor’s own window, and only theirs', async () => {
    earlier('2026-11-01');
    const visit = { consultationType: 'consultation' };
    expect(await quote('2026-11-05', visit)).toMatchObject({ fee: 500, isFreeFollowUp: false });
    doctorOf('doc-1')!.freeFollowUpDays = 7;
    expect(await quote('2026-11-05', visit)).toMatchObject({ fee: 0, isFreeFollowUp: true, governed: false });
    doctorOf('doc-1')!.freeFollowUpDays = 0;
    expect(await quote('2026-11-05', visit)).toMatchObject({ fee: 500 });
  });

  it('still charges the plain fee where no window was ever applied', async () => {
    doctorOf('doc-1')!.freeFollowUpDays = 7;
    earlier('2026-11-01');
    expect(await quote('2026-11-05', {}, { ungoverned: 'list_fee' })).toMatchObject({ fee: 500, governed: false });
  });
});

describe('follow-up rules: preview, bill and snapshot agree', () => {
  function book(id: string, date: string, over: Row = {}) {
    db.appointments.push({
      id, tenantId: T, patientId: 'pat-1', doctorId: 'doc-1', consultationType: 'follow_up',
      appointmentDate: DAY(date), status: 'confirmed', createdAt: new Date(), ...over,
    });
  }
  const preview = (date: string, type = 'follow_up') =>
    appointments.getBookingChargePreview(T, { doctorId: 'doc-1', patientId: 'pat-1', type, date } as any);
  const checkout = (id: string) => appointments.frontdeskCheckout(T, id, 'desk-1', { collectNow: false } as any);

  it.each([
    ['2026-11-05', 'follow_up', 0, 'Consultation Fee — Waived (Follow-up) — Free follow-up, day 4 of 7', 'paid'],
    ['2026-11-12', 'follow_up', 300, 'Follow-up visit — Follow-up fee ₹300 (day 11, free follow-up ended on day 7)', 'pending'],
    ['2026-11-12', 'consultation', 500, 'Consultation Fee (Pay at Front Desk)', 'pending'],
  ])('on %s a %s is ₹%i everywhere', async (date, type, fee, description, status) => {
    await setHospital();
    earlier('2026-11-01');
    const before = await preview(date, type);
    book('apt', date, { consultationType: type });
    const onAppointment = await appointments.getAppointmentChargePreview(T, 'apt');
    const bill = await checkout('apt');
    const raised = db.bills.find((b) => b.items.some((i: Row) => i.referenceId === 'apt'))!;

    expect(before.consultationFee).toBe(fee);
    expect(before.total).toBe(fee);
    expect(onAppointment.consultationFee).toBe(fee);
    expect(bill.totalAmount).toBe(fee);
    expect(raised.items[0]).toMatchObject({ description, unitPrice: fee });
    expect(raised.status).toBe(status);
    expect((await appointments.getAppointmentChargePreview(T, 'apt')).consultationFee).toBe(fee);
  });

  it('shows the same amount and label on the appointment row', async () => {
    await setHospital();
    earlier('2026-11-01');
    book('apt', '2026-11-05');
    await checkout('apt');
    const bill = db.bills.find((b) => b.items.some((i: Row) => i.referenceId === 'apt'))!;
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([{ id: 'apt', tenantId: T }] as any);
    vi.mocked(prisma.billItem.findMany).mockResolvedValue([
      { referenceId: 'apt', totalAmount: 0, bill: { ...bill, payments: [] } },
    ] as any);
    const { appointments: list } = await appointments.getAppointments(T, { page: 1, limit: 10 } as any);
    expect(list[0].paymentInfo).toMatchObject({
      totalAmount: 0, consultationAmount: 0, paymentStatus: 'waived', isFreeFollowUp: true, feeLabel: 'Free follow-up, day 4 of 7',
    });
  });

  it('bills a booking under the rule it was made with, whatever is set later', async () => {
    await setHospital();
    earlier('2026-11-01');
    book('apt', '2026-11-12');
    await rules.snapshotRuleAtBooking(T, { id: 'apt', doctorId: 'doc-1' }, doctorOf('doc-1') as any);
    await setHospital({ freeDays: 30, fixedFee: 50 });
    expect((await checkout('apt')).totalAmount).toBe(300);
    expect((await preview('2026-11-12')).consultationFee).toBe(0);
  });

  it('does not re-price a bill already raised', async () => {
    await setHospital();
    earlier('2026-11-01');
    book('apt', '2026-11-12');
    await checkout('apt');
    await setHospital({ freeDays: 30 });
    expect((await checkout('apt')).totalAmount).toBe(300);
    const shown = await appointments.getAppointmentChargePreview(T, 'apt');
    expect(shown).toMatchObject({ consultationFee: 300, followUp: { kind: 'paid_follow_up' } });
  });

  it('does not bring an appointment made before any rule under it', async () => {
    earlier('2026-11-01');
    book('apt', '2026-11-25', { createdAt: new Date(Date.now() - 60_000) });
    await setHospital();
    expect((await checkout('apt')).totalAmount).toBe(0); // a declared follow-up, as it was then
  });

  it('uses the new doctor’s rule when the booking is moved to another doctor', async () => {
    await setHospital();
    earlier('2026-11-01', { doctorId: 'doc-2' });
    book('apt', '2026-11-12');
    await rules.snapshotRuleAtBooking(T, { id: 'apt', doctorId: 'doc-1' }, doctorOf('doc-1') as any);
    db.appointments.find((a) => a.id === 'apt')!.doctorId = 'doc-2';
    await rules.saveDoctorRule(T, ADMIN, 'doc-2', { ...INHERIT, afterWindow: 'fixed', fixedFee: 120 });
    expect((await checkout('apt')).totalAmount).toBe(120);
  });
});

describe('follow-up rules: charges pulled onto a bill', () => {
  const visit = (id: string, date: string, type = 'follow_up') => ({
    id, tenantId: T, patientId: 'pat-1', doctorId: 'doc-1', visitType: 'op', visitDate: new Date(`${date}T06:00:00.000Z`),
    status: 'active', appointmentId: `apt-${id}`, admission: null, createdAt: new Date(Date.now() + 60_000), doctor: doctorOf('doc-1'),
    appointment: { id: `apt-${id}`, doctorId: 'doc-1', appointmentDate: DAY(date), consultationType: type, createdAt: new Date(Date.now() + 60_000) },
  });
  const feed = async () =>
    (await getPatientCharges(T, { patientId: 'pat-1', source: 'consultation' })).charges.map((r) => [r.referenceId, r.unitPrice]);

  it('prices an unbilled visit by the same rules', async () => {
    await setHospital();
    earlier('2026-11-01');
    vi.mocked(prisma.visit.findMany).mockResolvedValue([
      visit('free', '2026-11-05'), visit('paid', '2026-11-12'), visit('full', '2026-11-12', 'consultation'),
    ] as any);
    expect(await feed()).toEqual([['paid', 300], ['full', 500]]);
  });

  it('keeps charging the plain fee when no rule is set', async () => {
    earlier('2026-11-01');
    vi.mocked(prisma.visit.findMany).mockResolvedValue([visit('v', '2026-11-05')] as any);
    expect(await feed()).toEqual([['v', 500]]);
  });
});

describe('follow-up rules: patient portal', () => {
  beforeEach(() => {
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([{ patientId: 'pat-1', tenantId: T }] as any);
    db.appointments.push({
      id: 'apt', tenantId: T, patientId: 'pat-1', doctorId: 'doc-1', consultationType: null,
      // Booked after the rules these tests set.
      appointmentDate: DAY('2026-11-05'), status: 'booked', createdAt: new Date(Date.now() + 60_000),
    });
  });
  const portalQuote = (date: string) => portal.getConsultationQuote('u1', 'p@x.in', T, { doctorId: 'doc-1', date });

  it('quotes and bills the same free follow-up, with nothing to collect', async () => {
    await setHospital();
    earlier('2026-11-01');
    const q = await portalQuote('2026-11-05');
    expect(q).toMatchObject({ fee: 0, listFee: 500, label: 'Free follow-up, day 4 of 7' });
    expect(q).not.toHaveProperty('rule');
    const out = await portal.confirmFrontdeskPayment('u1', 'p@x.in', { appointmentId: 'apt' });
    expect(out).toMatchObject({ status: 'paid', amount: 0, isFreeFollowUp: true });
    expect(db.bills.at(-1)).toMatchObject({ totalAmount: 0, status: 'paid' });
  });

  it('refuses to start an online payment for a free follow-up', async () => {
    await setHospital();
    earlier('2026-11-01');
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ linkedAccountId: 'acc', bankVerified: true } as any);
    await expect(portal.createPatientPaymentOrder('u1', 'p@x.in', { appointmentId: 'apt' })).rejects.toThrow(/free/i);
  });

  it('charges the full fee outside the period and when no rule is set', async () => {
    earlier('2026-11-01');
    doctorOf('doc-1')!.freeFollowUpDays = 7;
    expect(await portalQuote('2026-11-05')).toMatchObject({ fee: 500, governed: false });
    doctorOf('doc-1')!.freeFollowUpDays = null;
    await setHospital();
    expect(await portalQuote('2026-11-12')).toMatchObject({ fee: 500, governed: true });
  });
});
