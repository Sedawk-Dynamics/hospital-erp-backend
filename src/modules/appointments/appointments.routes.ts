import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createDoctorProfileSchema,
  updateDoctorScheduleSchema,
  createDoctorLeaveSchema,
  getDoctorLeavesQuerySchema,
  listAllDoctorLeavesQuerySchema,
  doctorLeaveIdParamSchema,
  reviewDoctorLeaveSchema,
  upsertScheduleOverrideSchema,
  bulkOverrideSchema,
  listOverridesQuerySchema,
  overrideIdParamSchema,
  bookAppointmentSchema,
  updateAppointmentStatusSchema,
  getAppointmentsQuerySchema,
  getDoctorProfilesQuerySchema,
  doctorIdParamSchema,
  appointmentIdParamSchema,
  slotsQuerySchema,
  queueQuerySchema,
} from './appointments.validation';
import * as controller from './appointments.controller';

export const appointmentRoutes = Router();

// --- Doctor Profiles ---

// Create doctor profile
appointmentRoutes.post(
  '/doctors',
  authenticate,
  requirePermission('appointments', 'create'),
  validate(createDoctorProfileSchema),
  controller.createDoctorProfile,
);

// List doctor profiles
appointmentRoutes.get(
  '/doctors',
  authenticate,
  validate(getDoctorProfilesQuerySchema),
  controller.getDoctorProfiles,
);

// Get single doctor profile
appointmentRoutes.get(
  '/doctors/:id',
  authenticate,
  validate(doctorIdParamSchema),
  controller.getDoctorProfile,
);

// Update doctor profile (fee, specialization, etc.)
appointmentRoutes.patch(
  '/doctors/:id',
  authenticate,
  requirePermission('appointments', 'update'),
  controller.updateDoctorProfile,
);

// Update doctor schedule
appointmentRoutes.put(
  '/doctors/:id/schedules',
  authenticate,
  requirePermission('appointments', 'update'),
  validate(updateDoctorScheduleSchema),
  controller.updateDoctorSchedule,
);

// Create doctor leave (doctor self-service — starts in pending state)
appointmentRoutes.post(
  '/doctors/:id/leaves',
  authenticate,
  validate(createDoctorLeaveSchema),
  controller.createDoctorLeave,
);

// List a doctor's leaves
appointmentRoutes.get(
  '/doctors/:id/leaves',
  authenticate,
  validate(getDoctorLeavesQuerySchema),
  controller.getDoctorLeaves,
);

// List all doctor leave requests (HR/admin approval queue)
appointmentRoutes.get(
  '/doctor-leaves',
  authenticate,
  requirePermission('hr', 'read'),
  validate(listAllDoctorLeavesQuerySchema),
  controller.listAllDoctorLeaves,
);

// Approve a doctor leave request
appointmentRoutes.patch(
  '/doctor-leaves/:leaveId/approve',
  authenticate,
  requirePermission('hr', 'approve'),
  validate(doctorLeaveIdParamSchema),
  controller.approveDoctorLeave,
);

// Reject a doctor leave request
appointmentRoutes.patch(
  '/doctor-leaves/:leaveId/reject',
  authenticate,
  requirePermission('hr', 'approve'),
  validate(reviewDoctorLeaveSchema),
  controller.rejectDoctorLeave,
);

// Doctor cancels own leave request (pending/approved)
appointmentRoutes.patch(
  '/doctor-leaves/:leaveId/cancel',
  authenticate,
  validate(doctorLeaveIdParamSchema),
  controller.cancelDoctorLeave,
);

// ── Schedule Overrides (date-specific, admin/HR managed) ─────

// List overrides in a date range
appointmentRoutes.get(
  '/doctors/:id/schedule-overrides',
  authenticate,
  validate(listOverridesQuerySchema),
  controller.listScheduleOverrides,
);

// Create or update an override for a single date
appointmentRoutes.post(
  '/doctors/:id/schedule-overrides',
  authenticate,
  requirePermission('appointments', 'update'),
  validate(upsertScheduleOverrideSchema),
  controller.upsertScheduleOverride,
);

// Bulk apply the same override to a date range
appointmentRoutes.post(
  '/doctors/:id/schedule-overrides/bulk',
  authenticate,
  requirePermission('appointments', 'update'),
  validate(bulkOverrideSchema),
  controller.bulkApplyOverrides,
);

// Remove an override (reverts date to weekly default)
appointmentRoutes.delete(
  '/doctors/schedule-overrides/:overrideId',
  authenticate,
  requirePermission('appointments', 'update'),
  validate(overrideIdParamSchema),
  controller.deleteScheduleOverride,
);

// Get available slots for a doctor on a date
appointmentRoutes.get(
  '/doctors/:id/slots',
  authenticate,
  validate(slotsQuerySchema),
  controller.getAvailableSlots,
);

// --- Queue (must be before /:id routes) ---

// Get queue for a doctor on a date
appointmentRoutes.get(
  '/queue/doctor/:doctorId',
  authenticate,
  validate(queueQuerySchema),
  controller.getQueueByDoctor,
);

// --- Appointment Stats ---

appointmentRoutes.get(
  '/stats',
  authenticate,
  controller.getAppointmentStats,
);

// --- Appointments ---

// Book appointment
appointmentRoutes.post(
  '/',
  authenticate,
  requirePermission('appointments', 'create'),
  validate(bookAppointmentSchema),
  controller.bookAppointment,
);

// List appointments
appointmentRoutes.get(
  '/',
  authenticate,
  requirePermission('appointments', 'read'),
  validate(getAppointmentsQuerySchema),
  controller.getAppointments,
);

// Get single appointment
appointmentRoutes.get(
  '/:id',
  authenticate,
  validate(appointmentIdParamSchema),
  controller.getAppointmentById,
);

// Update appointment status
appointmentRoutes.patch(
  '/:id/status',
  authenticate,
  validate(updateAppointmentStatusSchema),
  controller.updateAppointmentStatus,
);

// Cancel appointment
appointmentRoutes.patch(
  '/:id/cancel',
  authenticate,
  validate(appointmentIdParamSchema),
  controller.cancelAppointment,
);

// Fetch assembled consultation form data for prefill + editability check
// (OP: 24h window, IP: until discharge). Does NOT change appointment status.
appointmentRoutes.get(
  '/:id/consultation-form-data',
  authenticate,
  validate(appointmentIdParamSchema),
  controller.getConsultationFormData,
);

// Generate queue token for an appointment
appointmentRoutes.post(
  '/:id/queue',
  authenticate,
  validate(appointmentIdParamSchema),
  controller.generateQueueToken,
);
