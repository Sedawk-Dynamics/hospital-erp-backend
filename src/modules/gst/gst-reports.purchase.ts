// ---------------------------------------------------------------------------
// The purchase-side GST reports (Group B) — what the hospital can claim back.
//
// The purchase record in this system is the DRUG BATCH. A batch carries the
// supplier, their invoice number and date, the quantity, the purchase rate, the
// line discount and the GST rate — which is everything a purchase register
// needs. The tax AMOUNT is not stored, and is not invented here either: it is
// computed by `batchPurchaseEconomics`, the same helper the inward screen and
// the margin reports already use, so the register agrees with what the
// storekeeper saw when they received the goods.
//
// What this does NOT cover, and must not pretend to: purchases that never
// become a batch — equipment, utilities, rent, professional services, lab
// reagents bought outside the pharmacy. A hospital's real ITC is larger than
// this. Every report here says so in `coverage`, because an accountant who
// takes B-2 as the complete input credit will under-claim.
//
// B-3 is the one that matters. Section 17(2) says a business making both
// taxable and exempt supplies may keep only the share of its input credit that
// belongs to the taxable half — and for a hospital almost everything is exempt,
// so almost all of the credit goes back. Getting the exempt ratio wrong is the
// most expensive mistake available on this side of the return, which is why the
// ratio comes from A-7 rather than being estimated here.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { batchPurchaseEconomics } from '../pharmacy/pharmacy.service';
import { getExemptTurnover, type SalesReportQuery } from './gst-reports.sales';

/** Under Rule 42, credit is also reversed for non-business use at this rate. */
const NON_BUSINESS_PERCENT = 5;

export interface PurchaseLine {
  batchId: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierGstin: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  receivedAt: Date;
  drugName: string;
  hsnCode: string | null;
  batchNumber: string;
  quantity: number;
  freeQuantity: number;
  purchaseRate: number | null;
  discountPercent: number;
  taxableValue: number;
  gstRatePercent: number | null;
  taxAmount: number;
  landingTotal: number;
}

function dateRange(query: SalesReportQuery) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

/**
 * B-1 — GST Purchase Register. One row per batch received.
 *
 * Dated by the SUPPLIER'S invoice date where there is one, because that is the
 * date the credit belongs to; a batch keyed on when it was entered would move
 * credit into the month somebody got round to the paperwork.
 */
export async function getPurchaseRegister(
  tenantId: string,
  query: SalesReportQuery & { supplierId?: string } = {},
): Promise<{ period: { from: string | null; to: string | null }; rows: PurchaseLine[] }> {
  const { from, to } = dateRange(query);
  const window = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  const batches = await prisma.drugBatch.findMany({
    where: {
      tenantId,
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(window
        ? {
            OR: [
              { invoiceDate: window },
              // No supplier invoice date recorded — fall back to when it was
              // received, so the row is not lost from every period at once.
              { invoiceDate: null, createdAt: window },
            ],
          }
        : {}),
    },
    orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, batchNumber: true, invoiceNumber: true, invoiceDate: true, createdAt: true,
      quantityReceived: true, freeQuantity: true, purchasePrice: true,
      purchaseDiscountPercent: true, gstPercent: true,
      drug: { select: { drugName: true, hsnCode: true } },
      supplier: { select: { id: true, name: true, gstNumber: true } },
    },
  });

  const rows = batches.map((b) => {
    const money = batchPurchaseEconomics(b);
    // What the hospital actually paid the supplier: the taxable value plus the
    // tax on it. `batchPurchaseEconomics` reports the per-unit landing cost,
    // which is that figure spread over the free units too — not the invoice.
    const landingTotal = r2((money.netPurchaseValue ?? 0) + (money.taxAmount ?? 0));
    return {
      batchId: b.id,
      supplierId: b.supplier?.id ?? null,
      supplierName: b.supplier?.name ?? null,
      supplierGstin: b.supplier?.gstNumber ?? null,
      invoiceNumber: b.invoiceNumber,
      invoiceDate: b.invoiceDate,
      receivedAt: b.createdAt,
      drugName: b.drug?.drugName ?? '',
      hsnCode: b.drug?.hsnCode ?? null,
      batchNumber: b.batchNumber,
      quantity: b.quantityReceived,
      freeQuantity: b.freeQuantity ?? 0,
      purchaseRate: money.netRate,
      discountPercent: Number(b.purchaseDiscountPercent ?? 0),
      taxableValue: money.netPurchaseValue ?? 0,
      gstRatePercent: b.gstPercent == null ? null : Number(b.gstPercent),
      taxAmount: money.taxAmount ?? 0,
      landingTotal,
    };
  });

  return { period: { from: query.from ?? null, to: query.to ?? null }, rows };
}

