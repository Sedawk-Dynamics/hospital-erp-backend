import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { fullName } from '../../shared/person-name';

// ============================================================
// OT booking rules — theatre required (gap 350), clash checks (gap 351),
// OT price resolution (gap 352), posted charges (gap 353) and completion
// timing (gap 354). Pure helpers first so they can be unit-tested directly.
// ============================================================

const IST_TIMEZONE = 'Asia/Kolkata';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Statuses that hold a theatre slot. Pending requests have no slot yet. */
export const OT_ACTIVE_STATUSES = ['scheduled', 'in_progress'] as const;

export interface MinuteWindow {
  start: number;
  end: number;
}

/** "09:30" → 570. Accepts "HH:mm[:ss]"; anything else is null. */
export function hhmmToMin(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 570 → "09:30". Wraps past midnight so a late case still prints sensibly. */
export function minToHhmm(total: number): string {
  const t = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Minutes of the day held by a @db.Time column (stored as 1970-01-01Thh:mm UTC). */
export function timeColumnToMin(value: Date | null | undefined): number | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/**
 * The minutes a case occupies. End time when it is after the start, otherwise
 * start + duration (or the hospital's default duration). Null when there is no
 * start time — a date-only booking cannot be checked for overlaps.
 */
export function caseWindow(
  c: { startTime?: string | null; endTime?: string | null; durationMinutes?: number | null },
  defaultDurationMinutes: number,
): MinuteWindow | null {
  const start = hhmmToMin(c.startTime);
  if (start == null) return null;
  const end = hhmmToMin(c.endTime);
  if (end != null && end > start) return { start, end };
  const dur = c.durationMinutes && c.durationMinutes > 0 ? c.durationMinutes : defaultDurationMinutes;
  return { start, end: start + dur };
}

/** Half-open overlap, optionally widened by a turnover buffer between cases. */
export function windowsOverlap(a: MinuteWindow, b: MinuteWindow, bufferMinutes = 0): boolean {
  return a.start < b.end + bufferMinutes && b.start < a.end + bufferMinutes;
}

/** "YYYY-MM-DD" for a date the client sent, or for a stored @db.Date column. */
export function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // @db.Date columns come back as UTC midnight, so the UTC date is the stored one.
  return d.toISOString().slice(0, 10);
}

/** Today's (or `now`'s) calendar date in IST. */
export function istTodayKey(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: IST_TIMEZONE });
}

/** True when the surgery's scheduled day is still in the future (IST). */
export function isBeforeScheduledDay(scheduledDate: Date | string | null | undefined, now: Date = new Date()): boolean {
  const key = dateKey(scheduledDate);
  if (!key) return false;
  return istTodayKey(now) < key;
}

