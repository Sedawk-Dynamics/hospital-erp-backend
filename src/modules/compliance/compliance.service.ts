import { Prisma } from '@prisma/client';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { istDayStart, istDayEnd, istDayRange } from '../../shared/date.utils';
import type {
  CreateTicketInput,
  UpdateTicketInput,
  AssignTicketInput,
  CloseTicketInput,
  GetTicketsQuery,
  SubmitFeedbackInput,
  RespondToFeedbackInput,
  GetFeedbackQuery,
  GetAuditLogsQuery,
  CreateComplianceDocInput,
  UpdateComplianceDocInput,
  GetComplianceDocsQuery,
  CreateOtRequestInput,
  ScheduleOtInput,
  GetOtRequestsQuery,
  UpdateOtRequestInput,
  CreateOtInput,
  UpdateOtInput,
  UpdateOtSettingsInput,
  ReportIncidentInput,
  UpdateIncidentInput,
  InvestigateIncidentInput,
  CloseIncidentInput,
  GetIncidentsQuery,
  OtScheduleResponseInput,
} from './compliance.validation';
import {
  SCHEDULE_AWAITING_DOCTOR,
  SCHEDULE_CONFIRMED,
  attachOtScheduleMeta,
  clearScheduleProposal,
  getOneOtScheduleMeta,
  getOtScheduleMeta,
  recordDoctorResponse,
  recordReschedule,
  sameSlot,
  toDateKey,
  toTimeKey,
} from '../../shared/ot-schedule';

// ============================================================
// Tickets
// ============================================================

