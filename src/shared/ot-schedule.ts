import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../config/logger';

// ============================================================
// OT reschedule ↔ doctor-confirmation state
// ============================================================
//
// The doctor raises an OT request with a *preferred* date/time. The OT admin
// then schedules the real slot. When that slot differs from what the doctor
// asked for, the booking is a **proposal**: the doctor must accept it before
// the surgery can start, or they can counter-propose a new preferred time, or
// cancel outright.
//
// This lives in columns on `ot_requests` rather than in the OtRequestStatus
// enum, so no enum migration is needed and every existing status transition
// keeps working untouched. The columns are read and written with raw SQL
// because the Prisma client is not regenerated while the Windows dev server
// holds the query-engine DLL (same pattern as `admissions.admission_type`).
// Once `prisma generate` runs, typed access becomes available and these
// helpers can be simplified.

/** Booking is final — either the admin took the doctor's slot, or the doctor accepted. */
export const SCHEDULE_CONFIRMED = 'confirmed';
/** Admin proposed a different slot; waiting on the doctor to accept / counter / cancel. */
export const SCHEDULE_AWAITING_DOCTOR = 'awaiting_doctor';

export type OtScheduleState = typeof SCHEDULE_CONFIRMED | typeof SCHEDULE_AWAITING_DOCTOR;
export type OtDoctorResponse = 'accepted' | 'rejected';

export interface OtScheduleMeta {
  scheduleState: OtScheduleState | null;
  rescheduleReason: string | null;
  rescheduledBy: string | null;
  rescheduledAt: string | null;
  previousScheduledDate: string | null;
  previousScheduledTime: string | null;
  doctorResponse: OtDoctorResponse | null;
  doctorResponseNote: string | null;
  doctorRespondedAt: string | null;
  rescheduleCount: number;
}

export const EMPTY_OT_SCHEDULE_META: OtScheduleMeta = {
  scheduleState: null,
  rescheduleReason: null,
  rescheduledBy: null,
  rescheduledAt: null,
  previousScheduledDate: null,
  previousScheduledTime: null,
  doctorResponse: null,
  doctorResponseNote: null,
  doctorRespondedAt: null,
  rescheduleCount: 0,
};

// ── Self-healing DDL ────────────────────────────────────────────────────────
// Adds the columns on first use if a database predates this feature, so a
// deployment that has not run `prisma db push` still works. Idempotent and
// memoised per process.

let columnsReady: Promise<void> | null = null;

