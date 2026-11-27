import { prisma } from '../../config/database';

// ============================================================
// Pharmacy sale figures — ONE definition of "a sale", its revenue, its cost
// and its margin, shared by the Reports summary, the Detailed Analysis report
// and (through the same formula) the POS cart.
//
// Gap 346: the summary tiles read `batch.sellingPrice × qty` from every
// dispense since server-local midnight, while the detailed report read the
// billed line total over an IST range — so the same paid ₹100 sale was ₹0 on
// one screen and ₹100 on the other. Both now call `loadPaidSaleLines`.
//
// Gap 348: margin was (revenue − cost) ÷ revenue with a tax-inclusive revenue,
// which on a line whose cost was missing or mis-entered printed −260%. Margin
// is now (retail excl. tax − cost) ÷ cost, and a line with no cost says so
// instead of inventing a number.
// ============================================================

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What one BASE unit of a batch cost the hospital, excluding GST (input tax
 * is credited, not a cost). The purchase discount comes off; free units dilute
 * it. Null when no purchase price was recorded — "cost not set", not ₹0.
 */
export function unitCostOf(batch: {
  purchasePrice?: unknown;
  purchaseDiscountPercent?: unknown;
  quantityReceived?: number | null;
  freeQuantity?: number | null;
} | null | undefined): number | null {
  const rate = num(batch?.purchasePrice);
  if (rate == null || rate <= 0) return null;
  const disc = num(batch?.purchaseDiscountPercent) ?? 0;
  const net = rate * (1 - disc / 100);
  const received = batch?.quantityReceived ?? 0;
  const free = Math.max(0, batch?.freeQuantity ?? 0);
  // Free goods carry no purchase value, so the paid value spreads over all units.
  const perUnit = received > 0 && free > 0 && free < received ? (net * (received - free)) / received : net;
  return perUnit > 0 ? perUnit : null;
}

/** Retail value of a tax-inclusive (MRP) amount with the GST taken out. */
export function exclusiveOfTax(inclusive: number, ratePercent: number): number {
  return ratePercent > 0 ? (inclusive * 100) / (100 + ratePercent) : inclusive;
}

/** 348: (retail excl. tax − cost) ÷ cost, as a percentage. Null = cost not set. */
export function marginPercent(retailExclTax: number, cost: number | null): number | null {
  if (cost == null || cost <= 0) return null;
  return round2(((retailExclTax - cost) / cost) * 100);
}

export interface SaleLineFigures {
  /** What the patient paid for the line, GST included (the bill line). */
  revenue: number;
  /** The same, GST taken out — the bill line's taxable value when it has one. */
  retailExclTax: number;
  tax: number;
  /** The rate the line was billed at (the resolved rate stored on it). */
  taxPercent: number;
  /** Null when the batch has no purchase price. */
  cost: number | null;
  /** retailExclTax − cost; null when cost is not set. */
  profit: number | null;
}

export function saleLineFigures(
  line: {
    quantityDispensed: number;
    lineTotal?: unknown;
    unitPrice?: unknown;
    taxPercent?: unknown;
  },
  batch: {
    purchasePrice?: unknown;
    purchaseDiscountPercent?: unknown;
    quantityReceived?: number | null;
    freeQuantity?: number | null;
    sellingPrice?: unknown;
    mrp?: unknown;
  } | null | undefined,
  billLine?: { taxableValue?: unknown; taxAmount?: unknown; totalAmount?: unknown } | null,
): SaleLineFigures {
  const qty = line.quantityDispensed || 0;
  const revenue =
    num(line.lineTotal) ??
    num(billLine?.totalAmount) ??
    (num(line.unitPrice) ?? num(batch?.sellingPrice) ?? num(batch?.mrp) ?? 0) * qty;
  const taxPercent = num(line.taxPercent) ?? 0;
  const billTaxable = num(billLine?.taxableValue);
  const retailExclTax = billTaxable ?? exclusiveOfTax(revenue, taxPercent);
  const tax = num(billLine?.taxAmount) ?? revenue - retailExclTax;
  const unit = unitCostOf(batch);
  const cost = unit != null ? unit * qty : null;
  return {
    revenue,
    retailExclTax,
    tax,
    taxPercent,
    cost,
    profit: cost != null ? retailExclTax - cost : null,
  };
}