export async function createTicket(tenantId: string, userId: string, data: CreateTicketInput) {
  // Generate ticket number
  const count = await prisma.ticket.count({ where: { tenantId } });
  const ticketNumber = `TKT-${String(count + 1).padStart(6, '0')}`;

  const ticket = await prisma.ticket.create({
    data: {
      tenantId,
      ticketNumber,
      raisedBy: userId,
      ticketType: data.ticketType,
      subject: data.subject,
      description: data.description,
      priority: data.priority,
      patientId: data.patientId,
      departmentId: data.departmentId,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, ticketId: ticket.id }, 'Ticket created');
  return ticket;
}

export async function getTickets(tenantId: string, query: GetTicketsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.priority) {
    where.priority = query.priority;
  }

  if (query.ticketType) {
    where.ticketType = query.ticketType;
  }

  if (query.assignedTo) {
    where.assignedTo = query.assignedTo;
  }

  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { ticketNumber: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      skip,
      take,
      include: {
        raiser: { select: { id: true, firstName: true, lastName: true } },
        assignee: { select: { id: true, firstName: true, lastName: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets, total, page, limit };
}

export async function getTicketById(tenantId: string, id: string) {
  const ticket = await prisma.ticket.findFirst({
    where: { id, tenantId },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true, email: true } },
      assignee: { select: { id: true, firstName: true, lastName: true, email: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  });

  if (!ticket) {
    throw AppError.notFound('Ticket not found');
  }

  return ticket;
}

export async function updateTicket(tenantId: string, id: string, data: UpdateTicketInput) {
  const ticket = await prisma.ticket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Cannot update a closed ticket');
  }

  const updated = await prisma.ticket.update({
    where: { id },
    data: {
      subject: data.subject,
      description: data.description,
      priority: data.priority,
      status: data.status,
      departmentId: data.departmentId,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
      assignee: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, ticketId: id }, 'Ticket updated');
  return updated;
}

export async function assignTicket(tenantId: string, id: string, data: AssignTicketInput) {
  const ticket = await prisma.ticket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Cannot assign a closed ticket');
  }

  // Verify assignee exists
  const assignee = await prisma.user.findFirst({
    where: { id: data.assignedTo, tenantId },
  });

  if (!assignee) {
    throw AppError.notFound('Assignee user not found');
  }

  const updated = await prisma.ticket.update({
    where: { id },
    data: {
      assignedTo: data.assignedTo,
      status: ticket.status === 'open' ? 'in_progress' : ticket.status,
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
      assignee: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, ticketId: id, assignedTo: data.assignedTo }, 'Ticket assigned');
  return updated;
}

export async function closeTicket(tenantId: string, id: string, userId: string, data: CloseTicketInput) {
  const ticket = await prisma.ticket.findFirst({
    where: { id, tenantId },
  });

  if (!ticket) {
    throw AppError.notFound('Ticket not found');
  }

  if (ticket.status === 'closed') {
    throw AppError.badRequest('Ticket is already closed');
  }

  const updated = await prisma.ticket.update({
    where: { id },
    data: {
      status: 'closed',
      resolutionNotes: data.resolutionNotes,
      resolvedAt: new Date(),
    },
    include: {
      raiser: { select: { id: true, firstName: true, lastName: true } },
      assignee: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, ticketId: id, closedBy: userId }, 'Ticket closed');
  return updated;
}

// ============================================================
// Feedback
// ============================================================

export async function submitFeedback(tenantId: string, userId: string, data: SubmitFeedbackInput) {
  const feedback = await prisma.feedback.create({
    data: {
      tenantId,
      submittedBy: userId,
      feedbackType: data.feedbackType,
      subject: data.subject,
      content: data.content,
      rating: data.rating,
      patientId: data.patientId,
      doctorId: data.doctorId,
      departmentId: data.departmentId,
    },
    include: {
      submitter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { select: { id: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, feedbackId: feedback.id }, 'Feedback submitted');
  return feedback;
}

export async function getFeedback(tenantId: string, query: GetFeedbackQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.feedbackType) {
    where.feedbackType = query.feedbackType;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.doctorId) {
    where.doctorId = query.doctorId;
  }

  if (query.departmentId) {
    where.departmentId = query.departmentId;
  }

  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { content: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [feedbackList, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      skip,
      take,
      include: {
        submitter: { select: { id: true, firstName: true, lastName: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.feedback.count({ where }),
  ]);

  return { feedbackList, total, page, limit };
}

export async function getFeedbackById(tenantId: string, id: string) {
  const feedback = await prisma.feedback.findFirst({
    where: { id, tenantId },
    include: {
      submitter: { select: { id: true, firstName: true, lastName: true, email: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { select: { id: true } },
      department: { select: { id: true, name: true } },
    },
  });

  if (!feedback) {
    throw AppError.notFound('Feedback not found');
  }

  return feedback;
}

export async function respondToFeedback(
  tenantId: string,
  id: string,
  userId: string,
  data: RespondToFeedbackInput,
) {
  const feedback = await prisma.feedback.findFirst({
    where: { id, tenantId },
  });

  if (!feedback) {
    throw AppError.notFound('Feedback not found');
  }

  const updated = await prisma.feedback.update({
    where: { id },
    data: {
      adminResponse: data.adminResponse,
      status: data.status,
    },
    include: {
      submitter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, feedbackId: id, respondedBy: userId }, 'Feedback responded to');
  return updated;
}

// ============================================================
// Audit Logs
// ============================================================

export async function getAuditLogs(tenantId: string, query: GetAuditLogsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.userId) {
    where.userId = query.userId;
  }

  if (query.action) {
    where.action = query.action;
  }

  if (query.entityType) {
    where.entityType = query.entityType;
  }

  // IST calendar-day bounds. `new Date(toDate)` is midnight UTC, so the chosen
  // end date was excluded entirely — and the Audit Logs page defaults `toDate`
  // to today, which meant today's actions never appeared in the trail at all.
  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: istDayStart(query.fromDate) };
  }

  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: istDayEnd(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { entityType: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total, page, limit };
}

export async function getAuditLogById(tenantId: string, id: string) {
  const log = await prisma.auditLog.findFirst({
    where: { id, tenantId },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!log) {
    throw AppError.notFound('Audit log not found');
  }

  return log;
}

export async function getAuditLogsByEntity(
  tenantId: string,
  entityType: string,
  entityId: string,
  query: { page: number; limit: number; sortOrder?: 'asc' | 'desc'; search?: string; sortBy?: string },
) {
  const { skip, take, page, limit } = getPaginationParams({
    ...query,
    sortOrder: query.sortOrder || 'desc',
  });

  const where = { tenantId, entityType, entityId };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total, page, limit };
}

// ============================================================
// Compliance Documents
// ============================================================

export async function createComplianceDoc(tenantId: string, userId: string, data: CreateComplianceDocInput) {
  const doc = await prisma.complianceDocument.create({
    data: {
      tenantId,
      documentType: data.documentType,
      title: data.title,
      description: data.description,
      fileUrl: data.fileUrl,
      issuedDate: data.issuedDate ? new Date(data.issuedDate) : undefined,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
      uploadedBy: userId,
    },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, documentId: doc.id }, 'Compliance document created');
  return doc;
}

export async function getComplianceDocs(tenantId: string, query: GetComplianceDocsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.documentType) {
    where.documentType = query.documentType;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [documents, total] = await Promise.all([
    prisma.complianceDocument.findMany({
      where,
      skip,
      take,
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.complianceDocument.count({ where }),
  ]);

  return { documents, total, page, limit };
}

export async function getComplianceDocById(tenantId: string, id: string) {
  const doc = await prisma.complianceDocument.findFirst({
    where: { id, tenantId },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!doc) {
    throw AppError.notFound('Compliance document not found');
  }

  return doc;
}

export async function updateComplianceDoc(
  tenantId: string,
  id: string,
  data: UpdateComplianceDocInput,
) {
  const doc = await prisma.complianceDocument.findFirst({
    where: { id, tenantId },
  });

  if (!doc) {
    throw AppError.notFound('Compliance document not found');
  }

  const updated = await prisma.complianceDocument.update({
    where: { id },
    data: {
      title: data.title,
      description: data.description,
      fileUrl: data.fileUrl,
      issuedDate: data.issuedDate ? new Date(data.issuedDate) : undefined,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
      status: data.status,
    },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, documentId: id }, 'Compliance document updated');
  return updated;
}

export async function approveComplianceDoc(tenantId: string, id: string, userId: string) {
  const doc = await prisma.complianceDocument.findFirst({
    where: { id, tenantId },
  });

  if (!doc) {
    throw AppError.notFound('Compliance document not found');
  }

  const updated = await prisma.complianceDocument.update({
    where: { id },
    data: {
      status: 'active',
    },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, documentId: id, approvedBy: userId }, 'Compliance document approved');
  return updated;
}

// ============================================================
// OT Requests
// ============================================================

// Maps OT-screen "priority" → DB `urgency` so the UI can keep its EmedHub
// vocabulary (routine/urgent/emergency) while the schema stays canonical.
function mapPriorityToUrgency(p?: string): 'elective' | 'urgent' | 'emergency' | undefined {
  if (!p) return undefined;
  if (p === 'routine') return 'elective';
  if (p === 'urgent') return 'urgent';
  if (p === 'emergency') return 'emergency';
  return undefined;
}

// Shape the OtRequest response so the frontend's `surgeryName`/`priority`
// expectations work without forcing the frontend to know the DB columns.
function shapeOtRequest<T extends { procedureName: string; urgency: string }>(
  r: T,
  meta?: object,
): T & { surgeryName: string; priority: string } {
  return {
    ...r,
    ...(meta ?? {}),
    surgeryName: r.procedureName,
    priority: r.urgency === 'elective' ? 'routine' : r.urgency,
  } as T & { surgeryName: string; priority: string };
}

const OT_REQUEST_INCLUDE = {
  patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, dateOfBirth: true, gender: true } },
  doctor: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
  surgeon: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
  anaesthetist: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
  visit: { select: { id: true, visitType: true, visitDate: true } },
  ot: { select: { id: true, name: true, location: true, status: true } },
} as const;

/**
 * Callers hand us either a DoctorProfile id or the doctor's User id — the
 * doctor-side OT form only knows the logged-in user. Resolve both to the
 * DoctorProfile id the OtRequest columns actually store, rather than 404ing.
 */
async function resolveDoctorProfileId(
  tenantId: string,
  id: string | undefined | null,
  label: string,
): Promise<string | undefined> {
  if (!id) return undefined;
  const profile = await prisma.doctorProfile.findFirst({
    where: { tenantId, OR: [{ id }, { userId: id }] },
    select: { id: true },
  });
  if (!profile) throw AppError.notFound(`${label} not found`);
  return profile.id;
}

/** DoctorProfile ids belonging to the calling user, if they are a doctor. */
async function callerDoctorProfileId(tenantId: string, userId: string): Promise<string | null> {
  const profile = await prisma.doctorProfile.findFirst({
    where: { tenantId, userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/** Fire-and-forget in-app notification — a failed notify must never fail the booking. */
function notify(args: {
  tenantId: string;
  userId: string | null | undefined;
  title: string;
  message: string;
  referenceType: string;
  referenceId: string;
}): void {
  if (!args.userId) return;
  void prisma.notification
    .create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        title: args.title,
        message: args.message,
        notificationType: 'alert' as any,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
      },
    })
    .catch((err) =>
      logger.warn({ err, userId: args.userId }, 'OT notification failed'),
    );
}

/** "12/08/2026 at 09:30" — the wording used in every OT notification. */
function slotLabel(date: Date | string | null | undefined, time: string | null | undefined): string {
  const d = toDateKey(date);
  if (!d) return 'an unscheduled slot';
  const [y, m, dd] = d.split('-');
  const t = toTimeKey(time);
  return `${dd}/${m}/${y}${t ? ` at ${t}` : ''}`;
}

export async function createOTRequest(tenantId: string, userId: string, data: CreateOtRequestInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // OT is in-patient only: the patient must be currently admitted (every
  // admission is IP / Emergency / Day Care) so the surgery charge routes onto
  // their running IP bill (ledger). OP / walk-in patients cannot be booked.
  const activeAdmission = await prisma.admission.findFirst({
    where: { tenantId, patientId: data.patientId, status: ACTIVE_ADMISSION_STATUS },
    orderBy: { admissionDate: 'desc' },
    select: { id: true, visitId: true },
  });
  if (!activeAdmission) {
    throw AppError.badRequest(
      'Only admitted patients (IP / Emergency / Day Care) can be booked for OT',
    );
  }

  // Tie the OT to the admission's visit when the caller didn't pass one, so the
  // surgery sits on the same in-patient episode (and its bill hits the ledger).
  let visitId = data.visitId;
  if (!visitId) {
    visitId = activeAdmission.visitId;
    if (!visitId) {
      const latestVisit = await prisma.visit.findFirst({
        where: { tenantId, patientId: data.patientId },
        orderBy: { visitDate: 'desc' },
        select: { id: true },
      });
      if (!latestVisit) {
        throw AppError.badRequest('No active visit found for patient — please create a visit first');
      }
      visitId = latestVisit.id;
    }
  } else {
    const visit = await prisma.visit.findFirst({ where: { id: visitId, tenantId } });
    if (!visit) throw AppError.notFound('Visit not found');
  }

  // Every id below may arrive as a DoctorProfile id or as the doctor's User id
  // (the doctor-side OT form only has the logged-in user), so normalise first.
  const surgeonId = await resolveDoctorProfileId(tenantId, data.surgeonId, 'Surgeon');
  const anaesthetistId = await resolveDoctorProfileId(
    tenantId,
    data.anaesthetistId,
    'Anaesthetist',
  );

  // doctorId is the requesting doctor (required by schema). Surgeon defaults
  // to the same doctor when not explicitly different, and a doctor raising the
  // request from their own OT list is the requester even if they named nobody.
  let doctorId =
    (await resolveDoctorProfileId(tenantId, data.doctorId, 'Doctor')) ??
    surgeonId ??
    (await callerDoctorProfileId(tenantId, userId)) ??
    undefined;
  if (!doctorId) {
    // Fall back to the visit's doctor.
    const v = await prisma.visit.findFirst({ where: { id: visitId, tenantId }, select: { doctorId: true } });
    doctorId = v?.doctorId ?? undefined;
  }
  if (!doctorId) throw AppError.badRequest('doctorId or surgeonId is required');

  const procedureName = data.procedureName ?? data.surgeryName!;
  const urgency = data.urgency ?? mapPriorityToUrgency(data.priority) ?? 'elective';
  const durationMinutes = data.durationMinutes ?? data.estimatedDuration;

  const otRequest = await prisma.otRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId,
      doctorId,
      surgeonId,
      anaesthetistId,
      otId: data.otId,
      procedureName,
      procedureDetails: data.procedureDetails,
      surgeryType: data.surgeryType,
      speciality: data.speciality,
      urgency,
      preferredDate: data.preferredDate ? new Date(data.preferredDate) : undefined,
      preferredTime: data.preferredTime ? new Date(`1970-01-01T${data.preferredTime}:00Z`) : undefined,
      scheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : undefined,
      scheduledStartTime: data.scheduledStartTime,
      scheduledEndTime: data.scheduledEndTime,
      durationMinutes,
      requiredEquipment: data.requiredEquipment as Prisma.InputJsonValue | undefined,
      preOpChecklist: data.preOpChecklist as Prisma.InputJsonValue | undefined,
      preOpDiagnosis: data.preOpDiagnosis,
      notes: data.notes,
      // If the caller booked a firm slot up-front (the OT admin's own Book-OT
      // dialog), jump straight to scheduled. A doctor's request carries only a
      // *preferred* slot and must stay `requested` so it lands in the OT
      // admin's pending queue for scheduling.
      status: data.scheduledDate ? 'scheduled' : 'requested',
    },
    include: OT_REQUEST_INCLUDE,
  });

  // A slot the OT team booked themselves needs no doctor sign-off.
  if (data.scheduledDate) {
    await recordReschedule(otRequest.id, {
      state: SCHEDULE_CONFIRMED,
      reason: null,
      byUserId: userId,
      previousDate: null,
      previousTime: null,
      countsAsReschedule: false,
    });
  }

  logger.info({ tenantId, otRequestId: otRequest.id, userId }, 'OT request created');
  return shapeOtRequest(otRequest as any, await getOneOtScheduleMeta(otRequest.id));
}

export async function getOTRequests(
  tenantId: string,
  query: GetOtRequestsQuery & { date?: string; otId?: string; surgeonId?: string },
  callerUserId?: string,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.urgency) where.urgency = query.urgency;
  if (query.doctorId) where.doctorId = query.doctorId;
  if ((query as any).surgeonId) where.surgeonId = (query as any).surgeonId;
  if ((query as any).otId) where.otId = (query as any).otId;
  if (query.patientId) where.patientId = query.patientId;

  // Both of the blocks below are OR-groups. They go through `AND` so they
  // compose — assigning `where.OR` twice would silently drop the first one.
  where.AND = where.AND ?? [];

  // `mine=true` — the doctor's own OT list. Resolved server-side because the
  // client only knows the User id, while the columns store DoctorProfile ids.
  // Matches whether the caller raised the request or is the named surgeon.
  if (query.mine && callerUserId) {
    const profileId = await callerDoctorProfileId(tenantId, callerUserId);
    where.AND.push(
      profileId
        ? { OR: [{ doctorId: profileId }, { surgeonId: profileId }] }
        // Not a doctor → nothing is "mine".
        : { id: '00000000-0000-0000-0000-000000000000' },
    );
  }

  // `date` filter searches both scheduled and preferred date (for unscheduled
  // requests). Bounded in IST — `new Date('2026-08-11')` is midnight UTC, which
  // is 05:30 IST, so the window used to run from half past five in the morning
  // to half past five the next morning: it dropped that day's early-morning
  // theatre list and pulled in the following morning's.
  if ((query as any).date) {
    const { start, end } = istDayRange((query as any).date);
    where.AND.push({
      OR: [
        { scheduledDate: { gte: start, lte: end } },
        { AND: [{ scheduledDate: null }, { preferredDate: { gte: start, lte: end } }] },
      ],
    });
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: istDayEnd(query.toDate) };
  }

  if (query.search) {
    const search = query.search;
    where.AND = [
      ...(where.AND ?? []),
      {
        OR: [
          { procedureName: { contains: search, mode: 'insensitive' } },
          { surgeryType: { contains: search, mode: 'insensitive' } },
          { speciality: { contains: search, mode: 'insensitive' } },
          { patient: { firstName: { contains: search, mode: 'insensitive' } } },
          { patient: { lastName: { contains: search, mode: 'insensitive' } } },
          { patient: { mrn: { contains: search, mode: 'insensitive' } } },
        ],
      },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.otRequest.findMany({
      where,
      skip,
      take,
      include: OT_REQUEST_INCLUDE,
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.otRequest.count({ where }),
  ]);

  const meta = await getOtScheduleMeta(requests.map((r) => r.id));
  let shaped = requests.map((r) => shapeOtRequest(attachOtScheduleMeta(r as any, meta)));

  // `scheduleState` lives in a raw column, so it is filtered after the fetch.
  // Only used by the doctor's "Awaiting my approval" tab, which is a small set.
  if (query.scheduleState) {
    shaped = shaped.filter((r: any) => r.scheduleState === query.scheduleState);
  }

  return { requests: shaped, total, page, limit };
}

export async function getOTRequestById(tenantId: string, id: string) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: OT_REQUEST_INCLUDE,
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  return shapeOtRequest(request as any, await getOneOtScheduleMeta(id));
}

export async function approveOTRequest(tenantId: string, id: string, userId: string) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  // Allow approve from either `requested` (frontend uses "pending"/"requested"
  // interchangeably). Idempotent: re-approving an already-scheduled returns 200.
  if (request.status !== 'requested' && request.status !== 'scheduled') {
    throw AppError.badRequest(`Cannot approve an OT request in status "${request.status}"`);
  }

  const updated = await prisma.otRequest.update({
    where: { id },
    data: { status: 'scheduled' },
    include: OT_REQUEST_INCLUDE,
  });

  logger.info({ tenantId, otRequestId: id, approvedBy: userId }, 'OT request approved');
  return shapeOtRequest(updated as any);
}

/**
 * OT admin books (or moves) the theatre slot.
 *
 * The doctor raised the request with a *preferred* slot. If the admin honours
 * it exactly the booking is final. If the admin picks anything else — or moves
 * an already-scheduled surgery — it is a **reschedule**: a reason is required,
 * the request goes to `awaiting_doctor`, and the requesting doctor (plus the
 * named surgeon) is notified so they can accept, counter-propose or cancel.
 */
export async function scheduleOT(
  tenantId: string,
  id: string,
  userId: string,
  data: ScheduleOtInput,
) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: OT_REQUEST_INCLUDE,
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot schedule a ${request.status} OT request`);
  }

  // Either of scheduledTime or scheduledStartTime is acceptable
  const startTimeStr = (data as any).scheduledStartTime ?? data.scheduledTime;

  const proposed = { date: data.scheduledDate, time: startTimeStr };
  const doctorPreferred = { date: request.preferredDate, time: request.preferredTime };
  const currentlyScheduled = { date: request.scheduledDate, time: request.scheduledStartTime };

  const hadSchedule = !!request.scheduledDate;
  const matchesDoctorsChoice = sameSlot(proposed, doctorPreferred);
  const movesExistingBooking = hadSchedule && !sameSlot(proposed, currentlyScheduled);
  // Anything other than "give the doctor exactly what they asked for" is a
  // reschedule the doctor has to be told about — including the very first
  // scheduling, because the doctor already stated a preference.
  const isReschedule =
    movesExistingBooking || (!!request.preferredDate && !matchesDoctorsChoice);

  const reason = data.rescheduleReason?.trim() || null;
  if (isReschedule && !reason) {
    throw AppError.badRequest(
      'A reason is required when the surgery is not booked at the time the doctor asked for.',
    );
  }

  const surgeonId = await resolveDoctorProfileId(tenantId, (data as any).surgeonId, 'Surgeon');
  const anaesthetistId = await resolveDoctorProfileId(
    tenantId,
    (data as any).anaesthetistId,
    'Anaesthetist',
  );

  const updated = await prisma.otRequest.update({
    where: { id },
    data: {
      otId: data.otId,
      scheduledDate: new Date(data.scheduledDate),
      scheduledTime: startTimeStr ? new Date(`1970-01-01T${startTimeStr}:00Z`) : undefined,
      scheduledStartTime: (data as any).scheduledStartTime ?? data.scheduledTime,
      scheduledEndTime: (data as any).scheduledEndTime,
      surgeonId,
      anaesthetistId,
      durationMinutes: data.durationMinutes,
      status: 'scheduled',
    },
    include: OT_REQUEST_INCLUDE,
  });

  await recordReschedule(id, {
    state: isReschedule ? SCHEDULE_AWAITING_DOCTOR : SCHEDULE_CONFIRMED,
    reason,
    byUserId: userId,
    previousDate: hadSchedule ? request.scheduledDate : request.preferredDate,
    previousTime: hadSchedule
      ? request.scheduledStartTime
      : toTimeKey(request.preferredTime),
    countsAsReschedule: isReschedule,
  });

  if (isReschedule) {
    const patientName = `${updated.patient?.firstName ?? ''} ${updated.patient?.lastName ?? ''}`.trim();
    const asked = slotLabel(
      hadSchedule ? request.scheduledDate : request.preferredDate,
      hadSchedule ? request.scheduledStartTime : toTimeKey(request.preferredTime),
    );
    const now = slotLabel(updated.scheduledDate, updated.scheduledStartTime);
    const targets = new Set(
      [updated.doctor?.user?.id, updated.surgeon?.user?.id].filter(Boolean) as string[],
    );
    for (const uid of targets) {
      notify({
        tenantId,
        userId: uid,
        title: 'Surgery rescheduled — your confirmation needed',
        message:
          `${updated.procedureName} for ${patientName || 'a patient'} was moved from ${asked} to ${now}. ` +
          `Reason: ${reason}. Accept it, propose another time, or cancel.`,
        referenceType: 'ot_reschedule',
        referenceId: id,
      });
    }
  } else {
    // The desk booked the slot the surgeon asked for (or booked one for the
    // first time). Nothing needs confirming, but the surgeon still has to be
    // TOLD — until now this branch was silent, so a doctor only discovered
    // their surgery was on by opening the list and looking.
    const patientName = `${updated.patient?.firstName ?? ''} ${updated.patient?.lastName ?? ''}`.trim();
    const slot = slotLabel(updated.scheduledDate, updated.scheduledStartTime);
    const theatre = (updated as { ot?: { name?: string | null } | null }).ot?.name;
    const targets = new Set(
      [updated.doctor?.user?.id, updated.surgeon?.user?.id].filter(Boolean) as string[],
    );
    for (const uid of targets) {
      // The person who did the scheduling does not need telling they did it.
      if (uid === userId) continue;
      notify({
        tenantId,
        userId: uid,
        title: 'Surgery scheduled',
        message:
          `${updated.procedureName} for ${patientName || 'a patient'} is scheduled for ${slot}` +
          (theatre ? ` in ${theatre}` : '') + '.',
        referenceType: 'ot_scheduled',
        referenceId: id,
      });
    }
  }

  logger.info(
    { tenantId, otRequestId: id, isReschedule, by: userId },
    isReschedule ? 'OT request rescheduled — awaiting doctor' : 'OT request scheduled',
  );
  return shapeOtRequest(updated as any, await getOneOtScheduleMeta(id));
}

/**
 * The doctor's answer to a rescheduled slot:
 *   accept     → booking confirmed, surgery may start
 *   reschedule → counter-proposal; back to `requested` with a new preferred
 *                slot for the OT admin to work from
 *   cancel     → surgery called off with a reason
 * Whichever way it goes, whoever proposed the move is notified.
 */
export async function respondToOtSchedule(
  tenantId: string,
  id: string,
  userId: string,
  roles: string[],
  data: OtScheduleResponseInput,
) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: OT_REQUEST_INCLUDE,
  });
  if (!request) throw AppError.notFound('OT request not found');
  if (request.status === 'completed') {
    throw AppError.badRequest('This surgery is already completed');
  }
  if (request.status === 'cancelled') {
    throw AppError.badRequest('This surgery is already cancelled');
  }

  // Only the doctor who raised it or the named surgeon may answer. The OT desk
  // (hospital admin) may record a verbal confirmation with `onBehalf` — but
  // another doctor must never be able to answer for a colleague, so the bypass
  // is gated on role, not on the flag alone.
  const profileId = await callerDoctorProfileId(tenantId, userId);
  const isOwner =
    !!profileId && (profileId === request.doctorId || profileId === request.surgeonId);
  const canActOnBehalf =
    !!data.onBehalf && roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'ot_admin');
  if (!isOwner && !canActOnBehalf) {
    throw AppError.forbidden('Only the requesting doctor or the surgeon can respond to this booking');
  }

  const meta = await getOneOtScheduleMeta(id);
  const note = data.note?.trim() || null;
  const patientName = `${request.patient?.firstName ?? ''} ${request.patient?.lastName ?? ''}`.trim();
  const proposer = meta.rescheduledBy;

  if (data.action === 'accept') {
    await recordDoctorResponse(id, { response: 'accepted', note, state: SCHEDULE_CONFIRMED });
    notify({
      tenantId,
      userId: proposer,
      title: 'Surgery time accepted',
      message: `${request.procedureName} for ${patientName || 'a patient'} on ${slotLabel(request.scheduledDate, request.scheduledStartTime)} was accepted by the doctor.`,
      referenceType: 'ot_response',
      referenceId: id,
    });
    logger.info({ tenantId, otRequestId: id, userId }, 'OT reschedule accepted by doctor');
    return shapeOtRequest(request as any, await getOneOtScheduleMeta(id));
  }

  if (data.action === 'cancel') {
    if (!note) throw AppError.badRequest('A reason is required to cancel the surgery');
    const updated = await prisma.otRequest.update({
      where: { id },
      data: { status: 'cancelled', cancellationReason: note },
      include: OT_REQUEST_INCLUDE,
    });
    await recordDoctorResponse(id, { response: 'rejected', note, state: null });
    notify({
      tenantId,
      userId: proposer,
      title: 'Surgery cancelled by the doctor',
      message: `${request.procedureName} for ${patientName || 'a patient'} was cancelled. Reason: ${note}`,
      referenceType: 'ot_response',
      referenceId: id,
    });
    logger.info({ tenantId, otRequestId: id, userId }, 'OT request cancelled by doctor');
    return shapeOtRequest(updated as any, await getOneOtScheduleMeta(id));
  }

  // action === 'reschedule' — the doctor counter-proposes a new preferred slot
  // and the request returns to the OT admin's pending queue.
  if (!data.preferredDate) {
    throw AppError.badRequest('A new preferred date is required to request another time');
  }
  if (!note) {
    throw AppError.badRequest('A reason is required when asking for another time');
  }
  const updated = await prisma.otRequest.update({
    where: { id },
    data: {
      status: 'requested',
      preferredDate: new Date(data.preferredDate),
      preferredTime: data.preferredTime
        ? new Date(`1970-01-01T${data.preferredTime}:00Z`)
        : null,
      // The old booking no longer stands — free the slot.
      scheduledDate: null,
      scheduledTime: null,
      scheduledStartTime: null,
      scheduledEndTime: null,
    },
    include: OT_REQUEST_INCLUDE,
  });
  await recordDoctorResponse(id, { response: 'rejected', note, state: null });
  await clearScheduleProposal(id);
  notify({
    tenantId,
    userId: proposer,
    title: 'Doctor asked for a different surgery time',
    message:
      `${request.procedureName} for ${patientName || 'a patient'} — the doctor asked for ` +
      `${slotLabel(data.preferredDate, data.preferredTime ?? null)} instead. Reason: ${note}`,
    referenceType: 'ot_response',
    referenceId: id,
  });
  logger.info({ tenantId, otRequestId: id, userId }, 'Doctor counter-proposed an OT slot');
  return shapeOtRequest(updated as any, await getOneOtScheduleMeta(id));
}

export async function updateOTRequest(
  tenantId: string,
  id: string,
  _userId: string,
  data: UpdateOtRequestInput,
) {
  const existing = await prisma.otRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('OT request not found');

  // start_time/end_time helpers — when status transitions to in_progress or
  // completed, default actual_start/end if the caller omits them.
  const now = new Date();
  const patch: any = {};
  if (data.status) {
    // A rescheduled surgery is only a proposal until the doctor accepts it —
    // the theatre must not start on a slot the surgeon has not agreed to.
    if (data.status === 'in_progress') {
      const meta = await getOneOtScheduleMeta(id);
      if (meta.scheduleState === SCHEDULE_AWAITING_DOCTOR) {
        throw AppError.badRequest(
          'The doctor has not yet accepted the rescheduled time. Wait for their confirmation before starting.',
        );
      }
    }
    patch.status = data.status;
    if (data.status === 'in_progress' && !existing.actualStartTime) {
      patch.actualStartTime = data.actualStartTime ? new Date(data.actualStartTime) : now;
    }
    if (data.status === 'completed' && !existing.actualEndTime) {
      patch.actualEndTime = data.actualEndTime ? new Date(data.actualEndTime) : now;
    }
  }
  if (data.actualStartTime) patch.actualStartTime = new Date(data.actualStartTime);
  if (data.actualEndTime) patch.actualEndTime = new Date(data.actualEndTime);
  if (data.postOpDiagnosis !== undefined) patch.postOpDiagnosis = data.postOpDiagnosis;
  if (data.cancellationReason !== undefined) patch.cancellationReason = data.cancellationReason;
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.billingAmount !== undefined) patch.billingAmount = data.billingAmount;
  if (data.billingStatus !== undefined) patch.billingStatus = data.billingStatus;
  if (data.surgeonId !== undefined) patch.surgeonId = data.surgeonId;
  if (data.anaesthetistId !== undefined) patch.anaesthetistId = data.anaesthetistId;
  if (data.surgeryType !== undefined) patch.surgeryType = data.surgeryType;
  if (data.speciality !== undefined) patch.speciality = data.speciality;

  const updated = await prisma.otRequest.update({
    where: { id },
    data: patch,
    include: OT_REQUEST_INCLUDE,
  });

  // Tell the doctor when the OT desk calls off a surgery they raised.
  if (data.status === 'cancelled') {
    const patientName = `${updated.patient?.firstName ?? ''} ${updated.patient?.lastName ?? ''}`.trim();
    const targets = new Set(
      [updated.doctor?.user?.id, updated.surgeon?.user?.id].filter(Boolean) as string[],
    );
    for (const uid of targets) {
      if (uid === _userId) continue;
      notify({
        tenantId,
        userId: uid,
        title: 'Surgery cancelled',
        message:
          `${updated.procedureName} for ${patientName || 'a patient'} was cancelled.` +
          (data.cancellationReason ? ` Reason: ${data.cancellationReason}` : ''),
        referenceType: 'ot_response',
        referenceId: id,
      });
    }
  }

  return shapeOtRequest(updated as any, await getOneOtScheduleMeta(id));
}

// ============================================================
// OT Analytics — surgery list, utilization, surgeon workload.
// ============================================================

export interface OtAnalyticsQuery {
  fromDate?: string;
  toDate?: string;
  otId?: string;
  surgeonId?: string;
}

export async function getOTAnalytics(tenantId: string, query: OtAnalyticsQuery) {
  // Whole IST days at both ends. Taken literally, `new Date(toDate)` is midnight
  // UTC, so every surgery on the last day of the range fell outside it — the
  // report silently understated the most recent day, which is the one anyone
  // looking at OT utilisation cares about most.
  const toDate = query.toDate ? istDayEnd(query.toDate) : istDayEnd();
  const fromDate = query.fromDate
    ? istDayStart(query.fromDate)
    : (() => {
        const d = new Date(toDate);
        d.setDate(d.getDate() - 30);
        return d;
      })();

  const where: any = {
    tenantId,
    createdAt: { gte: fromDate, lte: toDate },
  };
  if (query.otId) where.otId = query.otId;
  if (query.surgeonId) where.surgeonId = query.surgeonId;

  const requests = await prisma.otRequest.findMany({
    where,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ot: { select: { id: true, name: true } },
    },
    orderBy: { scheduledDate: 'desc' },
  });

  // Status breakdown
  const byStatus = requests.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Surgeon workload
  const surgeonAgg = new Map<
    string,
    {
      surgeonId: string;
      surgeonName: string;
      total: number;
      completed: number;
      cancelled: number;
      avgDurationMin: number;
      totalDuration: number;
      durationCount: number;
    }
  >();
  for (const r of requests) {
    const sid = r.surgeonId ?? r.doctorId;
    const sUser = r.surgeon?.user ?? r.doctor?.user;
    const sName = sUser ? `Dr. ${sUser.firstName} ${sUser.lastName}` : 'Unassigned';
    let row = surgeonAgg.get(sid);
    if (!row) {
      row = {
        surgeonId: sid,
        surgeonName: sName,
        total: 0,
        completed: 0,
        cancelled: 0,
        avgDurationMin: 0,
        totalDuration: 0,
        durationCount: 0,
      };
      surgeonAgg.set(sid, row);
    }
    row.total += 1;
    if (r.status === 'completed') row.completed += 1;
    if (r.status === 'cancelled') row.cancelled += 1;
    if (r.actualStartTime && r.actualEndTime) {
      const mins = Math.round((r.actualEndTime.getTime() - r.actualStartTime.getTime()) / 60000);
      if (mins > 0 && mins < 24 * 60) {
        row.totalDuration += mins;
        row.durationCount += 1;
      }
    } else if (r.durationMinutes) {
      row.totalDuration += r.durationMinutes;
      row.durationCount += 1;
    }
  }
  for (const row of surgeonAgg.values()) {
    row.avgDurationMin = row.durationCount ? Math.round(row.totalDuration / row.durationCount) : 0;
  }

  // OT utilization
  const otAgg = new Map<
    string,
    { otId: string; otName: string; total: number; completed: number; totalDuration: number }
  >();
  for (const r of requests) {
    if (!r.otId) continue;
    let row = otAgg.get(r.otId);
    if (!row) {
      row = { otId: r.otId, otName: r.ot?.name ?? 'Unknown OT', total: 0, completed: 0, totalDuration: 0 };
      otAgg.set(r.otId, row);
    }
    row.total += 1;
    if (r.status === 'completed') row.completed += 1;
    if (r.actualStartTime && r.actualEndTime) {
      row.totalDuration += Math.max(
        0,
        Math.round((r.actualEndTime.getTime() - r.actualStartTime.getTime()) / 60000),
      );
    } else if (r.durationMinutes) {
      row.totalDuration += r.durationMinutes;
    }
  }

  const dayMinutes =
    Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000))) * 12 * 60; // 12hr OT day
  const otUtilization = Array.from(otAgg.values()).map((row) => ({
    ...row,
    utilizationPercent: dayMinutes > 0 ? Math.min(100, Math.round((row.totalDuration / dayMinutes) * 100)) : 0,
  }));

  // Average start delay = actual start − scheduled start (minutes). Positive
  // means surgeries tend to start late. Only counts requests that have both an
  // actual start and a scheduled date+time; absurd values are dropped as bad data.
  let delaySum = 0;
  let delayCount = 0;
  for (const r of requests) {
    if (!r.actualStartTime || !r.scheduledDate || !r.scheduledStartTime) continue;
    const [hh, mm] = r.scheduledStartTime.split(':').map(Number);
    if (Number.isNaN(hh)) continue;
    const sched = new Date(r.scheduledDate);
    sched.setHours(hh, mm ?? 0, 0, 0);
    const delayMin = Math.round((r.actualStartTime.getTime() - sched.getTime()) / 60000);
    if (delayMin > -12 * 60 && delayMin < 24 * 60) {
      delaySum += delayMin;
      delayCount += 1;
    }
  }
  const avgStartDelayMin = delayCount ? Math.round(delaySum / delayCount) : 0;

  return {
    avgStartDelayMin,
    startDelaySampleSize: delayCount,
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    totals: {
      total: requests.length,
      completed: byStatus.completed ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      scheduled: byStatus.scheduled ?? 0,
      inProgress: byStatus.in_progress ?? 0,
      requested: byStatus.requested ?? 0,
    },
    byStatus,
    surgeonWorkload: Array.from(surgeonAgg.values()).sort((a, b) => b.total - a.total),
    otUtilization: otUtilization.sort((a, b) => b.total - a.total),
    surgeryList: requests.map((r) => ({
      id: r.id,
      patient: r.patient,
      procedureName: r.procedureName,
      surgeryType: r.surgeryType,
      speciality: r.speciality,
      surgeonName: r.surgeon?.user
        ? `Dr. ${r.surgeon.user.firstName} ${r.surgeon.user.lastName}`
        : r.doctor?.user
          ? `Dr. ${r.doctor.user.firstName} ${r.doctor.user.lastName}`
          : '—',
      otName: r.ot?.name ?? null,
      status: r.status,
      scheduledDate: r.scheduledDate,
      scheduledStartTime: r.scheduledStartTime,
      durationMinutes: r.durationMinutes,
      billingAmount: r.billingAmount ? Number(r.billingAmount) : null,
      billingStatus: r.billingStatus,
    })),
  };
}

// ============================================================
// Operating Theaters (rooms)
// ============================================================

// Managing operation theaters (rooms) is a hospital-admin concern — other OT
// users (e.g. inventory_manager) can view + use theaters for scheduling but
// cannot add / edit / delete them. admin = hospital admin, super_admin = platform.
const HOSPITAL_ADMIN_ROLES = new Set(['super_admin', 'admin']);
function assertHospitalAdmin(roles: string[], action = 'manage operation theaters'): void {
  if (!roles.some((r) => HOSPITAL_ADMIN_ROLES.has(r))) {
    throw AppError.forbidden(`Only a hospital admin can ${action}.`);
  }
}

export async function listOperatingTheaters(tenantId: string) {
  return prisma.operatingTheater.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
  });
}

export async function createOperatingTheater(tenantId: string, roles: string[], data: CreateOtInput) {
  assertHospitalAdmin(roles, 'add an operation theater');
  const ot = await prisma.operatingTheater.create({
    data: {
      tenantId,
      name: data.name,
      location: data.location,
      status: (data.status as any) ?? 'available',
      equipmentList: data.equipmentList as Prisma.InputJsonValue | undefined,
    },
  });
  logger.info({ tenantId, otId: ot.id }, 'Operating theater created');
  return ot;
}

export async function updateOperatingTheater(tenantId: string, roles: string[], id: string, data: UpdateOtInput) {
  assertHospitalAdmin(roles, 'edit an operation theater');
  const existing = await prisma.operatingTheater.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Operating theater not found');

  return prisma.operatingTheater.update({
    where: { id },
    data: {
      name: data.name,
      location: data.location ?? undefined,
      status: data.status as any,
      equipmentList: data.equipmentList as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function deleteOperatingTheater(tenantId: string, roles: string[], id: string) {
  assertHospitalAdmin(roles, 'delete an operation theater');
  const existing = await prisma.operatingTheater.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Operating theater not found');
  // Block deletion if active OT requests reference it.
  const referenced = await prisma.otRequest.count({
    where: { otId: id, status: { in: ['requested', 'scheduled', 'in_progress'] } },
  });
  if (referenced > 0) {
    throw AppError.badRequest('Cannot delete theater while active OT requests reference it');
  }
  await prisma.operatingTheater.delete({ where: { id } });
}

// ============================================================
// OT scheduling preferences (one row per tenant)
// ============================================================

const OT_SETTINGS_DEFAULTS = {
  defaultDurationMinutes: 60,
  bufferMinutes: 30,
  maxSurgeriesPerDay: 10,
  dayStartTime: null as string | null,
  dayEndTime: null as string | null,
};

export async function getOtSchedulingSettings(tenantId: string) {
  const settings = await prisma.otSchedulingSetting.findUnique({ where: { tenantId } });
  // No row yet — return the defaults without creating one.
  return settings ?? { tenantId, ...OT_SETTINGS_DEFAULTS };
}

export async function updateOtSchedulingSettings(
  tenantId: string,
  data: UpdateOtSettingsInput,
) {
  const settings = await prisma.otSchedulingSetting.upsert({
    where: { tenantId },
    create: { tenantId, ...OT_SETTINGS_DEFAULTS, ...data },
    update: data,
  });
  logger.info({ tenantId }, 'OT scheduling settings updated');
  return settings;
}

// ============================================================
// Incidents
// ============================================================

export async function reportIncident(tenantId: string, userId: string, data: ReportIncidentInput) {
  const incident = await prisma.incidentReport.create({
    data: {
      tenantId,
      reportedBy: userId,
      incidentType: data.incidentType,
      description: data.description,
      severity: data.severity,
      patientId: data.patientId,
      location: data.location,
      occurredAt: data.occurredAt ? new Date(data.occurredAt) : undefined,
    },
    include: {
      reporter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, incidentId: incident.id }, 'Incident reported');
  return incident;
}

export async function getIncidents(tenantId: string, query: GetIncidentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.severity) {
    where.severity = query.severity;
  }

  if (query.incidentType) {
    where.incidentType = query.incidentType;
  }

  // IST day bounds — an incident logged on the end date itself used to fall
  // outside the range, so "show me everything up to today" hid today's.
  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: istDayEnd(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { location: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [incidents, total] = await Promise.all([
    prisma.incidentReport.findMany({
      where,
      skip,
      take,
      include: {
        reporter: { select: { id: true, firstName: true, lastName: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.incidentReport.count({ where }),
  ]);

  return { incidents, total, page, limit };
}

export async function getIncidentById(tenantId: string, id: string) {
  const incident = await prisma.incidentReport.findFirst({
    where: { id, tenantId },
    include: {
      reporter: { select: { id: true, firstName: true, lastName: true, email: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  if (!incident) {
    throw AppError.notFound('Incident report not found');
  }

  return incident;
}

export async function updateIncident(tenantId: string, id: string, data: UpdateIncidentInput) {
  const incident = await prisma.incidentReport.findFirst({
    where: { id, tenantId },
  });

  if (!incident) {
    throw AppError.notFound('Incident report not found');
  }

  if (incident.status === 'closed') {
    throw AppError.badRequest('Cannot update a closed incident');
  }

  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      description: data.description,
      severity: data.severity,
      location: data.location,
    },
    include: {
      reporter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, incidentId: id }, 'Incident updated');
  return updated;
}

export async function investigateIncident(
  tenantId: string,
  id: string,
  userId: string,
  data: InvestigateIncidentInput,
) {
  const incident = await prisma.incidentReport.findFirst({
    where: { id, tenantId },
  });

  if (!incident) {
    throw AppError.notFound('Incident report not found');
  }

  if (incident.status === 'closed') {
    throw AppError.badRequest('Cannot investigate a closed incident');
  }

  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      status: 'investigating',
      resolutionNotes: data.resolutionNotes,
    },
    include: {
      reporter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, incidentId: id, investigatedBy: userId }, 'Incident investigation started');
  return updated;
}

export async function closeIncident(
  tenantId: string,
  id: string,
  userId: string,
  data: CloseIncidentInput,
) {
  const incident = await prisma.incidentReport.findFirst({
    where: { id, tenantId },
  });

  if (!incident) {
    throw AppError.notFound('Incident report not found');
  }

  if (incident.status === 'closed') {
    throw AppError.badRequest('Incident is already closed');
  }

  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      status: 'closed',
      resolutionNotes: data.resolutionNotes,
      resolvedAt: new Date(),
    },
    include: {
      reporter: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, incidentId: id, closedBy: userId }, 'Incident closed');
  return updated;
}
