import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import * as identity from '../../../../src/shared/patient-identity';
import {
  getPatientAppointments,
  listMyProfiles,
  getPatientConsultationSummaries,
  getPatientPrescriptions,
  createMyProfile,
} from '../../../../src/modules/patient-portal/patient-portal.service';

const USER_ID = 'user-1';
const EMAIL = 'patient@example.com';

beforeEach(() => {
  vi.clearAllMocks();
});

/** The user owns one patient record, resolved via `patient.findMany({ userId })`. */
function ownsPatient(id = 'p1') {
  vi.mocked(prisma.patient.findMany).mockResolvedValue([{ id, tenantId: 't1' }] as any);
  vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);
}

describe('Patient portal — consultation summaries', () => {
  // A signed consultation with nothing pinned used to be filtered out entirely
  // (`pins: { some: … }`), so a patient whose doctor wrote up the visit
  // normally saw an empty list and concluded nothing had been documented.
  it('lists a signed consultation even when the doctor pinned nothing', async () => {
    ownsPatient();
    vi.mocked(prisma.progressNote.findMany).mockResolvedValue([
      { id: 'n1', status: 'finalized', pins: [], content: 'Reviewed, doing well' },
    ] as any);

    const notes = await getPatientConsultationSummaries(USER_ID, EMAIL, {});

    expect(notes).toHaveLength(1);
    const where = vi.mocked(prisma.progressNote.findMany).mock.calls[0][0]?.where as any;
    expect(where.pins).toBeUndefined();
    expect(where.status.in).toContain('finalized');
  });

  // Ward rounds belong to the discharge summary, not the OP consultation list.
  it('excludes in-patient ward notes', async () => {
    ownsPatient();
    vi.mocked(prisma.progressNote.findMany).mockResolvedValue([] as any);

    await getPatientConsultationSummaries(USER_ID, EMAIL, {});

    const where = vi.mocked(prisma.progressNote.findMany).mock.calls[0][0]?.where as any;
    expect(where.admissionId).toBeNull();
  });

  // Rule reversed on purpose (Test Report 3 / A7 follow-up). Requiring a
  // signature meant the patient saw nothing until the doctor got round to
  // signing, which on real data was almost never — one consultation was
  // visible across the whole database while ten existed.
  //
  // An unsigned note is not a half-written one: it is created when the doctor
  // ENDS the consultation, and the in-progress draft lives in the browser
  // rather than this table. The portal marks these as awaiting sign-off.
  it('includes an unsigned consultation so the patient is not left waiting', async () => {
    ownsPatient();
    vi.mocked(prisma.progressNote.findMany).mockResolvedValue([] as any);

    await getPatientConsultationSummaries(USER_ID, EMAIL, {});

    const where = vi.mocked(prisma.progressNote.findMany).mock.calls[0][0]?.where as any;
    expect(where.status.in).toEqual(
      expect.arrayContaining(['finalized', 'active', 'archived']),
    );
  });

  // signedAt is null on an unsigned note, so ordering by it would bury the most
  // recent consultations at the bottom of the patient's list.
  it('orders by when the consultation happened, not when it was signed', async () => {
    ownsPatient();
    vi.mocked(prisma.progressNote.findMany).mockResolvedValue([] as any);

    await getPatientConsultationSummaries(USER_ID, EMAIL, {});

    const args = vi.mocked(prisma.progressNote.findMany).mock.calls[0][0] as any;
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });
});

describe('Patient portal — profile scoping', () => {
  // A stale profileId (family member removed, or left over in a store from a
  // previous session) used to resolve to an empty patient set, which rendered
  // every list on the portal blank with no explanation.
  it('falls back to all the user\'s records when profileId is not theirs', async () => {
    ownsPatient('p1');
    vi.mocked(prisma.prescription.findMany).mockResolvedValue([{ id: 'rx1' }] as any);

    const { data } = await getPatientPrescriptions(USER_ID, EMAIL, { profileId: 'someone-else' });

    expect(data).toHaveLength(1);
    const where = vi.mocked(prisma.prescription.findMany).mock.calls[0][0]?.where as any;
    expect(where.patientId.in).toEqual(['p1']);
  });

  it('honours a profileId the user does own', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'p1', tenantId: 't1' },
      { id: 'p2', tenantId: 't1' },
    ] as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.prescription.findMany).mockResolvedValue([] as any);

    await getPatientPrescriptions(USER_ID, EMAIL, { profileId: 'p2' });

    const where = vi.mocked(prisma.prescription.findMany).mock.calls[0][0]?.where as any;
    expect(where.patientId.in).toEqual(['p2']);
  });
});

