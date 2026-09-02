/**
 * Split payments, walked end to end.
 *
 * A patient pays one bill across several modes — ₹2,000 cash and the rest on a
 * card. Each split is its own Payment with its own Receipt, all inside one
 * transaction, and the bill must end up with exactly one balance.
 *
 * The known-fragile part is the RECEIPT NUMBER. `Receipt.receiptNumber` is
 * `@unique` across the whole database, and a unique violation inside a Postgres
 * transaction aborts it — so a number handed out twice does not merely misname
 * a receipt, it destroys the entire collection. The generator was made
 * transaction-aware so splits within one payment do not collide; whether it is
 * safe against ANOTHER HOSPITAL holding the same number is what the last
 * section actually reproduces.
 *
 *   npm run db:check-split-payment      (needs the dev server up)
 *
 * Fixtures are tagged SPLIT-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const OTHER_TENANT = 'db6df4e2-d729-41a1-8153-243fb9d31ab8';
const TAG = `SPLIT-${Date.now()}`;
const p = new PrismaClient();

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ck(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${name}${detail ? ' - ' + detail : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

const tokens: Record<string, string> = {};
async function login(key: string, email: string) {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Admin@123' }),
    });
    const j: any = await res.json();
    const token = j?.data?.accessToken ?? j?.data?.tokens?.accessToken ?? '';
    if (token) {
      tokens[key] = token;
      return true;
    }
  } catch {
    /* fall through */
  }
  const user = await p.user.findFirst({
    where: { email },
    select: {
      id: true,
      tenantId: true,
      email: true,
      userRoles: { select: { role: { select: { name: true } } } },
    },
  });
  if (!user) return false;
  tokens[key] = jwt.sign(
    {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.userRoles.map((r) => r.role.name),
    },
    process.env.JWT_ACCESS_SECRET as string,
    { expiresIn: '30m' },
  );
  console.log('        (login endpoint unavailable — signed a token directly; Redis is down)');
  return true;
}

