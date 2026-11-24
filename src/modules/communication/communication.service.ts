import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { formatDateTimeIST } from '../../shared/date.utils';
import { getPaginationParams } from '../../shared/pagination';
import { fullName } from '../../shared/person-name';
import { describeClaimDeadline } from '../insurance/insurance.metrics';
import {
  collapseNotifications,
  countUniqueNotifications,
  isClaimDeadlineNotification,
  notificationGroupKey,
} from './notification-dedupe';
import { writeNotificationOnce } from './notification-writer';
import type {
  CreateNotificationInput,
  GetNotificationsQuery,
  SendMessageInput,
  GetMessagesQuery,
  ConversationQuery,
  CreateHandoverInput,
  GetHandoversQuery,
  AddHandoverNoteInput,
  CompleteHandoverInput,
  ShiftSummaryQuery,
  CreateTicketInput,
  GetTicketsQuery,
} from './communication.validation';

// ============================================================
// Notifications
// ============================================================
//
// A notification names exactly ONE user, and `userId` on every read below comes
// from the authenticated token — so the user is the scope. It is deliberately
// NOT also filtered by the session's tenant, and that is the whole fix here.
//
// A patient's account lives on the PLATFORM tenant by design (auth.service:
// "Create the account holder on the platform tenant"), because one person can
// attend several hospitals and cannot belong to one of them. Notifications
// about their care are written with the HOSPITAL's tenantId. So
// `where: { tenantId, userId }` could never match for a patient: on the dev
// database ALL 11 patient-targeted notifications were filed under a tenant the
// recipient does not belong to, and none matched. Patients were not missing
// some notifications — they had never received one.
//
// The tenantId stays ON the row: it records which hospital the notice is about,
// which is exactly what a patient with records at two hospitals needs.

/**
 * Create a notification, or return the one already written for the same
 * event, record, user and reminder stage. `created` tells the caller which.
 */
export async function createNotificationWithStatus(tenantId: string, data: CreateNotificationInput) {
  // The recipient must be someone this hospital deals with — staff on the
  // tenant, or a patient it actually treats. The check stays (this route is
  // permissioned but still lets a caller name any userId, and without it one
  // hospital could notify another's users) but it can no longer refuse a
  // patient, whose account sits on the platform tenant rather than here.
  const [staffUser, patientOfTenant] = await Promise.all([
    prisma.user.findFirst({ where: { id: data.userId, tenantId }, select: { id: true } }),
    prisma.patient.findFirst({ where: { tenantId, userId: data.userId }, select: { id: true } }),
  ]);

  if (!staffUser && !patientOfTenant) {
    throw AppError.notFound('Target user not found in this tenant');
  }

  // Gap 295: one row per (tenant, recipient, event/type, record, reminder
  // stage) — a repeat or simultaneous POST returns the existing notification.
  const result = await writeNotificationOnce({
    tenantId,
    userId: data.userId,
    title: data.title,
    message: data.message,
    notificationType: data.notificationType,
    channel: data.channel,
    referenceType: data.referenceType,
    referenceId: data.referenceId,
    eventKey: data.eventKey,
    reminderStage: data.reminderStage,
  });

  logger.info(
    { tenantId, notificationId: result.notification.id, userId: data.userId, created: result.created },
    result.created ? 'Notification created' : 'Notification already existed — returned the existing one',
  );
  return result;
}

/**
 * Create and send a notification to a user (idempotent — gap 295).
 */
export async function createNotification(tenantId: string, data: CreateNotificationInput) {
  return (await createNotificationWithStatus(tenantId, data)).notification;
}

/**
 * Get paginated notifications for the authenticated user.
 *
 * Duplicates (same event + record + stage) are collapsed into one entry, the
 * newest, carrying `duplicateCount` (gap 295). Claim-deadline alerts are
 * re-worded from the claim's due date at read time (gap 296), so a stored
 * "expiring in 1 day" never outlives the day it was true.
 */
