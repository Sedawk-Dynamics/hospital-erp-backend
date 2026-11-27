import { prisma } from '../../config/database';
import { getExpiryWasteReport, getDepartmentConsumptionReport } from './inventory.reports.service';
import { getStockValuation } from './stock-valuation.service';
import { drugMovementsAsStockTransactions, inventoryTypeForMovement } from '../pharmacy/pharmacy.stock-movement';
import { formatDrugQty, UNIT_SELECT } from '../pharmacy/pharmacy.units';

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

/**
 * The value one movement contributes to consumption. Shared by the aggregate
 * (top consumed) and its drill-down (gap 349) so the two always reconcile.
 */
export function movementValue(t: { totalCost?: unknown; unitCost?: unknown; quantity: number }): number {
  return t.totalCost != null ? num(t.totalCost) : num(t.unitCost) * t.quantity;
}

function resolveRange(range: Range) {
  const to = range.toDate ? new Date(`${range.toDate}T23:59:59.999+05:30`) : new Date();
  const from = range.fromDate ? new Date(`${range.fromDate}T00:00:00.000+05:30`) : new Date(to.getTime() - 29 * DAY_MS);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  return { from, to, days };
}

export async function getInventoryDetailedReport(tenantId: string, range: Range) {
  const { from, to, days } = resolveRange(range);

  const [items, txns, pos, transfers, expiry, dept, stock] = await Promise.all([
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
    getStockValuation(tenantId),
  ]);

  // ---- Valuation (live, by category) ----
  // Gap 301: this used to value generic inventory items only, so a store whose
  // stock is all pharmacy batches showed ₹0 / 0 items. It now uses the shared
  // valuation service (items + live drug batches, purchase-cost basis).
  const valuation = {
    basis: stock.basis,
    basisLabel: stock.basisLabel,
    asOf: stock.asOf,
    itemCount: stock.itemCount,
    units: stock.units,
    costValue: stock.costValue,
    retailValue: stock.retailValue,
    potentialMargin: round2(stock.retailValue - stock.costValue),
    byCategory: stock.byCategory,
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
  const consumed = new Map<
    string,
    { kind: 'item' | 'drug'; refId: string; itemName: string; category: string; qty: number; value: number; transactions: number }
  >();
  // 349: pharmacy sales, issues and transfers move drug batches, not
  // InventoryItems, so they were missing from movements and top-consumed.
  const drugTxns = await drugMovementsAsStockTransactions(tenantId, from, to);
  const tagged = [
    ...txns.map((t) => ({ ...t, kind: 'item' as const })),
    ...drugTxns.map((t) => ({ ...t, kind: 'drug' as const })),
  ];
  for (const t of tagged) {
    const val = movementValue(t);
    const bucket = moveSummary[t.transactionType] ?? (moveSummary[t.transactionType] = { qty: 0, value: 0 });
    bucket.qty += t.quantity; bucket.value += val;

    const day = istDay(t.createdAt);
    const tr = trend.get(day) ?? { stockIn: 0, stockOut: 0 };
    if (t.transactionType === 'stock_in') tr.stockIn += t.quantity;
    if (t.transactionType === 'stock_out') tr.stockOut += t.quantity;
    trend.set(day, tr);

    if (t.transactionType === 'stock_out' && t.inventoryItem) {
      // Gap 349: keyed by kind too — a drug and an item are different records.
      const key = `${t.kind}:${t.inventoryItem.id}`;
      const c = consumed.get(key) ?? {
        kind: t.kind, refId: t.inventoryItem.id,
        itemName: t.inventoryItem.itemName, category: String(t.inventoryItem.category), qty: 0, value: 0, transactions: 0,
      };
      c.qty += t.quantity; c.value += val; c.transactions += 1; consumed.set(key, c);
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
    // kind + refId open the supporting transactions (getConsumptionTransactions).
    .map((c) => ({
      kind: c.kind, refId: c.refId, itemName: c.itemName, category: c.category,
      qty: c.qty, value: round2(c.value), transactions: c.transactions,
    }))
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

// ============================================================
// Gap 349: the transactions behind one "Top consumed items" row.
//
// QA: the consumption rollup was aggregate-only — no batch, date or document
// number to trace a figure back to (a PH-… bill, a transfer number). This
// returns, for one item or drug and the SAME date range, every movement the
// aggregate counted, with batch, date, source document, quantity and value.
// The selection (stock-out only, same window) and the value formula
// (`movementValue`) are the aggregate's own, so the rows sum to the row total.
// ============================================================

export interface ConsumptionTransaction {
  id: string;
  date: Date;
  batchNumber: string | null;
  movementType: string;
  documentType: string | null;
  documentNumber: string | null;
  party: string | null;
  quantity: number;
  /** 345: the quantity in words, for a medicine. */
  quantityText?: string | null;
  unitCost: number | null;
  value: number;
}

export async function getConsumptionTransactions(
  tenantId: string,
  query: Range & { kind: 'item' | 'drug'; refId: string },
) {
  const { from, to } = resolveRange(query);
  let name = '—';
  let rows: ConsumptionTransaction[] = [];
  // Unrounded per-row values, summed the way the rollup sums them.
  let rawTotal = 0;

  if (query.kind === 'drug') {
    const [drug, moves] = await Promise.all([
      prisma.drugFormulary.findFirst({ where: { id: query.refId, tenantId }, select: { drugName: true, ...UNIT_SELECT } }),
      // Exactly the drug movements the rollup reads as stock_out
      // (inventoryTypeForMovement): outbound, and not a receipt/adjustment.
      prisma.drugStockMovement.findMany({
        where: {
          tenantId, drugId: query.refId, createdAt: { gte: from, lte: to },
          quantity: { lt: 0 }, movementType: { notIn: ['receipt', 'adjustment'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    name = drug?.drugName ?? name;
    const list = ((moves ?? []) as any[]).filter(
      (m) => inventoryTypeForMovement(m.movementType, m.quantity) === 'stock_out',
    );
    const ids = (type: string) => [
      ...new Set(list.filter((m) => m.referenceType === type && m.referenceId).map((m) => m.referenceId as string)),
    ];
    const saleIds = ids('pharmacy_sale');
    const transferIds = ids('stock_transfer');
    const returnIds = ids('drug_return');
    const [batches, bills, transfers, returns] = await Promise.all([
      prisma.drugBatch.findMany({
        where: { tenantId, id: { in: [...new Set(list.map((m) => m.drugBatchId as string))] } },
        select: { id: true, batchNumber: true },
      }),
      saleIds.length
        ? prisma.bill.findMany({ where: { tenantId, id: { in: saleIds } }, select: { id: true, billNumber: true } })
        : Promise.resolve([]),
      transferIds.length
        ? prisma.stockTransfer.findMany({ where: { tenantId, id: { in: transferIds } }, select: { id: true, transferNumber: true } })
        : Promise.resolve([]),
      returnIds.length
        ? prisma.drugReturn.findMany({ where: { tenantId, id: { in: returnIds } }, select: { id: true, returnNumber: true } })
        : Promise.resolve([]),
    ]);
    const batchNo = new Map(((batches ?? []) as any[]).map((b) => [b.id as string, b.batchNumber as string]));
    const docNo = new Map<string, string | null>([
      ...((bills ?? []) as any[]).map((b): [string, string | null] => [b.id, b.billNumber ?? null]),
      ...((transfers ?? []) as any[]).map((t): [string, string | null] => [t.id, t.transferNumber ?? null]),
      ...((returns ?? []) as any[]).map((r): [string, string | null] => [r.id, r.returnNumber ?? null]),
    ]);
    rows = list.map((m) => {
      const qty = Math.abs(m.quantity);
      const unit = m.unitCost != null ? Number(m.unitCost) : null;
      // The same totalCost the rollup derives in drugMovementsAsStockTransactions.
      const totalCost = unit != null ? round2(unit * qty) : null;
      return {
        id: m.id,
        date: m.createdAt,
        batchNumber: batchNo.get(m.drugBatchId) ?? null,
        movementType: m.movementType,
        documentType: m.referenceType ?? null,
        documentNumber: (m.referenceId ? docNo.get(m.referenceId) : null) ?? m.notes ?? null,
        party: m.party ?? null,
        quantity: qty,
        quantityText: formatDrugQty(qty, drug),
        unitCost: unit,
        value: round2(movementValue({ totalCost, unitCost: unit, quantity: qty })),
      };
    });
    rawTotal = rows.reduce((sum, r) => sum + r.value, 0);
  } else {
    const [item, txns] = await Promise.all([
      prisma.inventoryItem.findFirst({ where: { id: query.refId, tenantId }, select: { itemName: true } }),
      prisma.stockTransaction.findMany({
        where: {
          tenantId, inventoryItemId: query.refId, transactionType: 'stock_out', createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, quantity: true, unitCost: true, totalCost: true, createdAt: true, batchNumber: true,
          referenceType: true, referenceId: true, notes: true,
          department: { select: { name: true } },
        },
      }),
    ]);
    name = item?.itemName ?? name;
    const list = (txns ?? []) as any[];
    const transferIds = [
      ...new Set(list.filter((t) => t.referenceType === 'stock_transfer' && t.referenceId).map((t) => t.referenceId as string)),
    ];
    const transfers = transferIds.length
      ? await prisma.stockTransfer.findMany({
          where: { tenantId, id: { in: transferIds } },
          select: { id: true, transferNumber: true },
        })
      : [];
    const transferNo = new Map(((transfers ?? []) as any[]).map((t) => [t.id as string, t.transferNumber as string]));
    rows = list.map((t) => ({
      id: t.id,
      date: t.createdAt,
      batchNumber: t.batchNumber ?? null,
      movementType: 'stock_out',
      documentType: t.referenceType ?? null,
      documentNumber: (t.referenceId ? transferNo.get(t.referenceId) : null) ?? t.notes ?? null,
      party: t.department?.name ?? null,
      quantity: t.quantity,
      unitCost: t.unitCost != null ? Number(t.unitCost) : null,
      value: round2(movementValue(t)),
    }));
    rawTotal = list.reduce((sum, t) => sum + movementValue(t), 0);
  }

  return {
    period: { fromDate: istDay(from), toDate: istDay(to) },
    kind: query.kind,
    refId: query.refId,
    itemName: name,
    totals: {
      transactions: rows.length,
      qty: rows.reduce((s, r) => s + r.quantity, 0),
      value: round2(rawTotal),
    },
    rows,
  };
}
