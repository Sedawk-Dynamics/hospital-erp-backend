import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import {
  resolvePersonPatientIds,
  resolvePersonCanonicalPatientId,
  isSameNamedPerson,
} from '../../../src/shared/patient-identity';

// ============================================================
// Which patient rows are the SAME human?
// ============================================================
//
// This decides whether two records share allergies, family history and personal
// history. Merging too eagerly attributes one patient's drug allergy to another
// — so the rule is deliberately strict, and these tests exist to stop anyone
// loosening it for convenience.
//
// The rule: ABHA (unique per individual) stands alone; otherwise name AND date
// of birth must match, plus either the same account or the same phone. Without
// a date of birth nothing merges.

const SELF = {
  id: 'p-self',
  userId: null as string | null,
  abhaNumber: null as string | null,
  firstName: 'Asha',
  lastName: 'Rao',
  dateOfBirth: new Date('1985-02-10'),
  phone: '+919812345678',
};

describe('resolvePersonPatientIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns just the row when the patient does not exist', async () => {
    vi.mocked(prisma.patient.findUnique).mockResolvedValue(null as never);
    await expect(resolvePersonPatientIds('missing')).resolves.toEqual(['missing']);
  });

  describe('ABHA — a government identity unique to one person', () => {
    it('merges every row carrying the same ABHA number', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF,
        abhaNumber: 'ABHA-123',
      } as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { id: 'p-self' }, { id: 'p-other-hospital' },
      ] as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toContain('p-self');
      expect(ids).toContain('p-other-hospital');
    });

    it('does not fall through to weaker matching once ABHA is present', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF,
        abhaNumber: 'ABHA-123',
      } as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([{ id: 'p-self' }] as never);

      await resolvePersonPatientIds('p-self');

      // No phone probe — ABHA is conclusive on its own.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('same account (userId)', () => {
    it('merges rows for the same human under one account', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF,
        userId: 'user-1',
      } as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { ...SELF, id: 'p-self', userId: 'user-1' },
        { ...SELF, id: 'p-same-person', userId: 'user-1' },
      ] as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toEqual(expect.arrayContaining(['p-self', 'p-same-person']));
    });

    it('does NOT merge a family member sharing the account', async () => {
      // One portal account owns the whole family's profiles. Grouping on userId
      // alone would put a mother's and her child's allergies on one record.
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF,
        userId: 'user-1',
      } as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { ...SELF, id: 'p-self', userId: 'user-1' },
        {
          ...SELF, id: 'p-child', userId: 'user-1',
          firstName: 'Ravi', dateOfBirth: new Date('2015-09-02'),
        },
      ] as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toContain('p-self');
      expect(ids).not.toContain('p-child');
    });
  });

  describe('no account — name + DOB + phone must all agree', () => {
    it('merges duplicates of the same person', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(SELF as never);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { id: 'p-self' }, { id: 'p-dup' },
      ] as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { ...SELF, id: 'p-self' },
        { ...SELF, id: 'p-dup' },
      ] as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toEqual(expect.arrayContaining(['p-self', 'p-dup']));
    });

    it('does NOT merge a relative sharing the phone number', async () => {
      // Families share a number; only name AND date of birth can separate them.
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(SELF as never);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { id: 'p-self' }, { id: 'p-relative' },
      ] as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { ...SELF, id: 'p-self' },
        {
          ...SELF, id: 'p-relative',
          firstName: 'Ravi', dateOfBirth: new Date('2015-09-02'),
        },
      ] as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toEqual(['p-self']);
    });

    it('refuses to merge at all without a date of birth', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF, dateOfBirth: null,
      } as never);

      const ids = await resolvePersonPatientIds('p-self');

      expect(ids).toEqual(['p-self']);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses to merge on a phone too short to be meaningful', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({
        ...SELF, phone: '12345',
      } as never);

      await expect(resolvePersonPatientIds('p-self')).resolves.toEqual(['p-self']);
    });
  });

  it('matches names case- and whitespace-insensitively', async () => {
    vi.mocked(prisma.patient.findUnique).mockResolvedValue({
      ...SELF, userId: 'user-1',
    } as never);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { ...SELF, id: 'p-self', userId: 'user-1' },
      {
        ...SELF, id: 'p-messy', userId: 'user-1',
        firstName: '  ASHA ', lastName: 'rao',
      },
    ] as never);

    const ids = await resolvePersonPatientIds('p-self');

    expect(ids).toContain('p-messy');
  });
});

