import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as appointmentsService from '../../../../src/modules/appointments/appointments.service';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';

// NOTE: do NOT add `vi.mock('.../config/database')` here. A bare vi.mock is
// an AUTOMOCK and overrides the working factory mock in tests/setup.ts,
// which is what made every prisma call in this file undefined.


// Booking refuses a date in the past, so the fixture date must stay in the
// future. A hardcoded one silently rots the moment that day passes — which is
// exactly what took these tests down.
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const FUTURE_DATE_STR = FUTURE_DATE.toISOString().slice(0, 10);

describe('AppointmentsService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ---------------------------------------------------------------------------
  // createDoctorProfile
  // ---------------------------------------------------------------------------
  describe('createDoctorProfile', () => {
    const profileInput = {
      userId: 'user-1',
      departmentId: 'dept-1',
      specialization: 'Cardiology',
      qualification: 'MD',
      registrationNumber: 'REG-001',
      consultationFee: 500,
      experience: 10,
      isActive: true,
    };

    it('should create a doctor profile linked to a user', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.doctorProfile.create).mockResolvedValue({
        id: 'doc-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        specialization: 'Cardiology',
        user: { firstName: 'Dr', lastName: 'Smith', email: 'dr@test.com' },
        department: { id: 'dept-1', name: 'Cardiology' },
      } as any);

      const result = await appointmentsService.createDoctorProfile('tenant-1', profileInput);

      expect(result).toBeDefined();
      expect(result.id).toBe('doc-1');
      expect(prisma.doctorProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            tenantId: 'tenant-1',
            specialization: 'Cardiology',
          }),
        }),
      );
    });

    it('should throw notFound if user does not exist in tenant', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.createDoctorProfile('tenant-1', profileInput),
      ).rejects.toThrow(AppError);
    });

    it('should throw conflict if doctor profile already exists for the user', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'existing-doc' } as any);

      await expect(
        appointmentsService.createDoctorProfile('tenant-1', profileInput),
      ).rejects.toThrow(AppError);
    });
  });

  // ---------------------------------------------------------------------------
  // getDoctorProfiles
  // ---------------------------------------------------------------------------
  describe('getDoctorProfiles', () => {
    it('should return paginated list of doctor profiles', async () => {
      vi.mocked(prisma.doctorProfile.findMany).mockResolvedValue([
        { id: 'doc-1', specialization: 'Cardiology', user: { firstName: 'Dr', lastName: 'Smith' } },
        { id: 'doc-2', specialization: 'Neurology', user: { firstName: 'Dr', lastName: 'Jones' } },
      ] as any);
      vi.mocked(prisma.doctorProfile.count).mockResolvedValue(2);

      const result = await appointmentsService.getDoctorProfiles('tenant-1', {});

      expect(result.doctors).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should filter by department', async () => {
      vi.mocked(prisma.doctorProfile.findMany).mockResolvedValue([]);
      vi.mocked(prisma.doctorProfile.count).mockResolvedValue(0);

      await appointmentsService.getDoctorProfiles('tenant-1', { departmentId: 'dept-1' } as any);

      expect(prisma.doctorProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1', departmentId: 'dept-1' }),
        }),
      );
    });

    it('should filter by specialization search', async () => {
      vi.mocked(prisma.doctorProfile.findMany).mockResolvedValue([]);
      vi.mocked(prisma.doctorProfile.count).mockResolvedValue(0);

      await appointmentsService.getDoctorProfiles('tenant-1', { specialization: 'Cardio' } as any);

      expect(prisma.doctorProfile.findMany).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getAvailableSlots
  // ---------------------------------------------------------------------------
  describe('getAvailableSlots', () => {
    it('should return empty slots when doctor has no schedule for the day', async () => {
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.doctorSchedule.findFirst).mockResolvedValue(null);

      const result = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-03-09');

      expect(result.slots).toEqual([]);
      expect(result.message).toBe('Doctor does not have a schedule for this day');
    });

    it('should throw notFound if doctor does not exist', async () => {
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.getAvailableSlots('tenant-1', 'nonexistent', '2026-03-09'),
      ).rejects.toThrow(AppError);
    });

    it('should return empty slots when doctor is on full-day leave', async () => {
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.doctorSchedule.findMany).mockResolvedValue([{
        id: 'sched-1', dayOfWeek: 1, startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T17:00:00Z'), slotDurationMinutes: 30,
      }] as any);
      vi.mocked(prisma.doctorLeave.findMany).mockResolvedValue([{
        id: 'leave-1', doctorId: 'doc-1', startTime: null, endTime: null,
      }] as any);

      const result = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-03-09');

      expect(result.slots).toEqual([]);
      expect(result.message).toBe('Doctor is on leave on this date');
    });

    it('should generate time slots and mark booked ones as unavailable', async () => {
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.doctorSchedule.findMany).mockResolvedValue([{
        id: 'sched-1', dayOfWeek: 1,
        startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T11:00:00Z'),
        slotDurationMinutes: 30,
      }] as any);
      vi.mocked(prisma.doctorLeave.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.appointment.findMany).mockResolvedValue([
        {
          startTime: new Date('1970-01-01T09:00:00Z'),
          endTime: new Date('1970-01-01T09:30:00Z'),
        },
      ] as any);

      // A future date — a past one has every slot marked past (gap 330).
      const result = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', FUTURE_DATE_STR);

      // 09:00-11:00 with 30 min slots = 4 slots
      expect(result.slots).toHaveLength(4);
      // First slot should be unavailable (booked)
      expect(result.slots[0].available).toBe(false);
      expect(result.slots[0].startTime).toBe('09:00');
      // Second slot should be available
      expect(result.slots[1].available).toBe(true);
      expect(result.slots[1].startTime).toBe('09:30');
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 330: "now" is IST. The shift is still running at 13:30 IST (08:00 UTC);
  // a server comparing in UTC either disabled the rest of the day or offered
  // slots that had already ended.
  // ---------------------------------------------------------------------------
  describe('slots and booking against the IST clock', () => {
    const shift = () => {
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1', isAvailable: true } as any);
      vi.mocked(prisma.doctorScheduleOverride.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.doctorSchedule.findMany).mockResolvedValue([{
        id: 'sched-1', dayOfWeek: 4,
        startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T17:00:00Z'),
        slotDurationMinutes: 30,
      }] as any);
      vi.mocked(prisma.doctorLeave.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Thu 19 Nov 2026, 13:30 IST.
      vi.setSystemTime(new Date('2026-11-19T08:00:00.000Z'));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('disables only the slots that have ended in IST today', async () => {
      shift();
      const { slots } = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-11-19');
      const byStart = Object.fromEntries(slots.map((sl) => [sl.startTime, sl]));

      expect(byStart['13:00']).toMatchObject({ available: false, past: true }); // ended 13:30
      expect(byStart['13:30']).toMatchObject({ available: true }); // starts now
      expect(byStart['16:30']).toMatchObject({ available: true });
      expect(slots.filter((sl) => sl.available)).toHaveLength(7); // 13:30 → 17:00
    });

    it('reads the weekday from the calendar date, not the host clock', async () => {
      shift();
      await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-11-19');
      expect(vi.mocked(prisma.doctorSchedule.findMany).mock.calls[0]![0]!.where).toMatchObject({ dayOfWeek: 4 });
    });

    it('marks every slot past for an earlier day and none for a later one', async () => {
      shift();
      const before = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-11-18');
      expect(before.slots.every((sl) => sl.past && !sl.available)).toBe(true);
      const after = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-11-20');
      expect(after.slots.every((sl) => !sl.past && sl.available)).toBe(true);
    });

    it('still treats it as today between 00:00 and 05:30 IST', async () => {
      // 00:30 IST on the 20th is 19:00 UTC on the 19th.
      vi.setSystemTime(new Date('2026-11-19T19:00:00.000Z'));
      shift();
      const { slots } = await appointmentsService.getAvailableSlots('tenant-1', 'doc-1', '2026-11-20');
      expect(slots.every((sl) => sl.available)).toBe(true);
    });

    const booking = (over: Record<string, unknown> = {}) => ({
      patientId: 'patient-1', doctorId: 'doc-1', appointmentDate: '2026-11-19',
      startTime: '13:30', endTime: '14:00', type: 'consultation' as const, priority: 'normal' as const,
      ...over,
    });

    const bookable = () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1', isAvailable: true } as any);
      vi.mocked(prisma.doctorLeave.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.appointment.create).mockImplementation((async (args: any) => ({ id: 'apt-1', ...args.data })) as any);
    };

    it('books a slot later today', async () => {
      bookable();
      await expect(appointmentsService.bookAppointment('tenant-1', booking())).resolves.toBeDefined();
    });

    it('refuses a slot that ended earlier today', async () => {
      bookable();
      await expect(
        appointmentsService.bookAppointment('tenant-1', booking({ startTime: '13:00', endTime: '13:30' })),
      ).rejects.toThrow('already ended');
    });

    it('refuses yesterday in IST even while the UTC date has not rolled over', async () => {
      vi.setSystemTime(new Date('2026-11-19T19:00:00.000Z')); // 00:30 IST on the 20th
      bookable();
      await expect(
        appointmentsService.bookAppointment('tenant-1', booking({ startTime: '15:00', endTime: '15:30' })),
      ).rejects.toThrow('in the past');
    });

    // Gap 333: a booked follow-up is a return visit, whatever the history says.
    it('stores a follow-up as a revisit', async () => {
      bookable();
      await appointmentsService.bookAppointment('tenant-1', booking({ type: 'follow_up' }));
      const data = vi.mocked(prisma.appointment.create).mock.calls[0]![0]!.data as any;
      expect(data.visitType).toBe('revisit');
      expect(data.consultationType).toBe('follow_up');
    });
  });

  // ---------------------------------------------------------------------------
  // bookAppointment
  // ---------------------------------------------------------------------------
  describe('bookAppointment', () => {
    const bookingInput = {
      patientId: 'patient-1',
      doctorId: 'doc-1',
      appointmentDate: FUTURE_DATE_STR,
      startTime: '09:00',
      endTime: '09:30',
      type: 'consultation' as const,
      priority: 'normal' as const,
      reason: 'General checkup',
    };

    it('should book an appointment successfully', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1', isAvailable: true } as any);
      vi.mocked(prisma.doctorLeave.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null); // no conflicts
      vi.mocked(prisma.appointment.create).mockResolvedValue({
        id: 'apt-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        doctorId: 'doc-1',
        status: 'booked',
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'John', lastName: 'Doe', phone: '123' },
        doctor: { user: { firstName: 'Dr', lastName: 'Smith' }, department: { id: 'dept-1', name: 'Cardiology' } },
      } as any);

      const result = await appointmentsService.bookAppointment('tenant-1', bookingInput);

      expect(result).toBeDefined();
      expect(result.status).toBe('booked');
      expect(prisma.appointment.create).toHaveBeenCalled();
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.bookAppointment('tenant-1', bookingInput),
      ).rejects.toThrow(AppError);
    });

    it('should throw notFound if doctor does not exist or is inactive', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.bookAppointment('tenant-1', bookingInput),
      ).rejects.toThrow(AppError);
    });

    it('should throw badRequest if doctor is on full-day leave', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1', isAvailable: true } as any);
      vi.mocked(prisma.doctorLeave.findFirst).mockResolvedValue({
        id: 'leave-1', startTime: null, endTime: null,
      } as any);

      await expect(
        appointmentsService.bookAppointment('tenant-1', bookingInput),
      ).rejects.toThrow(AppError);
    });

    it('should throw conflict if time slot is already booked', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1', isAvailable: true } as any);
      vi.mocked(prisma.doctorLeave.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({ id: 'existing-apt' } as any);

      await expect(
        appointmentsService.bookAppointment('tenant-1', bookingInput),
      ).rejects.toThrow(AppError);
    });
  });

  // ---------------------------------------------------------------------------
  // updateAppointmentStatus
  // ---------------------------------------------------------------------------
  describe('updateAppointmentStatus', () => {
    it('should update status from booked to confirmed', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'booked',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'confirmed',
        patient: { id: 'p1', mrn: 'MRN-001', firstName: 'John', lastName: 'Doe' },
        doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      const result = await appointmentsService.updateAppointmentStatus(
        'tenant-1', 'apt-1', { status: 'confirmed' }, 'user-1',
      );

      expect(result.status).toBe('confirmed');
    });

    it('should update status from confirmed to checked_in', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'confirmed',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'checked_in',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      const result = await appointmentsService.updateAppointmentStatus(
        'tenant-1', 'apt-1', { status: 'checked_in' }, 'user-1',
      );

      expect(result.status).toBe('checked_in');
    });

    it('should update status from checked_in to in_consultation', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'checked_in',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'in_consultation',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      const result = await appointmentsService.updateAppointmentStatus(
        'tenant-1', 'apt-1', { status: 'in_consultation' }, 'user-1',
      );

      expect(result.status).toBe('in_consultation');
    });

    it('should update status from in_consultation to completed', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'in_consultation',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'completed',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      const result = await appointmentsService.updateAppointmentStatus(
        'tenant-1', 'apt-1', { status: 'completed' }, 'user-1',
      );

      expect(result.status).toBe('completed');
    });

    it('should throw notFound if appointment does not exist', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.updateAppointmentStatus(
          'tenant-1', 'nonexistent', { status: 'confirmed' }, 'user-1',
        ),
      ).rejects.toThrow(AppError);
    });

    it('should throw badRequest for invalid status transition (booked -> completed)', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'booked',
      } as any);

      await expect(
        appointmentsService.updateAppointmentStatus(
          'tenant-1', 'apt-1', { status: 'completed' }, 'user-1',
        ),
      ).rejects.toThrow(AppError);
    });

    it('should throw badRequest for invalid transition (completed -> booked)', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'completed',
      } as any);

      await expect(
        appointmentsService.updateAppointmentStatus(
          'tenant-1', 'apt-1', { status: 'booked' }, 'user-1',
        ),
      ).rejects.toThrow(AppError);
    });

    it('should set cancellation reason and cancelledBy when cancelling', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'booked',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'cancelled',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      await appointmentsService.updateAppointmentStatus(
        'tenant-1', 'apt-1',
        { status: 'cancelled', cancellationReason: 'Patient requested' },
        'user-1',
      );

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'cancelled',
            cancellationReason: 'Patient requested',
            cancelledBy: 'user-1',
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // cancelAppointment
  // ---------------------------------------------------------------------------
  describe('cancelAppointment', () => {
    it('should cancel appointment with reason', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'booked',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'cancelled',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      const result = await appointmentsService.cancelAppointment(
        'tenant-1', 'apt-1', 'user-1', 'No longer needed',
      );

      expect(result.status).toBe('cancelled');
    });

    it('should use default reason when none is provided', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'confirmed',
      } as any);
      vi.mocked(prisma.appointment.update).mockResolvedValue({
        id: 'apt-1', status: 'cancelled',
        patient: { id: 'p1' }, doctor: { user: { firstName: 'Dr', lastName: 'Smith' } },
      } as any);

      await appointmentsService.cancelAppointment('tenant-1', 'apt-1', 'user-1');

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationReason: 'Cancelled by user',
          }),
        }),
      );
    });

    it('should throw error when trying to cancel an already completed appointment', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', status: 'completed',
      } as any);

      await expect(
        appointmentsService.cancelAppointment('tenant-1', 'apt-1', 'user-1', 'Too late'),
      ).rejects.toThrow(AppError);
    });
  });

  // ---------------------------------------------------------------------------
  // generateQueueToken
  // ---------------------------------------------------------------------------
  describe('generateQueueToken', () => {
    it('should create a sequential queue token', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', doctorId: 'doc-1', patientId: 'patient-1',
        appointmentDate: FUTURE_DATE,
        doctor: { id: 'doc-1' },
      } as any);
      vi.mocked(prisma.queueToken.findFirst)
        .mockResolvedValueOnce(null)  // no existing token for this appointment
        .mockResolvedValueOnce(null); // no previous tokens today
      vi.mocked(prisma.queueToken.create).mockResolvedValue({
        id: 'qt-1', tokenNumber: '001', appointmentId: 'apt-1',
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'John', lastName: 'Doe' },
      } as any);

      const result = await appointmentsService.generateQueueToken('tenant-1', 'apt-1');

      expect(result).toBeDefined();
      expect(result.tokenNumber).toBe('001');
    });

    it('should increment token number from last token', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-2', doctorId: 'doc-1', patientId: 'patient-2',
        appointmentDate: FUTURE_DATE,
        doctor: { id: 'doc-1' },
      } as any);
      vi.mocked(prisma.queueToken.findFirst)
        .mockResolvedValueOnce(null) // no existing token for this appointment
        .mockResolvedValueOnce({ tokenNumber: '005' } as any); // last token today
      vi.mocked(prisma.queueToken.create).mockResolvedValue({
        id: 'qt-2', tokenNumber: '006', appointmentId: 'apt-2',
        patient: { id: 'patient-2', mrn: 'MRN-002', firstName: 'Jane', lastName: 'Doe' },
      } as any);

      const result = await appointmentsService.generateQueueToken('tenant-1', 'apt-2');

      expect(result.tokenNumber).toBe('006');
      // Verify the create call used the incremented token number
      expect(prisma.queueToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tokenNumber: '006' }),
        }),
      );
    });

    it('should throw notFound if appointment does not exist', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null);

      await expect(
        appointmentsService.generateQueueToken('tenant-1', 'nonexistent'),
      ).rejects.toThrow(AppError);
    });

    it('should throw conflict if token already exists for the appointment', async () => {
      vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
        id: 'apt-1', doctorId: 'doc-1', patientId: 'patient-1',
        appointmentDate: FUTURE_DATE,
        doctor: { id: 'doc-1' },
      } as any);
      vi.mocked(prisma.queueToken.findFirst).mockResolvedValue({
        id: 'qt-existing', tokenNumber: '001',
      } as any);

      await expect(
        appointmentsService.generateQueueToken('tenant-1', 'apt-1'),
      ).rejects.toThrow(AppError);
    });
  });
});

