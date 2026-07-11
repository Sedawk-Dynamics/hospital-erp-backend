import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './indents.service';

const ctx = (req: AuthenticatedRequest) => ({
  tenantId: req.user!.tenantId,
  userId: req.user!.userId,
  roles: req.user!.roles ?? [],
});

export async function raiseIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.raiseIndent(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Indent raised to IP pharmacy', data });
  } catch (err) { next(err); }
}

export async function confirmDraftIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.confirmDraftIndent(tenantId, userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Draft indent confirmed and sent to pharmacy', data });
  } catch (err) { next(err); }
}

export async function createTtoIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.createTtoIndentFromPrescription(tenantId, userId, req.params.prescriptionId as string);
    sendResponse({ res, statusCode: 201, message: 'TTO (discharge) indent raised to pharmacy', data });
  } catch (err) { next(err); }
}

export async function approveIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.approveIndent(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Indent approved', data });
  } catch (err) { next(err); }
}

export async function dispenseIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.dispenseIndent(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Indent dispensed to IP bill', data });
  } catch (err) { next(err); }
}

export async function returnIndentItems(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.returnIndentItems(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Items returned to pharmacy and credited to the IP bill', data });
  } catch (err) { next(err); }
}

export async function markDelivered(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.markDelivered(tenantId, userId, roles, req.params.id as string);
    sendResponse({ res, message: 'Indent marked delivered', data });
  } catch (err) { next(err); }
}

export async function acknowledgeIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.acknowledgeIndent(tenantId, userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Indent acknowledged by ward', data });
  } catch (err) { next(err); }
}

export async function cancelIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.cancelIndent(tenantId, userId, req.params.id as string, req.body?.reason);
    sendResponse({ res, message: 'Indent cancelled', data });
  } catch (err) { next(err); }
}

export async function listIndents(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listIndents(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Medication indents', data });
  } catch (err) { next(err); }
}

export async function getIndent(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getIndentById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Medication indent', data });
  } catch (err) { next(err); }
}
