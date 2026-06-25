import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './icd.controller';
import {
  searchIcdSchema,
  listIcdSchema,
  createIcdSchema,
  updateIcdSchema,
  icdIdParamSchema,
  createCustomIcdSchema,
} from './icd.validation';

export const icdRoutes = Router();

// --- Search (any authenticated clinical user — powers diagnosis autocomplete) ---
icdRoutes.get('/search', authenticate, validate(searchIcdSchema), controller.searchIcd);

// --- Hospital-scoped custom code (declared before '/' POST so it isn't shadowed) ---
icdRoutes.post(
  '/custom',
  authenticate,
  requirePermission('diagnoses', 'create'),
  validate(createCustomIcdSchema),
  controller.createCustomIcd,
);

// --- Super-admin management of the shared platform catalog ---
icdRoutes.get('/', authenticate, requireRoles('super_admin'), validate(listIcdSchema), controller.listIcd);
icdRoutes.post('/', authenticate, requireRoles('super_admin'), validate(createIcdSchema), controller.createIcd);
icdRoutes.put('/:id', authenticate, requireRoles('super_admin'), validate(updateIcdSchema), controller.updateIcd);
icdRoutes.delete('/:id', authenticate, requireRoles('super_admin'), validate(icdIdParamSchema), controller.deleteIcd);