/** "2026-11-14" → "14/11/2026", the wording used on every OT screen. */
export function displayDate(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Default end of a surgery when Complete is pressed without an edited end time
 * (gap 354): actual start + planned duration. Duration comes from the booking,
 * else the scheduled window, else the hospital default — never "now", which is
 * what produced the "01:51 PM – 01:51 PM" for a 60-minute case.
 */
export function defaultCompletionEnd(
  actualStart: Date,
  c: { durationMinutes?: number | null; scheduledStartTime?: string | null; scheduledEndTime?: string | null },
  defaultDurationMinutes: number,
): Date {
  let dur = c.durationMinutes && c.durationMinutes > 0 ? c.durationMinutes : null;
  if (dur == null) {
    const s = hhmmToMin(c.scheduledStartTime);
    const e = hhmmToMin(c.scheduledEndTime);
    if (s != null && e != null && e > s) dur = e - s;
  }
  return new Date(actualStart.getTime() + (dur ?? defaultDurationMinutes) * 60_000);
}

// ── Doctor availability (shift + leave) ─────────────────────────────────────

export interface DoctorDayFacts {
  /** True when the doctor has at least one active weekly schedule row. */
  hasWeeklySchedule: boolean;
  /** Weekly shifts for this weekday. */
  weeklyShifts: MinuteWindow[];
  /** Date-specific override, if any. */
  override: { isDayOff: boolean; shifts: MinuteWindow[]; note?: string | null } | null;
  /** Approved leaves covering the date. A null window means a full-day leave. */
  leaves: Array<MinuteWindow | null>;
}

/**
 * Why a doctor cannot take a case on this day/window, or [] when they can.
 * Shift checks only apply when the doctor has a roster at all — a surgeon with
 * no schedule configured is not treated as permanently off duty.
 */
export function doctorAvailabilityProblems(
  label: string,
  dayKey: string,
  window: MinuteWindow | null,
  facts: DoctorDayFacts,
): string[] {
  const problems: string[] = [];
  const day = displayDate(dayKey);

  for (const leave of facts.leaves) {
    if (!leave) {
      problems.push(`${label} is on approved leave on ${day}.`);
      return problems;
    }
    if (window && windowsOverlap(window, leave)) {
      problems.push(
        `${label} is on approved leave ${minToHhmm(leave.start)}–${minToHhmm(leave.end)} on ${day}.`,
      );
    }
  }

  if (facts.override?.isDayOff) {
    problems.push(`${label} is marked off duty on ${day}${facts.override.note ? ` (${facts.override.note})` : ''}.`);
    return problems;
  }

  const shifts =
    facts.override && facts.override.shifts.length > 0 ? facts.override.shifts : facts.weeklyShifts;
  const hasRoster = facts.hasWeeklySchedule || (facts.override?.shifts.length ?? 0) > 0;
  if (!hasRoster) return problems;

  if (shifts.length === 0) {
    const weekday = DAY_NAMES[new Date(`${dayKey}T00:00:00Z`).getUTCDay()];
    problems.push(`${label} has no shift on ${weekday} ${day} (day off).`);
    return problems;
  }
  if (window && !shifts.some((s) => window.start >= s.start && window.end <= s.end)) {
    const list = shifts.map((s) => `${minToHhmm(s.start)}–${minToHhmm(s.end)}`).join(', ');
    problems.push(
      `${minToHhmm(window.start)}–${minToHhmm(window.end)} is outside ${label}'s shift hours on ${day} (${list}).`,
    );
  }
  return problems;
}

// ── Theatre master ──────────────────────────────────────────────────────────

/**
 * A booking must name a theatre from the master (gap 350). Distinguishes "no
 * theatre configured at all" — the UI turns that code into a link to OT
 * Settings — from "you did not pick one".
 */
export async function requireTheatre(tenantId: string, otId: string | null | undefined) {
  if (!otId) {
    const configured = await prisma.operatingTheater.count({ where: { tenantId } });
    if (configured === 0) {
      throw AppError.badRequest(
        'No operating theater is configured. Add a theater first in OT Settings.',
        'OT_NO_THEATRE',
      );
    }
    throw AppError.badRequest('Select the operating theater for this surgery.', 'OT_THEATRE_REQUIRED');
  }
  const ot = await prisma.operatingTheater.findFirst({
    where: { id: otId, tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!ot) throw AppError.notFound('Operating theater not found');
  return ot;
}

async function schedulingDefaults(tenantId: string) {
  const s = await prisma.otSchedulingSetting.findUnique({ where: { tenantId } });
  return {
    defaultDurationMinutes: s?.defaultDurationMinutes ?? 60,
    bufferMinutes: s?.bufferMinutes ?? 0,
  };
}

// ── Clash checks (gap 351) ──────────────────────────────────────────────────

export interface OtSlotCandidate {
  /** The booking being moved — never clashes with itself. */
  excludeId?: string;
  date: Date | string;
  startTime?: string | null;
  endTime?: string | null;
  durationMinutes?: number | null;
  otId?: string | null;
  /** DoctorProfile id of the operating surgeon (falls back to the requester). */
  surgeonId?: string | null;
  anaesthetistId?: string | null;
  patientId: string;
}

export type OtConflictKind = 'theatre' | 'surgeon' | 'anaesthetist' | 'patient' | 'doctor_availability';

export interface OtConflict {
  kind: OtConflictKind;
  message: string;
  otRequestId?: string;
}

async function doctorDayFacts(doctorId: string, dayKey: string): Promise<DoctorDayFacts> {
  const target = new Date(`${dayKey}T00:00:00.000Z`);
  const weekday = target.getUTCDay();
  const [weekly, override, leaves] = await Promise.all([
    prisma.doctorSchedule.findMany({ where: { doctorId, isActive: true } }),
    prisma.doctorScheduleOverride.findUnique({
      where: { doctorId_date: { doctorId, date: target } },
      include: { shifts: true },
    }),
    prisma.doctorLeave.findMany({
      where: {
        doctorId,
        status: 'approved',
        leaveDate: { lte: target },
        OR: [{ endDate: null, leaveDate: target }, { endDate: { gte: target } }],
      },
    }),
  ]);
  const toWin = (s: { startTime: Date; endTime: Date }): MinuteWindow | null => {
    const a = timeColumnToMin(s.startTime);
    const b = timeColumnToMin(s.endTime);
    return a != null && b != null && b > a ? { start: a, end: b } : null;
  };
  return {
    hasWeeklySchedule: (weekly ?? []).length > 0,
    weeklyShifts: (weekly ?? [])
      .filter((s) => s.dayOfWeek === weekday)
      .map(toWin)
      .filter((w): w is MinuteWindow => !!w),
    override: override
      ? {
          isDayOff: override.isDayOff,
          note: override.note,
          shifts: (override.shifts ?? []).map(toWin).filter((w): w is MinuteWindow => !!w),
        }
      : null,
    leaves: (leaves ?? []).map((l) => {
      const a = timeColumnToMin(l.startTime);
      const b = timeColumnToMin(l.endTime);
      return a != null && b != null && b > a ? { start: a, end: b } : null;
    }),
  };
}

/**
 * Every clash for a proposed slot: same theatre (widened by the turnover
 * buffer), same surgeon or anaesthetist in two places, the same patient twice,
 * and the surgeon's roster / approved leave.
 */
export async function findOtConflicts(tenantId: string, c: OtSlotCandidate): Promise<OtConflict[]> {
  const dayKey = dateKey(c.date);
  if (!dayKey) return [];
  const { defaultDurationMinutes, bufferMinutes } = await schedulingDefaults(tenantId);
  const window = caseWindow(c, defaultDurationMinutes);
  const conflicts: OtConflict[] = [];

  const people = [c.surgeonId, c.anaesthetistId].filter((x): x is string => !!x);
  const or: object[] = [{ patientId: c.patientId }];
  if (c.otId) or.push({ otId: c.otId });
  for (const p of people) {
    or.push({ surgeonId: p }, { anaesthetistId: p }, { AND: [{ surgeonId: null }, { doctorId: p }] });
  }

  const day = new Date(`${dayKey}T00:00:00.000Z`);
  const others = await prisma.otRequest.findMany({
    where: {
      tenantId,
      scheduledDate: day,
      status: { in: [...OT_ACTIVE_STATUSES] },
      ...(c.excludeId ? { id: { not: c.excludeId } } : {}),
      OR: or,
    },
    select: {
      id: true,
      procedureName: true,
      patientId: true,
      otId: true,
      doctorId: true,
      surgeonId: true,
      anaesthetistId: true,
      scheduledStartTime: true,
      scheduledEndTime: true,
      durationMinutes: true,
      patient: { select: { firstName: true, lastName: true } },
      ot: { select: { name: true } },
    },
  });

  const peopleNames = await doctorNames(people);

  for (const o of others ?? []) {
    const ow = caseWindow(
      { startTime: o.scheduledStartTime, endTime: o.scheduledEndTime, durationMinutes: o.durationMinutes },
      defaultDurationMinutes,
    );
    // A case with no start time holds the whole day as far as we can tell.
    const span = ow ? `${minToHhmm(ow.start)}–${minToHhmm(ow.end)}` : 'on this day (no start time)';
    const who = fullName(o.patient) || 'another patient';
    const theatre = o.ot?.name ?? 'an unassigned theater';
    const clashes = (buffer: number) => !window || !ow || windowsOverlap(window, ow, buffer);

    if (c.otId && o.otId === c.otId && clashes(bufferMinutes)) {
      conflicts.push({
        kind: 'theatre',
        otRequestId: o.id,
        message:
          `${theatre} is already booked ${span} for ${o.procedureName} (${who})` +
          (bufferMinutes > 0 ? `, including the ${bufferMinutes}-min turnover buffer.` : '.'),
      });
    }
    if (o.patientId === c.patientId && clashes(0)) {
      conflicts.push({
        kind: 'patient',
        otRequestId: o.id,
        message: `This patient already has ${o.procedureName} booked ${span} in ${theatre}.`,
      });
    }
    const oSurgeon = o.surgeonId ?? o.doctorId;
    for (const p of people) {
      if ((oSurgeon === p || o.anaesthetistId === p) && clashes(0)) {
        conflicts.push({
          kind: p === c.surgeonId ? 'surgeon' : 'anaesthetist',
          otRequestId: o.id,
          message: `${peopleNames.get(p) ?? 'The doctor'} is already in ${o.procedureName} (${who}) ${span} in ${theatre}.`,
        });
      }
    }
  }

  for (const p of people) {
    const facts = await doctorDayFacts(p, dayKey);
    for (const message of doctorAvailabilityProblems(peopleNames.get(p) ?? 'The doctor', dayKey, window, facts)) {
      conflicts.push({ kind: 'doctor_availability', message });
    }
  }

  return conflicts;
}

async function doctorNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await prisma.doctorProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true, user: { select: { firstName: true, lastName: true } } },
  });
  for (const r of rows ?? []) {
    const n = fullName(r.user);
    out.set(r.id, n ? `Dr. ${n}` : 'The doctor');
  }
  return out;
}

