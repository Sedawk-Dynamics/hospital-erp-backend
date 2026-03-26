import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as patientPortalService from './patient-portal.service';

const router = Router();

router.use(authenticate);

// GET /patient-connections — List connection requests for this hospital
router.get(
  '/',
  requirePermission('patients', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await patientPortalService.listConnectionRequests(req.user!.tenantId, {
        status: req.query.status as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      });
      sendResponse({
        res,
        statusCode: 200,
        message: 'Connection requests',
        data: result.data,
        meta: {
          page: result.meta.page,
          limit: result.meta.limit,
          total: result.meta.total,
          totalPages: Math.ceil(result.meta.total / result.meta.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /patient-connections/:id/approve
router.post(
  '/:id/approve',
  requirePermission('patients', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const connection = await patientPortalService.approveConnection(
        req.user!.tenantId,
        req.params.id as string,
        req.user!.userId,
      );
      sendResponse({ res, statusCode: 200, message: 'Connection approved', data: connection });
    } catch (err) {
      next(err);
    }
  },
);

// POST /patient-connections/:id/reject
router.post(
  '/:id/reject',
  requirePermission('patients', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const connection = await patientPortalService.rejectConnection(
        req.user!.tenantId,
        req.params.id as string,
        req.user!.userId,
        req.body.reason,
      );
      sendResponse({ res, statusCode: 200, message: 'Connection rejected', data: connection });
    } catch (err) {
      next(err);
    }
  },
);

export { router as connectionAdminRoutes };