describe('Patient portal — upcoming appointments', () => {
  // The dashboard panel asked for sortOrder=asc with limit=5 and no date
  // filter, which returns the five OLDEST appointments on record. A patient
  // with any history saw visits from months ago under "Upcoming", and an
  // appointment they had just booked appeared nowhere, because it sorts last.
  it('filters to appointments still ahead, rather than relying on the sort', async () => {
    ownsPatient();
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);

    await getPatientAppointments(USER_ID, EMAIL, { upcoming: true, limit: 5, sortOrder: 'asc' });

    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0][0]?.where as any;
    expect(where.appointmentDate?.gte).toBeInstanceOf(Date);
    // From the START of today — an appointment later today is still upcoming.
    const gte = where.appointmentDate.gte as Date;
    expect([gte.getHours(), gte.getMinutes(), gte.getSeconds()]).toEqual([0, 0, 0]);
  });

  it('leaves out a future appointment that will not happen', async () => {
    ownsPatient();
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);

    await getPatientAppointments(USER_ID, EMAIL, { upcoming: true });

    // A cancelled appointment next Tuesday is not something to turn up for,
    // and the list page applies the same rule.
    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0][0]?.where as any;
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['completed', 'cancelled', 'no_show']),
    );
  });

  it('does not filter anything when upcoming is not asked for', async () => {
    ownsPatient();
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);

    await getPatientAppointments(USER_ID, EMAIL, {});

    // The full history is what the appointments page renders.
    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0][0]?.where as any;
    expect(where.appointmentDate).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  it('still honours an explicit status filter', async () => {
    ownsPatient();
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);

    await getPatientAppointments(USER_ID, EMAIL, { status: 'booked' });

    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0][0]?.where as any;
    expect(where.status).toBe('booked');
  });
});

describe('Patient portal — platform placeholders', () => {
  const platform = { id: 'platform-1', name: 'Platform', slug: '__platform__', logoUrl: null };
  const hospital = { id: 'h1', name: 'Green city Hospital', slug: 'gch', logoUrl: null };

  beforeEach(() => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'platform-1' } as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);
  });

  // The reported bug: one human, two entries with the same MRN, the platform
  // one always empty — and picking it showed them nothing.
  it('hides the platform placeholder once the person has a real hospital row', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'p-plat', mrn: 'MRN-1', firstName: 'Don', isSelf: true, tenantId: 'platform-1', tenant: platform },
      { id: 'p-hosp', mrn: 'MRN-1', firstName: 'Don', isSelf: false, tenantId: 'h1', tenant: hospital },
    ] as any);
    vi.spyOn(identity, 'resolvePersonPatientIds').mockResolvedValue(['p-plat', 'p-hosp']);

    const profiles: any[] = await listMyProfiles(USER_ID, EMAIL);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('p-hosp');
    expect(profiles[0].alsoAt).toEqual([]);
  });

  // The regression this replaced: blanket-hiding platform rows made a newly
  // added family member vanish, because that is where they are created until
  // the person has picked a hospital.
  it('keeps a person who has ONLY a placeholder', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'child', mrn: 'MRN-C', firstName: 'Child', isSelf: false, tenantId: 'platform-1', tenant: platform },
    ] as any);
    vi.spyOn(identity, 'resolvePersonPatientIds').mockImplementation(async (id) => [id]);

    const profiles: any[] = await listMyProfiles(USER_ID, EMAIL);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('child');
  });
});