/**
 * Block a clashing booking with a 409 that lists every conflict, unless the
 * caller confirmed the override (gap 351). Overrides are logged.
 */
export async function assertNoOtConflicts(
  tenantId: string,
  c: OtSlotCandidate,
  opts: { override?: boolean; userId: string },
): Promise<OtConflict[]> {
  const conflicts = await findOtConflicts(tenantId, c);
  if (!conflicts.length) return conflicts;
  if (opts.override) {
    logger.warn(
      { tenantId, otRequestId: c.excludeId, userId: opts.userId, conflicts },
      'OT booking saved over scheduling conflicts (confirmed override)',
    );
    return conflicts;
  }
  throw AppError.conflict(
    conflicts.length === 1
      ? `Scheduling conflict: ${conflicts[0].message}`
      : `${conflicts.length} scheduling conflicts: ${conflicts.map((x) => x.message).join(' ')}`,
    'OT_CONFLICT',
    { conflicts },
  );
}

// ── OT charge (gaps 352, 353) ───────────────────────────────────────────────
//
// Gap 352 (retest): a surgery tariff priced at ₹0 was refused and, where one
// existed, ignored, so a deliberate "no charge" case could not be configured;
// and a case could only bill one amount. Two rules now:
//
//   • ₹0 is a price. A tariff at 0 is an explicit no-charge procedure, and
//     Complete posts a labelled "₹0 — no charge" line instead of skipping it.
//     (A negative price is still refused at the tariff API.)
//   • A surgery/procedure tariff can carry component charges — theatre,
//     surgeon, anaesthesia, assistant. Precedence, so nothing is billed twice:
//       1. an amount typed on THIS surgery (billingAmount > 0) — one line;
//       2. else the tariff's components, when any is configured — one line
//          per non-zero component, and the tariff's single basePrice is NOT
//          added on top;
//       3. else the tariff's single basePrice — one line (₹0 = no charge).
//     The tariff is the linked one, else the one active surgery/procedure
//     tariff whose name is exactly the procedure.