describe('registration fee decided after the bill exists', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ensureAppointmentBill returns an EXISTING bill untouched, so a choice made
  // after the bill was raised reached nothing: the desk picked "charge the
  // registration fee", the counter still showed the consultation fee alone,
  // and nothing said why.
  const pendingBill = { id: 'bill-1', status: 'pending' };

  function arrangeExistingBill() {
    vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
      id: 'apt-1', status: 'booked', patientId: 'pat-1',
      doctor: { consultationFee: 500, freeFollowUpDays: 0 },
    } as any);
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as any);
    vi.mocked(prisma.appointment.update).mockResolvedValue({} as any);
    // What getPatientVisitStatus reads to decide "first visit here".
    vi.mocked(prisma.appointment.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.visit.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.admission.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.admission.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.visit.findMany).mockResolvedValue([] as any);
    // Registration fee configured and enabled for this hospital.
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      themeConfig: { registrationFee: { enabled: true, amount: 600, gstRatePercent: 10, label: 'Registration Fee', oncePerPatient: true } },
    } as any);
  }

  it('adds the registration line when the desk asks for it afterwards', async () => {
    arrangeExistingBill();
    // No registration line on the bill yet.
    vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.billItem.create).mockResolvedValue({} as any);

    await appointmentsService.initiateFrontdeskPayment('t1', 'apt-1', 'u1', {
      chargeRegistrationFee: true,
    });

    const created = vi.mocked(prisma.billItem.create).mock.calls[0]?.[0] as any;
    expect(created?.data?.referenceType).toBe('registration');
    expect(created?.data?.billId).toBe('bill-1');
  });

  it('removes it again when the desk changes their mind', async () => {
    arrangeExistingBill();
    vi.mocked(prisma.billItem.findFirst).mockResolvedValue({ id: 'item-reg' } as any);
    vi.mocked(prisma.billItem.delete).mockResolvedValue({} as any);

    await appointmentsService.initiateFrontdeskPayment('t1', 'apt-1', 'u1', {
      chargeRegistrationFee: false,
    });

    expect(prisma.billItem.delete).toHaveBeenCalledWith({ where: { id: 'item-reg' } });
  });

  it('leaves a collected bill alone', async () => {
    arrangeExistingBill();
    vi.mocked(prisma.bill.findFirst).mockResolvedValue({ id: 'bill-1', status: 'paid' } as any);
    vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.billItem.create).mockResolvedValue({} as any);

    await appointmentsService.initiateFrontdeskPayment('t1', 'apt-1', 'u1', {
      chargeRegistrationFee: true,
    });

    // A paid bill is a record of money taken, not a draft to edit.
    expect(prisma.billItem.create).not.toHaveBeenCalled();
    expect(prisma.billItem.delete).not.toHaveBeenCalled();
  });

  it('does nothing when the desk expresses no preference', async () => {
    arrangeExistingBill();
    vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.billItem.create).mockResolvedValue({} as any);

    await appointmentsService.initiateFrontdeskPayment('t1', 'apt-1', 'u1', {});

    // No answer means the rule already decided when the bill was built.
    expect(prisma.billItem.create).not.toHaveBeenCalled();
  });
});

