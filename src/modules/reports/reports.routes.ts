import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './reports.controller';
import {
  createSavedReportSchema,
  getSavedReportsQuerySchema,
  savedReportIdParamSchema,
  updateSavedReportSchema,
  generateReportSchema,
  exportReportSchema,
  createScheduledReportSchema,
  getScheduledReportsQuerySchema,
  scheduledReportIdParamSchema,
  updateScheduledReportSchema,
  toggleScheduledReportSchema,
  createSupportTicketSchema,
  getSupportTicketsQuerySchema,
  supportTicketIdParamSchema,
  updateSupportTicketSchema,
  addSupportTicketCommentSchema,
  closeSupportTicketSchema,
} from './reports.validation';

export const reportsRoutes = Router();

// --- Saved Reports ---
reportsRoutes.post('/saved', authenticate, requirePermission('reports', 'create'), validate(createSavedReportSchema), controller.createSavedReport);
reportsRoutes.get('/saved', authenticate, requirePermission('reports', 'create'), validate(getSavedReportsQuerySchema), controller.getSavedReports);
reportsRoutes.get('/saved/:id', authenticate, requirePermission('reports', 'create'), validate(savedReportIdParamSchema), controller.getSavedReportById);
reportsRoutes.put('/saved/:id', authenticate, requirePermission('reports', 'create'), validate(updateSavedReportSchema), controller.updateSavedReport);
reportsRoutes.delete('/saved/:id', authenticate, requirePermission('reports', 'delete'), validate(savedReportIdParamSchema), controller.deleteSavedReport);
reportsRoutes.post('/saved/:id/generate', authenticate, requirePermission('reports', 'create'), validate(generateReportSchema), controller.generateReport);
reportsRoutes.get('/saved/:id/export', authenticate, requirePermission('reports', 'create'), validate(exportReportSchema), controller.exportReport);

// --- Scheduled Reports ---
reportsRoutes.post('/scheduled', authenticate, requirePermission('reports', 'create'), validate(createScheduledReportSchema), controller.createScheduledReport);
reportsRoutes.get('/scheduled', authenticate, requirePermission('reports', 'create'), validate(getScheduledReportsQuerySchema), controller.getScheduledReports);
reportsRoutes.get('/scheduled/:id', authenticate, requirePermission('reports', 'create'), validate(scheduledReportIdParamSchema), controller.getScheduledReportById);
reportsRoutes.put('/scheduled/:id', authenticate, requirePermission('reports', 'create'), validate(updateScheduledReportSchema), controller.updateScheduledReport);
reportsRoutes.delete('/scheduled/:id', authenticate, requirePermission('reports', 'delete'), validate(scheduledReportIdParamSchema), controller.deleteScheduledReport);
reportsRoutes.patch('/scheduled/:id/toggle', authenticate, requirePermission('reports', 'create'), validate(toggleScheduledReportSchema), controller.toggleScheduledReport);

// --- Support Tickets ---
reportsRoutes.post('/support-tickets', authenticate, requirePermission('reports', 'create'), validate(createSupportTicketSchema), controller.createSupportTicket);
reportsRoutes.get('/support-tickets', authenticate, requirePermission('reports', 'read'), validate(getSupportTicketsQuerySchema), controller.getSupportTickets);
reportsRoutes.get('/support-tickets/:id', authenticate, requirePermission('reports', 'read'), validate(supportTicketIdParamSchema), controller.getSupportTicketById);
reportsRoutes.put('/support-tickets/:id', authenticate, requirePermission('reports', 'update'), validate(updateSupportTicketSchema), controller.updateSupportTicket);
reportsRoutes.post('/support-tickets/:id/comments', authenticate, requirePermission('reports', 'create'), validate(addSupportTicketCommentSchema), controller.addSupportTicketComment);
reportsRoutes.patch('/support-tickets/:id/close', authenticate, requirePermission('reports', 'update'), validate(closeSupportTicketSchema), controller.closeSupportTicket);
