import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createTemporaryPatient } from '../../../../src/modules/patients/patients.temporary.service';

// The service opens the encounter through the clinical module. Mocked so the
// test is about WHETHER an encounter is opened, not about how a visit row is
// built — that is clinical.service's own business and its own tests.
vi.mock('../../../../src/modules/clinical/clinical.service', () => ({
  createVisit: vi.fn(async () => ({ id: 'visit-1' })),
}));
import { createVisit } from '../../../../src/modules/clinical/clinical.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

describe('createTemporaryPatient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No existing TEMP- rows, so the MRN generator starts at 001.
    (prisma.patient.findFirst as any).mockResolvedValue(null);
    (prisma.patient.findMany as any).mockResolvedValue([]);
    (prisma.patient.create as any).mockResolvedValue({
      id: 'patient-1',
      mrn: 'TEMP-20260819-001',
      firstName: 'Temporary 1',
      lastName: null,
    });
    (createVisit as any).mockResolvedValue({ id: 'visit-1' });
  });

  // THE point of the temporary-patient flow. LabOrder.visitId,
  // Prescription.visitId and ImagingRequest.visitId are all non-null, so with
  // no encounter the lab cannot raise an order, the doctor cannot prescribe and
  // radiology cannot book a study. Without this the patient is unreachable by
  // every department until somebody admits them — which is exactly what QA
  // reported.
  it('opens an encounter so the departments have something to attach work to', async () => {
    const result = await createTemporaryPatient(TENANT, USER, {} as never);

    expect(createVisit).toHaveBeenCalledTimes(1);
    const [, visitArg] = (createVisit as any).mock.calls[0];
    expect(visitArg).toMatchObject({ patientId: 'patient-1', visitType: 'op' });
    expect(result).toMatchObject({ visitId: 'visit-1' });
  });

  // The encounter carries no doctor on purpose: at the door of an emergency
  // nobody knows which consultant will take the patient. An appointment or a
  // direct admission adopts it later and fills the doctor in.
  it('leaves the encounter unassigned — no doctor is known yet', async () => {
    await createTemporaryPatient(TENANT, USER, {} as never);

    const [, visitArg] = (createVisit as any).mock.calls[0];
    expect(visitArg.doctorId).toBeUndefined();
  });

  // Registration must survive a failure to open the encounter. A patient at the
  // door with a half-made record beats a registration that refused; the caller
  // gets visitId: null and can retry.
  it('still registers the patient when the encounter cannot be opened', async () => {
    (createVisit as any).mockRejectedValue(new Error('db down'));

    const result = await createTemporaryPatient(TENANT, USER, {} as never);

    expect(result).toMatchObject({ id: 'patient-1', visitId: null });
  });

  // An unnamed arrival is the normal case, not an edge case — the whole flow
  // exists for the patient nobody can identify yet.
  it('accepts a completely anonymous arrival', async () => {
    await createTemporaryPatient(TENANT, USER, {} as never);

    const created = (prisma.patient.create as any).mock.calls[0][0].data;
    expect(created.firstName).toMatch(/^Temporary /);
    expect(created.mrn).toMatch(/^TEMP-/);
  });
});
