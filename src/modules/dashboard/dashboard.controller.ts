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

/**
 * GET /api/v1/dashboard/revenue?date=YYYY-MM-DD&kind=revenue|advances
 * The payments behind the money tiles (gap item 360) — the tiles link here.
 */
export async function getRevenueRows(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const kind = req.query.kind === 'advances' ? 'advances' : 'revenue';
    const data = await dashboardService.getRevenueRows(tenantId, { date, kind });
    sendResponse({ res, message: 'Revenue rows retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}
