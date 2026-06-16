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
