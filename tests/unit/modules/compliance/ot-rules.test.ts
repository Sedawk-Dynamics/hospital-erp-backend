import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/modules/billing/billing.service', () => ({
  billOtRequest: vi.fn(async () => ({ billId: 'bill-1', billNumber: 'IP-0001' })),
}));

import { prisma } from '../../../../src/config/database';
import { billOtRequest } from '../../../../src/modules/billing/billing.service';
import {
  caseWindow,
  defaultCompletionEnd,
  doctorAvailabilityProblems,
  findOtConflicts,
  isBeforeScheduledDay,
  resolveOtCharge,
  tariffChargeLines,
  otChargeLineDescription,
  windowsOverlap,
} from '../../../../src/modules/compliance/ot-rules';
import {
  approveOTRequest,
  createOTRequest,
  getOTAnalytics,
  scheduleOT,
  updateOTRequest,
} from '../../../../src/modules/compliance/compliance.service';

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.notification.create as any).mockResolvedValue({ id: 'n-1' });
});

// ── Pure rules ───────────────────────────────────────────────────────────────

describe('OT rules — time windows (gap 351)', () => {
  it('uses the end time, else start + duration, else the default', () => {
    expect(caseWindow({ startTime: '09:00', endTime: '10:30' }, 60)).toEqual({ start: 540, end: 630 });
    expect(caseWindow({ startTime: '09:00', durationMinutes: 45 }, 60)).toEqual({ start: 540, end: 585 });
    expect(caseWindow({ startTime: '09:00' }, 60)).toEqual({ start: 540, end: 600 });
    expect(caseWindow({ startTime: null }, 60)).toBeNull();
  });

  it('back-to-back cases do not overlap, but do inside a turnover buffer', () => {
    const a = { start: 540, end: 600 };
    const b = { start: 600, end: 660 };
    expect(windowsOverlap(a, b)).toBe(false);
    expect(windowsOverlap(a, b, 30)).toBe(true);
  });
});

describe('OT rules — surgeon roster and leave (gap 351)', () => {
  const win = { start: 540, end: 600 };
  const base = { hasWeeklySchedule: true, weeklyShifts: [{ start: 480, end: 780 }], override: null, leaves: [] };

  it('passes a case inside the shift', () => {
    expect(doctorAvailabilityProblems('Dr. A', '2026-11-16', win, base)).toEqual([]);
  });

  it('flags a weekday with no shift as a day off', () => {
    const out = doctorAvailabilityProblems('Dr. A', '2026-11-15', win, { ...base, weeklyShifts: [] });
    expect(out[0]).toMatch(/no shift on Sunday 15\/11\/2026/);
  });

  it('flags approved full-day leave', () => {
    const out = doctorAvailabilityProblems('Dr. A', '2026-11-16', win, { ...base, leaves: [null] });
    expect(out).toEqual(['Dr. A is on approved leave on 16/11/2026.']);
  });

  it('flags a date override marked off duty', () => {
    const out = doctorAvailabilityProblems('Dr. A', '2026-11-16', win, {
      ...base,
      override: { isDayOff: true, shifts: [] },
    });
    expect(out[0]).toMatch(/off duty/);
  });

  it('does not treat a surgeon with no roster at all as off duty', () => {
    expect(
      doctorAvailabilityProblems('Dr. A', '2026-11-16', win, { ...base, hasWeeklySchedule: false, weeklyShifts: [] }),
    ).toEqual([]);
  });
});

