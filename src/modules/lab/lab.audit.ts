import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { sendLabReport, sendEmail } from '../../services/email.service';

// All writes here are best-effort: failure to log an audit row or send a
// notification must never abort the underlying lab workflow.

export type LabAuditAction = 'create' | 'update' | 'delete';

export async function safeLabAudit(params: {
  tenantId: string;
  userId: string;
  action: LabAuditAction;
  entityType: string;
  entityId: string;
  description?: string;
  oldValues?: any;
  newValues?: any;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        description: params.description,
        oldValues: params.oldValues ?? undefined,
        newValues: params.newValues ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to write lab audit log');
  }
}

export async function safeLabReportEmail(params: {
  toEmail?: string | null;
  patientName: string;
  reportDate: string;
  hospitalName: string;
  testSummary: string;
}) {
  if (!params.toEmail) return;
  try {
    await sendLabReport(
      params.toEmail,
      params.patientName,
      params.testSummary,
      params.reportDate,
      params.hospitalName,
    );
  } catch (err) {
    logger.warn({ err, toEmail: params.toEmail }, 'Failed to send lab report email');
  }
}

export async function safeLabReportCorrectedEmail(params: {
  toEmail?: string | null;
  patientName: string;
  reportDate: string;
  hospitalName: string;
  correctionNotes: string;
}) {
  if (!params.toEmail) return;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Lab Report Updated</h2>
      <p>Dear ${params.patientName},</p>
      <p>An updated version of your lab report from <strong>${params.hospitalName}</strong> has been issued
      on ${params.reportDate}. Please review the latest version in your patient portal.</p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Reason for correction:</strong></p>
        <p>${params.correctionNotes}</p>
      </div>
      <p>If you have questions, please consult your doctor.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>${params.hospitalName} Lab Department</strong></p>
    </div>
  `;
  try {
    await sendEmail({
      to: params.toEmail,
      subject: `Updated Lab Report - ${params.hospitalName}`,
      html,
      text: `Dear ${params.patientName}, an updated lab report from ${params.hospitalName} dated ${params.reportDate} is available. Reason: ${params.correctionNotes}. Log in to your patient portal to review.`,
    });
  } catch (err) {
    logger.warn({ err, toEmail: params.toEmail }, 'Failed to send corrected lab report email');
  }
}
