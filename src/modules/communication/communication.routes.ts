import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './communication.controller';
import {
  createNotificationSchema,
  getNotificationsQuerySchema,
  notificationIdParamSchema,
  sendMessageSchema,
  getMessagesQuerySchema,
  messageIdParamSchema,
  conversationUserParamSchema,
  createHandoverSchema,
  getHandoversQuerySchema,
  handoverIdParamSchema,
  addHandoverNoteSchema,
  completeHandoverSchema,
  shiftSummaryQuerySchema,
  createTicketSchema,
  getTicketsQuerySchema,
  ticketIdParamSchema,
} from './communication.validation';

export const communicationRoutes = Router();

// --- Notifications ---
communicationRoutes.post('/notifications', authenticate, requirePermission('notifications', 'create'), validate(createNotificationSchema), controller.createNotification);
communicationRoutes.get('/notifications', authenticate, requirePermission('notifications', 'read'), validate(getNotificationsQuerySchema), controller.getNotifications);
communicationRoutes.get('/notifications/unread-count', authenticate, requirePermission('notifications', 'read'), controller.getUnreadCount);
communicationRoutes.patch('/notifications/:id/read', authenticate, requirePermission('notifications', 'update'), validate(notificationIdParamSchema), controller.markNotificationRead);
communicationRoutes.patch('/notifications/read-all', authenticate, requirePermission('notifications', 'update'), controller.markAllNotificationsRead);
communicationRoutes.delete('/notifications/:id', authenticate, requirePermission('notifications', 'delete'), validate(notificationIdParamSchema), controller.deleteNotification);

// --- Messages ---
communicationRoutes.post('/messages', authenticate, requirePermission('notifications', 'create'), validate(sendMessageSchema), controller.sendMessage);
communicationRoutes.get('/messages', authenticate, requirePermission('notifications', 'read'), validate(getMessagesQuerySchema), controller.getMessages);
communicationRoutes.get('/messages/:id', authenticate, requirePermission('notifications', 'read'), validate(messageIdParamSchema), controller.getMessageById);
communicationRoutes.get('/messages/conversation/:userId', authenticate, requirePermission('notifications', 'read'), validate(conversationUserParamSchema), controller.getConversation);
communicationRoutes.patch('/messages/:id/read', authenticate, requirePermission('notifications', 'update'), validate(messageIdParamSchema), controller.markMessageRead);
communicationRoutes.delete('/messages/:id', authenticate, requirePermission('notifications', 'delete'), validate(messageIdParamSchema), controller.deleteMessage);

// --- Shift Handover ---
// Shift summary (/shift-summary) is registered above handovers/:id to avoid route-precedence issues.
communicationRoutes.get('/shift-summary', authenticate, requirePermission('notifications', 'read'), validate(shiftSummaryQuerySchema), controller.getShiftSummary);
communicationRoutes.post('/handovers', authenticate, requirePermission('notifications', 'create'), validate(createHandoverSchema), controller.createHandover);
communicationRoutes.get('/handovers', authenticate, requirePermission('notifications', 'read'), validate(getHandoversQuerySchema), controller.getHandovers);
communicationRoutes.get('/handovers/:id', authenticate, requirePermission('notifications', 'read'), validate(handoverIdParamSchema), controller.getHandoverById);
communicationRoutes.patch('/handovers/:id/acknowledge', authenticate, requirePermission('notifications', 'update'), validate(handoverIdParamSchema), controller.acknowledgeHandover);
communicationRoutes.patch('/handovers/:id/complete', authenticate, requirePermission('notifications', 'update'), validate(completeHandoverSchema), controller.completeHandover);
communicationRoutes.post('/handovers/:id/notes', authenticate, requirePermission('notifications', 'create'), validate(addHandoverNoteSchema), controller.addHandoverNote);

// --- Tickets ---
communicationRoutes.post('/tickets', authenticate, requirePermission('tickets', 'create'), validate(createTicketSchema), controller.createTicket);
communicationRoutes.get('/tickets', authenticate, requirePermission('tickets', 'read'), validate(getTicketsQuerySchema), controller.getTickets);
communicationRoutes.get('/tickets/:id', authenticate, requirePermission('tickets', 'read'), validate(ticketIdParamSchema), controller.getTicketById);
