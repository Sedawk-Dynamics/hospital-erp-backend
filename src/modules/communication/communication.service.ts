import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateNotificationInput,
  GetNotificationsQuery,
  SendMessageInput,
  GetMessagesQuery,
  ConversationQuery,
  CreateHandoverInput,
  GetHandoversQuery,
  AddHandoverNoteInput,
} from './communication.validation';

// ============================================================
// Notifications
// ============================================================

/**
 * Create and send a notification to a user.
 */
export async function createNotification(tenantId: string, data: CreateNotificationInput) {
  // Verify the target user exists within the tenant
  const user = await prisma.user.findFirst({
    where: { id: data.userId, tenantId },
  });

  if (!user) {
    throw AppError.notFound('Target user not found in this tenant');
  }

  const notification = await prisma.notification.create({
    data: {
      tenantId,
      userId: data.userId,
      title: data.title,
      message: data.message,
      notificationType: data.notificationType,
      channel: data.channel,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
    },
  });

  logger.info(
    { tenantId, notificationId: notification.id, userId: data.userId },
    'Notification created',
  );
  return notification;
}

/**
 * Get paginated notifications for the authenticated user.
 */
export async function getNotifications(
  tenantId: string,
  userId: string,
  query: GetNotificationsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId, userId };

  if (query.isRead !== undefined) {
    where.isRead = query.isRead;
  }

  if (query.notificationType) {
    where.notificationType = query.notificationType;
  }

  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { message: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where }),
  ]);

  return { notifications, total, page, limit };
}

/**
 * Get count of unread notifications for the authenticated user.
 */
export async function getUnreadCount(tenantId: string, userId: string) {
  const count = await prisma.notification.count({
    where: { tenantId, userId, isRead: false },
  });

  return { unreadCount: count };
}

/**
 * Mark a single notification as read.
 */
export async function markNotificationRead(tenantId: string, userId: string, id: string) {
  const notification = await prisma.notification.findFirst({
    where: { id, tenantId, userId },
  });

  if (!notification) {
    throw AppError.notFound('Notification not found');
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true, readAt: new Date() },
  });

  return updated;
}

/**
 * Mark all notifications as read for the authenticated user.
 */
