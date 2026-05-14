import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createTicketSchema,
  getTicketsQuerySchema,
  ticketIdParamSchema,
  updateTicketSchema,
  assignTicketSchema,
  closeTicketSchema,
  submitFeedbackSchema,
  getFeedbackQuerySchema,
  feedbackIdParamSchema,
  respondToFeedbackSchema,
  getAuditLogsQuerySchema,
  auditLogIdParamSchema,
  auditLogsByEntitySchema,
  createComplianceDocSchema,
  getComplianceDocsQuerySchema,
  complianceDocIdParamSchema,
  updateComplianceDocSchema,
  approveComplianceDocSchema,
  createOtRequestSchema,
  getOtRequestsQuerySchema,
  otRequestIdParamSchema,
  approveOtRequestSchema,
  scheduleOtSchema,
  updateOtRequestSchema,
  otAnalyticsQuerySchema,
  createOtSchema,
  updateOtSchema,
  otIdParamSchema,
  reportIncidentSchema,
  getIncidentsQuerySchema,
  incidentIdParamSchema,
  updateIncidentSchema,
  investigateIncidentSchema,
  closeIncidentSchema,
} from './compliance.validation';
import * as controller from './compliance.controller';

export const complianceRoutes = Router();

// --- Tickets ---
complianceRoutes.post('/tickets', authenticate, requirePermission('tickets', 'create'), validate(createTicketSchema), controller.createTicket);
complianceRoutes.get('/tickets', authenticate, requirePermission('tickets', 'read'), validate(getTicketsQuerySchema), controller.getTickets);
complianceRoutes.get('/tickets/:id', authenticate, requirePermission('tickets', 'read'), validate(ticketIdParamSchema), controller.getTicketById);
complianceRoutes.put('/tickets/:id', authenticate, requirePermission('tickets', 'update'), validate(updateTicketSchema), controller.updateTicket);
complianceRoutes.patch('/tickets/:id/assign', authenticate, requirePermission('tickets', 'update'), validate(assignTicketSchema), controller.assignTicket);
complianceRoutes.patch('/tickets/:id/close', authenticate, requirePermission('tickets', 'approve'), validate(closeTicketSchema), controller.closeTicket);

// --- Feedback ---
complianceRoutes.post('/feedback', authenticate, requirePermission('compliance', 'create'), validate(submitFeedbackSchema), controller.submitFeedback);
complianceRoutes.get('/feedback', authenticate, requirePermission('compliance', 'read'), validate(getFeedbackQuerySchema), controller.getFeedback);
complianceRoutes.get('/feedback/:id', authenticate, requirePermission('compliance', 'read'), validate(feedbackIdParamSchema), controller.getFeedbackById);
complianceRoutes.post('/feedback/:id/respond', authenticate, requirePermission('compliance', 'update'), validate(respondToFeedbackSchema), controller.respondToFeedback);

// --- Audit Logs (read + export only --- logs are immutable) ---
complianceRoutes.get('/audit-logs', authenticate, requirePermission('audit_logs', 'read'), validate(getAuditLogsQuerySchema), controller.getAuditLogs);
complianceRoutes.get('/audit-logs/:id', authenticate, requirePermission('audit_logs', 'read'), validate(auditLogIdParamSchema), controller.getAuditLogById);
complianceRoutes.get('/audit-logs/entity/:entityType/:entityId', authenticate, requirePermission('audit_logs', 'read'), validate(auditLogsByEntitySchema), controller.getAuditLogsByEntity);

// --- Compliance Documents ---
complianceRoutes.post('/documents', authenticate, requirePermission('compliance', 'create'), validate(createComplianceDocSchema), controller.createComplianceDoc);
complianceRoutes.get('/documents', authenticate, requirePermission('compliance', 'read'), validate(getComplianceDocsQuerySchema), controller.getComplianceDocs);
complianceRoutes.get('/documents/:id', authenticate, requirePermission('compliance', 'read'), validate(complianceDocIdParamSchema), controller.getComplianceDocById);
complianceRoutes.put('/documents/:id', authenticate, requirePermission('compliance', 'update'), validate(updateComplianceDocSchema), controller.updateComplianceDoc);
complianceRoutes.patch('/documents/:id/approve', authenticate, requirePermission('compliance', 'approve'), validate(approveComplianceDocSchema), controller.approveComplianceDoc);

// --- OT Requests ---
// Analytics endpoint comes first so it's not shadowed by the `:id` matcher.
complianceRoutes.get('/ot-requests/analytics', authenticate, validate(otAnalyticsQuerySchema), controller.otAnalytics);
complianceRoutes.post('/ot-requests', authenticate, validate(createOtRequestSchema), controller.createOTRequest);
complianceRoutes.get('/ot-requests', authenticate, validate(getOtRequestsQuerySchema), controller.getOTRequests);
complianceRoutes.get('/ot-requests/:id', authenticate, validate(otRequestIdParamSchema), controller.getOTRequestById);
complianceRoutes.patch('/ot-requests/:id', authenticate, validate(updateOtRequestSchema), controller.updateOTRequest);
complianceRoutes.patch('/ot-requests/:id/approve', authenticate, validate(approveOtRequestSchema), controller.approveOTRequest);
complianceRoutes.patch('/ot-requests/:id/schedule', authenticate, validate(scheduleOtSchema), controller.scheduleOT);

// --- Operating Theaters (rooms) CRUD ---
complianceRoutes.get('/operating-theaters', authenticate, controller.listOperatingTheaters);
complianceRoutes.post('/operating-theaters', authenticate, validate(createOtSchema), controller.createOperatingTheater);
complianceRoutes.put('/operating-theaters/:id', authenticate, validate(updateOtSchema), controller.updateOperatingTheater);
complianceRoutes.delete('/operating-theaters/:id', authenticate, validate(otIdParamSchema), controller.deleteOperatingTheater);

// --- Incidents ---
complianceRoutes.post('/incidents', authenticate, validate(reportIncidentSchema), controller.reportIncident);
complianceRoutes.get('/incidents', authenticate, validate(getIncidentsQuerySchema), controller.getIncidents);
complianceRoutes.get('/incidents/:id', authenticate, validate(incidentIdParamSchema), controller.getIncidentById);
complianceRoutes.put('/incidents/:id', authenticate, validate(updateIncidentSchema), controller.updateIncident);
complianceRoutes.patch('/incidents/:id/investigate', authenticate, validate(investigateIncidentSchema), controller.investigateIncident);
complianceRoutes.patch('/incidents/:id/close', authenticate, validate(closeIncidentSchema), controller.closeIncident);
