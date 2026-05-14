import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const stockBalanceReportSchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    groupBy: z.enum(['day', 'month']).optional(),
    inventoryItemId: z.string().uuid().optional(),
    category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']).optional(),
  }),
});

export const deptConsumptionReportSchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    departmentId: z.string().uuid().optional(),
    inventoryItemId: z.string().uuid().optional(),
  }),
});

export const reorderHistoryReportSchema = z.object({
  query: paginationSchema.partial().extend({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    supplierId: z.string().uuid().optional(),
    inventoryItemId: z.string().uuid().optional(),
    status: z
      .enum(['draft', 'submitted', 'approved', 'delivered', 'partially_delivered', 'cancelled'])
      .optional(),
  }),
});

export const expiryWasteReportSchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    windowMonths: z.coerce.number().int().min(1).max(36).optional(),
    inventoryItemId: z.string().uuid().optional(),
  }),
});

export const auditLogsReportSchema = z.object({
  query: paginationSchema.partial().extend({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    userId: z.string().uuid().optional(),
    action: z.enum(['create', 'update', 'delete']).optional(),
    entityType: z.string().max(100).optional(),
    search: z.string().max(255).optional(),
  }),
});

// --- Stock Transfers ---

export const createStockTransferSchema = z.object({
  body: z
    .object({
      inventoryItemId: z.string().uuid('Invalid inventory item ID'),
      fromDepartmentId: z.string().uuid().optional(),
      toDepartmentId: z.string().uuid().optional(),
      fromLocation: z.string().max(100).optional(),
      toLocation: z.string().max(100).optional(),
      quantityRequested: z.number().int().positive('Quantity must be positive'),
      batchNumber: z.string().max(100).optional(),
      reason: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
    })
    .refine((d) => d.fromDepartmentId || d.fromLocation, {
      message: 'Either fromDepartmentId or fromLocation is required',
      path: ['fromDepartmentId'],
    })
    .refine((d) => d.toDepartmentId || d.toLocation, {
      message: 'Either toDepartmentId or toLocation is required',
      path: ['toDepartmentId'],
    }),
});

export const listStockTransfersSchema = z.object({
  query: paginationSchema.partial().extend({
    status: z
      .enum(['pending', 'approved', 'dispatched', 'received', 'rejected', 'cancelled'])
      .optional(),
    fromDepartmentId: z.string().uuid().optional(),
    toDepartmentId: z.string().uuid().optional(),
    inventoryItemId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    search: z.string().max(255).optional(),
  }),
});

export const stockTransferIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid stock transfer ID'),
  }),
});

export const approveStockTransferSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ notes: z.string().max(2000).optional() }).optional(),
});

export const rejectStockTransferSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(1000),
  }),
});

export const dispatchStockTransferSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      quantityDispatched: z.number().int().positive().optional(),
    })
    .optional(),
});

export const cancelStockTransferSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(1000).optional() }).optional(),
});
