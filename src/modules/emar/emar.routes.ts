import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as ctrl from './emar.controller';
import {
  createTimeSlotSchema,
  updateTimeSlotSchema,
  timeSlotIdParamSchema,
  createFrequencySchema,
  updateFrequencySchema,
  frequencyIdParamSchema,
  updateSettingsSchema,
  listSchedulesQuerySchema,
  scheduleIdParamSchema,
  giveDoseSchema,
  holdRefuseDoseSchema,
  missedDoseSchema,
  amendDoseSchema,
  triggerPrnSchema,
  regenerateSchedulesSchema,
  auditQuerySchema,
} from './emar.validation';

export const emarRoutes = Router();

// ── Time Slot Master (configurable per tenant) ──────────────
// Read available to anyone with prescriptions:read; mutations require
// nurse_assignments:update which only nurse_admin/admin have.
emarRoutes.get(
  '/settings/time-slots',
  authenticate,
  requirePermission('prescriptions', 'read'),
  ctrl.listTimeSlots,
);
emarRoutes.post(
  '/settings/time-slots',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(createTimeSlotSchema),
  ctrl.createTimeSlot,
);
emarRoutes.put(
  '/settings/time-slots/:id',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(updateTimeSlotSchema),
  ctrl.updateTimeSlot,
);
emarRoutes.delete(
  '/settings/time-slots/:id',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(timeSlotIdParamSchema),
  ctrl.deleteTimeSlot,
);

// ── Frequency Master ────────────────────────────────────────
emarRoutes.get(
  '/settings/frequencies',
  authenticate,
  requirePermission('prescriptions', 'read'),
  ctrl.listFrequencies,
);
emarRoutes.post(
  '/settings/frequencies',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(createFrequencySchema),
  ctrl.createFrequency,
);
emarRoutes.put(
  '/settings/frequencies/:id',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(updateFrequencySchema),
  ctrl.updateFrequency,
);
emarRoutes.delete(
  '/settings/frequencies/:id',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(frequencyIdParamSchema),
  ctrl.deleteFrequency,
);

// ── Settings (grace period etc.) ────────────────────────────
emarRoutes.get(
  '/settings',
  authenticate,
  requirePermission('prescriptions', 'read'),
  ctrl.getSettings,
);
emarRoutes.put(
  '/settings',
  authenticate,
  requirePermission('nurse_assignments', 'update'),
  validate(updateSettingsSchema),
  ctrl.updateSettings,
);

// ── Lifecycle tick (manual trigger) ─────────────────────────
emarRoutes.post(
  '/lifecycle/tick',
  authenticate,
  requirePermission('prescriptions', 'update'),
  ctrl.tick,
);

// ── Audit ──────────────────────────────────────────────────
emarRoutes.get(
  '/audit/:id',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(auditQuerySchema),
  ctrl.getAudit,
);

// ── PRN trigger ────────────────────────────────────────────
emarRoutes.post(
  '/prn/:prescriptionItemId',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(triggerPrnSchema),
  ctrl.triggerPrn,
);

// ── Regenerate ─────────────────────────────────────────────
emarRoutes.post(
  '/regenerate/:prescriptionId',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(regenerateSchedulesSchema),
  ctrl.regenerate,
);

// ── Schedules ──────────────────────────────────────────────
emarRoutes.get(
  '/doses',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(listSchedulesQuerySchema),
  ctrl.listSchedules,
);
emarRoutes.get(
  '/doses/:id',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(scheduleIdParamSchema),
  ctrl.getSchedule,
);
emarRoutes.post(
  '/doses/:id/give',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(giveDoseSchema),
  ctrl.giveDose,
);
emarRoutes.post(
  '/doses/:id/hold',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(holdRefuseDoseSchema),
  ctrl.holdDose,
);
emarRoutes.post(
  '/doses/:id/refuse',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(holdRefuseDoseSchema),
  ctrl.refuseDose,
);
emarRoutes.post(
  '/doses/:id/missed',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(missedDoseSchema),
  ctrl.markMissed,
);
emarRoutes.post(
  '/doses/:id/amend',
  authenticate,
  requirePermission('prescriptions', 'update'),
  validate(amendDoseSchema),
  ctrl.amendDose,
);
