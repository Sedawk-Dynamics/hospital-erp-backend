import { prisma } from '../../config/database';
import { assertTransferCustody } from './transfer-custody';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { safeInventoryAudit } from './inventory.audit';

// ============================================================
// Stock Transfer — moves inventory between two departments (or any
// from/to location pair). Lifecycle:
//   pending → approved → dispatched → received
//                      ↘ rejected / cancelled
//
// On dispatch we create a `stock_out` transaction tagged with the from
// department; on receive we create a `stock_in` against the to department
// and adjust the item's current stock by the difference. We do NOT decrement
// stock until dispatch — the request alone is non-binding.
// ============================================================

async function generateTransferNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  const prefix = `ST-${dateStr}-`;

  const latest = await prisma.stockTransfer.findFirst({
    where: { tenantId, transferNumber: { startsWith: prefix } },
    orderBy: { transferNumber: 'desc' },
    select: { transferNumber: true },
  });
  let nextNumber = 1;
  if (latest?.transferNumber) {
    const lastNumber = parseInt(latest.transferNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }
  const transferNumber = `${prefix}${String(nextNumber).padStart(4, '0')}`;
  const dupe = await prisma.stockTransfer.findFirst({ where: { transferNumber } });
  if (dupe) return generateTransferNumber(tenantId);
  return transferNumber;
}

export interface CreateStockTransferInput {
  // Exactly one of inventoryItemId / drugBatchId. drugBatchId issues pharmacy
  // drug stock from the pharmacy to a department/ward.
  inventoryItemId?: string;
  drugBatchId?: string;
  fromDepartmentId?: string;
  toDepartmentId?: string;
  fromLocation?: string;
  toLocation?: string;
  quantityRequested: number;
  batchNumber?: string;
  reason?: string;
  notes?: string;
}

export async function createStockTransfer(
  tenantId: string,
  userId: string,
  data: CreateStockTransferInput,
) {
  if (!data.fromDepartmentId && !data.fromLocation) {
    throw AppError.badRequest('Either fromDepartmentId or fromLocation is required');
  }
  if (!data.toDepartmentId && !data.toLocation) {
    throw AppError.badRequest('Either toDepartmentId or toLocation is required');
  }
  if (data.fromDepartmentId && data.toDepartmentId && data.fromDepartmentId === data.toDepartmentId) {
    throw AppError.badRequest('From and to departments cannot be the same');
  }
  if (!data.inventoryItemId && !data.drugBatchId) {
    throw AppError.badRequest('Pick an inventory item or a pharmacy drug batch to transfer');
  }
  if (data.inventoryItemId && data.drugBatchId) {
    throw AppError.badRequest('A transfer is for either an inventory item or a drug batch, not both');
  }

  // Resolve the item being transferred (generic inventory item or a drug batch)
  // for validation + a human label in the audit log.
  let itemLabel: string;
  let batchNumber = data.batchNumber;
  if (data.drugBatchId) {
    const batch = await prisma.drugBatch.findFirst({
      where: { id: data.drugBatchId, tenantId },
      include: { drug: { select: { drugName: true } } },
    });
    if (!batch) throw AppError.notFound('Drug batch not found');
    itemLabel = `${batch.drug?.drugName ?? 'Drug'} (batch ${batch.batchNumber})`;
    batchNumber = batchNumber ?? batch.batchNumber;
  } else {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: data.inventoryItemId, tenantId, isActive: true },
    });
    if (!item) throw AppError.notFound('Inventory item not found or inactive');
    itemLabel = item.itemName;
  }

  if (data.fromDepartmentId) {
    const fromDept = await prisma.department.findFirst({
      where: { id: data.fromDepartmentId, tenantId },
    });
    if (!fromDept) throw AppError.notFound('From department not found');
  }
  if (data.toDepartmentId) {
    const toDept = await prisma.department.findFirst({
      where: { id: data.toDepartmentId, tenantId },
    });
    if (!toDept) throw AppError.notFound('To department not found');
  }

  const transferNumber = await generateTransferNumber(tenantId);

  const transfer = await prisma.stockTransfer.create({
    data: {
      tenantId,
      transferNumber,
      inventoryItemId: data.inventoryItemId ?? null,
      drugBatchId: data.drugBatchId ?? null,
      fromDepartmentId: data.fromDepartmentId,
      toDepartmentId: data.toDepartmentId,
      fromLocation: data.fromLocation,
      toLocation: data.toLocation,
      quantityRequested: data.quantityRequested,
      batchNumber,
      reason: data.reason,
      notes: data.notes,
      requestedBy: userId,
    },
    include: {
      inventoryItem: { select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, currentStock: true } },
      drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true } } } },
      fromDepartment: { select: { id: true, name: true } },
      toDepartment: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'stock_transfer',
    entityId: transfer.id,
    description: `Stock transfer ${transferNumber} created (${data.quantityRequested} × ${itemLabel})`,
    newValues: transfer,
  });

  logger.info({ tenantId, transferId: transfer.id }, 'Stock transfer created');
  return transfer;
}

