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
      // Exactly one of inventoryItemId / drugBatchId (drug batch = pharmacy stock).
      inventoryItemId: z.string().uuid('Invalid inventory item ID').optional(),
      drugBatchId: z.string().uuid('Invalid drug batch ID').optional(),
      fromDepartmentId: z.string().uuid().optional(),
      toDepartmentId: z.string().uuid().optional(),
      // Where a DRUG transfer lands. Wards hold drug stock; departments do not.
      toWardId: z.string().uuid('Invalid ward').optional(),
      fromLocation: z.string().max(100).optional(),
      toLocation: z.string().max(100).optional(),
      quantityRequested: z.number().int().positive('Quantity must be positive'),
      batchNumber: z.string().max(100).optional(),
      reason: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
      // The person taking custody of a vault narcotic. Compulsory for those and
      // ignored for everything else — declared here or validate() drops it and
      // the transfer refuses a hand-over that was actually named.
      custodianId: z.string().uuid('Invalid custodian').optional().nullable(),
    })
    .refine((d) => !!d.inventoryItemId !== !!d.drugBatchId, {
      message: 'Provide either an inventory item or a drug batch (not both)',
      path: ['inventoryItemId'],
    })
    .refine((d) => d.fromDepartmentId || d.fromLocation, {
      message: 'Either fromDepartmentId or fromLocation is required',
      path: ['fromDepartmentId'],
    })
    .refine((d) => d.toDepartmentId || d.toLocation || d.toWardId, {
      message: 'A destination is required — a ward for drugs, a department otherwise',
      path: ['toDepartmentId'],
    })
    .refine((d) => !d.toWardId || !!d.drugBatchId, {
      // A ward's shelf holds medicines. Sending a consumable there would credit
      // ward stock with something the ward-stock screen cannot show.
      message: 'Only a drug transfer can be sent to a ward',
      path: ['toWardId'],
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