export type OtChargeComponent = 'procedure' | 'theatre' | 'surgeon' | 'anaesthesia' | 'assistant';

export interface OtChargeLine {
  component: OtChargeComponent;
  label: string;
  amount: number;
  /**
   * BillItem.referenceType for this line. The FIRST line is always
   * 'ot_request' — the anchor every "already billed?" check looks for — and the
   * rest are 'ot_request_<component>' so the bill's (referenceType,
   * referenceId) de-duplication keeps each component as its own line.
   */
  referenceType: string;
}

export interface OtChargeQuote {
  amount: number;
  source: 'manual' | 'tariff' | 'tariff_match';
  label: string;
  serviceTariffId?: string;
  /** What Complete posts, one bill line each. */
  lines: OtChargeLine[];
  /** An explicit ₹0 price — posted as a labelled no-charge line. */
  noCharge: boolean;
}

/** Every BillItem.referenceType an OT case's charge lines can carry. */
export const OT_CHARGE_REFERENCE_TYPES = [
  'ot_request',
  'ot_request_theatre',
  'ot_request_surgeon',
  'ot_request_anaesthesia',
  'ot_request_assistant',
  'ot_request_procedure',
] as const;

export const OT_NO_CHARGE_LABEL = '₹0 — no charge';

const COMPONENT_LABEL: Record<OtChargeComponent, string> = {
  procedure: 'Procedure charge',
  theatre: 'Theatre charge',
  surgeon: 'Surgeon fee',
  anaesthesia: 'Anaesthesia charge',
  assistant: 'Assistant surgeon fee',
};

