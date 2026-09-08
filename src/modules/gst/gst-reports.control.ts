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

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import { getSalesRegister, totalOf, type SalesReportQuery } from './gst-reports.sales';

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

  const payments = await prisma.payment.findMany({
    where: {
      tenantId,
      status: 'completed',
      ...(from || to ? { paymentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { paymentDate: 'asc' },
    select: {
      id: true, paymentDate: true, amount: true, paymentMethod: true,
      paymentType: true, paymentSource: true,
      processor: { select: { firstName: true, lastName: true } },
      bill: { select: { id: true, billNumber: true, totalAmount: true, taxAmount: true } },
    },
  });

  const rows = payments.map((p) => {
    const amount = n(p.amount);
    const billTotal = n(p.bill?.totalAmount);
    const billTax = n(p.bill?.taxAmount);
    // The payment's share of the bill's tax. A refund carries its share back.
    const share = billTotal > 0 ? Math.min(1, amount / billTotal) : 0;
    const taxShare = r2(billTax * share) * (p.paymentType === 'refund' ? -1 : 1);
    return {
      paymentId: p.id,
      date: p.paymentDate,
      day: p.paymentDate.toISOString().slice(0, 10),
      amount: p.paymentType === 'refund' ? -amount : amount,
      method: String(p.paymentMethod),
      type: String(p.paymentType),
      counter: p.paymentSource ? String(p.paymentSource) : 'unknown',
      cashier: p.processor ? fullName(p.processor) : null,
      billNumber: p.bill?.billNumber ?? null,
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
  const { period, rows } = await getSalesRegister(tenantId, query);

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

  return {
    period,
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
      select: { invoiceNumber: true, gstDocumentType: true, financialYear: true, status: true, billDate: true, cancellationReason: true },
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
  }
  for (const c of notes) {
    push('credit_note', c.financialYear, c.creditNoteNumber, 'issued', c.issueDate, null);
  }
  for (const v of vouchers) {
    // A voucher carries no financial-year column of its own; the year is in the
    // number it was allotted ("RV/2026-27/000004").
    const fy = v.voucherNumber!.split('/')[1] ?? null;
    push(String(v.voucherType ?? 'receipt_voucher'), fy, v.voucherNumber!, 'issued', v.paymentDate, null);
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
      updatedAt: true,
      canceller: { select: { firstName: true, lastName: true } },
      patient: { select: { mrn: true, firstName: true, lastName: true } },
      creditNotes: { select: { creditNoteNumber: true, taxAmount: true, totalAmount: true } },
    },
  });

  const rows = bills.map((b) => ({
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
    totalAmount: n(b.totalAmount),
    taxAmount: n(b.taxAmount),
    creditNotes: b.creditNotes.map((c) => ({
      creditNoteNumber: c.creditNoteNumber,
      taxAmount: n(c.taxAmount),
      totalAmount: n(c.totalAmount),
    })),
    /** Issued, cancelled, and never reversed. The tax is still declared. */
    unreversed: !!b.invoiceNumber && b.creditNotes.length === 0,
  }));

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    rows,
    totals: {
      count: rows.length,
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
  const { period, rows } = await getSalesRegister(tenantId, query);
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
    totals: {
      linesChecked: rows.length,
      overrides: overrides.length,
      taxCharged: r2(overrides.reduce((t, l) => t + l.taxAmount, 0)),
      value: r2(overrides.reduce((t, l) => t + l.totalAmount, 0)),
    },
    notes: [
      'Finalising a bill now REFUSES a line with no GST classification, so a new override cannot reach a finalised bill. What appears here is legacy — lines billed before that gate existed.',
      '"Raised by" is the person who raised the document, not provably the person who typed the rate — a bill line carries no author of its own.',
      'No reason is recorded against an override. Capturing one means asking for it at the counter, which changes what staff have to do.',
      'Fix an override at its source: give the item an HSN or SAC code, or have its rate approved on the service tariff. Both are in the Unmapped Items report.',
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

  const changes = await prisma.gstRateChange.findMany({
    where: {
      ...(from || to ? { changedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { changedAt: 'desc' },
    include: { changer: { select: { firstName: true, lastName: true } } },
  });

  if (changes.length === 0) {
    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      changes: [],
      totals: { changes: 0, linesAffected: 0, outOfStep: 0 },
      notes: [
        'Nothing on a tax master changed in this period.',
        'This log starts from the day it was added — a rate that moved before then is not in it.',
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
    totals: {
      changes: rows.length,
      linesAffected: rows.reduce((t, r) => t + r.linesBefore.count + r.linesAfter.count, 0),
      outOfStep: rows.reduce((t, r) => t + r.outOfStep.length, 0),
    },
    notes: [
      'A line billed BEFORE a change keeps the rate that applied on the day — that is what freezing the tax onto the line is for, and it is not restated here.',
      'A line billed AFTER a change that still carries the old rate is listed as out of step: the masters and the bills have parted company.',
      'This log starts from the day it was added — a rate that moved before then is not in it.',
    ],
  };
}

