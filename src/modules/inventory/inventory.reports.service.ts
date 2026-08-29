import { prisma } from '../../config/database';
import { getPaginationParams } from '../../shared/pagination';

// ============================================================
// Stock Balance Report — daily or monthly snapshot of inflow / outflow / net
// per product.
//
// Stock lives in TWO systems: the legacy InventoryItem + StockTransaction pair,
// and the formulary + batches that every type of stock now uses. Reading only
// StockTransaction (as this once did) made the report almost empty — it showed
// a handful of legacy rows while the real movement sat in batches, which reads
// as "no stock" rather than "wrong report". So we normalise both into one
// movement stream and roll that up.
//
// Drug-side flows covered: batch receipts (in), dispensing (out), processed
// returns (in), expired batches (out). Manual batch adjustments live in the
// audit log rather than a movement table, so they are counted for legacy items
// only — noted in `adjustmentsCoverLegacyOnly` on the response.
// ============================================================

export interface StockBalanceQuery {
  fromDate?: string;
  toDate?: string;
  groupBy?: 'day' | 'month';
  inventoryItemId?: string;
  category?: string;
}

// One normalised stock movement, whichever system it came from.
interface Movement {
  refId: string;
  name: string;
  code: string | null;
  category: string;
  unit: string | null;
  date: Date;
  kind: 'in' | 'out' | 'return' | 'expired' | 'adjustment';
  qty: number;
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

  const window = { gte: fromDate, lte: toDate };

  const where: any = { tenantId, createdAt: window };
  if (query.inventoryItemId) where.inventoryItemId = query.inventoryItemId;
  if (query.category) where.inventoryItem = { category: query.category };

  // A drug filter reuses `inventoryItemId` as "the product id" — the caller has
  // one id field and a formulary row is just as valid a product as a legacy item.
  const drugId = query.inventoryItemId;
  const drugWhere = query.category ? { category: query.category as any } : {};
  // Dispenses and returns reach the product through their batch, so BOTH the
  // product filter and the category filter have to be expressed there — filtering
  // only by drugId would let every other category's outflow leak into a
  // category-filtered report.
  const batchDrugFilter =
    drugId || query.category
      ? {
          drugBatch: {
            ...(drugId ? { drugId } : {}),
            ...(query.category ? { drug: drugWhere } : {}),
          },
        }
      : {};
  const drugSelect = {
    id: true, drugName: true, category: true, hsnCode: true, looseUnitLabel: true,
  } as const;

