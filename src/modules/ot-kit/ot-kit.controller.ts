import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './ot-kit.service';

const ctx = (req: AuthenticatedRequest) => ({
  tenantId: req.user!.tenantId,
  userId: req.user!.userId,
  roles: req.user!.roles ?? [],
});

// --- Templates ---
export async function listTemplates(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listTemplates(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Surgical templates', data });
  } catch (err) { next(err); }
}

export async function getTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getTemplateById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Surgical template', data });
  } catch (err) { next(err); }
}

export async function createTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createTemplate(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Surgical template created', data });
  } catch (err) { next(err); }
}

export async function updateTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.updateTemplate(tenantId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Surgical template updated', data });
  } catch (err) { next(err); }
}

export async function deleteTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.deleteTemplate(tenantId, roles, req.params.id as string);
    sendResponse({ res, message: 'Surgical template retired', data });
  } catch (err) { next(err); }
}

// --- Kit issue lifecycle ---
export async function requestKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.requestKit(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'OT kit requested', data });
  } catch (err) { next(err); }
}

export async function issueKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.issueKit(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'OT kit issued (transit lock)', data });
  } catch (err) { next(err); }
}

export async function reconcileKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.reconcileKit(tenantId, userId, roles, req.body);
    sendResponse({ res, message: 'OT kit reconciled (net billed)', data });
  } catch (err) { next(err); }
}

export async function cancelKit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.cancelKit(tenantId, userId, roles, req.params.id as string, req.body?.reason);
    sendResponse({ res, message: 'OT kit cancelled', data });
  } catch (err) { next(err); }
}

export async function listIssues(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listIssues(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'OT kit issues', data });
  } catch (err) { next(err); }
}

export async function getIssue(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getIssueById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'OT kit issue', data });
  } catch (err) { next(err); }
}
