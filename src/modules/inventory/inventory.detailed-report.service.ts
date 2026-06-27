import { prisma } from '../../config/database';
import { getExpiryWasteReport, getDepartmentConsumptionReport } from './inventory.reports.service';

// ============================================================
// Inventory — Detailed Analysis report (single-call deep rollup).
//
// Stock valuation by category, low-stock reorder, movement summary + daily
// trend, top-consumed items, purchase-order spend by status/supplier, stock
// transfers by status, and (reusing the existing reports) expiry/waste exposure
// and department consumption — for a date range (defaults to last 30 days).
// ============================================================

interface Range {
  fromDate?: string;
  toDate?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

function resolveRange(range: Range) {
  const to = range.toDate ? new Date(`${range.toDate}T23:59:59.999+05:30`) : new Date();
  const from = range.fromDate ? new Date(`${range.fromDate}T00:00:00.000+05:30`) : new Date(to.getTime() - 29 * DAY_MS);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  return { from, to, days };
}

export async function getInventoryDetailedReport(tenantId: string, range: Range) {
  const { from, to, days } = resolveRange(range);

  const [items, txns, pos, transfers, expiry, dept] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { tenantId, isActive: true },
      select: {
        itemName: true, itemCode: true, category: true, currentStock: true,
        minimumStockThreshold: true, costPerUnit: true, sellingPricePerUnit: true, unitOfMeasurement: true,
      },
    }),
    prisma.stockTransaction.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
      select: {
        transactionType: true, quantity: true, totalCost: true, unitCost: true, createdAt: true,
        inventoryItem: { select: { id: true, itemName: true, category: true } },
      },
    }),
    prisma.purchaseOrder.findMany({
      where: { tenantId, orderDate: { gte: from, lte: to } },
      select: { status: true, totalAmount: true, supplierId: true, supplier: { select: { name: true } } },
    }),
    prisma.stockTransfer.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
      select: { status: true, quantityTransferred: true },
    }),
    getExpiryWasteReport(tenantId, { fromDate: range.fromDate, toDate: range.toDate }),
    getDepartmentConsumptionReport(tenantId, { fromDate: range.fromDate, toDate: range.toDate }),
  ]);

  // ---- Valuation (live, by category) ----
  const byCategory = new Map<string, { items: number; units: number; costValue: number; retailValue: number }>();
  let totalCostValue = 0, totalRetailValue = 0, totalUnits = 0;
  for (const it of items) {
    const stock = it.currentStock;
    const cost = num(it.costPerUnit) * stock;
    const retail = num(it.sellingPricePerUnit ?? it.costPerUnit) * stock;
    totalCostValue += cost; totalRetailValue += retail; totalUnits += stock;
    const c = byCategory.get(it.category) ?? { items: 0, units: 0, costValue: 0, retailValue: 0 };
    c.items += 1; c.units += stock; c.costValue += cost; c.retailValue += retail;
    byCategory.set(it.category, c);
  }
  const valuation = {
    itemCount: items.length,
    units: totalUnits,
    costValue: round2(totalCostValue),
    retailValue: round2(totalRetailValue),
    potentialMargin: round2(totalRetailValue - totalCostValue),
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, items: v.items, units: v.units, costValue: round2(v.costValue), retailValue: round2(v.retailValue) }))
      .sort((a, b) => b.costValue - a.costValue),
  };

  // ---- Low stock ----
  const low = items
    .filter((it) => it.currentStock < it.minimumStockThreshold)
    .map((it) => ({
      itemName: it.itemName, itemCode: it.itemCode ?? '', category: it.category,
      stock: it.currentStock, minStock: it.minimumStockThreshold, deficit: it.minimumStockThreshold - it.currentStock,
      unit: it.unitOfMeasurement ?? '',
    }))
    .sort((a, b) => b.deficit - a.deficit);
  const lowStock = { count: low.length, items: low.slice(0, 30) };

  // ---- Movements summary + trend + top consumed ----
  const moveSummary: Record<string, { qty: number; value: number }> = {
    stock_in: { qty: 0, value: 0 }, stock_out: { qty: 0, value: 0 }, adjustment: { qty: 0, value: 0 },
    return_stock: { qty: 0, value: 0 }, expired_removal: { qty: 0, value: 0 },
  };
  const trend = new Map<string, { stockIn: number; stockOut: number }>();
  const consumed = new Map<string, { itemName: string; category: string; qty: number; value: number }>();
  for (const t of txns) {
    const val = t.totalCost != null ? num(t.totalCost) : num(t.unitCost) * t.quantity;
    const bucket = moveSummary[t.transactionType] ?? (moveSummary[t.transactionType] = { qty: 0, value: 0 });
    bucket.qty += t.quantity; bucket.value += val;

    const day = istDay(t.createdAt);
    const tr = trend.get(day) ?? { stockIn: 0, stockOut: 0 };
    if (t.transactionType === 'stock_in') tr.stockIn += t.quantity;
    if (t.transactionType === 'stock_out') tr.stockOut += t.quantity;
    trend.set(day, tr);

    if (t.transactionType === 'stock_out' && t.inventoryItem) {
      const c = consumed.get(t.inventoryItem.id) ?? { itemName: t.inventoryItem.itemName, category: t.inventoryItem.category, qty: 0, value: 0 };
      c.qty += t.quantity; c.value += val; consumed.set(t.inventoryItem.id, c);
    }
  }
  const trendArr: { date: string; stockIn: number; stockOut: number }[] = [];
  for (let t = new Date(istDay(from)); istDay(t) <= istDay(to); t = new Date(t.getTime() + DAY_MS)) {
    const key = istDay(t);
    const v = trend.get(key) ?? { stockIn: 0, stockOut: 0 };
    trendArr.push({ date: key, stockIn: v.stockIn, stockOut: v.stockOut });
  }
  const movements = {
    stockIn: { qty: moveSummary.stock_in.qty, value: round2(moveSummary.stock_in.value) },
    stockOut: { qty: moveSummary.stock_out.qty, value: round2(moveSummary.stock_out.value) },
    adjustments: { qty: moveSummary.adjustment.qty, value: round2(moveSummary.adjustment.value) },
    returns: { qty: moveSummary.return_stock.qty, value: round2(moveSummary.return_stock.value) },
    expiredRemoval: { qty: moveSummary.expired_removal.qty, value: round2(moveSummary.expired_removal.value) },
    trend: trendArr,
  };
  const topConsumed = [...consumed.values()]
    .map((c) => ({ itemName: c.itemName, category: c.category, qty: c.qty, value: round2(c.value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  // ---- Purchase orders (spend) ----
  const poByStatus = new Map<string, { count: number; value: number }>();
  const poBySupplier = new Map<string, { name: string; count: number; value: number }>();
  let poTotal = 0;
  for (const o of pos) {
    const v = num(o.totalAmount);
    poTotal += v;
    const s = poByStatus.get(o.status) ?? { count: 0, value: 0 };
    s.count += 1; s.value += v; poByStatus.set(o.status, s);
    const sup = poBySupplier.get(o.supplierId) ?? { name: o.supplier?.name ?? 'Unspecified', count: 0, value: 0 };
    sup.count += 1; sup.value += v; poBySupplier.set(o.supplierId, sup);
  }
  const purchases = {
    poCount: pos.length,
    totalSpend: round2(poTotal),
    byStatus: [...poByStatus.entries()].map(([status, v]) => ({ status, count: v.count, value: round2(v.value) })),
    bySupplier: [...poBySupplier.entries()]
      .map(([supplierId, v]) => ({ supplierId, name: v.name, orders: v.count, value: round2(v.value) }))
      .sort((a, b) => b.value - a.value).slice(0, 10),
  };

  // ---- Stock transfers ----
  const tByStatus = new Map<string, { count: number; qty: number }>();
  for (const t of transfers) {
    const s = tByStatus.get(t.status) ?? { count: 0, qty: 0 };
    s.count += 1; s.qty += t.quantityTransferred; tByStatus.set(t.status, s);
  }
  const transfersOut = {
    count: transfers.length,
    byStatus: [...tByStatus.entries()].map(([status, v]) => ({ status, count: v.count, qty: v.qty })),
  };

  // ---- Expiry/waste + department consumption (reuse existing reports) ----
  const expiryWaste = {
    summary: expiry.summary,
    expiringSoon: (expiry.expiringBatches ?? []).slice(0, 20).map((b: any) => ({
      itemName: b.item?.itemName ?? b.item?.name ?? '—',
      batchNumber: b.batchNumber, expiryDate: b.expiryDate,
      remaining: b.remainingQuantity, value: round2(num(b.unitCost) * num(b.remainingQuantity)),
    })),
  };
  const departments = (dept.departments ?? [])
    .map((d: any) => ({ departmentName: d.departmentName, quantity: d.totalQuantity, cost: round2(num(d.totalCost)) }))
    .sort((a: any, b: any) => b.cost - a.cost)
    .slice(0, 15);

  return {
    period: { fromDate: istDay(from), toDate: istDay(to), days },
    valuation,
    lowStock,
    movements,
    topConsumed,
    purchases,
    transfers: transfersOut,
    expiryWaste,
    departments,
  };
}
