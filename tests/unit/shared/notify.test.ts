import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import {
  notifyUsers,
  usersWithRoles,
  doctorUserIdFromProfile,
  tenantOwnerUserIds,
} from '../../../src/shared/notify';
import { abnormalFindings, isValueAbnormal } from '../../../src/shared/vitals-ranges';

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyUsers', () => {
  it('writes one notification per recipient, filed under the hospital', async () => {
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);

    const n = await notifyUsers({
      tenantId: TENANT,
      userIds: ['u1', 'u2'],
      title: 'T',
      message: 'M',
      referenceType: 'vital_abnormal',
      referenceId: 'pat-1',
    });

    expect(n).toBe(2);
    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ tenantId: TENANT, userId: 'u1', referenceType: 'vital_abnormal' });
  });

  it('drops blanks and duplicates rather than notifying someone twice', async () => {
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);

    await notifyUsers({
      tenantId: TENANT,
      userIds: ['u1', 'u1', null, undefined],
      title: 'T',
      message: 'M',
    });

    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data.map((d) => d.userId)).toEqual(['u1']);
  });

  it('treats "nobody to tell" as normal, not as a failure', async () => {
    // A walk-in with no doctor assigned, or a hospital with nobody in a role.
    await expect(notifyUsers({ tenantId: TENANT, userIds: [null], title: 'T', message: 'M' })).resolves.toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('never lets a failed notification take the clinical action down', async () => {
    vi.mocked(prisma.notification.createMany).mockRejectedValue(new Error('db down') as never);

    // The vital / booking is already saved by the time this runs.
    await expect(
      notifyUsers({ tenantId: TENANT, userIds: ['u1'], title: 'T', message: 'M' }),
    ).resolves.toBe(0);
  });
});

describe('doctorUserIdFromProfile', () => {
  it('hops from the DoctorProfile id to the User id', async () => {
    // Visit/Appointment.doctorId is a DoctorProfile id; notifications are keyed
    // on User. Skipping the hop addresses the notice to nobody.
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ userId: 'user-doc' } as never);

    await expect(doctorUserIdFromProfile(TENANT, 'profile-1')).resolves.toBe('user-doc');
    const where = vi.mocked(prisma.doctorProfile.findFirst).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ id: 'profile-1', tenantId: TENANT });
  });

  it('asks nothing when there is no doctor on the encounter', async () => {
    await expect(doctorUserIdFromProfile(TENANT, null)).resolves.toBeNull();
    expect(prisma.doctorProfile.findFirst).not.toHaveBeenCalled();
  });
});

describe('usersWithRoles', () => {
  it('resolves active users by role slug', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }] as never);
    vi.mocked(prisma.tenantOwner.findMany).mockResolvedValue([] as never);

    await expect(usersWithRoles(TENANT, ['front_desk', 'admin'])).resolves.toEqual(['u1', 'u2']);
    const where = vi.mocked(prisma.user.findMany).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ tenantId: TENANT, isActive: true });
    expect(where.userRoles.some.role.name.in).toEqual(['front_desk', 'admin']);
  });

  // A hospital's own administrator is typically its OWNER, and an owner's
  // account lives on the PLATFORM tenant — so every tenant-scoped lookup missed
  // them. On the dev database Green city Hospital has zero users holding the
  // `admin` role: everything addressed to its admins reached nobody.
  it('reaches the hospital owner when the ask includes admin', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-billing' }] as never);
    vi.mocked(prisma.tenantOwner.findMany).mockResolvedValue([{ userId: 'u-owner' }] as never);

    await expect(usersWithRoles(TENANT, ['admin', 'billing_admin'])).resolves.toEqual([
      'u-billing',
      'u-owner',
    ]);
    const where = vi.mocked(prisma.tenantOwner.findMany).mock.calls[0][0]!.where as any;
    // Ownership is recorded on TenantOwner, not by the user's own tenantId.
    expect(where).toMatchObject({ tenantId: TENANT });
    expect(where.user).toMatchObject({ isActive: true });
  });

  it('does not drag the owner into a notice meant for clinical staff', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-nurse' }] as never);

    await expect(usersWithRoles(TENANT, ['nurse', 'doctor'])).resolves.toEqual(['u-nurse']);
    expect(prisma.tenantOwner.findMany).not.toHaveBeenCalled();
  });

  it('tells an owner who is also staff once, not twice', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u-owner' }] as never);
    vi.mocked(prisma.tenantOwner.findMany).mockResolvedValue([{ userId: 'u-owner' }] as never);

    await expect(usersWithRoles(TENANT, ['admin'])).resolves.toEqual(['u-owner']);
  });

  it('still answers when the owner lookup fails', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u1' }] as never);
    vi.mocked(prisma.tenantOwner.findMany).mockRejectedValue(new Error('db down') as never);

    await expect(usersWithRoles(TENANT, ['admin'])).resolves.toEqual(['u1']);
  });
});

describe('tenantOwnerUserIds', () => {
  it('skips a deactivated owner account', async () => {
    vi.mocked(prisma.tenantOwner.findMany).mockResolvedValue([] as never);

    await expect(tenantOwnerUserIds(TENANT)).resolves.toEqual([]);
    const where = vi.mocked(prisma.tenantOwner.findMany).mock.calls[0][0]!.where as any;
    expect(where.user).toMatchObject({ isActive: true });
  });
});

describe('abnormal vitals — the server’s own copy of the ranges', () => {
  it('agrees with the frontend thresholds', () => {
    expect(isValueAbnormal('pulseRate', 132)).toBe(true);
    expect(isValueAbnormal('pulseRate', 72)).toBe(false);
    expect(isValueAbnormal('oxygenSaturation', 88)).toBe(true);
    expect(isValueAbnormal('temperature', 39)).toBe(true);
    // Hypothermia and bradypnoea are abnormal too — a lower bound the earlier
    // per-screen copies had dropped.
    expect(isValueAbnormal('temperature', 34)).toBe(true);
    expect(isValueAbnormal('respiratoryRate', 8)).toBe(true);
  });

  it('says nothing about a reading that was not taken', () => {
    expect(isValueAbnormal('pulseRate', null)).toBe(false);
    expect(isValueAbnormal('pulseRate', undefined)).toBe(false);
    expect(isValueAbnormal('pulseRate', '')).toBe(false);
    expect(isValueAbnormal('unknownVital', 999)).toBe(false);
  });

  it('words each finding for a human, with its direction', () => {
    expect(abnormalFindings({ pulseRate: 132, oxygenSaturation: 88 })).toEqual([
      'Pulse 132 bpm (high)',
      'SpO₂ 88 % (low)',
    ]);
  });

  it('finds nothing in a normal set, so nothing is sent', () => {
    expect(
      abnormalFindings({
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        temperature: 36.6,
        respiratoryRate: 16,
        oxygenSaturation: 98,
      }),
    ).toEqual([]);
  });
});
