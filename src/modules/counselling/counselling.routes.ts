import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './counselling.controller';
import {
  counsellingStatsSchema,
  createCounsellingSessionSchema,
  listCounsellingSessionsSchema,
  sessionIdParamSchema,
  updateCounsellingSessionSchema,
  updateCounsellingStatusSchema,
} from './counselling.validation';

// Counselling sessions & referrals (gap #200 / #298). Mounted behind
// `authenticate` in modules/router.ts; every route is gated on the
// `counselling` permission module, which only counsellor, admin and
// super_admin hold — any other role gets 403 even calling the API directly.
export const counsellingRoutes = Router();

// Literal paths first so `/sessions/:id` never swallows "stats".
counsellingRoutes.get('/counsellors', requirePermission('counselling', 'read'), controller.listCounsellors);
counsellingRoutes.get(
  '/sessions/stats',
  requirePermission('counselling', 'read'),
  validate(counsellingStatsSchema),
  controller.getStats,
);
counsellingRoutes.get(
  '/sessions',
  requirePermission('counselling', 'read'),
  validate(listCounsellingSessionsSchema),
  controller.listSessions,
);
counsellingRoutes.post(
  '/sessions',
  requirePermission('counselling', 'create'),
  validate(createCounsellingSessionSchema),
  controller.createSession,
);
counsellingRoutes.get(
  '/sessions/:id',
  requirePermission('counselling', 'read'),
  validate(sessionIdParamSchema),
  controller.getSession,
);
counsellingRoutes.patch(
  '/sessions/:id/status',
  requirePermission('counselling', 'update'),
  validate(updateCounsellingStatusSchema),
  controller.updateStatus,
);
counsellingRoutes.patch(
  '/sessions/:id',
  requirePermission('counselling', 'update'),
  validate(updateCounsellingSessionSchema),
  controller.updateSession,
);
