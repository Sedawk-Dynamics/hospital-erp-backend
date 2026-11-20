import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { importStaffFromUsers, createStaffProfile } from '../../../../src/modules/hr/hr.service';

// Gap 300: HR could not add staff, so attendance/payroll had nobody to select.
describe('importStaffFromUsers (gap 300)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one draft profile per staff user without a profile, in the default department', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }] as any);
    vi.mocked(prisma.department.findMany).mockResolvedValue([
      { id: 'd-gen', name: 'General' },
      { id: 'd-nurse', name: 'Nursing' },
    ] as any);
    vi.mocked(prisma.staffProfile.createMany).mockResolvedValue({ count: 2 } as any);

    const res = await importStaffFromUsers('t1', {});

    const where = vi.mocked(prisma.user.findMany).mock.calls[0]![0]!.where as any;
    expect(where).toMatchObject({ tenantId: 't1', isActive: true, staffProfile: null });
    // Patient-only accounts are excluded.
    expect(where.userRoles).toEqual({ some: { role: { name: { not: 'patient' } } } });
    expect(prisma.staffProfile.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 't1', userId: 'u1', departmentId: 'd-nurse' },
        { tenantId: 't1', userId: 'u2', departmentId: 'd-nurse' },
      ],
      skipDuplicates: true,
    });
    expect(res).toEqual({ created: 2, skipped: 0 });
  });

  it('is a no-op when every staff user already has a profile', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
    const res = await importStaffFromUsers('t1', { departmentId: '00000000-0000-0000-0000-000000000001' });
    expect(res).toEqual({ created: 0, skipped: 0 });
    expect(prisma.staffProfile.createMany).not.toHaveBeenCalled();
  });

  it('createStaffProfile falls back to the default department when none is given', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u1' } as any);
    vi.mocked(prisma.staffProfile.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.department.findMany).mockResolvedValue([{ id: 'd-gen', name: 'General' }] as any);
    vi.mocked(prisma.staffProfile.create).mockResolvedValue({ id: 's1' } as any);

    await createStaffProfile('t1', { userId: 'u1' } as any);
    expect(vi.mocked(prisma.staffProfile.create).mock.calls[0]![0].data).toMatchObject({ departmentId: 'd-gen' });
  });
});
