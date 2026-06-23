import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { randomUUID } from 'crypto';
import { safeInventoryAudit } from './inventory.audit';
import { getInventorySettings, getInventorySettingsSafe } from './inventory.settings.service';
import { notifyInventoryRecipients, hasOpenInventoryAlert } from './inventory.notify';
import { makeInternalBarcode } from '../pharmacy/pharmacy.barcode';
import { safePharmacyAudit } from '../pharmacy/pharmacy.audit';
import type {
  CreateSupplierInput,
  UpdateSupplierInput,
  GetSuppliersQuery,
  CreateItemInput,
  UpdateItemInput,
  GetItemsQuery,
  CreateStockTransactionInput,
  GetStockTransactionsQuery,
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  GetPurchaseOrdersQuery,
  ReceivePurchaseOrderInput,
  CreateSupplyRequestInput,
  GetSupplyRequestsQuery,
  ApproveSupplyRequestInput,
  FulfillSupplyRequestInput,
  GetExpiringQuery,
  CancelPurchaseOrderInput,
  RunInventoryAlertsInput,
} from './inventory.validation';

// ============================================================
// Helpers
// ============================================================

function toNumber(val: Decimal | number | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  return val.toNumber();
}

async function generateOrderNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `PO-${dateStr}-`;

  const latest = await prisma.purchaseOrder.findFirst({
    where: { tenantId, orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: 'desc' },
    select: { orderNumber: true },
  });

  let nextNumber = 1;
  if (latest?.orderNumber) {
    const lastNumber = parseInt(latest.orderNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const orderNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.purchaseOrder.findFirst({
    where: { orderNumber },
  });

  if (existing) {
    return generateOrderNumber(tenantId);
  }

  return orderNumber;
}

// ============================================================
// Suppliers
// ============================================================

export async function createSupplier(tenantId: string, data: CreateSupplierInput) {
  const supplier = await prisma.supplier.create({
    data: {
      tenantId,
      name: data.name,
      phone: data.phone,
      email: data.email,
      address: data.address,
      gstNumber: data.gstNumber,
      licenseNumber: data.licenseNumber,
      supplyType: data.supplyType as any,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, supplierId: supplier.id }, 'Supplier created');
  return supplier;
}

export async function getSuppliers(tenantId: string, query: GetSuppliersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.supplyType) where.supplyType = query.supplyType;

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
    }),
    prisma.supplier.count({ where }),
  ]);

  return { suppliers, total, page, limit };
}

export async function getSupplierById(tenantId: string, id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, tenantId },
    include: {
      purchaseOrders: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: { id: true, orderNumber: true, status: true, totalAmount: true, createdAt: true },
      },
    },
  });

  if (!supplier) {
    throw AppError.notFound('Supplier not found');
  }

  return supplier;
}

export async function updateSupplier(tenantId: string, id: string, data: UpdateSupplierInput) {
  const existing = await prisma.supplier.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Supplier not found');
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.address !== undefined) updateData.address = data.address;
  if (data.gstNumber !== undefined) updateData.gstNumber = data.gstNumber;
  if (data.licenseNumber !== undefined) updateData.licenseNumber = data.licenseNumber;
  if (data.supplyType !== undefined) updateData.supplyType = data.supplyType;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const supplier = await prisma.supplier.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, supplierId: id }, 'Supplier updated');
  return supplier;
}

export async function deleteSupplier(tenantId: string, id: string) {
  const existing = await prisma.supplier.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Supplier not found');
  }

  // Soft delete by setting isActive to false
  await prisma.supplier.update({
    where: { id },
    data: { isActive: false },
  });

  logger.info({ tenantId, supplierId: id }, 'Supplier deactivated');
}

// ============================================================
// Inventory Items
// ============================================================

export async function createItem(tenantId: string, data: CreateItemInput) {
  // Check for duplicate item code within tenant
  if (data.itemCode) {
    const existing = await prisma.inventoryItem.findFirst({
      where: { tenantId, itemCode: data.itemCode },
    });

    if (existing) {
      throw AppError.conflict('An inventory item with this code already exists');
    }
  }

  // Fall back to the tenant's configured default threshold when none is given.
  const settings = await getInventorySettingsSafe(tenantId);
  const minimumStockThreshold = data.minimumStockThreshold ?? settings.defaultLowStockThreshold;

  const item = await prisma.inventoryItem.create({
    data: {
      tenantId,
      itemName: data.itemName,
      itemCode: data.itemCode,
      category: data.category as any,
      description: data.description,
      unitOfMeasurement: data.unitOfMeasurement,
      minimumStockThreshold,
      currentStock: data.currentStock ?? 0,
      costPerUnit: data.costPerUnit,
      sellingPricePerUnit: data.sellingPricePerUnit,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, itemId: item.id }, 'Inventory item created');
  return item;
}

export async function getItems(tenantId: string, query: GetItemsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.category) where.category = query.category;
  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [
      { itemName: { contains: query.search, mode: 'insensitive' } },
      { itemCode: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      skip,
      take,
      orderBy: { itemName: 'asc' },
    }),
    prisma.inventoryItem.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getItemById(tenantId: string, id: string) {
  const item = await prisma.inventoryItem.findFirst({
    where: { id, tenantId },
    include: {
      stockTransactions: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          transactionType: true,
          quantity: true,
          batchNumber: true,
          notes: true,
          createdAt: true,
        },
      },
    },
  });

  if (!item) {
    throw AppError.notFound('Inventory item not found');
  }

  return item;
}

