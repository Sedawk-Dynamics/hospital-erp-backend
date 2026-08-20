/**
 * Where a diagnostic order's patient is in their consultation.
 *
 * Lab and radiology see an order arrive with no sense of what the patient is
 * doing. In OPD the order is normally raised mid-consultation: the doctor sends
 * the patient down, the test runs, the patient goes back with the result. But a
 * row in the queue looks identical whether the doctor has seen the patient or
 * the patient is still sitting in the waiting room, so the department cannot
 * tell when it is reasonable to start work — or start a report.
 *
 * This resolves that in one batched query for a page of orders, rather than a
 * lookup per row.
 */
import { prisma } from '../config/database';

export type ConsultationState =
  /** Booked/checked in, but the doctor has not started. */
  | 'awaiting'
  /** The doctor has the patient now. */
  | 'in_consultation'
  /** The consultation is finished. */
  | 'done'
  /**
   * No consultation stands behind this order — no appointment at all (a direct
   * or temporary registration), or one that was cancelled / not attended.
   */
  | 'none';

export interface ConsultationInfo {
  state: ConsultationState;
  /** 'op' | 'ip' | … — an inpatient has rounds, not a consultation. */
  visitType: string;
  doctorName: string | null;
}

/** Appointment states that mean the doctor has not begun. */
const NOT_STARTED = new Set(['pending_payment', 'booked', 'confirmed', 'checked_in', 'waiting']);

/** States where the consultation is not going to happen at all. */
const ABANDONED = new Set(['cancelled', 'no_show']);

export async function resolveConsultationStates(
  tenantId: string,
  visitIds: Array<string | null | undefined>,
): Promise<Map<string, ConsultationInfo>> {
  const out = new Map<string, ConsultationInfo>();
  const ids = [...new Set(visitIds.filter((v): v is string => !!v))];
  if (!ids.length) return out;

  const visits = await prisma.visit.findMany({
    where: { id: { in: ids }, tenantId },
    select: {
      id: true,
      status: true,
      visitType: true,
      appointment: { select: { status: true } },
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  for (const v of visits) {
    const u = v.doctor?.user;
    const doctorName = u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null : null;
    const apptStatus = v.appointment?.status as string | undefined;

    let state: ConsultationState;
    if (!apptStatus) {
      // A visit with no appointment — a temporary registration, or an
      // encounter opened directly. Nothing to report either way.
      state = 'none';
    } else if (ABANDONED.has(apptStatus)) {
      // Cancelled or not attended, and this is checked before the closed-visit
      // rule below — closing the visit of a cancelled appointment must not
      // read as "consultation done". 'awaiting' would imply one is still
      // coming; an order with no consultation behind it is worth seeing plainly.
      state = 'none';
    } else if (apptStatus === 'completed' || v.status !== 'active') {
      // Either the doctor closed the consultation, or the visit itself is no
      // longer open. A closed visit cannot still be mid-consultation.
      state = 'done';
    } else if (NOT_STARTED.has(apptStatus)) {
      state = 'awaiting';
    } else {
      // in_consultation, and anything new that is neither finished nor waiting.
      state = 'in_consultation';
    }

    out.set(v.id, { state, visitType: v.visitType as string, doctorName });
  }

  return out;
}
