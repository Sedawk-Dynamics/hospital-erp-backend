import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createNotification,
  markNotificationRead,
  getUnreadCount,
  sendMessage,
  getConversation,
  createHandover,
  getHandovers,
  acknowledgeHandover,
  addHandoverNote,
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

  // ═══════════════════════════════════════════
  // Response contract
  // ═══════════════════════════════════════════
  // The nurse UI reads these exact keys. It used to read fromUser / toUser /
  // summary / status instead — none of which the API has ever sent — so every
  // handover rendered as "Unknown → Anyone" with an empty body and no
  // Acknowledge button. `apiGet<T>` casts rather than validates, so nothing
  // caught it. These tests pin the shape the clients depend on.
  describe('handover response contract', () => {
    const row = {
      id: 'ho-1',
      fromNurseId: USER_ID,
      toNurseId: 'nurse-2',
      wardId: 'ward-1',
      shiftType: 'morning',
      content: 'BP stable overnight, watch bed 4',
      isAcknowledged: false,
      acknowledgedAt: null,
    };

    it('derives status=submitted for an unacknowledged note', async () => {
      vi.mocked(prisma.shiftHandoverNote.findMany).mockResolvedValueOnce([row] as any);
      vi.mocked(prisma.shiftHandoverNote.count).mockResolvedValueOnce(1);

      const { handovers } = await getHandovers(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(handovers[0]).toMatchObject({
        fromNurseId: USER_ID,
        content: 'BP stable overnight, watch bed 4',
        isAcknowledged: false,
        status: 'submitted',
      });
    });

    it('derives status=acknowledged once acknowledged', async () => {
      vi.mocked(prisma.shiftHandoverNote.findMany).mockResolvedValueOnce([
        { ...row, isAcknowledged: true, acknowledgedAt: new Date() },
      ] as any);
      vi.mocked(prisma.shiftHandoverNote.count).mockResolvedValueOnce(1);

      const { handovers } = await getHandovers(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(handovers[0].status).toBe('acknowledged');
    });

    // A note left for "anyone on next shift" (toNurseId null) is claimed by
    // whoever acknowledges it — otherwise the most common case would have no
    // recipient on record.
    it('claims an unaddressed note for the acknowledging nurse', async () => {
      vi.mocked(prisma.shiftHandoverNote.findFirst).mockResolvedValueOnce({
        ...row,
        toNurseId: null,
      } as any);
      vi.mocked(prisma.shiftHandoverNote.update).mockResolvedValueOnce({
        ...row,
        toNurseId: 'nurse-9',
        isAcknowledged: true,
      } as any);

      const result = await acknowledgeHandover(TENANT_ID, 'nurse-9', 'ho-1');

      expect(vi.mocked(prisma.shiftHandoverNote.update).mock.calls[0][0]).toMatchObject({
        data: { isAcknowledged: true, toNurseId: 'nurse-9' },
      });
      expect(result.status).toBe('acknowledged');
    });

    it('refuses to acknowledge the same note twice', async () => {
      vi.mocked(prisma.shiftHandoverNote.findFirst).mockResolvedValueOnce({
        ...row,
        isAcknowledged: true,
      } as any);

      await expect(acknowledgeHandover(TENANT_ID, 'nurse-2', 'ho-1')).rejects.toThrow(
        'already been acknowledged',
      );
    });

    // The addendum text is read by the next nurse on shift; it used to embed
    // the author's raw UUID.
    it('names the author in an addendum instead of their UUID', async () => {
      vi.mocked(prisma.shiftHandoverNote.findFirst).mockResolvedValueOnce(row as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        firstName: 'Asha',
        lastName: 'Menon',
      } as any);
      vi.mocked(prisma.shiftHandoverNote.update).mockResolvedValueOnce(row as any);

      await addHandoverNote(TENANT_ID, USER_ID, 'ho-1', { content: 'Bed 4 spiked at 3am' } as any);

      const written = vi.mocked(prisma.shiftHandoverNote.update).mock.calls[0][0] as any;
      expect(written.data.content).toContain('Addendum by Asha Menon');
      expect(written.data.content).not.toContain(USER_ID);
    });
  });
});
