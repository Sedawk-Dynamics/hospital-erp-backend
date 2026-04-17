import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  generateDischargeSummarySchema,
  getDischargeSummaryByIdSchema,
  getDischargeSummaryByAdmissionSchema,
  updateDischargeSummarySchema,
  dischargeSummaryIdParamSchema,
  signDischargeSummarySchema,
} from './mrd.validation';
import * as controller from './mrd.controller';

export const mrdRoutes = Router();

// ==================== MRD Documents ====================

mrdRoutes.get(
  '/documents',
  authenticate,
  controller.getMrdDocuments,
);

mrdRoutes.post(
  '/documents',
  authenticate,
  controller.createMrdRequest,
);

// ==================== Discharge Summary ====================

mrdRoutes.get(
  '/discharge-summary/generate',
  authenticate,
  requirePermission('admissions', 'read'),
  validate(generateDischargeSummarySchema),
  controller.generateDischargeSummary,
);

mrdRoutes.get(
  '/discharge-summary/by-admission/:admissionId',
  authenticate,
  requirePermission('admissions', 'read'),
  validate(getDischargeSummaryByAdmissionSchema),
  controller.getDischargeSummaryByAdmission,
);

mrdRoutes.get(
  '/discharge-summary/:id',
  authenticate,
  requirePermission('admissions', 'read'),
  validate(getDischargeSummaryByIdSchema),
  controller.getDischargeSummaryById,
);

mrdRoutes.patch(
  '/discharge-summary/:id',
  authenticate,
  requirePermission('admissions', 'update'),
  validate(updateDischargeSummarySchema),
  controller.updateDischargeSummary,
);

mrdRoutes.post(
  '/discharge-summary/:id/sign',
  authenticate,
  requirePermission('admissions', 'update'),
  validate(signDischargeSummarySchema),
  controller.signDischargeSummary,
);

mrdRoutes.post(
  '/discharge-summary/:id/publish',
  authenticate,
  requirePermission('admissions', 'update'),
  validate(dischargeSummaryIdParamSchema),
  controller.publishDischargeSummary,
);

mrdRoutes.post(
  '/discharge-summary/:id/refresh',
  authenticate,
  requirePermission('admissions', 'update'),
  validate(dischargeSummaryIdParamSchema),
  controller.refreshDischargeSummary,
);

mrdRoutes.get(
  '/discharge-summary/:id/pdf',
  authenticate,
  requirePermission('admissions', 'read'),
  validate(dischargeSummaryIdParamSchema),
  controller.downloadDischargeSummaryPdf,
);