export async function markAllNotificationsRead(tenantId: string, userId: string) {
  const result = await prisma.notification.updateMany({
    where: { tenantId, userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });

  logger.info({ tenantId, userId, count: result.count }, 'All notifications marked as read');
  return { updatedCount: result.count };
}

/**
 * Delete a notification.
 */
export async function deleteNotification(tenantId: string, userId: string, id: string) {
  const notification = await prisma.notification.findFirst({
    where: { id, tenantId, userId },
  });

  if (!notification) {
    throw AppError.notFound('Notification not found');
  }

  await prisma.notification.delete({ where: { id } });

  logger.info({ tenantId, notificationId: id }, 'Notification deleted');
  return { deleted: true };
}

// ============================================================
// Messages
// ============================================================

/**
 * Send a message to another user.
 */
export async function sendMessage(tenantId: string, senderId: string, data: SendMessageInput) {
  // Verify receiver exists within the tenant
  const receiver = await prisma.user.findFirst({
    where: { id: data.receiverId, tenantId },
  });

  if (!receiver) {
    throw AppError.notFound('Receiver not found in this tenant');
  }

  // If replying to a parent message, verify it exists
  if (data.parentMessageId) {
    const parentMessage = await prisma.message.findFirst({
      where: { id: data.parentMessageId, tenantId },
    });

    if (!parentMessage) {
      throw AppError.notFound('Parent message not found');
    }
  }

  const message = await prisma.message.create({
    data: {
      tenantId,
      senderId,
      receiverId: data.receiverId,
      subject: data.subject,
      content: data.content,
      parentMessageId: data.parentMessageId,
    },
    include: {
      sender: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      receiver: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  logger.info(
    { tenantId, messageId: message.id, senderId, receiverId: data.receiverId },
    'Message sent',
  );
  return message;
}

/**
 * Get paginated messages for the authenticated user (inbox - received messages).
 */
export async function getMessages(tenantId: string, userId: string, query: GetMessagesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    tenantId,
    OR: [{ senderId: userId }, { receiverId: userId }],
  };

  if (query.isRead !== undefined) {
    where.isRead = query.isRead;
  }

  if (query.search) {
    where.AND = [
      {
        OR: [
          { subject: { contains: query.search, mode: 'insensitive' } },
          { content: { contains: query.search, mode: 'insensitive' } },
        ],
      },
    ];
  }

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where,
      skip,
      take,
      include: {
        sender: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        receiver: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.message.count({ where }),
  ]);

  return { messages, total, page, limit };
}

/**
 * Get a single message by ID.
 */
export async function getMessageById(tenantId: string, userId: string, id: string) {
  const message = await prisma.message.findFirst({
    where: {
      id,
      tenantId,
      OR: [{ senderId: userId }, { receiverId: userId }],
    },
    include: {
      sender: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      receiver: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      parentMessage: {
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
      replies: {
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!message) {
    throw AppError.notFound('Message not found');
  }

  return message;
}

/**
 * Get conversation thread between the authenticated user and another user.
 */
export async function getConversation(
  tenantId: string,
  currentUserId: string,
  otherUserId: string,
  query: ConversationQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where = {
    tenantId,
    OR: [
      { senderId: currentUserId, receiverId: otherUserId },
      { senderId: otherUserId, receiverId: currentUserId },
    ],
  };

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where,
      skip,
      take,
      include: {
        sender: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        receiver: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.message.count({ where }),
  ]);

  return { messages, total, page, limit };
}

/**
 * Mark a message as read.
 */
export async function markMessageRead(tenantId: string, userId: string, id: string) {
  const message = await prisma.message.findFirst({
    where: { id, tenantId, receiverId: userId },
  });

  if (!message) {
    throw AppError.notFound('Message not found');
  }

  const updated = await prisma.message.update({
    where: { id },
    data: { isRead: true, readAt: new Date() },
  });

  return updated;
}

/**
 * Delete a message (soft-check: only sender or receiver can delete).
 */
export async function deleteMessage(tenantId: string, userId: string, id: string) {
  const message = await prisma.message.findFirst({
    where: {
      id,
      tenantId,
      OR: [{ senderId: userId }, { receiverId: userId }],
    },
  });

  if (!message) {
    throw AppError.notFound('Message not found');
  }

  await prisma.message.delete({ where: { id } });

  logger.info({ tenantId, messageId: id }, 'Message deleted');
  return { deleted: true };
}

// ============================================================
// Shift Handover Notes
// ============================================================

/**
 * Create a shift handover note.
 */
export async function createHandover(
  tenantId: string,
  fromNurseId: string,
  data: CreateHandoverInput,
) {
  // Verify the target nurse if provided
  if (data.toNurseId) {
    const toNurse = await prisma.user.findFirst({
      where: { id: data.toNurseId, tenantId },
    });

    if (!toNurse) {
      throw AppError.notFound('Target nurse not found in this tenant');
    }
  }

  // Verify ward exists within tenant
  const ward = await prisma.ward.findFirst({
    where: { id: data.wardId, tenantId },
  });

  if (!ward) {
    throw AppError.notFound('Ward not found in this tenant');
  }

  const handover = await prisma.shiftHandoverNote.create({
    data: {
      tenantId,
      fromNurseId,
      toNurseId: data.toNurseId,
      wardId: data.wardId,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.shiftType,
      content: data.content,
      patientStatuses: data.patientStatuses ?? undefined,
      outstandingTasks: data.outstandingTasks ?? undefined,
    },
    include: {
      fromNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      toNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      ward: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info(
    { tenantId, handoverId: handover.id, fromNurseId },
    'Shift handover note created',
  );
  return handover;
}

/**
 * Get paginated list of shift handover notes.
 */
export async function getHandovers(tenantId: string, query: GetHandoversQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.wardId) {
    where.wardId = query.wardId;
  }

  if (query.shiftType) {
    where.shiftType = query.shiftType;
  }

  if (query.shiftDate) {
    const targetDate = new Date(query.shiftDate);
    where.shiftDate = targetDate;
  }

  if (query.isAcknowledged !== undefined) {
    where.isAcknowledged = query.isAcknowledged;
  }

  if (query.search) {
    where.OR = [
      { content: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [handovers, total] = await Promise.all([
    prisma.shiftHandoverNote.findMany({
      where,
      skip,
      take,
      include: {
        fromNurse: {
          select: { id: true, firstName: true, lastName: true },
        },
        toNurse: {
          select: { id: true, firstName: true, lastName: true },
        },
        ward: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.shiftHandoverNote.count({ where }),
  ]);

  return { handovers, total, page, limit };
}

/**
 * Get a single handover note by ID.
 */
export async function getHandoverById(tenantId: string, id: string) {
  const handover = await prisma.shiftHandoverNote.findFirst({
    where: { id, tenantId },
    include: {
      fromNurse: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      toNurse: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      ward: {
        select: { id: true, name: true },
      },
    },
  });

  if (!handover) {
    throw AppError.notFound('Handover note not found');
  }

  return handover;
}

/**
 * Acknowledge a shift handover note (by the receiving nurse).
 */
export async function acknowledgeHandover(tenantId: string, userId: string, id: string) {
  const handover = await prisma.shiftHandoverNote.findFirst({
    where: { id, tenantId },
  });

  if (!handover) {
    throw AppError.notFound('Handover note not found');
  }

  if (handover.isAcknowledged) {
    throw AppError.badRequest('Handover note has already been acknowledged');
  }

  const updated = await prisma.shiftHandoverNote.update({
    where: { id },
    data: {
      isAcknowledged: true,
      acknowledgedAt: new Date(),
      toNurseId: handover.toNurseId ?? userId,
    },
    include: {
      fromNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      toNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      ward: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info(
    { tenantId, handoverId: id, acknowledgedBy: userId },
    'Handover note acknowledged',
  );
  return updated;
}

/**
 * Add supplemental notes to an existing handover.
 */
export async function addHandoverNote(
  tenantId: string,
  userId: string,
  id: string,
  data: AddHandoverNoteInput,
) {
  const handover = await prisma.shiftHandoverNote.findFirst({
    where: { id, tenantId },
  });

  if (!handover) {
    throw AppError.notFound('Handover note not found');
  }

  // Append additional content to the existing handover
  const updatedContent = `${handover.content}\n\n--- Addendum by user ${userId} at ${new Date().toISOString()} ---\n${data.content}`;

  const updateData: any = {
    content: updatedContent,
  };

  if (data.patientStatuses !== undefined) {
    updateData.patientStatuses = data.patientStatuses;
  }

  if (data.outstandingTasks !== undefined) {
    updateData.outstandingTasks = data.outstandingTasks;
  }

  const updated = await prisma.shiftHandoverNote.update({
    where: { id },
    data: updateData,
    include: {
      fromNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      toNurse: {
        select: { id: true, firstName: true, lastName: true },
      },
      ward: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info(
    { tenantId, handoverId: id, addedBy: userId },
    'Handover note updated with addendum',
  );
  return updated;
}
