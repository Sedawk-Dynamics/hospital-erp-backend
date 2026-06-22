import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { uploadSingle } from '../../services/upload.service';
import type { AuthenticatedRequest } from '../../shared/types';
import * as controller from './pharmacy.controller';
import {
  createCategorySchema,
  getCategoriesQuerySchema,
  updateCategorySchema,
  categoryIdParamSchema,
  createFormularySchema,
  findFormularyMatchesSchema,
  mergeFormularySchema,
  matchInwardSchema,
  commitInwardSchema,
  inwardScanQuerySchema,
  attachBarcodeSchema,
  distributorMappingsQuerySchema,
  scanQuerySchema,
  complianceCheckSchema,
  prePackHoldSchema,
  collectHoldSchema,
  holdsQuerySchema,
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
  stockTakeReconcileSchema,
  getStockAdjustmentsQuerySchema,
  createDispenseSchema,
  setPharmacyStatusSchema,
  createEmergencyPatientSchema,
  mergeEmergencyPatientSchema,
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
  dailyTransactionQuerySchema,
  purchaseReportQuerySchema,
  vendorWiseQuerySchema,
  creditNotesQuerySchema,
  narcoticRegisterQuerySchema,
  getDrugPurchaseOrdersQuerySchema,
  drugPurchaseOrderIdParamSchema,
  updateDrugPurchaseOrderSchema,
  setDrugPurchaseOrderStatusSchema,
  wardStockTransferSchema,
  wardStockDispenseSchema,
  wardStockReturnSchema,
  wardStockAdjustSchema,
  wardStockQuerySchema,
  wardLedgerQuerySchema,
  creditStatusQuerySchema,
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
// G4: physical stock-take — reconcile counted quantities into audited corrections.
pharmacyRoutes.post('/stock-take/reconcile', authenticate, requirePermission('pharmacy', 'update'), validate(stockTakeReconcileSchema), controller.reconcileStockTake);

// --- G1: bulk stock inward (CSV / OCR / manual multi-row) ---
// Step 1 scores incoming distributor-invoice lines against the formulary (read);
// step 2 commits the reviewed map-or-create decisions and posts the stock.
pharmacyRoutes.post('/inward/match', authenticate, requirePermission('pharmacy', 'read'), validate(matchInwardSchema), controller.matchInward);
pharmacyRoutes.post('/inward/commit', authenticate, requirePermission('pharmacy', 'create'), validate(commitInwardSchema), controller.commitInward);
// OCR a supplier invoice photo/PDF into inward lines (multipart field: "invoice").
// The file is read by Gemini, then scored by the same matcher as /inward/match.
pharmacyRoutes.post(
  '/inward/ocr',
  authenticate,
  requirePermission('pharmacy', 'create'),
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => uploadSingle('invoice')(req as any, res, next as any),
  controller.ocrInward,
);
// Resolve a barcode/GS1 scan at stock entry → a draft inward line (drug identity
// + batch/expiry parsed off the pack). Read-only lookup, hence 'read'.
pharmacyRoutes.get('/inward/scan', authenticate, requirePermission('pharmacy', 'read'), validate(inwardScanQuerySchema), controller.resolveInwardScan);
// Remember an unknown barcode against a chosen drug (stock-entry fallback).
pharmacyRoutes.post('/barcodes/attach', authenticate, requirePermission('pharmacy', 'update'), validate(attachBarcodeSchema), controller.attachBarcode);

// --- OP pre-packing: Stock Hold / Pre-Packed (spec OP Step 1) ---
pharmacyRoutes.get('/holds', authenticate, requirePermission('pharmacy', 'read'), validate(holdsQuerySchema), controller.listStockHolds);
pharmacyRoutes.post('/holds', authenticate, requirePermission('pharmacy', 'create'), validate(prePackHoldSchema), controller.prePackHold);
pharmacyRoutes.patch('/holds/:id/collect', authenticate, requirePermission('pharmacy', 'create'), validate(collectHoldSchema), controller.collectHold);
pharmacyRoutes.patch('/holds/:id/release', authenticate, requirePermission('pharmacy', 'update'), controller.releaseHold);

// --- Barcode-driven dispensing + automated compliance (spec Section 2) ---
pharmacyRoutes.get('/scan', authenticate, requirePermission('pharmacy', 'read'), validate(scanQuerySchema), controller.resolveScan);
pharmacyRoutes.post('/sales/compliance-check', authenticate, requirePermission('pharmacy', 'read'), validate(complianceCheckSchema), controller.checkSaleCompliance);

// --- Product Resolution Engine: learned distributor → product mappings ---
pharmacyRoutes.get('/distributor-mappings', authenticate, requirePermission('pharmacy', 'read'), validate(distributorMappingsQuerySchema), controller.getDistributorMappings);
pharmacyRoutes.delete('/distributor-mappings/:id', authenticate, requirePermission('pharmacy', 'delete'), controller.deleteDistributorMapping);

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

// --- G13: Ward stock (central pharmacy → ward, ward → patient, ward ledger) ---
pharmacyRoutes.get('/ward-stock', authenticate, requirePermission('pharmacy', 'read'), validate(wardStockQuerySchema), controller.getWardStock);
pharmacyRoutes.get('/ward-stock/ledger', authenticate, requirePermission('pharmacy', 'read'), validate(wardLedgerQuerySchema), controller.getWardLedger);
pharmacyRoutes.post('/ward-stock/transfer', authenticate, requirePermission('pharmacy', 'create'), validate(wardStockTransferSchema), controller.transferToWard);
pharmacyRoutes.post('/ward-stock/dispense', authenticate, requirePermission('pharmacy', 'create'), validate(wardStockDispenseSchema), controller.dispenseFromWard);
// G13: reverse flows — return excess/near-expiry ward stock to central; correct count.
pharmacyRoutes.post('/ward-stock/return', authenticate, requirePermission('pharmacy', 'create'), validate(wardStockReturnSchema), controller.returnWardStock);
pharmacyRoutes.post('/ward-stock/adjust', authenticate, requirePermission('pharmacy', 'update'), validate(wardStockAdjustSchema), controller.adjustWardStock);
// IP credit & clearance check — patient's live deposit-vs-bill picture.
pharmacyRoutes.get('/credit-status', authenticate, requirePermission('pharmacy', 'read'), validate(creditStatusQuerySchema), controller.getCreditStatus);
// §4.1 Flow 2: consolidated IP billing / TPA-submission summary for a patient.
pharmacyRoutes.get('/billing-summary', authenticate, requirePermission('pharmacy', 'read'), validate(creditStatusQuerySchema), controller.getIpBillingSummary);

// --- G16: Emergency (Golden Hour) pre-registration buffer + retrospective merge ---
pharmacyRoutes.post('/emergency-patients', authenticate, requirePermission('pharmacy', 'create'), validate(createEmergencyPatientSchema), controller.createEmergencyPatient);
pharmacyRoutes.get('/emergency-patients', authenticate, requirePermission('pharmacy', 'read'), controller.listEmergencyPatients);
pharmacyRoutes.post('/emergency-patients/:id/merge', authenticate, requirePermission('pharmacy', 'update'), validate(mergeEmergencyPatientSchema), controller.mergeEmergencyPatient);

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

// --- G15: mandatory reports (Daily Txn / Purchase / Stock Valuation / Vendor-wise / Credit Notes) ---
pharmacyRoutes.get('/reports/daily-transactions', authenticate, requirePermission('pharmacy', 'read'), validate(dailyTransactionQuerySchema), controller.getDailyTransactionReport);
pharmacyRoutes.get('/reports/purchases', authenticate, requirePermission('pharmacy', 'read'), validate(purchaseReportQuerySchema), controller.getPurchaseReport);
pharmacyRoutes.get('/reports/stock-valuation', authenticate, requirePermission('pharmacy', 'read'), controller.getStockValuationReport);
pharmacyRoutes.get('/reports/vendor-wise', authenticate, requirePermission('pharmacy', 'read'), validate(vendorWiseQuerySchema), controller.getVendorWiseReport);
pharmacyRoutes.get('/reports/credit-notes', authenticate, requirePermission('pharmacy', 'read'), validate(creditNotesQuerySchema), controller.getCreditNotesReport);
// G17: narcotic / controlled-drug register (DI audit) — filter by user + date.
pharmacyRoutes.get('/reports/narcotic-register', authenticate, requirePermission('pharmacy', 'read'), validate(narcoticRegisterQuerySchema), controller.getNarcoticRegister);
// G9: reorder list — drugs at/below their reorder level (draft purchase order).
pharmacyRoutes.get('/reports/reorder', authenticate, requirePermission('pharmacy', 'read'), controller.getReorderList);

// --- G9: draft purchase orders for drugs (generate from reorder → review → send) ---
// "generate" + "/:id" — declare the static path first so it isn't read as an :id.
pharmacyRoutes.post('/purchase-orders/generate', authenticate, requirePermission('pharmacy', 'create'), controller.generatePurchaseOrders);
pharmacyRoutes.get('/purchase-orders', authenticate, requirePermission('pharmacy', 'read'), validate(getDrugPurchaseOrdersQuerySchema), controller.getDrugPurchaseOrders);
pharmacyRoutes.get('/purchase-orders/:id', authenticate, requirePermission('pharmacy', 'read'), validate(drugPurchaseOrderIdParamSchema), controller.getDrugPurchaseOrderById);
pharmacyRoutes.put('/purchase-orders/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateDrugPurchaseOrderSchema), controller.updateDrugPurchaseOrder);
pharmacyRoutes.patch('/purchase-orders/:id/status', authenticate, requirePermission('pharmacy', 'update'), validate(setDrugPurchaseOrderStatusSchema), controller.setDrugPurchaseOrderStatus);
pharmacyRoutes.delete('/purchase-orders/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(drugPurchaseOrderIdParamSchema), controller.deleteDrugPurchaseOrder);

// --- Maintenance: auto-flag expired batches (idempotent) ---
pharmacyRoutes.post('/maintenance/flag-expired', authenticate, requirePermission('pharmacy', 'approve'), controller.flagExpiredBatches);
// G5: run the full expiry check now — flag expired + dispatch near-expiry alerts.
pharmacyRoutes.post('/maintenance/run-expiry-alerts', authenticate, requirePermission('pharmacy', 'approve'), controller.runPharmacyExpiryAlerts);
