/**
 * Recording a patient death.
 *
 * Test Report 3 (D6) asks for an explicit workflow for a death that happens
 * before the patient has even been identified. Nothing existed: the only way to
 * close a stay was `discharged`, so a death was filed as the patient having
 * gone home, with the fact of it surviving — if at all — as free text in a
 * discharge reason.
 *
 * Two things follow from "before identification":
 *
 *   1. The fact belongs to the PATIENT, not to an admission. Someone brought in
 *      dead, or dying in casualty before admission, has no admission to close.
 *   2. Nothing may be deleted. The report is explicit that charges and clinical
 *      events recorded under a temporary ID must survive, and they are also
 *      what the death certificate and any inquiry are written from.
 *
 * So this closes the encounters a living patient would have had open, and
 * touches no bill, no order and no note.
 */
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';

export interface RecordDeathInput {
  /** When they died — not when someone got round to entering it. */
  deceasedAt?: string | Date;
  /** Free text: place, circumstance, certifying doctor if not the recorder. */
  note?: string | null;
}

export interface RecordDeathResult {
  patientId: string;
  deceasedAt: Date;
  /** The stay closed as `deceased`, when there was one. */
  admissionClosed: string | null;
  bedReleased: boolean;
  visitsClosed: number;
  appointmentsCancelled: number;
}

/**
 * Record that a patient has died.
 *
 * Safe to call whether or not they were ever admitted — that is the point.
 */
export async function recordPatientDeath(
  tenantId: string,
  patientId: string,
  userId: string,
  data: RecordDeathInput = {},
): Promise<RecordDeathResult> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true, mrn: true, deceasedAt: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  if (patient.deceasedAt) {
    // Not an idempotent no-op: recording a second, different date would
    // silently rewrite a legal fact.
    throw AppError.badRequest(
      `A death is already recorded for this patient on ${patient.deceasedAt.toISOString().slice(0, 10)}.`,
    );
  }

  const deceasedAt = data.deceasedAt ? new Date(data.deceasedAt) : new Date();
  if (Number.isNaN(deceasedAt.getTime())) {
    throw AppError.badRequest('Invalid date of death');
  }
  if (deceasedAt.getTime() > Date.now() + 60_000) {
    // A minute of slack for clock skew; beyond that it is a typo.
    throw AppError.badRequest('A date of death cannot be in the future');
  }

  return prisma.$transaction(async (tx) => {
    await tx.patient.update({
      where: { id: patientId },
      data: {
        deceasedAt,
        deceasedRecordedBy: userId,
        deceasedNote: data.note?.trim() || null,
        // isActive is left alone deliberately — it is a soft-delete flag, and
        // the record has to stay readable and billable.
      },
    });

    // The stay, if there is one. `deceased` rather than `discharged`: the bill,
    // the portal and every report otherwise say the patient went home.
    const admission = await tx.admission.findFirst({
      where: { tenantId, patientId, status: ACTIVE_ADMISSION_STATUS },
      orderBy: { admissionDate: 'desc' },
      select: { id: true, bedId: true },
    });

    let bedReleased = false;
    if (admission) {
      await tx.admission.update({
        where: { id: admission.id },
        data: { status: 'deceased', dischargeDate: deceasedAt, dischargedBy: userId },
      });
      if (admission.bedId) {
        // Guarded on currentPatientId in case a transfer already moved them.
        const freed = await tx.bed.updateMany({
          where: { id: admission.bedId, currentPatientId: patientId },
          data: { status: 'available', currentPatientId: null },
        });
        bedReleased = freed.count > 0;
      }
    }

    // Any encounter still open. Left open, a dead patient keeps appearing on
    // ward lists, OPD queues and "who is here" counts.
    const visits = await tx.visit.updateMany({
      where: { tenantId, patientId, status: 'active' },
      data: { status: 'completed' },
    });

    // Future bookings. This is the one with a voice: the reminder job reads
    // appointments and has no notion of a patient being dead, so leaving these
    // standing means texting the family about an appointment.
    const appts = await tx.appointment.updateMany({
      where: {
        tenantId,
        patientId,
        status: { in: ['pending_payment', 'booked', 'confirmed', 'checked_in', 'waiting'] },
      },
      data: { status: 'cancelled', cancellationReason: 'Patient deceased', cancelledBy: userId },
    });

    logger.info(
      {
        tenantId,
        patientId,
        mrn: patient.mrn,
        recordedBy: userId,
        admissionClosed: admission?.id ?? null,
        visitsClosed: visits.count,
        appointmentsCancelled: appts.count,
      },
      'Patient death recorded',
    );

    return {
      patientId,
      deceasedAt,
      admissionClosed: admission?.id ?? null,
      bedReleased,
      visitsClosed: visits.count,
      appointmentsCancelled: appts.count,
    };
  });
}

/**
 * Undo a death recorded against the wrong patient.
 *
 * Mis-identification is exactly what the unidentified-patient flow is prone to,
 * and a death recorded on the wrong record with no way back would be worse than
 * the gap this closes. It clears the patient-level fact and reopens the stay;
 * it does NOT try to un-cancel appointments or reopen visits, because those are
 * ordinary operations someone can redo deliberately, and guessing at them would
 * resurrect bookings nobody asked for.
 */
export async function clearPatientDeath(
  tenantId: string,
  patientId: string,
  userId: string,
  reason: string,
): Promise<{ patientId: string; admissionReopened: string | null }> {
  if (!reason?.trim()) {
    throw AppError.badRequest('A reason is required to remove a recorded death');
  }

  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true, mrn: true, deceasedAt: true, deceasedNote: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');
  if (!patient.deceasedAt) throw AppError.badRequest('No death is recorded for this patient');

  return prisma.$transaction(async (tx) => {
    // The correction is appended to the note rather than replacing it: what was
    // recorded, and that it was withdrawn, both matter afterwards.
    const trail = [
      patient.deceasedNote?.trim(),
      `[Death record removed on ${new Date().toISOString().slice(0, 10)}: ${reason.trim()}]`,
    ]
      .filter(Boolean)
      .join('\n');

    await tx.patient.update({
      where: { id: patientId },
      data: { deceasedAt: null, deceasedRecordedBy: null, deceasedNote: trail },
    });

    const admission = await tx.admission.findFirst({
      where: { tenantId, patientId, status: 'deceased' },
      orderBy: { admissionDate: 'desc' },
      select: { id: true },
    });
    if (admission) {
      await tx.admission.update({
        where: { id: admission.id },
        data: { status: 'admitted', dischargeDate: null, dischargedBy: null },
      });
    }

    logger.warn(
      { tenantId, patientId, mrn: patient.mrn, removedBy: userId, reason: reason.trim() },
      'Recorded patient death removed',
    );

    return { patientId, admissionReopened: admission?.id ?? null };
  });
}
