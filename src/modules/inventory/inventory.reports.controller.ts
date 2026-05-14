import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as reports from './inventory.reports.service';
import * as transfers from './inventory.transfer.service';

export async function stockBalanceReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await reports.getStockBalanceReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Stock balance report', data });
  } catch (err) { next(err); }
}

export async function deptConsumptionReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await reports.getDepartmentConsumptionReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Department consumption report', data });
  } catch (err) { next(err); }
}

export async function reorderHistoryReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await reports.getReorderHistoryReport(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, data.orders, data.total, data.page, data.limit, 'Reorder history');
  } catch (err) { next(err); }
}

export async function expiryWasteReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await reports.getExpiryWasteReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Expiry & waste report', data });
  } catch (err) { next(err); }
}

export async function auditLogsReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await reports.getInventoryAuditLogs(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, data.logs, data.total, data.page, data.limit, 'Inventory audit logs');
  } catch (err) { next(err); }
}

// --- Stock transfers ---

export async function createTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.createStockTransfer(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Stock transfer created', data });
  } catch (err) { next(err); }
}

export async function listTransfers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await transfers.listStockTransfers(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.transfers, result.total, result.page, result.limit, 'Stock transfers');
  } catch (err) { next(err); }
}

export async function getTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.getStockTransferById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Stock transfer', data });
  } catch (err) { next(err); }
}

export async function approveTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.approveStockTransfer(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.notes,
    );
    sendResponse({ res, message: 'Stock transfer approved', data });
  } catch (err) { next(err); }
}

export async function rejectTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.rejectStockTransfer(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.rejectionReason ?? 'Rejected',
    );
    sendResponse({ res, message: 'Stock transfer rejected', data });
  } catch (err) { next(err); }
}

export async function dispatchTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.dispatchStockTransfer(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.quantityDispatched,
    );
    sendResponse({ res, message: 'Stock transfer dispatched', data });
  } catch (err) { next(err); }
}

export async function receiveTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.receiveStockTransfer(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
    );
    sendResponse({ res, message: 'Stock transfer received', data });
  } catch (err) { next(err); }
}

export async function cancelTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await transfers.cancelStockTransfer(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body?.reason,
    );
    sendResponse({ res, message: 'Stock transfer cancelled', data });
  } catch (err) { next(err); }
}
