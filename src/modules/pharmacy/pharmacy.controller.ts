import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as pharmacyService from './pharmacy.service';

// ============================================================
// Drug Categories
// ============================================================

export async function createDrugCategory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const category = await pharmacyService.createDrugCategory(tenantId, req.user!.roles ?? [], req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Drug category created successfully',
      data: category,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDrugCategories(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { categories, total, page, limit } = await pharmacyService.getDrugCategories(
      tenantId,
      req.query,
    );
    sendPaginatedResponse(res, categories, total, page, limit, 'Drug categories retrieved');
  } catch (err) {
    next(err);
  }
}

export async function updateDrugCategory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const category = await pharmacyService.updateDrugCategory(
      tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Drug category updated successfully',
      data: category,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteDrugCategory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await pharmacyService.deleteDrugCategory(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Drug category deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Formulary
// ============================================================

export async function createFormularyItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pharmacyService.createFormularyItem(
      tenantId,
      req.user!.roles ?? [],
      req.body,
    );
    // G1: a high-confidence near-duplicate was found and the caller didn't force
    // creation — return 200 with the suggestions so the UI can prompt the user
    // to map to the existing drug instead of splitting stock.
    if (result.status === 'duplicate_suspected') {
      sendResponse({
        res,
        statusCode: 200,
        message: 'A similar drug already exists. Map to it or create anyway.',
        data: { duplicateSuspected: true, matches: result.matches },
      });
      return;
    }
    sendResponse({
      res,
      statusCode: 201,
      message: 'Formulary item created successfully',
      data: result.item,
    });
  } catch (err) {
    next(err);
  }
}

// G1: live duplicate-detection used by the inward / add-drug dialog. Returns the
// existing formulary rows most likely to be the same drug as the typed name.
export async function findFormularyMatches(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const q = req.query as Record<string, string>;
    const { matches } = await pharmacyService.findFormularyMatches(tenantId, {
      name: q.name ?? '',
      genericName: q.genericName,
      manufacturer: q.manufacturer,
      strength: q.strength,
      dosageForm: q.dosageForm,
      excludeId: q.excludeId,
    });
    sendResponse({ res, message: 'Formulary matches retrieved', data: { matches } });
  } catch (err) {
    next(err);
  }
}

// G1: bulk stock inward — score every incoming distributor-invoice line against
// the formulary so the UI can show a side-by-side "existing vs incoming" review
// before any row is committed (prevents the split-stock duplicate problem).
export async function matchInward(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.matchInwardLines(tenantId, req.body.lines, req.body.supplierId);
    sendResponse({ res, message: 'Inward lines matched', data });
  } catch (err) {
    next(err);
  }
}

// Barcode scan resolve (spec Section 2): one scan → product + batch + expiry + stock.
export async function resolveScan(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.resolveScan(req.user!.tenantId, req.query.code as string);
    sendResponse({ res, message: 'Scan resolved', data });
  } catch (err) {
    next(err);
  }
}

// Automated compliance pre-check for a cart (HSN/GST/Schedule rules).
export async function checkSaleCompliance(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.checkSaleCompliance(req.user!.tenantId, req.body);
    sendResponse({ res, message: 'Compliance check', data });
  } catch (err) {
    next(err);
  }
}

// Product Resolution Engine: list the learned distributor → product mappings.
export async function getDistributorMappings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getDistributorMappings(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Distributor mappings', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteDistributorMapping(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.deleteDistributorMapping(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
    );
    sendResponse({ res, message: 'Mapping deleted', data });
  } catch (err) {
    next(err);
  }
}

// G1: commit a reviewed bulk inward — map each line onto an existing drug or
// create a new one, then post the received stock as batches (per-line resilient).
export async function commitInward(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.commitInward(
      tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Stock inward committed', data });
  } catch (err) {
    next(err);
  }
}

// ── G15: mandatory reports ──
export async function getDailyTransactionReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getDailyTransactionReport(
      req.user!.tenantId,
      req.query.date as string | undefined,
    );
    sendResponse({ res, message: 'Daily transaction report', data });
  } catch (err) {
    next(err);
  }
}

export async function getPurchaseReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getPurchaseReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Purchase report', data });
  } catch (err) {
    next(err);
  }
}

export async function getStockValuationReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getStockValuationReport(req.user!.tenantId);
    sendResponse({ res, message: 'Stock valuation report', data });
  } catch (err) {
    next(err);
  }
}