describe('resolvePersonCanonicalPatientId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the row itself when the person has only one', async () => {
    vi.mocked(prisma.patient.findUnique).mockResolvedValue({
      ...SELF, dateOfBirth: null,
    } as never);

    await expect(resolvePersonCanonicalPatientId('p-self')).resolves.toBe('p-self');
  });

  it('prefers the row that already holds the personal history', async () => {
    // Personal history is a singleton per person — writing it anywhere else
    // would give one human a lifestyle record per hospital.
    vi.mocked(prisma.patient.findUnique).mockResolvedValue({
      ...SELF, userId: 'user-1',
    } as never);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { ...SELF, id: 'p-self', userId: 'user-1' },
      { ...SELF, id: 'p-dup', userId: 'user-1' },
    ] as never);
    vi.mocked(prisma.patientPersonalHistory.findMany).mockResolvedValue([
      { patientId: 'p-dup', updatedAt: new Date() },
    ] as never);

    await expect(resolvePersonCanonicalPatientId('p-self')).resolves.toBe('p-dup');
  });

  it('falls back to the oldest row when no history exists yet', async () => {
    vi.mocked(prisma.patient.findUnique).mockResolvedValue({
      ...SELF, userId: 'user-1',
    } as never);
    vi.mocked(prisma.patient.findMany)
      .mockResolvedValueOnce([
        { ...SELF, id: 'p-self', userId: 'user-1' },
        { ...SELF, id: 'p-dup', userId: 'user-1' },
      ] as never)
      .mockResolvedValueOnce([{ id: 'p-oldest' }] as never);
    vi.mocked(prisma.patientPersonalHistory.findMany).mockResolvedValue([] as never);

    await expect(resolvePersonCanonicalPatientId('p-self')).resolves.toBe('p-oldest');
  });
});

describe('isSameNamedPerson', () => {
  const riya = { firstName: 'Riya', lastName: 'Probe', dateOfBirth: new Date('2016-04-05') };

  it('matches the same name and date of birth', () => {
    expect(isSameNamedPerson(riya, { ...riya, dateOfBirth: '2016-04-05' })).toBe(true);
  });

  it('ignores case and surrounding space in a name', () => {
    expect(isSameNamedPerson(riya, { firstName: '  rIYa ', lastName: 'probe', dateOfBirth: '2016-04-05' })).toBe(true);
  });

  // A son named after his father, or two siblings sharing a first name: the
  // date of birth is what keeps them apart.
  it('separates two people who share a name', () => {
    expect(isSameNamedPerson(riya, { ...riya, dateOfBirth: '2019-11-02' })).toBe(false);
  });

  it('separates two different names born on one day', () => {
    expect(isSameNamedPerson(riya, { ...riya, firstName: 'Aarav' })).toBe(false);
  });

  // A field skipped twice is likelier than untracked twins — and registration
  // offers an explicit override for when it really is not.
  it('treats two records with no date of birth as one person', () => {
    expect(
      isSameNamedPerson(
        { firstName: 'Riya', lastName: 'Probe', dateOfBirth: null },
        { firstName: 'Riya', lastName: 'Probe' },
      ),
    ).toBe(true);
  });

  it('does not match a record that has a date of birth against one that does not', () => {
    expect(isSameNamedPerson(riya, { firstName: 'Riya', lastName: 'Probe' })).toBe(false);
  });
});
