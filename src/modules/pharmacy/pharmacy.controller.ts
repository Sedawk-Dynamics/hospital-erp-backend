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
    const category = await pharmacyService.createDrugCategory(tenantId, req.body);
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
    const item = await pharmacyService.createFormularyItem(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Formulary item created successfully',
      data: item,
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
    const batch = await pharmacyService.createBatch(tenantId, req.body);
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
    const batch = await pharmacyService.updateBatch(tenantId, req.params.id as string, req.body);
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
    const drugReturn = await pharmacyService.createReturn(tenantId, req.body);
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