export async function getVendorWiseReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getVendorWiseReport(
      req.user!.tenantId,
      req.query.supplierId as string | undefined,
    );
    sendResponse({ res, message: 'Vendor-wise report', data });
  } catch (err) {
    next(err);
  }
}

export async function getCreditNotesReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getCreditNotesReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Supplier credit notes report', data });
  } catch (err) {
    next(err);
  }
}

// ── G13: ward stock ──
export async function transferToWard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.transferToWard(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Stock transferred to ward', data });
  } catch (err) {
    next(err);
  }
}

export async function getWardStock(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getWardStock(req.user!.tenantId, req.query.wardId as string);
    sendResponse({ res, message: 'Ward stock retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function getCreditStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getPatientCreditStatus(req.user!.tenantId, req.query.patientId as string);
    sendResponse({ res, message: 'Credit status retrieved', data });
  } catch (err) {
    next(err);
  }
}

// §4.1 Flow 2: consolidated IP billing / TPA-submission summary for a patient.
export async function getIpBillingSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getIpBillingSummary(req.user!.tenantId, req.query.patientId as string);
    sendResponse({ res, message: 'Billing summary retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function dispenseFromWard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.dispenseFromWard(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Dispensed from ward stock', data });
  } catch (err) {
    next(err);
  }
}

export async function getWardLedger(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getWardLedger(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Ward ledger retrieved', data });
  } catch (err) {
    next(err);
  }
}

// G13: return excess / near-expiry ward stock to the central pharmacy.
export async function returnWardStock(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.returnWardStock(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Ward stock returned to central', data });
  } catch (err) {
    next(err);
  }
}

// G13: correct a ward's on-hand count (breakage / miscount).
export async function adjustWardStock(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.adjustWardStock(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, message: 'Ward stock adjusted', data });
  } catch (err) {
    next(err);
  }
}

// G9: reorder list — formulary drugs at/below their reorder level (draft PO).
export async function getReorderList(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getReorderList(req.user!.tenantId);
    sendResponse({ res, message: 'Reorder list', data });
  } catch (err) {
    next(err);
  }
}

// ── G9: draft purchase orders for drugs ──
export async function generatePurchaseOrders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.generateReorderDraftPOs(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
    );
    sendResponse({
      res,
      statusCode: 201,
      message: data.created
        ? `Generated ${data.created} draft purchase order(s)`
        : 'No new drugs to order',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDrugPurchaseOrders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getDrugPurchaseOrders(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Purchase orders retrieved', data: data.orders });
  } catch (err) {
    next(err);
  }
}

export async function getDrugPurchaseOrderById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getDrugPurchaseOrderById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Purchase order retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function updateDrugPurchaseOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.updateDrugPurchaseOrder(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Purchase order updated', data });
  } catch (err) {
    next(err);
  }
}

export async function setDrugPurchaseOrderStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.setDrugPurchaseOrderStatus(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body.status,
    );
    sendResponse({ res, message: 'Purchase order updated', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteDrugPurchaseOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    await pharmacyService.deleteDrugPurchaseOrder(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
    );
    sendResponse({ res, message: 'Purchase order deleted' });
  } catch (err) {
    next(err);
  }
}

// G17: narcotic / controlled-drug register for a Drug Inspector audit.
export async function getNarcoticRegister(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.getNarcoticRegister(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Narcotic register', data });
  } catch (err) {
    next(err);
  }
}

// G16: mint a temporary emergency (Golden Hour) patient to dispense against.
export async function createEmergencyPatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const patient = await pharmacyService.createEmergencyPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Emergency patient created', data: patient });
  } catch (err) {
    next(err);
  }
}

// G16: list active emergency temp patients + their held pharmacy charges.
export async function listEmergencyPatients(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.listEmergencyPatients(req.user!.tenantId);
    sendResponse({ res, message: 'Emergency patients retrieved', data });
  } catch (err) {
    next(err);
  }
}

// G16: merge a temp emergency patient's pharmacy history into a permanent MRN.
export async function mergeEmergencyPatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await pharmacyService.mergeEmergencyPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body.targetPatientId as string,
    );
    sendResponse({ res, message: 'Emergency record merged', data });
  } catch (err) {
    next(err);
  }
}

