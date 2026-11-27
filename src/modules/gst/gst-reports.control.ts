// ---------------------------------------------------------------------------
// The operational and control reports (Group C).
//
// These exist so problems are caught DURING the month rather than on the day of
// filing. Nothing here is a return; everything here is a question somebody in
// the hospital has to be able to answer without waiting for the accountant.
//
// C-3 and C-4 are the two that earn their place. C-3 finds the items that were
// billed without a code or a treatment, which is how an unclassified line
// reaches a return. C-4 is what an auditor asks for on day one: prove your
// invoice series has no holes.
// ---------------------------------------------------------------------------

import { isAdvanceApplication, collectionDocumentNumber } from '../billing/bill-payment-ledger';
import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import { getSalesRegister, totalOf, type SalesReportQuery } from './gst-reports.sales';
import {
  getCreditNoteRegister, notesThatReduceOutward, noteExclusions, outwardTaxableNet,
} from './gst-reports.returns';
import {
  getItemRateChanges, getItemVsMasterDifferences, getBilledVsItemDifferences,
} from './gst-reports.rate-audit';

/**
 * The tender a payment was made in, grouped the way the cash desk counts it.
 *
 * Read from the payment row itself. Credit and debit cards are one "Card"
 * bucket — the day-end sheet counts them together, and C-1b showed card as ₹0
 * when card takings were listed under other names (gap item 280).
 */
export function paymentModeOf(method: string | null | undefined): string {
  switch (String(method ?? '')) {
    case 'cash': return 'cash';
    case 'credit_card':
    case 'debit_card':
    case 'card': return 'card';
    case 'upi': return 'upi';
    case 'net_banking':
    case 'bank_transfer': return 'net_banking';
    case 'cheque': return 'cheque';
    case 'insurance': return 'insurance';
    case 'advance': return 'advance';
    default: return 'other';
  }
}

/** Every mode, so a mode with nothing in it reads ₹0 rather than vanishing. */
const PAYMENT_MODES = ['cash', 'card', 'upi', 'net_banking', 'cheque', 'insurance', 'advance', 'other'];

const n = (v: unknown) => r2(Number(v ?? 0));

function dateRange(query: { from?: string; to?: string }) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

/**
 * GST Collected Through Payments — what came in, by counter, cashier and mode.
 *
 * This was called "C-1 Daily GST Collection" and stood alone, which mixed two
 * accounting concepts the review document is explicit about keeping apart: GST
 * LIABILITY and cash COLLECTED are not the same number. An invoice raised today
 * and paid next month is liability today and cash next month; an advance, a
 * credit sale, a refund and a credit note all pull them further apart.
 *
 * So this is now the cash half only, and {@link getDailyGstLiability} is the
 * other half — C-1 proper, keyed on the bill.
 *
 * Keyed on the PAYMENT, because this is the cash-desk question — "what came in
 * today and who took it". The tax is apportioned to the payment by its share of
 * the bill: a part payment against a taxed bill carries a part of the tax,
 * which is the only defensible split when the patient has not paid in full.
 */
export async function getDailyCollection(tenantId: string, query: { from?: string; to?: string } = {}) {
  const { from, to } = dateRange(query);

  const allPayments = await prisma.payment.findMany({
    where: {
      tenantId,
      status: 'completed',
      ...(from || to ? { paymentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { paymentDate: 'asc' },
    select: {
      id: true, paymentDate: true, amount: true, paymentMethod: true,
      paymentType: true, paymentSource: true,
      transactionId: true, notes: true, voucherNumber: true, sourceAdvancePaymentId: true,
      processor: { select: { firstName: true, lastName: true } },
      bill: { select: { id: true, billNumber: true, totalAmount: true, taxAmount: true } },
    },
  });

  // A deposit or advance APPLIED to a bill is not new money — the receipt that
  // brought it in is already counted (gap item 361). Leave the applications
  // out so the day's collection is counted once.
  const payments = allPayments.filter((p) => !isAdvanceApplication({
    paymentType: String(p.paymentType),
    paymentMethod: String(p.paymentMethod),
    sourceAdvancePaymentId: p.sourceAdvancePaymentId,
    transactionId: p.transactionId,
    notes: p.notes,
  }));

  // A bill settled in several tenders (cash + card…) is several payment rows.
  // Each carries tax in proportion to its own amount, and the shares are
  // scaled so a bill's tenders together never carry more than the bill's tax
  // (gap item 280).
  const tenderedByBill = new Map<string, number>();
  for (const p of payments) {
    if (!p.bill || p.paymentType === 'refund') continue;
    tenderedByBill.set(p.bill.id, r2((tenderedByBill.get(p.bill.id) ?? 0) + n(p.amount)));
  }

  // The payment's share of the bill's tax. A refund carries its share back.
  // Rounded one by one, three equal tenders of a bill with 10.00 of tax came to
  // 9.99: the paisa rounding left over goes to the bill's last tender (and, for
  // refunds, its last refund), so the modes always add up to the tax (#280).
  const taxShares = new Map<string, number>();
  const byBill = new Map<string, typeof payments>();
  for (const p of payments) {
    if (!p.bill) continue;
    const key = `${p.bill.id}:${p.paymentType === 'refund' ? 'refund' : 'in'}`;
    byBill.set(key, [...(byBill.get(key) ?? []), p]);
  }
  for (const list of byBill.values()) {
    const bill = list[0]!.bill!;
    const base = Math.max(n(bill.totalAmount), tenderedByBill.get(bill.id) ?? 0);
    const shareOf = (amount: number) => (base > 0 ? Math.min(1, amount / base) : 0);
    const whole = r2(n(bill.taxAmount) * shareOf(r2(list.reduce((t, p) => t + n(p.amount), 0))));
    let given = 0;
    list.forEach((p, i) => {
      const tax = i === list.length - 1 ? r2(whole - given) : r2(n(bill.taxAmount) * shareOf(n(p.amount)));
      given = r2(given + tax);
      taxShares.set(p.id, tax);
    });
  }

  const rows = payments.map((p) => {
    const amount = n(p.amount);
    const taxShare = r2((taxShares.get(p.id) ?? 0) * (p.paymentType === 'refund' ? -1 : 1));
    return {
      paymentId: p.id,
      date: p.paymentDate,
      day: p.paymentDate.toISOString().slice(0, 10),
      amount: p.paymentType === 'refund' ? -amount : amount,
      /** The mode as saved on the payment record. */
      method: String(p.paymentMethod),
      mode: paymentModeOf(String(p.paymentMethod)),
      type: String(p.paymentType),
      counter: p.paymentSource ? String(p.paymentSource) : 'unknown',
      cashier: p.processor ? fullName(p.processor) : null,
      billNumber: p.bill?.billNumber ?? null,
      /** The receipt voucher for an advance / refund — unique per receipt (gap 361). */
      documentNumber: collectionDocumentNumber({
        paymentType: String(p.paymentType), voucherNumber: p.voucherNumber, bill: p.bill,
      }),
      taxCollected: taxShare,
    };
  });

  const fold = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { collected: number; taxCollected: number; count: number }>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { collected: 0, taxCollected: 0, count: 0 };
      cur.collected = r2(cur.collected + r.amount);
      cur.taxCollected = r2(cur.taxCollected + r.taxCollected);
      cur.count += 1;
      m.set(k, cur);
    }
    return m;
  };

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows,
    byDay: [...fold((r) => r.day)].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    byMethod: [...fold((r) => r.method)].map(([method, v]) => ({ method, ...v })),
    /** By tender, every mode listed — card = credit + debit card. */
    byMode: (() => {
      const m = fold((r) => r.mode);
      return PAYMENT_MODES.map((mode) => ({
        mode, ...(m.get(mode) ?? { collected: 0, taxCollected: 0, count: 0 }),
      }));
    })(),
    byCounter: [...fold((r) => r.counter)].map(([counter, v]) => ({ counter, ...v })),
    byCashier: [...fold((r) => r.cashier ?? 'unattributed')].map(([cashier, v]) => ({ cashier, ...v })),
    totals: {
      count: rows.length,
      collected: r2(rows.reduce((t, r) => t + r.amount, 0)),
      taxCollected: r2(rows.reduce((t, r) => t + r.taxCollected, 0)),
    },
    note:
      'Tax is apportioned to each payment by its share of the bill it was made against — ' +
      'a part payment carries a part of the tax. This is CASH COLLECTED, not the ' +
      'month\u2019s liability: see Daily GST Billing / Tax Liability for what was charged.',
  };
}

