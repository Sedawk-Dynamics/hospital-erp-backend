import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as reportsService from './reports.service';

// ============================================================
// Saved Reports
// ============================================================

export async function createSavedReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const report = await reportsService.createSavedReport(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Saved report created successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function getSavedReports(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { reports, total, page, limit } = await reportsService.getSavedReports(tenantId, req.query as any);
    sendPaginatedResponse(res, reports, total, page, limit, 'Saved reports retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getSavedReportById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await reportsService.getSavedReportById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Saved report retrieved successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function updateSavedReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await reportsService.updateSavedReport(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Saved report updated successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function deleteSavedReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await reportsService.deleteSavedReport(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Saved report deleted successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function generateReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await reportsService.generateReport(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Report generated successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function exportReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await reportsService.exportReport(tenantId, req.params.id as string, req.query as any);
    sendResponse({ res, message: 'Report export initiated successfully', data: result });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Scheduled Reports
// ============================================================

export async function createScheduledReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const report = await reportsService.createScheduledReport(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Scheduled report created successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function getScheduledReports(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { reports, total, page, limit } = await reportsService.getScheduledReports(tenantId, req.query as any);
    sendPaginatedResponse(res, reports, total, page, limit, 'Scheduled reports retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getScheduledReportById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await reportsService.getScheduledReportById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Scheduled report retrieved successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function updateScheduledReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await reportsService.updateScheduledReport(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Scheduled report updated successfully', data: report });
  } catch (err) {
    next(err);
  }
}

export async function deleteScheduledReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await reportsService.deleteScheduledReport(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Scheduled report deleted successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function toggleScheduledReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await reportsService.toggleScheduledReport(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Scheduled report toggled successfully', data: report });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Support Tickets
// ============================================================

export async function createSupportTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const ticket = await reportsService.createSupportTicket(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Support ticket created successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function getSupportTickets(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { tickets, total, page, limit } = await reportsService.getSupportTickets(tenantId, req.query as any);
    sendPaginatedResponse(res, tickets, total, page, limit, 'Support tickets retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getSupportTicketById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const ticket = await reportsService.getSupportTicketById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Support ticket retrieved successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function updateSupportTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const ticket = await reportsService.updateSupportTicket(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Support ticket updated successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function addSupportTicketComment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const ticket = await reportsService.addSupportTicketComment(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Comment added successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}

export async function closeSupportTicket(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const ticket = await reportsService.closeSupportTicket(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Support ticket closed successfully', data: ticket });
  } catch (err) {
    next(err);
  }
}
