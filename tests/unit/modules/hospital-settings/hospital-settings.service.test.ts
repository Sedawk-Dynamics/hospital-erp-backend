import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getPatientVisitStatus,
  getRegistrationFeeSettings,
  updateRegistrationFeeSettings,
} from '../../../../src/modules/hospital-settings/hospital-settings.service';

const TENANT = 'tenant-1';
const PATIENT = 'patient-1';

/** Nothing on record anywhere unless a test says otherwise. */
function noHistory() {
  (prisma.patient.findFirst as any).mockResolvedValue({ id: PATIENT });
  (prisma.appointment.findMany as any).mockResolvedValue([]);
  (prisma.appointment.count as any).mockResolvedValue(0);
  (prisma.visit.findMany as any).mockResolvedValue([]);
  (prisma.visit.count as any).mockResolvedValue(0);
  (prisma.admission.findMany as any).mockResolvedValue([]);
  (prisma.admission.count as any).mockResolvedValue(0);
  (prisma.billItem.findFirst as any).mockResolvedValue(null);
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { registrationFee: { enabled: true, amount: 200 } },
  });
}

describe('registration fee settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is off until the hospital sets one', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: {} });
    expect(await getRegistrationFeeSettings(TENANT)).toMatchObject({ enabled: false, amount: 0 });
  });

  // Billing must never fail because a settings read did.
  it('falls back to charging nothing when the settings cannot be read', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue(null);
    expect(await getRegistrationFeeSettings(TENANT)).toMatchObject({ enabled: false });
  });

  it('writes under its own key and leaves the rest of themeConfig alone', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({
      themeConfig: { pdf: { name: 'Hospital' }, pdfTemplates: { __all__: {} } },
    });

    await updateRegistrationFeeSettings(TENANT, { enabled: true, amount: 300 });

    const data = (prisma.tenant.update as any).mock.calls[0][0].data.themeConfig;
    expect(data.pdf).toEqual({ name: 'Hospital' });
    expect(data.pdfTemplates).toEqual({ __all__: {} });
    expect(data.registrationFee).toMatchObject({ enabled: true, amount: 300 });
  });
});