// Gap 331: the payment step showed "Collect ₹500 & Book" for a follow-up the
// bill then waived to ₹0. The booking preview runs the bill's own rules.
describe('getBookingChargePreview', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a follow-up as waived, not the list fee', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ consultationFee: 500, freeFollowUpDays: 0 } as any);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p1' } as any);

    const out = await appointmentsService.getBookingChargePreview('tenant-1', {
      doctorId: 'doc-1', patientId: 'p1', type: 'follow_up',
    } as any);

    expect(out.consultationFee).toBe(0);
    expect(out.followUp).toMatchObject({ isFree: true, listFee: 500 });
  });

  it('charges the list fee for a consultation by a new patient', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ consultationFee: 500, freeFollowUpDays: 0 } as any);

    const out = await appointmentsService.getBookingChargePreview('tenant-1', {
      doctorId: 'doc-1', type: 'consultation',
    } as any);

    expect(out.consultationFee).toBe(500);
    expect(out.registration.isFirstVisit).toBe(true);
  });
});

// Gap 334: the Referral report listed a same-doctor follow-up as a referral.
describe('getAppointments — referred filter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('keeps only visits whose patient has a referral source', async () => {
    await appointmentsService.getAppointments('tenant-1', { referred: true } as any);
    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0]![0]!.where as any;
    expect(where.consultationType).toBeUndefined();
    expect(where.AND).toEqual([
      { patient: { referredBy: { not: null } } },
      { NOT: { patient: { referredBy: '' } } },
    ]);
  });

  it('bounds a date range by IST days, end date inclusive (gap 359)', async () => {
    await appointmentsService.getAppointments('tenant-1', { fromDate: '2026-10-14', toDate: '2026-11-13' } as any);
    const where = vi.mocked(prisma.appointment.findMany).mock.calls[0]![0]!.where as any;
    // appointmentDate is a calendar date at UTC midnight; 13 Nov must be inside.
    expect(where.appointmentDate.lte.getTime()).toBeGreaterThanOrEqual(new Date('2026-11-13T00:00:00Z').getTime());
    expect(where.appointmentDate.lte.getTime()).toBeLessThan(new Date('2026-11-14T00:00:00Z').getTime());
    expect(where.appointmentDate.gte.getTime()).toBeGreaterThan(new Date('2026-10-13T00:00:00Z').getTime());
  });
});