export interface OtTariffPricing {
  id: string;
  serviceName: string;
  basePrice: unknown;
  otTheatreCharge?: unknown;
  otSurgeonCharge?: unknown;
  otAnaesthesiaCharge?: unknown;
  otAssistantCharge?: unknown;
}

const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

/** Give the first line the anchor reference type and the rest their own. */
function anchorLines(lines: Array<Omit<OtChargeLine, 'referenceType'>>): OtChargeLine[] {
  return lines.map((l, i) => ({
    ...l,
    referenceType: i === 0 ? 'ot_request' : `ot_request_${l.component}`,
  }));
}

/**
 * The lines a tariff bills (pure — unit-tested). Components when any is
 * configured, else the single basePrice; ₹0 either way is one no-charge line.
 * Null when the tariff carries no usable price at all.
 */
export function tariffChargeLines(t: OtTariffPricing): { lines: OtChargeLine[]; amount: number; noCharge: boolean } | null {
  const components: Array<[OtChargeComponent, number | null]> = [
    ['theatre', money(t.otTheatreCharge)],
    ['surgeon', money(t.otSurgeonCharge)],
    ['anaesthesia', money(t.otAnaesthesiaCharge)],
    ['assistant', money(t.otAssistantCharge)],
  ];
  const configured = components.filter(([, v]) => v !== null) as Array<[OtChargeComponent, number]>;
  if (configured.length > 0) {
    const amount = Math.round(configured.reduce((s, [, v]) => s + v, 0) * 100) / 100;
    if (amount === 0) {
      return {
        amount: 0,
        noCharge: true,
        lines: anchorLines([{ component: 'procedure', label: OT_NO_CHARGE_LABEL, amount: 0 }]),
      };
    }
    return {
      amount,
      noCharge: false,
      lines: anchorLines(
        configured.filter(([, v]) => v > 0).map(([c, v]) => ({ component: c, label: COMPONENT_LABEL[c], amount: v })),
      ),
    };
  }
  const base = money(t.basePrice);
  if (base === null) return null;
  return {
    amount: base,
    noCharge: base === 0,
    lines: anchorLines([
      { component: 'procedure', label: base === 0 ? OT_NO_CHARGE_LABEL : COMPONENT_LABEL.procedure, amount: base },
    ]),
  };
}

/** The bill-line description for one OT charge line. */
export function otChargeLineDescription(line: OtChargeLine, procedureName: string, surgeon: string | null): string {
  const who = surgeon ? ` (${surgeon})` : '';
  if (line.label === OT_NO_CHARGE_LABEL) return `Surgery — ${procedureName}${who} — ${OT_NO_CHARGE_LABEL}`;
  switch (line.component) {
    case 'theatre':
      return `OT theatre charge — ${procedureName}`;
    case 'surgeon':
      return `Surgeon fee — ${procedureName}${who}`;
    case 'anaesthesia':
      return `Anaesthesia charge — ${procedureName}`;
    case 'assistant':
      return `Assistant surgeon fee — ${procedureName}`;
    default:
      return `Surgery — ${procedureName}${who}`;
  }
}

const TARIFF_PRICING_SELECT = {
  id: true,
  serviceName: true,
  basePrice: true,
  otTheatreCharge: true,
  otSurgeonCharge: true,
  otAnaesthesiaCharge: true,
  otAssistantCharge: true,
} as const;