export async function updateItem(tenantId: string, id: string, data: UpdateItemInput) {
  const existing = await prisma.inventoryItem.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Inventory item not found');
  }

  // Check for duplicate item code if code is being changed
  if (data.itemCode && data.itemCode !== existing.itemCode) {
    const duplicate = await prisma.inventoryItem.findFirst({
      where: { tenantId, itemCode: data.itemCode, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('An inventory item with this code already exists');
    }
  }

  const updateData: any = {};
  if (data.itemName !== undefined) updateData.itemName = data.itemName;
  if (data.itemCode !== undefined) updateData.itemCode = data.itemCode;
  if (data.category !== undefined) updateData.category = data.category;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.unitOfMeasurement !== undefined) updateData.unitOfMeasurement = data.unitOfMeasurement;
  if (data.minimumStockThreshold !== undefined) updateData.minimumStockThreshold = data.minimumStockThreshold;
  if (data.costPerUnit !== undefined) updateData.costPerUnit = data.costPerUnit;
  if (data.sellingPricePerUnit !== undefined) updateData.sellingPricePerUnit = data.sellingPricePerUnit;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const item = await prisma.inventoryItem.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, itemId: id }, 'Inventory item updated');
  return item;
}

export async function deleteItem(tenantId: string, id: string) {
  const existing = await prisma.inventoryItem.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Inventory item not found');
  }

  // Soft delete by setting isActive to false
  await prisma.inventoryItem.update({
    where: { id },
    data: { isActive: false },
  });

  logger.info({ tenantId, itemId: id }, 'Inventory item deactivated');
}

/**
 * Items that have stock-in batches expiring within `months`. We look at
 * stock_in transactions with an expiryDate set, and sum the remaining
 * quantity per (item, batchNumber) by subtracting later stock_outs from
 * the same batch. Equipment items with no expiry are excluded.
 */
export async function getExpiringInventory(tenantId: string, query: GetExpiringQuery) {
  const months = query.months ?? 3;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const threshold = new Date(today);
  threshold.setMonth(threshold.getMonth() + months);

  // Look at stock_in transactions with a non-null expiryDate within the window
  const stockIns = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'stock_in',
      expiryDate: { gte: today, lte: threshold },
    },
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, category: true, currentStock: true },
      },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { expiryDate: 'asc' },
  });

  // For each stock-in, find later stock_out transactions referencing the same item + batchNumber
  const rows = await Promise.all(
    stockIns.map(async (tx) => {
      const used = await prisma.stockTransaction.aggregate({
        where: {
          tenantId,
          inventoryItemId: tx.inventoryItemId,
          batchNumber: tx.batchNumber ?? undefined,
          transactionType: { in: ['stock_out', 'expired_removal'] },
          createdAt: { gte: tx.createdAt },
        },
        _sum: { quantity: true },
      });
      const remaining = tx.quantity - (used._sum.quantity ?? 0);
      return {
        transactionId: tx.id,
        inventoryItemId: tx.inventoryItemId,
        item: tx.inventoryItem,
        batchNumber: tx.batchNumber,
        receivedAt: tx.createdAt,
        expiryDate: tx.expiryDate,
        receivedQuantity: tx.quantity,
        remainingQuantity: Math.max(0, remaining),
        unitCost: tx.unitCost ? Number(tx.unitCost) : 0,
        supplier: tx.supplier,
      };
    }),
  );

  // Drop fully consumed batches
  const expiring = rows.filter((r) => r.remainingQuantity > 0);

  return {
    months,
    total: expiring.length,
    items: expiring,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Unified stock overview across BOTH stock systems that the combined Inventory
 * page surfaces as one picture:
 *   • generic inventory items (inventory_items / stock_transactions), and
 *   • pharmacy drug stock (drug_formulary / drug_batches).
 *
 * Returns a per-system breakdown plus a `combined` roll-up. Definitions match
 * the two panels exactly — drug out-of-stock uses the same "no available batch"
 * relation filter the formulary list uses; item expiry reuses getExpiringInventory.
 */
export async function getStockOverview(tenantId: string) {
  const settings = await getInventorySettingsSafe(tenantId);
  const expiryAlertMonths = settings?.expiryAlertMonths ?? 3;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const configuredThreshold = new Date(now);
  configuredThreshold.setMonth(configuredThreshold.getMonth() + expiryAlertMonths);
  const in90 = new Date(now);
  in90.setDate(in90.getDate() + 90);

  // ---- Generic inventory items ----
  const items = await prisma.inventoryItem.findMany({
    where: { tenantId, isActive: true },
    select: {
      currentStock: true,
      minimumStockThreshold: true,
      costPerUnit: true,
      sellingPricePerUnit: true,
    },
  });
  let itemLowStock = 0;
  let itemOutOfStock = 0;
  let itemStockValue = 0;
  for (const it of items) {
    if (it.currentStock <= 0) itemOutOfStock += 1;
    else if (it.currentStock <= it.minimumStockThreshold) itemLowStock += 1;
    const unit = toNumber(it.sellingPricePerUnit) || toNumber(it.costPerUnit);
    itemStockValue += unit * it.currentStock;
  }
  const itemSkus = items.length;
  const itemExpiring = (await getExpiringInventory(tenantId, { months: expiryAlertMonths } as GetExpiringQuery)).total;

  // ---- Pharmacy drug stock ----
  const availableBatchFilter = { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } };
  const [drugSkus, drugOutOfStock, recalledBatches] = await Promise.all([
    prisma.drugFormulary.count({ where: { tenantId, isActive: true } }),
    prisma.drugFormulary.count({
      where: { tenantId, isActive: true, drugBatches: { none: availableBatchFilter } },
    }),
    prisma.drugBatch.count({ where: { tenantId, isRecalled: true, quantityInStock: { gt: 0 } } }),
  ]);

  // In-stock (non-recalled) batches drive the value + expiry roll-ups and the
  // per-drug live-stock total used for drug low-stock.
  const batches = await prisma.drugBatch.findMany({
    where: { tenantId, isRecalled: false, quantityInStock: { gt: 0 } },
    select: { drugId: true, quantityInStock: true, sellingPrice: true, expiryDate: true, isExpired: true },
  });
  let drugStockValue = 0;
  let drugExpiringConfigured = 0;
  let drugValueAtRisk = 0;
  const liveByDrug = new Map<string, number>();
  for (const b of batches) {
    const sell = toNumber(b.sellingPrice);
    drugStockValue += sell * b.quantityInStock;
    liveByDrug.set(b.drugId, (liveByDrug.get(b.drugId) ?? 0) + b.quantityInStock);
    const exp = new Date(b.expiryDate);
    if (exp <= configuredThreshold) drugExpiringConfigured += 1;
    if (b.isExpired || exp <= in90) drugValueAtRisk += sell * b.quantityInStock;
  }
  // Drug low-stock: in-stock drugs whose live total has fallen to/below minStock.
  const minStockDrugs = await prisma.drugFormulary.findMany({
    where: { tenantId, isActive: true, minStock: { not: null } },
    select: { id: true, minStock: true },
  });
  let drugLowStock = 0;
  for (const d of minStockDrugs) {
    const live = liveByDrug.get(d.id) ?? 0;
    if (live > 0 && d.minStock != null && live <= d.minStock) drugLowStock += 1;
  }

  return {
    expiryAlertMonths,
    items: {
      skus: itemSkus,
      lowStock: itemLowStock,
      outOfStock: itemOutOfStock,
      expiring: itemExpiring,
      stockValue: round2(itemStockValue),
    },
    drugs: {
      skus: drugSkus,
      lowStock: drugLowStock,
      outOfStock: drugOutOfStock,
      expiring: drugExpiringConfigured,
      recalledBatches,
      stockValue: round2(drugStockValue),
      valueAtRisk: round2(drugValueAtRisk),
    },
    combined: {
      skus: itemSkus + drugSkus,
      lowStock: itemLowStock + drugLowStock,
      outOfStock: itemOutOfStock + drugOutOfStock,
      expiring: itemExpiring + drugExpiringConfigured,
      stockValue: round2(itemStockValue + drugStockValue),
      valueAtRisk: round2(drugValueAtRisk),
    },
  };
}

