import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  systemFormIdParamSchema,
  updateSystemFormSchema,
  upsertHospitalFormConfigSchema,
  updateHospitalFormConfigSchema,
  createFormSubmissionSchema,
  updateFormSubmissionSchema,
  idParamSchema,
} from './forms.validation';
import {
  systemFormsController,
  hospitalFormConfigController,
  formSubmissionsController,
} from './forms.controller';

export const formsRoutes = Router();

// All form routes require authentication
formsRoutes.use(authenticate);

// ─── System Forms ────────────────────────────────────────────

// List all system forms (any authenticated user)
formsRoutes.get('/system', systemFormsController.list);

// Single system form by slug
formsRoutes.get(
  '/system/:id',
  validate(systemFormIdParamSchema),
  systemFormsController.getById,
);

// Super admin: edit schema, toggle, name, description, defaultRoleSettings
formsRoutes.patch(
  '/system/:id',
  requireRoles('super_admin'),
  validate(updateSystemFormSchema),
  systemFormsController.update,
);

// Resolve forms for a workflow trigger — used by booking flow, admission, etc.
formsRoutes.get('/system/trigger/:trigger', systemFormsController.getForTrigger);

// Pending (unfilled required) forms for a context
formsRoutes.get('/pending', systemFormsController.getPending);

// All forms the current user can fill (Staff Forms Inbox)
formsRoutes.get('/available-for-me', systemFormsController.getAvailableForMe);

// ─── Hospital Form Config ────────────────────────────────────

// List all configs for this hospital
formsRoutes.get('/hospital-config', hospitalFormConfigController.list);

// Upsert config (create or update)
formsRoutes.post(
  '/hospital-config',
  requireRoles('admin', 'super_admin'),
  validate(upsertHospitalFormConfigSchema),
  hospitalFormConfigController.upsert,
);

// Update config by formId
formsRoutes.patch(
  '/hospital-config/:formId',
  requireRoles('admin', 'super_admin'),
  validate(updateHospitalFormConfigSchema),
  hospitalFormConfigController.update,
);

// ─── Submissions ─────────────────────────────────────────────

formsRoutes.get('/submissions', formSubmissionsController.list);
formsRoutes.get('/submissions/:id', validate(idParamSchema), formSubmissionsController.getById);

// Anyone authenticated can submit
formsRoutes.post(
  '/submissions',
  validate(createFormSubmissionSchema),
  formSubmissionsController.create,
);

// Verify / reject
formsRoutes.patch(
  '/submissions/:id',
  requireRoles('admin', 'super_admin', 'doctor', 'front_desk', 'nurse'),
  validate(updateFormSubmissionSchema),
  formSubmissionsController.update,
);

formsRoutes.delete(
  '/submissions/:id',
  requireRoles('admin', 'super_admin'),
  validate(idParamSchema),
  formSubmissionsController.delete,
);