describe('OT rules — completion time and early completion (gap 354)', () => {
  it('ends at start + planned duration rather than "now"', () => {
    const start = new Date('2026-11-14T08:21:00.000Z');
    expect(defaultCompletionEnd(start, { durationMinutes: 60 }, 30).toISOString()).toBe('2026-11-14T09:21:00.000Z');
    expect(
      defaultCompletionEnd(start, { scheduledStartTime: '13:00', scheduledEndTime: '14:30' }, 30).toISOString(),
    ).toBe('2026-11-14T09:51:00.000Z');
    expect(defaultCompletionEnd(start, {}, 45).toISOString()).toBe('2026-11-14T09:06:00.000Z');
  });

  it('knows when the scheduled day is still in the future (IST)', () => {
    const now = new Date('2026-11-13T19:00:00.000Z'); // 14/11 00:30 IST
    expect(isBeforeScheduledDay(new Date('2026-11-14T00:00:00Z'), now)).toBe(false);
    expect(isBeforeScheduledDay(new Date('2026-11-15T00:00:00Z'), now)).toBe(true);
    expect(isBeforeScheduledDay(null, now)).toBe(false);
  });
});

describe('OT rules — price resolution (gap 352)', () => {
  it('uses the charge set on the surgery first', async () => {
    const q = await resolveOtCharge(TENANT, { billingAmount: 25000, procedureName: 'Appendectomy' });
    expect(q).toMatchObject({ amount: 25000, source: 'manual' });
  });

  it('uses a single exact-name surgery tariff', async () => {
    vi.mocked(prisma.serviceTariff.findMany).mockResolvedValueOnce([
      { id: 't-1', serviceName: 'Appendectomy', basePrice: 18000 },
    ] as any);
    const q = await resolveOtCharge(TENANT, { billingAmount: null, procedureName: 'appendectomy' });
    expect(q).toMatchObject({ amount: 18000, source: 'tariff_match', serviceTariffId: 't-1' });
  });

  it('never guesses between two same-name tariffs, and returns null without a price', async () => {
    vi.mocked(prisma.serviceTariff.findMany).mockResolvedValueOnce([
      { id: 't-1', serviceName: 'Appendectomy', basePrice: 18000 },
      { id: 't-2', serviceName: 'Appendectomy', basePrice: 21000 },
    ] as any);
    expect(await resolveOtCharge(TENANT, { procedureName: 'Appendectomy' })).toBeNull();
    expect(await resolveOtCharge(TENANT, { procedureName: 'Unpriced op' })).toBeNull();
  });
});

