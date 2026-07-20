import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './drug-master.controller';

// Isolated in-memory upload for the catalog CSV (kept separate from the
// disk-storage attachment uploader, which has an image/PDF allowlist).
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });
import {
  searchDrugMasterSchema,
  listDrugMasterSchema,
  drugMasterIdParamSchema,
  createDrugMasterSchema,
  updateDrugMasterSchema,
  suggestDrugMasterSchema,
} from './drug-master.validation';

export const drugMasterRoutes = Router();

// --- Catalog search (any authenticated clinical/pharmacy user) ---
// The drug catalog is non-sensitive platform reference data (like ICD codes);
// any logged-in user can search it to pick a drug or import it into the
// hospital formulary.
drugMasterRoutes.get(
  '/search',
  authenticate,
  validate(searchDrugMasterSchema),
  controller.searchDrugMaster,
);

// --- HSN → GST tax reference (any authenticated pharmacy/inventory user) ---
// Non-sensitive platform reference data (like the catalog itself). Declared
// before '/:id' so these literals aren't captured as an :id.
drugMasterRoutes.get('/hsn', authenticate, controller.listHsnGstRates);
drugMasterRoutes.get('/hsn/lookup', authenticate, controller.lookupHsnGst);

// --- Super-admin catalog refresh (upsert against a provider / CSV snapshot) ---
// Declared before '/:id' so these literals aren't captured as an :id.
drugMasterRoutes.get(
  '/providers',
  authenticate,
  requireRoles('super_admin'),
  controller.getDrugProviders,
);
drugMasterRoutes.post(
  '/refresh',
  authenticate,
  requireRoles('super_admin'),
  csvUpload.single('file'),
  controller.refreshCatalog,
);
drugMasterRoutes.get(
  '/refresh/status',
  authenticate,
  requireRoles('super_admin'),
  controller.refreshStatus,
);

// --- Super-admin management ---
drugMasterRoutes.get(
  '/',
  authenticate,
  requireRoles('super_admin'),
  validate(listDrugMasterSchema),
  controller.listDrugMaster,
);
drugMasterRoutes.get(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(drugMasterIdParamSchema),
  controller.getDrugMasterById,
);
drugMasterRoutes.post(
  '/',
  authenticate,
  requireRoles('super_admin'),
  validate(createDrugMasterSchema),
  controller.createDrugMaster,
);
// G11: a pharmacy user suggests an unlisted brand — created unpublished, then a
// platform admin reviews/publishes it. Declared before '/:id' routes.
drugMasterRoutes.post(
  '/suggest',
  authenticate,
  requirePermission('pharmacy', 'create'),
  validate(suggestDrugMasterSchema),
  controller.suggestDrugMaster,
);
drugMasterRoutes.put(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(updateDrugMasterSchema),
  controller.updateDrugMaster,
);
drugMasterRoutes.delete(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(drugMasterIdParamSchema),
  controller.deleteDrugMaster,
);
