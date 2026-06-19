import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './ot-kits.controller';
import {
  createKitTemplateSchema,
  updateKitTemplateSchema,
  issueKitSchema,
  reconcileKitSchema,
  listIssuesQuerySchema,
} from './ot-kits.validation';

export const otKitsRoutes = Router();

// Surgical kit templates (master).
otKitsRoutes.get('/templates', authenticate, requirePermission('pharmacy', 'read'), controller.listTemplates);
otKitsRoutes.post('/templates', authenticate, requirePermission('pharmacy', 'create'), validate(createKitTemplateSchema), controller.createTemplate);
otKitsRoutes.put('/templates/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateKitTemplateSchema), controller.updateTemplate);
otKitsRoutes.delete('/templates/:id', authenticate, requirePermission('pharmacy', 'delete'), controller.deleteTemplate);

// Issue → reconcile (net bill) → cancel.
otKitsRoutes.get('/issues', authenticate, requirePermission('pharmacy', 'read'), validate(listIssuesQuerySchema), controller.listIssues);
otKitsRoutes.get('/issues/:id', authenticate, requirePermission('pharmacy', 'read'), controller.getIssue);
otKitsRoutes.post('/issues', authenticate, requirePermission('pharmacy', 'create'), validate(issueKitSchema), controller.issueKit);
otKitsRoutes.patch('/issues/:id/reconcile', authenticate, requirePermission('pharmacy', 'update'), validate(reconcileKitSchema), controller.reconcileKit);
otKitsRoutes.patch('/issues/:id/cancel', authenticate, requirePermission('pharmacy', 'update'), controller.cancelKit);