// Gap 352 (retest): explicit ₹0 tariffs and theatre/surgeon/anaesthesia components.
describe('OT rules — zero and component tariffs (gap 352)', () => {
  const tariff = (over: Record<string, unknown> = {}) => ({
    id: 't-1', serviceName: 'Appendectomy', basePrice: 18000,
    otTheatreCharge: null, otSurgeonCharge: null, otAnaesthesiaCharge: null, otAssistantCharge: null,
    ...over,
  });

  it('a ₹0 tariff is an explicit no-charge price, not "no price"', async () => {
    vi.mocked(prisma.serviceTariff.findFirst).mockResolvedValueOnce(tariff({ basePrice: 0 }) as any);
    const q = await resolveOtCharge(TENANT, { serviceTariffId: 't-1', procedureName: 'Appendectomy' });
    expect(q).toMatchObject({ amount: 0, noCharge: true, source: 'tariff' });
    expect(q!.lines).toEqual([
      expect.objectContaining({ amount: 0, label: '₹0 — no charge', referenceType: 'ot_request' }),
    ]);
    expect(otChargeLineDescription(q!.lines[0], 'Appendectomy', 'Dr. A')).toBe('Surgery — Appendectomy (Dr. A) — ₹0 — no charge');
  });

  it('a ₹0 exact-name tariff is used too (it used to be skipped)', async () => {
    vi.mocked(prisma.serviceTariff.findMany).mockResolvedValueOnce([tariff({ basePrice: 0 })] as any);
    const q = await resolveOtCharge(TENANT, { procedureName: 'appendectomy' });
    expect(q).toMatchObject({ amount: 0, noCharge: true, source: 'tariff_match' });
  });

  it('bills each configured component as its own line', () => {
    const r = tariffChargeLines(tariff({ otTheatreCharge: 5000, otSurgeonCharge: 10000, otAnaesthesiaCharge: '3000.50' }))!;
    expect(r.amount).toBe(18000.5);
    expect(r.lines.map((l) => [l.component, l.amount, l.referenceType])).toEqual([
      ['theatre', 5000, 'ot_request'],
      ['surgeon', 10000, 'ot_request_surgeon'],
      ['anaesthesia', 3000.5, 'ot_request_anaesthesia'],
    ]);
  });

  it('never adds the single basePrice on top of the components', () => {
    const r = tariffChargeLines(tariff({ basePrice: 18000, otTheatreCharge: 5000, otSurgeonCharge: 10000 }))!;
    expect(r.amount).toBe(15000);
    expect(r.lines.some((l) => l.component === 'procedure')).toBe(false);
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(r.amount);
  });

  it('drops zero components but keeps the rest; all-zero components are one no-charge line', () => {
    expect(tariffChargeLines(tariff({ otTheatreCharge: 5000, otSurgeonCharge: 0 }))!.lines).toHaveLength(1);
    const none = tariffChargeLines(tariff({ otTheatreCharge: 0, otSurgeonCharge: 0 }))!;
    expect(none).toMatchObject({ amount: 0, noCharge: true });
    expect(none.lines).toHaveLength(1);
  });

  it('an amount typed on the surgery wins over the tariff components — one line', async () => {
    const q = await resolveOtCharge(TENANT, { billingAmount: 25000, serviceTariffId: 't-1', procedureName: 'Appendectomy' });
    expect(q).toMatchObject({ amount: 25000, source: 'manual' });
    expect(q!.lines).toHaveLength(1);
    expect(prisma.serviceTariff.findFirst).not.toHaveBeenCalled();
  });

  it('labels component lines on the bill', () => {
    const [theatre, surgeon] = tariffChargeLines(tariff({ otTheatreCharge: 1, otSurgeonCharge: 2 }))!.lines;
    expect(otChargeLineDescription(theatre, 'Hernia repair', 'Dr. B')).toBe('OT theatre charge — Hernia repair');
    expect(otChargeLineDescription(surgeon, 'Hernia repair', 'Dr. B')).toBe('Surgeon fee — Hernia repair (Dr. B)');
  });
});

describe('OT rules — findOtConflicts (gap 351)', () => {
  const other = {
    id: 'ot-other',
    procedureName: 'Hernia repair',
    patientId: 'pat-2',
    otId: 'room-1',
    doctorId: 'doc-9',
    surgeonId: 'doc-9',
    anaesthetistId: null,
    scheduledStartTime: '09:30',
    scheduledEndTime: '10:30',
    durationMinutes: 60,
    patient: { firstName: 'Other', lastName: 'Patient' },
    ot: { name: 'OT-1' },
  };

  it('reports a theatre clash with the booking it overlaps', async () => {
    vi.mocked(prisma.otRequest.findMany).mockResolvedValueOnce([other] as any);
    const out = await findOtConflicts(TENANT, {
      date: '2026-11-20', startTime: '09:00', durationMinutes: 60, otId: 'room-1', surgeonId: 'doc-1', patientId: 'pat-1',
    });
    expect(out.map((c) => c.kind)).toEqual(['theatre']);
    expect(out[0].message).toMatch(/OT-1 is already booked 09:30–10:30 for Hernia repair/);
  });

  it('reports the same surgeon in two theatres', async () => {
    vi.mocked(prisma.otRequest.findMany).mockResolvedValueOnce([{ ...other, otId: 'room-2', surgeonId: 'doc-1' }] as any);
    vi.mocked(prisma.doctorProfile.findMany).mockResolvedValueOnce([
      { id: 'doc-1', user: { firstName: 'Asha', lastName: 'Rao' } },
    ] as any);
    const out = await findOtConflicts(TENANT, {
      date: '2026-11-20', startTime: '09:00', durationMinutes: 60, otId: 'room-1', surgeonId: 'doc-1', patientId: 'pat-1',
    });
    expect(out.map((c) => c.kind)).toEqual(['surgeon']);
    expect(out[0].message).toMatch(/Dr\. Asha Rao is already in Hernia repair/);
  });

  it('reports approved leave for the surgeon', async () => {
    vi.mocked(prisma.doctorLeave.findMany).mockResolvedValueOnce([{ startTime: null, endTime: null }] as any);
    const out = await findOtConflicts(TENANT, {
      date: '2026-11-20', startTime: '09:00', otId: 'room-1', surgeonId: 'doc-1', patientId: 'pat-1',
    });
    expect(out.map((c) => c.kind)).toEqual(['doctor_availability']);
  });
});

