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
  findFormularyMatchesSchema,
  mergeFormularySchema,
  getFormularyQuerySchema,
  formularyIdParamSchema,
  updateFormularySchema,
  importFormularySchema,
  importFormularyBulkSchema,
  getCatalogQuerySchema,
  createBatchSchema,
  getBatchesQuerySchema,
  getExpiringBatchesQuerySchema,
  batchIdParamSchema,
  updateBatchSchema,
  adjustBatchSchema,
  getStockAdjustmentsQuerySchema,
  createDispenseSchema,
  setPharmacyStatusSchema,
  createPharmacySaleSchema,
  getPharmacySalesQuerySchema,
  cancelSaleSchema,
  saleIdParamSchema,
  getDispenseQuerySchema,
  dispenseIdParamSchema,
  createReturnSchema,
  createVendorReturnSchema,
  getReturnsQuerySchema,
  returnableQuerySchema,
  returnIdParamSchema,
  processReturnSchema,
  recallBatchSchema,
  unrecallBatchSchema,
  recallDrugSchema,
  recallAffectedPatientsParamSchema,
  getRecalledItemsQuerySchema,
  getGstReportQuerySchema,
  getStockLedgerQuerySchema,
} from './pharmacy.validation';

export const pharmacyRoutes = Router();

// --- Drug Categories ---
pharmacyRoutes.post('/categories', authenticate, requirePermission('pharmacy', 'create'), validate(createCategorySchema), controller.createDrugCategory);
pharmacyRoutes.get('/categories', authenticate, requirePermission('pharmacy', 'read'), validate(getCategoriesQuerySchema), controller.getDrugCategories);
pharmacyRoutes.put('/categories/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateCategorySchema), controller.updateDrugCategory);
pharmacyRoutes.delete('/categories/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(categoryIdParamSchema), controller.deleteDrugCategory);

// --- Drug catalog (tenant-facing browse of the platform DrugMaster) ---
pharmacyRoutes.get('/catalog', authenticate, requirePermission('pharmacy', 'read'), validate(getCatalogQuerySchema), controller.getTenantCatalog);

// --- Formulary ---
pharmacyRoutes.post('/formulary', authenticate, requirePermission('pharmacy', 'create'), validate(createFormularySchema), controller.createFormularyItem);
// G1: fuzzy duplicate look-up for the inward / add-drug dialog. Declared before
// '/formulary/:id' so "match" isn't captured as an :id.
pharmacyRoutes.get('/formulary/match', authenticate, requirePermission('pharmacy', 'read'), validate(findFormularyMatchesSchema), controller.findFormularyMatches);
// G1: merge a duplicate drug row into the canonical one (consolidate split stock).
pharmacyRoutes.post('/formulary/:id/merge', authenticate, requirePermission('pharmacy', 'update'), validate(mergeFormularySchema), controller.mergeFormularyItems);
// G8: alternative brands sharing this drug's composition. Before '/formulary/:id'.
pharmacyRoutes.get('/formulary/:id/alternatives', authenticate, requirePermission('pharmacy', 'read'), validate(formularyIdParamSchema), controller.getFormularyAlternatives);
// Import from the platform drug catalog. Declared before '/formulary/:id' so
// "import" isn't captured as an :id.
pharmacyRoutes.post('/formulary/import', authenticate, requirePermission('pharmacy', 'create'), validate(importFormularySchema), controller.importFormularyItem);
// Bulk copy many catalog drugs at once. Declared before '/formulary/:id'.
pharmacyRoutes.post('/formulary/import-bulk', authenticate, requirePermission('pharmacy', 'create'), validate(importFormularyBulkSchema), controller.importFormularyItemsBulk);
pharmacyRoutes.get('/formulary', authenticate, requirePermission('pharmacy', 'read'), validate(getFormularyQuerySchema), controller.getFormulary);
pharmacyRoutes.get('/formulary/:id', authenticate, requirePermission('pharmacy', 'read'), validate(formularyIdParamSchema), controller.getFormularyItemById);
pharmacyRoutes.put('/formulary/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateFormularySchema), controller.updateFormularyItem);
pharmacyRoutes.delete('/formulary/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(formularyIdParamSchema), controller.deleteFormularyItem);

// --- Batches ---
pharmacyRoutes.post('/batches', authenticate, requirePermission('pharmacy', 'create'), validate(createBatchSchema), controller.createBatch);
pharmacyRoutes.get('/batches', authenticate, requirePermission('pharmacy', 'read'), validate(getBatchesQuerySchema), controller.getBatches);
pharmacyRoutes.get('/batches/expiring', authenticate, requirePermission('pharmacy', 'read'), validate(getExpiringBatchesQuerySchema), controller.getExpiringBatches);
// G4: stock discrepancy report (manual count corrections). Before '/batches/:id'.
pharmacyRoutes.get('/batches/adjustments', authenticate, requirePermission('pharmacy', 'read'), validate(getStockAdjustmentsQuerySchema), controller.getStockAdjustments);
pharmacyRoutes.get('/batches/:id', authenticate, requirePermission('pharmacy', 'read'), validate(batchIdParamSchema), controller.getBatchById);
pharmacyRoutes.put('/batches/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateBatchSchema), controller.updateBatch);
// G4: deliberate stock-count correction (reason-stamped + audited).
pharmacyRoutes.patch('/batches/:id/adjust', authenticate, requirePermission('pharmacy', 'update'), validate(adjustBatchSchema), controller.adjustBatchStock);

// --- Counter billing (POS sale: partial / loose / walk-in, one invoice) ---
pharmacyRoutes.post('/sales', authenticate, requirePermission('pharmacy', 'create'), validate(createPharmacySaleSchema), controller.createPharmacySale);
// List counter-sale invoices (+ period summary) for the Transactions page.
pharmacyRoutes.get('/sales', authenticate, requirePermission('pharmacy', 'read'), validate(getPharmacySalesQuerySchema), controller.getPharmacySales);
// Void a counter sale: restore stock + reverse payment (pharmacy_admin only).
pharmacyRoutes.patch('/sales/:id/cancel', authenticate, requirePermission('pharmacy', 'approve'), validate(cancelSaleSchema), controller.cancelPharmacySale);
pharmacyRoutes.get('/sales/:id', authenticate, requirePermission('pharmacy', 'read'), validate(saleIdParamSchema), controller.getPharmacySale);

// --- Dispensing ---
pharmacyRoutes.post('/dispensing', authenticate, requirePermission('pharmacy', 'create'), validate(createDispenseSchema), controller.createDispense);
// SOW-literal alias: POST /pharmacy/dispense (same as /dispensing).
pharmacyRoutes.post('/dispense', authenticate, requirePermission('pharmacy', 'create'), validate(createDispenseSchema), controller.createDispense);
pharmacyRoutes.get('/dispensing', authenticate, requirePermission('pharmacy', 'create'), validate(getDispenseQuerySchema), controller.getDispenseRecords);
pharmacyRoutes.get('/dispensing/:id', authenticate, requirePermission('pharmacy', 'read'), validate(dispenseIdParamSchema), controller.getDispenseById);
pharmacyRoutes.patch('/dispensing/:id/verify', authenticate, requirePermission('pharmacy', 'approve'), validate(dispenseIdParamSchema), controller.verifyDispense);

// --- G12: ward→pharmacy order fulfilment status (Ordered→Preparing→Ready→Collected) ---
pharmacyRoutes.patch('/queue/:id/status', authenticate, requirePermission('pharmacy', 'update'), validate(setPharmacyStatusSchema), controller.setPrescriptionPharmacyStatus);

// --- Analytics (sales / expiry / stock usage / batch summary for the Reports page) ---
pharmacyRoutes.get('/analytics', authenticate, requirePermission('pharmacy', 'read'), controller.getPharmacyAnalytics);

// --- Stock ledger (batch-wise movement register: receipts / dispenses / returns) ---
pharmacyRoutes.get('/stock-ledger', authenticate, requirePermission('pharmacy', 'read'), validate(getStockLedgerQuerySchema), controller.getStockLedger);

// --- Returns ---
pharmacyRoutes.post('/returns', authenticate, requirePermission('pharmacy', 'create'), validate(createReturnSchema), controller.createReturn);
// SOW-literal alias: POST /pharmacy/vendor-returns (vendor return; admin-only).
pharmacyRoutes.post('/vendor-returns', authenticate, requirePermission('pharmacy', 'create'), validate(createVendorReturnSchema), controller.createVendorReturn);
pharmacyRoutes.get('/returns', authenticate, requirePermission('pharmacy', 'read'), validate(getReturnsQuerySchema), controller.getReturns);
// Returnable counter-sale lines for a patient (patient-return picker).
pharmacyRoutes.get('/returnable', authenticate, requirePermission('pharmacy', 'read'), validate(returnableQuerySchema), controller.getReturnableDispenses);
// Full return record for the printable acknowledgement receipt (G3).
pharmacyRoutes.get('/returns/:id', authenticate, requirePermission('pharmacy', 'read'), validate(returnIdParamSchema), controller.getReturnById);
pharmacyRoutes.patch('/returns/:id/process', authenticate, requirePermission('pharmacy', 'approve'), validate(processReturnSchema), controller.processReturn);

// --- Recall Management ---
pharmacyRoutes.get('/recalls', authenticate, requirePermission('pharmacy', 'read'), validate(getRecalledItemsQuerySchema), controller.getRecalledItems);
pharmacyRoutes.get('/recalls/batches/:id/affected-patients', authenticate, requirePermission('pharmacy', 'read'), validate(recallAffectedPatientsParamSchema), controller.getRecallAffectedPatients);
pharmacyRoutes.patch('/recalls/batches/:id', authenticate, requirePermission('pharmacy', 'approve'), validate(recallBatchSchema), controller.recallBatch);
pharmacyRoutes.delete('/recalls/batches/:id', authenticate, requirePermission('pharmacy', 'approve'), validate(unrecallBatchSchema), controller.unrecallBatch);
pharmacyRoutes.patch('/recalls/drugs/:id', authenticate, requirePermission('pharmacy', 'approve'), validate(recallDrugSchema), controller.recallDrug);

// --- GST Report ---
pharmacyRoutes.get('/gst', authenticate, requirePermission('pharmacy', 'read'), validate(getGstReportQuerySchema), controller.getGstReport);

// --- Maintenance: auto-flag expired batches (idempotent) ---
pharmacyRoutes.post('/maintenance/flag-expired', authenticate, requirePermission('pharmacy', 'approve'), controller.flagExpiredBatches);
