import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as imagingService from './imaging.service';

// ============================================================
// Imaging Requests
// ============================================================

export async function createImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await imagingService.createImagingRequest(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Imaging request created successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function getImagingRequests(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { requests, total, page, limit } = await imagingService.getImagingRequests(tenantId, req.query as any);
    sendPaginatedResponse(res, requests, total, page, limit, 'Imaging requests retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getImagingRequestById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await imagingService.getImagingRequestById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Imaging request retrieved successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function updateImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await imagingService.updateImagingRequest(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Imaging request updated successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function cancelImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await imagingService.cancelImagingRequest(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Imaging request cancelled successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function closeImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await imagingService.closeImagingRequest(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Imaging request closed', data: request });
  } catch (err) {
    next(err);
  }
}

export async function reopenImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await imagingService.reopenImagingRequest(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'Imaging request reopened', data: request });
  } catch (err) {
    next(err);
  }
}

export async function scheduleImaging(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const request = await imagingService.scheduleImaging(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Imaging request scheduled successfully', data: request });
  } catch (err) {
    next(err);
  }
}

export async function verifyImagingPayment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const request = await imagingService.verifyImagingPayment(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'Imaging payment verified', data: request });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Imaging Results
// ============================================================

export async function uploadImagingResult(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await imagingService.uploadImagingResult(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Imaging result uploaded successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getImagingResults(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { results, total, page, limit } = await imagingService.getImagingResults(tenantId, req.query as any);
    sendPaginatedResponse(res, results, total, page, limit, 'Imaging results retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getImagingResultById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await imagingService.getImagingResultById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Imaging result retrieved successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function addImagingReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await imagingService.addImagingReport(tenantId, req.params.id as string, userId, req.body);
    sendResponse({ res, message: 'Imaging report added successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function editImagingResult(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await imagingService.editImagingResult(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Imaging result updated successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifyImagingResult(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await imagingService.verifyImagingResult(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'Imaging result verified successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getImagingAnalytics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await imagingService.getImagingAnalytics(tenantId, {
      fromDate: req.query.fromDate as string | undefined,
      toDate: req.query.toDate as string | undefined,
    });
    sendResponse({ res, message: 'Imaging analytics retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}

export async function getImagingDashboard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await imagingService.getImagingDashboard(tenantId);
    sendResponse({ res, message: 'Imaging dashboard retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}

export async function getImagingBillingSummary(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await imagingService.getImagingBillingSummary(tenantId, {
      fromDate: req.query.fromDate as string | undefined,
      toDate: req.query.toDate as string | undefined,
    });
    sendResponse({ res, message: 'Imaging billing summary retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}