// G12: advance an IP prescription through the ward→pharmacy fulfilment lifecycle.
export async function setPrescriptionPharmacyStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.setPrescriptionPharmacyStatus(
      tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body.status,
    );
    sendResponse({ res, message: 'Order status updated', data });
  } catch (err) {
    next(err);
  }
}

// G8: alternative brands sharing this drug's composition (for out-of-stock swaps).
export async function getFormularyAlternatives(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getFormularyAlternatives(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Alternatives retrieved', data });
  } catch (err) {
    next(err);
  }
}

// G1: consolidate stock that already split across two near-duplicate rows by
// merging the source drug into the target (repoints batches + history).
export async function mergeFormularyItems(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pharmacyService.mergeFormularyItems(
      tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body.sourceId as string,
    );
    sendResponse({ res, message: 'Drugs merged successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function importFormularyItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pharmacyService.importFormularyItem(tenantId, req.user!.roles ?? [], req.body);
    sendResponse({
      res,
      statusCode: result.status === 'created' ? 201 : 200,
      message:
        result.status === 'created'
          ? 'Drug imported into formulary'
          : 'Drug already in formulary',
      data: result.item,
    });
  } catch (err) {
    next(err);
  }
}

export async function getTenantCatalog(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { items, total, page, limit } = await pharmacyService.getTenantCatalog(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Drug catalog retrieved');
  } catch (err) {
    next(err);
  }
}

export async function importFormularyItemsBulk(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pharmacyService.importFormularyItemsBulk(
      tenantId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: `Imported ${result.created} drug(s)${result.skipped ? `, ${result.skipped} already in formulary` : ''}`,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getFormulary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { items, total, page, limit } = await pharmacyService.getFormulary(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Formulary items retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getFormularyItemById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await pharmacyService.getFormularyItemById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Formulary item retrieved successfully',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateFormularyItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await pharmacyService.updateFormularyItem(
      tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Formulary item updated successfully',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteFormularyItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await pharmacyService.deleteFormularyItem(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Formulary item deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Batches
// ============================================================

export async function createBatch(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const batch = await pharmacyService.createBatch(tenantId, req.user!.userId, req.user!.roles ?? [], req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Drug batch created successfully',
      data: batch,
    });
  } catch (err) {
    next(err);
  }
}

export async function getBatches(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { batches, total, page, limit } = await pharmacyService.getBatches(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, batches, total, page, limit, 'Drug batches retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getBatchById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const batch = await pharmacyService.getBatchById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Drug batch retrieved successfully',
      data: batch,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateBatch(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const batch = await pharmacyService.updateBatch(tenantId, req.user!.roles ?? [], req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Drug batch updated successfully',
      data: batch,
    });
  } catch (err) {
    next(err);
  }
}

// G4: deliberate stock-count correction (reason-stamped + audited).
export async function adjustBatchStock(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pharmacyService.adjustBatchStock(
      tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Stock adjusted successfully', data: result });
  } catch (err) {
    next(err);
  }
}

// G4: reconcile a physical stock-take — apply each counted variance as an
// audited correction (per-line resilient) and return a matched/adjusted summary.
export async function reconcileStockTake(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.reconcileStockTake(
      tenantId,
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, message: 'Stock-take reconciled', data });
  } catch (err) {
    next(err);
  }
}

