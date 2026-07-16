import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Shared param schemas
// ============================================================

export const idParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID'),
  }),
});

// ============================================================
// Suppliers
// ============================================================

export const createSupplierSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Supplier name is required').max(255),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').max(255).optional(),
    address: z.string().max(1000).optional(),
    gstNumber: z.string().max(50).optional(),
    licenseNumber: z.string().max(100).optional(),
    supplyType: z.enum(['drugs', 'consumables', 'equipment', 'all']).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateSupplierSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    phone: z.string().max(20).optional().nullable(),
    email: z.string().email('Invalid email').max(255).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    gstNumber: z.string().max(50).optional().nullable(),
    licenseNumber: z.string().max(100).optional().nullable(),
    supplyType: z.enum(['drugs', 'consumables', 'equipment', 'all']).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid supplier ID'),
  }),
});

export const getSuppliersQuerySchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    supplyType: z.enum(['drugs', 'consumables', 'equipment', 'all']).optional(),
  }),
});

// ============================================================
// Inventory Items
// ============================================================

export const createItemSchema = z.object({
  body: z.object({
    itemName: z.string().min(1, 'Item name is required').max(255),
    itemCode: z.string().max(50).optional(),
    category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']),
    description: z.string().max(2000).optional(),
    unitOfMeasurement: z.string().max(20).optional(),
    // Omitted → falls back to the tenant's configured default threshold.
    minimumStockThreshold: z.number().int().min(0).optional(),
    currentStock: z.number().int().min(0).default(0),
    costPerUnit: z.number().min(0).optional(),
    sellingPricePerUnit: z.number().min(0).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateItemSchema = z.object({
  body: z.object({
    itemName: z.string().min(1).max(255).optional(),
    itemCode: z.string().max(50).optional().nullable(),
    category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']).optional(),
    description: z.string().max(2000).optional().nullable(),
    unitOfMeasurement: z.string().max(20).optional().nullable(),
    minimumStockThreshold: z.number().int().min(0).optional(),
    costPerUnit: z.number().min(0).optional().nullable(),
    sellingPricePerUnit: z.number().min(0).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid item ID'),
  }),
});

export const getItemsQuerySchema = z.object({
  query: paginationSchema.extend({
    category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']).optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    wardId: z.string().uuid().optional(),
    search: z.string().max(255).optional(),
  }),
});

export const getLowStockQuerySchema = z.object({
  query: paginationSchema,
});

// Unified storage feed: generic items + pharmacy drugs in one list.
export const getUnifiedStockQuerySchema = z.object({
  query: paginationSchema.extend({
    search: z.string().max(255).optional(),
    type: z.enum(['all', 'item', 'drug']).optional(),
    category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']).optional(),
    stockStatus: z.enum(['all', 'low', 'out', 'expiring', 'in', 'recalled']).optional(),
  }),
});

// Unified "New Item" — one create flow for a generic item OR a batch-tracked drug.
export const createUnifiedStockSchema = z.object({
  body: z
    .object({
      kind: z.enum(['item', 'drug']),
      force: z.boolean().optional(),
      item: z
        .object({
          itemName: z.string().min(1).max(255),
          itemCode: z.string().max(50).optional(),
          category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']),
          description: z.string().max(2000).optional(),
          unitOfMeasurement: z.string().max(20).optional(),
          minimumStockThreshold: z.number().int().min(0).optional(),
          currentStock: z.number().int().min(0).default(0),
          costPerUnit: z.number().min(0).optional(),
          sellingPricePerUnit: z.number().min(0).optional(),
        })
        .optional(),
      drug: z
        .object({
          drugName: z.string().min(1).max(255),
          genericName: z.string().max(255).optional(),
          manufacturer: z.string().max(255).optional(),
          dosageForm: z
            .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
            .optional(),
          strength: z.string().max(100).optional(),
          unitOfMeasurement: z.string().max(20).optional(),
          looseUnitLabel: z.string().max(40).optional(),
          packSize: z.number().int().min(1).optional(),
          taxPercent: z.number().min(0).max(100).optional(),
          price: z.number().min(0).optional(),
          minStock: z.number().int().min(0).optional(),
          hsnCode: z.string().max(20).optional(),
          gtin: z.string().max(20).optional(),
          indications: z.string().max(2000).optional(),
          contraindications: z.string().max(2000).optional(),
        })
        .optional(),
    })
    .refine((b) => (b.kind === 'item' ? !!b.item : !!b.drug), {
      message: 'Provide an `item` payload for kind=item or a `drug` payload for kind=drug',
    }),
});

export const getExpiringQuerySchema = z.object({
  query: paginationSchema.extend({
    months: z.coerce.number().int().min(1).max(36).default(3),
  }),
});

// ============================================================
// Stock Transactions
// ============================================================

export const createStockTransactionSchema = z.object({
  body: z.object({
    inventoryItemId: z.string().uuid('Invalid inventory item ID'),
    transactionType: z.enum(['stock_in', 'stock_out', 'return_stock', 'adjustment', 'expired_removal']),
    quantity: z.number().int().positive('Quantity must be positive'),
    batchNumber: z.string().max(100).optional(),
    expiryDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    referenceType: z.string().max(50).optional(),
    referenceId: z.string().uuid().optional(),
    unitCost: z.number().min(0).optional(),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    notes: z.string().max(2000).optional(),
  }),
});

// SOW-literal POST /inventory/stock-in and /stock-out — same body WITHOUT
// transactionType (the route fixes the direction; controller injects it).
export const stockMovementSchema = z.object({
  body: z.object({
    inventoryItemId: z.string().uuid('Invalid inventory item ID'),
    quantity: z.number().int().positive('Quantity must be positive'),
    batchNumber: z.string().max(100).optional(),
    expiryDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    referenceType: z.string().max(50).optional(),
    referenceId: z.string().uuid().optional(),
    unitCost: z.number().min(0).optional(),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const getStockTransactionsQuerySchema = z.object({
  query: paginationSchema.extend({
    inventoryItemId: z.string().uuid().optional(),
    transactionType: z.enum(['stock_in', 'stock_out', 'return_stock', 'adjustment', 'expired_removal']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ============================================================
// Purchase Orders
// ============================================================

// A PO line references EITHER a generic inventory item OR a pharmacy drug.
const purchaseOrderLineSchema = z
  .object({
    inventoryItemId: z.string().uuid('Invalid inventory item ID').optional(),
    drugId: z.string().uuid('Invalid drug ID').optional(),
    quantityOrdered: z.number().int().positive('Quantity must be positive'),
    unitPrice: z.number().min(0).optional(),
  })
  .refine((i) => (i.inventoryItemId ? 1 : 0) + (i.drugId ? 1 : 0) === 1, {
    message: 'Each line must reference exactly one of an inventory item or a drug',
    path: ['inventoryItemId'],
  });

export const createPurchaseOrderSchema = z.object({
  body: z.object({
    supplierId: z.string().uuid('Invalid supplier ID'),
    expectedDeliveryDate: z.string().optional(),
    notes: z.string().max(2000).optional(),
    items: z.array(purchaseOrderLineSchema).min(1, 'At least one item is required'),
  }),
});

export const updatePurchaseOrderSchema = z.object({
  body: z.object({
    expectedDeliveryDate: z.string().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    items: z.array(purchaseOrderLineSchema).min(1).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid purchase order ID'),
  }),
});

export const getPurchaseOrdersQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['draft', 'submitted', 'approved', 'delivered', 'partially_delivered', 'cancelled']).optional(),
    supplierId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const approvePurchaseOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid purchase order ID'),
  }),
});

export const receivePurchaseOrderSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          purchaseOrderItemId: z.string().uuid('Invalid purchase order item ID'),
          quantityReceived: z.number().int().min(0, 'Quantity received cannot be negative'),
          // Purchase price is captured at ARRIVAL (not at PO creation). Sets the
          // stock cost / drug-batch purchase price and the PO line value.
          unitPrice: z.number().min(0).optional(),
          // For DRUG lines these create a real DrugBatch in pharmacy stock, so the
          // batch + expiry are captured at receipt (batch/expiry required when the
          // line is a drug and qty > 0 — enforced in the service).
          batchNumber: z.string().max(100).optional(),
          expiryDate: z.string().optional(),
          manufacturingDate: z.string().optional(),
          mrp: z.number().min(0).optional(),
          sellingPrice: z.number().min(0).optional(),
        }),
      )
      .min(1, 'At least one item is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid purchase order ID'),
  }),
});

// Reconcile a PO against stock already posted via the bulk-inward flow — only
// advances quantityReceived + status; no stock is posted here.
export const reconcilePurchaseOrderSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid purchase order ID') }),
  body: z.object({
    items: z
      .array(
        z.object({
          purchaseOrderItemId: z.string().uuid('Invalid purchase order item ID'),
          quantityReceived: z.number().int().min(0),
          unitPrice: z.number().min(0).optional(),
        }),
      )
      .min(1, 'At least one item is required'),
    markDelivered: z.boolean().optional(),
  }),
});