/**
 * Mark expired batches: any stock-in with expiryDate < today and remaining
 * quantity > 0 gets an `expired_removal` transaction that zeroes it out.
 * Idempotent — if the expired_removal already exists for the batch, skip.
 */
export async function flagExpiredInventory(tenantId: string, userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiredIns = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'stock_in',
      expiryDate: { lt: today },
    },
  });

  let flagged = 0;
  for (const tx of expiredIns) {
    if (!tx.batchNumber) continue;
    const used = await prisma.stockTransaction.aggregate({
      where: {
        tenantId,
        inventoryItemId: tx.inventoryItemId,
        batchNumber: tx.batchNumber,
        transactionType: { in: ['stock_out', 'expired_removal'] },
        createdAt: { gte: tx.createdAt },
      },
      _sum: { quantity: true },
    });
    const remaining = tx.quantity - (used._sum.quantity ?? 0);
    if (remaining <= 0) continue;

    await prisma.$transaction([
      prisma.stockTransaction.create({
        data: {
          tenantId,
          inventoryItemId: tx.inventoryItemId,
          transactionType: 'expired_removal',
          quantity: remaining,
          batchNumber: tx.batchNumber,
          expiryDate: tx.expiryDate,
          referenceType: 'auto_expiry',
          referenceId: tx.id,
          notes: `Auto-flagged expired batch ${tx.batchNumber}`,
          performedBy: userId,
        },
      }),
      prisma.inventoryItem.update({
        where: { id: tx.inventoryItemId },
        data: { currentStock: { decrement: remaining } },
      }),
    ]);
    flagged += 1;
  }

  logger.info({ tenantId, count: flagged }, 'Auto-flagged expired inventory batches');
  return { flagged };
}

export async function getLowStockItems(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    tenantId,
    isActive: true,
  };

  // Items where currentStock <= minimumStockThreshold. Prisma can't compare two
  // columns in a where clause, so use a raw query to find the matching IDs
  // (ordered by how low the stock is), then re-fetch through Prisma so the rows
  // come back camelCased and correctly typed — `SELECT *` returns snake_case
  // columns the frontend/InventoryItem shape doesn't understand.
  const [idRows, total] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM inventory_items
       WHERE tenant_id = $1
         AND is_active = true
         AND current_stock <= minimum_stock_threshold
       ORDER BY current_stock ASC
       LIMIT $2 OFFSET $3`,
      tenantId,
      take,
      skip,
    ),
    prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT COUNT(*)::int as count FROM inventory_items
       WHERE tenant_id = $1
         AND is_active = true
         AND current_stock <= minimum_stock_threshold`,
      tenantId,
    ),
  ]);

  const ids = idRows.map((r) => r.id);
  const items = ids.length
    ? await prisma.inventoryItem.findMany({
        where: { id: { in: ids } },
        orderBy: { currentStock: 'asc' },
      })
    : [];

  const totalCount = Number(total[0]?.count ?? 0);

  return { items, total: totalCount, page, limit };
}

// ============================================================
// Stock Transactions
// ============================================================

