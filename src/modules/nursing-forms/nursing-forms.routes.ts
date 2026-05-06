import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createIntakeOutputSchema,
  createObservationSchema,
  createDeviceSchema,
  updateDeviceSchema,
  removeDeviceSchema,
  createDeviceCheckSchema,
  listDeviceChecksQuerySchema,
  createProcedureSchema,
  listDevicesQuerySchema,
  listProceduresQuerySchema,
  ioTotalsQuerySchema,
  listFormsQuerySchema,
  summaryQuerySchema,
} from './nursing-forms.validation';
import * as controller from './nursing-forms.controller';

export const nursingFormsRoutes = Router();

// HISTORY: this module used to expose 6 hardcoded "patient form" types
// (Admission Assessment, Pain, Fall Risk, Wound Care, Daily Note,
// Intake/Output). Those were retired on 2026-05-06 in favour of the
// dynamic form-builder system at /api/v1/forms (`backend/src/modules/forms/`).
// Only the **clinical-charting** endpoints (Observations, Devices,
// Device checks, Procedures, charting timeline, IO totals) remain here
// because they have purpose-built UX (device lifecycle, timeline) that
// doesn't translate to dynamic JSON forms.

// --- Intake / Output (kept — feeds charting "running tally" footer) ---
nursingFormsRoutes.post(
  '/intake-output',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createIntakeOutputSchema),
  controller.createIntakeOutput,
);
nursingFormsRoutes.get(
  '/intake-output',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listIntakeOutput,
);
nursingFormsRoutes.get(
  '/intake-output/totals',
  authenticate,
  requirePermission('forms', 'read'),
  validate(ioTotalsQuerySchema),
  controller.getIntakeOutputTotals,
);

// --- Clinical Observation ---
nursingFormsRoutes.post(
  '/observations',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createObservationSchema),
  controller.createObservation,
);
nursingFormsRoutes.get(
  '/observations',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listObservations,
);

// --- Clinical Devices / Lines ---
nursingFormsRoutes.post(
  '/devices',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createDeviceSchema),
  controller.createDevice,
);
nursingFormsRoutes.get(
  '/devices',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listDevicesQuerySchema),
  controller.listDevices,
);
nursingFormsRoutes.get(
  '/devices/:id',
  authenticate,
  requirePermission('forms', 'read'),
  controller.getDevice,
);
nursingFormsRoutes.patch(
  '/devices/:id',
  authenticate,
  requirePermission('forms', 'create'),
  validate(updateDeviceSchema),
  controller.updateDevice,
);
nursingFormsRoutes.post(
  '/devices/:id/remove',
  authenticate,
  requirePermission('forms', 'create'),
  validate(removeDeviceSchema),
  controller.removeDevice,
);
nursingFormsRoutes.post(
  '/devices/:id/checks',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createDeviceCheckSchema),
  controller.createDeviceCheck,
);
nursingFormsRoutes.get(
  '/devices/:id/checks',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listDeviceChecksQuerySchema),
  controller.listDeviceChecks,
);

// --- Clinical Procedures ---
nursingFormsRoutes.post(
  '/procedures',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createProcedureSchema),
  controller.createProcedure,
);
nursingFormsRoutes.get(
  '/procedures',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listProceduresQuerySchema),
  controller.listProcedures,
);

// --- Charting timeline (combined feed) ---
nursingFormsRoutes.get(
  '/timeline/:patientId',
  authenticate,
  requirePermission('forms', 'read'),
  validate(summaryQuerySchema),
  controller.getChartingTimeline,
);
