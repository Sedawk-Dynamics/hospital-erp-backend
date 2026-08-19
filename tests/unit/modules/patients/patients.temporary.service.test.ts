import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createTemporaryPatient,
  mergeTemporaryPatient,
} from '../../../../src/modules/patients/patients.temporary.service';

// The service opens the encounter through the clinical module. Mocked so the
// test is about WHETHER an encounter is opened, not about how a visit row is
// built — that is clinical.service's own business and its own tests.
vi.mock('../../../../src/modules/clinical/clinical.service', () => ({
  createVisit: vi.fn(async () => ({ id: 'visit-1' })),
}));
import { createVisit } from '../../../../src/modules/clinical/clinical.service';

// Resolve-only account-holder lookup. Mocked so these tests are about whether
// the linkage is recorded, not about how a phone number resolves.
vi.mock('../../../../src/modules/patients/patients.service', () => ({
  findAccountHolderByPhone: vi.fn(async () => null),
}));
import { findAccountHolderByPhone } from '../../../../src/modules/patients/patients.service';

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
    (findAccountHolderByPhone as any).mockResolvedValue(null);
    (prisma.patient.count as any).mockResolvedValue(1);
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

describe('mergeTemporaryPatient', () => {
  const TEMP = 'temp-1';
  const TARGET = 'target-1';

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.patient.findFirst as any).mockImplementation(async ({ where }: any) =>
      where.id === TEMP
        ? { id: TEMP, mrn: 'TEMP-20260819-001' }
        : { id: TARGET, mrn: 'MRN-0001' },
    );
    (prisma.patient.update as any).mockResolvedValue({});
    (prisma.visit.findMany as any).mockResolvedValue([]);
    (prisma.visit.updateMany as any).mockResolvedValue({ count: 0 });
    // The transaction callback runs against the same mocked client.
    (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  });

  // D4's actual requirement: "connectable to the final identity WITHOUT LOSING
  // HISTORY". Every model carrying a non-unique patientId is repointed, which
  // is what carries the orders, prescriptions, imaging, vitals and bills across
  // with the patient. A model quietly dropped from that sweep is an episode
  // silently detached from the person it belongs to.
  it('repoints every patient-owned record onto the target', async () => {
    const seen: string[] = [];
    for (const key of ['visit', 'vital', 'prescription', 'labOrder', 'imagingRequest', 'bill']) {
      (prisma as any)[key].updateMany = vi.fn(async ({ where, data }: any) => {
        if (where.patientId === TEMP && data.patientId === TARGET) seen.push(key);
        return { count: 1 };
      });
    }

    await mergeTemporaryPatient('tenant-1', 'user-1', TEMP, TARGET);

    // The episode is exactly these: what was ordered, given, imaged and billed.
    expect(seen).toEqual(
      expect.arrayContaining(['visit', 'vital', 'prescription', 'labOrder', 'imagingRequest', 'bill']),
    );
  });

  // The temporary row is retired rather than deleted — it is the audit trail of
  // how the patient first arrived.
  it('retires the temporary record instead of deleting it', async () => {
    await mergeTemporaryPatient('tenant-1', 'user-1', TEMP, TARGET);

    const call = (prisma.patient.update as any).mock.calls.find(
      (c: any[]) => c[0]?.where?.id === TEMP,
    );
    expect(call).toBeTruthy();
    expect(call[0].data).toMatchObject({ isActive: false });
    expect(call[0].data.mrn).toMatch(/-MERGED$/);
    expect((prisma.patient as any).delete).not.toHaveBeenCalled();
  });

  // Reconciliation must never close an encounter that has care recorded on it.
  // Losing a record of care is the one outcome worse than a duplicate.
  it('never closes an encounter that carries care', async () => {
    // The care-bearing encounter is deliberately SECOND. Ordered first, a
    // "keep the oldest, close the rest" implementation would pass this test by
    // accident while still being wrong.
    (prisma.visit.findMany as any).mockResolvedValue([
      { id: 'v-empty', _count: { vitals: 0, diagnoses: 0, progressNotes: 0, nursingNotes: 0, prescriptions: 0, labOrders: 0, imagingRequests: 0, bills: 0 } },
      { id: 'v-care', _count: { vitals: 0, diagnoses: 0, progressNotes: 0, nursingNotes: 0, prescriptions: 1, labOrders: 2, imagingRequests: 0, bills: 1 } },
    ]);

    await mergeTemporaryPatient('tenant-1', 'user-1', TEMP, TARGET);

    const closed = (prisma.visit.updateMany as any).mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'completed',
    );
    expect(closed[0].where.id.in).toEqual(['v-empty']);
    expect(closed[0].where.id.in).not.toContain('v-care');
  });

  // Two encounters both carrying care cannot be resolved automatically — that
  // is a clinical decision. The merge must still succeed and say so.
  it('leaves two care-bearing encounters open and flags them', async () => {
    const withCare = (id: string) => ({
      id,
      _count: { vitals: 1, diagnoses: 0, progressNotes: 0, nursingNotes: 0, prescriptions: 0, labOrders: 0, imagingRequests: 0, bills: 0 },
    });
    (prisma.visit.findMany as any).mockResolvedValue([withCare('v-1'), withCare('v-2')]);

    const res = await mergeTemporaryPatient('tenant-1', 'user-1', TEMP, TARGET);

    expect(res.encounters.closed).toBe(0);
    expect(res.encounters.needsReview).toBe(2);
  });
});

