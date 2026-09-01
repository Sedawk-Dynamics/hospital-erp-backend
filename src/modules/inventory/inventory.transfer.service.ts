import { prisma } from '../../config/database';
import { assertTransferCustody } from './transfer-custody';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { safeInventoryAudit } from './inventory.audit';

// ============================================================
// Stock Transfer — moves stock between two departments, or out of the
// pharmacy onto a ward's shelf.
//
// RECORDING A TRANSFER IS THE TRANSFER. It used to be a four-step board —
// pending → approved → dispatched → received, with reject and cancel — which
// only separates duties if different people hold the steps. Nobody did: every
// role that can create a transfer also holds `inventory:approve`, and on the
// live data all four approved transfers were approved by whoever requested
// them and all three received by whoever dispatched them. It was four clicks
// and a status column for one person moving a box across a corridor.
//
// So one action moves the stock, atomically, and the row lands on `received`.
// What that deliberately KEEPS:
//   • the controlled-drug custody gate — a vault narcotic still names a second
//     person who cannot be the one moving it (`transfer-custody.ts`);
//   • `dispatchedAt`, `quantityTransferred`, the dispatcher and the custodian,
//     because the statutory controlled-drug register reads them off this row
//     and filters on `status in ('dispatched','received')`;
//   • the ward stock ledger, so a ward can still say where its medicines came
//     from.
//
// To undo a transfer, transfer it back — there is no half-done state to cancel.
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
  /** Where a DRUG transfer lands — wards hold drug stock, departments do not. */
  toWardId?: string;
  fromLocation?: string;
  toLocation?: string;
  quantityRequested: number;
  batchNumber?: string;
  reason?: string;
  notes?: string;
  /** Required when the drug is held in the narcotic safe — and never the mover. */
  custodianId?: string | null;
}