export async function createStockTransaction(
  tenantId: string,
  userId: string,
  data: CreateStockTransactionInput,
) {
  // Verify inventory item exists
  const item = await prisma.inventoryItem.findFirst({
    where: { id: data.inventoryItemId, tenantId },
  });

  if (!item) {
    throw AppError.notFound('Inventory item not found');
  }

  // Verify supplier if provided
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  const settings = await getInventorySettingsSafe(tenantId);

  // Prevent use of expired stock: a stock-out naming a batch whose latest
  // stock-in carries an expiry date in the past is blocked when the tenant
  // has the guard enabled. Equipment / batchless items are unaffected.
  if (settings.preventExpiredUse && data.transactionType === 'stock_out' && data.batchNumber) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const batchIn = await prisma.stockTransaction.findFirst({
      where: {
        tenantId,
        inventoryItemId: data.inventoryItemId,
        batchNumber: data.batchNumber,
        transactionType: 'stock_in',
        expiryDate: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { expiryDate: true },
    });
    if (batchIn?.expiryDate && batchIn.expiryDate < today) {
      throw AppError.badRequest(
        `Batch ${data.batchNumber} expired on ${batchIn.expiryDate.toISOString().slice(0, 10)} and cannot be dispensed. Flag and remove it via expiry tracking.`,
      );
    }
  }

  // Calculate new stock level
  let stockDelta: number;
  switch (data.transactionType) {
    case 'stock_in':
    case 'return_stock':
      stockDelta = data.quantity;
      break;
    case 'stock_out':
    case 'expired_removal':
      stockDelta = -data.quantity;
      break;
    case 'adjustment':
      // For adjustments, the quantity represents the absolute new stock level
      stockDelta = data.quantity - item.currentStock;
      break;
    default:
      stockDelta = 0;
  }

  const newStock = item.currentStock + stockDelta;
  if (newStock < 0) {
    throw AppError.badRequest(
      `Insufficient stock. Current stock: ${item.currentStock}, attempted change: ${stockDelta}`,
    );
  }

  const totalCost = data.unitCost ? data.unitCost * data.quantity : undefined;

  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.stockTransaction.create({
      data: {
        tenantId,
        inventoryItemId: data.inventoryItemId,
        transactionType: data.transactionType as any,
        quantity: data.quantity,
        batchNumber: data.batchNumber,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
        supplierId: data.supplierId,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        unitCost: data.unitCost,
        totalCost,
        departmentId: data.departmentId,
        notes: data.notes,
        performedBy: userId,
      },
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, itemCode: true },
        },
      },
    });

    await tx.inventoryItem.update({
      where: { id: data.inventoryItemId },
      data: { currentStock: newStock },
    });

    return transaction;
  });

  logger.info(
    { tenantId, transactionId: result.id, itemId: data.inventoryItemId, type: data.transactionType, quantity: data.quantity },
    'Stock transaction created',
  );

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'stock_transaction',
    entityId: result.id,
    description: `${data.transactionType.replace('_', ' ')} of ${data.quantity} × ${item.itemName}${data.batchNumber ? ` (batch ${data.batchNumber})` : ''}`,
    newValues: {
      transactionType: data.transactionType,
      quantity: data.quantity,
      inventoryItemId: data.inventoryItemId,
      departmentId: data.departmentId ?? null,
    },
  });

  // Reorder alert: fire once when a stock-reducing movement drops the item to
  // or below its threshold (i.e. it just crossed). Skip if it was already low.
  if (
    settings.lowStockAlertEnabled &&
    settings.reorderNotifyEnabled &&
    stockDelta < 0 &&
    newStock <= item.minimumStockThreshold &&
    item.currentStock > item.minimumStockThreshold
  ) {
    void notifyInventoryRecipients({
      tenantId,
      recipientRoles: settings.alertRecipientRoles,
      title: 'Low stock — reorder needed',
      message: `${item.itemName}${item.itemCode ? ` (${item.itemCode})` : ''} dropped to ${newStock} ${item.unitOfMeasurement ?? 'units'} (threshold ${item.minimumStockThreshold}). Raise a purchase order.`,
      referenceType: 'inventory_low_stock',
      referenceId: item.id,
    });
  }

  return result;
}

