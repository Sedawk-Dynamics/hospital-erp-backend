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
  /**
   * The head-wise split. Read off the batch where the inward captured it, and
   * otherwise derived: the supplier's state against the hospital's decides
   * whether the credit sits in IGST or splits between CGST and SGST. B-1's own
   * column list asks for all four and the register reported one lump `taxAmount`.
   */
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  supplierStateCode: string | null;
  isInterState: boolean;
  /** 'eligible' | 'ineligible' | 'partly' — section 17(5) and the room rule. */
  itcEligibility: string;
  itcBlockedReason: string | null;
  landingTotal: number;
}

function dateRange(query: SalesReportQuery) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

/**
 * The head-wise split of the tax paid on one purchase.
 *
 * Read off the batch where the inward captured it. Where it did not — every
 * batch received before those columns existed — it is derived: the supplier's
 * state against the hospital's decides whether the whole amount is IGST or
 * splits between CGST and SGST, and the odd paisa goes to CGST, exactly as it
 * does on the outward side.
 *
 * A supplier with no state on file is treated as local, which is what the
 * register assumed for every purchase until now.
 */
function splitInput(
  taxAmount: number,
  batch: {
    inputCgst?: unknown; inputSgst?: unknown; inputIgst?: unknown;
    supplier?: { stateCode?: string | null; gstNumber?: string | null } | null;
  },
  homeState: string | null,
): {
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  supplierStateCode: string | null;
  isInterState: boolean;
} {
  const supplierState =
    batch.supplier?.stateCode ??
    (batch.supplier?.gstNumber && /^\d{2}/.test(batch.supplier.gstNumber)
      ? batch.supplier.gstNumber.slice(0, 2)
      : null);
  const interState = Boolean(homeState && supplierState && homeState !== supplierState);

  const stored =
    batch.inputCgst != null || batch.inputSgst != null || batch.inputIgst != null
      ? {
          cgstAmount: r2(Number(batch.inputCgst ?? 0)),
          sgstAmount: r2(Number(batch.inputSgst ?? 0)),
          igstAmount: r2(Number(batch.inputIgst ?? 0)),
        }
      : null;
  if (stored) return { ...stored, supplierStateCode: supplierState, isInterState: interState };

  if (interState) {
    return {
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: r2(taxAmount),
      supplierStateCode: supplierState,
      isInterState: true,
    };
  }
  const half = r2(taxAmount / 2);
  return {
    // The odd paisa goes to CGST, consistently — the same rule the outward side
    // follows, so the two sides of the ledger round the same way.
    cgstAmount: r2(taxAmount - half),
    sgstAmount: half,
    igstAmount: 0,
    supplierStateCode: supplierState,
    isInterState: false,
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
      itcEligibility: true, itcBlockedReason: true,
      inputCgst: true, inputSgst: true, inputIgst: true,
      drug: { select: { drugName: true, hsnCode: true } },
      supplier: { select: { id: true, name: true, gstNumber: true, stateCode: true } },
    },
  });

  // The hospital's own state, so an inter-state purchase can be told from an
  // intra-state one. Without it every purchase was assumed local.
  let homeState: string | null = null;
  try {
    const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
    homeState = (await getGstProfile(tenantId)).stateCode;
  } catch {
    /* unreadable profile → treat every purchase as intra-state, as before */
  }

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
      ...splitInput(money.taxAmount ?? 0, b, homeState),
      itcEligibility: String(b.itcEligibility ?? 'eligible'),
      itcBlockedReason: b.itcBlockedReason ?? null,
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
    cgstAmount: r2(rows.reduce((t, l) => t + l.cgstAmount, 0)),
    sgstAmount: r2(rows.reduce((t, l) => t + l.sgstAmount, 0)),
    igstAmount: r2(rows.reduce((t, l) => t + l.igstAmount, 0)),
    landingTotal: r2(rows.reduce((t, l) => t + l.landingTotal, 0)),
  };

  // ── The ladder ───────────────────────────────────────────────────────────
  //
  // This report used to stop at gross credit by rate and by supplier, which is
  // the rung that flatters the hospital: for a clinical establishment most of
  // that number is reversed again under Rule 42, and the accountant had to
  // assemble the real answer from B-2 and B-3 in their head.
  //
  //   Gross ITC → Ineligible → Reversals → Eligible → Claimed → Remaining
  //
  // Every rung names its source, because a figure an auditor cannot trace is a
  // figure they will re-derive from scratch.
  const gross = totals.taxAmount;

  const ineligibleRows = rows.filter((l) => l.itcEligibility === 'ineligible');
  const partlyRows = rows.filter((l) => l.itcEligibility === 'partly');
  // A "partly" line is half in and half out until somebody apportions it, and
  // guessing the share would be inventing a number. It is reported separately
  // and counted as ineligible in the running total, which is the conservative
  // direction: under-claiming costs money, over-claiming costs money AND
  // interest.
  const ineligible = r2(
    ineligibleRows.reduce((t, l) => t + l.taxAmount, 0) +
      partlyRows.reduce((t, l) => t + l.taxAmount, 0),
  );

  // Rule 42/43, from B-3 — the reversal that follows from the hospital's exempt
  // turnover. Read rather than recomputed so B-2 and B-3 can never disagree.
  let reversals = 0;
  let reversalNote = 'Rule 42/43 working could not be read';
  try {
    const working = await getItcReversalWorking(tenantId, query);
    reversals = working.reversal.total;
    reversalNote = `Rule 42 D1 + D2 for the period (exempt turnover ${
      Math.round((working.exemptRatioPercent ?? 0) * 1000) / 10
    }% of total)`;
  } catch {
    /* leave at zero and say so */
  }

  const eligible = r2(Math.max(0, gross - ineligible - reversals));

  return {
    period,
    byRate,
    bySupplier,
    totals,
    /**
     * What the hospital actually keeps, rung by rung, each with its source.
     *
     * `claimed` has no source in this system: nothing records what was actually
     * claimed in GSTR-3B, because that number is entered on the portal. It is
     * reported as null rather than as zero — a zero would read as "nothing was
     * claimed", which is a different and much more alarming statement.
     */
    ladder: [
      {
        key: 'gross',
        label: 'Gross ITC',
        amount: gross,
        source: 'B-1 purchase register — total tax on every purchase in the period',
      },
      {
        key: 'ineligible',
        label: 'Ineligible ITC',
        amount: ineligible,
        source:
          ineligibleRows.length + partlyRows.length === 0
            ? 'Nothing marked blocked under section 17(5) — no purchase in this period carries an eligibility flag'
            : `${ineligibleRows.length} blocked and ${partlyRows.length} partly-eligible purchase(s) under section 17(5)`,
      },
      {
        key: 'reversals',
        label: 'Rule 42 / 43 reversal',
        amount: reversals,
        source: reversalNote,
      },
      {
        key: 'eligible',
        label: 'Eligible ITC',
        amount: eligible,
        source: 'Gross less ineligible less the reversal',
      },
      {
        key: 'claimed',
        label: 'ITC claimed',
        amount: null as number | null,
        source:
          'Not recorded here — the figure is entered on the portal in GSTR-3B. ' +
          'Enter it against the filed period to complete the ladder.',
      },
      {
        key: 'remaining',
        label: 'Remaining',
        amount: null as number | null,
        source: 'Eligible less claimed, once the claimed figure is known',
      },
    ],
    /** Purchases with no rate recorded — their credit cannot be claimed as it stands. */
    withoutRate: rows.filter((l) => l.gstRatePercent == null).length,
    ineligibleCount: ineligibleRows.length,
    partlyEligibleCount: partlyRows.length,
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

/**
 * B-6 — Purchase Returns and Debit Notes.
 *
 * Credit already taken has to go back when the goods do. Two ways that happens
 * in this hospital, and they are kept apart because only one of them involves
 * the supplier at all:
 *
 *   - a VENDOR RETURN — stock sent back, against which the supplier raises a
 *     credit note. The input tax on what went back is reversed;
 *   - an EXPIRY WRITE-OFF — nothing goes back to anybody, but section 17(5)(h)
 *     blocks credit on goods written off, so the tax on them is reversed all
 *     the same. This is the one hospitals forget, and it is the one an auditor
 *     finds by comparing the expiry register to the reversal.
 *
 * The tax comes from the BATCH the goods were bought on, at the rate that was
 * paid — not at today's rate, and not at the rate the same drug is sold at.
 */
export async function getPurchaseReturns(
  tenantId: string,
  query: SalesReportQuery & { supplierId?: string } = {},
) {
  const { from, to } = dateRange(query);
  const window = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  const returns = await prisma.drugReturn.findMany({
    where: {
      tenantId,
      returnType: 'vendor_return',
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(window ? { createdAt: window } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, createdAt: true, quantity: true, reason: true, status: true,
      creditNoteNumber: true, creditAmount: true, batchNumber: true, expiryDate: true,
      drug: { select: { drugName: true, hsnCode: true } },
      supplier: { select: { id: true, name: true, gstNumber: true } },
      drugBatch: {
        select: {
          purchasePrice: true, purchaseDiscountPercent: true, gstPercent: true,
          invoiceNumber: true, invoiceDate: true,
        },
      },
    },
  });

  const rows = returns.map((r) => {
    const b = r.drugBatch;
    // Priced at what was PAID for these units, so the reversal matches the
    // credit that was taken. A vendor credit note, where one exists, is what
    // the supplier says — both are reported and any gap is visible.
    const netRate = b?.purchasePrice != null
      ? r2(Number(b.purchasePrice) * (1 - Number(b.purchaseDiscountPercent ?? 0) / 100))
      : null;
    const taxableValue = netRate != null ? r2(netRate * r.quantity) : 0;
    const rate = b?.gstPercent == null ? null : Number(b.gstPercent);
    const taxToReverse = rate != null ? r2(taxableValue * (rate / 100)) : 0;
    return {
      returnId: r.id,
      date: r.createdAt,
      status: String(r.status),
      supplierId: r.supplier?.id ?? null,
      supplierName: r.supplier?.name ?? null,
      supplierGstin: r.supplier?.gstNumber ?? null,
      drugName: r.drug?.drugName ?? '',
      hsnCode: r.drug?.hsnCode ?? null,
      batchNumber: r.batchNumber,
      expiryDate: r.expiryDate,
      quantity: r.quantity,
      reason: r.reason,
      /** The supplier's own credit note, where they have raised one. */
      supplierCreditNoteNumber: r.creditNoteNumber,
      supplierCreditAmount: r.creditAmount == null ? null : r2(Number(r.creditAmount)),
      purchaseInvoiceNumber: b?.invoiceNumber ?? null,
      purchaseInvoiceDate: b?.invoiceDate ?? null,
      taxableValue,
      gstRatePercent: rate,
      taxToReverse,
    };
  });

  // Expiry write-offs on general inventory. Nothing goes back to the supplier,
  // but 17(5)(h) blocks the credit all the same.
  const writeOffs = await prisma.stockTransaction.findMany({
    where: {
      tenantId,
      transactionType: 'expired_removal',
      ...(window ? { createdAt: window } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, createdAt: true, quantity: true, batchNumber: true, expiryDate: true,
      totalCost: true, notes: true,
      inventoryItem: { select: { itemName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  const expired = writeOffs.map((w) => ({
    transactionId: w.id,
    date: w.createdAt,
    itemName: w.inventoryItem?.itemName ?? '',
    supplierName: w.supplier?.name ?? null,
    batchNumber: w.batchNumber,
    expiryDate: w.expiryDate,
    quantity: w.quantity,
    value: w.totalCost == null ? 0 : r2(Number(w.totalCost)),
    notes: w.notes,
  }));

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    returns: rows,
    expiryWriteOffs: expired,
    totals: {
      returns: rows.length,
      returnedValue: r2(rows.reduce((t, x) => t + x.taxableValue, 0)),
      taxToReverse: r2(rows.reduce((t, x) => t + x.taxToReverse, 0)),
      /** Sent back with no credit note from the supplier — chase these. */
      withoutSupplierCreditNote: rows.filter((x) => !x.supplierCreditNoteNumber).length,
      expiryWriteOffs: expired.length,
      expiredValue: r2(expired.reduce((t, x) => t + x.value, 0)),
    },
    notes: [
      'Tax on a return is reversed at the rate PAID on the batch it was bought on, not at today’s rate.',
      'Expiry write-offs carry no tax figure: the general inventory stock record holds a cost but no GST rate. Section 17(5)(h) still blocks the credit, so the value is reported for the accountant to reverse against.',
      COVERAGE_NOTE,
    ],
  };
}