// ── Service wiring ───────────────────────────────────────────────────────────

describe('OT booking — theatre required (gap 350)', () => {
  beforeEach(() => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as any);
    vi.mocked(prisma.admission.findFirst).mockResolvedValue({ id: 'adm-1', visitId: 'visit-1' } as any);
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
  });

  it('refuses a firm booking with no theatre configured, pointing to OT Settings', async () => {
    vi.mocked(prisma.operatingTheater.count).mockResolvedValueOnce(0);
    await expect(
      createOTRequest(TENANT, 'u-1', {
        patientId: 'pat-1', surgeryName: 'Appendectomy', surgeonId: 'doc-1', scheduledDate: '2026-11-20',
      } as any),
    ).rejects.toMatchObject({ code: 'OT_NO_THEATRE', message: expect.stringMatching(/Add a theater first/) });
    expect(prisma.otRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a firm booking that did not pick a theatre', async () => {
    vi.mocked(prisma.operatingTheater.count).mockResolvedValueOnce(2);
    await expect(
      createOTRequest(TENANT, 'u-1', {
        patientId: 'pat-1', surgeryName: 'Appendectomy', surgeonId: 'doc-1', scheduledDate: '2026-11-20',
      } as any),
    ).rejects.toMatchObject({ code: 'OT_THEATRE_REQUIRED' });
  });

  it('refuses to approve a request that has no theatre', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({ id: 'ot-1', status: 'requested', otId: null } as any);
    vi.mocked(prisma.operatingTheater.count).mockResolvedValueOnce(1);
    await expect(approveOTRequest(TENANT, 'ot-1', 'u-1')).rejects.toMatchObject({ code: 'OT_THEATRE_REQUIRED' });
  });

  it('refuses to start a case with no theatre', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({
      id: 'ot-1', status: 'scheduled', otId: null, scheduledDate: new Date('2026-11-01T00:00:00Z'),
    } as any);
    vi.mocked(prisma.operatingTheater.count).mockResolvedValueOnce(1);
    await expect(updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'in_progress' } as any)).rejects.toMatchObject({
      code: 'OT_THEATRE_REQUIRED',
    });
    expect(prisma.otRequest.update).not.toHaveBeenCalled();
  });
});

