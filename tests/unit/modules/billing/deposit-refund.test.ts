import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  refundDeposit,
  recalculateBillTotalsPublic,
  getAdmissionAdvanceBalance,
  getAdmissionLedger,
  receivableSplit,
} from '../../../../src/modules/billing/billing.service';
import { getBillBalanceBreakdowns } from '../../../../src/modules/billing/bill-payment-ledger';

// ---------------------------------------------------------------------------
// Gap items 335 / 340 / 286 / 283 — returning an UNUSED deposit must never move
// a bill the deposit settled.
//
// The refund path touches bills, payments, refunds and the deposit pool across
// a dozen queries, so it runs against a tiny in-memory store rather than a
// stack of call-order mocks: the assertion is about where the money ends up,
// not about which query ran first.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const TENANT = 't-1';
const ACTOR = { userId: 'u-1', roles: ['billing_admin'] };

let db: Record<string, Row[]>;
let seq = 0;

// Relation filters the billing queries use, as `field → [table, foreign key]`.
const RELATIONS: Record<string, Record<string, [string, string]>> = {
  payment: { bill: ['bill', 'billId'] },
  refund: { payment: ['payment', 'paymentId'], bill: ['bill', 'billId'] },
};

function matchField(val: unknown, cond: any): boolean {
  if (cond === null) return val == null;
  if (typeof cond !== 'object' || cond instanceof Date) return val === cond;
  if ('in' in cond && !cond.in.includes(val)) return false;
  if ('notIn' in cond && cond.notIn.includes(val)) return false;
  if ('startsWith' in cond && !(typeof val === 'string' && val.startsWith(cond.startsWith))) return false;
  if ('gt' in cond && !(Number(val) > cond.gt)) return false;
  if ('not' in cond) {
    const n = cond.not;
    if (n !== null && typeof n === 'object') {
      if (matchField(val, n)) return false;
    } else if (val === n) return false;
  }
  return true;
}

function matches(table: string, row: Row, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (k === 'OR') { if (!(v as any[]).some((w) => matches(table, row, w))) return false; continue; }
    if (k === 'AND') { if (!(v as any[]).every((w) => matches(table, row, w))) return false; continue; }
    if (k === 'NOT') {
      const list = Array.isArray(v) ? v : [v];
      if (list.some((w) => matches(table, row, w))) return false;
      continue;
    }
    const rel = RELATIONS[table]?.[k];
    if (rel) {
      const related = db[rel[0]].find((r) => r.id === row[rel[1]]);
      if (!related || !matches(rel[0], related, v)) return false;
      continue;
    }
    if (!matchField(row[k], v)) return false;
  }
  return true;
}

function withIncludes(table: string, row: Row, args: any): Row {
  const out = { ...row };
  const inc = { ...(args?.include ?? {}), ...(args?.select ?? {}) };
  if (table === 'bill' && inc.billItems) out.billItems = db.billItem.filter((i) => i.billId === row.id);
  if (table === 'payment' && inc.refunds) {
    out.refunds = db.refund.filter((r) => r.paymentId === row.id && matches('refund', r, inc.refunds.where));
  }
  return out;
}

