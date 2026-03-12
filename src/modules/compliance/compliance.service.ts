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

export async function createOTRequest(tenantId: string, userId: string, data: CreateOtRequestInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit exists
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  const otRequest = await prisma.otRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      doctorId: data.doctorId,
      procedureName: data.procedureName,
      procedureDetails: data.procedureDetails,
      urgency: data.urgency,
      preferredDate: data.preferredDate ? new Date(data.preferredDate) : undefined,
      preferredTime: data.preferredTime ? new Date(`1970-01-01T${data.preferredTime}:00Z`) : undefined,
      durationMinutes: data.durationMinutes,
      requiredEquipment: data.requiredEquipment as Prisma.InputJsonValue | undefined,
      preOpChecklist: data.preOpChecklist as Prisma.InputJsonValue | undefined,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { select: { id: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, otRequestId: otRequest.id }, 'OT request created');
  return otRequest;
}

export async function getOTRequests(tenantId: string, query: GetOtRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.urgency) {
    where.urgency = query.urgency;
  }

  if (query.doctorId) {
    where.doctorId = query.doctorId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { procedureName: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.otRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        doctor: { select: { id: true } },
        visit: { select: { id: true, visitType: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.otRequest.count({ where }),
  ]);

  return { requests, total, page, limit };
}

export async function getOTRequestById(tenantId: string, id: string) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, dateOfBirth: true, gender: true } },
      doctor: { select: { id: true } },
      visit: { select: { id: true, visitType: true } },
      ot: { select: { id: true, name: true } },
    },
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  return request;
}

export async function approveOTRequest(tenantId: string, id: string, userId: string) {
  const request = await prisma.otRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('OT request not found');
  }

  if (request.status !== 'requested') {
    throw AppError.badRequest('Only requests with status "requested" can be approved');
  }

  const updated = await prisma.otRequest.update({
    where: { id },
    data: { status: 'scheduled' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { select: { id: true } },
    },
  });

  logger.info({ tenantId, otRequestId: id, approvedBy: userId }, 'OT request approved');
  return updated;
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

  const updated = await prisma.otRequest.update({
    where: { id },
    data: {
      otId: data.otId,
      scheduledDate: new Date(data.scheduledDate),
      scheduledTime: new Date(`1970-01-01T${data.scheduledTime}:00Z`),
      durationMinutes: data.durationMinutes,
      status: 'scheduled',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: { select: { id: true } },
      ot: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, otRequestId: id }, 'OT request scheduled');
  return updated;
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
