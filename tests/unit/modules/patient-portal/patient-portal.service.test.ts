import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getPatientAppointments,
  listMyProfiles,
  getPatientConsultationSummaries,
  getPatientPrescriptions,
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

describe('Patient portal — profile switcher', () => {
  // Signup used to mint a Patient row on the PLATFORM tenant. Platform is not
  // a hospital — no doctors, wards or bills — so that row could never hold a
  // record, but it survived until the person booked somewhere real and got a
  // second row. One human, two entries with the SAME MRN, the platform one
  // always empty; picking it showed them nothing, because the portal narrows
  // to the single chosen row.
  it('never offers a platform-tenant row as a profile', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'platform-1' } as any);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);

    await listMyProfiles(USER_ID, EMAIL);

    const where = vi.mocked(prisma.patient.findMany).mock.calls[0][0]?.where as any;
    expect(where.tenantId).toEqual({ not: 'platform-1' });
  });

  it('applies the same rule to the legacy email fallback', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'platform-1' } as any);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);

    await listMyProfiles(USER_ID, EMAIL);

    // Second patient.findMany call is the email-match fallback.
    const calls = vi.mocked(prisma.patient.findMany).mock.calls;
    const emailWhere = calls[calls.length - 1][0]?.where as any;
    expect(emailWhere.tenantId).toEqual({ not: 'platform-1' });
  });

  it('still works if there is no platform tenant to exclude', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.patient.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as any);

    await expect(listMyProfiles(USER_ID, EMAIL)).resolves.toBeDefined();
    const where = vi.mocked(prisma.patient.findMany).mock.calls[0][0]?.where as any;
    expect(where.tenantId).toBeUndefined();
  });
});
