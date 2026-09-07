import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { sendResponse } from '../../shared/apiResponse';
import type { AuthenticatedRequest } from '../../shared/types';
import * as reports from './gst-reports.service';
import * as masters from './gst-master.service';

export const gstRoutes = Router();

/**
 * GST reports show the hospital's complete revenue position, so they are not
 * open to everyone who can read a bill.
 *
 * `billing:read` is too wide — doctor and patient both hold it, and neither
 * should see the hospital's turnover or its tax liability. `billing:approve` is
 * the narrowest existing permission that still covers the people who need
 * these: the front desk, billing admin, insurance staff and hospital admin.
 * That matches the instruction that the accounts/GST team owns the reports and
 * management gets access.
 */
const gstReportAccess = [authenticate, requirePermission('billing', 'approve')];

const advancesQuerySchema = z.object({
  query: z.object({
    // Plain YYYY-MM-DD. A filter missing from this schema is silently dropped
    // by validate(), so every supported filter has to be named here.
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    patientId: z.string().uuid().optional(),
    treatment: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated']).optional(),
  }),
});

/**
 * A-10 — Advances & Advance Adjustments.
 *
 * What came in before a supply, what tax fell due on it, what has since been
 * adjusted against an invoice, and what is still held. Feeds GSTR-1 table 11.
 */
gstRoutes.get(
  '/reports/advances',
  ...gstReportAccess,
  validate(advancesQuerySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await reports.getAdvancesReport(req.user!.tenantId, req.query as never);
      sendResponse({ res, message: 'Advances and advance adjustments', data });
    } catch (err) {
      next(err);
    }
  },
);

// --- Platform SAC master (super admin only, like the HSN master) ---

gstRoutes.get(
  '/sac-codes',
  authenticate,
  requireRoles('super_admin'),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      sendResponse({ res, message: 'SAC codes', data: await masters.listSacCodes() });
    } catch (err) {
      next(err);
    }
  },
);