export async function getStockTransactions(tenantId: string, query: GetStockTransactionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.inventoryItemId) where.inventoryItemId = query.inventoryItemId;
  if (query.transactionType) where.transactionType = query.transactionType;

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { batchNumber: { contains: query.search, mode: 'insensitive' } },
      { notes: { contains: query.search, mode: 'insensitive' } },
      { inventoryItem: { itemName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [transactions, total] = await Promise.all([
    prisma.stockTransaction.findMany({
      where,
      skip,
      take,
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true },
        },
        supplier: {
          select: { id: true, name: true },
        },
        performer: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.stockTransaction.count({ where }),
  ]);

  return { transactions, total, page, limit };
}

export async function getStockTransactionById(tenantId: string, id: string) {
  const transaction = await prisma.stockTransaction.findFirst({
    where: { id, tenantId },
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, currentStock: true },
      },
      supplier: {
        select: { id: true, name: true },
      },
      performer: {
        select: { id: true, firstName: true, lastName: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
  });

  if (!transaction) {
    throw AppError.notFound('Stock transaction not found');
  }

  return transaction;
}

// ============================================================
// Purchase Orders
// ============================================================

// Verify every PO line points at an existing inventory item or formulary drug.
async function assertPoLinesExist(
  tenantId: string,
  items: Array<{ inventoryItemId?: string; drugId?: string }>,
) {
  const itemIds = [...new Set(items.map((i) => i.inventoryItemId).filter((x): x is string => !!x))];
  const drugIds = [...new Set(items.map((i) => i.drugId).filter((x): x is string => !!x))];
  if (itemIds.length) {
    const found = await prisma.inventoryItem.findMany({
      where: { id: { in: itemIds }, tenantId },
      select: { id: true },
    });
    if (found.length !== itemIds.length) throw AppError.badRequest('One or more inventory items not found');
  }
  if (drugIds.length) {
    const found = await prisma.drugFormulary.findMany({
      where: { id: { in: drugIds }, tenantId },
      select: { id: true },
    });
    if (found.length !== drugIds.length) throw AppError.badRequest('One or more drugs not found in the formulary');
  }
}

export async function createPurchaseOrder(tenantId: string, data: CreatePurchaseOrderInput) {
  // Verify supplier exists
  const supplier = await prisma.supplier.findFirst({
    where: { id: data.supplierId, tenantId, isActive: true },
  });

  if (!supplier) {
    throw AppError.notFound('Supplier not found or inactive');
  }

  // A line references EITHER an inventory item OR a pharmacy drug — verify both.
  await assertPoLinesExist(tenantId, data.items);

  const orderNumber = await generateOrderNumber(tenantId);

  // Calculate total amount
  let totalAmount = 0;
  const orderItems = data.items.map((item) => {
    const unitPrice = item.unitPrice ?? 0;
    const totalPrice = unitPrice * item.quantityOrdered;
    totalAmount += totalPrice;
    return {
      inventoryItemId: item.inventoryItemId ?? null,
      drugId: item.drugId ?? null,
      quantityOrdered: item.quantityOrdered,
      unitPrice: unitPrice || undefined,
      totalPrice: totalPrice || undefined,
    };
  });

  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      tenantId,
      supplierId: data.supplierId,
      orderNumber,
      orderDate: new Date(),
      expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : undefined,
      // No draft/approval step — a PO is created ready to receive (shown as
      // "Created" in the UI). Stored as 'approved' since that is the receivable
      // pre-delivery state the receive flow accepts.
      status: 'approved',
      totalAmount: totalAmount || undefined,
      notes: data.notes,
      items: {
        create: orderItems,
      },
    },
    include: {
      supplier: {
        select: { id: true, name: true },
      },
      items: {
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, itemCode: true },
          },
        },
      },
    },
  });

  logger.info({ tenantId, purchaseOrderId: purchaseOrder.id, orderNumber }, 'Purchase order created');
  return purchaseOrder;
}

export async function getPurchaseOrders(tenantId: string, query: GetPurchaseOrdersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.supplierId) where.supplierId = query.supplierId;

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { orderNumber: { contains: query.search, mode: 'insensitive' } },
      { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      skip,
      take,
      include: {
        supplier: {
          select: { id: true, name: true },
        },
        _count: {
          select: { items: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return { orders, total, page, limit };
}

export async function getPurchaseOrderById(tenantId: string, id: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, tenantId },
    include: {
      supplier: {
        select: { id: true, name: true, phone: true, email: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true },
      },
      items: {
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true },
          },
          drug: {
            select: { id: true, drugName: true, genericName: true, manufacturer: true, strength: true, dosageForm: true },
          },
        },
      },
    },
  });

  if (!order) {
    throw AppError.notFound('Purchase order not found');
  }

  return order;
}

export async function updatePurchaseOrder(
  tenantId: string,
  id: string,
  data: UpdatePurchaseOrderInput,
) {
  const existing = await prisma.purchaseOrder.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Purchase order not found');
  }

  if (existing.status !== 'draft') {
    throw AppError.badRequest('Only draft purchase orders can be updated');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Update items if provided
    if (data.items) {
      // A line references an inventory item OR a drug — verify both.
      await assertPoLinesExist(tenantId, data.items);

      // Delete existing items and recreate
      await tx.purchaseOrderItem.deleteMany({
        where: { purchaseOrderId: id },
      });

      let totalAmount = 0;
      for (const item of data.items) {
        const unitPrice = item.unitPrice ?? 0;
        const totalPrice = unitPrice * item.quantityOrdered;
        totalAmount += totalPrice;

        await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: id,
            inventoryItemId: item.inventoryItemId ?? null,
            drugId: item.drugId ?? null,
            quantityOrdered: item.quantityOrdered,
            unitPrice: unitPrice || undefined,
            totalPrice: totalPrice || undefined,
          },
        });
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: { totalAmount: totalAmount || undefined },
      });
    }

    const updateData: any = {};
    if (data.expectedDeliveryDate !== undefined) {
      updateData.expectedDeliveryDate = data.expectedDeliveryDate
        ? new Date(data.expectedDeliveryDate)
        : null;
    }
    if (data.notes !== undefined) updateData.notes = data.notes;

    const order = await tx.purchaseOrder.update({
      where: { id },
      data: updateData,
      include: {
        supplier: {
          select: { id: true, name: true },
        },
        items: {
          include: {
            inventoryItem: {
              select: { id: true, itemName: true, itemCode: true },
            },
          },
        },
      },
    });

    return order;
  });

  logger.info({ tenantId, purchaseOrderId: id }, 'Purchase order updated');
  return result;
}

export async function approvePurchaseOrder(tenantId: string, id: string, approvedBy: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, tenantId },
  });

  if (!order) {
    throw AppError.notFound('Purchase order not found');
  }

  if (order.status !== 'draft' && order.status !== 'submitted') {
    throw AppError.badRequest('Only draft or submitted purchase orders can be approved');
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy,
    },
    include: {
      supplier: {
        select: { id: true, name: true },
      },
      items: {
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, itemCode: true },
          },
        },
      },
    },
  });

  logger.info({ tenantId, purchaseOrderId: id, approvedBy }, 'Purchase order approved');

  void safeInventoryAudit({
    tenantId,
    userId: approvedBy,
    action: 'update',
    entityType: 'purchase_order',
    entityId: id,
    description: `Purchase order ${order.orderNumber} approved`,
    oldValues: { status: order.status },
    newValues: { status: 'approved' },
  });

  return updated;
}

