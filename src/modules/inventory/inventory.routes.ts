import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  idParamSchema,
  createSupplierSchema,
  updateSupplierSchema,
  getSuppliersQuerySchema,
  createItemSchema,
  updateItemSchema,
  getItemsQuerySchema,
  getLowStockQuerySchema,
  getExpiringQuerySchema,
  getUnifiedStockQuerySchema,
  createUnifiedStockSchema,
  createStockTransactionSchema,
  stockMovementSchema,
  getStockTransactionsQuerySchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  getPurchaseOrdersQuerySchema,
  approvePurchaseOrderSchema,
  receivePurchaseOrderSchema,
  reconcilePurchaseOrderSchema,
  createSupplyRequestSchema,
  getSupplyRequestsQuerySchema,
  approveSupplyRequestSchema,
  fulfillSupplyRequestSchema,
  cancelPurchaseOrderSchema,
  updateInventorySettingsSchema,
  runInventoryAlertsSchema,
} from './inventory.validation';
import * as controller from './inventory.controller';
import * as reportsController from './inventory.reports.controller';
import {
  stockBalanceReportSchema,
  deptConsumptionReportSchema,
  reorderHistoryReportSchema,
  expiryWasteReportSchema,
  auditLogsReportSchema,
  createStockTransferSchema,
  listStockTransfersSchema,
  stockTransferIdSchema,
  approveStockTransferSchema,
  rejectStockTransferSchema,
  dispatchStockTransferSchema,
  cancelStockTransferSchema,
} from './inventory.reports.validation';

export const inventoryRoutes = Router();