describe('OT booking — clash checks (gap 351)', () => {
  const REQ = {
    id: 'ot-1', status: 'scheduled', patientId: 'pat-1', doctorId: 'doc-1', surgeonId: 'doc-1',
    anaesthetistId: null, otId: 'room-1', procedureName: 'Appendectomy', durationMinutes: 60,
    preferredDate: null, preferredTime: null,
    scheduledDate: new Date('2026-11-20T00:00:00Z'), scheduledStartTime: '08:00',
    patient: { firstName: 'P', lastName: 'One' }, doctor: { user: { id: 'du' } }, surgeon: { user: { id: 'du' } },
  };
  const clashing = {
    id: 'ot-2', procedureName: 'Hernia repair', patientId: 'pat-2', otId: 'room-1', doctorId: 'doc-9',
    surgeonId: 'doc-9', anaesthetistId: null, scheduledStartTime: '09:30', scheduledEndTime: null,
    durationMinutes: 60, patient: { firstName: 'Other', lastName: 'Patient' }, ot: { name: 'OT-1' },
  };

  beforeEach(() => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValue(REQ as any);
    vi.mocked(prisma.operatingTheater.findFirst).mockResolvedValue({ id: 'room-1', name: 'OT-1' } as any);
    vi.mocked(prisma.otRequest.update).mockResolvedValue({ ...REQ, ot: { name: 'OT-1' } } as any);
  });

  it('blocks moving a booking onto an occupied theatre with a 409 listing the clash', async () => {
    vi.mocked(prisma.otRequest.findMany).mockResolvedValueOnce([clashing] as any);
    const err = await scheduleOT(TENANT, 'ot-1', 'u-1', {
      scheduledDate: '2026-11-20', scheduledStartTime: '09:00', rescheduleReason: 'moved',
    } as any).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('OT_CONFLICT');
    expect(err.details.conflicts[0]).toMatchObject({ kind: 'theatre', otRequestId: 'ot-2' });
    expect(prisma.otRequest.update).not.toHaveBeenCalled();
    // The booking being moved is never compared with itself.
    expect((prisma.otRequest.findMany as any).mock.calls[0][0].where.id).toEqual({ not: 'ot-1' });
  });

  it('saves the booking when the clash is confirmed as an override', async () => {
    vi.mocked(prisma.otRequest.findMany).mockResolvedValueOnce([clashing] as any);
    await scheduleOT(TENANT, 'ot-1', 'u-1', {
      scheduledDate: '2026-11-20', scheduledStartTime: '09:00', rescheduleReason: 'moved', overrideConflicts: true,
    } as any);
    expect(prisma.otRequest.update).toHaveBeenCalled();
  });
});

describe('OT lifecycle — start/complete (gaps 352, 354)', () => {
  const started = new Date('2026-11-14T08:21:00.000Z');
  const RUNNING = {
    id: 'ot-1', status: 'in_progress', otId: 'room-1', procedureName: 'Appendectomy',
    scheduledDate: new Date('2026-11-14T00:00:00Z'), actualStartTime: started, actualEndTime: null,
    durationMinutes: 60, billingAmount: null, serviceTariffId: null,
  };

  beforeEach(() => {
    vi.mocked(prisma.operatingTheater.findFirst).mockResolvedValue({ id: 'room-1', name: 'OT-1' } as any);
    vi.mocked(prisma.otRequest.update).mockImplementation((async (a: any) => ({ ...RUNNING, ...a.data })) as any);
  });

  it('blocks completing before the scheduled date unless confirmed', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({
      ...RUNNING, scheduledDate: new Date('2099-01-01T00:00:00Z'),
    } as any);
    await expect(updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any)).rejects.toMatchObject({
      statusCode: 409, code: 'OT_EARLY',
    });
  });

  it('stores end = start + duration when the end was not edited', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce(RUNNING as any);
    await updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any);
    const patch = (prisma.otRequest.update as any).mock.calls[0][0].data;
    expect(patch.actualEndTime.toISOString()).toBe('2026-11-14T09:21:00.000Z');
  });

  it('keeps an edited end time', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce(RUNNING as any);
    await updateOTRequest(TENANT, 'ot-1', 'u-1', {
      status: 'completed', actualEndTime: '2026-11-14T10:00:00.000Z',
    } as any);
    const patch = (prisma.otRequest.update as any).mock.calls[0][0].data;
    expect(patch.actualEndTime.toISOString()).toBe('2026-11-14T10:00:00.000Z');
  });

  it('says nothing will be billed when no price is configured', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce(RUNNING as any);
    const out: any = await updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any);
    expect(out.billing).toMatchObject({ posted: false, amount: 0 });
    expect(out.billing.message).toMatch(/nothing will be billed/);
    expect(billOtRequest).not.toHaveBeenCalled();
  });

  it('posts the configured price to the stay on Complete', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({ ...RUNNING, billingAmount: 25000 } as any);
    vi.mocked(prisma.otRequest.update).mockImplementation(
      (async (a: any) => ({ ...RUNNING, billingAmount: 25000, ...a.data })) as any,
    );
    const out: any = await updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any);
    expect(billOtRequest).toHaveBeenCalledWith(TENANT, 'ot-1', 'u-1');
    expect(out.billing).toMatchObject({ posted: true, amount: 25000, billNumber: 'IP-0001' });
  });

  // Gap 352 (retest): a ₹0 tariff is billed as a labelled no-charge line, not skipped.
  it('posts a ₹0 — no charge tariff on Complete instead of skipping it', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({ ...RUNNING, serviceTariffId: 't-0' } as any);
    vi.mocked(prisma.otRequest.update).mockImplementation(
      (async (a: any) => ({ ...RUNNING, serviceTariffId: 't-0', ...a.data })) as any,
    );
    vi.mocked(prisma.serviceTariff.findFirst).mockResolvedValue({
      id: 't-0', serviceName: 'Free camp cataract', basePrice: 0,
    } as any);
    const out: any = await updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any);
    expect(billOtRequest).toHaveBeenCalledWith(TENANT, 'ot-1', 'u-1');
    expect(out.billing).toMatchObject({ posted: true, amount: 0 });
    expect(out.billing.message).toContain('₹0 — no charge');
    vi.mocked(prisma.serviceTariff.findFirst).mockReset();
  });

  it('posts the component lines and leaves billingAmount as typed (no manual override)', async () => {
    vi.mocked(prisma.otRequest.findFirst).mockResolvedValueOnce({ ...RUNNING, serviceTariffId: 't-c' } as any);
    vi.mocked(prisma.otRequest.update).mockImplementation(
      (async (a: any) => ({ ...RUNNING, serviceTariffId: 't-c', ...a.data })) as any,
    );
    vi.mocked(prisma.serviceTariff.findFirst).mockResolvedValue({
      id: 't-c', serviceName: 'Appendectomy', basePrice: 15000, otTheatreCharge: 5000, otSurgeonCharge: 10000,
    } as any);
    const out: any = await updateOTRequest(TENANT, 'ot-1', 'u-1', { status: 'completed' } as any);
    expect(out.billing).toMatchObject({ posted: true, amount: 15000 });
    expect(out.billing.message).toContain('Theatre charge ₹5,000');
    // Writing the total back made every later read treat it as a one-line manual charge.
    const amountWrites = (prisma.otRequest.update as any).mock.calls.filter((c: any) => 'billingAmount' in c[0].data);
    expect(amountWrites).toHaveLength(0);
    vi.mocked(prisma.serviceTariff.findFirst).mockReset();
  });
});

