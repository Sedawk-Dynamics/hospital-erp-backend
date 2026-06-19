import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './ot-kits.service';

const ctx = (req: AuthenticatedRequest) => ({
  tenantId: req.user!.tenantId,
  userId: req.user!.userId,
  roles: req.user!.roles ?? [],
});

export async function createTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.createKitTemplate(tenantId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Kit template created', data });
  } catch (err) { next(err); }
}

export async function listTemplates(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listKitTemplates(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Kit templates', data });
  } catch (err) { next(err); }
}

export async function updateTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.updateKitTemplate(tenantId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Kit template updated', data });
  } catch (err) { next(err); }
}

export async function deleteTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.deleteKitTemplate(tenantId, roles, req.params.id as string);
    sendResponse({ res, message: 'Kit template removed', data });
  } catch (err) { next(err); }
}

export async function issueKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.issueKit(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Kit issued to OT', data });
  } catch (err) { next(err); }
}

export async function reconcileKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.reconcileKit(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Kit reconciled (net billed)', data });
  } catch (err) { next(err); }
}

export async function cancelKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.cancelKitIssue(tenantId, userId, roles, req.params.id as string);
    sendResponse({ res, message: 'Kit issue cancelled', data });
  } catch (err) { next(err); }
}

export async function listIssues(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listKitIssues(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'OT kit issues', data });
  } catch (err) { next(err); }
}

export async function getIssue(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getKitIssue(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'OT kit issue', data });
  } catch (err) { next(err); }
}
