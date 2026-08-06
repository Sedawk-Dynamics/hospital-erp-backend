import type { AdmissionStatus } from '@prisma/client';

/**
 * Admission statuses where the patient is PHYSICALLY STILL IN THE HOSPITAL.
 *
 * `ready_to_discharge` means the doctor has published the discharge summary and
 * the patient is clinically cleared — but they are still in the bed, waiting on
 * Front Desk / Billing to clear the final bill. Until that happens they are
 * every bit as present as an `admitted` patient: nurses are still administering
 * medication through eMAR, the ward still raises indents, pharmacy and OT still
 * bill to the stay, the bed still reads occupied and room charges still accrue.
 *
 * So ANY query that means "is this patient here?" must use this set, never a
 * bare `status: 'admitted'`. Getting that wrong makes a signed-off patient
 * silently vanish from the ward the moment the doctor finishes writing —
 * including from their drug chart.
 *
 * Only `discharged` frees the bed and closes the stay.
 */
export const ACTIVE_ADMISSION_STATUSES = ['admitted', 'ready_to_discharge'] as const;

export type ActiveAdmissionStatus = (typeof ACTIVE_ADMISSION_STATUSES)[number];

/** Drop-in for a Prisma `where.status` clause: `{ status: ACTIVE_ADMISSION_STATUS }`. */
export const ACTIVE_ADMISSION_STATUS = {
  in: ACTIVE_ADMISSION_STATUSES as unknown as AdmissionStatus[],
};

/** True while the patient still occupies a bed. */
export function isActiveAdmission(status: AdmissionStatus | string | null | undefined): boolean {
  return (ACTIVE_ADMISSION_STATUSES as readonly string[]).includes(String(status));
}

/**
 * True once the doctor has signed off and the stay is waiting on the counter.
 * Distinct from `isActiveAdmission` — this one is about the billing queue.
 */
export function isReadyToDischarge(status: AdmissionStatus | string | null | undefined): boolean {
  return status === 'ready_to_discharge';
}