describe('createTemporaryPatient — attender linkage', () => {
  const ACCOUNT = 'account-holder-1';

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.patient.findFirst as any).mockResolvedValue(null);
    (prisma.patient.findMany as any).mockResolvedValue([]);
    (prisma.patient.count as any).mockResolvedValue(1);
    (prisma.patient.create as any).mockResolvedValue({
      id: 'patient-1', mrn: 'TEMP-20260819-001', firstName: 'Temporary 1',
    });
    (createVisit as any).mockResolvedValue({ id: 'visit-1' });
    (findAccountHolderByPhone as any).mockResolvedValue(null);
  });

  // The reported bug: registering under an existing attender posted no linkage
  // to that attender's account. Patient.userId is what puts the record under
  // an account; without it the record belongs to nobody.
  it('files the record under the account that owns the phone', async () => {
    (findAccountHolderByPhone as any).mockResolvedValue(ACCOUNT);

    await createTemporaryPatient(TENANT, USER, { phone: '9876543210' } as never);

    const created = (prisma.patient.create as any).mock.calls[0][0].data;
    expect(created.userId).toBe(ACCOUNT);
    expect(created.relationship).toBe('other');
  });

  // The desk's explicit choice always wins over the inferred default.
  it('keeps the relationship the desk chose', async () => {
    (findAccountHolderByPhone as any).mockResolvedValue(ACCOUNT);

    await createTemporaryPatient(
      TENANT, USER, { phone: '9876543210', relationship: 'child' } as never,
    );

    expect((prisma.patient.create as any).mock.calls[0][0].data.relationship).toBe('child');
  });

  // An unidentified patient must never acquire a login account in their name
  // off the back of a relative's phone number. No match means no linkage.
  it('does not invent an account when the number matches nobody', async () => {
    (findAccountHolderByPhone as any).mockResolvedValue(null);

    await createTemporaryPatient(TENANT, USER, { phone: '9000000000' } as never);

    const created = (prisma.patient.create as any).mock.calls[0][0].data;
    expect(created.userId).toBeUndefined();
    expect(created.relationship).toBeUndefined();
  });

  // An explicit account id is honoured without needing a phone at all — the
  // desk picking the attender off screen.
  it('accepts an explicitly chosen account holder', async () => {
    await createTemporaryPatient(
      TENANT, USER, { userId: ACCOUNT, relationship: 'parent' } as never,
    );

    const created = (prisma.patient.create as any).mock.calls[0][0].data;
    expect(created.userId).toBe(ACCOUNT);
    expect(created.relationship).toBe('parent');
  });
});
