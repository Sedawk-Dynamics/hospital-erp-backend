import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './nurse-assignments.service';

export async function createNurseAssignment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await service.createNurseAssignment(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Nurse assignment created', data });
  } catch (err) {
    next(err);
  }
}

export async function listNurseAssignments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await service.listNurseAssignments(tenantId, req.query as any);
    sendPaginatedResponse(
      res,
      result.rows,
      result.total,
      result.page,
      result.limit,
      'Nurse assignments retrieved',
    );
  } catch (err) {
    next(err);
  }
}

export async function getNurseAssignmentById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await service.getNurseAssignmentById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Nurse assignment retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function updateNurseAssignment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await service.updateNurseAssignment(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Nurse assignment updated', data });
  } catch (err) {
    next(err);
  }
}

export async function endNurseAssignment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await service.endNurseAssignment(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Nurse assignment ended', data });
  } catch (err) {
    next(err);
  }
}

export async function handoverNurseAssignment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await service.handoverNurseAssignment(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Nurse assignment handed over', data });
  } catch (err) {
    next(err);
  }
}

export async function getHandoverFeed(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const query = req.query as any;
    // Default to the authenticated user; admin tooling can pass a userId.
    const target = query.userId ?? req.user!.userId;
    const data = await service.getHandoverFeedForNurse(tenantId, target, query);
    sendResponse({ res, message: 'Handover feed retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function bulkHandoverAssignments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await service.bulkHandoverAssignments(tenantId, userId, req.body);
    sendResponse({ res, message: 'Bulk handover complete', data });
  } catch (err) {
    next(err);
  }
}