// --- Suppliers ---
inventoryRoutes.post('/suppliers', authenticate, requirePermission('inventory', 'create'), validate(createSupplierSchema), controller.createSupplier);
inventoryRoutes.get('/suppliers', authenticate, requirePermission('inventory', 'read'), validate(getSuppliersQuerySchema), controller.getSuppliers);
inventoryRoutes.get('/suppliers/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getSupplierById);
inventoryRoutes.put('/suppliers/:id', authenticate, requirePermission('inventory', 'update'), validate(updateSupplierSchema), controller.updateSupplier);
inventoryRoutes.delete('/suppliers/:id', authenticate, requirePermission('inventory', 'delete'), validate(idParamSchema), controller.deleteSupplier);

// --- Inventory Items ---
inventoryRoutes.post('/items', authenticate, requirePermission('inventory', 'create'), validate(createItemSchema), controller.createItem);
inventoryRoutes.get('/items', authenticate, requirePermission('inventory', 'read'), validate(getItemsQuerySchema), controller.getItems);
inventoryRoutes.get('/items/low-stock', authenticate, requirePermission('inventory', 'read'), validate(getLowStockQuerySchema), controller.getLowStockItems);
inventoryRoutes.get('/items/expiring', authenticate, requirePermission('inventory', 'read'), validate(getExpiringQuerySchema), controller.getExpiringInventory);
// SOW-literal aliases: GET /inventory/low-stock and GET /inventory/expiring.
inventoryRoutes.get('/low-stock', authenticate, requirePermission('inventory', 'read'), validate(getLowStockQuerySchema), controller.getLowStockItems);
inventoryRoutes.get('/expiring', authenticate, requirePermission('inventory', 'read'), validate(getExpiringQuerySchema), controller.getExpiringInventory);
inventoryRoutes.post('/items/flag-expired', authenticate, requirePermission('inventory', 'approve'), controller.flagExpiredInventory);
// Unified stock overview (generic items + pharmacy drug stock) for the combined page.
inventoryRoutes.get('/stock-overview', authenticate, requirePermission('inventory', 'read'), controller.getStockOverview);
// One unified storage feed + create flow — generic items AND pharmacy drugs as one list.
inventoryRoutes.get('/stock', authenticate, requirePermission('inventory', 'read'), validate(getUnifiedStockQuerySchema), controller.getUnifiedStock);
inventoryRoutes.post('/stock', authenticate, requirePermission('inventory', 'create'), validate(createUnifiedStockSchema), controller.createUnifiedStock);
inventoryRoutes.get('/items/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getItemById);
inventoryRoutes.put('/items/:id', authenticate, requirePermission('inventory', 'update'), validate(updateItemSchema), controller.updateItem);
inventoryRoutes.delete('/items/:id', authenticate, requirePermission('inventory', 'delete'), validate(idParamSchema), controller.deleteItem);

// --- Stock Transactions ---
inventoryRoutes.post('/transactions', authenticate, requirePermission('inventory', 'create'), validate(createStockTransactionSchema), controller.createStockTransaction);
// SOW-literal aliases: stock-in (add) / stock-out (deduct).
inventoryRoutes.post('/stock-in', authenticate, requirePermission('inventory', 'create'), validate(stockMovementSchema), controller.stockIn);
inventoryRoutes.post('/stock-out', authenticate, requirePermission('inventory', 'create'), validate(stockMovementSchema), controller.stockOut);
inventoryRoutes.get('/transactions', authenticate, requirePermission('inventory', 'read'), validate(getStockTransactionsQuerySchema), controller.getStockTransactions);
inventoryRoutes.get('/transactions/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getStockTransactionById);

// --- Purchase Orders ---
inventoryRoutes.post('/purchase-orders', authenticate, requirePermission('inventory', 'create'), validate(createPurchaseOrderSchema), controller.createPurchaseOrder);
inventoryRoutes.get('/purchase-orders', authenticate, requirePermission('inventory', 'read'), validate(getPurchaseOrdersQuerySchema), controller.getPurchaseOrders);
inventoryRoutes.get('/purchase-orders/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getPurchaseOrderById);
inventoryRoutes.put('/purchase-orders/:id', authenticate, requirePermission('inventory', 'update'), validate(updatePurchaseOrderSchema), controller.updatePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/approve', authenticate, requirePermission('inventory', 'approve'), validate(approvePurchaseOrderSchema), controller.approvePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/receive', authenticate, requirePermission('inventory', 'update'), validate(receivePurchaseOrderSchema), controller.receivePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/reconcile', authenticate, requirePermission('inventory', 'update'), validate(reconcilePurchaseOrderSchema), controller.reconcilePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/cancel', authenticate, requirePermission('inventory', 'update'), validate(cancelPurchaseOrderSchema), controller.cancelPurchaseOrder);

// --- Settings & Alerts (per-tenant module config + "alert inventory manager") ---
inventoryRoutes.get('/settings', authenticate, requirePermission('inventory', 'read'), controller.getInventorySettings);
inventoryRoutes.put('/settings', authenticate, requirePermission('inventory', 'update'), validate(updateInventorySettingsSchema), controller.updateInventorySettings);
inventoryRoutes.post('/alerts/run', authenticate, requirePermission('inventory', 'update'), validate(runInventoryAlertsSchema), controller.runInventoryAlerts);

// --- Reports (Week 10) ---
// Stock balance / dept consumption / reorder history / expiry-waste / audit logs.
// All are read-only and require `inventory:read`; access is further scoped per
// tenant inside the service.
inventoryRoutes.get('/reports/detailed', authenticate, requirePermission('inventory', 'read'), reportsController.detailedReport);
inventoryRoutes.get('/reports/stock-balance', authenticate, requirePermission('inventory', 'read'), validate(stockBalanceReportSchema), reportsController.stockBalanceReport);
inventoryRoutes.get('/reports/dept-consumption', authenticate, requirePermission('inventory', 'read'), validate(deptConsumptionReportSchema), reportsController.deptConsumptionReport);
inventoryRoutes.get('/reports/reorder-history', authenticate, requirePermission('inventory', 'read'), validate(reorderHistoryReportSchema), reportsController.reorderHistoryReport);
inventoryRoutes.get('/reports/expiry-waste', authenticate, requirePermission('inventory', 'read'), validate(expiryWasteReportSchema), reportsController.expiryWasteReport);
inventoryRoutes.get('/reports/audit-logs', authenticate, requirePermission('inventory', 'read'), validate(auditLogsReportSchema), reportsController.auditLogsReport);

// --- Stock Transfers (Week 10) ---
inventoryRoutes.post('/transfers', authenticate, requirePermission('inventory', 'create'), validate(createStockTransferSchema), reportsController.createTransfer);
inventoryRoutes.get('/transfers', authenticate, requirePermission('inventory', 'read'), validate(listStockTransfersSchema), reportsController.listTransfers);
inventoryRoutes.get('/transfers/:id', authenticate, requirePermission('inventory', 'read'), validate(stockTransferIdSchema), reportsController.getTransfer);
inventoryRoutes.patch('/transfers/:id/approve', authenticate, requirePermission('inventory', 'approve'), validate(approveStockTransferSchema), reportsController.approveTransfer);
inventoryRoutes.patch('/transfers/:id/reject', authenticate, requirePermission('inventory', 'approve'), validate(rejectStockTransferSchema), reportsController.rejectTransfer);
inventoryRoutes.patch('/transfers/:id/dispatch', authenticate, requirePermission('inventory', 'update'), validate(dispatchStockTransferSchema), reportsController.dispatchTransfer);
inventoryRoutes.patch('/transfers/:id/receive', authenticate, requirePermission('inventory', 'update'), validate(stockTransferIdSchema), reportsController.receiveTransfer);
inventoryRoutes.patch('/transfers/:id/cancel', authenticate, requirePermission('inventory', 'update'), validate(cancelStockTransferSchema), reportsController.cancelTransfer);

// --- Supply Requests ---
inventoryRoutes.post('/supply-requests', authenticate, requirePermission('inventory', 'create'), validate(createSupplyRequestSchema), controller.createSupplyRequest);
inventoryRoutes.get('/supply-requests', authenticate, requirePermission('inventory', 'read'), validate(getSupplyRequestsQuerySchema), controller.getSupplyRequests);
inventoryRoutes.get('/supply-requests/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getSupplyRequestById);
inventoryRoutes.patch('/supply-requests/:id/approve', authenticate, requirePermission('inventory', 'approve'), validate(approveSupplyRequestSchema), controller.approveSupplyRequest);
inventoryRoutes.patch('/supply-requests/:id/fulfill', authenticate, requirePermission('inventory', 'update'), validate(fulfillSupplyRequestSchema), controller.fulfillSupplyRequest);