const SALE_LINE_SELECT = {
  id: true,
  quantityDispensed: true,
  unitPrice: true,
  lineTotal: true,
  taxPercent: true,
  dispensedAt: true,
  dispensedBy: true,
  billId: true,
  drugBatchId: true,
  dispenser: { select: { firstName: true, lastName: true } },
  drugBatch: {
    select: {
      purchasePrice: true,
      purchaseDiscountPercent: true,
      quantityReceived: true,
      freeQuantity: true,
      sellingPrice: true,
      mrp: true,
      drug: { select: { id: true, drugName: true, dosageForm: true, category: true } },
    },
  },
} as const;

/**
 * Every dispensed line in [from, to] that sits on a PAID bill, with the bill
 * line it was billed as. One query shape for every pharmacy sales figure.
 *
 * A line finds its bill through `dispensingRecord.billId` (counter sales) or,
 * failing that, through the bill line that references it (dispenses billed onto
 * a visit bill). Cancelled sales, unpaid and part-paid bills are not sales yet.
 */
export async function loadPaidSaleLines(tenantId: string, from: Date, to: Date) {
  const records = await prisma.dispensingRecord.findMany({
    where: { tenantId, cancelledAt: null, dispensedAt: { gte: from, lte: to } },
    select: SALE_LINE_SELECT,
  });
  if (records.length === 0) return [];

  const billLines = await prisma.billItem.findMany({
    where: { referenceType: 'dispensing_record', referenceId: { in: records.map((r) => r.id) } },
    select: { referenceId: true, billId: true, taxableValue: true, taxAmount: true, totalAmount: true },
  });
  const lineByRecord = new Map(billLines.map((b) => [b.referenceId as string, b]));

  const billIds = new Set<string>();
  for (const r of records) {
    const id = r.billId ?? lineByRecord.get(r.id)?.billId;
    if (id) billIds.add(id);
  }
  const paid = billIds.size
    ? await prisma.bill.findMany({
        where: { tenantId, id: { in: [...billIds] }, status: 'paid' },
        select: { id: true },
      })
    : [];
  const paidIds = new Set(paid.map((b) => b.id));

  return records
    .map((r) => {
      const billLine = lineByRecord.get(r.id) ?? null;
      const billId = r.billId ?? billLine?.billId ?? null;
      return { ...r, billId, billLine, figures: saleLineFigures(r, r.drugBatch, billLine) };
    })
    .filter((r) => r.billId != null && paidIds.has(r.billId));
}

export type PaidSaleLine = Awaited<ReturnType<typeof loadPaidSaleLines>>[number];

/** Totals over a set of paid sale lines — revenue, profit and margin on cost. */
export function summariseSaleLines(lines: PaidSaleLine[]) {
  let revenue = 0, retailExclTax = 0, costed = 0, costedRetail = 0, cost = 0;
  let costMissingLines = 0;
  for (const l of lines) {
    revenue += l.figures.revenue;
    retailExclTax += l.figures.retailExclTax;
    if (l.figures.cost == null) { costMissingLines += 1; continue; }
    costed += 1;
    cost += l.figures.cost;
    costedRetail += l.figures.retailExclTax;
  }
  return {
    revenue: round2(revenue),
    retailExclTax: round2(retailExclTax),
    /** Only over lines whose cost is known. */
    cost: round2(cost),
    profit: round2(costedRetail - cost),
    marginPct: marginPercent(costedRetail, costed ? cost : null),
    costMissingLines,
    lines: lines.length,
  };
}