// ============================================================
// Supply Requests
// ============================================================

export const createSupplyRequestSchema = z.object({
  body: z.object({
    departmentId: z.string().uuid('Invalid department ID'),
    wardId: z.string().uuid('Invalid ward ID').optional(),
    inventoryItemId: z.string().uuid('Invalid inventory item ID'),
    quantityRequested: z.number().int().positive('Quantity must be positive'),
    urgency: z.enum(['routine', 'urgent']).default('routine'),
    notes: z.string().max(2000).optional(),
  }),
});

export const getSupplyRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['pending', 'approved', 'fulfilled', 'rejected']).optional(),
    departmentId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    urgency: z.enum(['routine', 'urgent']).optional(),
  }),
});

export const approveSupplyRequestSchema = z.object({
  body: z.object({
    status: z.enum(['approved', 'rejected']),
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid supply request ID'),
  }),
});

export const fulfillSupplyRequestSchema = z.object({
  body: z.object({
    quantityFulfilled: z.number().int().positive('Quantity must be positive'),
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid supply request ID'),
  }),
});

export const cancelPurchaseOrderSchema = z.object({
  body: z
    .object({
      reason: z.string().max(500).optional(),
    })
    .optional()
    .default({}),
  params: z.object({
    id: z.string().uuid('Invalid purchase order ID'),
  }),
});

