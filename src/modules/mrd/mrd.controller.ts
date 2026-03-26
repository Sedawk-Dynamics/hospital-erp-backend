import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as mrdService from './mrd.service';

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
