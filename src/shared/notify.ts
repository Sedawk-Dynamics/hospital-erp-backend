// Raising an in-app notification, from anywhere.
//
// Two rules this centralises, both learned the hard way:
//
//   1. A notification must NEVER take the clinical action down with it. The
//      vital, the booking, the cancellation is the record and it is already
//      saved by the time this runs — a failure here gets logged, not thrown.
//
//   2. A notification with no recipient is not an error. Resolving "the
//      treating doctor" or "the front desk" can legitimately come back empty
//      (a walk-in with no doctor assigned yet, a hospital with nobody in that
//      role), and that must not look like a fault.
//
// The `tenantId` written on the row is the HOSPITAL the notice is about, not
// the recipient's own tenant — a patient's account lives on the platform
// tenant, and the reads are scoped by recipient rather than by tenant for
// exactly that reason. See communication.service.

import { prisma } from '../config/database';
import { logger } from '../config/logger';

export interface NotifyParams {
  tenantId: string;
  /** Recipients. Duplicates and blanks are dropped. */
  userIds: Array<string | null | undefined>;
  title: string;
  message: string;
  /** `alert` for something clinically time-sensitive; `general` otherwise. */
  notificationType?: 'alert' | 'general' | 'reminder';
  /** Must be mapped in the frontend's `notificationLink()` or the bell dead-ends. */
  referenceType?: string;
  referenceId?: string | null;
}

/**
 * Best-effort in-app notification to one or more users.
 *
 * Returns how many were written, so a caller that wants to log coverage can,
 * without having to care whether the write succeeded.
 */
export async function notifyUsers(params: NotifyParams): Promise<number> {
  const recipients = [...new Set(params.userIds.filter((id): id is string => !!id))];
  if (recipients.length === 0) return 0;

  try {
    const res = await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        tenantId: params.tenantId,
        userId,
        title: params.title,
        message: params.message,
        notificationType: (params.notificationType ?? 'general') as never,
        channel: 'in_app' as never,
        referenceType: params.referenceType,
        referenceId: params.referenceId ?? undefined,
      })),
    });
    return res.count;
  } catch (err) {
    logger.warn(
      { err, referenceType: params.referenceType, referenceId: params.referenceId },
      'Notification write failed — the action itself is unaffected',
    );
    return 0;
  }
}

/**
 * The users registered as OWNERS of this hospital.
 *
 * An owner's `User` row lives on the PLATFORM tenant, not on the hospital they
 * run — they are a platform-level account that switches into a hospital with
 * `X-Tenant-Id`, and one account can own several. Ownership is recorded in
 * `TenantOwner`, not by the user's own tenantId.
 */
export async function tenantOwnerUserIds(tenantId: string): Promise<string[]> {
  try {
    const owners = await prisma.tenantOwner.findMany({
      where: { tenantId, user: { isActive: true } },
      select: { userId: true },
    });
    return owners.map((o) => o.userId);
  } catch (err) {
    logger.warn({ err, tenantId }, 'Could not resolve tenant owners for notification');
    return [];
  }
}

/**
 * Active users to notify in this tenant, by role.
 *
 * **Asking for `admin` also reaches the hospital's owners.** Every one of these
 * lookups filters on `user.tenantId`, and a hospital's own administrator is
 * typically its OWNER, whose account sits on the platform tenant — so a
 * tenant-scoped query cannot see them. On the dev database "Green city
 * Hospital" has ZERO users holding the `admin` role: its only administrator is
 * the owner. Every notice addressed to that hospital's admins reached nobody.
 *
 * Owners are folded in for `admin` rather than behind a flag because that is
 * what the relationship means — owning the hospital IS administering it — and a
 * flag would have to be remembered at every future call site, which is exactly
 * how this went wrong the first time.
 */
export async function usersWithRoles(tenantId: string, roleSlugs: string[]): Promise<string[]> {
  try {
    const [users, owners] = await Promise.all([
      prisma.user.findMany({
        where: {
          tenantId,
          isActive: true,
          userRoles: { some: { role: { name: { in: roleSlugs } } } },
        },
        select: { id: true },
      }),
      roleSlugs.includes('admin') ? tenantOwnerUserIds(tenantId) : Promise.resolve([]),
    ]);
    return [...new Set([...users.map((u) => u.id), ...owners])];
  } catch (err) {
    logger.warn({ err, roleSlugs }, 'Could not resolve notification recipients by role');
    return [];
  }
}

/**
 * The USER behind a `Visit.doctorId` / `Appointment.doctorId`.
 *
 * Those columns hold a **DoctorProfile id, not a User id** — the single most
 * common way a notification here ends up addressed to nobody. Notifications
 * are keyed on User, so the hop is mandatory.
 */
export async function doctorUserIdFromProfile(
  tenantId: string,
  doctorProfileId: string | null | undefined,
): Promise<string | null> {
  if (!doctorProfileId) return null;
  try {
    const profile = await prisma.doctorProfile.findFirst({
      where: { id: doctorProfileId, tenantId },
      select: { userId: true },
    });
    return profile?.userId ?? null;
  } catch (err) {
    logger.warn({ err, doctorProfileId }, 'Could not resolve doctor user for notification');
    return null;
  }
}