describe('OT reports (gap 353)', () => {
  it('filters on the surgery date (IST, end inclusive), counts theatres from the master and bills from posted charges', async () => {
    vi.mocked(prisma.otRequest.findMany).mockResolvedValueOnce([
      {
        id: 'ot-1', status: 'completed', otId: null, doctorId: 'd', surgeonId: 'd', procedureName: 'X',
        scheduledDate: new Date('2026-11-13T00:00:00Z'), billingAmount: 5000, durationMinutes: 60,
      },
    ] as any);
    vi.mocked(prisma.operatingTheater.findMany).mockResolvedValueOnce([
      { id: 'room-1', name: 'OT-1' }, { id: 'room-2', name: 'OT-2' },
    ] as any);
    vi.mocked(prisma.billItem.findMany).mockResolvedValueOnce([
      { referenceId: 'ot-1', totalAmount: 4500, bill: { id: 'b', billNumber: 'IP-1', status: 'draft' } },
    ] as any);

    const out = await getOTAnalytics(TENANT, { fromDate: '2026-10-14', toDate: '2026-11-13' });

    const where = (prisma.otRequest.findMany as any).mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
    expect(where.OR[0].scheduledDate.gte.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(where.OR[0].scheduledDate.lte.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(out.theatreCount).toBe(2);
    expect(out.otUtilization.map((o) => o.otName).sort()).toEqual(['OT-1', 'OT-2']);
    expect(out.unassignedTheatreCount).toBe(1);
    expect(out.billedTotal).toBe(4500);
    expect(out.surgeryList[0].billedAmount).toBe(4500);
  });
});
