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
  createStockTransactionSchema,
  getStockTransactionsQuerySchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  getPurchaseOrdersQuerySchema,
  approvePurchaseOrderSchema,
  receivePurchaseOrderSchema,
  createSupplyRequestSchema,
  getSupplyRequestsQuerySchema,
  approveSupplyRequestSchema,
  fulfillSupplyRequestSchema,
} from './inventory.validation';
import * as controller from './inventory.controller';

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
inventoryRoutes.post('/items/flag-expired', authenticate, requirePermission('inventory', 'approve'), controller.flagExpiredInventory);
inventoryRoutes.get('/items/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getItemById);
inventoryRoutes.put('/items/:id', authenticate, requirePermission('inventory', 'update'), validate(updateItemSchema), controller.updateItem);
inventoryRoutes.delete('/items/:id', authenticate, requirePermission('inventory', 'delete'), validate(idParamSchema), controller.deleteItem);

// --- Stock Transactions ---
inventoryRoutes.post('/transactions', authenticate, requirePermission('inventory', 'create'), validate(createStockTransactionSchema), controller.createStockTransaction);
inventoryRoutes.get('/transactions', authenticate, requirePermission('inventory', 'read'), validate(getStockTransactionsQuerySchema), controller.getStockTransactions);
inventoryRoutes.get('/transactions/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getStockTransactionById);

// --- Purchase Orders ---
inventoryRoutes.post('/purchase-orders', authenticate, requirePermission('inventory', 'create'), validate(createPurchaseOrderSchema), controller.createPurchaseOrder);
inventoryRoutes.get('/purchase-orders', authenticate, requirePermission('inventory', 'read'), validate(getPurchaseOrdersQuerySchema), controller.getPurchaseOrders);
inventoryRoutes.get('/purchase-orders/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getPurchaseOrderById);
inventoryRoutes.put('/purchase-orders/:id', authenticate, requirePermission('inventory', 'update'), validate(updatePurchaseOrderSchema), controller.updatePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/approve', authenticate, requirePermission('inventory', 'approve'), validate(approvePurchaseOrderSchema), controller.approvePurchaseOrder);
inventoryRoutes.patch('/purchase-orders/:id/receive', authenticate, requirePermission('inventory', 'update'), validate(receivePurchaseOrderSchema), controller.receivePurchaseOrder);

// --- Supply Requests ---
inventoryRoutes.post('/supply-requests', authenticate, requirePermission('inventory', 'create'), validate(createSupplyRequestSchema), controller.createSupplyRequest);
inventoryRoutes.get('/supply-requests', authenticate, requirePermission('inventory', 'read'), validate(getSupplyRequestsQuerySchema), controller.getSupplyRequests);
inventoryRoutes.get('/supply-requests/:id', authenticate, requirePermission('inventory', 'read'), validate(idParamSchema), controller.getSupplyRequestById);
inventoryRoutes.patch('/supply-requests/:id/approve', authenticate, requirePermission('inventory', 'approve'), validate(approveSupplyRequestSchema), controller.approveSupplyRequest);
inventoryRoutes.patch('/supply-requests/:id/fulfill', authenticate, requirePermission('inventory', 'update'), validate(fulfillSupplyRequestSchema), controller.fulfillSupplyRequest);
