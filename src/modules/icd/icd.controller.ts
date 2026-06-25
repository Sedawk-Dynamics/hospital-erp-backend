import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './icd.service';

export async function searchIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { q, limit } = req.query as { q: string; limit?: string };
    const results = await service.searchIcdCodes(
      req.user!.tenantId,
      q,
      limit ? Number(limit) : undefined,
    );
    sendResponse({ res, message: 'ICD code search', data: results });
  } catch (err) {
    next(err);
  }
}

export async function listIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { items, total, page, limit } = await service.listIcdCodes(req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'ICD codes retrieved');
  } catch (err) {
    next(err);
  }
}

export async function createIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const code = await service.createIcdCode(req.user!.roles ?? [], req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'ICD code created', data: code });
  } catch (err) {
    next(err);
  }
}

export async function updateIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const code = await service.updateIcdCode(req.user!.roles ?? [], req.params.id as string, req.body);
    sendResponse({ res, message: 'ICD code updated', data: code });
  } catch (err) {
    next(err);
  }
}

export async function deleteIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.deleteIcdCode(req.user!.roles ?? [], req.params.id as string);
    sendResponse({ res, message: 'ICD code deleted', data: result });
  } catch (err) {
    next(err);
  }
}

export async function createCustomIcd(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const code = await service.createCustomIcdCode(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Custom ICD code created', data: code });
  } catch (err) {
    next(err);
  }
}
