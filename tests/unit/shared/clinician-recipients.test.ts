import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import {
  clinicianUserIdsForVisit,
  describePatientForNotification,
} from '../../../src/shared/notify';

// "Not getting the notification at the doctor's side" and "the abnormal-value
// notification should identify the patient without opening it blindly" are the
// same code path seen from two angles: who a result alert reaches, and whether
// it says anything useful when it gets there.

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('who hears about a result', () => {
  it('tells the treating doctor as well as whoever ordered the test', async () => {
    // The gap: the lab pipeline notified `orderedBy` and nobody else. On the
    // dev database 4 of 17 orders were placed by someone other than the visit's
    // own doctor, and the treating doctor heard nothing about any of them.
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({
      doctor: { userId: 'user-treating' },
      admission: null,
    } as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: 'user-ordering' }),
    ).resolves.toEqual(['user-ordering', 'user-treating']);
  });

  it('includes the admitting consultant, who can differ from the visit doctor', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({
      doctor: { userId: 'user-treating' },
      admission: { doctor: { userId: 'user-consultant' } },
    } as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: 'user-ordering' }),
    ).resolves.toEqual(['user-ordering', 'user-treating', 'user-consultant']);
  });

  it('tells one doctor once when they are both', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({
      doctor: { userId: 'user-same' },
      admission: null,
    } as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: 'user-same' }),
    ).resolves.toEqual(['user-same']);
  });

  it('still reaches the treating doctor when nobody is recorded as ordering', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({
      doctor: { userId: 'user-treating' },
      admission: null,
    } as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: null }),
    ).resolves.toEqual(['user-treating']);
  });

  it('never falls back to somebody who is not a clinician', async () => {
    // The old critical-value path fell back to the PATIENT's own account, so a
    // panic value went to the patient unmediated while no clinician was told.
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({ doctor: null, admission: null } as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: null }),
    ).resolves.toEqual([]);
  });

  it('does not fail the alert when the visit cannot be read', async () => {
    vi.mocked(prisma.visit.findFirst).mockRejectedValue(new Error('db down') as never);

    await expect(
      clinicianUserIdsForVisit(TENANT, { visitId: 'visit-1', orderedBy: 'user-ordering' }),
    ).resolves.toEqual(['user-ordering']);
  });
});

describe('naming the patient in an alert', () => {
  it('gives name and MRN so the alert can be triaged from the bell', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({
      firstName: 'Asha', lastName: 'Rao', mrn: 'MRN-9', admissions: [],
    } as never);

    await expect(describePatientForNotification(TENANT, 'pat-1')).resolves.toBe('Asha Rao (MRN-9)');
  });

  it('adds where to find an inpatient', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({
      firstName: 'Asha',
      lastName: 'Rao',
      mrn: 'MRN-9',
      admissions: [{ ward: { name: 'ICU' }, bed: { bedNumber: 'A-4' } }],
    } as never);

    // The difference between acting now and going looking.
    await expect(describePatientForNotification(TENANT, 'pat-1')).resolves.toBe(
      'Asha Rao (MRN-9), ICU A-4',
    );
  });

  it('copes with a patient who has no MRN yet', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({
      firstName: 'Unknown', lastName: null, mrn: null, admissions: [],
    } as never);

    await expect(describePatientForNotification(TENANT, 'pat-1')).resolves.toBe('Unknown');
  });

  it('never blocks an alert because the patient could not be read', async () => {
    vi.mocked(prisma.patient.findFirst).mockRejectedValue(new Error('db down') as never);

    await expect(describePatientForNotification(TENANT, 'pat-1')).resolves.toBe('A patient');
  });
});
