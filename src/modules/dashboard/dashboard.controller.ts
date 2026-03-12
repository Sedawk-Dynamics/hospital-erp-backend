import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as dashboardService from './dashboard.service';

/**
 * GET /api/v1/dashboard/stats
 * Returns aggregated dashboard statistics for the authenticated user's tenant.
 */
export async function getStats(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const stats = await dashboardService.getDashboardStats(tenantId);
    sendResponse({
      res,
      message: 'Dashboard stats retrieved successfully',
      data: stats,
    });
  } catch (err) {
    next(err);
  }
}
