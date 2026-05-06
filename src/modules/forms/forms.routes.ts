import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission } from '../../middleware/authorize';
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

// ─── Hospital forms (admin manages, all clinical staff read) ──

formsRoutes.get(
  '/',
  authenticate,
  requirePermission('forms', 'read'),
  validate(listHospitalFormsQuerySchema),
  controller.listHospitalForms,
);

formsRoutes.get(
  '/:id',
  authenticate,
  requirePermission('forms', 'read'),
  validate(hospitalFormIdParam),
  controller.getHospitalForm,
);

formsRoutes.post(
  '/',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createHospitalFormSchema),
  controller.createHospitalForm,
);

formsRoutes.put(
  '/:id',
  authenticate,
  requirePermission('forms', 'update'),
  validate(updateHospitalFormSchema),
  controller.updateHospitalForm,
);

formsRoutes.post(
  '/clone-template/:templateId',
  authenticate,
  requirePermission('forms', 'create'),
  validate(cloneTemplateSchema),
  controller.cloneTemplate,
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

// ─── Submissions ──────────────────────────────────────────────
// Anyone with `forms:create` can submit (nurse, admin, doctor,
// super_admin, front_desk per role-permissions). Service layer
// enforces patient + tenant scoping via resolveVisitContext.
// Submission list/get is `forms:read` — same audience as patient
// detail (doctor, nurse, nurse_admin, admin, etc.).

formsRoutes.post(
  '/:id/submissions',
  authenticate,
  requirePermission('forms', 'create'),
  validate(createSubmissionSchema),
  controller.createSubmission,
);

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