export async function createStockTransfer(
  tenantId: string,
  userId: string,
  data: CreateStockTransferInput,
) {
  if (!data.fromDepartmentId && !data.fromLocation) {
    throw AppError.badRequest('Either fromDepartmentId or fromLocation is required');
  }
  if (!data.toDepartmentId && !data.toLocation && !data.toWardId) {
    throw AppError.badRequest('A destination is required — a ward for drugs, a department otherwise');
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
  // A ward's shelf holds medicines. The route schema says this too, but the
  // invariant belongs where the ward actually gets credited — otherwise a
  // consumable sent to a ward would be recorded as ward-bound and land nowhere.
  if (data.toWardId && !data.drugBatchId) {
    throw AppError.badRequest('Only a drug transfer can be sent to a ward');
  }

  const qty = data.quantityRequested;
  if (qty <= 0) throw AppError.badRequest('Quantity must be positive');

  // Resolve what is moving, and check there is enough of it BEFORE anything is
  // written. A drug batch also carries the controlled-drug fields the custody
  // gate reads.
  let itemLabel: string;
  let batchNumber = data.batchNumber;
  let drugForCustody: {
    drugName: string;
    controlledClass?: string | null;
    vaultControlled?: boolean | null;
    schedule?: string | null;
  } | null = null;
  let drugId: string | null = null;

  if (data.drugBatchId) {
    const batch = await prisma.drugBatch.findFirst({
      where: { id: data.drugBatchId, tenantId },
      include: {
        drug: {
          select: {
            id: true,
            drugName: true,
            controlledClass: true,
            vaultControlled: true,
            schedule: true,
          },
        },
      },
    });
    if (!batch) throw AppError.notFound('Drug batch not found');
    if (qty > batch.quantityInStock) {
      throw AppError.badRequest(
        `Insufficient drug stock. Available: ${batch.quantityInStock}, requested: ${qty}`,
      );
    }
    itemLabel = `${batch.drug?.drugName ?? 'Drug'} (batch ${batch.batchNumber})`;
    batchNumber = batchNumber ?? batch.batchNumber;
    drugForCustody = batch.drug ?? null;
    drugId = batch.drug?.id ?? null;
  } else {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: data.inventoryItemId, tenantId, isActive: true },
    });
    if (!item) throw AppError.notFound('Inventory item not found or inactive');
    if (qty > item.currentStock) {
      throw AppError.badRequest(
        `Insufficient stock. Available: ${item.currentStock}, requested: ${qty}`,
      );
    }
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

  // Controlled-drug custody, checked before anything moves. A vault narcotic is
  // handed to a named second person who cannot be the one moving it — the same
  // rule the NDPS challan has always applied. Collapsing the four-step board
  // into one action does not relax it; it just asks for the custodian on the
  // form instead of on a later dispatch screen.
  const custody = await assertTransferCustody(tenantId, drugForCustody, {
    dispatcherId: userId,
    custodianId: data.custodianId,
  });

  const transferNumber = await generateTransferNumber(tenantId);
  const now = new Date();

  const transfer = await prisma.$transaction(async (tx) => {
    const created = await tx.stockTransfer.create({
      data: {
        tenantId,
        transferNumber,
        inventoryItemId: data.inventoryItemId ?? null,
        drugBatchId: data.drugBatchId ?? null,
        fromDepartmentId: data.fromDepartmentId,
        toDepartmentId: data.toDepartmentId,
        toWardId: data.toWardId ?? null,
        fromLocation: data.fromLocation,
        toLocation: data.toLocation,
        quantityRequested: qty,
        quantityTransferred: qty,
        batchNumber,
        reason: data.reason,
        notes: data.notes,
        // The move is done the moment it is recorded, so every party is the
        // person who did it. These columns are kept — and kept populated —
        // because the statutory controlled-drug register reads `dispatchedAt`,
        // `quantityTransferred`, the dispatcher and the custodian off this row.
        status: 'received',
        requestedBy: userId,
        dispatchedBy: userId,
        dispatchedAt: now,
        receivedBy: userId,
        receivedAt: now,
        custodianId: custody.custodianId,
        custodyAt: custody.custodyAt,
      },
      include: {
        inventoryItem: { select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, currentStock: true } },
        drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true, controlledClass: true, vaultControlled: true, schedule: true } } } },
        fromDepartment: { select: { id: true, name: true } },
        toDepartment: { select: { id: true, name: true } },
        toWard: { select: { id: true, name: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        custodian: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (data.drugBatchId) {
      // Pharmacy drug: the stock leaves the batch and lands on the ward's
      // shelf. Departments do not hold drug stock, so a transfer with no ward
      // simply issues it out of the pharmacy.
      await tx.drugBatch.update({
        where: { id: data.drugBatchId },
        data: { quantityInStock: { decrement: qty } },
      });

      if (data.toWardId && drugId) {
        const existing = await tx.wardStock.findFirst({
          where: { tenantId, wardId: data.toWardId, drugBatchId: data.drugBatchId },
          select: { id: true },
        });
        if (existing) {
          await tx.wardStock.update({
            where: { id: existing.id },
            data: { quantityInStock: { increment: qty } },
          });
        } else {
          await tx.wardStock.create({
            data: {
              tenantId,
              wardId: data.toWardId,
              drugId,
              drugBatchId: data.drugBatchId,
              quantityInStock: qty,
            },
          });
        }
        // The ward's record of where its medicines came from. Without this the
        // stock appears on the shelf with no history.
        await tx.wardStockLedger.create({
          data: {
            tenantId,
            wardId: data.toWardId,
            drugId,
            drugBatchId: data.drugBatchId,
            movementType: 'received',
            quantity: qty,
            performedBy: userId,
            reason: `Stock transfer ${transferNumber}`,
          },
        });
      }
    } else if (data.inventoryItemId) {
      // A generic item moves between departments. `currentStock` is a single
      // hospital-wide figure, so moving it department to department leaves the
      // total unchanged — the two transactions below are what record WHERE it
      // went. (The old four-step flow decremented on dispatch and incremented
      // the same field on receive, which came to the same nothing.)
      await tx.stockTransaction.create({
        data: {
          tenantId,
          inventoryItemId: data.inventoryItemId,
          transactionType: 'stock_out',
          quantity: qty,
          batchNumber,
          referenceType: 'stock_transfer',
          referenceId: created.id,
          departmentId: data.fromDepartmentId ?? undefined,
          notes: `Transferred out via ${transferNumber}`,
          performedBy: userId,
        },
      });
      await tx.stockTransaction.create({
        data: {
          tenantId,
          inventoryItemId: data.inventoryItemId,
          transactionType: 'stock_in',
          quantity: qty,
          batchNumber,
          referenceType: 'stock_transfer',
          referenceId: created.id,
          departmentId: data.toDepartmentId ?? undefined,
          notes: `Transferred in via ${transferNumber}`,
          performedBy: userId,
        },
      });
    }

    return created;
  });

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'stock_transfer',
    entityId: transfer.id,
    description:
      `Stock transfer ${transferNumber}: ${qty} × ${itemLabel} moved ` +
      `${data.fromDepartmentId || data.fromLocation ? 'from source' : ''} to destination`.replace(
        /\s+/g,
        ' ',
      ),
    newValues: {
      status: 'received',
      quantityTransferred: qty,
      custodianId: custody.custodianId,
    },
  });

  logger.info(
    { tenantId, transferId: transfer.id, qty, custodianId: custody.custodianId },
    'Stock transfer completed',
  );
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
        // The controlled flags travel with the row so the board knows, before
        // anyone presses Dispatch, that this move needs a second person.
        drugBatch: {
          select: {
            id: true, batchNumber: true, quantityInStock: true,
            drug: {
              select: {
                drugName: true, controlledClass: true, vaultControlled: true, schedule: true,
              },
            },
          },
        },
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
      drugBatch: { select: { id: true, batchNumber: true, quantityInStock: true, drug: { select: { drugName: true, controlledClass: true, vaultControlled: true, schedule: true } } } },
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
