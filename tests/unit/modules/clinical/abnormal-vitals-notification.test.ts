import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { recordVitals } from '../../../../src/modules/clinical/clinical.service';

// Nursing takes almost every reading in the hospital, and an out-of-range one
// reached the treating doctor nowhere — they found it by opening the chart.
// Recording a vital emitted no notification of any kind.
//
// Only ABNORMAL readings are sent: a bell that fires on every routine round is
// a bell people stop reading.

const TENANT = 'tenant-1';
const NURSE = 'user-nurse';
const DOCTOR_PROFILE = 'profile-doc';
const DOCTOR_USER = 'user-doc';
const PATIENT = 'pat-1';
const VISIT = 'visit-1';

function stage() {
  vi.mocked(prisma.visit.findFirst).mockResolvedValue({
    id: VISIT, tenantId: TENANT, patientId: PATIENT, doctorId: DOCTOR_PROFILE,
  } as never);
  vi.mocked(prisma.vital.create).mockResolvedValue({ id: 'vital-1' } as never);
  vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ userId: DOCTOR_USER } as never);
  vi.mocked(prisma.patient.findFirst).mockResolvedValue(
    { firstName: 'Asha', lastName: 'Rao', mrn: 'MRN-9' } as never,
  );
  vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);
}

const record = (vitals: Record<string, unknown>, actor = NURSE) =>
  recordVitals(TENANT, actor, ['nurse'], { patientId: PATIENT, visitId: VISIT, ...vitals } as never);

beforeEach(() => {
  vi.clearAllMocks();
  stage();
});

describe('recording a vital', () => {
  it('tells the treating doctor when a reading is out of range', async () => {
    await record({ pulseRate: 132, oxygenSaturation: 88 });

    expect(prisma.notification.createMany).toHaveBeenCalled();
    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      userId: DOCTOR_USER,
      tenantId: TENANT,
      notificationType: 'alert',
      referenceType: 'vital_abnormal',
      // The doctor needs that patient, not a worklist of everyone's vitals.
      referenceId: PATIENT,
    });
  });

  it('names the patient and what is wrong, so the bell is readable without opening it', async () => {
    await record({ pulseRate: 132 });

    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data[0].message).toContain('Asha Rao');
    expect(data[0].message).toContain('MRN-9');
    expect(data[0].message).toContain('Pulse 132 bpm (high)');
  });

  it('stays silent on a normal set', async () => {
    await record({
      bloodPressureSystolic: 120, bloodPressureDiastolic: 80,
      pulseRate: 72, temperature: 36.6, respiratoryRate: 16, oxygenSaturation: 98,
    });

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('does not tell a doctor about the reading they just took themselves', async () => {
    await record({ pulseRate: 132 }, DOCTOR_USER);

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('records the vital even when no doctor is assigned to the visit yet', async () => {
    vi.mocked(prisma.visit.findFirst).mockResolvedValue({
      id: VISIT, tenantId: TENANT, patientId: PATIENT, doctorId: null,
    } as never);

    // A walk-in whose doctor is assigned later must still be chartable.
    await expect(record({ pulseRate: 132 })).resolves.toMatchObject({ id: 'vital-1' });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('saves the vital even if the notification write fails', async () => {
    vi.mocked(prisma.notification.createMany).mockRejectedValue(new Error('db down') as never);

    // The reading is the record; the notice is not.
    await expect(record({ pulseRate: 132 })).resolves.toMatchObject({ id: 'vital-1' });
    expect(prisma.vital.create).toHaveBeenCalled();
  });
});
