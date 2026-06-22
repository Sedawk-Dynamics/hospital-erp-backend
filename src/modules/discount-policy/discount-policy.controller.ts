import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './discount-policy.service';

export async function getConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getConfig(req.user!.tenantId);
    sendResponse({ res, message: 'Margin-discount config', data });
  } catch (err) {
    next(err);
  }
}

export async function updateConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateConfig(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, message: 'Margin-discount config updated', data });
  } catch (err) {
    next(err);
  }
}

export async function listRules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.listRules(req.user!.tenantId);
    sendResponse({ res, message: 'Margin-discount bands', data });
  } catch (err) {
    next(err);
  }
}

export async function createRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createRule(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Margin-discount band created', data });
  } catch (err) {
    next(err);
  }
}

export async function updateRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateRule(req.user!.tenantId, req.user!.userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Margin-discount band updated', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.deleteRule(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Margin-discount band deleted', data });
  } catch (err) {
    next(err);
  }
}

// The effective policy (enabled + mode + active bands) for the POS to apply
// per-line caps locally without a round-trip per item.
export async function getEffective(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getEffectivePolicy(req.user!.tenantId);
    sendResponse({ res, message: 'Effective margin-discount policy', data });
  } catch (err) {
    next(err);
  }
}

export async function evaluate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.evaluate(req.user!.tenantId, Number(req.query.margin));
    sendResponse({ res, message: 'Margin-discount evaluation', data });
  } catch (err) {
    next(err);
  }
}