/**
 * The price that will be posted when the surgery completes, or null when none
 * is configured. Only real configured prices: the charge set on the surgery,
 * its linked tariff, or the one active surgery/procedure tariff whose name is
 * exactly the procedure. Nothing is guessed (gap 352). See the precedence above.
 */
export async function resolveOtCharge(
  tenantId: string,
  r: { billingAmount?: unknown; serviceTariffId?: string | null; procedureName: string },
): Promise<OtChargeQuote | null> {
  const manual = Number(r.billingAmount ?? 0);
  if (Number.isFinite(manual) && manual > 0) {
    return {
      amount: manual,
      source: 'manual',
      label: 'OT charge set on this surgery',
      lines: anchorLines([{ component: 'procedure', label: COMPONENT_LABEL.procedure, amount: manual }]),
      noCharge: false,
    };
  }
  const fromTariff = (t: OtTariffPricing, source: 'tariff' | 'tariff_match'): OtChargeQuote | null => {
    const priced = tariffChargeLines(t);
    if (!priced) return null;
    return {
      amount: priced.amount,
      source,
      label: priced.noCharge ? `${OT_NO_CHARGE_LABEL} (tariff: ${t.serviceName})` : `Tariff: ${t.serviceName}`,
      serviceTariffId: t.id,
      lines: priced.lines,
      noCharge: priced.noCharge,
    };
  };
  if (r.serviceTariffId) {
    const t = await prisma.serviceTariff.findFirst({
      where: { id: r.serviceTariffId, tenantId, isActive: true },
      select: TARIFF_PRICING_SELECT,
    });
    const q = t ? fromTariff(t, 'tariff') : null;
    if (q) return q;
  }
  const name = r.procedureName?.trim();
  if (name) {
    const matches = await prisma.serviceTariff.findMany({
      where: {
        tenantId,
        isActive: true,
        category: { in: ['surgery', 'procedure'] },
        serviceName: { equals: name, mode: 'insensitive' },
      },
      select: TARIFF_PRICING_SELECT,
      take: 2,
    });
    // Two tariffs with the same name is ambiguous — do not pick one.
    if ((matches ?? []).length === 1) {
      const q = fromTariff(matches[0], 'tariff_match');
      if (q) return q;
    }
  }
  return null;
}

export const NO_OT_PRICE_MESSAGE =
  'No OT price is configured for this procedure or theater, so nothing will be billed. ' +
  'Set the charge in OT Billing Transactions (or a surgery tariff with this procedure name) to bill it.';

export interface PostedOtCharge {
  amount: number;
  bills: Array<{
    billId: string;
    billNumber: string | null;
    status: string;
    amount: number;
    /** Gap 352: each posted line (theatre / surgeon / anaesthesia / no-charge …). */
    lines: Array<{ description: string; amount: number }>;
  }>;
}

/** What has actually been posted to bills for each surgery — not the planned amount. */
export async function getPostedOtCharges(tenantId: string, ids: string[]): Promise<Map<string, PostedOtCharge>> {
  const out = new Map<string, PostedOtCharge>();
  if (!ids.length) return out;
  const items = await prisma.billItem.findMany({
    where: {
      referenceType: { in: [...OT_CHARGE_REFERENCE_TYPES] },
      referenceId: { in: ids },
      bill: { tenantId, status: { not: 'cancelled' } },
    },
    select: {
      referenceId: true,
      description: true,
      totalAmount: true,
      bill: { select: { id: true, billNumber: true, status: true } },
    },
  });
  for (const it of items ?? []) {
    if (!it.referenceId) continue;
    const amount = Number(it.totalAmount ?? 0);
    const row = out.get(it.referenceId) ?? { amount: 0, bills: [] };
    row.amount += amount;
    // One entry per bill, its lines listed under it.
    let bill = row.bills.find((b) => b.billId === it.bill.id);
    if (!bill) {
      bill = {
        billId: it.bill.id,
        billNumber: it.bill.billNumber ?? null,
        status: String(it.bill.status),
        amount: 0,
        lines: [],
      };
      row.bills.push(bill);
    }
    bill.amount += amount;
    bill.lines.push({ description: (it as { description?: string }).description ?? 'OT charge', amount });
    out.set(it.referenceId, row);
  }
  return out;
}
