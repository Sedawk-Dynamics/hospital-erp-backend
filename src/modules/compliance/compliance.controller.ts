import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as complianceService from './compliance.service';

// ============================================================
// Tickets
// ============================================================

export async function createTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const ticket = await complianceService.createTicket(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Ticket created successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function getTickets(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { tickets, total, page, limit } = await complianceService.getTickets(tenantId, req.query as any);
    sendPaginatedResponse(res, tickets, total, page, limit, 'Tickets retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getTicketById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const ticket = await complianceService.getTicketById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Ticket retrieved successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function updateTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const ticket = await complianceService.updateTicket(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Ticket updated successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function assignTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const ticket = await complianceService.assignTicket(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Ticket assigned successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function closeTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const ticket = await complianceService.closeTicket(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Ticket closed successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Feedback
// ============================================================

export async function submitFeedback(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const feedback = await complianceService.submitFeedback(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Feedback submitted successfully', data: feedback });
  } catch (err) {
    next(err);
  }
}

export async function getFeedback(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { feedbackList, total, page, limit } = await complianceService.getFeedback(tenantId, req.query as any);
    sendPaginatedResponse(res, feedbackList, total, page, limit, 'Feedback retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getFeedbackById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const feedback = await complianceService.getFeedbackById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Feedback retrieved successfully', data: feedback });
  } catch (err) {
    next(err);
  }
}

export async function respondToFeedback(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const feedback = await complianceService.respondToFeedback(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Feedback response submitted successfully', data: feedback });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Audit Logs
// ============================================================

export async function getAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { logs, total, page, limit } = await complianceService.getAuditLogs(tenantId, req.query as any);
    sendPaginatedResponse(res, logs, total, page, limit, 'Audit logs retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getAuditLogById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const log = await complianceService.getAuditLogById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Audit log retrieved successfully', data: log });
  } catch (err) {
    next(err);
  }
}

export async function getAuditLogsByEntity(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const entityType = req.params.entityType as string;
    const entityId = req.params.entityId as string;
    const { logs, total, page, limit } = await complianceService.getAuditLogsByEntity(
      tenantId,
      entityType,
      entityId,
      req.query as any,
    );
    sendPaginatedResponse(res, logs, total, page, limit, 'Audit logs retrieved successfully');
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Compliance Documents
// ============================================================

export async function createComplianceDoc(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const doc = await complianceService.createComplianceDoc(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Compliance document created successfully', data: doc });
  } catch (err) {
    next(err);
  }
}

export async function getComplianceDocs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { documents, total, page, limit } = await complianceService.getComplianceDocs(tenantId, req.query as any);
    sendPaginatedResponse(res, documents, total, page, limit, 'Compliance documents retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getComplianceDocById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const doc = await complianceService.getComplianceDocById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Compliance document retrieved successfully', data: doc });
  } catch (err) {
    next(err);
  }
}

export async function updateComplianceDoc(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const doc = await complianceService.updateComplianceDoc(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Compliance document updated successfully', data: doc });
  } catch (err) {
    next(err);
  }
}

export async function approveComplianceDoc(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const doc = await complianceService.approveComplianceDoc(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'Compliance document approved successfully', data: doc });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// OT Requests
// ============================================================

export async function createOTRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await complianceService.createOTRequest(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'OT request created successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function getOTRequests(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { requests, total, page, limit } = await complianceService.getOTRequests(
      tenantId,
      req.query as any,
      req.user!.userId,
    );
    sendPaginatedResponse(res, requests, total, page, limit, 'OT requests retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getOTRequestById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await complianceService.getOTRequestById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'OT request retrieved successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function approveOTRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await complianceService.approveOTRequest(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'OT request approved successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function scheduleOT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await complianceService.scheduleOT(
      tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({
      res,
      message:
        (request as { scheduleState?: string | null }).scheduleState === 'awaiting_doctor'
          ? 'Surgery rescheduled — the doctor has been notified for confirmation'
          : 'OT scheduled successfully',
      data: request,
    });
  } catch (err) {
    next(err);
  }
}

/** Doctor accepts / counter-proposes / cancels a rescheduled surgery slot. */
export async function respondToOtSchedule(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = await complianceService.respondToOtSchedule(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    const messages: Record<string, string> = {
      accept: 'Surgery time confirmed',
      reschedule: 'New time requested — the OT desk has been notified',
      cancel: 'Surgery cancelled',
    };
    sendResponse({ res, message: messages[req.body.action] ?? 'Response recorded', data: request });
  } catch (err) {
    next(err);
  }
}

export async function updateOTRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await complianceService.updateOTRequest(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'OT request updated', data: request });
  } catch (err) {
    next(err);
  }
}

export async function otAnalytics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await complianceService.getOTAnalytics(tenantId, req.query as any);
    sendResponse({ res, message: 'OT analytics', data });
  } catch (err) {
    next(err);
  }
}

// --- Operating Theaters (rooms) CRUD ---

export async function listOperatingTheaters(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await complianceService.listOperatingTheaters(req.user!.tenantId);
    sendResponse({ res, message: 'Operating theaters', data });
  } catch (err) {
    next(err);
  }
}

export async function createOperatingTheater(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await complianceService.createOperatingTheater(req.user!.tenantId, req.user!.roles ?? [], req.body);
    sendResponse({ res, statusCode: 201, message: 'Operating theater created', data });
  } catch (err) {
    next(err);
  }
}

export async function updateOperatingTheater(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await complianceService.updateOperatingTheater(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Operating theater updated', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteOperatingTheater(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await complianceService.deleteOperatingTheater(req.user!.tenantId, req.user!.roles ?? [], req.params.id as string);
    sendResponse({ res, message: 'Operating theater deleted' });
  } catch (err) {
    next(err);
  }
}

export async function getOtSchedulingSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await complianceService.getOtSchedulingSettings(req.user!.tenantId);
    sendResponse({ res, message: 'OT scheduling settings', data });
  } catch (err) {
    next(err);
  }
}

export async function updateOtSchedulingSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await complianceService.updateOtSchedulingSettings(req.user!.tenantId, req.body);
    sendResponse({ res, message: 'OT scheduling settings updated', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Incidents
// ============================================================

export async function reportIncident(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const incident = await complianceService.reportIncident(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Incident reported successfully', data: incident });
  } catch (err) {
    next(err);
  }
}

export async function getIncidents(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { incidents, total, page, limit } = await complianceService.getIncidents(tenantId, req.query as any);
    sendPaginatedResponse(res, incidents, total, page, limit, 'Incidents retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getIncidentById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const incident = await complianceService.getIncidentById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Incident retrieved successfully', data: incident });
  } catch (err) {
    next(err);
  }
}

export async function updateIncident(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const incident = await complianceService.updateIncident(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Incident updated successfully', data: incident });
  } catch (err) {
    next(err);
  }
}

export async function investigateIncident(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const incident = await complianceService.investigateIncident(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Incident investigation started successfully', data: incident });
  } catch (err) {
    next(err);
  }
}

export async function closeIncident(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const incident = await complianceService.closeIncident(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Incident closed successfully', data: incident });
  } catch (err) {
    next(err);
  }
}
