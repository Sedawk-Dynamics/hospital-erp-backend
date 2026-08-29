import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findOpenChargeBill, isAdvanceBucket, NOT_ADVANCE_BUCKET } from '../../../src/shared/charge-bill';

const TENANT = 'tenant-1';
const PATIENT = 'patient-1';
const ADMISSION = 'admission-1';

/**
 * A stand-in for the Prisma transaction client the ward charge paths run inside.
 * Records the `where` of every bill lookup so the test can assert what was
 * asked for, and answers from a queue of results.
 */
function fakeTx(results: Array<any>) {
  const calls: any[] = [];
  const tx = {
    bill: {
      findFirst: vi.fn(async (args: any) => {
        calls.push(args);
        return results.length ? results.shift() : null;
      }),
    },
  };
  return { tx, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAdvanceBucket', () => {
  it('recognises the advance holding account', () => {
    expect(isAdvanceBucket('ADV-3f2a1b9c-1755')).toBe(true);
  });

  it('does not mistake a real bill for it', () => {
    expect(isAdvanceBucket('IPW-20260824-0001')).toBe(false);
    expect(isAdvanceBucket('OTK-20260824-0001')).toBe(false);
    expect(isAdvanceBucket(null)).toBe(false);
    expect(isAdvanceBucket(undefined)).toBe(false);
  });
});

describe('findOpenChargeBill', () => {
  it('excludes the advance bucket from every lookup it makes', async () => {
    const { tx, calls } = fakeTx([null, null]);

    await findOpenChargeBill(tx, { tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION });

    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.where.billNumber).toEqual(NOT_ADVANCE_BUCKET.billNumber);
    }
  });

  it('prefers this stay’s running draft over the newest open bill', async () => {
    const ipDraft = { id: 'bill-ip', billNumber: 'IPW-20260824-0001', status: 'draft', admissionId: ADMISSION };
    const { tx, calls } = fakeTx([ipDraft]);

    const found = await findOpenChargeBill(tx, {
      tenantId: TENANT,
      patientId: PATIENT,
      admissionId: ADMISSION,
    });

    expect(found).toBe(ipDraft);
    // Answered on the first, admission-scoped lookup — the patient-wide
    // fallback is never reached.
    expect(calls.length).toBe(1);
    expect(calls[0].where.admissionId).toBe(ADMISSION);
    expect(calls[0].where.status).toBe('draft');
  });

  it('falls back to the patient’s newest open bill, unrestricted by admission', async () => {
    // A lab/imaging charge for an admitted patient can sit on an orphan bill
    // raised against the VISIT with no admissionId. The callers adopt that bill
    // onto the stay, so the fallback must still be able to see it.
    const orphan = { id: 'bill-visit', billNumber: 'BILL-0007', status: 'pending', admissionId: null };
    const { tx, calls } = fakeTx([null, orphan]);

    const found = await findOpenChargeBill(tx, {
      tenantId: TENANT,
      patientId: PATIENT,
      admissionId: ADMISSION,
    });

    expect(found).toBe(orphan);
    expect(calls[1].where.admissionId).toBeUndefined();
    expect(calls[1].where.patientId).toBe(PATIENT);
    expect(calls[1].where.status).toEqual({ in: ['draft', 'pending', 'partially_paid'] });
  });

  it('skips the admission lookup entirely for an out-patient', async () => {
    const { tx, calls } = fakeTx([null]);

    await findOpenChargeBill(tx, { tenantId: TENANT, patientId: PATIENT, admissionId: null });

    expect(calls.length).toBe(1);
    expect(calls[0].where.admissionId).toBeUndefined();
  });

  it('returns null rather than a bill when nothing is open', async () => {
    const { tx } = fakeTx([]);
    await expect(
      findOpenChargeBill(tx, { tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION }),
    ).resolves.toBeNull();
  });

  it('scopes every lookup to the tenant', async () => {
    const { tx, calls } = fakeTx([null, null]);
    await findOpenChargeBill(tx, { tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION });
    for (const c of calls) expect(c.where.tenantId).toBe(TENANT);
  });
});

/**
 * A readmission before the previous bill is settled leaves a patient with two
 * open admissions. This stay's ward doses were landing on the EARLIER stay's
 * bill: the preferred lookup found no draft for this admission, and the
 * fallback took the patient's newest open bill without caring whose stay it
 * belonged to. The callers could not correct it either — they retag a bill only
 * when its admissionId is null — so the charge stayed on the wrong stay
 * silently, understating this stay and inflating one already being settled.
 */
describe('a patient with two open stays', () => {
  it('will not charge this stay to another admission bill', async () => {
    const { tx, calls } = fakeTx([null, null]);
    await findOpenChargeBill(tx as never, {
      tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION,
    });
    // The fallback is the second lookup.
    expect(calls[1].where.OR).toEqual([{ admissionId: null }, { admissionId: ADMISSION }]);
  });

  it('still adopts an orphan bill raised against the visit', async () => {
    // The reason the fallback exists: a lab or imaging charge can sit on a bill
    // with no admission, and the caller tags it onto the stay. Narrowing that
    // away would open a second bill per dispense.
    const orphan = { id: 'bill-orphan', admissionId: null };
    const { tx } = fakeTx([null, orphan]);
    const found = await findOpenChargeBill(tx as never, {
      tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION,
    });
    expect(found).toBe(orphan);
  });

  it('prefers this stay own draft before any fallback', async () => {
    const own = { id: 'bill-own', admissionId: ADMISSION, status: 'draft' };
    const { tx, calls } = fakeTx([own]);
    const found = await findOpenChargeBill(tx as never, {
      tenantId: TENANT, patientId: PATIENT, admissionId: ADMISSION,
    });
    expect(found).toBe(own);
    expect(calls).toHaveLength(1);
  });

  it('leaves an outpatient charge unrestricted, since there is no stay to confuse', async () => {
    const { tx, calls } = fakeTx([null]);
    await findOpenChargeBill(tx as never, { tenantId: TENANT, patientId: PATIENT });
    expect(calls[0].where.OR).toBeUndefined();
  });
});