export async function getNotifications(
  tenantId: string,
  userId: string,
  query: GetNotificationsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Scoped by the token's user, not the session tenant — see the note above.
  const where: any = { userId };

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

  // Grouping needs every matching row's key; only the key columns are read,
  // and the page's full rows are fetched afterwards.
  const keys = await prisma.notification.findMany({
    where,
    select: { id: true, referenceType: true, referenceId: true, title: true, isRead: true },
    orderBy: { createdAt: 'desc' },
    take: NOTIFICATION_SCAN_LIMIT,
  });
  const groups = collapseNotifications(keys);
  const pageGroups = groups.slice(skip, skip + take);

  const rows = pageGroups.length
    ? await prisma.notification.findMany({ where: { id: { in: pageGroups.map((g) => g.head.id) } } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shaped = pageGroups
    .map((g) => {
      const row = byId.get(g.head.id);
      if (!row) return null;
      return { ...row, isRead: !g.unread, duplicateCount: g.memberIds.length };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const notifications = await rewordClaimDeadlines(shaped);
  return { notifications, total: groups.length, page, limit };
}

/** Upper bound on rows scanned for grouping — far above any real inbox. */
const NOTIFICATION_SCAN_LIMIT = 5000;

/**
 * Gap 296: rebuild the title/message of claim-deadline alerts from the claim's
 * current due date, so an already-expired claim never reads "expiring in 1 day".
 */
async function rewordClaimDeadlines<T extends { referenceType: string | null; referenceId: string | null; title: string; message: string }>(
  rows: T[],
): Promise<T[]> {
  const claimIds = rows
    .filter((r) => r.referenceId && isClaimDeadlineNotification(r))
    .map((r) => r.referenceId as string);
  if (!claimIds.length) return rows;
  const claims = await prisma.insuranceClaim.findMany({
    where: { id: { in: claimIds } },
    select: {
      id: true,
      claimNumber: true,
      expiryDate: true,
      patient: { select: { firstName: true, lastName: true } },
    },
  });
  const byId = new Map(claims.map((c) => [c.id, c]));
  const now = new Date();
  return rows.map((r) => {
    if (!r.referenceId || !isClaimDeadlineNotification(r)) return r;
    const claim = byId.get(r.referenceId);
    if (!claim?.expiryDate) return r;
    const { title, message } = describeClaimDeadline(
      { id: claim.id, claimNumber: claim.claimNumber, expiryDate: claim.expiryDate },
      fullName(claim.patient),
      now,
    );
    return { ...r, title, message };
  });
}

/**
 * Get count of unread notifications for the authenticated user — distinct
 * notifications, not rows, so 22 copies of one alert count once (gap 295).
 */
export async function getUnreadCount(tenantId: string, userId: string) {
  const rows = await prisma.notification.findMany({
    where: { userId, isRead: false },
    select: { id: true, referenceType: true, referenceId: true, title: true },
    take: NOTIFICATION_SCAN_LIMIT,
  });

  return { unreadCount: countUniqueNotifications(rows) };
}

/** Ids of every row in the same duplicate group as `n` for this user. */
async function groupMemberIds(
  userId: string,
  n: { id: string; referenceType: string | null; referenceId: string | null; title: string },
  extraWhere: Record<string, unknown> = {},
): Promise<string[]> {
  if (!n.referenceId) return [n.id];
  const key = notificationGroupKey(n);
  const candidates = await prisma.notification.findMany({
    where: { userId, referenceType: n.referenceType, referenceId: n.referenceId, ...extraWhere },
    select: { id: true, referenceType: true, referenceId: true, title: true },
  });
  const ids = (candidates ?? []).filter((c) => notificationGroupKey(c) === key).map((c) => c.id);
  return ids.includes(n.id) ? ids : [n.id, ...ids];
}

/**
 * Mark a single notification as read — together with its collapsed duplicates,
 * or the badge would keep counting the copies the reader never sees.
 */
export async function markNotificationRead(tenantId: string, userId: string, id: string) {
  const notification = await prisma.notification.findFirst({
    where: { id, userId },
  });

  if (!notification) {
    throw AppError.notFound('Notification not found');
  }

  const now = new Date();
  const ids = await groupMemberIds(userId, notification, { isRead: false });
  if (ids.length > 1) {
    await prisma.notification.updateMany({
      where: { id: { in: ids }, userId },
      data: { isRead: true, readAt: now },
    });
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true, readAt: now },
  });

  return updated;
}

/**
 * Mark all notifications as read for the authenticated user.
 */
export async function markAllNotificationsRead(tenantId: string, userId: string) {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });

  logger.info({ tenantId, userId, count: result.count }, 'All notifications marked as read');
  return { updatedCount: result.count };
}

