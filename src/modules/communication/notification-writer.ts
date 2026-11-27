// Gap 295: idempotent notification writes.
//
// POSTing the same event / record / user twice used to return 201 twice with
// two ids, and the reminder jobs guarded with a read-then-insert that two
// concurrent runs could both pass. Every keyed write now runs inside one
// transaction that first takes a Postgres advisory lock on (tenant, user,
// dedupe key): writers of the same notification queue on that lock, so the
// second one always sees the first one's row, and sequential and simultaneous
// requests both end with exactly one row.
//
// Why a lock and not a UNIQUE index: adding a unique constraint to the
// existing notifications table makes `prisma db push` stop with a data-loss
// warning, and both `npm run dev` (predev) and `npm start` run `db push`
// without --accept-data-loss — so every environment would fail to boot after
// the merge. dedupe_key carries a plain index instead.

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

/** The advisory-lock key for one notification: hashtext() folds it to an int. */
export function notificationLockKey(tenantId: string, userId: string, dedupeKey: string): string {
  return `notification:${tenantId}:${userId}:${dedupeKey}`;
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

  return prisma.$transaction(async (tx) => {
    // Held until this transaction ends; a concurrent writer of the same key
    // waits here and then finds the row this one wrote.
    const lockKey = notificationLockKey(input.tenantId, input.userId, dedupeKey);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const refresh = async (n: Notification): Promise<Notification> => {
      if (n.message === input.message) return n;
      return (await tx.notification.update({ where: { id: n.id }, data: { message: input.message } })) ?? n;
    };

    const existing = await tx.notification.findFirst({
      where: { tenantId: input.tenantId, userId: input.userId, dedupeKey },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return { notification: await refresh(existing), created: false };

    // A row written before the key existed (dedupe_key NULL) for the same
    // event: adopt the newest one instead of adding another beside it.
    const legacy = await tx.notification.findFirst({
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
      const adopted = await tx.notification.update({ where: { id: legacy.id }, data: { dedupeKey } });
      return { notification: await refresh(adopted ?? legacy), created: false };
    }

    const created = await tx.notification.create({ data: { ...data, dedupeKey } });
    return { notification: created, created: true };
  });
}