/** What a purchase register can and cannot see. Printed on every B report. */
const COVERAGE_NOTE =
  'Pharmacy and inventory purchases only — anything that does not arrive as a stock batch ' +
  '(equipment, rent, utilities, professional services) is not recorded in this system and is not included here.';

/**
 * B-2 — Input Tax Credit Summary. Rate-wise and supplier-wise.
 *
 * This is the credit BEFORE any reversal. What the hospital actually keeps is
 * B-3, and the two must never be confused: for a hospital the gap between them
 * is most of the number.
 */
export async function getItcSummary(
  tenantId: string,
  query: SalesReportQuery & { supplierId?: string } = {},
) {
  const { period, rows } = await getPurchaseRegister(tenantId, query);

  const fold = <K extends string>(key: (l: PurchaseLine) => K) => {
    const m = new Map<K, { count: number; taxableValue: number; taxAmount: number; landingTotal: number }>();
    for (const l of rows) {
      const k = key(l);
      const cur = m.get(k) ?? { count: 0, taxableValue: 0, taxAmount: 0, landingTotal: 0 };
      cur.count += 1;
      cur.taxableValue = r2(cur.taxableValue + l.taxableValue);
      cur.taxAmount = r2(cur.taxAmount + l.taxAmount);
      cur.landingTotal = r2(cur.landingTotal + l.landingTotal);
      m.set(k, cur);
    }
    return m;
  };

  const byRate = [...fold((l) => String(l.gstRatePercent ?? 'unknown'))]
    .map(([rate, v]) => ({ ratePercent: rate === 'unknown' ? null : Number(rate), ...v }))
    .sort((a, b) => (b.ratePercent ?? -1) - (a.ratePercent ?? -1));

  const bySupplier = [...fold((l) => l.supplierId ?? 'none')]
    .map(([supplierId, v]) => {
      const first = rows.find((l) => (l.supplierId ?? 'none') === supplierId);
      return {
        supplierId: supplierId === 'none' ? null : supplierId,
        supplierName: first?.supplierName ?? null,
        supplierGstin: first?.supplierGstin ?? null,
        ...v,
      };
    })
    .sort((a, b) => b.taxAmount - a.taxAmount);

  const totals = {
    count: rows.length,
    taxableValue: r2(rows.reduce((t, l) => t + l.taxableValue, 0)),
    taxAmount: r2(rows.reduce((t, l) => t + l.taxAmount, 0)),
    landingTotal: r2(rows.reduce((t, l) => t + l.landingTotal, 0)),
  };

  return {
    period,
    byRate,
    bySupplier,
    totals,
    /** Purchases with no rate recorded — their credit cannot be claimed as it stands. */
    withoutRate: rows.filter((l) => l.gstRatePercent == null).length,
    coverage: COVERAGE_NOTE,
  };
}

/**
 * B-4 — Supplier GSTIN Exception Report.
 *
 * Credit can only be claimed against a supplier who is registered and has
 * declared the supply. A purchase from a supplier with no GSTIN on file, or one
 * that is not a valid GSTIN, is credit at risk — and it is far cheaper to find
 * that during the month than in a notice two years later.
 */
export async function getSupplierGstinExceptions(
  tenantId: string,
  query: SalesReportQuery = {},
) {
  const { checkGstin } = await import('../../shared/gst');
  const { period, rows } = await getPurchaseRegister(tenantId, query);

  const bySupplier = new Map<
    string,
    { supplierId: string | null; supplierName: string | null; supplierGstin: string | null;
      problem: string; taxAtRisk: number; purchaseValue: number; batches: number }
  >();

  for (const l of rows) {
    const gstin = (l.supplierGstin ?? '').trim();
    const check = gstin ? checkGstin(gstin) : null;
    const problem = !gstin
      ? 'No GSTIN on file'
      : check?.valid === false
        ? `Invalid GSTIN — ${check.reason ?? 'failed the checksum'}`
        : null;
    if (!problem) continue;

    const key = l.supplierId ?? `unknown:${l.supplierName ?? ''}`;
    const cur = bySupplier.get(key) ?? {
      supplierId: l.supplierId,
      supplierName: l.supplierName,
      supplierGstin: gstin || null,
      problem,
      taxAtRisk: 0,
      purchaseValue: 0,
      batches: 0,
    };
    cur.taxAtRisk = r2(cur.taxAtRisk + l.taxAmount);
    cur.purchaseValue = r2(cur.purchaseValue + l.taxableValue);
    cur.batches += 1;
    bySupplier.set(key, cur);
  }

  const suppliers = [...bySupplier.values()].sort((a, b) => b.taxAtRisk - a.taxAtRisk);
  return {
    period,
    suppliers,
    totals: {
      suppliers: suppliers.length,
      batches: suppliers.reduce((t, s) => t + s.batches, 0),
      taxAtRisk: r2(suppliers.reduce((t, s) => t + s.taxAtRisk, 0)),
    },
    coverage: COVERAGE_NOTE,
  };
}

