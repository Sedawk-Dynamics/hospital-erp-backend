import { prisma } from '../../config/database';
import { getPaginationParams } from '../../shared/pagination';

// ============================================================
// Stock Balance Report — daily or monthly snapshot of inflow / outflow / net
// per item. We derive movement from StockTransaction rows in the date window.
// ============================================================

export interface StockBalanceQuery {
  fromDate?: string;
  toDate?: string;
  groupBy?: 'day' | 'month';
  inventoryItemId?: string;
  category?: string;
}

export async function getStockBalanceReport(tenantId: string, query: StockBalanceQuery) {
  const toDate = query.toDate ? new Date(query.toDate) : new Date();
  const fromDate = query.fromDate
    ? new Date(query.fromDate)
    : (() => {
        const d = new Date(toDate);
        d.setDate(d.getDate() - 30);
        return d;
      })();

  const where: any = {
    tenantId,
    createdAt: { gte: fromDate, lte: toDate },
  };
  if (query.inventoryItemId) where.inventoryItemId = query.inventoryItemId;
  if (query.category) where.inventoryItem = { category: query.category };

  const transactions = await prisma.stockTransaction.findMany({
    where,
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, category: true, currentStock: true, unitOfMeasurement: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Roll up per item × bucket
  const buckets = new Map<
    string,
    {
      itemId: string;
      itemName: string;
      itemCode: string | null;
      category: string;
      bucket: string;
      stockIn: number;
      stockOut: number;
      adjustments: number;
      expiredRemoval: number;
      returns: number;
      net: number;
    }
  >();

  const bucketKey = (d: Date) =>
    query.groupBy === 'month'
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  for (const tx of transactions) {
    const bucket = bucketKey(tx.createdAt);
    const key = `${tx.inventoryItemId}|${bucket}`;
    let row = buckets.get(key);
    if (!row) {
      row = {
        itemId: tx.inventoryItem.id,
        itemName: tx.inventoryItem.itemName,
        itemCode: tx.inventoryItem.itemCode,
        category: tx.inventoryItem.category,
        bucket,
        stockIn: 0,
        stockOut: 0,
        adjustments: 0,
        expiredRemoval: 0,
        returns: 0,
        net: 0,
      };
      buckets.set(key, row);
    }
    switch (tx.transactionType) {
      case 'stock_in':
        row.stockIn += tx.quantity;
        row.net += tx.quantity;
        break;
      case 'stock_out':
        row.stockOut += tx.quantity;
        row.net -= tx.quantity;
        break;
      case 'return_stock':
        row.returns += tx.quantity;
        row.net += tx.quantity;
        break;
      case 'expired_removal':
        row.expiredRemoval += tx.quantity;
        row.net -= tx.quantity;
        break;
      case 'adjustment':
        row.adjustments += tx.quantity;
        break;
    }
  }

  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (a.bucket === b.bucket) return a.itemName.localeCompare(b.itemName);
    return a.bucket.localeCompare(b.bucket);
  });

  // Per-item summary (current stock + total flow in window)
  const itemSummary = new Map<
    string,
    { itemId: string; itemName: string; itemCode: string | null; category: string; currentStock: number; totalIn: number; totalOut: number; net: number; unit: string | null }
  >();

  for (const tx of transactions) {
    let row = itemSummary.get(tx.inventoryItemId);
    if (!row) {
      row = {
        itemId: tx.inventoryItem.id,
        itemName: tx.inventoryItem.itemName,
        itemCode: tx.inventoryItem.itemCode,
        category: tx.inventoryItem.category,
        currentStock: tx.inventoryItem.currentStock,
        unit: tx.inventoryItem.unitOfMeasurement,
        totalIn: 0,
        totalOut: 0,
        net: 0,
      };
      itemSummary.set(tx.inventoryItemId, row);
    }
    if (tx.transactionType === 'stock_in' || tx.transactionType === 'return_stock') {
      row.totalIn += tx.quantity;
      row.net += tx.quantity;
    } else if (tx.transactionType === 'stock_out' || tx.transactionType === 'expired_removal') {
      row.totalOut += tx.quantity;
      row.net -= tx.quantity;
    }
  }

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    groupBy: query.groupBy ?? 'day',
    items: Array.from(itemSummary.values()).sort((a, b) => a.itemName.localeCompare(b.itemName)),
    movements: rows,
    totals: {
      stockIn: rows.reduce((s, r) => s + r.stockIn, 0),
      stockOut: rows.reduce((s, r) => s + r.stockOut, 0),
      returns: rows.reduce((s, r) => s + r.returns, 0),
      expiredRemoval: rows.reduce((s, r) => s + r.expiredRemoval, 0),
    },
  };
}

// ============================================================
// Department Consumption Report — usage by department over a window.
// Pulls from StockTransaction rows tagged with departmentId.
// ============================================================

export interface DeptConsumptionQuery {
  fromDate?: string;
  toDate?: string;
  departmentId?: string;
  inventoryItemId?: string;
}

