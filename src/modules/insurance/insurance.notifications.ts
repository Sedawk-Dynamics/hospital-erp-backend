import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { writeNotificationOnce } from '../communication/notification-writer';

/**
 * Best-effort patient-portal milestone messaging. Insurance decisions must not
 * be rolled back because a notification row could not be written, so this
 * helper owns and logs every failure instead of throwing into the caller.
 */
export async function notifyPatientInsuranceMilestone(params: {
  tenantId: string;
  patientId: string;
  title: string;
  message: string;
  referenceType: 'insurance_claim' | 'pre_authorization_request' | 'insurance_case' | 'claim_query';
  referenceId: string;
  alert?: boolean;
}): Promise<boolean> {
  try {
    const patient = await prisma.patient.findFirst({
      where: { id: params.patientId, tenantId: params.tenantId },
      select: { userId: true },
    });
    if (!patient?.userId) return false;

    // Gap 295: idempotent on (tenant, patient user, event, record) through the
    // unique dedupe key — the old findFirst-then-create could double-write
    // when two decisions on one claim landed together.
    const { created } = await writeNotificationOnce({
      tenantId: params.tenantId,
      userId: patient.userId,
      title: params.title,
      message: params.message,
      notificationType: params.alert ? 'alert' : 'general',
      channel: 'in_app',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
    });
    return created;
  } catch (err) {
    logger.warn(
      { err, patientId: params.patientId, referenceType: params.referenceType, referenceId: params.referenceId },
      'Patient insurance milestone notification failed',
    );
    return false;
  }
}
