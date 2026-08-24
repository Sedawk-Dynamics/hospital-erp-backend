import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getVisitById, updateVisit } from '../../../../src/modules/clinical/clinical.service';

// The nurse's intake complaint is kept apart from the doctor's own framing:
// the patient's words at the door and the clinician's reading of the problem
// are different statements, and one shared box meant whoever saved last
// replaced the other with nothing recording who said what.
//
// For that separation to be worth anything the doctor has to be able to SEE
// who recorded it, which needs the recorder resolved by name —
// `nurseChiefComplaintById` is a bare FK column with no Prisma relation, so it
// cannot be `include`d.

const TENANT = 'tenant-1';
const USER = 'user-1';

const VISIT = {
  id: 'visit-1',
  tenantId: TENANT,
  patientId: 'pat-1',
  status: 'active',
  chiefComplaint: 'Exertional angina, 3 days',
  nurseChiefComplaint: 'Chest pain since morning',
  nurseChiefComplaintById: 'nurse-1',
  nurseChiefComplaintAt: new Date('2026-08-24T04:30:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getVisitById — naming who recorded the intake complaint', () => {
  it('resolves the recorder so the doctor sees a name, not an id', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue(VISIT as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(
      { id: 'nurse-1', firstName: 'Asha', lastName: 'Rao' } as never,
    );

    const visit: any = await getVisitById(TENANT, 'visit-1');

    expect(visit.nurseChiefComplaintBy).toMatchObject({ firstName: 'Asha', lastName: 'Rao' });
    expect(visit.nurseChiefComplaint).toBe('Chest pain since morning');
    // The doctor's own complaint is a separate statement and survives alongside.
    expect(visit.chiefComplaint).toBe('Exertional angina, 3 days');
  });

  it('does not go looking for a recorder when nursing recorded nothing', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue(
      { ...VISIT, nurseChiefComplaint: null, nurseChiefComplaintById: null } as never,
    );

    const visit: any = await getVisitById(TENANT, 'visit-1');

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(visit.nurseChiefComplaintBy).toBeNull();
  });

  it('still returns the visit when the recorder account is gone', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue(VISIT as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);

    const visit: any = await getVisitById(TENANT, 'visit-1');

    expect(visit.nurseChiefComplaintBy).toBeNull();
    expect(visit.nurseChiefComplaint).toBe('Chest pain since morning');
  });
});

describe('updateVisit — the two complaints stay separate', () => {
  beforeEach(() => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue(VISIT as never);
    vi.mocked(prisma.visit.update).mockImplementation(
      (async (args: any) => ({ ...VISIT, ...args.data })) as never,
    );
  });

  it('writing the doctor’s complaint leaves the nurse’s untouched', async () => {
    await updateVisit(TENANT, 'visit-1', { chiefComplaint: 'Rewritten by the doctor' } as never, USER);

    const data = vi.mocked(prisma.visit.update).mock.calls[0][0].data as any;
    expect(data.chiefComplaint).toBe('Rewritten by the doctor');
    // This is what "Use this" relies on: the doctor rewrites their own field
    // and the intake record is not overwritten.
    expect(data.nurseChiefComplaint).toBeUndefined();
    expect(data.nurseChiefComplaintById).toBeUndefined();
  });

  it('stamps attribution server-side rather than trusting the caller', async () => {
    await updateVisit(
      TENANT,
      'visit-1',
      { nurseChiefComplaint: 'Chest pain since morning' } as never,
      USER,
    );

    const data = vi.mocked(prisma.visit.update).mock.calls[0][0].data as any;
    // The point of a separate field is knowing who recorded it, so the client
    // must not be able to claim someone else said it.
    expect(data.nurseChiefComplaintById).toBe(USER);
    expect(data.nurseChiefComplaintAt).toBeInstanceOf(Date);
  });

  it('clearing it clears the attribution too', async () => {
    await updateVisit(TENANT, 'visit-1', { nurseChiefComplaint: '' } as never, USER);

    const data = vi.mocked(prisma.visit.update).mock.calls[0][0].data as any;
    expect(data.nurseChiefComplaint).toBeNull();
    expect(data.nurseChiefComplaintById).toBeNull();
    expect(data.nurseChiefComplaintAt).toBeNull();
  });
});