export async function receivePurchaseOrder(
  tenantId: string,
  id: string,
  userId: string,
  data: ReceivePurchaseOrderInput,
) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, tenantId },
    include: { items: true },
  });

  if (!order) {
    throw AppError.notFound('Purchase order not found');
  }

  if (order.status !== 'approved' && order.status !== 'partially_delivered') {
    throw AppError.badRequest('Only approved or partially delivered purchase orders can be received');
  }

  // Validate that all provided item IDs belong to this order
  const orderItemIds = new Set(order.items.map((item) => item.id));
  for (const receivedItem of data.items) {
    if (!orderItemIds.has(receivedItem.purchaseOrderItemId)) {
      throw AppError.badRequest(
        `Purchase order item ${receivedItem.purchaseOrderItemId} does not belong to this order`,
      );
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    let allFullyReceived = true;

    for (const receivedItem of data.items) {
      const poItem = order.items.find((i) => i.id === receivedItem.purchaseOrderItemId)!;
      const newReceivedQty = poItem.quantityReceived + receivedItem.quantityReceived;

      if (newReceivedQty > poItem.quantityOrdered) {
        throw AppError.badRequest(
          `Received quantity (${newReceivedQty}) exceeds ordered quantity (${poItem.quantityOrdered}) for item ${poItem.id}`,
        );
      }

      // Update the PO item received quantity + capture the price entered at
      // arrival (PO creation no longer takes a price).
      await tx.purchaseOrderItem.update({
        where: { id: poItem.id },
        data: {
          quantityReceived: newReceivedQty,
          ...(receivedItem.unitPrice != null
            ? { unitPrice: receivedItem.unitPrice, totalPrice: receivedItem.unitPrice * poItem.quantityOrdered }
            : {}),
        },
      });

      // Post the received stock. A DRUG line lands as a real DrugBatch in pharmacy
      // stock (so purchasing and pharmacy stay connected); an inventory-item line
      // increments InventoryItem stock via a stock_in transaction.
      if (receivedItem.quantityReceived > 0) {
        const unitCost = receivedItem.unitPrice ?? toNumber(poItem.unitPrice);

        if (poItem.drugId) {
          if (!receivedItem.batchNumber || !receivedItem.expiryDate) {
            throw AppError.badRequest('Batch number and expiry date are required to receive a drug line');
          }
          const batchId = randomUUID();
          const batch = await tx.drugBatch.create({
            data: {
              id: batchId,
              tenantId,
              drugId: poItem.drugId,
              batchNumber: receivedItem.batchNumber,
              expiryDate: new Date(receivedItem.expiryDate),
              manufacturingDate: receivedItem.manufacturingDate
                ? new Date(receivedItem.manufacturingDate)
                : undefined,
              supplierId: order.supplierId,
              purchasePrice: unitCost || undefined,
              mrp: receivedItem.mrp,
              sellingPrice: receivedItem.sellingPrice,
              quantityReceived: receivedItem.quantityReceived,
              quantityInStock: receivedItem.quantityReceived,
              invoiceNumber: order.orderNumber,
              storageLocation: receivedItem.storageLocation ?? null,
              barcode: makeInternalBarcode(batchId),
            },
          });
          void safePharmacyAudit({
            tenantId,
            userId,
            action: 'create',
            entityType: 'drug_batch',
            entityId: batch.id,
            description: `Stock in (PO ${order.orderNumber}): ${receivedItem.quantityReceived} unit(s), batch ${receivedItem.batchNumber}`,
            newValues: {
              batchNumber: receivedItem.batchNumber,
              quantityReceived: receivedItem.quantityReceived,
              supplierId: order.supplierId,
              storageLocation: receivedItem.storageLocation ?? null,
              purchaseOrderId: order.id,
            },
          });
        } else if (poItem.inventoryItemId) {
          await tx.stockTransaction.create({
            data: {
              tenantId,
              inventoryItemId: poItem.inventoryItemId,
              transactionType: 'stock_in',
              quantity: receivedItem.quantityReceived,
              supplierId: order.supplierId,
              referenceType: 'purchase_order',
              referenceId: order.id,
              unitCost: unitCost || undefined,
              totalCost: unitCost ? unitCost * receivedItem.quantityReceived : undefined,
              performedBy: userId,
              notes: `Received from PO ${order.orderNumber}`,
            },
          });
          await tx.inventoryItem.update({
            where: { id: poItem.inventoryItemId },
            data: { currentStock: { increment: receivedItem.quantityReceived } },
          });
        }
      }

      if (newReceivedQty < poItem.quantityOrdered) {
        allFullyReceived = false;
      }
    }

    // Check if any non-updated items are also not fully received
    for (const poItem of order.items) {
      const wasUpdated = data.items.some((ri) => ri.purchaseOrderItemId === poItem.id);
      if (!wasUpdated && poItem.quantityReceived < poItem.quantityOrdered) {
        allFullyReceived = false;
      }
    }

    const newStatus = allFullyReceived ? 'delivered' : 'partially_delivered';

    // Recompute the PO value from the per-line prices captured at arrival.
    const freshItems = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: id },
      select: { totalPrice: true },
    });
    const totalAmount = freshItems.reduce((s, it) => s + toNumber(it.totalPrice), 0);

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: newStatus as any, totalAmount: totalAmount || undefined },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: {
            inventoryItem: {
              select: { id: true, itemName: true, itemCode: true, currentStock: true },
            },
            drug: {
              select: { id: true, drugName: true, genericName: true, manufacturer: true, strength: true, dosageForm: true },
            },
          },
        },
      },
    });

    return updated;
  });

  logger.info({ tenantId, purchaseOrderId: id, userId }, 'Purchase order items received');

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'purchase_order',
    entityId: id,
    description: `Purchase order ${order.orderNumber} items received`,
    newValues: { status: result.status, items: data.items },
  });

  return result;
}

