import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getPatientFile,
  getPlatformPatientDirectory,
  isPlatformActor,
} from '../../../../src/modules/patients/patients.file.service';

vi.mock('../../../../src/shared/patient-identity', () => ({
  resolvePersonPatientIds: vi.fn(async (id: string) => [id]),
}));
import { resolvePersonPatientIds } from '../../../../src/shared/patient-identity';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const PATIENT = 'patient-1';

const hospitalAdmin = { tenantId: TENANT, roles: ['admin'] };
const superAdmin = { tenantId: TENANT, roles: ['super_admin'] };

function patientRow(over: Record<string, unknown> = {}) {
  return {
    id: PATIENT,
    tenantId: TENANT,
    mrn: 'MRN-0001',
    firstName: 'Sample',
    lastName: 'Patient',
    dateOfBirth: new Date('1984-01-01'),
    gender: 'male',
    bloodGroup: 'O+',
    maritalStatus: null,
    phone: '9990000000',
    email: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    occupation: null,
    nationality: null,
    religion: null,
    abhaNumber: null,
    idProofType: null,
    idProofNumber: null,
    referredBy: null,
    notes: null,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    tenant: { id: TENANT, name: 'Green city Hospital' },
    user: null,
    emergencyContacts: [],
    ...over,
  };
}

/** Everything the file fetches in parallel resolves empty unless a test says otherwise. */
function emptyRelations() {
  (prisma.patientPersonalHistory.findFirst as any).mockResolvedValue(null);
}

describe('centralized patient file — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePersonPatientIds as any).mockImplementation(async (id: string) => [id]);
    emptyRelations();
  });

  // The whole point of the feature: a hospital admin sees the file only for
  // patients registered at THEIR hospital.
  it('scopes a hospital admin to their own tenant', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(patientRow());

    await getPatientFile(hospitalAdmin, PATIENT);

    expect(prisma.patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PATIENT, tenantId: TENANT } }),
    );
  });

  it('drops the tenant filter for super_admin', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(patientRow({ tenantId: OTHER_TENANT }));

    await getPatientFile(superAdmin, PATIENT);

    expect(prisma.patient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PATIENT } }),
    );
  });

  // 404 and not 403 on purpose: "this patient exists but is not yours" would
  // confirm the person is a patient somewhere else, which is precisely what a
  // hospital admin must not learn from this screen.
  it("reports a patient from another hospital as simply not found", async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(null);

    await expect(getPatientFile(hospitalAdmin, PATIENT)).rejects.toThrow('Patient not found');
  });

  it('labels the scope so the UI can say which view this is', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(patientRow());
    const asHospital = await getPatientFile(hospitalAdmin, PATIENT);
    expect(asHospital.access.scope).toBe('hospital');
    expect(asHospital.access.hospital.name).toBe('Green city Hospital');

    (prisma.patient.findFirst as any).mockResolvedValue(patientRow());
    const asPlatform = await getPatientFile(superAdmin, PATIENT);
    expect(asPlatform.access.scope).toBe('platform');
  });

  it('recognises only super_admin as a platform actor', () => {
    expect(isPlatformActor({ tenantId: TENANT, roles: ['super_admin'] })).toBe(true);
    expect(isPlatformActor({ tenantId: TENANT, roles: ['admin'] })).toBe(false);
    expect(isPlatformActor({ tenantId: TENANT, roles: [] })).toBe(false);
  });
});

