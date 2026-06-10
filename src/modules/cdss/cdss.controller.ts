import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as service from './cdss.service';

export async function validatePrescription(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.validatePrescription(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, message: 'Prescription validated', data });
  } catch (err) { next(err); }
}

export async function getOrderSuggestions(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = service.getOrderRecommendations(req.query as any);
    sendResponse({ res, message: 'Order suggestions retrieved', data });
  } catch (err) { next(err); }
}

export async function evaluateLabResults(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.evaluateLabResults(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Lab results evaluated', data });
  } catch (err) { next(err); }
}

export async function getAlertsFeed(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.getAlertsFeed(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'CDSS alerts retrieved', data });
  } catch (err) { next(err); }
}

export async function getAlertsSummary(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.getAlertsSummary(req.user!.tenantId);
    sendResponse({ res, message: 'CDSS summary retrieved', data });
  } catch (err) { next(err); }
}

export async function acknowledgeAlert(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.acknowledgeAlert(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body?.note,
    );
    sendResponse({ res, message: 'Alert acknowledged', data });
  } catch (err) { next(err); }
}

export async function overrideAlert(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.overrideAlert(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body.reason,
    );
    sendResponse({ res, message: 'Alert overridden', data });
  } catch (err) { next(err); }
}
