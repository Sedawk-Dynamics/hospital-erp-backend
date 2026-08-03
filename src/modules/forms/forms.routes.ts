import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission, denyRoles } from '../../middleware/authorize';

// Patient forms are nursing documentation: the nurse records them at the
// bedside and the doctor reads them. A doctor must not file a submission in
// the nurse's name, even though the role holds `forms:create` for the
// hospital-form catalogue. Mirrors the nurse-cannot-write-prescriptions rule.
const noDoctorSubmit = denyRoles('doctor');
import { validate } from '../../middleware/validate';
import * as controller from './forms.controller';
import {
  createTemplateSchema,
  updateTemplateSchema,
  templateIdParam,
  listTemplatesQuerySchema,
  createHospitalFormSchema,
  updateHospitalFormSchema,
  hospitalFormIdParam,
  listHospitalFormsQuerySchema,
  cloneTemplateSchema,
  archiveFormSchema,
  createSubmissionSchema,
  listSubmissionsQuerySchema,
  submissionIdParam,
} from './forms.validation';

export const formsRoutes = Router();

// ─── Templates (super-admin only for writes) ───────────────────
// Reads stay open to authenticated users — hospital admins need to
// browse templates before cloning.

formsRoutes.get(
  '/templates',
  authenticate,
  validate(listTemplatesQuerySchema),
  controller.listTemplates,
);

formsRoutes.get(
  '/templates/:id',
  authenticate,
  validate(templateIdParam),
  controller.getTemplate,
);

formsRoutes.post(
  '/templates',
  authenticate,
  requireRoles('super_admin'),
  validate(createTemplateSchema),
  controller.createTemplate,
);

formsRoutes.put(
  '/templates/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(updateTemplateSchema),
  controller.updateTemplate,
);

formsRoutes.delete(
  '/templates/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(templateIdParam),
  controller.deleteTemplate,
);

// ─── Submissions ──────────────────────────────────────────────
// Registered BEFORE the generic `/:id` routes so /submissions is
// not swallowed by Express matching `submissions` against `:id`
// (which previously rejected with "Invalid uuid").
//
// Submitting needs `forms:create` — nurse, admin, front_desk, patient,
// super_admin — but NOT doctor: see `noDoctorSubmit` above. Service layer
// enforces patient + tenant scoping via resolveVisitContext.
// Submission list/get is `forms:read` — same audience as patient
// detail (doctor, nurse, nurse_admin, admin, etc.), so doctors read
// everything the nurse files.

formsRoutes.get(
  '/submissions',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listSubmissionsQuerySchema),
  controller.listSubmissions,
);

formsRoutes.get(
  '/submissions/:id',
  authenticate,
  requirePermission('forms', 'read'),
  validate(submissionIdParam),
  controller.getSubmission,
);

// ─── Hospital forms (admin manages, all clinical staff read) ──

formsRoutes.get(
  '/',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listHospitalFormsQuerySchema),
  controller.listHospitalForms,
);

formsRoutes.post(
  '/',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createHospitalFormSchema),
  controller.createHospitalForm,
);

formsRoutes.post(
  '/clone-template/:templateId',
  authenticate,
  requirePermission('forms', 'create'),
  validate(cloneTemplateSchema),
  controller.cloneTemplate,
);

formsRoutes.post(
  '/:id/submissions',
  authenticate,
  requirePermission('forms', 'create'),
  noDoctorSubmit,
  validate(createSubmissionSchema),
  controller.createSubmission,
);

formsRoutes.post(
  '/:id/archive',
  authenticate,
  requirePermission('forms', 'update'),
  validate(archiveFormSchema),
  controller.archiveHospitalForm,
);

formsRoutes.post(
  '/:id/restore',
  authenticate,
  requirePermission('forms', 'update'),
  validate(hospitalFormIdParam),
  controller.restoreHospitalForm,
);

formsRoutes.get(
  '/:id',
  authenticate,
  requirePermission('forms', 'read'),
  validate(hospitalFormIdParam),
  controller.getHospitalForm,
);

formsRoutes.put(
  '/:id',
  authenticate,
  requirePermission('forms', 'update'),
  validate(updateHospitalFormSchema),
  controller.updateHospitalForm,
);
