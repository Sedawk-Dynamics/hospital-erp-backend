import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { sendResponse } from '../../shared/apiResponse';
import type { AuthenticatedRequest } from '../../shared/types';
import * as service from './follow-up-rules.service';

// Gap #019/#331. What a follow-up costs is set by the Hospital Admin and by
// nobody else; whoever books appointments may read it.
export const followUpRulesRoutes = Router();

const canRead = [authenticate, requirePermission('appointments', 'read')];
const adminOnly = [authenticate, requireRoles(...service.FOLLOW_UP_RULE_ROLES)];

type Handler = (req: AuthenticatedRequest) => Promise<unknown>;
const respond =
  (message: string, run: Handler) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      sendResponse({ res, message, data: await run(req) });
    } catch (err) {
      next(err);
    }
  };

const id = (req: AuthenticatedRequest) => req.params.id as string;
const tenant = (req: AuthenticatedRequest) => req.user!.tenantId;

followUpRulesRoutes.get('/', ...canRead, respond('Follow-up rules', (req) => service.getFollowUpRules(tenant(req), req.user!)));

followUpRulesRoutes.get(
  '/doctors/:id',
  ...canRead,
  respond('Follow-up rule', (req) => service.getDoctorFollowUpRule(tenant(req), id(req), req.user!)),
);

followUpRulesRoutes.put(
  '/hospital',
  ...adminOnly,
  respond('Follow-up rule saved', (req) => service.saveHospitalRule(tenant(req), req.user!, req.body ?? {})),
);
followUpRulesRoutes.delete(
  '/hospital',
  ...adminOnly,
  respond('Follow-up rule removed', (req) => service.saveHospitalRule(tenant(req), req.user!, null)),
);

followUpRulesRoutes.put(
  '/departments/:id',
  ...adminOnly,
  respond('Follow-up rule saved', (req) => service.saveDepartmentRule(tenant(req), req.user!, id(req), req.body ?? {})),
);
followUpRulesRoutes.delete(
  '/departments/:id',
  ...adminOnly,
  respond('Follow-up rule removed', (req) => service.saveDepartmentRule(tenant(req), req.user!, id(req), null)),
);

followUpRulesRoutes.put(
  '/doctors/:id',
  ...adminOnly,
  respond('Follow-up rule saved', (req) => service.saveDoctorRule(tenant(req), req.user!, id(req), req.body ?? {})),
);
followUpRulesRoutes.delete(
  '/doctors/:id',
  ...adminOnly,
  respond('Follow-up rule removed', (req) => service.saveDoctorRule(tenant(req), req.user!, id(req), null)),
);