export async function cancelPurchaseOrder(
  tenantId: string,
  id: string,
  userId: string,
  data: CancelPurchaseOrderInput,
) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, tenantId },
  });

  if (!order) {
    throw AppError.notFound('Purchase order not found');
  }

  // Once goods start flowing in, cancellation is no longer safe — stock has
  // already been received against the order.
  if (!['draft', 'submitted', 'approved'].includes(order.status)) {
    throw AppError.badRequest(`A ${order.status.replace('_', ' ')} purchase order cannot be cancelled`);
  }

  const reasonNote = data?.reason ? `Cancelled: ${data.reason}` : 'Cancelled';
  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: {
      status: 'cancelled',
      notes: order.notes ? `${order.notes}\n${reasonNote}` : reasonNote,
    },
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        include: {
          inventoryItem: { select: { id: true, itemName: true, itemCode: true } },
        },
      },
    },
  });

  logger.info({ tenantId, purchaseOrderId: id, userId }, 'Purchase order cancelled');

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'purchase_order',
    entityId: id,
    description: `Purchase order ${order.orderNumber} cancelled${data?.reason ? ` — ${data.reason}` : ''}`,
    oldValues: { status: order.status },
    newValues: { status: 'cancelled' },
  });

  return updated;
}

// ============================================================
// Supply Requests
// ============================================================

export async function createSupplyRequest(
  tenantId: string,
  userId: string,
  data: CreateSupplyRequestInput,
) {
  // Verify inventory item exists
  const item = await prisma.inventoryItem.findFirst({
    where: { id: data.inventoryItemId, tenantId, isActive: true },
  });

  if (!item) {
    throw AppError.notFound('Inventory item not found or inactive');
  }

  // Verify department exists
  const department = await prisma.department.findFirst({
    where: { id: data.departmentId, tenantId },
  });

  if (!department) {
    throw AppError.notFound('Department not found');
  }

  const request = await prisma.supplyRequest.create({
    data: {
      tenantId,
      requestedBy: userId,
      departmentId: data.departmentId,
      wardId: data.wardId,
      inventoryItemId: data.inventoryItemId,
      quantityRequested: data.quantityRequested,
      urgency: (data.urgency as any) ?? 'routine',
      notes: data.notes,
      status: 'pending',
    },
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, currentStock: true },
      },
      department: {
        select: { id: true, name: true },
      },
      requester: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info(
    { tenantId, supplyRequestId: request.id, itemId: data.inventoryItemId },
    'Supply request created',
  );
  return request;
}

export async function getSupplyRequests(tenantId: string, query: GetSupplyRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.departmentId) where.departmentId = query.departmentId;
  if ((query as any).wardId) where.wardId = (query as any).wardId;
  if (query.urgency) where.urgency = query.urgency;

  if (query.search) {
    where.OR = [
      { inventoryItem: { itemName: { contains: query.search, mode: 'insensitive' } } },
      { department: { name: { contains: query.search, mode: 'insensitive' } } },
      { notes: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.supplyRequest.findMany({
      where,
      skip,
      take,
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true },
        },
        department: {
          select: { id: true, name: true },
        },
        requester: {
          select: { id: true, firstName: true, lastName: true },
        },
        approver: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.supplyRequest.count({ where }),
  ]);

  return { requests, total, page, limit };
}

