import { prisma } from '../../config/database';

// ============================================================
// Pharmacy — Detailed Analysis report (single-call deep rollup).
//
// One endpoint that powers the "Detailed Analysis" page: sales & margin,
// daily trend, ABC classification, dosage-form mix, top drugs, staff
// performance, returns, stock valuation, expiry exposure, dead/slow stock,
// low-stock reorder, GST-by-rate and supplier purchase analysis — all derived
// from the dispensing ledger + live batches over a date range.
// ============================================================

interface Range {
  fromDate?: string;
  toDate?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in IST — for day-bucketing. */
function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

function resolveRange(range: Range) {
  const to = range.toDate ? new Date(`${range.toDate}T23:59:59.999+05:30`) : new Date();
  const from = range.fromDate
    ? new Date(`${range.fromDate}T00:00:00.000+05:30`)
    : new Date(to.getTime() - 29 * DAY_MS);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  return { from, to, days };
}

export async function getPharmacyDetailedReport(tenantId: string, range: Range) {
  const { from, to, days } = resolveRange(range);
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  const in60 = new Date(now.getTime() + 60 * DAY_MS);
  const in90 = new Date(now.getTime() + 90 * DAY_MS);

  const [dispenses, returns, liveBatches, purchasedBatches, users] = await Promise.all([
    prisma.dispensingRecord.findMany({
      // A voided sale is not a sale.
      where: { tenantId, cancelledAt: null, dispensedAt: { gte: from, lte: to } },
      select: {
        quantityDispensed: true, unitPrice: true, lineTotal: true, dispensedAt: true,
        dispensedBy: true, billId: true,
        drugBatch: {
          select: {
            purchasePrice: true, sellingPrice: true, mrp: true,
            drug: { select: { id: true, drugName: true, dosageForm: true, taxPercent: true } },
          },
        },
      },
    }),
    prisma.drugReturn.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
      select: { returnType: true, quantity: true, refundAmount: true, creditAmount: true, status: true },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, isRecalled: false, quantityInStock: { gt: 0 } },
      select: {
        quantityInStock: true, purchasePrice: true, sellingPrice: true, mrp: true,
        expiryDate: true, isExpired: true, batchNumber: true,
        drug: { select: { id: true, drugName: true, dosageForm: true, minStock: true } },
      },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
      select: {
        quantityReceived: true, purchasePrice: true, supplierId: true,
        supplier: { select: { name: true } },
      },
    }),
    prisma.user.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
  ]);

  const userName = new Map(users.map((u) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown']));

  // ---- Per-line revenue / cost from the dispensing ledger ----
  const lineRev = (r: (typeof dispenses)[number]) => {
    const qty = r.quantityDispensed;
    if (r.lineTotal != null) return num(r.lineTotal);
    const unit = r.unitPrice != null ? num(r.unitPrice) : num(r.drugBatch?.sellingPrice ?? r.drugBatch?.mrp);
    return unit * qty;
  };
  const lineCost = (r: (typeof dispenses)[number]) => num(r.drugBatch?.purchasePrice) * r.quantityDispensed;

  let revenue = 0, cost = 0, itemsSold = 0;
  const bills = new Set<string>();
  const trend = new Map<string, { revenue: number; profit: number; lines: number; qty: number }>();
  const byForm = new Map<string, { qty: number; revenue: number }>();
  const byDrug = new Map<string, { drugId: string; drugName: string; qty: number; revenue: number; cost: number }>();
  const byDispenser = new Map<string, { lines: number; qty: number; revenue: number }>();
  const byRate = new Map<number, { taxable: number; tax: number; lines: number }>();
  const soldDrugIds = new Set<string>();

  for (const r of dispenses) {
    const rev = lineRev(r);
    const c = lineCost(r);
    revenue += rev; cost += c; itemsSold += r.quantityDispensed;
    if (r.billId) bills.add(r.billId);

    const day = istDay(r.dispensedAt);
    const t = trend.get(day) ?? { revenue: 0, profit: 0, lines: 0, qty: 0 };
    t.revenue += rev; t.profit += rev - c; t.lines += 1; t.qty += r.quantityDispensed;
    trend.set(day, t);

    const form = r.drugBatch?.drug?.dosageForm ?? 'other';
    const f = byForm.get(form) ?? { qty: 0, revenue: 0 };
    f.qty += r.quantityDispensed; f.revenue += rev; byForm.set(form, f);

    const drug = r.drugBatch?.drug;
    if (drug) {
      soldDrugIds.add(drug.id);
      const d = byDrug.get(drug.id) ?? { drugId: drug.id, drugName: drug.drugName, qty: 0, revenue: 0, cost: 0 };
      d.qty += r.quantityDispensed; d.revenue += rev; d.cost += c; byDrug.set(drug.id, d);
    }

    const disp = byDispenser.get(r.dispensedBy) ?? { lines: 0, qty: 0, revenue: 0 };
    disp.lines += 1; disp.qty += r.quantityDispensed; disp.revenue += rev; byDispenser.set(r.dispensedBy, disp);

    // GST (MRP is tax-inclusive in Indian pharmacy): tax = rev * rate / (100 + rate).
    const rate = num(drug?.taxPercent);
    const g = byRate.get(rate) ?? { taxable: 0, tax: 0, lines: 0 };
    const tax = rate > 0 ? (rev * rate) / (100 + rate) : 0;
    g.taxable += rev - tax; g.tax += tax; g.lines += 1; byRate.set(rate, g);
  }

  const grossProfit = revenue - cost;

  const sales = {
    revenue: round2(revenue),
    cost: round2(cost),
    grossProfit: round2(grossProfit),
    marginPct: pct(grossProfit, revenue),
    lines: dispenses.length,
    itemsSold,
    bills: bills.size,
    avgBillValue: bills.size ? round2(revenue / bills.size) : 0,
    avgLineValue: dispenses.length ? round2(revenue / dispenses.length) : 0,
    perDayRevenue: round2(revenue / days),
  };

  // ---- Daily trend (dense over the range) ----
  const trendArr: { date: string; revenue: number; profit: number; lines: number; qty: number }[] = [];
  for (let t = new Date(istDay(from)); istDay(t) <= istDay(to); t = new Date(t.getTime() + DAY_MS)) {
    const key = istDay(t);
    const v = trend.get(key) ?? { revenue: 0, profit: 0, lines: 0, qty: 0 };
    trendArr.push({ date: key, revenue: round2(v.revenue), profit: round2(v.profit), lines: v.lines, qty: v.qty });
  }

  const byDosageForm = [...byForm.entries()]
    .map(([form, v]) => ({ form, qty: v.qty, revenue: round2(v.revenue), sharePct: pct(v.revenue, revenue) }))
    .sort((a, b) => b.revenue - a.revenue);

  const drugRows = [...byDrug.values()].map((d) => ({
    drugId: d.drugId, drugName: d.drugName, qty: d.qty,
    revenue: round2(d.revenue), profit: round2(d.revenue - d.cost), marginPct: pct(d.revenue - d.cost, d.revenue),
  }));
  const topByRevenue = [...drugRows].sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  const topByQuantity = [...drugRows].sort((a, b) => b.qty - a.qty).slice(0, 15);

  // ---- ABC analysis (Pareto by revenue contribution) ----
  const sortedByRev = [...drugRows].sort((a, b) => b.revenue - a.revenue);
  let cum = 0;
  const abcClasses = { A: { count: 0, revenue: 0 }, B: { count: 0, revenue: 0 }, C: { count: 0, revenue: 0 } };
  for (const d of sortedByRev) {
    cum += d.revenue;
    const cumShare = pct(cum, revenue);
    const cls = cumShare <= 80 ? 'A' : cumShare <= 95 ? 'B' : 'C';
    abcClasses[cls].count += 1;
    abcClasses[cls].revenue += d.revenue;
  }
  const abc = {
    A: { count: abcClasses.A.count, revenue: round2(abcClasses.A.revenue), sharePct: pct(abcClasses.A.revenue, revenue) },
    B: { count: abcClasses.B.count, revenue: round2(abcClasses.B.revenue), sharePct: pct(abcClasses.B.revenue, revenue) },
    C: { count: abcClasses.C.count, revenue: round2(abcClasses.C.revenue), sharePct: pct(abcClasses.C.revenue, revenue) },
  };

  const dispensers = [...byDispenser.entries()]
    .map(([id, v]) => ({ userId: id, name: userName.get(id) ?? 'Unknown', lines: v.lines, qty: v.qty, revenue: round2(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  // ---- Returns ----
  const retByType = new Map<string, { count: number; quantity: number; value: number }>();
  let retCount = 0, retQty = 0, retValue = 0;
  for (const r of returns) {
    retCount += 1; retQty += r.quantity;
    const v = num(r.refundAmount) + num(r.creditAmount);
    retValue += v;
    const t = retByType.get(r.returnType) ?? { count: 0, quantity: 0, value: 0 };
    t.count += 1; t.quantity += r.quantity; t.value += v; retByType.set(r.returnType, t);
  }
  const returnsOut = {
    count: retCount, quantity: retQty, refundValue: round2(retValue),
    returnRatePct: pct(retQty, itemsSold),
    byType: [...retByType.entries()].map(([type, v]) => ({ type, count: v.count, quantity: v.quantity, value: round2(v.value) })),
  };

  // ---- Stock valuation, expiry, dead/slow + low stock (from live batches) ----
  let costValue = 0, retailValue = 0;
  let expiredBatches = 0, expiredValue = 0;
  const near = { d30: { count: 0, value: 0 }, d60: { count: 0, value: 0 }, d90: { count: 0, value: 0 } };
  const valByForm = new Map<string, { costValue: number; retailValue: number; units: number }>();
  const stockByDrug = new Map<string, { drugName: string; minStock: number | null; stock: number; cost: number }>();
  const upcoming: { drugName: string; batchNumber: string; expiryDate: Date; qty: number; value: number }[] = [];

  for (const b of liveBatches) {
    const qty = b.quantityInStock;
    const unitCost = num(b.purchasePrice);
    const unitRetail = num(b.sellingPrice ?? b.mrp);
    const bCost = unitCost * qty;
    const bRetail = unitRetail * qty;
    const expired = b.isExpired || (b.expiryDate && b.expiryDate < now);

    if (expired) { expiredBatches += 1; expiredValue += bCost; }
    else {
      costValue += bCost; retailValue += bRetail;
      const form = b.drug?.dosageForm ?? 'other';
      const vf = valByForm.get(form) ?? { costValue: 0, retailValue: 0, units: 0 };
      vf.costValue += bCost; vf.retailValue += bRetail; vf.units += qty; valByForm.set(form, vf);

      if (b.expiryDate) {
        if (b.expiryDate <= in30) { near.d30.count += 1; near.d30.value += bCost; upcoming.push({ drugName: b.drug?.drugName ?? '—', batchNumber: b.batchNumber, expiryDate: b.expiryDate, qty, value: round2(bCost) }); }
        else if (b.expiryDate <= in60) { near.d60.count += 1; near.d60.value += bCost; }
        else if (b.expiryDate <= in90) { near.d90.count += 1; near.d90.value += bCost; }
      }
    }

    const drug = b.drug;
    if (drug && !expired) {
      const s = stockByDrug.get(drug.id) ?? { drugName: drug.drugName, minStock: drug.minStock, stock: 0, cost: 0 };
      s.stock += qty; s.cost += bCost; stockByDrug.set(drug.id, s);
    }
  }

  const valuation = {
    batchCount: liveBatches.length,
    drugCount: stockByDrug.size,
    costValue: round2(costValue),
    retailValue: round2(retailValue),
    potentialMargin: round2(retailValue - costValue),
    marginPct: pct(retailValue - costValue, retailValue),
    byForm: [...valByForm.entries()]
      .map(([form, v]) => ({ form, costValue: round2(v.costValue), retailValue: round2(v.retailValue), units: v.units }))
      .sort((a, b) => b.costValue - a.costValue),
  };

  const expiry = {
    expiredBatches, expiredValue: round2(expiredValue),
    near30: { count: near.d30.count, value: round2(near.d30.value) },
    near60: { count: near.d60.count, value: round2(near.d60.value) },
    near90: { count: near.d90.count, value: round2(near.d90.value) },
    valueAtRisk: round2(near.d30.value + near.d60.value + near.d90.value),
    upcoming: upcoming.sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime()).slice(0, 20),
  };

  // Dead stock = in stock but not sold in the range. Slow = sold a little.
  const dead = [...stockByDrug.entries()]
    .filter(([id]) => !soldDrugIds.has(id))
    .map(([, s]) => ({ drugName: s.drugName, stock: s.stock, value: round2(s.cost) }))
    .sort((a, b) => b.value - a.value);
  const deadStock = { count: dead.length, value: round2(dead.reduce((t, x) => t + x.value, 0)), items: dead.slice(0, 25) };

  // Low stock (below the drug's reorder level).
  const low = [...stockByDrug.values()]
    .filter((s) => s.minStock != null && s.stock < s.minStock)
    .map((s) => ({ drugName: s.drugName, stock: s.stock, minStock: s.minStock!, deficit: s.minStock! - s.stock }))
    .sort((a, b) => b.deficit - a.deficit);
  const lowStock = { count: low.length, items: low.slice(0, 25) };

  // GST by rate.
  let totalTax = 0, totalTaxable = 0;
  const gstByRate = [...byRate.entries()]
    .map(([rate, v]) => { totalTax += v.tax; totalTaxable += v.taxable; return { rate, taxable: round2(v.taxable), tax: round2(v.tax), lines: v.lines }; })
    .sort((a, b) => a.rate - b.rate);
  const gst = { totalTax: round2(totalTax), taxableValue: round2(totalTaxable), byRate: gstByRate };

  // Supplier purchase analysis (stock received in the range).
  const bySupplier = new Map<string, { name: string; purchaseValue: number; batches: number; units: number }>();
  for (const b of purchasedBatches) {
    const key = b.supplierId ?? 'unknown';
    const s = bySupplier.get(key) ?? { name: b.supplier?.name ?? 'Unspecified', purchaseValue: 0, batches: 0, units: 0 };
    s.purchaseValue += num(b.purchasePrice) * b.quantityReceived; s.batches += 1; s.units += b.quantityReceived;
    bySupplier.set(key, s);
  }
  const suppliers = [...bySupplier.entries()]
    .map(([supplierId, s]) => ({ supplierId, name: s.name, purchaseValue: round2(s.purchaseValue), batches: s.batches, units: s.units }))
    .sort((a, b) => b.purchaseValue - a.purchaseValue)
    .slice(0, 15);
  const purchaseTotal = round2([...bySupplier.values()].reduce((t, s) => t + s.purchaseValue, 0));

  return {
    period: { fromDate: istDay(from), toDate: istDay(to), days },
    sales,
    trend: trendArr,
    byDosageForm,
    topByRevenue,
    topByQuantity,
    abc,
    dispensers,
    returns: returnsOut,
    valuation,
    expiry,
    deadStock,
    lowStock,
    gst,
    purchases: { total: purchaseTotal, suppliers },
  };
}
