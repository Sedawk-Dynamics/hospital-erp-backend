// Gap 295: idempotent notification writes.
//
// POSTing the same event / record / user twice used to return 201 twice with
// two ids, and the reminder jobs guarded with a read-then-insert that two
// concurrent runs could both pass. Every keyed write now goes through the
// unique index on (tenant_id, user_id, dedupe_key): the database, not a prior
// read, decides that a second write is the same notification, so sequential
// and simultaneous requests both end with exactly one row.

import type { Notification } from '@prisma/client';
import { prisma } from '../../config/database';
import { notificationDedupeKey } from './notification-dedupe';

export interface NotificationWriteInput {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  notificationType: string;
  channel?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Names the event when the title alone should not ("claim_deadline"). */
  eventKey?: string | null;
  /** Reminder stage ("7d", "3d", "1d", "expired"); one row per stage. */
  reminderStage?: string | null;
}

export interface NotificationWriteResult {
  notification: Notification;
  /** false → the notification already existed and is returned unchanged in id. */
  created: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
}

/**
 * Create a notification once per (tenant, recipient, event/type, record,
 * reminder stage). A repeat returns the existing row — same id — with its
 * message refreshed if the wording changed; its read state is left alone so a
 * repeat cannot re-raise the badge for something already seen.
 */
export async function writeNotificationOnce(input: NotificationWriteInput): Promise<NotificationWriteResult> {
  const data = {
    tenantId: input.tenantId,
    userId: input.userId,
    title: input.title,
    message: input.message,
    notificationType: input.notificationType as never,
    channel: (input.channel ?? 'in_app') as never,
    referenceType: input.referenceType ?? undefined,
    referenceId: input.referenceId ?? undefined,
  };

  const dedupeKey = notificationDedupeKey(input);
  if (!dedupeKey) {
    // No record named: nothing says two writes are the same event.
    return { notification: await prisma.notification.create({ data }), created: true };
  }

  const where = { tenantId_userId_dedupeKey: { tenantId: input.tenantId, userId: input.userId, dedupeKey } };

  const refresh = async (n: Notification): Promise<Notification> => {
    if (n.message === input.message) return n;
    return (await prisma.notification.update({ where: { id: n.id }, data: { message: input.message } })) ?? n;
  };

  const existing = await prisma.notification.findUnique({ where });
  if (existing) return { notification: await refresh(existing), created: false };

  // A row written before the key existed (dedupe_key NULL) for the same event:
  // adopt the newest one instead of adding another beside it.
  const legacy = await prisma.notification.findFirst({
    where: {
      tenantId: input.tenantId,
      userId: input.userId,
      title: input.title,
      notificationType: input.notificationType as never,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId,
      dedupeKey: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (legacy) {
    try {
      const adopted = await prisma.notification.update({ where: { id: legacy.id }, data: { dedupeKey } });
      return { notification: await refresh(adopted ?? legacy), created: false };
    } catch (err) {
      // Another request adopted / created the keyed row first.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  try {
    const created = await prisma.notification.create({ data: { ...data, dedupeKey } });
    return { notification: created, created: true };
  } catch (err) {
    // Lost the race to a simultaneous write: the unique index kept one row.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.notification.findUnique({ where });
    if (!winner) throw err;
    return { notification: winner, created: false };
  }
}