/**
 * Delete a notification, with its collapsed duplicates — otherwise deleting
 * the one shown just surfaces the next copy.
 */
export async function deleteNotification(tenantId: string, userId: string, id: string) {
  const notification = await prisma.notification.findFirst({
    where: { id, userId },
  });

  if (!notification) {
    throw AppError.notFound('Notification not found');
  }

  const ids = await groupMemberIds(userId, notification);
  if (ids.length > 1) {
    await prisma.notification.deleteMany({ where: { id: { in: ids }, userId } });
  } else {
    await prisma.notification.delete({ where: { id } });
  }

  logger.info({ tenantId, notificationId: id, duplicatesRemoved: ids.length - 1 }, 'Notification deleted');
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
 * Derived UI state for a handover.
 *
 * `ShiftHandoverNote` has no status column: a note is created already
 * submitted (there is no draft) and the only transition is acknowledgement.
 * Every handover surface still needs one field to badge, so it is derived here
 * — once, server-side — rather than re-implemented (differently) in each
 * client. Clients read `status`; the DB keeps `isAcknowledged` as the truth.
 */
export type HandoverStatus = 'submitted' | 'acknowledged';

function withHandoverStatus<T extends { isAcknowledged: boolean }>(
  handover: T,
): T & { status: HandoverStatus } {
  return { ...handover, status: handover.isAcknowledged ? 'acknowledged' : 'submitted' };
}

/** Display name for the user who acted, so note text names a person, not a UUID. */
async function actorName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true },
  });
  return user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : 'a colleague';
}

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
  return withHandoverStatus(handover);
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

  return { handovers: handovers.map(withHandoverStatus), total, page, limit };
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

  return withHandoverStatus(handover);
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
  return withHandoverStatus(updated);
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

  // Append additional content to the existing handover. Name the author — this
  // string is read by the next nurse on shift, and a bare UUID told them nothing.
  const author = await actorName(userId);
  const updatedContent = `${handover.content}\n\n--- Addendum by ${author} at ${formatDateTimeIST(new Date())} ---\n${data.content}`;

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
  return withHandoverStatus(updated);
}

// ============================================================
// Tickets
// ============================================================

/**
 * Generate a unique ticket number.
 */
function generateTicketNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TKT-${timestamp}${random}`;
}

/**
 * Create a new ticket.
 */
export async function createTicket(tenantId: string, raisedBy: string, data: CreateTicketInput) {
  // Verify patient if provided
  if (data.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
    });
    if (!patient) {
      throw AppError.notFound('Patient not found');
    }
  }

  // Verify department if provided
  if (data.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: data.departmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Department not found');
    }
  }

  // Verify assignee if provided
  if (data.assignedTo) {
    const assignee = await prisma.user.findFirst({
      where: { id: data.assignedTo, tenantId },
    });
    if (!assignee) {
      throw AppError.notFound('Assigned user not found');
    }
  }

  const ticket = await prisma.ticket.create({
    data: {
      tenantId,
      ticketNumber: generateTicketNumber(),
      raisedBy,
      ticketType: data.ticketType,
      subject: data.subject,
      description: data.description,
      priority: data.priority ?? 'medium',
      patientId: data.patientId,
      departmentId: data.departmentId,
      assignedTo: data.assignedTo,
      status: 'open',
    },
    include: {
      raiser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      assignee: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info({ tenantId, ticketId: ticket.id, ticketNumber: ticket.ticketNumber }, 'Ticket created');
  return ticket;
}

/**
 * Get paginated list of tickets with filters.
 */
export async function getTickets(tenantId: string, query: GetTicketsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.ticketType) where.ticketType = query.ticketType;
  if (query.raisedBy) where.raisedBy = query.raisedBy;
  if (query.assignedTo) where.assignedTo = query.assignedTo;

  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
      { ticketNumber: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      skip,
      take,
      include: {
        raiser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        assignee: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        department: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets, total, page, limit };
}

/**
 * Get a single ticket by ID.
 */
export async function getTicketById(tenantId: string, id: string) {
  const ticket = await prisma.ticket.findFirst({
    where: { id, tenantId },
    include: {
      raiser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      assignee: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
        },
      },
      department: {
        select: { id: true, name: true },
      },
    },
  });

  if (!ticket) {
    throw AppError.notFound('Ticket not found');
  }

  return ticket;
}

// ============================================================
// Shift Handover — complete / auto-summary
// ============================================================

/**
 * Mark a handover complete. In the 3-state lifecycle (draft → submitted →
 * acknowledged) completion is the acknowledged terminal state. Unlike
 * `acknowledgeHandover`, this endpoint is idempotent and accepts an optional
 * completion note that is appended to the existing content as a free-form
 * closing remark.
 */
export async function completeHandover(
  tenantId: string,
  userId: string,
  id: string,
  data: CompleteHandoverInput | undefined,
) {
  const handover = await prisma.shiftHandoverNote.findFirst({
    where: { id, tenantId },
  });

  if (!handover) {
    throw AppError.notFound('Handover note not found');
  }

  const note = data?.completionNote?.trim();
  const appendedContent = note
    ? `${handover.content}\n\n[Completed ${formatDateTimeIST(new Date())} by ${await actorName(userId)}] ${note}`
    : handover.content;

  // Idempotent: if already acknowledged, just allow appending a completion note.
  const updated = await prisma.shiftHandoverNote.update({
    where: { id },
    data: {
      isAcknowledged: true,
      acknowledgedAt: handover.acknowledgedAt ?? new Date(),
      toNurseId: handover.toNurseId ?? userId,
      content: appendedContent,
    },
    include: {
      fromNurse: { select: { id: true, firstName: true, lastName: true } },
      toNurse: { select: { id: true, firstName: true, lastName: true } },
      ward: { select: { id: true, name: true } },
    },
  });

  logger.info(
    { tenantId, handoverId: id, completedBy: userId, hasNote: !!note },
    'Handover note marked complete',
  );
  return withHandoverStatus(updated);
}

/**
 * Compute a summary of activity for a shift window — counts of vitals
 * recorded, medications administered, nursing notes written, admissions
 * touched, and outstanding handovers. Used by the handover UI to auto-
 * compile the "shift summary" card that the outgoing nurse sees.
 */
export async function getShiftSummary(
  tenantId: string,
  currentUserId: string,
  query: ShiftSummaryQuery,
) {
  // Resolve the user we're summarising for — defaults to the caller.
  const userId = query.userId ?? currentUserId;

  // Resolve shift window.
  const baseDate = query.shiftDate ? new Date(query.shiftDate) : new Date();
  if (isNaN(baseDate.getTime())) {
    throw AppError.badRequest('Invalid shiftDate');
  }

  // Detect shift type from time if not supplied.
  const shiftType = query.shiftType ?? detectShiftTypeFromDate(baseDate);

  // Build shift start/end in the LOCAL clock of the request's `baseDate` day.
  // Morning: 06:00–14:00 | Afternoon: 14:00–22:00 | Night: 22:00–06:00 (crosses midnight)
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth();
  const d = baseDate.getDate();

  let from: Date;
  let to: Date;
  if (shiftType === 'morning') {
    from = new Date(y, m, d, 6, 0, 0);
    to = new Date(y, m, d, 14, 0, 0);
  } else if (shiftType === 'afternoon') {
    from = new Date(y, m, d, 14, 0, 0);
    to = new Date(y, m, d, 22, 0, 0);
  } else {
    // Night: 22:00 on baseDate → 06:00 on next day.
    from = new Date(y, m, d, 22, 0, 0);
    to = new Date(y, m, d + 1, 6, 0, 0);
  }

  // ── Run all counts in parallel (tenant-scoped) ─────────
  const [
    vitalsCount,
    medsAdministeredCount,
    nursingNotesCount,
    woundCareCount,
    ivLinesCount,
    intakeOutputCount,
    handoversInCount,
    handoversOutCount,
    patientsSeen,
  ] = await Promise.all([
    // Vitals: scoped by visit.tenantId + recordedBy
    prisma.vital.count({
      where: {
        visit: { tenantId },
        recordedBy: userId,
        recordedAt: { gte: from, lt: to },
      },
    }),
    // Medication administrations: scoped via prescriptionItem → prescription.tenantId
    prisma.medicationAdministration.count({
      where: {
        administeredBy: userId,
        status: 'given',
        administeredAt: { gte: from, lt: to },
        prescriptionItem: { prescription: { tenantId } },
      },
    }),
    // Nursing notes by this nurse
    prisma.nursingNote.count({
      where: {
        nurseId: userId,
        createdAt: { gte: from, lt: to },
        visit: { tenantId },
      },
    }),
    // Wound care records
    prisma.woundCareRecord.count({
      where: {
        nurseId: userId,
        createdAt: { gte: from, lt: to },
        visit: { tenantId },
      },
    }),
    // IV lines inserted
    prisma.iVLineRecord.count({
      where: {
        insertedBy: userId,
        insertedAt: { gte: from, lt: to },
        visit: { tenantId },
      },
    }),
    // Intake/output entries
    prisma.intakeOutputRecord.count({
      where: {
        nurseId: userId,
        recordDatetime: { gte: from, lt: to },
        visit: { tenantId },
      },
    }),
    // Handovers received (incoming to this nurse) in window
    prisma.shiftHandoverNote.count({
      where: { tenantId, toNurseId: userId, createdAt: { gte: from, lt: to } },
    }),
    // Handovers submitted (outgoing by this nurse) in window
    prisma.shiftHandoverNote.count({
      where: { tenantId, fromNurseId: userId, createdAt: { gte: from, lt: to } },
    }),
    // Distinct patients where this nurse recorded vitals / notes / meds during window
    countDistinctPatients(tenantId, userId, from, to),
  ]);

  return {
    shiftType,
    shiftDate: baseDate.toISOString(),
    windowFrom: from.toISOString(),
    windowTo: to.toISOString(),
    userId,
    counts: {
      patientsSeen,
      vitalsRecorded: vitalsCount,
      medicationsAdministered: medsAdministeredCount,
      nursingNotes: nursingNotesCount,
      woundCareRecords: woundCareCount,
      ivLinesInserted: ivLinesCount,
      intakeOutputEntries: intakeOutputCount,
      handoversReceived: handoversInCount,
      handoversSubmitted: handoversOutCount,
    },
  };
}

function detectShiftTypeFromDate(d: Date): 'morning' | 'afternoon' | 'night' {
  const h = d.getHours();
  if (h >= 6 && h < 14) return 'morning';
  if (h >= 14 && h < 22) return 'afternoon';
  return 'night';
}

async function countDistinctPatients(
  tenantId: string,
  userId: string,
  from: Date,
  to: Date,
): Promise<number> {
  // Aggregate distinct patient IDs across vitals, notes, and administrations.
  const [vitals, notes, admins] = await Promise.all([
    prisma.vital.findMany({
      where: {
        recordedBy: userId,
        recordedAt: { gte: from, lt: to },
        visit: { tenantId },
      },
      select: { patientId: true },
      distinct: ['patientId'],
    }),
    prisma.nursingNote.findMany({
      where: {
        nurseId: userId,
        createdAt: { gte: from, lt: to },
        visit: { tenantId },
      },
      select: { patientId: true },
      distinct: ['patientId'],
    }),
    prisma.medicationAdministration.findMany({
      where: {
        administeredBy: userId,
        administeredAt: { gte: from, lt: to },
        prescriptionItem: { prescription: { tenantId } },
      },
      select: { patientId: true },
      distinct: ['patientId'],
    }),
  ]);

  const set = new Set<string>();
  for (const row of [...vitals, ...notes, ...admins]) set.add(row.patientId);
  return set.size;
}
