import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './inventory.service';

// Suppliers
export async function createSupplier(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createSupplier(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Supplier created', data });
  } catch (err) { next(err); }
}
export async function getSuppliers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getSuppliers(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.suppliers, result.total, result.page, result.limit, 'Suppliers retrieved');
  } catch (err) { next(err); }
}
export async function getSupplierById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getSupplierById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Supplier retrieved', data });
  } catch (err) { next(err); }
}
export async function updateSupplier(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateSupplier(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Supplier updated', data });
  } catch (err) { next(err); }
}
export async function deleteSupplier(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteSupplier(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Supplier deleted' });
  } catch (err) { next(err); }
}

// Items
export async function createItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createItem(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Item created', data });
  } catch (err) { next(err); }
}
export async function getItems(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getItems(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.items, result.total, result.page, result.limit, 'Items retrieved');
  } catch (err) { next(err); }
}
export async function getItemById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getItemById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Item retrieved', data });
  } catch (err) { next(err); }
}
export async function updateItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateItem(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Item updated', data });
  } catch (err) { next(err); }
}
export async function deleteItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteItem(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Item deleted' });
  } catch (err) { next(err); }
}
export async function getLowStockItems(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getLowStockItems(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Low stock items retrieved', data });
  } catch (err) { next(err); }
}

// Stock Transactions
export async function createStockTransaction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createStockTransaction(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Stock transaction recorded', data });
  } catch (err) { next(err); }
}
export async function getStockTransactions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getStockTransactions(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.transactions, result.total, result.page, result.limit, 'Transactions retrieved');
  } catch (err) { next(err); }
}
export async function getStockTransactionById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getStockTransactionById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Transaction retrieved', data });
  } catch (err) { next(err); }
}

// Purchase Orders
export async function createPurchaseOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createPurchaseOrder(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Purchase order created', data });
  } catch (err) { next(err); }
}
export async function getPurchaseOrders(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getPurchaseOrders(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.orders, result.total, result.page, result.limit, 'Purchase orders retrieved');
  } catch (err) { next(err); }
}
export async function getPurchaseOrderById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPurchaseOrderById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Purchase order retrieved', data });
  } catch (err) { next(err); }
}
export async function updatePurchaseOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updatePurchaseOrder(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Purchase order updated', data });
  } catch (err) { next(err); }
}
export async function approvePurchaseOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approvePurchaseOrder(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Purchase order approved', data });
  } catch (err) { next(err); }
}
export async function receivePurchaseOrder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.receivePurchaseOrder(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Purchase order received', data });
  } catch (err) { next(err); }
}

// Supply Requests
export async function createSupplyRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createSupplyRequest(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Supply request created', data });
  } catch (err) { next(err); }
}
export async function getSupplyRequests(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getSupplyRequests(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.requests, result.total, result.page, result.limit, 'Supply requests retrieved');
  } catch (err) { next(err); }
}
export async function getSupplyRequestById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getSupplyRequestById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Supply request retrieved', data });
  } catch (err) { next(err); }
}
export async function approveSupplyRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approveSupplyRequest(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Supply request approved', data });
  } catch (err) { next(err); }
}
export async function fulfillSupplyRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.fulfillSupplyRequest(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Supply request fulfilled', data });
  } catch (err) { next(err); }
}
