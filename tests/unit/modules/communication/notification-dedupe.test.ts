import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  collapseNotifications,
  countUniqueNotifications,
  notificationGroupKey,
} from '../../../../src/modules/communication/notification-dedupe';
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
} from '../../../../src/modules/communication/communication.service';

const USER = 'user-1';
const claimAlert = (id: string, title = 'Insurance claim expiring in 1 day', isRead = false) => ({
  id,
  referenceType: 'insurance_claim',
  referenceId: 'claim-1',
  title,
  isRead,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notification grouping (gap 295)', () => {
  it('treats repeated rows for the same record and stage as one notification', () => {
    const rows = Array.from({ length: 22 }, (_, i) => claimAlert(`n${i}`));
    expect(countUniqueNotifications(rows)).toBe(1);
    const [group] = collapseNotifications(rows);
    expect(group.head.id).toBe('n0');
    expect(group.memberIds).toHaveLength(22);
  });

  it('folds every deadline stage of one claim into one entry, apart from other alerts on it', () => {
    const rows = [
      claimAlert('a', 'Insurance claim expired'),
      claimAlert('b', 'Insurance claim expiring in 1 day'),
      claimAlert('c', 'Insurance claim expiring in 3 days'),
      claimAlert('d', 'Insurance claim expiring in 7 days'),
      claimAlert('e', 'Insurance claim approved'),
    ];
    expect(countUniqueNotifications(rows)).toBe(2);
  });

  it('never merges rows that name no record', () => {
    const rows = [
      { id: 'x', referenceType: null, referenceId: null, title: 'Same title' },
      { id: 'y', referenceType: null, referenceId: null, title: 'Same title' },
    ];
    expect(countUniqueNotifications(rows)).toBe(2);
    expect(notificationGroupKey(rows[0])).not.toBe(notificationGroupKey(rows[1]));
  });

  it('a group is unread while any copy is unread', () => {
    const [g] = collapseNotifications([claimAlert('a', undefined, true), claimAlert('b', undefined, false)]);
    expect(g.unread).toBe(true);
  });
});

describe('notification centre reads (gap 295/296)', () => {
  it('badge counts unique unread notifications, not rows', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue(
      [...Array.from({ length: 22 }, (_, i) => claimAlert(`n${i}`)), { id: 'other', referenceType: 'lab_report', referenceId: 'lab-1', title: 'Report ready', isRead: false }] as never,
    );
    await expect(getUnreadCount('t1', USER)).resolves.toEqual({ unreadCount: 2 });
  });

  it('lists one entry per group with its duplicate count, re-worded from the due date', async () => {
    vi.mocked(prisma.notification.findMany)
      // key scan
      .mockResolvedValueOnce([claimAlert('n0'), claimAlert('n1'), claimAlert('n2')] as never)
      // page rows
      .mockResolvedValueOnce([
        { ...claimAlert('n0'), message: 'Claim CLM-1 is due by 09/11/2026.', userId: USER, createdAt: new Date() },
      ] as never);
    vi.mocked(prisma.insuranceClaim.findMany).mockResolvedValue([
      { id: 'claim-1', claimNumber: 'CLM-1', expiryDate: new Date('2026-11-09T00:00:00.000Z'), patient: { firstName: 'Asha', lastName: 'Rao' } },
    ] as never);

    // 19/11/2026 IST — ten days after the claim's 09/11 deadline.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T04:30:00.000Z'));
    try {
      const res = await getNotifications('t1', USER, { page: 1, limit: 20 } as never);

      expect(res.total).toBe(1);
      expect(res.notifications).toHaveLength(1);
      expect(res.notifications[0]).toMatchObject({ id: 'n0', duplicateCount: 3, isRead: false });
      // The stored "expiring in 1 day" must not be shown for an expired claim.
      expect(res.notifications[0].title).toBe('Insurance claim expired');
      expect(res.notifications[0].message).toMatch(/10 days ago/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marking one read clears its collapsed copies too', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ ...claimAlert('n0'), userId: USER } as never);
    vi.mocked(prisma.notification.findMany).mockResolvedValue([claimAlert('n0'), claimAlert('n1'), claimAlert('n2')] as never);
    vi.mocked(prisma.notification.update).mockResolvedValue({ id: 'n0', isRead: true } as never);

    await markNotificationRead('t1', USER, 'n0');

    const call = vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!;
    expect((call.where as any).id.in.sort()).toEqual(['n0', 'n1', 'n2']);
    expect((call.where as any).userId).toBe(USER);
  });
});