export interface ListStockTransfersQuery {
  status?: string;
  fromDepartmentId?: string;
  toDepartmentId?: string;
  inventoryItemId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortOrder?: 'asc' | 'desc';
}

export async function listStockTransfers(tenantId: string, query: ListStockTransfersQuery) {
  const { skip, take, page, limit } = getPaginationParams({
    page: query.page,
    limit: query.limit ?? 20,
    sortOrder: query.sortOrder ?? 'desc',
  } as any);

  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.fromDepartmentId) where.fromDepartmentId = query.fromDepartmentId;
  if (query.toDepartmentId) where.toDepartmentId = query.toDepartmentId;
  if (query.inventoryItemId) where.inventoryItemId = query.inventoryItemId;
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }
  if (query.search) {
    where.OR = [
      { transferNumber: { contains: query.search, mode: 'insensitive' } },
      { inventoryItem: { itemName: { contains: query.search, mode: 'insensitive' } } },
      { drugBatch: { drug: { drugName: { contains: query.search, mode: 'insensitive' } } } },
      { fromDepartment: { name: { contains: query.search, mode: 'insensitive' } } },
      { toDepartment: { name: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [transfers, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      skip,
      take,
      include: {
        inventoryItem: { select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, currentStock: true } },
        drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true } } } },
        fromDepartment: { select: { id: true, name: true } },
        toDepartment: { select: { id: true, name: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.stockTransfer.count({ where }),
  ]);

  return { transfers, total, page, limit };
}

export async function getStockTransferById(tenantId: string, id: string) {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id, tenantId },
    include: {
      inventoryItem: true,
      drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true } } } },
      fromDepartment: true,
      toDepartment: true,
      requester: { select: { id: true, firstName: true, lastName: true, email: true } },
      approver: { select: { id: true, firstName: true, lastName: true } },
      dispatcher: { select: { id: true, firstName: true, lastName: true } },
      receiver: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  return transfer;
}

export async function approveStockTransfer(tenantId: string, id: string, userId: string, notes?: string) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id, tenantId } });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  if (transfer.status !== 'pending') {
    throw AppError.badRequest(`Only pending transfers can be approved (current: ${transfer.status})`);
  }

  const updated = await prisma.stockTransfer.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy: userId,
      approvedAt: new Date(),
      ...(notes ? { notes } : {}),
    },
    include: {
      inventoryItem: { select: { id: true, itemName: true, itemCode: true, currentStock: true } },
      fromDepartment: { select: { id: true, name: true } },
      toDepartment: { select: { id: true, name: true } },
    },
  });

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'stock_transfer',
    entityId: id,
    description: `Stock transfer ${transfer.transferNumber} approved`,
    oldValues: { status: transfer.status },
    newValues: { status: 'approved' },
  });

  return updated;
}

