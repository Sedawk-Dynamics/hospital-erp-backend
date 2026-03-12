import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './dashboard.controller';

export const dashboardRoutes = Router();

// GET /api/v1/dashboard/stats
dashboardRoutes.get('/stats', authenticate, controller.getStats);
