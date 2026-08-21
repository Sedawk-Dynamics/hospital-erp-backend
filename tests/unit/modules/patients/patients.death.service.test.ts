import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  recordPatientDeath,
  clearPatientDeath,
} from '../../../../src/modules/patients/patients.death.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const PATIENT = 'patient-1';

/** $transaction here just runs the callback against the same mocked client. */
function runTransactionInline() {
  vi.mocked(prisma.$transaction).mockImplementation(((fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : fn) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  runTransactionInline();
  vi.mocked(prisma.visit.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.appointment.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.bed.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.patient.update).mockResolvedValue({} as never);
});

const alivePatient = { id: PATIENT, mrn: 'MRN-1', deceasedAt: null };

describe('recordPatientDeath', () => {
  // The case Test Report 3 actually asks about: someone brought in dead, or
  // dying before anyone gets round to admitting them. There is no admission to
  // close, and an admission status could never have expressed this.
  it('records a death for a patient who was never admitted', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce(null as never);

    const result = await recordPatientDeath(TENANT, PATIENT, USER, { note: 'Brought in dead' });

    expect(result.admissionClosed).toBeNull();
    expect(result.bedReleased).toBe(false);
    expect(prisma.patient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deceasedRecordedBy: USER, deceasedNote: 'Brought in dead' }),
      }),
    );
  });

  it('closes the stay as deceased rather than discharged, and frees the bed', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce({
      id: 'adm-1',
      bedId: 'bed-1',
    } as never);
    vi.mocked(prisma.admission.update).mockResolvedValue({} as never);
    vi.mocked(prisma.bed.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    const result = await recordPatientDeath(TENANT, PATIENT, USER, {});

    expect(result.admissionClosed).toBe('adm-1');
    expect(result.bedReleased).toBe(true);
    // 'discharged' would tell the family, the bill and every report that the
    // patient went home.
    expect(prisma.admission.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'deceased' }) }),
    );
  });

  it('cancels future appointments so the family is not reminded of one', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.appointment.updateMany).mockResolvedValueOnce({ count: 2 } as never);

    const result = await recordPatientDeath(TENANT, PATIENT, USER, {});

    expect(result.appointmentsCancelled).toBe(2);
    const call = vi.mocked(prisma.appointment.updateMany).mock.calls[0]![0]! as any;
    expect(call.data.status).toBe('cancelled');
    // Only bookings that have not happened — a completed visit is history.
    expect(call.where.status.in).not.toContain('completed');
  });

  it('never touches isActive', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce(null as never);

    await recordPatientDeath(TENANT, PATIENT, USER, {});

    // isActive is a soft-delete flag. The record must stay readable and
    // billable — the report is explicit that charges have to survive.
    const data = (vi.mocked(prisma.patient.update).mock.calls[0]![0]! as any).data;
    expect(data).not.toHaveProperty('isActive');
  });

  it('refuses to overwrite a death that is already recorded', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({
      ...alivePatient,
      deceasedAt: new Date('2026-01-02'),
    } as never);

    await expect(recordPatientDeath(TENANT, PATIENT, USER, {})).rejects.toThrow(/already recorded/i);
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  it('refuses a date of death in the future', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);

    await expect(
      recordPatientDeath(TENANT, PATIENT, USER, {
        deceasedAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    ).rejects.toThrow(/future/i);
  });

  it('refuses a patient outside this tenant', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(null as never);
    await expect(recordPatientDeath(TENANT, PATIENT, USER, {})).rejects.toThrow(/not found/i);
  });
});

describe('clearPatientDeath', () => {
  const deceased = { ...alivePatient, deceasedAt: new Date('2026-01-02'), deceasedNote: 'BID' };

  it('requires a reason, because this rewrites a legal fact', async () => {
    await expect(clearPatientDeath(TENANT, PATIENT, USER, '   ')).rejects.toThrow(/reason/i);
  });

  it('keeps what was recorded, and that it was withdrawn', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(deceased as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce(null as never);

    await clearPatientDeath(TENANT, PATIENT, USER, 'wrong record');

    const data = (vi.mocked(prisma.patient.update).mock.calls[0]![0]! as any).data;
    expect(data.deceasedAt).toBeNull();
    // The original note survives alongside the correction — both matter after.
    expect(data.deceasedNote).toContain('BID');
    expect(data.deceasedNote).toContain('wrong record');
  });

  it('reopens a stay that was closed as deceased', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(deceased as never);
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce({ id: 'adm-1' } as never);
    vi.mocked(prisma.admission.update).mockResolvedValue({} as never);

    const result = await clearPatientDeath(TENANT, PATIENT, USER, 'wrong record');

    expect(result.admissionReopened).toBe('adm-1');
    expect(prisma.admission.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'admitted' }) }),
    );
  });

  it('refuses when no death is recorded', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(alivePatient as never);
    await expect(clearPatientDeath(TENANT, PATIENT, USER, 'x')).rejects.toThrow(/no death/i);
  });
});
