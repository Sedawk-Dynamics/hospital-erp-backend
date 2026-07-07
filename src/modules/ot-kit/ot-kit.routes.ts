import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './ot-kit.controller';
import {
  createTemplateSchema,
  updateTemplateSchema,
  templateIdParamSchema,
  listTemplatesQuerySchema,
  requestKitSchema,
  issueKitSchema,
  reconcileKitSchema,
  cancelKitSchema,
  issueIdParamSchema,
  listIssuesQuerySchema,
} from './ot-kit.validation';

export const otKitRoutes = Router();

// --- Surgical templates (preference cards). Reads are open to any authenticated
// staff (the OT nurse browses them to request a kit); writes are pharmacy master
// data (pharmacy_admin). ---
otKitRoutes.get('/templates', authenticate, validate(listTemplatesQuerySchema), controller.listTemplates);
otKitRoutes.get('/templates/:id', authenticate, validate(templateIdParamSchema), controller.getTemplate);
otKitRoutes.post('/templates', authenticate, requirePermission('pharmacy', 'create'), validate(createTemplateSchema), controller.createTemplate);
otKitRoutes.put('/templates/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateTemplateSchema), controller.updateTemplate);
otKitRoutes.delete('/templates/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(templateIdParamSchema), controller.deleteTemplate);

// --- Kit issue lifecycle ---
// Pre-op request by the OT nurse (any authenticated staff — no pharmacy perm).
otKitRoutes.post('/issues/request', authenticate, validate(requestKitSchema), controller.requestKit);
// Bulk issue + transit-lock and post-op reconcile + net-bill are pharmacy actions.
otKitRoutes.post('/issues/issue', authenticate, requirePermission('pharmacy', 'create'), validate(issueKitSchema), controller.issueKit);
otKitRoutes.post('/issues/reconcile', authenticate, requirePermission('pharmacy', 'update'), validate(reconcileKitSchema), controller.reconcileKit);
otKitRoutes.patch('/issues/:id/cancel', authenticate, requirePermission('pharmacy', 'update'), validate(cancelKitSchema), controller.cancelKit);
otKitRoutes.get('/issues', authenticate, validate(listIssuesQuerySchema), controller.listIssues);
otKitRoutes.get('/issues/:id', authenticate, validate(issueIdParamSchema), controller.getIssue);