export function ensureOtScheduleColumns(): Promise<void> {
  if (!columnsReady) {
    columnsReady = (async () => {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ot_requests
          ADD COLUMN IF NOT EXISTS schedule_state VARCHAR(24),
          ADD COLUMN IF NOT EXISTS reschedule_reason TEXT,
          ADD COLUMN IF NOT EXISTS rescheduled_by TEXT,
          ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS previous_scheduled_date DATE,
          ADD COLUMN IF NOT EXISTS previous_scheduled_time VARCHAR(10),
          ADD COLUMN IF NOT EXISTS doctor_response VARCHAR(20),
          ADD COLUMN IF NOT EXISTS doctor_response_note TEXT,
          ADD COLUMN IF NOT EXISTS doctor_responded_at TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0
      `);
    })().catch((err) => {
      // Reset so a transient failure can be retried on the next call rather
      // than poisoning every subsequent request.
      columnsReady = null;
      logger.error({ err }, 'Failed to ensure OT schedule columns');
      throw err;
    });
  }
  return columnsReady;
}

// ── Read ────────────────────────────────────────────────────────────────────

interface MetaRow {
  id: string;
  schedule_state: string | null;
  reschedule_reason: string | null;
  rescheduled_by: string | null;
  rescheduled_at: Date | null;
  previous_scheduled_date: Date | null;
  previous_scheduled_time: string | null;
  doctor_response: string | null;
  doctor_response_note: string | null;
  doctor_responded_at: Date | null;
  reschedule_count: number | null;
}

function toMeta(row: MetaRow): OtScheduleMeta {
  return {
    scheduleState: (row.schedule_state as OtScheduleState | null) ?? null,
    rescheduleReason: row.reschedule_reason,
    rescheduledBy: row.rescheduled_by,
    rescheduledAt: row.rescheduled_at ? row.rescheduled_at.toISOString() : null,
    previousScheduledDate: row.previous_scheduled_date
      ? row.previous_scheduled_date.toISOString()
      : null,
    previousScheduledTime: row.previous_scheduled_time,
    doctorResponse: (row.doctor_response as OtDoctorResponse | null) ?? null,
    doctorResponseNote: row.doctor_response_note,
    doctorRespondedAt: row.doctor_responded_at ? row.doctor_responded_at.toISOString() : null,
    rescheduleCount: Number(row.reschedule_count ?? 0),
  };
}

/** Schedule meta for a set of OT request ids, keyed by id. */
export async function getOtScheduleMeta(ids: string[]): Promise<Map<string, OtScheduleMeta>> {
  const map = new Map<string, OtScheduleMeta>();
  if (ids.length === 0) return map;
  await ensureOtScheduleColumns();
  const rows = await prisma.$queryRaw<MetaRow[]>`
    SELECT id, schedule_state, reschedule_reason, rescheduled_by, rescheduled_at,
           previous_scheduled_date, previous_scheduled_time,
           doctor_response, doctor_response_note, doctor_responded_at, reschedule_count
    FROM ot_requests
    WHERE id IN (${Prisma.join(ids)})
  `;
  for (const r of rows) map.set(r.id, toMeta(r));
  return map;
}

export async function getOneOtScheduleMeta(id: string): Promise<OtScheduleMeta> {
  const map = await getOtScheduleMeta([id]);
  return map.get(id) ?? EMPTY_OT_SCHEDULE_META;
}

/** Merge the schedule meta onto an OT request row (or list of them). */
export function attachOtScheduleMeta<T extends { id: string }>(
  row: T,
  meta: Map<string, OtScheduleMeta>,
): T & OtScheduleMeta {
  return { ...row, ...(meta.get(row.id) ?? EMPTY_OT_SCHEDULE_META) };
}

// ── Write ───────────────────────────────────────────────────────────────────

/** Record the admin's (re)schedule proposal. */
export async function recordReschedule(
  id: string,
  args: {
    state: OtScheduleState;
    reason: string | null;
    byUserId: string;
    previousDate: Date | string | null;
    previousTime: string | null;
    /** Bump the counter only when this actually moved an existing booking. */
    countsAsReschedule: boolean;
  },
): Promise<void> {
  await ensureOtScheduleColumns();
  // Every parameter is explicitly cast: Postgres cannot infer a type for a bare
  // placeholder in `reschedule_count + $n` or against a DATE column, and errors
  // out with "could not determine data type of parameter".
  await prisma.$executeRaw`
    UPDATE ot_requests SET
      schedule_state = ${args.state}::varchar,
      reschedule_reason = ${args.reason}::text,
      rescheduled_by = ${args.byUserId}::text,
      rescheduled_at = now(),
      previous_scheduled_date = ${toDateKey(args.previousDate)}::date,
      previous_scheduled_time = ${args.previousTime}::varchar,
      -- A fresh proposal supersedes any earlier doctor answer.
      doctor_response = NULL,
      doctor_response_note = NULL,
      doctor_responded_at = NULL,
      reschedule_count = reschedule_count + ${args.countsAsReschedule ? 1 : 0}::int
    WHERE id = ${id}
  `;
}

/** Record the doctor's answer to a proposal. */
export async function recordDoctorResponse(
  id: string,
  args: { response: OtDoctorResponse; note: string | null; state: OtScheduleState | null },
): Promise<void> {
  await ensureOtScheduleColumns();
  await prisma.$executeRaw`
    UPDATE ot_requests SET
      doctor_response = ${args.response}::varchar,
      doctor_response_note = ${args.note}::text,
      doctor_responded_at = now(),
      schedule_state = ${args.state}::varchar
    WHERE id = ${id}
  `;
}

/** Clear the proposal entirely — used when the doctor counter-proposes. */
export async function clearScheduleProposal(id: string): Promise<void> {
  await ensureOtScheduleColumns();
  await prisma.$executeRaw`
    UPDATE ot_requests SET
      schedule_state = NULL,
      previous_scheduled_date = NULL,
      previous_scheduled_time = NULL
    WHERE id = ${id}
  `;
}

// ── Slot helpers ────────────────────────────────────────────────────────────

/** yyyy-MM-dd for a Date (or a date-ish string), in UTC — DB dates are date-only. */
export function toDateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** HH:mm from an "HH:mm[:ss]" string or a time-only Date column. */
export function toTimeKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : null;
  }
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(11, 16);
}

/**
 * True when the two slots are the same date *and* the same start time.
 * A slot with no date never matches — there is nothing to compare against.
 */
export function sameSlot(
  a: { date: Date | string | null | undefined; time: Date | string | null | undefined },
  b: { date: Date | string | null | undefined; time: Date | string | null | undefined },
): boolean {
  const aDate = toDateKey(a.date);
  const bDate = toDateKey(b.date);
  if (!aDate || !bDate || aDate !== bDate) return false;
  return toTimeKey(a.time) === toTimeKey(b.time);
}
