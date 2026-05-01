import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createAdmissionAssessmentSchema,
  createPainAssessmentSchema,
  createFallRiskSchema,
  createIntakeOutputSchema,
  createWoundCareSchema,
  createNursingNoteSchema,
  listFormsQuerySchema,
  summaryQuerySchema,
} from './nursing-forms.validation';
import * as controller from './nursing-forms.controller';

export const nursingFormsRoutes = Router();

// Permissions: re-use the existing `forms` module — already provisioned for
// nurse / nurse_admin / admin / doctor / front_desk in role-permissions.ts.
// Service-layer also enforces "nurse-only writes" the way Vitals does, so a
// permission drift between tenants can't open a write loophole.

// --- Admission Assessment ---
nursingFormsRoutes.post(
  '/admission-assessments',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createAdmissionAssessmentSchema),
  controller.createAdmissionAssessment,
);
nursingFormsRoutes.get(
  '/admission-assessments',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listAdmissionAssessments,
);

// --- Pain Assessment ---
nursingFormsRoutes.post(
  '/pain-assessments',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createPainAssessmentSchema),
  controller.createPainAssessment,
);
nursingFormsRoutes.get(
  '/pain-assessments',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listPainAssessments,
);

// --- Fall Risk (Morse) ---
nursingFormsRoutes.post(
  '/fall-risks',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createFallRiskSchema),
  controller.createFallRisk,
);
nursingFormsRoutes.get(
  '/fall-risks',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listFallRisks,
);

// --- Intake / Output ---
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

// --- Wound Care ---
nursingFormsRoutes.post(
  '/wound-care',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createWoundCareSchema),
  controller.createWoundCare,
);
nursingFormsRoutes.get(
  '/wound-care',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listWoundCare,
);

// --- Nursing Daily Note ---
nursingFormsRoutes.post(
  '/nursing-notes',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createNursingNoteSchema),
  controller.createNursingNote,
);
nursingFormsRoutes.get(
  '/nursing-notes',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listFormsQuerySchema),
  controller.listNursingNotes,
);

// --- Aggregate patient summary (powers read-only panels on doctor screens) ---
nursingFormsRoutes.get(
  '/summary/:patientId',
  authenticate,
  requirePermission('forms', 'read'),
  validate(summaryQuerySchema),
  controller.getPatientSummary,
);
