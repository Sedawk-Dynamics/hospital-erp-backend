import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './nurse-doctor-assignments.service';

export async function createNurseDoctorAssignments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await service.createNurseDoctorAssignments(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: `Created ${data.created} assignment${data.created === 1 ? '' : 's'}, skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}`,
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function listNurseDoctorAssignments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await service.listNurseDoctorAssignments(tenantId, req.query as any);
    sendPaginatedResponse(
      res,
      result.rows,
      result.total,
      result.page,
      result.limit,
      'Nurse-doctor assignments retrieved',
    );
  } catch (err) {
    next(err);
  }
}

export async function getNurseDoctorAssignmentById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await service.getNurseDoctorAssignmentById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Nurse-doctor assignment retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function endNurseDoctorAssignment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await service.endNurseDoctorAssignment(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Nurse-doctor assignment ended', data });
  } catch (err) {
    next(err);
  }
}

export async function getMyDoctors(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await service.getMyDoctors(tenantId, userId);
    sendResponse({ res, message: 'Assigned doctors retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function getMyPatients(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await service.getMyPatients(tenantId, userId, req.query as any);
    sendPaginatedResponse(
      res,
      result.rows,
      result.total,
      result.page,
      result.limit,
      'My patients retrieved',
    );
  } catch (err) {
    next(err);
  }
}