// G4: stock discrepancy report — manual corrections in a date window.
export async function getStockAdjustments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { items, total, page, limit } = await pharmacyService.getStockAdjustments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Stock adjustments retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getExpiringBatches(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { batches, total, page, limit } = await pharmacyService.getExpiringBatches(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, batches, total, page, limit, 'Expiring batches retrieved');
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Dispensing
// ============================================================

export async function createDispense(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await pharmacyService.createDispense(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Drug dispensed successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

// Counter billing — bill a whole cart as one invoice (partial / loose / walk-in).
export async function createPharmacySale(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const sale = await pharmacyService.createPharmacySale(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Pharmacy bill created successfully',
      data: sale,
    });
  } catch (err) {
    next(err);
  }
}

export async function getPharmacySale(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const sale = await pharmacyService.getPharmacySale(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Pharmacy bill retrieved successfully', data: sale });
  } catch (err) {
    next(err);
  }
}

export async function getPharmacySales(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { bills, total, page, limit, summary } = await pharmacyService.getPharmacySales(
      tenantId,
      req.query as any,
    );
    // Pagination meta + a period summary the Transactions page renders as cards.
    sendResponse({
      res,
      message: 'Pharmacy sales retrieved',
      data: bills,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        summary,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelPharmacySale(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const sale = await pharmacyService.cancelPharmacySale(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Pharmacy bill cancelled successfully', data: sale });
  } catch (err) {
    next(err);
  }
}

export async function getDispenseRecords(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { records, total, page, limit } = await pharmacyService.getDispenseRecords(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, records, total, page, limit, 'Dispensing records retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getDispenseById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const record = await pharmacyService.getDispenseById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Dispensing record retrieved successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

export async function verifyDispense(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await pharmacyService.verifyDispense(tenantId, req.params.id as string, userId);
    sendResponse({
      res,
      message: 'Dispensing record verified successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Returns
// ============================================================

export async function createReturn(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const drugReturn = await pharmacyService.createReturn(tenantId, req.user!.userId, req.user!.roles ?? [], req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Drug return created successfully',
      data: drugReturn,
    });
  } catch (err) {
    next(err);
  }
}

// SOW-literal: POST /pharmacy/vendor-returns — injects returnType=vendor_return.
export async function createVendorReturn(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const drugReturn = await pharmacyService.createReturn(tenantId, req.user!.userId, req.user!.roles ?? [], {
      ...req.body,
      returnType: 'vendor_return',
    });
    sendResponse({
      res,
      statusCode: 201,
      message: 'Vendor return logged successfully',
      data: drugReturn,
    });
  } catch (err) {
    next(err);
  }
}

export async function getReturns(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { returns, total, page, limit } = await pharmacyService.getReturns(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, returns, total, page, limit, 'Drug returns retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getReturnableDispenses(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getReturnableDispenses(tenantId, {
      patientId: req.query.patientId as string | undefined,
      billNumber: req.query.billNumber as string | undefined,
    });
    sendResponse({ res, message: 'Returnable sale lines retrieved', data });
  } catch (err) {
    next(err);
  }
}

// G3: full return record + hospital header for the printable acknowledgement.
export async function getReturnById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getReturnById(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Return retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function processReturn(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const drugReturn = await pharmacyService.processReturn(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({
      res,
      message: 'Drug return processed successfully',
      data: drugReturn,
    });
  } catch (err) {
    next(err);
  }
}

export async function getStockLedger(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getStockLedger(tenantId, req.query as any);
    sendResponse({ res, message: 'Stock ledger retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}

export async function getPharmacyAnalytics(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getPharmacyAnalytics(tenantId, {
      fromDate: req.query.fromDate as string | undefined,
      toDate: req.query.toDate as string | undefined,
    });
    sendResponse({ res, message: 'Pharmacy analytics retrieved successfully', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Recall Management
// ============================================================

export async function recallBatch(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await pharmacyService.recallBatch(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({ res, message: 'Batch recalled successfully', data });
  } catch (err) {
    next(err);
  }
}

export async function unrecallBatch(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.unrecallBatch(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Batch unmarked from recall', data });
  } catch (err) {
    next(err);
  }
}

export async function recallDrug(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await pharmacyService.recallDrug(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({ res, message: 'Drug recalled (all batches)', data });
  } catch (err) {
    next(err);
  }
}

export async function getRecallAffectedPatients(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getRecallAffectedPatients(
      tenantId,
      req.params.id as string,
    );
    sendResponse({ res, message: 'Recall affected patients retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function getRecalledItems(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getRecalledItems(tenantId, req.query as any);
    sendResponse({ res, message: 'Recalled items retrieved', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// GST Report
// ============================================================

export async function getGstReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.getGstReport(tenantId, req.query as any);
    sendResponse({ res, message: 'GST report retrieved', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Maintenance: flag expired batches
// ============================================================

export async function flagExpiredBatches(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.flagExpiredBatches(tenantId);
    sendResponse({ res, message: 'Expired batches flagged', data });
  } catch (err) {
    next(err);
  }
}

// G5: manual "run expiry check now" — flags expired batches + dispatches
// near-expiry alerts to the configured recipients (the daily job does this
// automatically; this lets an admin trigger it on demand).
export async function runPharmacyExpiryAlerts(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await pharmacyService.runPharmacyExpiryAlerts(tenantId, req.user!.userId, {
      force: true,
    });
    sendResponse({ res, message: 'Expiry check complete', data });
  } catch (err) {
    next(err);
  }
}