function wireTable(table: string) {
  const m = (prisma as any)[table];
  const find = (args: any) => db[table].filter((r) => matches(table, r, args?.where));
  m.findMany.mockImplementation(async (args: any) => find(args).map((r) => withIncludes(table, r, args)));
  m.findFirst.mockImplementation(async (args: any) => {
    const r = find(args)[0];
    return r ? withIncludes(table, r, args) : null;
  });
  m.findUnique.mockImplementation(async (args: any) => {
    const r = find(args)[0];
    return r ? withIncludes(table, r, args) : null;
  });
  m.count.mockImplementation(async (args: any) => find(args).length);
  m.aggregate.mockImplementation(async (args: any) => {
    const rows = find(args);
    const _sum: Row = {};
    for (const k of Object.keys(args?._sum ?? {})) _sum[k] = rows.length ? rows.reduce((s, r) => s + Number(r[k] ?? 0), 0) : null;
    return { _sum, _count: { _all: rows.length } };
  });
  m.groupBy.mockImplementation(async (args: any) => {
    const groups = new Map<string, Row[]>();
    for (const r of find(args)) {
      const key = args.by.map((b: string) => r[b]).join('|');
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].map((rows) => {
      const _sum: Row = {};
      for (const k of Object.keys(args?._sum ?? {})) _sum[k] = rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
      return { ...Object.fromEntries(args.by.map((b: string) => [b, rows[0][b]])), _sum };
    });
  });
  m.create.mockImplementation(async (args: any) => {
    const row = { id: `${table}-${++seq}`, createdAt: new Date(), ...args.data };
    db[table].push(row);
    return row;
  });
  m.update.mockImplementation(async (args: any) => {
    const row = find(args)[0];
    if (!row) throw new Error(`${table} not found`);
    for (const [k, v] of Object.entries(args.data)) {
      row[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? Number(row[k] ?? 0) + (v as Row).increment : v;
    }
    return row;
  });
}

function seed() {
  seq = 0;
  db = { admission: [], bill: [], billItem: [], payment: [], refund: [], discount: [], receipt: [] };
  db.admission.push({ id: 'adm-1', tenantId: TENANT, patientId: 'p-1', depositAmount: 1_000, visitId: null, billingCategory: 'cash', admissionDate: new Date() });
  // The patient's ADV- holding bill: the deposit RECEIPT lives here.
  db.bill.push({ id: 'adv-1', tenantId: TENANT, patientId: 'p-1', billNumber: 'ADV-p1-1', status: 'pending', totalAmount: 0, amountPaid: 0, balanceDue: 0, admissionId: null, insuranceCoveredAmount: 0, patientPayableAmount: 0, discountAmount: 0, createdAt: new Date() });
  db.payment.push({ id: 'rc-1', tenantId: TENANT, billId: 'adv-1', patientId: 'p-1', amount: 1_000, paymentType: 'advance', paymentMethod: 'cash', transactionId: 'IPDEPRCPT:adm-1', status: 'completed', paymentDate: new Date('2026-11-20T06:30:00Z'), voucherNumber: 'RV/000001', sourceAdvancePaymentId: null });
  // The final bill, settled in full from the deposit.
  db.bill.push({ id: 'bill-1', tenantId: TENANT, patientId: 'p-1', billNumber: 'IPW-20261120-0001', status: 'paid', totalAmount: 900, amountPaid: 900, balanceDue: 0, admissionId: 'adm-1', insuranceCoveredAmount: 0, patientPayableAmount: 0, discountAmount: 0, createdAt: new Date() });
  db.billItem.push({ id: 'item-1', billId: 'bill-1', quantity: 1, unitPrice: 900, discountAmount: 0, taxAmount: 0, totalAmount: 900, taxableValue: 900, description: 'Room', category: 'room', createdAt: new Date() });
  db.payment.push({ id: 'app-1', tenantId: TENANT, billId: 'bill-1', patientId: 'p-1', amount: 900, paymentType: 'advance', paymentMethod: 'advance', transactionId: 'IPDEP:adm-1', status: 'completed', paymentDate: new Date('2026-11-20T06:31:00Z'), sourceAdvancePaymentId: 'rc-1' });
  for (const t of Object.keys(db)) wireTable(t);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe('refundDeposit — unused deposit returned after the bill was settled from it', () => {
  it('deposit 1,000 → bill 900 settled from it → refund 100 → bill stays paid 900 / balance 0', async () => {
    const before = await getAdmissionLedger(TENANT, 'adm-1', ACTOR);
    expect(before.totals.refundable).toBe(100);

    await refundDeposit(TENANT, 'u-1', 'adm-1', ACTOR, { amount: 100 });

    // The refund hangs on the deposit RECEIPT, never on the applied row.
    const refunds = db.refund;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ paymentId: 'rc-1', billId: 'adv-1', amount: 100 });

    // And a full recalculation of the bill, the path that used to subtract the
    // refund, leaves it exactly as it was.
    await recalculateBillTotalsPublic('bill-1');
    const bill = db.bill.find((b) => b.id === 'bill-1')!;
    expect(bill).toMatchObject({ amountPaid: 900, balanceDue: 0, status: 'paid' });

    // Ledger, deposit pool and receivables agree: nothing owed, nothing more
    // to give back, nothing negative received.
    const after = await getAdmissionLedger(TENANT, 'adm-1', ACTOR);
    expect(after.totals.balanceAfterDeposit).toBe(0);
    expect(after.totals.refundable).toBe(0);
    expect(after.totals.depositRefunded).toBe(100);
    const pool = await getAdmissionAdvanceBalance(TENANT, 'adm-1');
    expect(pool).toMatchObject({ collected: 1_000, applied: 900, refunded: 100, available: 0 });

    const bd = (await getBillBalanceBreakdowns(prisma as never, [bill as never])).get('bill-1')!;
    expect(bd).toMatchObject({ advanceApplied: 900, refunds: 0, balance: 0 });

    // The refund voucher points at the receipt, so the advances register reads
    // received 1,000 / adjusted 900 / refunded 100 / held 0.
    const voucher = db.payment.find((p) => p.paymentType === 'refund');
    expect(voucher).toMatchObject({ sourceAdvancePaymentId: 'rc-1', amount: 100 });
  });

  it('takes only an OVERPAYMENT off a bill — the insurer covered what the deposit paid', async () => {
    Object.assign(db.bill.find((b) => b.id === 'bill-1')!, { insuranceCoveredAmount: 900, patientPayableAmount: 0 });

    await refundDeposit(TENANT, 'u-1', 'adm-1', ACTOR, { amount: 1_000 });

    // 100 never applied comes off the receipt; the 900 the insurer now pays
    // comes off the bill it was applied to.
    expect(db.refund.map((r) => [r.paymentId, r.amount])).toEqual([['rc-1', 100], ['app-1', 900]]);
    const bill = db.bill.find((b) => b.id === 'bill-1')!;
    expect(bill).toMatchObject({ amountPaid: 0, balanceDue: 0 });
    const after = await getAdmissionLedger(TENANT, 'adm-1', ACTOR);
    expect(after.totals).toMatchObject({ balanceAfterDeposit: 0, refundable: 0 });
  });

  it('refuses a second return once nothing is held', async () => {
    await refundDeposit(TENANT, 'u-1', 'adm-1', ACTOR, { amount: 100 });
    await expect(refundDeposit(TENANT, 'u-1', 'adm-1', ACTOR, { amount: 100 })).rejects.toThrow(/No deposit to return/);
    expect(db.bill.find((b) => b.id === 'bill-1')).toMatchObject({ amountPaid: 900, balanceDue: 0 });
  });
});