export async function getDepartmentConsumptionReport(tenantId: string, query: DeptConsumptionQuery) {
  const toDate = query.toDate ? new Date(query.toDate) : new Date();
  const fromDate = query.fromDate
    ? new Date(query.fromDate)
    : (() => {
        const d = new Date(toDate);
        d.setDate(d.getDate() - 30);
        return d;
      })();

  const where: any = {
    tenantId,
    createdAt: { gte: fromDate, lte: toDate },
    transactionType: { in: ['stock_out', 'expired_removal'] as const },
    departmentId: { not: null },
  };
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.inventoryItemId) where.inventoryItemId = query.inventoryItemId;

  const transactions = await prisma.stockTransaction.findMany({
    where,
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, category: true, unitOfMeasurement: true, costPerUnit: true },
      },
      department: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  type DeptRow = {
    departmentId: string;
    departmentName: string;
    items: Map<string, { itemId: string; itemName: string; itemCode: string | null; category: string; unit: string | null; quantity: number; totalCost: number }>;
    totalQuantity: number;
    totalCost: number;
  };
  const depts = new Map<string, DeptRow>();

  for (const tx of transactions) {
    const dept = tx.department;
    if (!dept) continue;
    let row = depts.get(dept.id);
    if (!row) {
      row = { departmentId: dept.id, departmentName: dept.name, items: new Map(), totalQuantity: 0, totalCost: 0 };
      depts.set(dept.id, row);
    }
    const itemRow = row.items.get(tx.inventoryItemId) ?? {
      itemId: tx.inventoryItem.id,
      itemName: tx.inventoryItem.itemName,
      itemCode: tx.inventoryItem.itemCode,
      category: tx.inventoryItem.category,
      unit: tx.inventoryItem.unitOfMeasurement,
      quantity: 0,
      totalCost: 0,
    };
    itemRow.quantity += tx.quantity;
    const lineCost = tx.totalCost
      ? Number(tx.totalCost)
      : tx.unitCost
        ? Number(tx.unitCost) * tx.quantity
        : tx.inventoryItem.costPerUnit
          ? Number(tx.inventoryItem.costPerUnit) * tx.quantity
          : 0;
    itemRow.totalCost += lineCost;
    row.items.set(tx.inventoryItemId, itemRow);
    row.totalQuantity += tx.quantity;
    row.totalCost += lineCost;
  }

  const departments = Array.from(depts.values()).map((row) => ({
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    totalQuantity: row.totalQuantity,
    totalCost: row.totalCost,
    items: Array.from(row.items.values()).sort((a, b) => b.quantity - a.quantity),
  }));

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    departments: departments.sort((a, b) => b.totalQuantity - a.totalQuantity),
    totals: {
      quantity: departments.reduce((s, d) => s + d.totalQuantity, 0),
      cost: departments.reduce((s, d) => s + d.totalCost, 0),
    },
  };
}

// ============================================================
// Reorder History Report — past purchase orders with supplier + qty.
// Filters by supplier, item, status, date range.
// ============================================================

export interface ReorderHistoryQuery {
  fromDate?: string;
  toDate?: string;
  supplierId?: string;
  inventoryItemId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export async function getReorderHistoryReport(tenantId: string, query: ReorderHistoryQuery) {
  const { skip, take, page, limit } = getPaginationParams({
    page: query.page,
    limit: query.limit ?? 50,
    sortOrder: 'desc',
  } as any);

  const where: any = { tenantId };
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.status) where.status = query.status;
  if (query.fromDate || query.toDate) {
    where.orderDate = {};
    if (query.fromDate) where.orderDate.gte = new Date(query.fromDate);
    if (query.toDate) where.orderDate.lte = new Date(query.toDate);
  }
  if (query.inventoryItemId) {
    where.items = { some: { inventoryItemId: query.inventoryItemId } };
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      skip,
      take,
      include: {
        supplier: { select: { id: true, name: true, contactPerson: true, phone: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
        items: {
          include: {
            inventoryItem: { select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true } },
          },
          ...(query.inventoryItemId ? { where: { inventoryItemId: query.inventoryItemId } } : {}),
        },
      },
      orderBy: { orderDate: 'desc' },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  // Compute supplier-wise totals across the entire window (not just current page)
  const supplierTotals = await prisma.purchaseOrder.groupBy({
    by: ['supplierId'],
    where,
    _sum: { totalAmount: true },
    _count: { id: true },
  });

  const supplierMeta = await prisma.supplier.findMany({
    where: { id: { in: supplierTotals.map((s) => s.supplierId) } },
    select: { id: true, name: true },
  });
  const supplierMap = new Map(supplierMeta.map((s) => [s.id, s.name] as const));

  const bySupplier = supplierTotals
    .map((s) => ({
      supplierId: s.supplierId,
      supplierName: supplierMap.get(s.supplierId) ?? 'Unknown',
      orderCount: s._count.id,
      totalAmount: s._sum.totalAmount ? Number(s._sum.totalAmount) : 0,
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  return {
    orders,
    bySupplier,
    page,
    limit,
    total,
  };
}

// ============================================================
// Expiry & Waste Report — combined: expired/expiring batches + returns.
// ============================================================

export interface ExpiryWasteQuery {
  fromDate?: string;
  toDate?: string;
  windowMonths?: number;
  inventoryItemId?: string;
}

export async function getExpiryWasteReport(tenantId: string, query: ExpiryWasteQuery) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowMonths = query.windowMonths ?? 3;
  const threshold = new Date(today);
  threshold.setMonth(threshold.getMonth() + windowMonths);

  // 1. Expiring batches (stock_in rows w/ expiryDate in next N months, remaining > 0)
  const expiringIns = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'stock_in',
      expiryDate: { gte: today, lte: threshold },
      ...(query.inventoryItemId ? { inventoryItemId: query.inventoryItemId } : {}),
    },
    include: {
      inventoryItem: { select: { id: true, itemName: true, itemCode: true, unitOfMeasurement: true, category: true } },
    },
    orderBy: { expiryDate: 'asc' },
  });

  const expiringBatches = await Promise.all(
    expiringIns.map(async (tx) => {
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
        item: tx.inventoryItem,
        batchNumber: tx.batchNumber,
        expiryDate: tx.expiryDate,
        receivedAt: tx.createdAt,
        receivedQuantity: tx.quantity,
        remainingQuantity: Math.max(0, remaining),
        unitCost: tx.unitCost ? Number(tx.unitCost) : 0,
      };
    }),
  );

