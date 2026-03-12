import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './pharmacy.controller';
import {
  createCategorySchema,
  getCategoriesQuerySchema,
  updateCategorySchema,
  categoryIdParamSchema,
  createFormularySchema,
  getFormularyQuerySchema,
  formularyIdParamSchema,
  updateFormularySchema,
  createBatchSchema,
  getBatchesQuerySchema,
  getExpiringBatchesQuerySchema,
  batchIdParamSchema,
  updateBatchSchema,
  createDispenseSchema,
  getDispenseQuerySchema,
  dispenseIdParamSchema,
  createReturnSchema,
  getReturnsQuerySchema,
  processReturnSchema,
} from './pharmacy.validation';

export const pharmacyRoutes = Router();

// --- Drug Categories ---
pharmacyRoutes.post('/categories', authenticate, requirePermission('pharmacy', 'create'), validate(createCategorySchema), controller.createDrugCategory);
pharmacyRoutes.get('/categories', authenticate, requirePermission('pharmacy', 'read'), validate(getCategoriesQuerySchema), controller.getDrugCategories);
pharmacyRoutes.put('/categories/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateCategorySchema), controller.updateDrugCategory);
pharmacyRoutes.delete('/categories/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(categoryIdParamSchema), controller.deleteDrugCategory);

// --- Formulary ---
pharmacyRoutes.post('/formulary', authenticate, requirePermission('pharmacy', 'create'), validate(createFormularySchema), controller.createFormularyItem);
pharmacyRoutes.get('/formulary', authenticate, requirePermission('pharmacy', 'read'), validate(getFormularyQuerySchema), controller.getFormulary);
pharmacyRoutes.get('/formulary/:id', authenticate, requirePermission('pharmacy', 'read'), validate(formularyIdParamSchema), controller.getFormularyItemById);
pharmacyRoutes.put('/formulary/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateFormularySchema), controller.updateFormularyItem);
pharmacyRoutes.delete('/formulary/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(formularyIdParamSchema), controller.deleteFormularyItem);

// --- Batches ---
pharmacyRoutes.post('/batches', authenticate, requirePermission('pharmacy', 'create'), validate(createBatchSchema), controller.createBatch);
pharmacyRoutes.get('/batches', authenticate, requirePermission('pharmacy', 'read'), validate(getBatchesQuerySchema), controller.getBatches);
pharmacyRoutes.get('/batches/expiring', authenticate, requirePermission('pharmacy', 'read'), validate(getExpiringBatchesQuerySchema), controller.getExpiringBatches);
pharmacyRoutes.get('/batches/:id', authenticate, requirePermission('pharmacy', 'read'), validate(batchIdParamSchema), controller.getBatchById);
pharmacyRoutes.put('/batches/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateBatchSchema), controller.updateBatch);

// --- Dispensing ---
pharmacyRoutes.post('/dispensing', authenticate, requirePermission('pharmacy', 'create'), validate(createDispenseSchema), controller.createDispense);
pharmacyRoutes.get('/dispensing', authenticate, requirePermission('pharmacy', 'create'), validate(getDispenseQuerySchema), controller.getDispenseRecords);
pharmacyRoutes.get('/dispensing/:id', authenticate, requirePermission('pharmacy', 'read'), validate(dispenseIdParamSchema), controller.getDispenseById);
pharmacyRoutes.patch('/dispensing/:id/verify', authenticate, requirePermission('pharmacy', 'approve'), validate(dispenseIdParamSchema), controller.verifyDispense);

// --- Returns ---
pharmacyRoutes.post('/returns', authenticate, requirePermission('pharmacy', 'create'), validate(createReturnSchema), controller.createReturn);
pharmacyRoutes.get('/returns', authenticate, requirePermission('pharmacy', 'read'), validate(getReturnsQuerySchema), controller.getReturns);
pharmacyRoutes.patch('/returns/:id/process', authenticate, requirePermission('pharmacy', 'approve'), validate(processReturnSchema), controller.processReturn);
