import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  createNotification,
} from '../../../../src/modules/communication/communication.service';

// A patient's account lives on the PLATFORM tenant by design — one person can
// attend several hospitals and cannot belong to one of them. Notifications
// about their care are written with the HOSPITAL's tenantId.
//
// So every read that filtered `{ tenantId, userId }` could never match for a
// patient. On the dev database ALL 11 patient-targeted notifications were filed
// under a tenant the recipient does not belong to, and none matched: patients
// were not missing some notifications, they had never received one.
//
// The reads are scoped by the token's user instead. That is not a loosening —
// a notification names exactly one user, and `userId` comes from the token.

const HOSPITAL = 'tenant-hospital';
const PLATFORM = 'tenant-platform';
const PATIENT_USER = 'user-patient';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading notifications is scoped to the person, not the tenant', () => {
  it('does not filter the list by the session tenant', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.notification.count).mockResolvedValue(0 as never);

    await getNotifications(PLATFORM, PATIENT_USER, { page: 1, limit: 20 } as never);

    const where = vi.mocked(prisma.notification.findMany).mock.calls[0][0]!.where as any;
    expect(where.userId).toBe(PATIENT_USER);
    // The killer: a patient on the platform tenant reading a notification
    // written with the hospital's tenantId.
    expect(where.tenantId).toBeUndefined();
  });

  it('counts unread by recipient, so the badge is not always zero', async () => {
    vi.mocked(prisma.notification.count).mockResolvedValue(3 as never);

    const res = await getUnreadCount(PLATFORM, PATIENT_USER);

    const where = vi.mocked(prisma.notification.count).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ userId: PATIENT_USER, isRead: false });
    expect(where.tenantId).toBeUndefined();
    expect(res.unreadCount).toBe(3);
  });

  it('lets the recipient mark one read from whichever tenant they are on', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: 'n1' } as never);
    vi.mocked(prisma.notification.update).mockResolvedValue({ id: 'n1', isRead: true } as never);

    await markNotificationRead(PLATFORM, PATIENT_USER, 'n1');

    const where = vi.mocked(prisma.notification.findFirst).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ id: 'n1', userId: PATIENT_USER });
    expect(where.tenantId).toBeUndefined();
  });

  it('marks all read for the recipient', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 2 } as never);

    await markAllNotificationsRead(PLATFORM, PATIENT_USER);

    const where = vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ userId: PATIENT_USER, isRead: false });
    expect(where.tenantId).toBeUndefined();
  });

  it('still refuses to touch someone else’s notification', async () => {
    // Scoping by user is the whole guard, so it has to actually hold.
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null as never);

    await expect(deleteNotification(PLATFORM, PATIENT_USER, 'someone-elses')).rejects.toThrow(
      /not found/i,
    );
    const where = vi.mocked(prisma.notification.findFirst).mock.calls[0][0]!.where as any;
    expect(where.userId).toBe(PATIENT_USER);
  });
});

describe('createNotification — who a hospital may notify', () => {
  const input = {
    userId: PATIENT_USER,
    title: 'Report ready',
    message: 'Your lab report is available.',
    notificationType: 'general',
    channel: 'in_app',
  } as never;

  it('accepts a patient this hospital treats, even though they sit on another tenant', async () => {
    // Not a staff user here...
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    // ...but the hospital has a Patient record for them.
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as never);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'n1' } as never);

    await expect(createNotification(HOSPITAL, input)).resolves.toMatchObject({ id: 'n1' });
  });

  it('accepts staff on the tenant', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-nurse' } as never);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'n2' } as never);

    await expect(createNotification(HOSPITAL, input)).resolves.toMatchObject({ id: 'n2' });
  });

  it('still refuses a stranger — one hospital cannot notify another’s users', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as never);

    await expect(createNotification(HOSPITAL, input)).rejects.toThrow(/not found in this tenant/i);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('files the notice under the hospital it is about, not the recipient’s tenant', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as never);
    vi.mocked(prisma.notification.create).mockResolvedValue({ id: 'n3' } as never);

    await createNotification(HOSPITAL, input);

    // Which hospital a notice concerns is worth keeping — a patient with
    // records at two of them needs to tell the two apart.
    const data = vi.mocked(prisma.notification.create).mock.calls[0][0]!.data as any;
    expect(data.tenantId).toBe(HOSPITAL);
    expect(data.userId).toBe(PATIENT_USER);
  });
});