export async function rejectStockTransfer(
  tenantId: string,
  id: string,
  userId: string,
  rejectionReason: string,
) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id, tenantId } });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  if (transfer.status !== 'pending' && transfer.status !== 'approved') {
    throw AppError.badRequest(`Only pending or approved transfers can be rejected (current: ${transfer.status})`);
  }

  const updated = await prisma.stockTransfer.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectionReason,
      approvedBy: userId,
      approvedAt: new Date(),
    },
  });

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'stock_transfer',
    entityId: id,
    description: `Stock transfer ${transfer.transferNumber} rejected: ${rejectionReason}`,
    oldValues: { status: transfer.status },
    newValues: { status: 'rejected', rejectionReason },
  });

  return updated;
}

export async function dispatchStockTransfer(
  tenantId: string,
  id: string,
  userId: string,
  quantityDispatched?: number,
  custodianId?: string | null,
) {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id, tenantId },
    include: {
      inventoryItem: true,
      drugBatch: {
        select: {
          id: true,
          quantityInStock: true,
          drug: {
            select: {
              drugName: true,
              // Read so the custody gate can fire. Without these the board
              // moved narcotics with no second person and no register entry.
              controlledClass: true,
              vaultControlled: true,
              schedule: true,
            },
          },
        },
      },
    },
  });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  if (transfer.status !== 'approved') {
    throw AppError.badRequest(`Only approved transfers can be dispatched (current: ${transfer.status})`);
  }

  const qty = quantityDispatched ?? transfer.quantityRequested;
  if (qty <= 0) throw AppError.badRequest('Quantity must be positive');

  // Controlled-drug custody, enforced BEFORE anything moves. A vault narcotic
  // is handed to a named second person — the same rule the NDPS challan has
  // always applied, now applied here too so the merged board cannot become the
  // way round it.
  const custody = await assertTransferCustody(tenantId, transfer.drugBatch?.drug, {
    dispatcherId: userId,
    custodianId,
  });

  const includeForUpdate = {
    inventoryItem: { select: { id: true, itemName: true, itemCode: true, currentStock: true } },
    drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true } } } },
    fromDepartment: { select: { id: true, name: true } },
    toDepartment: { select: { id: true, name: true } },
  };

  let result;
  if (transfer.drugBatchId && transfer.drugBatch) {
    // Pharmacy drug transfer: issue the drug out of the pharmacy. Drug stock is
    // not department-scoped, so dispatch decrements the batch and receive simply
    // marks delivery — the drug does not return to pharmacy stock.
    if (qty > transfer.drugBatch.quantityInStock) {
      throw AppError.badRequest(
        `Insufficient drug stock to dispatch. Available: ${transfer.drugBatch.quantityInStock}, requested: ${qty}`,
      );
    }
    result = await prisma.$transaction(async (tx) => {
      await tx.drugBatch.update({
        where: { id: transfer.drugBatchId! },
        data: { quantityInStock: { decrement: qty } },
      });
      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: 'dispatched',
          quantityTransferred: qty,
          dispatchedBy: userId,
          dispatchedAt: new Date(),
          custodianId: custody.custodianId,
          custodyAt: custody.custodyAt,
        },
        include: includeForUpdate,
      });
    });
  } else {
    if (!transfer.inventoryItem || !transfer.inventoryItemId) {
      throw AppError.badRequest('Transfer has no item to dispatch');
    }
    if (qty > transfer.inventoryItem.currentStock) {
      throw AppError.badRequest(
        `Insufficient stock to dispatch. Available: ${transfer.inventoryItem.currentStock}, requested: ${qty}`,
      );
    }
    const inventoryItemId = transfer.inventoryItemId;
    result = await prisma.$transaction(async (tx) => {
      // Stock out from the source side
      await tx.stockTransaction.create({
        data: {
          tenantId,
          inventoryItemId,
          transactionType: 'stock_out',
          quantity: qty,
          batchNumber: transfer.batchNumber,
          referenceType: 'stock_transfer',
          referenceId: transfer.id,
          departmentId: transfer.fromDepartmentId ?? undefined,
          notes: `Dispatched via transfer ${transfer.transferNumber}`,
          performedBy: userId,
        },
      });

      await tx.inventoryItem.update({
        where: { id: inventoryItemId },
        data: { currentStock: { decrement: qty } },
      });

      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: 'dispatched',
          quantityTransferred: qty,
          dispatchedBy: userId,
          dispatchedAt: new Date(),
        },
        include: includeForUpdate,
      });
    });
  }

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'stock_transfer',
    entityId: id,
    description: `Stock transfer ${transfer.transferNumber} dispatched (${qty} units)`,
    newValues: { status: 'dispatched', quantityTransferred: qty },
  });

  return result;
}

