import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  submitDemoRequestSchema,
  approveDemoRequestSchema,
  rejectDemoRequestSchema,
  endTrialSchema,
  deleteDemoRequestSchema,
} from './demo-requests.validation';
import { demoRequestsController } from './demo-requests.controller';

export const demoRequestRoutes = Router();

// Public: submit a demo request (no auth required)
demoRequestRoutes.post(
  '/',
  validate(submitDemoRequestSchema),
  demoRequestsController.submit,
);

// Super admin: list all demo requests
demoRequestRoutes.get(
  '/',
  authenticate,
  requireRoles('super_admin'),
  demoRequestsController.list,
);

// Super admin: approve a demo request (creates hospital + admin + trial)
demoRequestRoutes.patch(
  '/:id/approve',
  authenticate,
  requireRoles('super_admin'),
  validate(approveDemoRequestSchema),
  demoRequestsController.approve,
);

// Super admin: reject a demo request
demoRequestRoutes.patch(
  '/:id/reject',
  authenticate,
  requireRoles('super_admin'),
  validate(rejectDemoRequestSchema),
  demoRequestsController.reject,
);

// Super admin: end a trial early
demoRequestRoutes.patch(
  '/:id/end-trial',
  authenticate,
  requireRoles('super_admin'),
  validate(endTrialSchema),
  demoRequestsController.endTrial,
);

// Super admin: delete a demo request
demoRequestRoutes.delete(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(deleteDemoRequestSchema),
  demoRequestsController.delete,
);
