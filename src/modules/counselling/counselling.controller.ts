import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './counselling.service';
import type { CounsellingFilter, ListCounsellingSessionsQuery } from './counselling.validation';

// Every handler takes the tenant from the authenticated request, never from the
// body or query, so one hospital can never read or write another's sessions.

export async function listSessions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as ListCounsellingSessionsQuery;
    const { data, total, page, limit } = await service.listSessions(req.user!.tenantId, query);
    sendPaginatedResponse(res, data, total, page, limit, 'Counselling sessions');
  } catch (err) {
    next(err);
  }
}

export async function getStats(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getStats(req.user!.tenantId, req.query as unknown as CounsellingFilter);
    sendResponse({ res, message: 'Counselling session counts', data });
  } catch (err) {
    next(err);
  }
}

export async function getSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getSession(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Counselling session', data });
  } catch (err) {
    next(err);
  }
}

export async function listCounsellors(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listCounsellors(req.user!.tenantId);
    sendResponse({ res, message: 'Counsellors', data });
  } catch (err) {
    next(err);
  }
}

export async function createSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createSession(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Counselling session booked', data });
  } catch (err) {
    next(err);
  }
}

export async function updateStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateStatus(req.user!.tenantId, req.user!.userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Counselling session status updated', data });
  } catch (err) {
    next(err);
  }
}

export async function updateSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateSession(req.user!.tenantId, req.user!.userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Counselling session updated', data });
  } catch (err) {
    next(err);
  }
}