async function api(as: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens[as]}`,
      'X-Tenant-Id': TENANT,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, data: json?.data, message: json?.message ?? '' };
}

const money = (v: unknown) => Number(v ?? 0);

/** The IST calendar day the receipt series is keyed on. */
function istDateStr() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  return ist.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  console.log(`Split payments, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) return;

  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient);
  if (!patient) return;

  let billSeq = 0;
  async function makeBill(amount: number, status: string = 'pending') {
    billSeq += 1;
    const bill = await p.bill.create({
      data: {
        tenantId: TENANT,
        patientId: patient!.id,
        billNumber: `${TAG}-B${billSeq}`,
        billDate: new Date(),
        status: status as never,
        subtotal: amount,
        totalAmount: amount,
        patientPayableAmount: amount,
        balanceDue: amount,
      },
      select: { id: true },
    });
    await p.billItem.create({
      data: {
        billId: bill.id,
        description: `${TAG} procedure`,
        category: 'procedure',
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
      },
    });
    return bill.id;
  }

  try {
    // -- Two ways of paying one bill -----------------------------------------
    section('A bill settled across two modes');
    const b1 = await makeBill(5000);
    const r1 = await api('admin', 'POST', '/billing/payments/split', {
      billId: b1,
      splits: [
        { amount: 2000, paymentMethod: 'cash' },
        { amount: 3000, paymentMethod: 'upi', referenceNumber: 'UPI-REF-1' },
      ],
    });
    ck('the split is accepted', r1.status === 201 || r1.status === 200, `HTTP ${r1.status} ${r1.message}`);
    ck('both collections are reported', r1.data?.payments?.length === 2, `${r1.data?.payments?.length} payment(s)`);
    ck('the whole amount is counted once', r1.data?.totalCollected === 5000, String(r1.data?.totalCollected));
    ck('and the bill is left with nothing due', r1.data?.newBalance === 0, String(r1.data?.newBalance));

    const pays1 = await p.payment.findMany({ where: { billId: b1 }, include: { receipt: true } });
    ck('two payments are stored', pays1.length === 2, `${pays1.length}`);
    ck(
      'the modes are kept apart',
      pays1.map((x) => x.paymentMethod).sort().join(',') === 'cash,upi',
      pays1.map((x) => x.paymentMethod).join(','),
    );
    ck(
      'the card reference is kept against its own split only',
      pays1.find((x) => x.paymentMethod === 'upi')?.transactionId === 'UPI-REF-1' &&
        !pays1.find((x) => x.paymentMethod === 'cash')?.transactionId,
    );
    const nums1 = pays1.map((x) => x.receipt?.receiptNumber).filter(Boolean);
    ck('each split gets its own receipt', nums1.length === 2, `${nums1.length} receipt(s)`);
    ck(
      'and the two receipt numbers differ',
      new Set(nums1).size === 2,
      nums1.join(' / ') + ' — one number twice would abort the whole transaction',
    );
    const billAfter1 = await p.bill.findUnique({ where: { id: b1 } });
    ck('the bill reads as paid', billAfter1?.status === 'paid', String(billAfter1?.status));
    ck('with the money accounted for once', money(billAfter1?.amountPaid) === 5000, String(money(billAfter1?.amountPaid)));

    // -- Three ways, and a part payment ---------------------------------------
    section('Three modes, paying only part of the bill');
    const b2 = await makeBill(10000);
    const r2 = await api('admin', 'POST', '/billing/payments/split', {
      billId: b2,
      splits: [
        { amount: 1000, paymentMethod: 'cash' },
        { amount: 2500, paymentMethod: 'credit_card' },
        { amount: 1500, paymentMethod: 'wallet' },
      ],
    });
    ck('a three-way split is accepted', r2.status === 201 || r2.status === 200, `HTTP ${r2.status} ${r2.message}`);
    ck('the balance is what is left', r2.data?.newBalance === 5000, String(r2.data?.newBalance));
    const billAfter2 = await p.bill.findUnique({ where: { id: b2 } });
    ck('and the bill is partly paid, not paid', billAfter2?.status === 'partially_paid', String(billAfter2?.status));

    const nums2 = (
      await p.receipt.findMany({
        where: { payment: { billId: b2 } },
        select: { receiptNumber: true },
      })
    ).map((x) => x.receiptNumber);
    ck('three distinct receipt numbers', new Set(nums2).size === 3, nums2.join(' / '));

    // A second split on the same bill must continue, not restart.
    const r2b = await api('admin', 'POST', '/billing/payments/split', {
      billId: b2,
      splits: [{ amount: 5000, paymentMethod: 'bank_transfer' }],
    });
    ck('the rest can be collected later', r2b.status === 201 || r2b.status === 200, `HTTP ${r2b.status}`);
    ck('and clears the bill', r2b.data?.newBalance === 0, String(r2b.data?.newBalance));
    ck(
      'the bill totals the four collections, not the last one',
      money((await p.bill.findUnique({ where: { id: b2 } }))?.amountPaid) === 10000,
    );

    // -- What must be refused --------------------------------------------------
    section('What a split must refuse');
    const b3 = await makeBill(1000);
    const over = await api('admin', 'POST', '/billing/payments/split', {
      billId: b3,
      splits: [
        { amount: 800, paymentMethod: 'cash' },
        { amount: 700, paymentMethod: 'upi' },
      ],
    });
    ck('collecting more than is due is refused', over.status === 400, `HTTP ${over.status} ${over.message}`);
    ck(
      'and nothing is written when it is',
      (await p.payment.count({ where: { billId: b3 } })) === 0,
      'a rejected split must not leave one leg behind',
    );

    const draft = await makeBill(1000, 'draft');
    const onDraft = await api('admin', 'POST', '/billing/payments/split', {
      billId: draft,
      splits: [{ amount: 100, paymentMethod: 'cash' }],
    });
    ck('a draft bill cannot be paid', onDraft.status === 400, `HTTP ${onDraft.status} ${onDraft.message}`);

    const cancelled = await makeBill(1000, 'cancelled');
    const onCancelled = await api('admin', 'POST', '/billing/payments/split', {
      billId: cancelled,
      splits: [{ amount: 100, paymentMethod: 'cash' }],
    });
    ck('a cancelled bill cannot be paid', onCancelled.status === 400, `HTTP ${onCancelled.status}`);

    const paidAgain = await api('admin', 'POST', '/billing/payments/split', {
      billId: b1,
      splits: [{ amount: 100, paymentMethod: 'cash' }],
    });
    ck('a settled bill cannot be paid again', paidAgain.status === 400, `HTTP ${paidAgain.status}`);

    // -- Another hospital holding the number ----------------------------------
    // receiptNumber is @unique across the WHOLE database, but the generator
    // looks for the day's highest number within the caller's own tenant. So a
    // second hospital that has not billed today computes -0001, another
    // hospital already holds it, and the insert violates the global index —
    // which in Postgres aborts the transaction, taking every split with it.
    section('Another hospital holding the next receipt number');
    const today = istDateStr();
    const mine = await p.receipt.findFirst({
      where: { tenantId: TENANT, receiptNumber: { startsWith: `RCP-${today}-` } },
      orderBy: { receiptNumber: 'desc' },
      select: { receiptNumber: true },
    });
    const nextSeq = mine ? parseInt(mine.receiptNumber.split('-').pop()!, 10) + 1 : 1;
    const contested = `RCP-${today}-${String(nextSeq).padStart(4, '0')}`;
    console.log(`        this hospital's next receipt number would be ${contested}`);

    // Park that exact number on the OTHER tenant, as a second hospital would.
    const otherPatient = await p.patient.findFirst({
      where: { tenantId: OTHER_TENANT },
      select: { id: true },
    });
    const squatterPatientId = otherPatient?.id ?? patient.id;
    const squatBill = await p.bill.create({
      data: {
        tenantId: OTHER_TENANT,
        patientId: squatterPatientId,
        billNumber: `${TAG}-OTHER`,
        billDate: new Date(),
        status: 'pending',
        subtotal: 100,
        totalAmount: 100,
        balanceDue: 100,
      },
      select: { id: true },
    });
    const squatPayment = await p.payment.create({
      data: {
        tenantId: OTHER_TENANT,
        billId: squatBill.id,
        patientId: squatterPatientId,
        amount: 100,
        paymentMethod: 'cash',
        paymentDate: new Date(),
        status: 'completed',
      },
      select: { id: true },
    });
    await p.receipt.create({
      data: {
        tenantId: OTHER_TENANT,
        receiptNumber: contested,
        paymentId: squatPayment.id,
        receiptDate: new Date(),
        amount: 100,
      },
    });
    ck('a second hospital now holds that number', true, contested);

    const b4 = await makeBill(3000);
    const contestedSplit = await api('admin', 'POST', '/billing/payments/split', {
      billId: b4,
      splits: [
        { amount: 1000, paymentMethod: 'cash' },
        { amount: 2000, paymentMethod: 'upi' },
      ],
    });
    ck(
      'this hospital can still take the payment',
      contestedSplit.status === 201 || contestedSplit.status === 200,
      `HTTP ${contestedSplit.status} ${contestedSplit.message} — the number is unique across all ` +
        `hospitals, so reading only this tenant's maximum hands out one that is already taken`,
    );
    ck(
      'and both collections are stored',
      (await p.payment.count({ where: { billId: b4 } })) === 2,
      `${await p.payment.count({ where: { billId: b4 } })} payment(s) — a unique violation aborts ` +
        `the whole transaction, so a clash loses every split, not just one`,
    );
    const nums4 = (
      await p.receipt.findMany({
        where: { payment: { billId: b4 } },
        select: { receiptNumber: true },
      })
    ).map((x) => x.receiptNumber);
    ck(
      'with numbers that avoid the one already taken',
      nums4.length === 2 && !nums4.includes(contested),
      nums4.join(' / ') || '(none issued)',
    );
  } finally {
    section('Cleanup');
    const billIds = (
      await p.bill.findMany({
        where: { billNumber: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((b) => b.id);
    await p.receipt.deleteMany({ where: { payment: { billId: { in: billIds } } } });
    await p.payment.deleteMany({ where: { billId: { in: billIds } } });
    // A voided or cancelled bill now carries a credit note that references it.
    await p.creditNote.deleteMany({ where: { billId: { in: billIds } } }).catch(() => {});
    await p.billItem.deleteMany({ where: { billId: { in: billIds } } });
    await p.bill.deleteMany({ where: { id: { in: billIds } } });
    ck(
      'fixtures cleaned up',
      (await p.bill.count({ where: { billNumber: { startsWith: TAG } } })) === 0,
    );
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\n  What is wrong:');
    for (const f of failures) console.log(`    . ${f}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    fail += 1;
  })
  .finally(async () => {
    await p.$disconnect();
    process.exit(fail ? 1 : 0);
  });
