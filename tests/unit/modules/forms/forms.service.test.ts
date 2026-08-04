import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createSubmission, listSubmissions } from '../../../../src/modules/forms/forms.service';

// Dynamic patient forms. Two behaviours matter most here:
//   • a submission is validated against the form's PUBLISHED schema server-side,
//     so a client cannot slip in an extra key or skip a required field;
//   • it binds to an encounter, and a temporary patient with no encounter yet
//     must still be documentable (visit_id is nullable).

const SCHEMA = {
  fields: [
    { id: 'f1', key: 'patient_name', label: 'Patient name', type: 'text', required: true, width: 'full' },
    { id: 'f2', key: 'pain_score', label: 'Pain score', type: 'number', required: false, width: 'full', min: 0, max: 10 },
  ],
};

const FORM = {
  id: 'form-1',
  tenantId: 'tenant-1',
  schema: SCHEMA,
  version: 3,
  isPublished: true,
  archivedAt: null as Date | null,
};

const TENANT = 'tenant-1';
const USER = 'user-1';

function stageForm(over: Partial<typeof FORM> = {}) {
  vi.mocked(prisma.hospitalForm.findFirst).mockResolvedValue({ ...FORM, ...over } as never);
}

function stageCreate() {
  vi.mocked(prisma.hospitalFormSubmission.create).mockImplementation(
    (async (args: any) => ({ id: 'sub-1', ...args.data })) as never,
  );
}

describe('forms: createSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stageCreate();
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as never);
  });

  describe('the form must be accepting submissions', () => {
    it('refuses a form that does not exist', async () => {
      vi.mocked(prisma.hospitalForm.findFirst).mockResolvedValue(null as never);
      await expect(
        createSubmission(TENANT, USER, 'nope', { patientId: 'pat-1', data: {} } as never),
      ).rejects.toThrow(/not found/i);
    });

    it('refuses an archived form', async () => {
      stageForm({ archivedAt: new Date() });
      await expect(
        createSubmission(TENANT, USER, 'form-1', { patientId: 'pat-1', data: {} } as never),
      ).rejects.toThrow(/archived/i);
    });

    it('refuses a draft form', async () => {
      stageForm({ isPublished: false });
      await expect(
        createSubmission(TENANT, USER, 'form-1', { patientId: 'pat-1', data: {} } as never),
      ).rejects.toThrow(/draft/i);
    });
  });

  describe('the payload is revalidated against the published schema', () => {
    beforeEach(() => stageForm());

    it('rejects a payload missing a required field', async () => {
      await expect(
        createSubmission(TENANT, USER, 'form-1', {
          patientId: 'pat-1', data: { pain_score: 4 },
        } as never),
      ).rejects.toThrow(/required/i);
    });

    it('rejects a number outside the field range', async () => {
      await expect(
        createSubmission(TENANT, USER, 'form-1', {
          patientId: 'pat-1', data: { patient_name: 'Asha', pain_score: 99 },
        } as never),
      ).rejects.toThrow(/10/);
    });

    it('accepts a valid payload', async () => {
      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', data: { patient_name: 'Asha', pain_score: 4 },
      } as never);
      expect(sub.data).toMatchObject({ patient_name: 'Asha', pain_score: 4 });
    });

    it('drops keys the schema does not declare', async () => {
      // A client must not be able to smuggle extra keys into a clinical record.
      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1',
        data: { patient_name: 'Asha', approved: true, injected: 'x' },
      } as never);
      expect(sub.data).not.toHaveProperty('approved');
      expect(sub.data).not.toHaveProperty('injected');
    });
  });

  describe('snapshotting', () => {
    beforeEach(() => stageForm());

    it('stores the schema and version as they were at submission time', async () => {
      // Old submissions must render as the nurse saw them, whatever the admin
      // edits into the form later.
      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', data: { patient_name: 'Asha' },
      } as never);
      expect(sub.formVersion).toBe(3);
      expect(sub.formSnapshot).toEqual(SCHEMA);
    });

    it('records who submitted it', async () => {
      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', data: { patient_name: 'Asha' },
      } as never);
      expect(sub.submittedById).toBe(USER);
    });
  });

  describe('binding to an encounter', () => {
    beforeEach(() => stageForm());

    it('uses the admission when one is named', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        id: 'adm-1', visitId: 'visit-1',
      } as never);

      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', admissionId: 'adm-1', data: { patient_name: 'Asha' },
      } as never);

      expect(sub.admissionId).toBe('adm-1');
      expect(sub.visitId).toBe('visit-1');
    });

    it('falls back to the live admission when no encounter is named', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        id: 'adm-live', visitId: 'visit-live',
      } as never);

      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', data: { patient_name: 'Asha' },
      } as never);

      expect(sub.admissionId).toBe('adm-live');
    });

    it('falls back to the latest visit when the patient is not admitted', async () => {
      vi.mocked(prisma.admission.findFirst).mockResolvedValue(null as never);
      vi.mocked(prisma.visit.findFirst).mockResolvedValue({
        id: 'visit-op', appointmentId: 'appt-1',
      } as never);

      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-1', data: { patient_name: 'Asha' },
      } as never);

      expect(sub.visitId).toBe('visit-op');
      expect(sub.appointmentId).toBe('appt-1');
    });

    it('still records a temporary patient who has no encounter at all', async () => {
      // A provisional TEMP- patient the front desk has not routed to OP or IP
      // yet must remain documentable — visit_id is nullable for exactly this.
      vi.mocked(prisma.admission.findFirst).mockResolvedValue(null as never);
      vi.mocked(prisma.visit.findFirst).mockResolvedValue(null as never);

      const sub: any = await createSubmission(TENANT, USER, 'form-1', {
        patientId: 'pat-temp', data: { patient_name: 'Temporary 1' },
      } as never);

      expect(sub.visitId).toBeNull();
      expect(sub.admissionId).toBeNull();
      expect(sub.patientId).toBe('pat-temp');
    });

    it('refuses an unknown patient', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as never);
      await expect(
        createSubmission(TENANT, USER, 'form-1', {
          patientId: 'ghost', data: { patient_name: 'Asha' },
        } as never),
      ).rejects.toThrow(/patient not found/i);
    });
  });
});

describe('forms: listSubmissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always scopes to the caller tenant', async () => {
    await listSubmissions(TENANT, { page: 1, limit: 20 } as never);
    expect(prisma.hospitalFormSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT }) }),
    );
  });

  it('narrows to one patient / admission when asked', async () => {
    await listSubmissions(TENANT, {
      page: 1, limit: 20, patientId: 'pat-1', admissionId: 'adm-1',
    } as never);
    expect(prisma.hospitalFormSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ patientId: 'pat-1', admissionId: 'adm-1' }),
      }),
    );
  });
});