  // 2. Expired removals (waste) in window
  const fromDate = query.fromDate ? new Date(query.fromDate) : (() => {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 6);
    return d;
  })();
  const toDate = query.toDate ? new Date(query.toDate) : new Date();

  const expiredRemovals = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'expired_removal',
      createdAt: { gte: fromDate, lte: toDate },
      ...(query.inventoryItemId ? { inventoryItemId: query.inventoryItemId } : {}),
    },
    include: {
      inventoryItem: {
        select: { id: true, itemName: true, itemCode: true, category: true, unitOfMeasurement: true, costPerUnit: true },
      },
      performer: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // 3. Returns (return_stock)
  const returns = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'return_stock',
      createdAt: { gte: fromDate, lte: toDate },
      ...(query.inventoryItemId ? { inventoryItemId: query.inventoryItemId } : {}),
    },
    include: {
      inventoryItem: { select: { id: true, itemName: true, itemCode: true, category: true, unitOfMeasurement: true } },
      supplier: { select: { id: true, name: true } },
      performer: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const wasteValue = expiredRemovals.reduce((s, tx) => {
    const cost = tx.totalCost
      ? Number(tx.totalCost)
      : tx.unitCost
        ? Number(tx.unitCost) * tx.quantity
        : tx.inventoryItem.costPerUnit
          ? Number(tx.inventoryItem.costPerUnit) * tx.quantity
          : 0;
    return s + cost;
  }, 0);

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    windowMonths,
    expiringBatches: expiringBatches.filter((b) => b.remainingQuantity > 0),
    expiredRemovals,
    returns,
    summary: {
      expiringCount: expiringBatches.filter((b) => b.remainingQuantity > 0).length,
      expiredCount: expiredRemovals.length,
      returnCount: returns.length,
      wasteValue,
      expiredQuantity: expiredRemovals.reduce((s, t) => s + t.quantity, 0),
      returnQuantity: returns.reduce((s, t) => s + t.quantity, 0),
    },
  };
}

// ============================================================
// Audit logs for inventory actions — wrapper around AuditLog filtered to
// inventory entity types so the UI can render an actions feed in-context.
// ============================================================

export interface InventoryAuditQuery {
  fromDate?: string;
  toDate?: string;
  userId?: string;
  action?: 'create' | 'update' | 'delete';
  entityType?: string;
  page?: number;
  limit?: number;
  search?: string;
}

const INVENTORY_ENTITY_TYPES = [
  'inventory_item',
  'supplier',
  'stock_transaction',
  'purchase_order',
  'supply_request',
  'stock_transfer',
  // Pharmacy sub-store stock actions (written by pharmacy.audit.ts) appear
  // in the same register so the hospital has one audit trail for all stock.
  'drug_batch',
  'dispensing_record',
  'pharmacy_sale',
  'drug_return',
];

export async function getInventoryAuditLogs(tenantId: string, query: InventoryAuditQuery) {
  const { skip, take, page, limit } = getPaginationParams({
    page: query.page,
    limit: query.limit ?? 50,
    sortOrder: 'desc',
  } as any);

  const where: any = {
    tenantId,
    entityType: query.entityType ? query.entityType : { in: INVENTORY_ENTITY_TYPES },
  };
  if (query.userId) where.userId = query.userId;
  if (query.action) where.action = query.action;
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }
  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { entityType: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total, page, limit };
}