export async function receiveStockTransfer(tenantId: string, id: string, userId: string) {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id, tenantId },
  });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  if (transfer.status !== 'dispatched') {
    throw AppError.badRequest(`Only dispatched transfers can be received (current: ${transfer.status})`);
  }

  const includeForUpdate = {
    inventoryItem: { select: { id: true, itemName: true, itemCode: true, currentStock: true } },
    drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true } } } },
    fromDepartment: { select: { id: true, name: true } },
    toDepartment: { select: { id: true, name: true } },
  };

  let result;
  if (transfer.drugBatchId) {
    // Drug transfer: the batch was already decremented on dispatch (issued from
    // the pharmacy). Receiving just confirms delivery — no stock change.
    result = await prisma.stockTransfer.update({
      where: { id },
      data: { status: 'received', receivedBy: userId, receivedAt: new Date() },
      include: includeForUpdate,
    });
  } else {
    const inventoryItemId = transfer.inventoryItemId;
    result = await prisma.$transaction(async (tx) => {
      // Stock in to the destination side (re-add to inventory)
      if (inventoryItemId) {
        await tx.stockTransaction.create({
          data: {
            tenantId,
            inventoryItemId,
            transactionType: 'stock_in',
            quantity: transfer.quantityTransferred,
            batchNumber: transfer.batchNumber,
            referenceType: 'stock_transfer',
            referenceId: transfer.id,
            departmentId: transfer.toDepartmentId ?? undefined,
            notes: `Received via transfer ${transfer.transferNumber}`,
            performedBy: userId,
          },
        });
        await tx.inventoryItem.update({
          where: { id: inventoryItemId },
          data: { currentStock: { increment: transfer.quantityTransferred } },
        });
      }

      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: 'received',
          receivedBy: userId,
          receivedAt: new Date(),
        },
        include: includeForUpdate,
      });
    });
  }

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'stock_transfer',
    entityId: id,
    description: `Stock transfer ${transfer.transferNumber} received`,
    newValues: { status: 'received' },
  });

  return result;
}

export async function cancelStockTransfer(tenantId: string, id: string, userId: string, reason?: string) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id, tenantId } });
  if (!transfer) throw AppError.notFound('Stock transfer not found');
  if (transfer.status === 'received' || transfer.status === 'cancelled' || transfer.status === 'rejected') {
    throw AppError.badRequest(`Cannot cancel transfer in status ${transfer.status}`);
  }
  // Already-dispatched transfers should be rolled back manually via adjustments
  // — we don't auto-reverse stock movement to avoid silent ledger inconsistencies.
  if (transfer.status === 'dispatched') {
    throw AppError.badRequest('Dispatched transfers cannot be cancelled — create a manual reverse adjustment.');
  }

  const updated = await prisma.stockTransfer.update({
    where: { id },
    data: {
      status: 'cancelled',
      rejectionReason: reason ?? 'Cancelled by user',
    },
  });

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'stock_transfer',
    entityId: id,
    description: `Stock transfer ${transfer.transferNumber} cancelled`,
    newValues: { status: 'cancelled' },
  });

  return updated;
}
