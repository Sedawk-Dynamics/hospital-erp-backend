import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as merge from './insurance.merge.service';
import * as escalation from './insurance.escalation';

// ============================================================
// Gap 293 — merge duplicate insurers / TPAs (Hospital Admin only)
// ============================================================
function previewHandler(kind: merge.MergeablePayerKind) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      merge.assertCanMergePayers(req.user!.roles);
      const data = await merge.previewPayerMerge(kind, req.user!.tenantId, req.params.id as string, String(req.query.keepId));
      sendResponse({ res, message: 'Merge preview', data });
    } catch (err) { next(err); }
  };
}

function mergeHandler(kind: merge.MergeablePayerKind) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await merge.mergePayers(
        kind,
        req.user!.tenantId,
        { userId: req.user!.userId, roles: req.user!.roles },
        req.params.id as string,
        req.body.keepId,
      );
      sendResponse({ res, message: `${kind === 'insurer' ? 'Insurer' : 'TPA'} merged`, data });
    } catch (err) { next(err); }
  };
}

export const previewInsurerMerge = previewHandler('insurer');
export const mergeInsurer = mergeHandler('insurer');
export const previewTpaMerge = previewHandler('tpa');
export const mergeTpa = mergeHandler('tpa');

// ============================================================
// Gap 294 — SLA escalation settings and stale-request closure
// ============================================================
export async function getEscalationSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await escalation.getEscalationSettings(req.user!.tenantId);
    sendResponse({ res, message: 'Escalation settings retrieved', data });
  } catch (err) { next(err); }
}

export async function updateEscalationSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await escalation.updateEscalationSettings(req.user!.tenantId, req.user!.userId, req.body.settings);
    sendResponse({ res, message: 'Escalation settings saved', data });
  } catch (err) { next(err); }
}

export async function closeStalePreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await escalation.closeStalePreAuth(req.user!.tenantId, req.user!.userId, req.params.id as string, req.body.reason);
    sendResponse({ res, message: 'Request closed', data });
  } catch (err) { next(err); }
}

export async function closeStaleClaimQuery(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await escalation.closeStaleClaimQuery(req.user!.tenantId, req.user!.userId, req.params.queryId as string, req.body.reason);
    sendResponse({ res, message: 'Query closed', data });
  } catch (err) { next(err); }
}
