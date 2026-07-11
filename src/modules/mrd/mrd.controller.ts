import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as mrdService from './mrd.service';
import { generateDischargeNarrative } from './mrd.discharge-ai';
import { streamDischargeSummaryPdf } from './discharge-summary-pdf';

export async function getMrdDocuments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { documents, total, page, limit } = await mrdService.getMrdDocuments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, documents, total, page, limit, 'MRD documents retrieved');
  } catch (err) {
    next(err);
  }
}

export async function createMrdRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const mrdRequest = await mrdService.createMrdRequest(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'MRD request created successfully',
      data: mrdRequest,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Discharge Summary ====================

export async function generateDischargeSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { admissionId } = req.query as { admissionId: string };
    const result = await mrdService.generateDischargeSummary(tenantId, admissionId);
    sendResponse({
      res,
      statusCode: 200,
      message: 'Discharge summary generated successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDischargeSummaryById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const result = await mrdService.getDischargeSummaryById(tenantId, id);
    sendResponse({
      res,
      statusCode: 200,
      message: 'Discharge summary retrieved successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDischargeSummaryByAdmission(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const admissionId = req.params.admissionId as string;
    const result = await mrdService.getDischargeSummaryByAdmission(tenantId, admissionId);
    sendResponse({
      res,
      statusCode: 200,
      message: 'Discharge summary retrieved successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateDischargeSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const result = await mrdService.updateDischargeSummary(tenantId, id, req.body);
    sendResponse({
      res,
      statusCode: 200,
      message: 'Discharge summary updated successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function signDischargeSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const signatureName = (req.body as { signatureName?: string } | undefined)?.signatureName;
    const result = await mrdService.signDischargeSummary(tenantId, id, userId, signatureName);
    sendResponse({
      res,
      statusCode: 200,
      message: 'Discharge summary signed successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function publishDischargeSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const result = await mrdService.publishDischargeSummary(tenantId, id, userId);
    sendResponse({
      res,
      statusCode: 200,
      message: result.discharged
        ? 'Discharge summary published — patient discharged'
        : 'Discharge summary published successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function refreshDischargeSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const result = await mrdService.refreshDischargeSummary(tenantId, id);
    sendResponse({ res, message: 'Discharge summary refreshed', data: result });
  } catch (err) {
    next(err);
  }
}

// UC4: AI-draft the narrative sections (suggestions only — not persisted).
export async function generateDischargeAiNarrative(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const result = await generateDischargeNarrative(tenantId, id);
    sendResponse({ res, message: 'AI narrative drafted', data: result });
  } catch (err) {
    next(err);
  }
}

export async function downloadDischargeSummaryPdf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const summary = await mrdService.getDischargeSummaryForPdf(tenantId, id);
    streamDischargeSummaryPdf(res, summary as any);
  } catch (err) {
    next(err);
  }
}