/**
 * B-3 — Rule 42 / 43 ITC Reversal Working.
 *
 * The calculation that decides how much of the month's input credit the
 * hospital actually keeps. Laid out as a WORKING, step by step with the rule's
 * own labels, so an auditor can follow it rather than re-do it.
 *
 * The honest part, and the reason every step is named: Rule 42 starts by
 * splitting the month's input tax into credit used exclusively for non-business
 * purposes (T1), exclusively for exempt supplies (T2), blocked under 17(5)
 * (T3), and exclusively for taxable supplies (T4). **This system does not
 * record that split** — a drug batch is not tagged with the use it will be put
 * to. So T1 to T4 are reported as zero and the whole of the month's input tax
 * is treated as common credit, which is the conservative reading: common credit
 * is what gets apportioned, so nothing is quietly kept that should have gone
 * back. Where a hospital can identify exclusive use, the figures have to be
 * adjusted by hand, and the report says so rather than presenting a number it
 * cannot support.
 */
export async function getItcReversalWorking(tenantId: string, query: SalesReportQuery = {}) {
  const [itc, turnover] = await Promise.all([
    getItcSummary(tenantId, query),
    getExemptTurnover(tenantId, query),
  ]);

  // Rule 42's own names, kept so the working can be read beside the rule.
  const T = itc.totals.taxAmount;
  const T1 = 0;
  const T2 = 0;
  const T3 = 0;
  const C1 = r2(T - (T1 + T2 + T3));
  const T4 = 0;
  const C2 = r2(C1 - T4);

  const E = turnover.exemptTurnover;
  const F = turnover.totalTurnover;
  // D1 — the exempt share of the common credit. This is the number.
  const D1 = F > 0 ? r2((E / F) * C2) : 0;
  // D2 — deemed 5% for non-business use. Nothing here is non-business: a
  // hospital's stock is bought for the hospital, so this stays at zero rather
  // than reversing credit on an assumption.
  const D2 = 0;
  const C3 = r2(C2 - (D1 + D2));

  return {
    period: itc.period,
    /** Every step, with the label the rule uses for it. */
    working: [
      { step: 'T', label: 'Total input tax in the period', amount: T,
        source: 'B-2 Input Tax Credit Summary' },
      { step: 'T1', label: 'Used exclusively for non-business purposes', amount: T1,
        source: 'Not recorded — see the note' },
      { step: 'T2', label: 'Used exclusively for exempt supplies', amount: T2,
        source: 'Not recorded — see the note' },
      { step: 'T3', label: 'Blocked under section 17(5)', amount: T3,
        source: 'Not recorded — see the note' },
      { step: 'C1', label: 'Credit credited to the electronic credit ledger', amount: C1,
        source: 'T − (T1 + T2 + T3)' },
      { step: 'T4', label: 'Used exclusively for taxable supplies', amount: T4,
        source: 'Not recorded — see the note' },
      { step: 'C2', label: 'Common credit', amount: C2, source: 'C1 − T4' },
      { step: 'E', label: 'Exempt turnover in the period', amount: E,
        source: 'A-7 Exempt, Nil-rated and Non-GST Turnover' },
      { step: 'F', label: 'Total turnover in the period', amount: F,
        source: 'A-7 Exempt, Nil-rated and Non-GST Turnover' },
      { step: 'D1', label: 'Common credit attributable to exempt supplies — REVERSE', amount: D1,
        source: '(E ÷ F) × C2' },
      { step: 'D2', label: 'Deemed 5% for non-business use', amount: D2,
        source: `${NON_BUSINESS_PERCENT}% of C2, where any non-business use exists` },
      { step: 'C3', label: 'Credit the hospital keeps', amount: C3, source: 'C2 − (D1 + D2)' },
    ],
    exemptRatioPercent: turnover.exemptRatio,
    creditAvailable: T,
    reversal: { total: r2(D1 + D2), d1: D1, d2: D2 },
    /** C3 — what the hospital actually keeps. */
    netCreditAvailable: C3,
    notes: [
      'Rule 42 requires input tax to be split by the use it is put to (T1–T4). This system does not record that split, so the whole of the month’s input tax is treated as common credit — the conservative reading. Adjust by hand where exclusive use can be identified.',
      COVERAGE_NOTE,
    ],
  };
}