/**
 * C-1 — Daily GST Billing / Tax Liability. What the hospital CHARGED.
 *
 * Keyed on the BILL, which is where a liability arises. This is the number the
 * billing manager checks daily and the number that eventually becomes GSTR-3B
 * box 3.1(a) — and it is emphatically not the cash figure beside it: an invoice
 * raised today and paid next month is liability today.
 *
 * Cut the three ways the daily check needs: by day, by department, and by the
 * person who raised the document.
 */
export async function getDailyGstLiability(tenantId: string, query: SalesReportQuery = {}) {
  const [{ period, rows }, notes] = await Promise.all([
    getSalesRegister(tenantId, query),
    getCreditNoteRegister(tenantId, { from: query.from, to: query.to }),
  ]);

  const fold = (key: (l: (typeof rows)[number]) => string) => {
    const m = new Map<
      string,
      { taxableValue: number; taxAmount: number; cgstAmount: number; sgstAmount: number; igstAmount: number; exemptValue: number; lines: number; bills: Set<string> }
    >();
    for (const l of rows) {
      const k = key(l);
      const cur = m.get(k) ?? {
        taxableValue: 0, taxAmount: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0,
        exemptValue: 0, lines: 0, bills: new Set<string>(),
      };
      if (l.gstTreatment === 'taxable') {
        cur.taxableValue = r2(cur.taxableValue + l.taxableValue);
      } else {
        cur.exemptValue = r2(cur.exemptValue + l.taxableValue);
      }
      cur.taxAmount = r2(cur.taxAmount + l.taxAmount);
      cur.cgstAmount = r2(cur.cgstAmount + l.cgstAmount);
      cur.sgstAmount = r2(cur.sgstAmount + l.sgstAmount);
      cur.igstAmount = r2(cur.igstAmount + l.igstAmount);
      cur.lines += 1;
      cur.bills.add(l.billId);
      m.set(k, cur);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v, bills: v.bills.size }));
  };

  const taxable = rows.filter((l) => l.gstTreatment === 'taxable');
  const exempt = rows.filter((l) => l.gstTreatment && l.gstTreatment !== 'taxable');

  // ── Gross, credit notes and net, rate by rate (gap item 276) ─────────────
  //
  // The liability for the period is what was billed LESS the sales returns
  // and cancellations that reverse it — the same notes, chosen the same way,
  // that GSTR-3B nets off. Without them C-1 overstated the liability and never
  // agreed with 3.1(a).
  const applied = notesThatReduceOutward(notes.rows);
  type RateRow = { ratePercent: number; gross: ReturnType<typeof zeroHeads>; creditNotes: ReturnType<typeof zeroHeads> };
  const zeroHeads = () => ({ taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, taxAmount: 0 });
  const addHeads = (a: ReturnType<typeof zeroHeads>, b: Partial<Record<keyof ReturnType<typeof zeroHeads>, unknown>>) => {
    for (const k of Object.keys(a) as (keyof typeof a)[]) a[k] = r2(a[k] + Number(b[k] ?? 0));
  };
  const rates = new Map<number, RateRow>();
  const rateRow = (rate: number) => {
    const cur = rates.get(rate) ?? { ratePercent: rate, gross: zeroHeads(), creditNotes: zeroHeads() };
    rates.set(rate, cur);
    return cur;
  };
  for (const l of taxable) addHeads(rateRow(l.taxRatePercent).gross, l);
  for (const c of applied) {
    const taxableItems = (c.items ?? []).filter((i) => i.gstTreatment === 'taxable');
    if (taxableItems.length) {
      for (const i of taxableItems) addHeads(rateRow(Number(i.taxPercent ?? 0)).creditNotes, i);
    } else if (c.byTreatment.taxable.taxableValue !== 0 || c.byTreatment.taxable.taxAmount !== 0) {
      // A legacy note with no lines: its rate is read off its own figures.
      const t = c.byTreatment.taxable;
      const rate = t.taxableValue !== 0 ? Math.round((t.taxAmount / t.taxableValue) * 100) : 0;
      addHeads(rateRow(rate).creditNotes, t);
    }
  }
  const byRate = [...rates.values()]
    .map((r) => {
      const net = zeroHeads();
      addHeads(net, r.gross);
      addHeads(net, r.creditNotes);
      return { ...r, net };
    })
    .sort((a, b) => b.ratePercent - a.ratePercent);
  const sumOf = (pick: (r: (typeof byRate)[number]) => ReturnType<typeof zeroHeads>) => {
    const t = zeroHeads();
    for (const r of byRate) addHeads(t, pick(r));
    return t;
  };
  const gstr3bOutward = outwardTaxableNet(totalOf(taxable), applied);
  const netTotals = sumOf((r) => r.net);

  return {
    period,
    /** Gross billed, credit notes (negative) and net, per rate. Net = GSTR-3B 3.1(a). */
    byRate,
    liability: {
      gross: sumOf((r) => r.gross),
      creditNotes: sumOf((r) => r.creditNotes),
      net: netTotals,
      gstr3bOutwardTax: gstr3bOutward.taxAmount,
      agreesWithGstr3b: Math.abs(netTotals.taxAmount - gstr3bOutward.taxAmount) < 0.01
        && Math.abs(netTotals.taxableValue - gstr3bOutward.taxableValue) < 0.01,
      notesApplied: applied.length,
      notesExcluded: noteExclusions(notes.rows),
    },
    byDay: fold((l) => l.billDate.toISOString().slice(0, 10))
      .map((r) => ({ day: r.key, ...r }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    byDepartment: fold((l) => l.department).map((r) => ({ department: r.key, ...r })),
    byRaisedBy: fold((l) => l.raisedBy ?? 'unattributed').map((r) => ({ raisedBy: r.key, ...r })),
    totals: {
      bills: new Set(rows.map((l) => l.billId)).size,
      lines: rows.length,
      taxableValue: r2(taxable.reduce((t, l) => t + l.taxableValue, 0)),
      exemptValue: r2(exempt.reduce((t, l) => t + l.taxableValue, 0)),
      cgstAmount: r2(rows.reduce((t, l) => t + l.cgstAmount, 0)),
      sgstAmount: r2(rows.reduce((t, l) => t + l.sgstAmount, 0)),
      igstAmount: r2(rows.reduce((t, l) => t + l.igstAmount, 0)),
      taxAmount: r2(rows.reduce((t, l) => t + l.taxAmount, 0)),
    },
    note:
      'This is what was BILLED — the liability that arose in the period. It is not ' +
      'the cash figure: an invoice raised today and paid next month is liability today. ' +
      'For what actually came in, see GST Collected Through Payments.',
  };
}

/**
 * C-2 — Exempt vs Taxable Revenue Mix, by month.
 *
 * Management's view of the same ratio B-3 turns on. A hospital whose taxable
 * share is drifting up is a hospital whose input credit position is changing,
 * and it is better to see that as a trend than as a surprise in the reversal.
 */
export async function getRevenueMix(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, query);

  const months = new Map<string, { taxable: number; exempt: number; unclassified: number }>();
  for (const l of rows) {
    const key = l.billDate.toISOString().slice(0, 7);
    const cur = months.get(key) ?? { taxable: 0, exempt: 0, unclassified: 0 };
    if (!l.gstTreatment) cur.unclassified = r2(cur.unclassified + l.taxableValue);
    else if (l.gstTreatment === 'taxable') cur.taxable = r2(cur.taxable + l.taxableValue);
    else cur.exempt = r2(cur.exempt + l.taxableValue);
    months.set(key, cur);
  }

  return {
    period,
    byMonth: [...months]
      .map(([month, v]) => {
        const total = r2(v.taxable + v.exempt + v.unclassified);
        return {
          month, ...v, total,
          taxableSharePercent: total > 0 ? r2((v.taxable / total) * 100) : 0,
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month)),
    totals: totalOf(rows),
  };
}

/**
 * C-3 — Unmapped Items Exception Report. The one that prevents surprises.
 *
 * Three different problems, kept apart because they are fixed in different
 * places and only one of them is urgent:
 *
 *   - no treatment at all — the line has no tax position, and a return cannot
 *     report it as anything;
 *   - no HSN or SAC — the line is classified but Table 12 has nothing to key
 *     on, and Rule 46 requires the code on the invoice;
 *   - a typed rate — taxable, from an item nobody has signed off, with no code
 *     behind it. Somebody at a counter decided the tax. That is the one to
 *     look at first.
 */
export async function getUnmappedItems(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, query);

  const noTreatment = rows.filter((l) => !l.gstTreatment);
  const noCode = rows.filter((l) => !!l.gstTreatment && !l.hsnSac);
  const typedRate = rows.filter((l) => l.requiresTaxResolution);
  // The fourth bucket, and the one that will get a return rejected rather than
  // merely queried: a line billed at a rate the law did not recognise on the
  // day it went out. The finalisation gate stops new ones; these are already
  // issued, and nothing was surfacing them.
  const illegalRate = rows.filter((l) => l.illegalRate);

  const byItem = (list: typeof rows) => {
    const m = new Map<string, { description: string; department: string; lines: number; value: number; rates: Set<number> }>();
    for (const l of list) {
      const key = `${l.department}:${l.description.toLowerCase()}`;
      const cur = m.get(key) ?? {
        description: l.description, department: l.department,
        lines: 0, value: 0, rates: new Set<number>(),
      };
      cur.lines += 1;
      cur.value = r2(cur.value + l.totalAmount);
      cur.rates.add(l.taxRatePercent);
      m.set(key, cur);
    }
    return [...m.values()]
      .map((v) => ({ ...v, rates: [...v.rates].sort((a, b) => a - b) }))
      .sort((a, b) => b.value - a.value);
  };

  return {
    period,
    /** No tax position at all. A return cannot report these as anything. */
    withoutTreatment: { totals: totalOf(noTreatment), items: byItem(noTreatment) },
    /** Classified, but with no code for Rule 46 or Table 12. */
    withoutCode: { totals: totalOf(noCode), items: byItem(noCode) },
    /** A rate somebody typed, on an item nobody approved, with no code. */
    typedRate: { totals: totalOf(typedRate), items: byItem(typedRate), lines: typedRate.map((l) => ({
      billNumber: l.billNumber, invoiceNumber: l.invoiceNumber, billDate: l.billDate,
      description: l.description, department: l.department,
      ratePercent: l.taxRatePercent, taxAmount: l.taxAmount, rateSource: l.rateSource,
    })) },
    /**
     * Billed at a rate that was not a legal slab on the bill's own date.
     *
     * Judged as at the BILL's date, so a 12% line from June 2025 was correct
     * then and is not listed. Each one has to be corrected with a credit note
     * and a fresh invoice at the right rate — section 4.9 of the report.
     */
    illegalRate: {
      totals: totalOf(illegalRate),
      items: byItem(illegalRate),
      lines: illegalRate.map((l) => ({
        billNumber: l.billNumber, invoiceNumber: l.invoiceNumber, billDate: l.billDate,
        description: l.description, department: l.department,
        ratePercent: l.taxRatePercent, taxAmount: l.taxAmount, rateSource: l.rateSource,
      })),
    },
    totals: {
      linesChecked: rows.length,
      exceptions: new Set(
        [...noTreatment, ...noCode, ...typedRate, ...illegalRate].map((l) => l.itemId),
      ).size,
    },
  };
}