describe('Patient portal — one person, one profile', () => {
  const tenantA = { id: 'ta', name: 'Hospital A', slug: 'a', logoUrl: null };
  const tenantB = { id: 'tb', name: 'Hospital B', slug: 'b', logoUrl: null };

  beforeEach(() => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'platform-1' } as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);
  });

  // A row is a hospital's record, so one person treated at two hospitals has
  // two of them — and the switcher listed each, which reads as two people.
  it('shows one entry for the same person held at two hospitals', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'p-a', mrn: 'MRN-1', firstName: 'Same', isSelf: true, tenant: tenantA },
      { id: 'p-b', mrn: 'MRN-1', firstName: 'Same', isSelf: false, tenant: tenantB },
    ] as any);
    vi.spyOn(identity, 'resolvePersonPatientIds').mockResolvedValue(['p-a', 'p-b']);

    const profiles: any[] = await listMyProfiles(USER_ID, EMAIL);

    expect(profiles).toHaveLength(1);
    // The person's own record represents them.
    expect(profiles[0].id).toBe('p-a');
    // …and the entry still records where else they are known.
    expect(profiles[0].alsoAt).toEqual([{ id: 'tb', name: 'Hospital B' }]);
  });

  // The trap: a parent's account holds their own row AND their children's
  // under the SAME userId. Grouping by account would merge a parent with
  // their child.
  it('never merges a parent with their child', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'parent', mrn: 'M-P', firstName: 'Parent', isSelf: true, tenant: tenantA },
      { id: 'child', mrn: 'M-C', firstName: 'Child', isSelf: false, tenant: tenantA },
    ] as any);
    // The identity rule keeps different people apart.
    vi.spyOn(identity, 'resolvePersonPatientIds').mockImplementation(async (id) => [id]);

    const profiles: any[] = await listMyProfiles(USER_ID, EMAIL);

    expect(profiles.map((p) => p.id).sort()).toEqual(['child', 'parent']);
  });

  it('never widens what the account can reach', async () => {
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'mine', mrn: 'M-1', firstName: 'Same', isSelf: true, tenant: tenantA },
    ] as any);
    // The person also exists on a row this account cannot see.
    vi.spyOn(identity, 'resolvePersonPatientIds').mockResolvedValue(['mine', 'someone-elses-row']);

    const profiles: any[] = await listMyProfiles(USER_ID, EMAIL);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].alsoAt).toEqual([]);
  });

  // Selecting a collapsed profile must surface the person's records
  // everywhere, not just the row that represents them.
  it('resolves a chosen profile to the whole person', async () => {
    ownsPatient('p-a');
    vi.mocked(prisma.patient.findMany).mockResolvedValue([
      { id: 'p-a', tenantId: 't1' },
      { id: 'p-b', tenantId: 't2' },
    ] as any);
    vi.spyOn(identity, 'resolvePersonPatientIds').mockResolvedValue(['p-a', 'p-b']);
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);

    await getPatientAppointments(USER_ID, EMAIL, { profileId: 'p-a' });

    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0][0]?.where as any;
    expect(where.patientId.in.sort()).toEqual(['p-a', 'p-b']);
  });
});

describe('Patient portal — adding a family profile', () => {
  const user = { id: USER_ID, tenantId: 't-platform' };
  const existing = {
    id: 'p1', mrn: 'MRN-OLD-1', firstName: 'Riya', lastName: 'Probe',
    dateOfBirth: new Date('2016-04-05'),
  };

  // Nothing checked the account for the person being added, so tapping Add
  // twice — or re-adding a child already listed — minted a second profile and
  // a second MRN for one child, and a booking then landed on whichever row the
  // form happened to carry.
  it('refuses someone who is already on the account', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([existing] as never);

    await expect(
      createMyProfile(USER_ID, {
        firstName: 'Riya', lastName: 'Probe', relationship: 'child', dateOfBirth: '2016-04-05',
      }),
    // The existing MRN is named, so the patient sees which profile they have.
    ).rejects.toThrow(/MRN-OLD-1/);
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  it('still adds a sibling born on another day', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([existing] as never);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.patient.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p2' } as never);

    await createMyProfile(USER_ID, {
      firstName: 'Aarav', lastName: 'Probe', relationship: 'child', dateOfBirth: '2019-11-02',
    });

    expect(prisma.patient.create).toHaveBeenCalled();
  });
});