export async function getSupplyRequestById(tenantId: string, id: string) {
  const request = await prisma.supplyRequest.findFirst({
    where: { id, tenantId },
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, currentStock: true },
      },
      department: {
        select: { id: true, name: true },
      },
      requester: {
        select: { id: true, firstName: true, lastName: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  if (!request) {
    throw AppError.notFound('Supply request not found');
  }

  return request;
}

export async function approveSupplyRequest(
  tenantId: string,
  id: string,
  approvedBy: string,
  data: ApproveSupplyRequestInput,
) {
  const request = await prisma.supplyRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Supply request not found');
  }

  if (request.status !== 'pending') {
    throw AppError.badRequest('Only pending supply requests can be approved or rejected');
  }

  const updateData: any = {
    status: data.status,
    approvedBy,
  };

  if (data.notes) {
    updateData.notes = data.notes;
  }

  const updated = await prisma.supplyRequest.update({
    where: { id },
    data: updateData,
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true },
      },
      department: {
        select: { id: true, name: true },
      },
      requester: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info(
    { tenantId, supplyRequestId: id, approvedBy, status: data.status },
    `Supply request ${data.status}`,
  );
  return updated;
}

export async function fulfillSupplyRequest(
  tenantId: string,
  id: string,
  fulfilledBy: string,
  data: FulfillSupplyRequestInput,
) {
  const request = await prisma.supplyRequest.findFirst({
    where: { id, tenantId },
    include: {
      inventoryItem: true,
    },
  });

  if (!request) {
    throw AppError.notFound('Supply request not found');
  }

  if (request.status !== 'approved') {
    throw AppError.badRequest('Only approved supply requests can be fulfilled');
  }

  const newFulfilledQty = request.quantityFulfilled + data.quantityFulfilled;
  if (newFulfilledQty > request.quantityRequested) {
    throw AppError.badRequest(
      `Fulfilled quantity (${newFulfilledQty}) exceeds requested quantity (${request.quantityRequested})`,
    );
  }

  // Check stock availability
  if (request.inventoryItem.currentStock < data.quantityFulfilled) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${request.inventoryItem.currentStock}, Requested: ${data.quantityFulfilled}`,
    );
  }

  const isFully = newFulfilledQty >= request.quantityRequested;

  const result = await prisma.$transaction(async (tx) => {
    // Create stock out transaction
    await tx.stockTransaction.create({
      data: {
        tenantId,
        inventoryItemId: request.inventoryItemId,
        transactionType: 'stock_out',
        quantity: data.quantityFulfilled,
        departmentId: request.departmentId,
        referenceType: 'supply_request',
        referenceId: request.id,
        performedBy: fulfilledBy,
        notes: data.notes ?? `Fulfilled supply request ${request.id}`,
      },
    });

    // Update inventory stock
    await tx.inventoryItem.update({
      where: { id: request.inventoryItemId },
      data: {
        currentStock: { decrement: data.quantityFulfilled },
      },
    });

    // Update supply request
    const updated = await tx.supplyRequest.update({
      where: { id },
      data: {
        quantityFulfilled: newFulfilledQty,
        status: isFully ? 'fulfilled' : 'approved',
        notes: data.notes ?? request.notes,
      },
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, itemCode: true, currentStock: true },
        },
        department: {
          select: { id: true, name: true },
        },
        requester: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    return updated;
  });

  logger.info(
    { tenantId, supplyRequestId: id, fulfilledBy, quantity: data.quantityFulfilled },
    'Supply request fulfilled',
  );
  return result;
}

// ============================================================
// Alert run — "alert inventory manager"
// ============================================================

/**
 * Scan low-stock items and soon-to-expire batches and notify the configured
 * recipient roles. Optionally auto-flags fully expired batches first. Used by
 * the on-demand "Run alerts now" action and the daily scheduled job.
 *
 * Alerts are de-duplicated against existing unread notifications so repeated
 * runs don't spam managers about the same item / batch.
 */
export async function runInventoryAlerts(
  tenantId: string,
  userId: string,
  opts: RunInventoryAlertsInput = {},
) {
  const settings = await getInventorySettings(tenantId);

  let expiredFlagged = 0;
  let lowStockAlerts = 0;
  let expiryAlerts = 0;

  // 1. Optionally remove fully-expired batches before alerting.
  if (opts?.autoFlagExpired ?? settings.autoFlagExpired) {
    const flaggedResult = await flagExpiredInventory(tenantId, userId);
    expiredFlagged = flaggedResult.flagged;
  }

  // 2. Low-stock / reorder alerts.
  if (settings.lowStockAlertEnabled) {
    const { items } = await getLowStockItems(tenantId, { page: 1, limit: 1000 });
    for (const it of items as Array<{ id: string; item_name?: string; itemName?: string; item_code?: string; itemCode?: string; current_stock?: number; currentStock?: number; minimum_stock_threshold?: number; minimumStockThreshold?: number; unit_of_measurement?: string; unitOfMeasurement?: string }>) {
      // getLowStockItems uses a raw query → snake_case columns; tolerate both.
      const itemId = it.id;
      const itemName = it.itemName ?? it.item_name ?? 'Item';
      const itemCode = it.itemCode ?? it.item_code ?? null;
      const current = it.currentStock ?? it.current_stock ?? 0;
      const threshold = it.minimumStockThreshold ?? it.minimum_stock_threshold ?? 0;
      const unit = it.unitOfMeasurement ?? it.unit_of_measurement ?? 'units';

      if (await hasOpenInventoryAlert(tenantId, 'inventory_low_stock', itemId)) continue;

      const sent = await notifyInventoryRecipients({
        tenantId,
        recipientRoles: settings.alertRecipientRoles,
        title: 'Low stock — reorder needed',
        message: `${itemName}${itemCode ? ` (${itemCode})` : ''} is at ${current} ${unit} (threshold ${threshold}). Raise a purchase order.`,
        referenceType: 'inventory_low_stock',
        referenceId: itemId,
      });
      if (sent > 0) lowStockAlerts += 1;
    }
  }

  // 3. Expiry alerts within the configured look-ahead window.
  if (settings.expiryAlertEnabled) {
    const { items } = await getExpiringInventory(tenantId, { months: settings.expiryAlertMonths } as GetExpiringQuery);
    for (const row of items) {
      if (await hasOpenInventoryAlert(tenantId, 'inventory_expiry', row.transactionId)) continue;

      const expiry = row.expiryDate ? new Date(row.expiryDate).toISOString().slice(0, 10) : 'soon';
      const sent = await notifyInventoryRecipients({
        tenantId,
        recipientRoles: settings.alertRecipientRoles,
        title: 'Stock expiring soon',
        message: `${row.item.itemName}${row.batchNumber ? ` batch ${row.batchNumber}` : ''} — ${row.remainingQuantity} ${row.item.unitOfMeasurement ?? 'units'} expiring on ${expiry}.`,
        referenceType: 'inventory_expiry',
        referenceId: row.transactionId,
      });
      if (sent > 0) expiryAlerts += 1;
    }
  }

  await prisma.inventorySetting.update({
    where: { tenantId },
    data: { lastAlertRunAt: new Date() },
  });

  logger.info(
    { tenantId, lowStockAlerts, expiryAlerts, expiredFlagged },
    'Inventory alert run complete',
  );

  return { lowStockAlerts, expiryAlerts, expiredFlagged, ranAt: new Date().toISOString() };
}
