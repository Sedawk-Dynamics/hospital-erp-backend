import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createNotification,
  markNotificationRead,
  getUnreadCount,
  sendMessage,
  getConversation,
  createHandover,
  acknowledgeHandover,
  markAllNotificationsRead,
} from '../../../../src/modules/communication/communication.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Notifications
// ============================================================

describe('Communication Service - Notifications', () => {
  describe('createNotification', () => {
    it('should create a notification when the target user exists', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'user-2' } as any);
      vi.mocked(prisma.notification.create).mockResolvedValueOnce({
        id: 'notif-1',
        tenantId: TENANT_ID,
        userId: 'user-2',
        title: 'Test',
        message: 'Hello',
      } as any);

      const result = await createNotification(TENANT_ID, {
        userId: 'user-2',
        title: 'Test',
        message: 'Hello',
        notificationType: 'info',
        channel: 'in_app',
      } as any);

      expect(result.id).toBe('notif-1');
      expect(result.title).toBe('Test');
    });

    it('should throw notFound when target user does not exist', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);

      await expect(
        createNotification(TENANT_ID, {
          userId: 'bad-user',
          title: 'Test',
          message: 'Hello',
          notificationType: 'info',
          channel: 'in_app',
        } as any),
      ).rejects.toThrow('Target user not found in this tenant');
    });
  });

  describe('markNotificationRead', () => {
    it('should mark a notification as read', async () => {
      vi.mocked(prisma.notification.findFirst).mockResolvedValueOnce({
        id: 'notif-1',
        isRead: false,
      } as any);
      vi.mocked(prisma.notification.update).mockResolvedValueOnce({
        id: 'notif-1',
        isRead: true,
      } as any);

      const result = await markNotificationRead(TENANT_ID, USER_ID, 'notif-1');

      expect(result.isRead).toBe(true);
    });

    it('should throw notFound when notification does not exist', async () => {
      vi.mocked(prisma.notification.findFirst).mockResolvedValueOnce(null);

      await expect(
        markNotificationRead(TENANT_ID, USER_ID, 'bad-id'),
      ).rejects.toThrow('Notification not found');
    });
  });

  describe('markAllNotificationsRead', () => {
    it('should mark all unread notifications as read and return count', async () => {
      vi.mocked(prisma.notification.updateMany).mockResolvedValueOnce({ count: 5 } as any);

      const result = await markAllNotificationsRead(TENANT_ID, USER_ID);

      expect(result.updatedCount).toBe(5);
    });
  });

  describe('getUnreadCount', () => {
    it('should return the count of unread notifications', async () => {
      vi.mocked(prisma.notification.count).mockResolvedValueOnce(7);

      const result = await getUnreadCount(TENANT_ID, USER_ID);

      expect(result.unreadCount).toBe(7);
    });
  });
});

// ============================================================
// Messages
// ============================================================

describe('Communication Service - Messages', () => {
  describe('sendMessage', () => {
    it('should send a message when receiver exists', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'user-2' } as any);
      vi.mocked(prisma.message.create).mockResolvedValueOnce({
        id: 'msg-1',
        senderId: USER_ID,
        receiverId: 'user-2',
        content: 'Hi there',
      } as any);

      const result = await sendMessage(TENANT_ID, USER_ID, {
        receiverId: 'user-2',
        content: 'Hi there',
      } as any);

      expect(result.id).toBe('msg-1');
      expect(result.content).toBe('Hi there');
    });

    it('should throw notFound when receiver does not exist', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);

      await expect(
        sendMessage(TENANT_ID, USER_ID, {
          receiverId: 'bad-user',
          content: 'Hi',
        } as any),
      ).rejects.toThrow('Receiver not found in this tenant');
    });

    it('should throw notFound when parent message does not exist', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'user-2' } as any);
      vi.mocked(prisma.message.findFirst).mockResolvedValueOnce(null);

      await expect(
        sendMessage(TENANT_ID, USER_ID, {
          receiverId: 'user-2',
          content: 'Reply',
          parentMessageId: 'bad-parent',
        } as any),
      ).rejects.toThrow('Parent message not found');
    });
  });

  describe('getConversation', () => {
    it('should return paginated messages between two users', async () => {
      const msgs = [
        { id: 'msg-1', senderId: USER_ID, receiverId: 'user-2', content: 'Hi' },
        { id: 'msg-2', senderId: 'user-2', receiverId: USER_ID, content: 'Hello' },
      ];
      vi.mocked(prisma.message.findMany).mockResolvedValueOnce(msgs as any);
      vi.mocked(prisma.message.count).mockResolvedValueOnce(2);

      const result = await getConversation(TENANT_ID, USER_ID, 'user-2', {
        page: 1,
        limit: 20,
        sortOrder: 'desc',
      } as any);

      expect(result.messages).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });
});

// ============================================================
// Shift Handover Notes
// ============================================================

describe('Communication Service - Handovers', () => {
  describe('createHandover', () => {
    it('should create a handover note when ward exists', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'nurse-2' } as any); // toNurse check
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce({ id: 'ward-1' } as any);
      vi.mocked(prisma.shiftHandoverNote.create).mockResolvedValueOnce({
        id: 'ho-1',
        fromNurseId: USER_ID,
        wardId: 'ward-1',
        shiftType: 'morning',
      } as any);

      const result = await createHandover(TENANT_ID, USER_ID, {
        toNurseId: 'nurse-2',
        wardId: 'ward-1',
        shiftDate: '2025-06-01',
        shiftType: 'morning',
        content: 'All stable',
      } as any);

      expect(result.id).toBe('ho-1');
    });

    it('should throw notFound when ward does not exist', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce(null);

      await expect(
        createHandover(TENANT_ID, USER_ID, {
          wardId: 'bad-ward',
          shiftDate: '2025-06-01',
          shiftType: 'morning',
          content: 'x',
        } as any),
      ).rejects.toThrow('Ward not found in this tenant');
    });
  });
});