  const [transactions, batches, dispenses, returns, expiredBatches, stockByDrug] =
    await Promise.all([
      prisma.stockTransaction.findMany({
        where,
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, itemCode: true, category: true, currentStock: true, unitOfMeasurement: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      // Receipts — a batch row IS the inward movement.
      prisma.drugBatch.findMany({
        where: { tenantId, createdAt: window, ...(drugId ? { drugId } : {}), drug: drugWhere },
        select: { createdAt: true, quantityReceived: true, drug: { select: drugSelect } },
      }),
      prisma.dispensingRecord.findMany({
        where: { tenantId, cancelledAt: null, dispensedAt: window, ...batchDrugFilter },
        select: {
          dispensedAt: true, quantityDispensed: true,
          drugBatch: { select: { drug: { select: drugSelect } } },
        },
      }),
      prisma.drugReturn.findMany({
        where: { tenantId, status: 'processed', createdAt: window, drugBatchId: { not: null }, ...batchDrugFilter },
        select: {
          createdAt: true, quantity: true,
          drugBatch: { select: { drug: { select: drugSelect } } },
        },
      }),
      // Expiry is a write-off out of stock; date it by when it was flagged.
      prisma.drugBatch.findMany({
        where: { tenantId, isExpired: true, updatedAt: window, ...(drugId ? { drugId } : {}), drug: drugWhere },
        select: { updatedAt: true, quantityInStock: true, drug: { select: drugSelect } },
      }),
      prisma.drugBatch.groupBy({
        by: ['drugId'],
        where: { tenantId, isExpired: false },
        _sum: { quantityInStock: true },
      }),
    ]);

  const stockFor = new Map(stockByDrug.map((g) => [g.drugId, g._sum.quantityInStock ?? 0]));
  const fromDrug = (d: { id: string; drugName: string; category: string; hsnCode: string | null; looseUnitLabel: string | null }) => ({
    refId: d.id, name: d.drugName, code: d.hsnCode, category: d.category, unit: d.looseUnitLabel,
  });

  const movements: Movement[] = [
    ...transactions.map((tx): Movement => ({
      refId: tx.inventoryItem.id,
      name: tx.inventoryItem.itemName,
      code: tx.inventoryItem.itemCode,
      category: tx.inventoryItem.category,
      unit: tx.inventoryItem.unitOfMeasurement,
      date: tx.createdAt,
      kind:
        tx.transactionType === 'stock_in' ? 'in'
        : tx.transactionType === 'stock_out' ? 'out'
        : tx.transactionType === 'return_stock' ? 'return'
        : tx.transactionType === 'expired_removal' ? 'expired'
        : 'adjustment',
      qty: tx.quantity,
    })),
    ...batches.map((b): Movement => ({ ...fromDrug(b.drug), date: b.createdAt, kind: 'in', qty: b.quantityReceived })),
    ...dispenses
      .filter((d) => d.drugBatch?.drug)
      .map((d): Movement => ({ ...fromDrug(d.drugBatch!.drug), date: d.dispensedAt, kind: 'out', qty: d.quantityDispensed })),
    ...returns
      .filter((r) => r.drugBatch?.drug)
      .map((r): Movement => ({ ...fromDrug(r.drugBatch!.drug), date: r.createdAt, kind: 'return', qty: r.quantity })),
    ...expiredBatches
      .filter((b) => b.quantityInStock > 0)
      .map((b): Movement => ({ ...fromDrug(b.drug), date: b.updatedAt, kind: 'expired', qty: b.quantityInStock })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Current on-hand per product: legacy items carry it on the row, formulary
  // products derive it from their live (non-expired) batches.
  const currentStockFor = (refId: string) =>
    stockFor.get(refId) ??
    transactions.find((t) => t.inventoryItem.id === refId)?.inventoryItem.currentStock ??
    0;

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

  for (const m of movements) {
    const bucket = bucketKey(m.date);
    const key = `${m.refId}|${bucket}`;
    let row = buckets.get(key);
    if (!row) {
      row = {
        itemId: m.refId,
        itemName: m.name,
        itemCode: m.code,
        category: m.category,
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
    switch (m.kind) {
      case 'in':
        row.stockIn += m.qty;
        row.net += m.qty;
        break;
      case 'out':
        row.stockOut += m.qty;
        row.net -= m.qty;
        break;
      case 'return':
        row.returns += m.qty;
        row.net += m.qty;
        break;
      case 'expired':
        row.expiredRemoval += m.qty;
        row.net -= m.qty;
        break;
      case 'adjustment':
        row.adjustments += m.qty;
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

  for (const m of movements) {
    let row = itemSummary.get(m.refId);
    if (!row) {
      row = {
        itemId: m.refId,
        itemName: m.name,
        itemCode: m.code,
        category: m.category,
        currentStock: currentStockFor(m.refId),
        unit: m.unit,
        totalIn: 0,
        totalOut: 0,
        net: 0,
      };
      itemSummary.set(m.refId, row);
    }
    if (m.kind === 'in' || m.kind === 'return') {
      row.totalIn += m.qty;
      row.net += m.qty;
    } else if (m.kind === 'out' || m.kind === 'expired') {
      row.totalOut += m.qty;
      row.net -= m.qty;
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
    // Manual batch adjustments are audit-log entries, not movement rows, so the
    // adjustments column reflects legacy items only. Surfaced so the UI can say
    // so rather than implying drug adjustments were nil.
    adjustmentsCoverLegacyOnly: true,
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

  // ── Pharmacy sub-store consumption ──────────────────────
  // The pharmacy tracks its own stock (DrugBatch/DispensingRecord), so its
  // outflow never shows up as StockTransaction rows. Aggregate dispenses in
  // the window into a synthetic "Pharmacy" department so the hospital-wide
  // consumption report covers drug stock too. Cost basis = batch purchase
  // price (consumption cost, not the billed MRP).
  if (!query.departmentId && !query.inventoryItemId) {
    const dispenses = await prisma.dispensingRecord.findMany({
      where: { tenantId, cancelledAt: null, dispensedAt: { gte: fromDate, lte: toDate } },
      include: {
        drugBatch: {
          select: {
            purchasePrice: true,
            drug: { select: { id: true, drugName: true, unitOfMeasurement: true, category: true } },
          },
        },
      },
    });

    if (dispenses.length > 0) {
      const drugRows = new Map<string, { itemId: string; itemName: string; itemCode: string | null; category: string; unit: string | null; quantity: number; totalCost: number }>();
      let pharmacyQty = 0;
      let pharmacyCost = 0;
      for (const d of dispenses) {
        const drug = d.drugBatch.drug;
        const row = drugRows.get(drug.id) ?? {
          itemId: drug.id,
          itemName: drug.drugName,
          itemCode: null,
          // The formulary holds every type of stock now, so report the row's real
          // category rather than assuming everything dispensed is a medicine.
          category: drug.category,
          unit: drug.unitOfMeasurement ?? null,
          quantity: 0,
          totalCost: 0,
        };
        const cost = d.drugBatch.purchasePrice
          ? Number(d.drugBatch.purchasePrice) * d.quantityDispensed
          : 0;
        row.quantity += d.quantityDispensed;
        row.totalCost += cost;
        drugRows.set(drug.id, row);
        pharmacyQty += d.quantityDispensed;
        pharmacyCost += cost;
      }
      departments.push({
        departmentId: 'pharmacy',
        departmentName: 'Pharmacy (drug sub-store)',
        totalQuantity: pharmacyQty,
        totalCost: pharmacyCost,
        items: Array.from(drugRows.values()).sort((a, b) => b.quantity - a.quantity),
      });
    }
  }

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
        supplier: { select: { id: true, name: true, phone: true } },
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

  // 4. The same three things from the batch-tracked side, where nearly all stock
  //    now lives. Expiry is first-class there — a DrugBatch carries its own
  //    expiryDate, remaining quantity and cost — so no reconstruction from
  //    movement rows is needed. Shaped to match the legacy rows above so the
  //    report renders one combined list.
  const drugFilter = query.inventoryItemId ? { drugId: query.inventoryItemId } : {};
  const drugCols = {
    id: true, drugName: true, hsnCode: true, looseUnitLabel: true, category: true,
  } as const;

  const [drugExpiring, drugExpired, drugReturns] = await Promise.all([
    prisma.drugBatch.findMany({
      where: {
        tenantId, isExpired: false, quantityInStock: { gt: 0 },
        expiryDate: { gte: today, lte: threshold }, ...drugFilter,
      },
      select: {
        id: true, batchNumber: true, expiryDate: true, createdAt: true,
        quantityReceived: true, quantityInStock: true, purchasePrice: true,
        drug: { select: drugCols },
      },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, isExpired: true, updatedAt: { gte: fromDate, lte: toDate }, ...drugFilter },
      select: {
        id: true, batchNumber: true, quantityInStock: true, updatedAt: true,
        purchasePrice: true, drug: { select: drugCols },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.drugReturn.findMany({
      where: { tenantId, status: 'processed', createdAt: { gte: fromDate, lte: toDate } },
      select: {
        id: true, quantity: true, createdAt: true, batchNumber: true,
        supplier: { select: { id: true, name: true } },
        drug: { select: drugCols },
        drugBatch: { select: { batchNumber: true, drug: { select: drugCols } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const asItem = (d: { id: string; drugName: string; hsnCode: string | null; looseUnitLabel: string | null; category: string }) => ({
    id: d.id, itemName: d.drugName, itemCode: d.hsnCode,
    unitOfMeasurement: d.looseUnitLabel, category: d.category,
  });

  const allExpiring = [
    ...expiringBatches.filter((b) => b.remainingQuantity > 0),
    ...drugExpiring.map((b) => ({
      transactionId: b.id,
      item: asItem(b.drug),
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      receivedAt: b.createdAt,
      receivedQuantity: b.quantityReceived,
      remainingQuantity: b.quantityInStock,
      unitCost: b.purchasePrice ? Number(b.purchasePrice) : 0,
    })),
  ].sort((a, b) => (a.expiryDate?.getTime() ?? 0) - (b.expiryDate?.getTime() ?? 0));

  const allExpired = [
    ...expiredRemovals,
    ...drugExpired
      .filter((b) => b.quantityInStock > 0)
      .map((b) => ({
        id: b.id,
        inventoryItem: asItem(b.drug),
        batchNumber: b.batchNumber,
        quantity: b.quantityInStock,
        createdAt: b.updatedAt,
        // Expiry is flagged by the scheduled expiry job, not a person.
        performer: null,
        unitCost: b.purchasePrice,
        totalCost: b.purchasePrice ? Number(b.purchasePrice) * b.quantityInStock : null,
      })),
  ];

  const allReturns = [
    ...returns,
    ...drugReturns.map((r) => {
      const drug = r.drugBatch?.drug ?? r.drug;
      return {
        id: r.id,
        inventoryItem: drug ? asItem(drug) : null,
        batchNumber: r.drugBatch?.batchNumber ?? r.batchNumber,
        quantity: r.quantity,
        supplier: r.supplier,
        createdAt: r.createdAt,
        performer: null,
      };
    }),
  ];

  const legacyWaste = expiredRemovals.reduce((s, tx) => {
    const cost = tx.totalCost
      ? Number(tx.totalCost)
      : tx.unitCost
        ? Number(tx.unitCost) * tx.quantity
        : tx.inventoryItem.costPerUnit
          ? Number(tx.inventoryItem.costPerUnit) * tx.quantity
          : 0;
    return s + cost;
  }, 0);
  const drugWaste = drugExpired.reduce(
    (s, b) => s + (b.purchasePrice ? Number(b.purchasePrice) * b.quantityInStock : 0),
    0,
  );

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    windowMonths,
    expiringBatches: allExpiring,
    expiredRemovals: allExpired,
    returns: allReturns,
    summary: {
      expiringCount: allExpiring.length,
      expiredCount: allExpired.length,
      returnCount: allReturns.length,
      wasteValue: legacyWaste + drugWaste,
      expiredQuantity: allExpired.reduce((s, t) => s + t.quantity, 0),
      returnQuantity: allReturns.reduce((s, t) => s + t.quantity, 0),
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
