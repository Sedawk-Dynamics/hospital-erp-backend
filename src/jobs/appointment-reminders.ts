import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { formatDateIST, formatTimeIST } from '../shared/date.utils';
import { sendAppointmentReminder } from '../services/email.service';

const TARGET_STATUSES = ['booked', 'confirmed'] as const;

/**
 * Daily appointment reminders.
 *
 * Sweeps appointments scheduled for tomorrow (IST date), and for each one
 * that hasn't already been reminded, emails the patient + creates an
 * in-app notification. Idempotency comes from the Notification table —
 * we skip any appointment that already has a notification with
 * `referenceType=appointment_reminder` and `referenceId=appointment.id`.
 *
 * Safe to run hourly; only sends to those that haven't been reminded yet.
 */
export async function runAppointmentReminderJob(): Promise<{ sent: number; skipped: number }> {
  // Window: start of tomorrow (IST) → end of tomorrow (IST)
  // appointmentDate is stored as `@db.Date` so a UTC start-of-day works for matching.
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const appointments = await prisma.appointment.findMany({
    where: {
      appointmentDate: { gte: tomorrow, lt: dayAfter },
      status: { in: [...TARGET_STATUSES] },
      // Recording a death cancels the patient's future bookings, so this is a
      // belt-and-braces guard for one booked afterwards, or a death recorded
      // straight in the database. Reminding a family about tomorrow's
      // appointment is the worst message this system can send.
      patient: { deceasedAt: null },
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, email: true, userId: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      tenant: { select: { id: true, name: true } },
    },
    take: 500,
  });

  let sent = 0;
  let skipped = 0;

  for (const apt of appointments) {
    // Idempotency check — has this appointment already been reminded?
    const alreadyReminded = await prisma.notification.findFirst({
      where: {
        tenantId: apt.tenantId,
        referenceType: 'appointment_reminder',
        referenceId: apt.id,
      },
      select: { id: true },
    });
    if (alreadyReminded) {
      skipped += 1;
      continue;
    }

    const patientName = `${apt.patient.firstName} ${apt.patient.lastName}`.trim();
    const doctorName = apt.doctor.user
      ? `${apt.doctor.user.firstName} ${apt.doctor.user.lastName}`.trim()
      : 'your doctor';
    const dateStr = formatDateIST(apt.appointmentDate);
    const timeStr = formatTimeIST(apt.startTime);
    const hospitalName = apt.tenant.name ?? 'your hospital';

    // 1. Email — only if patient has an email on file
    if (apt.patient.email) {
      await sendAppointmentReminder(
        apt.patient.email,
        patientName,
        doctorName,
        dateStr,
        timeStr,
        hospitalName,
      ).catch((err) =>
        logger.warn({ err, appointmentId: apt.id }, 'Appointment reminder email failed'),
      );
    }

    // 2. In-app notification — only if patient has a linked User account
    const recipientUserId = apt.patient.userId;
    if (recipientUserId) {
      await prisma.notification
        .create({
          data: {
            tenantId: apt.tenantId,
            userId: recipientUserId,
            title: 'Appointment reminder',
            message: `Reminder: appointment with Dr. ${doctorName} on ${dateStr} at ${timeStr}.`,
            notificationType: 'appointment',
            channel: apt.patient.email ? 'email' : 'in_app',
            referenceType: 'appointment_reminder',
            referenceId: apt.id,
            sentAt: new Date(),
          },
        })
        .catch((err) =>
          logger.warn({ err, appointmentId: apt.id }, 'Appointment reminder notification failed'),
        );
    } else {
      // No portal account — still record a tenant-scoped sentinel notification
      // (against the booker) so the idempotency lookup works on the next sweep.
      const sentinelUserId = apt.bookedBy;
      if (sentinelUserId) {
        await prisma.notification
          .create({
            data: {
              tenantId: apt.tenantId,
              userId: sentinelUserId,
              title: 'Appointment reminder sent',
              message: `Reminder for ${patientName}'s appointment with Dr. ${doctorName} on ${dateStr} at ${timeStr} was dispatched.`,
              notificationType: 'appointment',
              channel: 'in_app',
              referenceType: 'appointment_reminder',
              referenceId: apt.id,
              isRead: true,
              sentAt: new Date(),
            },
          })
          .catch(() => {});
      }
    }

    sent += 1;
  }

  if (sent || skipped) {
    logger.info({ sent, skipped, total: appointments.length }, 'Appointment reminders processed');
  }

  return { sent, skipped };
}
