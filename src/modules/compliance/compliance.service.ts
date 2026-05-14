import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
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
  ReportIncidentInput,
  UpdateIncidentInput,
  InvestigateIncidentInput,
  CloseIncidentInput,
  GetIncidentsQuery,
} from './compliance.validation';

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

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }

  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
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
function shapeOtRequest<T extends { procedureName: string; urgency: string }>(r: T): T & {
  surgeryName: string;
  priority: string;
} {
  return {
    ...r,
    surgeryName: r.procedureName,
    priority: r.urgency === 'elective' ? 'routine' : r.urgency,
  };
}

const OT_REQUEST_INCLUDE = {
  patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, dateOfBirth: true, gender: true } },
  doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
  surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
  anaesthetist: { include: { user: { select: { firstName: true, lastName: true } } } },
  visit: { select: { id: true, visitType: true, visitDate: true } },
  ot: { select: { id: true, name: true, location: true, status: true } },
} as const;

export async function createOTRequest(tenantId: string, userId: string, data: CreateOtRequestInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Visit is normally required (legacy schema) but in EmedHub the OT booking
  // can predate a Visit. If the caller didn't pass one, attach the most-recent
  // visit for this patient; otherwise we error out.
  let visitId = data.visitId;
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
  } else {
    const visit = await prisma.visit.findFirst({ where: { id: visitId, tenantId } });
    if (!visit) throw AppError.notFound('Visit not found');
  }

  // doctorId is the requesting doctor (required by schema). Surgeon defaults
  // to the same doctor when not explicitly different.
  let doctorId = data.doctorId ?? data.surgeonId;
  if (!doctorId) {
    // Fall back to the visit's doctor.
    const v = await prisma.visit.findFirst({ where: { id: visitId, tenantId }, select: { doctorId: true } });
    doctorId = v?.doctorId ?? undefined;
  }
  if (!doctorId) throw AppError.badRequest('doctorId or surgeonId is required');

  if (data.surgeonId) {
    const s = await prisma.doctorProfile.findFirst({ where: { id: data.surgeonId, tenantId } });
    if (!s) throw AppError.notFound('Surgeon not found');
  }
  if (data.anaesthetistId) {
    const a = await prisma.doctorProfile.findFirst({ where: { id: data.anaesthetistId, tenantId } });
    if (!a) throw AppError.notFound('Anaesthetist not found');
  }

  const procedureName = data.procedureName ?? data.surgeryName!;
  const urgency = data.urgency ?? mapPriorityToUrgency(data.priority) ?? 'elective';
  const durationMinutes = data.durationMinutes ?? data.estimatedDuration;

  const otRequest = await prisma.otRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId,
      doctorId,
      surgeonId: data.surgeonId,
      anaesthetistId: data.anaesthetistId,
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
      // If the caller provided a schedule up-front, jump straight to scheduled.
      status: data.scheduledDate ? 'scheduled' : 'requested',
    },
    include: OT_REQUEST_INCLUDE,
  });

  logger.info({ tenantId, otRequestId: otRequest.id, userId }, 'OT request created');
  return shapeOtRequest(otRequest as any);
}

export async function getOTRequests(
  tenantId: string,
  query: GetOtRequestsQuery & { date?: string; otId?: string; surgeonId?: string },
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.urgency) where.urgency = query.urgency;
  if (query.doctorId) where.doctorId = query.doctorId;
  if ((query as any).surgeonId) where.surgeonId = (query as any).surgeonId;
  if ((query as any).otId) where.otId = (query as any).otId;
  if (query.patientId) where.patientId = query.patientId;

  // `date` filter searches both scheduled and preferred date (for unscheduled requests)
  if ((query as any).date) {
    const day = new Date((query as any).date);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    where.OR = [
      { scheduledDate: { gte: day, lt: next } },
      { AND: [{ scheduledDate: null }, { preferredDate: { gte: day, lt: next } }] },
    ];
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
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

  return { requests: requests.map((r) => shapeOtRequest(r as any)), total, page, limit };
}

export async function getOTRequestById(tenantId: string, id: string) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: OT_REQUEST_INCLUDE,
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  return shapeOtRequest(request as any);
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

export async function scheduleOT(tenantId: string, id: string, data: ScheduleOtInput) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot schedule a ${request.status} OT request`);
  }

  // Either of scheduledTime or scheduledStartTime is acceptable
  const startTimeStr = (data as any).scheduledStartTime ?? data.scheduledTime;
  const updated = await prisma.otRequest.update({
    where: { id },
    data: {
      otId: data.otId,
      scheduledDate: new Date(data.scheduledDate),
      scheduledTime: startTimeStr ? new Date(`1970-01-01T${startTimeStr}:00Z`) : undefined,
      scheduledStartTime: (data as any).scheduledStartTime ?? data.scheduledTime,
      scheduledEndTime: (data as any).scheduledEndTime,
      surgeonId: (data as any).surgeonId,
      anaesthetistId: (data as any).anaesthetistId,
      durationMinutes: data.durationMinutes,
      status: 'scheduled',
    },
    include: OT_REQUEST_INCLUDE,
  });

  logger.info({ tenantId, otRequestId: id }, 'OT request scheduled');
  return shapeOtRequest(updated as any);
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

  return shapeOtRequest(updated as any);
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
  const toDate = query.toDate ? new Date(query.toDate) : new Date();
  const fromDate = query.fromDate
    ? new Date(query.fromDate)
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

  return {
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

export async function listOperatingTheaters(tenantId: string) {
  return prisma.operatingTheater.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
  });
}

export async function createOperatingTheater(tenantId: string, data: CreateOtInput) {
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

export async function updateOperatingTheater(tenantId: string, id: string, data: UpdateOtInput) {
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

export async function deleteOperatingTheater(tenantId: string, id: string) {
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

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
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
