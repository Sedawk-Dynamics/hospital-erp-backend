import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './dashboard.controller';

export const dashboardRoutes = Router();

// GET /api/v1/dashboard/stats
dashboardRoutes.get('/stats', authenticate, controller.getStats);

// GET /api/v1/dashboard/revenue — the rows behind the money tiles (gap item 360).
dashboardRoutes.get('/revenue', authenticate, requirePermission('billing', 'read'), controller.getRevenueRows);