/**
 * The one-off list section 6.11 asks for: IP bills that charged tax on ward
 * medicines before the composite-supply rule went in.
 *
 * "Historic IP bills that charged 5% on ward medicines — identified and listed
 * by a one-off report, so the hospital and its auditor can decide whether to
 * correct them."
 *
 * Medicines and consumables used ON an admitted patient are part of an exempt
 * composite supply whose principal supply is the treatment. Charging tax on
 * them means the hospital remitted tax it did not owe AND understated its
 * exempt turnover, which then under-reverses input credit under Rule 42. Both
 * errors run in the hospital's disfavour, which is why it is worth finding
 * them rather than leaving them.
 *
 * DELIBERATELY A LIST, NOT A FIX. The owner's own answer to question 3 was
 * "apply the approved IP treatment to NEW bills; don't alter old bills
 * automatically" — a paid bill in a filed period cannot be quietly recomputed,
 * and the correction is a credit note the hospital chooses to raise.
 */
export async function getHistoricIpMedicineTax(tenantId: string, query: SalesReportQuery = {}) {
  const { from, to } = dateRange(query);

  const rows = await prisma.billItem.findMany({
    where: {
      bill: {
        tenantId,
        status: { not: 'draft' },
        // An IP bill: one raised against an admission.
        admissionId: { not: null },
        ...(from || to
          ? { billDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      category: { in: ['pharmacy', 'consumable'] as never },
      taxAmount: { gt: 0 },
    },
    select: {
      id: true, description: true, category: true, quantity: true,
      taxPercent: true, taxableValue: true, taxAmount: true, totalAmount: true,
      gstTreatment: true, rateSource: true,
      bill: {
        select: {
          id: true, billNumber: true, invoiceNumber: true, billDate: true,
          status: true, admissionId: true,
          patient: { select: { mrn: true, firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { bill: { billDate: 'asc' } },
  });

  const byBill = new Map<
    string,
    {
      billId: string; billNumber: string; invoiceNumber: string | null;
      billDate: Date; billStatus: string; admissionId: string | null;
      patientName: string | null; mrn: string | null;
      lines: number; taxCharged: number; taxableValue: number;
    }
  >();
  for (const r of rows) {
    const b = r.bill!;
    const cur = byBill.get(b.id) ?? {
      billId: b.id,
      billNumber: b.billNumber,
      invoiceNumber: b.invoiceNumber,
      billDate: b.billDate,
      billStatus: String(b.status),
      admissionId: b.admissionId,
      patientName: b.patient ? fullName(b.patient) : null,
      mrn: b.patient?.mrn ?? null,
      lines: 0,
      taxCharged: 0,
      taxableValue: 0,
    };
    cur.lines += 1;
    cur.taxCharged = n(cur.taxCharged + n(r.taxAmount));
    cur.taxableValue = n(cur.taxableValue + n(r.taxableValue));
    byBill.set(b.id, cur);
  }

  const bills = [...byBill.values()].sort((a, b) => b.taxCharged - a.taxCharged);
  const taxCharged = n(rows.reduce((t, r) => t + n(r.taxAmount), 0));

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    bills,
    lines: rows.map((r) => ({
      itemId: r.id,
      billNumber: r.bill?.billNumber ?? null,
      invoiceNumber: r.bill?.invoiceNumber ?? null,
      billDate: r.bill?.billDate ?? null,
      description: r.description,
      category: String(r.category),
      quantity: r.quantity,
      ratePercent: n(r.taxPercent),
      taxableValue: n(r.taxableValue),
      taxCharged: n(r.taxAmount),
      total: n(r.totalAmount),
      treatment: r.gstTreatment,
      rateSource: r.rateSource,
    })),
    totals: {
      bills: bills.length,
      lines: rows.length,
      taxCharged,
      /**
       * The exempt turnover these lines should have carried. It was reported as
       * taxable, so the Rule 42 exempt ratio is understated by this much and
       * the hospital has been keeping input credit it was not entitled to.
       */
      understatedExemptTurnover: n(rows.reduce((t, r) => t + n(r.taxableValue), 0)),
      /** Already issued as a document, so a correction has to be a credit note. */
      issued: bills.filter((b) => !!b.invoiceNumber).length,
    },
    notes: [
      'Medicines and consumables used ON an admitted patient are an exempt composite supply — the medicine follows the treatment. Tax charged on them was remitted but never owed.',
      'The second cost is quieter: the same value was reported as TAXABLE turnover, so the Rule 42 exempt ratio is understated and input credit has been over-retained. Both errors run against the hospital.',
      'This is a list, not a fix. A paid bill is not quietly recomputed — the correction is a credit note, and whether to raise one is the hospital and its auditor’s decision.',
    ],
  };
}

/**
 * C-4 — Document Series Continuity. The one an auditor asks for on day one.
 *
 * For each series and financial year: the first and last number issued, how
 * many, and every number that is MISSING or DUPLICATED. A hole is not proof of
 * anything wrong, but it is always a question, and the hospital should be the
 * one holding the answer.
 *
 * The counter is checked too: a series whose counter has run ahead of the last
 * issued number has burned numbers somewhere — usually a transaction that
 * allotted one and then rolled back.
 */
export async function getSeriesContinuity(tenantId: string, query: { financialYear?: string } = {}) {
  const [series, bills, notes, vouchers] = await Promise.all([
    prisma.gstDocumentSeries.findMany({
      where: { tenantId, ...(query.financialYear ? { financialYear: query.financialYear } : {}) },
      orderBy: [{ financialYear: 'asc' }, { documentType: 'asc' }],
    }),
    prisma.bill.findMany({
      where: {
        tenantId,
        invoiceNumber: { not: null },
        ...(query.financialYear ? { financialYear: query.financialYear } : {}),
      },
      select: { invoiceNumber: true, billOfSupplyNumber: true, gstDocumentType: true, financialYear: true, status: true, billDate: true, cancellationReason: true },
    }),
    prisma.creditNote.findMany({
      where: { tenantId, ...(query.financialYear ? { financialYear: query.financialYear } : {}) },
      select: { creditNoteNumber: true, financialYear: true, issueDate: true },
    }),
    // Rule 50 receipt vouchers and Rule 51 refund vouchers. These are numbered
    // out of the same series table as invoices, but they live on the PAYMENT,
    // not on a bill — so a report reading only bills and credit notes found no
    // document at all against those two series and declared every number in
    // them burned. An auditor opening this would have been told the hospital
    // had lost its entire advance-voucher run.
    prisma.payment.findMany({
      where: { tenantId, voucherNumber: { not: null } },
      select: { voucherNumber: true, voucherType: true, paymentDate: true },
    }),
  ]);

  /** "INV/2026-27/000004" → 4. The sequence is the last path segment. */
  const seqOf = (docNumber: string): number | null => {
    const tail = docNumber.split('/').pop() ?? '';
    const num = Number(tail);
    return Number.isFinite(num) ? num : null;
  };

  const issued = new Map<string, Array<{ number: string; seq: number; status: string; date: Date; note: string | null }>>();
  const push = (documentType: string, financialYear: string | null, number: string, status: string, date: Date, note: string | null) => {
    const seq = seqOf(number);
    if (seq == null) return;
    const key = `${documentType}:${financialYear ?? '-'}`;
    const list = issued.get(key) ?? [];
    list.push({ number, seq, status, date, note });
    issued.set(key, list);
  };
  for (const b of bills) {
    push(b.gstDocumentType ?? 'unknown', b.financialYear, b.invoiceNumber!, String(b.status), b.billDate, b.cancellationReason);
    // Rule 46A's second document draws from the bill_of_supply series. Without
    // this every one of them would read as a burned number there, which is the
    // same mistake the advance vouchers used to produce.
    if (b.billOfSupplyNumber) {
      push('bill_of_supply', b.financialYear, b.billOfSupplyNumber, String(b.status), b.billDate, b.cancellationReason);
    }
  }
  for (const c of notes) {
    push('credit_note', c.financialYear, c.creditNoteNumber, 'issued', c.issueDate, null);
  }
  for (const v of vouchers) {
    // Guarded rather than asserted. The query filters on `voucherNumber: { not:
    // null }`, but a report must not fall over if a row without one reaches it —
    // and a series continuity report crashing is worse than one row missing.
    if (!v.voucherNumber) continue;
    // A voucher carries no financial-year column of its own; the year is in the
    // number it was allotted ("RV/2026-27/000004").
    const fy = v.voucherNumber.split('/')[1] ?? null;
    push(String(v.voucherType ?? 'receipt_voucher'), fy, v.voucherNumber, 'issued', v.paymentDate, null);
  }

  const rows = series.map((s) => {
    const key = `${s.documentType}:${s.financialYear}`;
    const list = (issued.get(key) ?? []).sort((a, b) => a.seq - b.seq);
    const seen = new Map<number, number>();
    for (const d of list) seen.set(d.seq, (seen.get(d.seq) ?? 0) + 1);

    const first = list[0]?.seq ?? null;
    const last = list[list.length - 1]?.seq ?? null;
    const missing: number[] = [];
    if (first != null && last != null) {
      for (let i = first; i <= last; i += 1) if (!seen.has(i)) missing.push(i);
    }
    const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([seq]) => seq);

    return {
      documentType: s.documentType,
      financialYear: s.financialYear,
      prefix: s.prefix,
      /** Where the counter stands. Numbers are allotted from it, one at a time. */
      counter: s.lastNumber,
      firstIssued: first,
      lastIssued: last,
      issuedCount: list.length,
      missing,
      duplicated,
      /**
       * The counter has gone past the last number on a document. Each gap is a
       * number that was allotted inside a transaction that then rolled back —
       * explainable, but it has to be explained.
       */
      burned: last != null ? Math.max(0, s.lastNumber - last) : s.lastNumber,
      cancelled: list
        .filter((d) => d.status === 'cancelled')
        .map((d) => ({ number: d.number, date: d.date, reason: d.note })),
      continuous: missing.length === 0 && duplicated.length === 0,
    };
  });

  return {
    financialYear: query.financialYear ?? null,
    series: rows,
    totals: {
      series: rows.length,
      withGaps: rows.filter((r) => r.missing.length > 0).length,
      withDuplicates: rows.filter((r) => r.duplicated.length > 0).length,
      burned: rows.reduce((t, r) => t + r.burned, 0),
    },
  };
}

/**
 * C-7 — Department-wise GST. Tax by pharmacy, lab, radiology, OT, room.
 *
 * The same fold A-2 does by department, given its own report because this is a
 * management question rather than a filing one, and it is asked far more often.
 */
export async function getDepartmentGst(tenantId: string, query: SalesReportQuery = {}) {
  const { period, rows } = await getSalesRegister(tenantId, query);

  const m = new Map<string, typeof rows>();
  for (const l of rows) {
    const list = m.get(l.department) ?? [];
    list.push(l);
    m.set(l.department, list);
  }

  return {
    period,
    departments: [...m]
      .map(([department, lines]) => {
        const taxable = lines.filter((l) => l.gstTreatment === 'taxable');
        return {
          department,
          ...totalOf(lines),
          taxableTurnover: r2(taxable.reduce((t, l) => t + l.taxableValue, 0)),
          exemptTurnover: r2(
            lines
              .filter((l) => l.gstTreatment && l.gstTreatment !== 'taxable')
              .reduce((t, l) => t + l.taxableValue, 0),
          ),
        };
      })
      .sort((a, b) => b.taxAmount - a.taxAmount || b.totalAmount - a.totalAmount),
    totals: totalOf(rows),
  };
}

/**
 * C-9 — Cancelled and Amended Invoices.
 *
 * A cancelled invoice keeps its number and is reversed by a credit note; that
 * is what section 34 requires and what keeps the series continuous. So the
 * question this answers is not "which numbers vanished" but "which issued
 * documents were undone, by whom, and was the note actually raised".
 *
 * A cancelled bill with NO credit note against it is the exception worth
 * finding: the money came off, the tax did not, and the return still declares
 * it.
 */
export async function getCancelledInvoices(tenantId: string, query: SalesReportQuery = {}) {
  const { from, to } = dateRange(query);

  const bills = await prisma.bill.findMany({
    where: {
      tenantId,
      status: 'cancelled',
      // Filtered on when it was CANCELLED, not when it was raised.
      //
      // This asked for `billDate`, which is a different month more often than
      // not: three invoices in this database were raised in July and cancelled
      // in September. They appeared in July's report — where the cancellation
      // had not happened yet — and were missing from September's, which is the
      // month the reversal belongs to. An auditor asking "what did you cancel
      // in September" got the wrong answer both ways.
      //
      // A bill cancelled before `cancelled_at` existed falls back to the date
      // it was raised, which is the only date it has.
      ...(from || to
        ? {
            OR: [
              { cancelledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
              {
                cancelledAt: null,
                billDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
              },
            ],
          }
        : {}),
    },
    orderBy: { billDate: 'asc' },
    select: {
      id: true, billNumber: true, invoiceNumber: true, gstDocumentType: true,
      billDate: true, cancelledAt: true, totalAmount: true, taxAmount: true, cancellationReason: true,
      taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true,
      updatedAt: true,
      canceller: { select: { firstName: true, lastName: true } },
      patient: { select: { mrn: true, firstName: true, lastName: true } },
      creditNotes: {
        select: {
          creditNoteNumber: true, noteType: true, taxableValue: true, cgstAmount: true,
          sgstAmount: true, igstAmount: true, taxAmount: true, totalAmount: true,
        },
      },
    },
  });

  const rows = bills.map((b) => {
    // Gap 268: voiding a pharmacy sale deletes or zeroes its lines, so the bill
    // itself reads ₹0 / ₹0 once cancelled. The credit note that reversed it
    // still holds what was invoiced (stored negative), so the register shows
    // the larger of the two — the bill's own figure when it kept one, the
    // reversal's when the bill was zeroed. Debit notes are not reversals.
    const credits = b.creditNotes.filter((c) => (c.noteType ?? 'credit') === 'credit');
    const reversed = (k: 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'taxAmount' | 'totalAmount') =>
      r2(Math.abs(credits.reduce((t, c) => t + n(c[k]), 0)));
    const useNotes = credits.length > 0 && reversed('totalAmount') > Math.abs(n(b.totalAmount));
    const pick = (k: 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'taxAmount' | 'totalAmount') =>
      useNotes ? reversed(k) : n(b[k]);
    return {
      billId: b.id,
      billNumber: b.billNumber,
      invoiceNumber: b.invoiceNumber,
      documentType: b.gstDocumentType,
      billDate: b.billDate,
      // The real date where we have it; the row's last touch only as a
      // fallback for a bill cancelled before the column existed.
      cancelledAt: b.cancelledAt ?? b.updatedAt,
      cancelledBy: b.canceller ? fullName(b.canceller) : null,
      reason: b.cancellationReason,
      patientName: b.patient ? fullName(b.patient) : null,
      mrn: b.patient?.mrn ?? null,
      totalAmount: pick('totalAmount'),
      taxableValue: pick('taxableValue'),
      cgstAmount: pick('cgstAmount'),
      sgstAmount: pick('sgstAmount'),
      igstAmount: pick('igstAmount'),
      taxAmount: pick('taxAmount'),
      /** Where the value came from: the bill, or the credit note when the bill was zeroed. */
      valueSource: useNotes ? ('credit_note' as const) : ('bill' as const),
      creditNotes: b.creditNotes.map((c) => ({
        creditNoteNumber: c.creditNoteNumber,
        noteType: c.noteType,
        taxableValue: r2(Math.abs(n(c.taxableValue))),
        taxAmount: r2(Math.abs(n(c.taxAmount))),
        totalAmount: r2(Math.abs(n(c.totalAmount))),
      })),
      /** Issued, cancelled, and never reversed. The tax is still declared. */
      unreversed: !!b.invoiceNumber && credits.length === 0,
    };
  });

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows,
    totals: {
      count: rows.length,
      taxableValue: r2(rows.reduce((t, r) => t + r.taxableValue, 0)),
      taxAmount: r2(rows.reduce((t, r) => t + r.taxAmount, 0)),
      totalAmount: r2(rows.reduce((t, r) => t + r.totalAmount, 0)),
      /** The exception: cancelled after issue, with no credit note behind it. */
      unreversed: rows.filter((r) => r.unreversed).length,
    },
  };
}

/**
 * C-5 — Rate Override Log.
 *
 * Every line where a rate was TYPED rather than resolved: taxable, on an item
 * nobody approved, with no HSN or SAC behind it. That is somebody at a counter
 * deciding what tax the patient pays, and it is the first thing an auditor
 * pulls on.
 *
 * Two honest limits, stated in the report rather than papered over:
 *
 *   - WHO is the person who raised the document, not provably the person who
 *     typed the rate. A bill line carries no author of its own. On a counter
 *     bill they are the same person; on a ward ledger the raiser is the one
 *     accountable for the bill.
 *   - WHY is not recorded at all. Capturing it means asking for a reason at the
 *     counter, which changes what staff have to do, so it is not added here
 *     without the hospital agreeing to it.
 *
 * What IS provable is the rest: which line, on which document, at what rate,
 * for how much tax, and which rule the engine would otherwise have used.
 */
export async function getRateOverrides(tenantId: string, query: SalesReportQuery = {}) {
  const [{ period, rows }, itemChanges, itemVsMaster, billedVsItem] = await Promise.all([
    getSalesRegister(tenantId, query),
    // Gap item 279: the three places a rate is actually overridden today.
    getItemRateChanges(tenantId, query),
    getItemVsMasterDifferences(tenantId).catch(() => []),
    getBilledVsItemDifferences(tenantId, query).catch(() => []),
  ]);
  const overrides = rows.filter((l) => l.requiresTaxResolution);

  const byPerson = new Map<string, { lines: number; taxCharged: number; value: number }>();
  for (const l of overrides) {
    const key = l.raisedBy ?? 'unattributed';
    const cur = byPerson.get(key) ?? { lines: 0, taxCharged: 0, value: 0 };
    cur.lines += 1;
    cur.taxCharged = r2(cur.taxCharged + l.taxAmount);
    cur.value = r2(cur.value + l.totalAmount);
    byPerson.set(key, cur);
  }

  return {
    period,
    rows: overrides.map((l) => ({
      billDate: l.billDate,
      document: l.invoiceNumber ?? l.billNumber,
      billNumber: l.billNumber,
      patientName: l.patientName,
      department: l.department,
      description: l.description,
      ratePercent: l.taxRatePercent,
      taxAmount: l.taxAmount,
      totalAmount: l.totalAmount,
      /** The rule the engine settled on — 'item_master' means a typed rate. */
      rateSource: l.rateSource,
      raisedBy: l.raisedBy,
    })),
    byPerson: [...byPerson.entries()]
      .map(([person, v]) => ({ person, ...v }))
      .sort((a, b) => b.taxCharged - a.taxCharged || b.lines - a.lines),
    /** Changes made to an item's rate, code or treatment in the period — who, when, why. */
    itemChanges,
    /** Items whose own rate differs from their HSN / SAC master: an item-level override. */
    itemVsMaster,
    /** Lines billed at a rate different from the item's rate. */
    billedVsItem,
    totals: {
      linesChecked: rows.length,
      overrides: overrides.length,
      taxCharged: r2(overrides.reduce((t, l) => t + l.taxAmount, 0)),
      value: r2(overrides.reduce((t, l) => t + l.totalAmount, 0)),
      itemChanges: itemChanges.length,
      itemVsMaster: itemVsMaster.length,
      billedVsItem: billedVsItem.length,
    },
    notes: [
      'Finalising a bill now REFUSES a line with no GST classification, so a new typed rate cannot reach a finalised bill. Typed-rate lines below are legacy.',
      'Item changes are logged from the day the log was added: every change to a service tariff or formulary drug\u2019s rate, HSN/SAC or treatment, with the user and time. A reason is recorded where the save sends one; otherwise the screen it came from is named.',
      'Item vs master compares each item with its HSN / SAC master as they stand today. A difference is an item-level override and should be one the auditor approved.',
      'Billed vs item compares each line with the item as it stands today, so a line billed before a logged change appears here too — check it against the change log.',
      '"Raised by" is the person who raised the document, not provably the person who typed the rate — a bill line carries no author of its own.',
    ],
  };
}

/**
 * C-8 — Rate Change Impact.
 *
 * What changed on a tax master, when, by whom — and, for each change, the bill
 * lines that carried that code either side of it. "Which items were affected"
 * is answered with rows rather than an estimate: the lines are counted from the
 * register, split at the moment of the change.
 *
 * Why the split matters. A line billed BEFORE the change keeps the rate that
 * applied on the day — that is the whole point of freezing the tax onto the
 * line — so it is not restated. A line billed AFTER carries the new one. If
 * lines after a change still carry the old rate, the masters and the bills have
 * fallen out of step, and that is the finding worth having.
 *
 * The log is platform-wide, because a change to HSN 3004 changes it for every
 * hospital at once. The IMPACT is scoped to this hospital's own bills.
 */
export async function getRateChangeImpact(
  tenantId: string,
  query: { from?: string; to?: string } = {},
) {
  const { from, to } = dateRange(query);

  const [changes, itemChanges, itemVsMaster] = await Promise.all([
    prisma.gstRateChange.findMany({
      where: {
        ...(from || to ? { changedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { changedAt: 'desc' },
      include: { changer: { select: { firstName: true, lastName: true } } },
    }),
    // Gap item 279: the hospital's own item changes, not only the masters.
    getItemRateChanges(tenantId, query),
    getItemVsMasterDifferences(tenantId).catch(() => []),
  ]);
  const itemImpact = await itemChangeImpact(tenantId, itemChanges);

  if (changes.length === 0) {
    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      changes: [],
      itemChanges: itemImpact,
      itemVsMaster,
      totals: {
        changes: 0, linesAffected: itemImpact.reduce((t, r) => t + r.linesBefore.count + r.linesAfter.count, 0),
        outOfStep: itemImpact.reduce((t, r) => t + r.outOfStep.length, 0),
        itemChanges: itemImpact.length, itemVsMaster: itemVsMaster.length,
      },
      notes: [
        ...(itemImpact.length ? [] : ['Nothing on a tax master or an item changed in this period.']),
        'Both logs start from the day they were added — a rate that moved before then is not in them.',
      ],
    };
  }

  // One pass over the affected lines rather than a query per change.
  const codes = [...new Set(changes.map((c) => c.code))];
  const lines = await prisma.billItem.findMany({
    where: {
      hsnSacCode: { in: codes },
      bill: { tenantId, status: { not: 'draft' } },
    },
    select: {
      hsnSacCode: true, taxPercent: true, taxAmount: true, totalAmount: true,
      description: true, createdAt: true,
      bill: { select: { billNumber: true, invoiceNumber: true, billDate: true } },
    },
  });

  const byCode = new Map<string, typeof lines>();
  for (const l of lines) {
    const key = l.hsnSacCode!;
    const list = byCode.get(key) ?? [];
    list.push(l);
    byCode.set(key, list);
  }

  const rows = changes.map((c) => {
    const affected = byCode.get(c.code) ?? [];
    const before = affected.filter((l) => l.createdAt < c.changedAt);
    const after = affected.filter((l) => l.createdAt >= c.changedAt);
    const newRate = c.newRate == null ? null : Number(c.newRate);
    // Billed after the change but still carrying the old rate. The masters and
    // the bills have fallen out of step, and this is the finding.
    const outOfStep =
      newRate == null ? [] : after.filter((l) => Number(l.taxPercent) !== newRate);

    const sum = (list: typeof affected, pick: (l: (typeof affected)[number]) => number) =>
      r2(list.reduce((t, l) => t + pick(l), 0));

    return {
      id: c.id,
      changedAt: c.changedAt,
      changedBy: c.changer ? fullName(c.changer) : null,
      codeType: c.codeType,
      code: c.code,
      description: c.description,
      action: c.action,
      previousRate: c.previousRate == null ? null : Number(c.previousRate),
      newRate,
      previousTreatment: c.previousTreatment,
      newTreatment: c.newTreatment,
      linesBefore: {
        count: before.length,
        taxCharged: sum(before, (l) => Number(l.taxAmount)),
        value: sum(before, (l) => Number(l.totalAmount)),
      },
      linesAfter: {
        count: after.length,
        taxCharged: sum(after, (l) => Number(l.taxAmount)),
        value: sum(after, (l) => Number(l.totalAmount)),
      },
      outOfStep: outOfStep.map((l) => ({
        billNumber: l.bill?.invoiceNumber ?? l.bill?.billNumber ?? null,
        billDate: l.bill?.billDate ?? null,
        description: l.description,
        ratePercent: Number(l.taxPercent),
        taxAmount: Number(l.taxAmount),
      })),
    };
  });

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    changes: rows,
    itemChanges: itemImpact,
    itemVsMaster,
    totals: {
      changes: rows.length,
      linesAffected: rows.reduce((t, r) => t + r.linesBefore.count + r.linesAfter.count, 0)
        + itemImpact.reduce((t, r) => t + r.linesBefore.count + r.linesAfter.count, 0),
      outOfStep: rows.reduce((t, r) => t + r.outOfStep.length, 0)
        + itemImpact.reduce((t, r) => t + r.outOfStep.length, 0),
      itemChanges: itemImpact.length,
      itemVsMaster: itemVsMaster.length,
    },
    notes: [
      'A line billed BEFORE a change keeps the rate that applied on the day — that is what freezing the tax onto the line is for, and it is not restated here.',
      'A line billed AFTER a change that still carries the old rate is listed as out of step: the masters and the bills have parted company.',
      'This log starts from the day it was added — a rate that moved before then is not in it.',
    ],
  };
}


/**
 * For each logged ITEM change, the bill lines for that item either side of it
 * (gap item 279). Services are matched on the tariff the line billed; drugs on
 * the formulary drug behind the dispensing record.
 */
async function itemChangeImpact(
  tenantId: string,
  changes: Awaited<ReturnType<typeof getItemRateChanges>>,
) {
  if (changes.length === 0) return [];
  const serviceIds = [...new Set(changes.filter((c) => c.itemType === 'service').map((c) => c.itemId))];
  const drugIds = [...new Set(changes.filter((c) => c.itemType === 'drug').map((c) => c.itemId))];
  const select = {
    taxPercent: true, taxAmount: true, totalAmount: true, description: true, createdAt: true,
    serviceTariffId: true, referenceId: true,
    bill: { select: { billNumber: true, invoiceNumber: true, billDate: true } },
  } as const;
  const [serviceLines, drugRecs] = await Promise.all([
    serviceIds.length
      ? prisma.billItem.findMany({
          where: { serviceTariffId: { in: serviceIds }, bill: { tenantId, status: { not: 'draft' } } },
          select,
        })
      : Promise.resolve([]),
    drugIds.length
      ? prisma.dispensingRecord.findMany({
          where: { tenantId, drugBatch: { drugId: { in: drugIds } } },
          select: { id: true, drugBatch: { select: { drugId: true } } },
        })
      : Promise.resolve([]),
  ]);
  const drugOfRec = new Map((drugRecs ?? []).map((r) => [r.id, r.drugBatch?.drugId ?? null]));
  const drugLines = drugOfRec.size
    ? await prisma.billItem.findMany({
        where: {
          referenceType: 'dispensing_record', referenceId: { in: [...drugOfRec.keys()] },
          bill: { tenantId, status: { not: 'draft' } },
        },
        select,
      })
    : [];
  type Line = (typeof serviceLines)[number];
  const linesFor = (c: (typeof changes)[number]): Line[] =>
    c.itemType === 'service'
      ? (serviceLines ?? []).filter((l) => l.serviceTariffId === c.itemId)
      : (drugLines ?? []).filter((l) => l.referenceId && drugOfRec.get(l.referenceId) === c.itemId);
  const sum = (list: Line[], pick: (l: Line) => number) => r2(list.reduce((t, l) => t + pick(l), 0));

  return changes.map((c) => {
    const affected = linesFor(c);
    const before = affected.filter((l) => l.createdAt < c.changedAt);
    const after = affected.filter((l) => l.createdAt >= c.changedAt);
    const outOfStep = c.newRate == null ? [] : after.filter((l) => Number(l.taxPercent) !== c.newRate);
    return {
      ...c,
      linesBefore: { count: before.length, taxCharged: sum(before, (l) => Number(l.taxAmount)), value: sum(before, (l) => Number(l.totalAmount)) },
      linesAfter: { count: after.length, taxCharged: sum(after, (l) => Number(l.taxAmount)), value: sum(after, (l) => Number(l.totalAmount)) },
      outOfStep: outOfStep.map((l) => ({
        billNumber: l.bill?.invoiceNumber ?? l.bill?.billNumber ?? null,
        billDate: l.bill?.billDate ?? null,
        description: l.description,
        ratePercent: Number(l.taxPercent),
        taxAmount: Number(l.taxAmount),
      })),
    };
  });
}