// ============================================================
// Inventory Settings (per-tenant module configuration)
// ============================================================

export const updateInventorySettingsSchema = z.object({
  body: z.object({
    defaultLowStockThreshold: z.number().int().min(0).max(100000).optional(),
    expiryAlertMonths: z.number().int().min(1).max(36).optional(),
    lowStockAlertEnabled: z.boolean().optional(),
    expiryAlertEnabled: z.boolean().optional(),
    autoFlagExpired: z.boolean().optional(),
    preventExpiredUse: z.boolean().optional(),
    reorderNotifyEnabled: z.boolean().optional(),
    // Normalised role slugs (snake_case). Empty array = use built-in defaults.
    alertRecipientRoles: z.array(z.string().max(50)).max(30).optional(),
  }),
});

export const runInventoryAlertsSchema = z.object({
  body: z
    .object({
      autoFlagExpired: z.boolean().optional(),
    })
    .optional()
    .default({}),
});

// ============================================================
// Exported types
// ============================================================

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>['body'];
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>['body'];
export type GetSuppliersQuery = z.infer<typeof getSuppliersQuerySchema>['query'];

export type CreateItemInput = z.infer<typeof createItemSchema>['body'];
export type UpdateItemInput = z.infer<typeof updateItemSchema>['body'];
export type GetItemsQuery = z.infer<typeof getItemsQuerySchema>['query'];

export type CreateStockTransactionInput = z.infer<typeof createStockTransactionSchema>['body'];
export type GetStockTransactionsQuery = z.infer<typeof getStockTransactionsQuerySchema>['query'];

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>['body'];
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>['body'];
export type GetPurchaseOrdersQuery = z.infer<typeof getPurchaseOrdersQuerySchema>['query'];
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>['body'];

export type GetExpiringQuery = z.infer<typeof getExpiringQuerySchema>['query'];
export type CreateSupplyRequestInput = z.infer<typeof createSupplyRequestSchema>['body'];
export type GetSupplyRequestsQuery = z.infer<typeof getSupplyRequestsQuerySchema>['query'];
export type ApproveSupplyRequestInput = z.infer<typeof approveSupplyRequestSchema>['body'];
export type FulfillSupplyRequestInput = z.infer<typeof fulfillSupplyRequestSchema>['body'];

export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderSchema>['body'];
export type UpdateInventorySettingsInput = z.infer<typeof updateInventorySettingsSchema>['body'];
export type RunInventoryAlertsInput = z.infer<typeof runInventoryAlertsSchema>['body'];