describe('centralized patient file — content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePersonPatientIds as any).mockImplementation(async (id: string) => [id]);
    emptyRelations();
    (prisma.patient.findFirst as any).mockResolvedValue(patientRow());
  });

  it("keeps every clinical query inside the patient's own hospital", async () => {
    await getPatientFile(hospitalAdmin, PATIENT);

    for (const model of ['visit', 'admission', 'appointment', 'prescription', 'labOrder', 'imagingRequest', 'bill'] as const) {
      expect((prisma as any)[model].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ patientId: PATIENT, tenantId: TENANT }),
        }),
      );
    }
  });

  // Allergies belong to the human, not to one hospital's row — a reaction
  // recorded elsewhere still has to warn the clinician here.
  it('resolves allergies across every row that is the same person', async () => {
    (resolvePersonPatientIds as any).mockResolvedValue([PATIENT, 'patient-elsewhere']);
    (prisma.patientAllergy.findMany as any).mockResolvedValue([
      { id: 'a1', allergen: 'Penicillin', allergyType: 'drug', severity: 'severe', reaction: 'Rash' },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(prisma.patientAllergy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: { in: [PATIENT, 'patient-elsewhere'] } } }),
    );
    expect(file.safety.allergies[0].allergen).toBe('Penicillin');
  });

  it('lists other hospitals by name and MRN only, never their records', async () => {
    (resolvePersonPatientIds as any).mockResolvedValue([PATIENT, 'patient-elsewhere']);
    (prisma.patient.findMany as any).mockResolvedValue([
      {
        id: 'patient-elsewhere',
        mrn: 'MRN-9999',
        tenantId: OTHER_TENANT,
        createdAt: new Date('2025-05-05'),
        tenant: { name: 'Other Hospital' },
      },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(file.otherHospitals).toEqual([
      expect.objectContaining({ name: 'Other Hospital', mrn: 'MRN-9999' }),
    ]);
    // Nothing clinical leaks in with it.
    expect(Object.keys(file.otherHospitals[0])).toEqual(
      expect.arrayContaining(['patientId', 'tenantId', 'name', 'mrn', 'firstSeen']),
    );
    expect(file.otherHospitals[0]).not.toHaveProperty('visits');
    expect(file.otherHospitals[0]).not.toHaveProperty('diagnoses');
  });

  it('states the money once, ignoring cancelled bills', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      { id: 'b1', billNumber: 'INV-1', status: 'paid', totalAmount: 1000, amountPaid: 1000, balanceDue: 0, billDate: null, createdAt: new Date() },
      { id: 'b2', billNumber: 'INV-2', status: 'pending', totalAmount: 500, amountPaid: 100, balanceDue: 400, billDate: null, createdAt: new Date() },
      { id: 'b3', billNumber: 'INV-3', status: 'cancelled', totalAmount: 9999, amountPaid: 0, balanceDue: 9999, billDate: null, createdAt: new Date() },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(file.billing.totals).toEqual({
      billed: 1500,
      paid: 1100,
      outstanding: 400,
      billCount: 2,
    });
    // The cancelled bill is still listed — it just does not count toward money.
    expect(file.billing.bills).toHaveLength(3);
  });

  it('surfaces a live admission so the file says the patient is in a bed', async () => {
    (prisma.admission.findMany as any).mockResolvedValue([
      {
        id: 'adm-1',
        admissionDate: new Date('2026-08-01'),
        dischargeDate: null,
        status: 'ready_to_discharge',
        ward: { name: 'Ward A' },
        bed: { bedNumber: 'B-12' },
        doctor: { user: { firstName: 'A', lastName: 'Sharma' } },
      },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(file.status.currentlyAdmitted).toBe(true);
    expect(file.status.currentAdmission).toMatchObject({ ward: 'Ward A', bed: 'B-12' });
    expect(file.status.currentAdmission?.doctor).toBe('Dr. A Sharma');
  });

  it('does not call a discharged stay a live admission', async () => {
    (prisma.admission.findMany as any).mockResolvedValue([
      { id: 'adm-1', admissionDate: new Date(), dischargeDate: new Date(), status: 'discharged', ward: null, bed: null, doctor: null },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(file.status.currentlyAdmitted).toBe(false);
    expect(file.status.currentAdmission).toBe(null);
  });

  it('flags a document filed against another of this person’s rows', async () => {
    (resolvePersonPatientIds as any).mockResolvedValue([PATIENT, 'patient-elsewhere']);
    (prisma.patientDocument.findMany as any).mockResolvedValue([
      { id: 'd1', patientId: PATIENT, documentType: 'other', title: 'Ours', fileUrl: '/u/a', createdAt: new Date() },
      { id: 'd2', patientId: 'patient-elsewhere', documentType: 'other', title: 'Theirs', fileUrl: '/u/b', createdAt: new Date() },
    ]);

    const file = await getPatientFile(hospitalAdmin, PATIENT);

    expect(file.documents.find((d) => d.id === 'd1')?.fromAnotherHospital).toBe(false);
    expect(file.documents.find((d) => d.id === 'd2')?.fromAnotherHospital).toBe(true);
  });

  it('marks a TEMP- record as temporary', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(patientRow({ mrn: 'TEMP-000123' }));
    const file = await getPatientFile(hospitalAdmin, PATIENT);
    expect(file.patient.isTemporary).toBe(true);
  });
});

describe('platform patient directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.patient.count as any).mockResolvedValue(0);
  });

  it('searches across name, MRN, phone, email and ABHA', async () => {
    (prisma.patient.findMany as any).mockResolvedValue([]);

    await getPlatformPatientDirectory({ search: 'sample' });

    const where = (prisma.patient.findMany as any).mock.calls[0][0].where;
    const fields = where.OR.map((c: Record<string, unknown>) => Object.keys(c)[0]);
    expect(fields).toEqual(['firstName', 'lastName', 'mrn', 'phone', 'email', 'abhaNumber']);
  });

  it('applies no tenant filter unless one is asked for', async () => {
    (prisma.patient.findMany as any).mockResolvedValue([]);

    await getPlatformPatientDirectory({});
    expect((prisma.patient.findMany as any).mock.calls[0][0].where).toEqual({});

    await getPlatformPatientDirectory({ tenantId: OTHER_TENANT });
    expect((prisma.patient.findMany as any).mock.calls[1][0].where).toMatchObject({
      tenantId: OTHER_TENANT,
    });
  });

  it('names the hospital on every row, since the list spans all of them', async () => {
    (prisma.patient.findMany as any).mockResolvedValue([
      {
        id: 'p1', mrn: 'MRN-1', firstName: 'A', lastName: 'B', dateOfBirth: null, gender: 'male',
        phone: null, email: null, abhaNumber: null, isActive: true, createdAt: new Date(),
        tenantId: OTHER_TENANT, tenant: { name: 'Other Hospital' }, user: { id: 'u1' },
      },
    ]);

    const res = await getPlatformPatientDirectory({});

    expect(res.patients[0].hospital).toEqual({ id: OTHER_TENANT, name: 'Other Hospital' });
    expect(res.patients[0].hasPortalAccount).toBe(true);
  });
});
