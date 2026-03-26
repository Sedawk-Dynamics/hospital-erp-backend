import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { linkBankAccountSchema } from './bank-linking.validation';
import * as controller from './bank-linking.controller';

export const bankLinkingRoutes = Router();

// POST /api/v1/bank-linking/link
bankLinkingRoutes.post(
  '/link',
  authenticate,
  requireRoles('admin', 'super_admin'),
  validate(linkBankAccountSchema),
  controller.linkBankAccount,
);

// GET /api/v1/bank-linking/status
bankLinkingRoutes.get(
  '/status',
  authenticate,
  controller.getBankLinkStatus,
);

// DELETE /api/v1/bank-linking/unlink
bankLinkingRoutes.delete(
  '/unlink',
  authenticate,
  requireRoles('admin', 'super_admin'),
  controller.unlinkBankAccount,
);
