import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../config/logger';

// SMTP configuration from environment variables
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@hospital-erp.com';

let transporter: Transporter | null = null;

/**
 * Initialize the SMTP transporter.
 * If SMTP is not configured, logs a warning and operates in no-op mode.
 */
function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    logger.warn(
      'SMTP not configured. Email sending is disabled. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables to enable email.',
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  logger.info({ host: SMTP_HOST, port: SMTP_PORT }, 'SMTP transporter initialized');
  return transporter;
}

// Shared email sending options
interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send a generic email.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logger.warn({ to: options.to, subject: options.subject }, 'Email not sent - SMTP not configured');
    return false;
  }

  try {
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    logger.info({ messageId: info.messageId, to: options.to, subject: options.subject }, 'Email sent successfully');
    return true;
  } catch (err) {
    logger.error({ err, to: options.to, subject: options.subject }, 'Failed to send email');
    return false;
  }
}

/**
 * Send a welcome email to a newly registered user.
 */
export async function sendWelcomeEmail(to: string, name: string, tenantName: string): Promise<boolean> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Welcome to ${tenantName}!</h2>
      <p>Dear ${name},</p>
      <p>Your account has been created successfully on our Hospital ERP system.</p>
      <p>You can now log in to access your dashboard and manage your healthcare information.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>${tenantName} Administration</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Welcome to ${tenantName} - Account Created`,
    html,
    text: `Welcome to ${tenantName}! Dear ${name}, your account has been created successfully.`,
  });
}

/**
 * Send a password reset email with a reset link.
 */
export async function sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<boolean> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Password Reset Request</h2>
      <p>Dear ${name},</p>
      <p>We received a request to reset your password. Click the button below to set a new password:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetLink}" style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Reset Password
        </a>
      </div>
      <p>If you did not request a password reset, please ignore this email. This link will expire in 1 hour.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>Hospital ERP Administration</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: 'Password Reset Request',
    html,
    text: `Dear ${name}, we received a request to reset your password. Visit this link to reset: ${resetLink}. This link expires in 1 hour.`,
  });
}

/**
 * Send an appointment reminder email.
 */
export async function sendAppointmentReminder(
  to: string,
  patientName: string,
  doctorName: string,
  appointmentDate: string,
  appointmentTime: string,
  hospitalName: string,
): Promise<boolean> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Appointment Reminder</h2>
      <p>Dear ${patientName},</p>
      <p>This is a reminder for your upcoming appointment:</p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Doctor:</strong> Dr. ${doctorName}</p>
        <p><strong>Date:</strong> ${appointmentDate}</p>
        <p><strong>Time:</strong> ${appointmentTime}</p>
        <p><strong>Hospital:</strong> ${hospitalName}</p>
      </div>
      <p>Please arrive 15 minutes before your scheduled appointment time.</p>
      <p>If you need to reschedule or cancel, please contact us at least 24 hours in advance.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>${hospitalName}</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Appointment Reminder - ${appointmentDate} at ${appointmentTime}`,
    html,
    text: `Dear ${patientName}, reminder for your appointment with Dr. ${doctorName} on ${appointmentDate} at ${appointmentTime} at ${hospitalName}.`,
  });
}

/**
 * Send a lab report notification email.
 */
export async function sendLabReport(
  to: string,
  patientName: string,
  testName: string,
  reportDate: string,
  hospitalName: string,
): Promise<boolean> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Lab Report Available</h2>
      <p>Dear ${patientName},</p>
      <p>Your lab report is now available:</p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Test:</strong> ${testName}</p>
        <p><strong>Report Date:</strong> ${reportDate}</p>
      </div>
      <p>You can view your detailed report by logging into your patient portal.</p>
      <p>If you have any questions about your results, please consult your doctor.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>${hospitalName} Lab Department</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Lab Report Available - ${testName}`,
    html,
    text: `Dear ${patientName}, your lab report for ${testName} dated ${reportDate} is now available. Log in to your patient portal to view the details.`,
  });
}

/**
 * Send a discharge summary published notification email.
 */
export async function sendDischargeSummaryPublishedEmail(
  to: string,
  patientName: string,
  hospitalName: string,
  dischargeDate: string,
  portalUrl?: string,
): Promise<boolean> {
  const cta = portalUrl
    ? `
      <div style="text-align: center; margin: 30px 0;">
        <a href="${portalUrl}" style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
          View in Patient Portal
        </a>
      </div>`
    : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Your Discharge Summary is Ready</h2>
      <p>Dear ${patientName},</p>
      <p>Your discharge summary from <strong>${hospitalName}</strong> has been finalized and is now
      available in your patient portal.</p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Discharge Date:</strong> ${dischargeDate}</p>
        <p><strong>Hospital:</strong> ${hospitalName}</p>
      </div>
      ${cta}
      <p>The summary includes your diagnoses, procedures, medications, key lab results, and follow-up
      instructions. Please review it carefully and contact us if you have any questions.</p>
      <br/>
      <p>Wishing you a speedy recovery,</p>
      <p><strong>${hospitalName}</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Discharge Summary Available - ${hospitalName}`,
    html,
    text: `Dear ${patientName}, your discharge summary from ${hospitalName} (discharge date ${dischargeDate}) is now available in your patient portal${portalUrl ? `: ${portalUrl}` : ''}.`,
  });
}

/**
 * Send a bill notification email.
 */
export async function sendBillNotification(
  to: string,
  patientName: string,
  billNumber: string,
  totalAmount: number,
  dueDate: string,
  hospitalName: string,
): Promise<boolean> {
  const formattedAmount = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(totalAmount);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Bill Notification</h2>
      <p>Dear ${patientName},</p>
      <p>A new bill has been generated for your recent visit:</p>
      <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Bill Number:</strong> ${billNumber}</p>
        <p><strong>Total Amount:</strong> ${formattedAmount}</p>
        <p><strong>Due Date:</strong> ${dueDate}</p>
      </div>
      <p>Please log in to your patient portal to view the detailed bill and make a payment.</p>
      <p>If you have any questions regarding your bill, please contact our billing department.</p>
      <br/>
      <p>Best regards,</p>
      <p><strong>${hospitalName} Billing Department</strong></p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Bill ${billNumber} - Amount Due ${formattedAmount}`,
    html,
    text: `Dear ${patientName}, bill ${billNumber} for ${formattedAmount} is due on ${dueDate}. Log in to your patient portal to view and pay.`,
  });
}
