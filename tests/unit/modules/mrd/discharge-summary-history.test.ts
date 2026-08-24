import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getDischargeSummariesForPatient } from '../../../../src/modules/mrd/mrd.service';

// "Past discharge summary is not available in the patient history view."
//
// The tab, the route and the permission were all fine — the data was there and
// the doctor could reach it. What was wrong is that every row was LABELLED
// "Not yet discharged", because the panel renders `dischargeDate` as each row's
// headline and every stored copy of it was null.
//
// The summary copies the date from the admission when it is written, but the
// summary IS the discharge gate: it is written while the patient is still
// admitted, so there is no date to copy. Nothing backfilled it. On the dev
// database that was 9 rows out of 9, while the admission itself carried a real
// date on 7 of them.

const TENANT = 'tenant-1';
const PATIENT = 'pat-1';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ds-1',
  status: 'published',
  admissionId: 'adm-1',
  admissionDate: null,
  dischargeDate: null,
  diagnosesSummary: 'Fever',
  createdAt: new Date('2026-07-13T00:00:00.000Z'),
  admission: {
    id: 'adm-1',
    admissionType: 'ip',
    admissionDate: new Date('2026-07-09T00:00:00.000Z'),
    dischargeDate: new Date('2026-07-11T09:40:00.000Z'),
  },
  doctor: { user: { firstName: 'Meera', lastName: 'Iyer' } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the discharge summaries a doctor sees in patient history', () => {
  it('falls back to the admission when the summary never got a discharge date', async () => {
    vi.mocked(prisma.dischargeSummary.findMany).mockResolvedValue([row()] as never);

    const [r] = await getDischargeSummariesForPatient(TENANT, PATIENT);

    // Without this the row's headline reads "Not yet discharged", which is
    // exactly how "no past discharge summary" looks to someone scanning a list.
    expect(r.dischargeDate).toEqual(new Date('2026-07-11T09:40:00.000Z'));
    expect(r.admissionDate).toEqual(new Date('2026-07-09T00:00:00.000Z'));
  });

  it('prefers the summary’s own date when it has one', async () => {
    const own = new Date('2026-07-12T00:00:00.000Z');
    vi.mocked(prisma.dischargeSummary.findMany).mockResolvedValue([
      row({ dischargeDate: own }),
    ] as never);

    const [r] = await getDischargeSummariesForPatient(TENANT, PATIENT);

    // The summary is the record; the admission is only the fallback.
    expect(r.dischargeDate).toEqual(own);
  });

  it('still says "not discharged" when the patient genuinely has not been', async () => {
    vi.mocked(prisma.dischargeSummary.findMany).mockResolvedValue([
      row({ admission: { id: 'adm-1', admissionType: 'ip', admissionDate: null, dischargeDate: null } }),
    ] as never);

    const [r] = await getDischargeSummariesForPatient(TENANT, PATIENT);

    // A stay in progress must not be dressed up as a completed one.
    expect(r.dischargeDate).toBeNull();
  });

  it('scopes through the admission, since the summary has no tenant column', async () => {
    vi.mocked(prisma.dischargeSummary.findMany).mockResolvedValue([] as never);

    await getDischargeSummariesForPatient(TENANT, PATIENT);

    const where = vi.mocked(prisma.dischargeSummary.findMany).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ patientId: PATIENT, admission: { tenantId: TENANT } });
  });

  it('carries enough to pick the right stay without opening each one', async () => {
    vi.mocked(prisma.dischargeSummary.findMany).mockResolvedValue([row()] as never);

    const [r] = await getDischargeSummariesForPatient(TENANT, PATIENT);

    expect(r).toMatchObject({
      status: 'published',
      admissionType: 'ip',
      diagnosesSummary: 'Fever',
      doctorName: 'Meera Iyer',
    });
  });
});
