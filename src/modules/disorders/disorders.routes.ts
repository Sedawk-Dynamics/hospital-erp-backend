import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './disorders.controller';
import {
  searchDisordersSchema,
  listDisordersSchema,
  createDisorderSchema,
  disorderIdParamSchema,
} from './disorders.validation';

export const disorderRoutes = Router();

// --- Search: any authenticated user. It backs the "existing disorders" field
//     on the clinician history panel AND the patient's own portal, so it must
//     not be gated behind a clinical permission. ---
disorderRoutes.get(
  '/search',
  authenticate,
  validate(searchDisordersSchema),
  controller.searchDisorders,
);

// --- Super-admin management of the shared list. `/search` is declared above
//     so this router's '/' handlers cannot shadow it. ---
disorderRoutes.get(
  '/',
  authenticate,
  requireRoles('super_admin'),
  validate(listDisordersSchema),
  controller.listDisorders,
);
disorderRoutes.post(
  '/',
  authenticate,
  requireRoles('super_admin'),
  validate(createDisorderSchema),
  controller.createDisorder,
);
disorderRoutes.post(
  '/:id/restore',
  authenticate,
  requireRoles('super_admin'),
  validate(disorderIdParamSchema),
  controller.restoreDisorder,
);
disorderRoutes.delete(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(disorderIdParamSchema),
  controller.deleteDisorder,
);
