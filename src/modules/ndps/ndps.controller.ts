import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './ndps.service';

const ctx = (req: AuthenticatedRequest) => ({
  tenantId: req.user!.tenantId,
  userId: req.user!.userId,
  roles: req.user!.roles ?? [],
});

export async function listLocations(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listLocations(req.user!.tenantId);
    sendResponse({ res, message: 'NDPS locations', data });
  } catch (err) { next(err); }
}

export async function createLocation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.createLocation(tenantId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Location created', data });
  } catch (err) { next(err); }
}

export async function receiveConsignment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.receiveConsignment(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'NDPS consignment received (Form 3C)', data });
  } catch (err) { next(err); }
}

export async function transferStock(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.transferStock(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'NDPS stock transferred', data });
  } catch (err) { next(err); }
}

export async function recordConsumption(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.recordConsumption(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'NDPS consumption recorded (Form 3E)', data });
  } catch (err) { next(err); }
}

export async function logDisposal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.logDisposal(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'NDPS disposal logged', data });
  } catch (err) { next(err); }
}

export async function runDailyClose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.runDailyClose(req.user!.tenantId, req.body?.date);
    sendResponse({ res, message: 'NDPS daily close run (Form 3H)', data });
  } catch (err) { next(err); }
}

export async function verifyDailyBalance(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.verifyDailyBalance(tenantId, userId, roles, req.params.id as string, req.body.physicalCount);
    sendResponse({ res, message: 'Daily account verified', data });
  } catch (err) { next(err); }
}

export async function getStockByLocation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getStockByLocation(req.user!.tenantId, req.query.drugFormularyId as string | undefined);
    sendResponse({ res, message: 'NDPS stock by location', data });
  } catch (err) { next(err); }
}

export async function getRegister(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getRegister(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'NDPS register', data });
  } catch (err) { next(err); }
}

export async function getDailyBalances(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDailyBalances(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'NDPS daily accounts (Form 3H)', data });
  } catch (err) { next(err); }
}

export async function exportRegisterPdf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getRegisterExport(req.user!.tenantId, req.query as any);
    const { streamNdpsRegisterPdf } = await import('./ndps.pdf');
    streamNdpsRegisterPdf(res, data as any);
  } catch (err) { next(err); }
}

export async function exportDailyPdf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDailyExport(req.user!.tenantId, req.query as any);
    const { streamNdpsDailyPdf } = await import('./ndps.pdf');
    streamNdpsDailyPdf(res, data);
  } catch (err) { next(err); }
}
