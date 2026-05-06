import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './nursing-forms.service';

// Tiny helper — every route follows the same pattern: pull tenantId/
// userId/roles off the auth payload, hand off to the service.
function ctx(req: AuthenticatedRequest) {
  return {
    tenantId: req.user!.tenantId,
    userId: req.user!.userId,
    roles: req.user!.roles ?? [],
  };
}

// ── Intake / Output ──────────────────────────────────────

export async function createIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createIntakeOutput(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Intake/output recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listIntakeOutput(
      tenantId,
      req.query as never,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Intake/output records retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getIntakeOutputTotals(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getIntakeOutputTotals(tenantId, req.query as never);
    sendResponse({ res, message: 'Intake/output totals retrieved', data });
  } catch (err) {
    next(err);
  }
}

// ── Clinical Observation ─────────────────────────────────

export async function createObservation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createObservation(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Observation recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listObservations(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listObservations(tenantId, req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Observations retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Clinical Device / Line ───────────────────────────────

export async function createDevice(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createDevice(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Device recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listDevices(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listDevices(tenantId, req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Devices retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getDevice(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getDevice(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Device retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function updateDevice(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.updateDevice(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Device updated', data });
  } catch (err) {
    next(err);
  }
}

export async function removeDevice(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.removeDevice(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Device removed', data });
  } catch (err) {
    next(err);
  }
}

export async function createDeviceCheck(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createDeviceCheck(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, statusCode: 201, message: 'Device check recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listDeviceChecks(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listDeviceChecks(
      tenantId,
      req.params.id as string,
      req.query as never,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Device checks retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Clinical Procedure ───────────────────────────────────

export async function createProcedure(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createProcedure(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Procedure recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listProcedures(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listProcedures(tenantId, req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Procedures retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getChartingTimeline(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getChartingTimeline(tenantId, req.params.patientId as string);
    sendResponse({ res, message: 'Charting timeline retrieved', data });
  } catch (err) {
    next(err);
  }
}