describe('getPatientVisitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noHistory();
  });

  it('calls a patient with no history here a first visit', async () => {
    const s = await getPatientVisitStatus(TENANT, PATIENT);
    expect(s.isFirstVisit).toBe(true);
    expect(s.lastVisitAt).toBe(null);
    expect(s.suggestCharge).toBe(true);
  });

  // The whole point of the rule: "first time at THIS hospital", not "new to the
  // platform". Every query is tenant-scoped and keyed on the per-hospital
  // Patient row, so a regular at another hospital is still new here.
  it('scopes every lookup to this hospital', async () => {
    await getPatientVisitStatus(TENANT, PATIENT);
    for (const model of ['appointment', 'visit', 'admission'] as const) {
      expect((prisma as any)[model].count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, patientId: PATIENT }) }),
      );
    }
  });

  it('is not a first visit once anything is on record here', async () => {
    (prisma.visit.count as any).mockResolvedValue(2);
    (prisma.visit.findMany as any).mockResolvedValue([{ visitDate: new Date('2026-03-01') }]);

    const s = await getPatientVisitStatus(TENANT, PATIENT);

    expect(s.isFirstVisit).toBe(false);
    expect(s.priorEncounters).toBe(2);
    expect(s.lastVisitKind).toBe('visit');
    expect(s.suggestCharge).toBe(false);
  });

  it('reports the most recent encounter of any kind as the last visit', async () => {
    (prisma.appointment.count as any).mockResolvedValue(1);
    (prisma.appointment.findMany as any).mockResolvedValue([
      { appointmentDate: new Date('2026-01-10') },
    ]);
    (prisma.admission.count as any).mockResolvedValue(1);
    (prisma.admission.findMany as any).mockResolvedValue([
      { admissionDate: new Date('2026-06-20') },
    ]);
    // An admission ALWAYS has a visit — `Admission.visitId` is a required
    // unique FK — so a stay implies a Visit row. Mocking one without the other
    // describes a database state that cannot exist.
    (prisma.visit.count as any).mockResolvedValue(1);

    const s = await getPatientVisitStatus(TENANT, PATIENT);

    expect(s.lastVisitKind).toBe('admission');
    expect(s.lastVisitAt).toBe(new Date('2026-06-20').toISOString());
    // Two attendances: the January appointment and the June stay. The stay's
    // Visit row IS the stay, so it is not counted again as an admission.
    expect(s.priorEncounters).toBe(2);
  });

  it('counts one attendance once, however many rows it left behind', async () => {
    // The bug this replaces: an OPD attendance leaves an Appointment AND the
    // Visit the desk opens from it, and an inpatient stay leaves an Admission
    // AND its Visit. Adding the three counts told the desk a patient who had
    // been in ten times had been in fifteen.
    (prisma.appointment.count as any)
      .mockResolvedValueOnce(7) // kept appointments
      .mockResolvedValueOnce(4); // ...of which 4 never became a visit
    (prisma.visit.count as any).mockResolvedValue(6);
    (prisma.admission.count as any).mockResolvedValue(2);

    const s = await getPatientVisitStatus(TENANT, PATIENT);

    expect(s.priorEncounters).toBe(10); // 6 visits + 4 appointments with none
    expect(s.isFirstVisit).toBe(false);
  });

  it('does not call a future booking the patient’s last visit', async () => {
    // A booking is not an attendance. Unbounded, an appointment made for next
    // month came back as "Last visit" — a date in the future on a line saying
    // when the patient was last here.
    await getPatientVisitStatus(TENANT, PATIENT);

    const where = (prisma.appointment.findMany as any).mock.calls[0][0].where;
    expect(where.appointmentDate.lte).toBeInstanceOf(Date);
  });

  // Booking an appointment and then asking "is this their first visit?" must
  // not count the appointment being booked as prior history.
  it('excludes the appointment being billed', async () => {
    await getPatientVisitStatus(TENANT, PATIENT, { excludeAppointmentId: 'appt-1' });
    expect(prisma.appointment.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'appt-1' } }) }),
    );
  });

  it('does not count a cancelled or no-show appointment as having attended', async () => {
    await getPatientVisitStatus(TENANT, PATIENT);
    const where = (prisma.appointment.count as any).mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ['cancelled', 'no_show'] });
  });

  // Found by reference type, so renaming the fee or changing its amount cannot
  // make an already-charged patient look uncharged.
  it('spots a fee that was already taken, and stops suggesting it', async () => {
    (prisma.billItem.findFirst as any).mockResolvedValue({ createdAt: new Date('2026-02-02') });

    const s = await getPatientVisitStatus(TENANT, PATIENT);

    expect(s.registrationFeeCharged).toBe(true);
    expect(s.registrationFeeChargedAt).toBe(new Date('2026-02-02').toISOString());
    expect(s.suggestCharge).toBe(false);
    expect((prisma.billItem.findFirst as any).mock.calls[0][0].where).toMatchObject({
      referenceType: 'registration',
    });
  });

  it('ignores a fee on a cancelled bill', async () => {
    await getPatientVisitStatus(TENANT, PATIENT);
    const where = (prisma.billItem.findFirst as any).mock.calls[0][0].where;
    expect(where.bill.status).toEqual({ not: 'cancelled' });
  });

  it('does not suggest a charge when the hospital has the fee switched off', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: {} });
    const s = await getPatientVisitStatus(TENANT, PATIENT);
    expect(s.isFirstVisit).toBe(true);
    expect(s.suggestCharge).toBe(false);
  });

  it('refuses a patient from another hospital', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(null);
    await expect(getPatientVisitStatus(TENANT, PATIENT)).rejects.toThrow('Patient not found');
  });
});
