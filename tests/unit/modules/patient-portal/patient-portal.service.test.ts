import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
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
