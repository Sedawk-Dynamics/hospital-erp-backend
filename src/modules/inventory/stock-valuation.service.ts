import { prisma } from '../../config/database';

// ============================================================
// Stock valuation — ONE basis for every screen (gap 301).
//
// The Inventory dashboard valued stock at selling price (expired batches
// included), the stock list at selling price × all batches, Inventory Detailed
// Analysis only looked at generic items (so a pharmacy-heavy store read ₹0 /
// 0 items) and Pharmacy Detailed Analysis at purchase cost. Four screens, four
// numbers. Every screen now calls this service.
//
// Basis: PURCHASE COST.
//   • Medicines — batch purchasePrice × quantityInStock, live batches only
//     (not expired, not recalled, stock > 0). A batch without a purchase price
//     counts as ₹0 and is reported in `unpricedBatches`.
//   • Other supplies — InventoryItem.costPerUnit × currentStock. Items mapped
//     to an active formulary drug are the same product, so they are valued once,
//     as the drug.
// Retail value (selling price, falling back to MRP / item cost) is returned
// alongside for margin views; it is never the headline figure.
// ============================================================

export const STOCK_VALUATION_BASIS = 'purchase_cost' as const;
export const STOCK_VALUATION_BASIS_LABEL =
  'Purchase cost — medicines at batch purchase price (unexpired, non-recalled batches); other supplies at item cost per unit';

const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ValuationLine {
  kind: 'item' | 'drug';
  refId: string;
  name: string;
  code: string | null;
  category: string;
  units: number;
  costValue: number;
  retailValue: number;
}

export interface StockValuation {
  basis: typeof STOCK_VALUATION_BASIS;
  basisLabel: string;
  asOf: string;
  itemCount: number;
  units: number;
  costValue: number;
  retailValue: number;
  items: { count: number; units: number; costValue: number; retailValue: number };
  drugs: { count: number; batchCount: number; units: number; costValue: number; retailValue: number; unpricedBatches: number };
  byCategory: Array<{ category: string; items: number; units: number; costValue: number; retailValue: number }>;
  lines: ValuationLine[];
}

/** Is a batch live stock (counts toward value) at `now`? */
export function isLiveBatch(
  b: { quantityInStock: number; isExpired: boolean; isRecalled?: boolean; expiryDate: Date | null },
  now: Date,
): boolean {
  if (b.quantityInStock <= 0 || b.isExpired || b.isRecalled) return false;
  if (b.expiryDate) {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    if (new Date(b.expiryDate) < startOfToday) return false;
  }
  return true;
}

export async function getStockValuation(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<StockValuation> {
  const now = opts.now ?? new Date();

  const [items, batches] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: {
        tenantId,
        isActive: true,
        // Mapped to an active drug → valued once, as the drug.
        formularyDrugs: { none: { tenantId, isActive: true } },
      },
      select: {
        id: true, itemName: true, itemCode: true, category: true, currentStock: true,
        costPerUnit: true, sellingPricePerUnit: true,
      },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, isRecalled: false, isExpired: false, quantityInStock: { gt: 0 }, drug: { isActive: true } },
      select: {
        drugId: true, quantityInStock: true, purchasePrice: true, sellingPrice: true, mrp: true,
        expiryDate: true, isExpired: true, isRecalled: true,
        drug: { select: { drugName: true, hsnCode: true, category: true } },
      },
    }),
  ]);

  const lines = new Map<string, ValuationLine>();

  let itemUnits = 0, itemCost = 0, itemRetail = 0, itemCount = 0;
  for (const it of items) {
    const units = Math.max(0, it.currentStock);
    const cost = num(it.costPerUnit) * units;
    const retail = num(it.sellingPricePerUnit ?? it.costPerUnit) * units;
    itemCount += 1; itemUnits += units; itemCost += cost; itemRetail += retail;
    lines.set(`item:${it.id}`, {
      kind: 'item', refId: it.id, name: it.itemName, code: it.itemCode ?? null,
      category: String(it.category), units, costValue: cost, retailValue: retail,
    });
  }

  let drugUnits = 0, drugCost = 0, drugRetail = 0, batchCount = 0, unpricedBatches = 0;
  for (const b of batches) {
    if (!isLiveBatch(b, now)) continue;
    const units = b.quantityInStock;
    if (b.purchasePrice == null) unpricedBatches += 1;
    const cost = num(b.purchasePrice) * units;
    const retail = num(b.sellingPrice ?? b.mrp ?? b.purchasePrice) * units;
    batchCount += 1; drugUnits += units; drugCost += cost; drugRetail += retail;
    const key = `drug:${b.drugId}`;
    const line = lines.get(key) ?? {
      kind: 'drug' as const, refId: b.drugId, name: b.drug?.drugName ?? '—', code: b.drug?.hsnCode ?? null,
      category: String(b.drug?.category ?? 'drug'), units: 0, costValue: 0, retailValue: 0,
    };
    line.units += units; line.costValue += cost; line.retailValue += retail;
    lines.set(key, line);
  }
  const drugCount = [...lines.values()].filter((l) => l.kind === 'drug').length;

  const byCategory = new Map<string, { items: number; units: number; costValue: number; retailValue: number }>();
  for (const l of lines.values()) {
    const c = byCategory.get(l.category) ?? { items: 0, units: 0, costValue: 0, retailValue: 0 };
    c.items += 1; c.units += l.units; c.costValue += l.costValue; c.retailValue += l.retailValue;
    byCategory.set(l.category, c);
  }

  return {
    basis: STOCK_VALUATION_BASIS,
    basisLabel: STOCK_VALUATION_BASIS_LABEL,
    asOf: now.toISOString(),
    itemCount: itemCount + drugCount,
    units: itemUnits + drugUnits,
    costValue: round2(itemCost + drugCost),
    retailValue: round2(itemRetail + drugRetail),
    items: { count: itemCount, units: itemUnits, costValue: round2(itemCost), retailValue: round2(itemRetail) },
    drugs: {
      count: drugCount, batchCount, units: drugUnits,
      costValue: round2(drugCost), retailValue: round2(drugRetail), unpricedBatches,
    },
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({
        category, items: v.items, units: v.units, costValue: round2(v.costValue), retailValue: round2(v.retailValue),
      }))
      .sort((a, b) => b.costValue - a.costValue),
    lines: [...lines.values()].map((l) => ({ ...l, costValue: round2(l.costValue), retailValue: round2(l.retailValue) })),
  };
}
