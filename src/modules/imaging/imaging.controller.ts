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

export async function getImagingCatalog(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await imagingService.getImagingCatalog(tenantId, {
      search: req.query.search as string | undefined,
      modality: req.query.modality as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    sendResponse({ res, message: 'Imaging catalog retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function getImagingRequests(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    // Roles decide whether unreleased result content comes back: radiology
    // staff see their own drafts, everyone else waits for admin approval.
    const { requests, total, page, limit } = await imagingService.getImagingRequests(
      tenantId,
      req.query as any,
      req.user!.roles ?? [],
    );
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

/**
 * The radiology admin's one act: charge the study, take the money (or record
 * why not), admit it and hand it to a radiologist.
 */
export async function acceptImagingRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const request = await imagingService.acceptImagingRequest(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Imaging request accepted', data: request });
  } catch (err) {
    next(err);
  }
}

/** What accepting will cost and where it settles. Posts nothing. */
export async function getImagingBillingPreview(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const preview = await imagingService.getImagingBillingPreview(
      req.user!.tenantId,
      req.params.id as string,
    );
    sendResponse({ res, message: 'Imaging billing preview', data: preview });
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

/** Radiologist's Mark as Done — draft → awaiting admin approval. */
export async function submitImagingResult(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await imagingService.submitImagingResult(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.impression,
    );
    sendResponse({ res, message: 'Report marked done — sent for admin approval', data: result });
  } catch (err) {
    next(err);
  }
}

/** Admin sends a submitted report back to the radiologist for changes. */
export async function reopenImagingResult(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await imagingService.reopenImagingResult(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.reason,
    );
    sendResponse({ res, message: 'Report sent back to the radiologist', data: result });
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
