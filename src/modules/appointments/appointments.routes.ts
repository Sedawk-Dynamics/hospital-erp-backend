import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createDoctorProfileSchema,
  updateDoctorScheduleSchema,
  createDoctorLeaveSchema,
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

// Update doctor schedule
appointmentRoutes.put(
  '/doctors/:id/schedules',
  authenticate,
  requirePermission('appointments', 'update'),
  validate(updateDoctorScheduleSchema),
  controller.updateDoctorSchedule,
);

// Create doctor leave
appointmentRoutes.post(
  '/doctors/:id/leaves',
  authenticate,
  validate(createDoctorLeaveSchema),
  controller.createDoctorLeave,
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

// Generate queue token for an appointment
appointmentRoutes.post(
  '/:id/queue',
  authenticate,
  validate(appointmentIdParamSchema),
  controller.generateQueueToken,
);