// Gap item 287 — the insurer is chased for its share, the patient for theirs.
describe('receivableSplit', () => {
  it('a 1,000 bill with 800 approved: insurer owes 800, patient 200, and both reconcile', () => {
    const s = receivableSplit(
      { total: 1_000, payments: 0, advanceApplied: 0, refunds: 0, advanceRefunds: 0, insurerPaid: 0, paid: 0, insurerShare: 800 },
      [{ disallowedAmount: 0, writtenOffAmount: 0 }],
    );
    expect(s.insurer).toMatchObject({ billed: 800, outstanding: 800 });
    expect(s.patient).toMatchObject({ billed: 200, outstanding: 200 });
    for (const f of [s.insurer!, s.patient!]) {
      expect(f.billed - f.received - f.adjusted - f.disallowed - f.writtenOff).toBe(f.outstanding);
    }
  });

  it('nets a refunded deposit application off "adjusted", never as negative received', () => {
    const s = receivableSplit(
      { total: 900, payments: 0, advanceApplied: 900, refunds: 100, advanceRefunds: 100, insurerPaid: 0, paid: 800, insurerShare: 0 },
      [],
    );
    expect(s.insurer).toBeNull();
    expect(s.patient).toMatchObject({ billed: 900, received: 0, adjusted: 800, outstanding: 100 });
  });
});
