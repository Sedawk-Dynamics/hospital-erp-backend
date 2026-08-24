import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { cancelAppointmentAsPatient } from '../../../../src/modules/patient-portal/patient-portal.service';

// A booking or cancellation made in the portal used to reach the hospital
// silently — nothing told the doctor whose list had changed, and nothing told
// the desk that takes the payment and checks the patient in. Both found out by
// refreshing a screen, or did not.

const TENANT = 'tenant-1';
const USER = 'user-patient';
const APPT = 'appt-1';

const APPOINTMENT = {
  id: APPT,
  tenantId: TENANT,
  doctorId: 'profile-doc',
  appointmentDate: new Date('2026-08-28T04:30:00.000Z'),
  patient: { id: 'pat-1', mrn: 'MRN-9', firstName: 'Asha', lastName: 'Rao' },
  doctor: { user: { firstName: 'Meera', lastName: 'Iyer' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.patientHospitalConnection.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.patient.findMany).mockResolvedValue([{ id: 'pat-1' }] as never);
  vi.mocked(prisma.appointment.findFirst).mockResolvedValue(
    { id: APPT, status: 'booked', patientId: 'pat-1' } as never,
  );
  vi.mocked(prisma.appointment.update).mockResolvedValue(APPOINTMENT as never);
  vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ userId: 'user-doc' } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user-desk' }] as never);
  vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);
});

describe('a patient cancelling in the portal', () => {
  it('tells the doctor whose list changed and the desk', async () => {
    await cancelAppointmentAsPatient(USER, 'a@b.c', APPT);

    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data.map((d) => d.userId).sort()).toEqual(['user-desk', 'user-doc']);
    expect(data[0]).toMatchObject({ tenantId: TENANT, referenceType: 'appointment_cancelled', referenceId: APPT });
  });

  it('asks for the desk by role rather than guessing', async () => {
    await cancelAppointmentAsPatient(USER, 'a@b.c', APPT);

    const where = vi.mocked(prisma.user.findMany).mock.calls[0][0]!.where as any;
    expect(where.userRoles.some.role.name.in).toEqual(['front_desk', 'admin']);
    expect(where.isActive).toBe(true);
  });

  it('says who cancelled what, so a freed slot is legible in the bell', async () => {
    await cancelAppointmentAsPatient(USER, 'a@b.c', APPT);

    const data = vi.mocked(prisma.notification.createMany).mock.calls[0][0]!.data as any[];
    expect(data[0].message).toContain('Asha Rao (MRN-9)');
    expect(data[0].message).toContain('Dr. Meera Iyer');
  });

  it('resolves the doctor through their profile, not straight off doctorId', async () => {
    // Appointment.doctorId is a DoctorProfile id; notifications key on User.
    await cancelAppointmentAsPatient(USER, 'a@b.c', APPT);

    const where = vi.mocked(prisma.doctorProfile.findFirst).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject({ id: 'profile-doc', tenantId: TENANT });
  });

  it('still cancels when the notification cannot be written', async () => {
    vi.mocked(prisma.notification.createMany).mockRejectedValue(new Error('db down') as never);

    await expect(cancelAppointmentAsPatient(USER, 'a@b.c', APPT)).resolves.toMatchObject({ id: APPT });
  });

  it('refuses to cancel an appointment that is not the patient’s', async () => {
    vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null as never);

    await expect(cancelAppointmentAsPatient(USER, 'a@b.c', APPT)).rejects.toThrow(/not found/i);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
