import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './communication.service';

// Notifications
export async function createNotification(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createNotification(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Notification sent', data });
  } catch (err) { next(err); }
}
export async function getNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getNotifications(req.user!.tenantId, req.user!.userId, req.query as any);
    sendPaginatedResponse(res, result.notifications, result.total, result.page, result.limit, 'Notifications retrieved');
  } catch (err) { next(err); }
}
export async function getUnreadCount(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getUnreadCount(req.user!.tenantId, req.user!.userId);
    sendResponse({ res, message: 'Unread count retrieved', data });
  } catch (err) { next(err); }
}
export async function markNotificationRead(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.markNotificationRead(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Notification marked as read', data });
  } catch (err) { next(err); }
}
export async function markAllNotificationsRead(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.markAllNotificationsRead(req.user!.tenantId, req.user!.userId);
    sendResponse({ res, message: 'All notifications marked as read' });
  } catch (err) { next(err); }
}
export async function deleteNotification(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteNotification(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Notification deleted' });
  } catch (err) { next(err); }
}

// Messages
export async function sendMessage(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.sendMessage(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Message sent', data });
  } catch (err) { next(err); }
}
export async function getMessages(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getMessages(req.user!.tenantId, req.user!.userId, req.query as any);
    sendPaginatedResponse(res, result.messages, result.total, result.page, result.limit, 'Messages retrieved');
  } catch (err) { next(err); }
}
export async function getMessageById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getMessageById(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Message retrieved', data });
  } catch (err) { next(err); }
}
export async function markMessageRead(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.markMessageRead(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Message marked as read', data });
  } catch (err) { next(err); }
}
export async function deleteMessage(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteMessage(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Message deleted' });
  } catch (err) { next(err); }
}
export async function getConversation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getConversation(req.user!.tenantId, req.user!.userId, req.params.userId as string, req.query as any);
    sendPaginatedResponse(res, result.messages, result.total, result.page, result.limit, 'Conversation retrieved');
  } catch (err) { next(err); }
}

// Handovers
export async function createHandover(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createHandover(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Handover created', data });
  } catch (err) { next(err); }
}
export async function getHandovers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getHandovers(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.handovers, result.total, result.page, result.limit, 'Handovers retrieved');
  } catch (err) { next(err); }
}
export async function getHandoverById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getHandoverById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Handover retrieved', data });
  } catch (err) { next(err); }
}
export async function acknowledgeHandover(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.acknowledgeHandover(req.user!.tenantId, req.user!.userId, req.params.id as string);
    sendResponse({ res, message: 'Handover acknowledged', data });
  } catch (err) { next(err); }
}
export async function addHandoverNote(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.addHandoverNote(req.user!.tenantId, req.user!.userId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Handover note added', data });
  } catch (err) { next(err); }
}
