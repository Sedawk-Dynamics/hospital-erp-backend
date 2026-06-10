import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './cdss.controller';
import {
  validatePrescriptionSchema,
  orderSuggestionsSchema,
  evaluateLabResultsSchema,
  alertsQuerySchema,
  acknowledgeAlertSchema,
  overrideAlertSchema,
} from './cdss.validation';

export const cdssRoutes = Router();

// CDSS sits over multiple modules; we reuse the `prescriptions:read` permission
// for prescription validation (doctor + nurse have it), and `lab_orders:read`
// for the critical-value endpoint. Alerts feed uses `lab_reports:read`.
cdssRoutes.post(
  '/validate-prescription',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(validatePrescriptionSchema),
  controller.validatePrescription,
);

cdssRoutes.get(
  '/order-suggestions',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(orderSuggestionsSchema),
  controller.getOrderSuggestions,
);

cdssRoutes.post(
  '/critical-values/evaluate',
  authenticate,
  requirePermission('lab_orders', 'read'),
  validate(evaluateLabResultsSchema),
  controller.evaluateLabResults,
);

cdssRoutes.get(
  '/alerts',
  authenticate,
  requirePermission('lab_reports', 'read'),
  validate(alertsQuerySchema),
  controller.getAlertsFeed,
);

cdssRoutes.get(
  '/alerts/summary',
  authenticate,
  requirePermission('lab_reports', 'read'),
  controller.getAlertsSummary,
);

// Review workflow: acknowledging/overriding is a clinical action — doctors
// and nurses hold `prescriptions:read`, which is the closest existing perm.
cdssRoutes.patch(
  '/alerts/:id/acknowledge',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(acknowledgeAlertSchema),
  controller.acknowledgeAlert,
);

cdssRoutes.patch(
  '/alerts/:id/override',
  authenticate,
  requirePermission('prescriptions', 'read'),
  validate(overrideAlertSchema),
  controller.overrideAlert,
);
