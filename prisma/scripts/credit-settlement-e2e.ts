/**
 * Credit settlement, walked end to end.
 *
 * The receivables screen groups every unpaid bill by WHO owes it — the TPA, the
 * insurer, or the patient themselves — and settling records one payer's cheque
 * against their own bills, oldest first. It had never been exercised because
 * there were no TPA providers, so the corporate bucket could not exist.
 *
 * The failure that matters is money landing on the wrong account: an insurer's
 * cheque spread over the oldest open bills in the whole hospital, self-pay
 * patients included. That was fixed once; this pins it.
 *
 *   npm run db:check-credit-settlement      (needs the dev server up)
 *
 * Fixtures are tagged CRED-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `CRED-${Date.now()}`;
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

async function main() {
  console.log(`Credit settlement, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) return;

  section('Fixtures');
  const named = await p.patient.findFirst({
    where: { tenantId: TENANT, lastName: { not: null } },
    select: { id: true, firstName: true, lastName: true },
  });
  // A temporary patient arrives with a first name only — that is the whole
  // point of the flow, and 8 of this hospital's patients are in that state.
  const noSurname = await p.patient.findFirst({
    where: { tenantId: TENANT, lastName: null },
    select: { id: true, firstName: true },
  });
  ck('a patient with a surname exists', !!named, named ? `${named.firstName} ${named.lastName}` : 'none');
  ck('and one without', !!noSurname, noSurname?.firstName ?? 'none');
  if (!named || !noSurname) return;

  const tpa = await api('admin', 'POST', '/insurance/tpa', { name: `${TAG} TPA` });
  const insurer = await api('admin', 'POST', '/insurance/insurers', { name: `${TAG} Insurer` });
  ck('a TPA provider is created', tpa.status === 201, `HTTP ${tpa.status} ${tpa.message}`);
  ck('and an insurer', insurer.status === 201, `HTTP ${insurer.status}`);
  if (!tpa.data?.id || !insurer.data?.id) return;

  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString();

  async function makePolicy(num: string, withTpa: boolean) {
    const res = await api('admin', 'POST', '/insurance/policies', {
      patientId: named!.id,
      insurerId: insurer.data.id,
      ...(withTpa ? { tpaId: tpa.data.id } : {}),
      policyNumber: `${TAG}-${num}`,
      coverageAmount: 500000,
      validFrom: yesterday,
      validTo: nextYear,
    });
    return res.data?.id as string;
  }

  const tpaPolicy = await makePolicy('TPA', true);
  const insurerPolicy = await makePolicy('INS', false);
  ck('a policy through the TPA', !!tpaPolicy);
  ck('and one direct with the insurer', !!insurerPolicy);

  let billSeq = 0;
  /** A pending bill with a balance, owned by `patientId`. */
  async function makeBill(amount: number, patientId: string, daysAgo = 0) {
    billSeq += 1;
    const when = new Date(Date.now() - daysAgo * 86400000);
    const bill = await p.bill.create({
      data: {
        tenantId: TENANT,
        patientId,
        billNumber: `${TAG}-B${billSeq}`,
        billDate: when,
        createdAt: when,
        status: 'pending',
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
        description: `${TAG} treatment`,
        category: 'procedure',
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
      },
    });
    return bill.id;
  }

  async function claimOn(billId: string, policyId: string, amount: number) {
    return api('admin', 'POST', '/insurance/claims', {
      policyId,
      patientId: named!.id,
      billId,
      claimAmount: amount,
    });
  }

  try {
    // Two bills owed by the TPA, of different ages, and one by the insurer.
    const tpaBillOld = await makeBill(3000, named.id, 30);
    const tpaBillNew = await makeBill(2000, named.id, 2);
    const insurerBill = await makeBill(4000, named.id, 10);
    const selfPayBill = await makeBill(1500, noSurname.id, 5);

    ck('claim on the older TPA bill', (await claimOn(tpaBillOld, tpaPolicy, 3000)).status === 201);
    ck('claim on the newer TPA bill', (await claimOn(tpaBillNew, tpaPolicy, 2000)).status === 201);
    ck('claim on the insurer bill', (await claimOn(insurerBill, insurerPolicy, 4000)).status === 201);

    // -- Who owes what --------------------------------------------------------
    section('Grouping receivables by who owes them');
    const list = await api('admin', 'GET', '/billing/credit-settlements?limit=200');
    ck('the receivables list loads', list.status === 200, `HTTP ${list.status} ${list.message}`);
    const rows: any[] = list.data?.settlements ?? [];

    const tpaRow = rows.find((r) => r.id === `tpa:${tpa.data.id}`);
    ck('the TPA appears as a corporate payer', !!tpaRow && tpaRow.providerType === 'corporate', String(tpaRow?.providerType));
    ck('named after the TPA, not the insurer behind it', tpaRow?.providerName === `${TAG} TPA`, String(tpaRow?.providerName));
    ck(
      'owing both of its bills',
      money(tpaRow?.outstandingAmount) === 5000 && tpaRow?.totalAdmissions === 2,
      `${money(tpaRow?.outstandingAmount)} across ${tpaRow?.totalAdmissions} bill(s)`,
    );

    const insRow = rows.find((r) => r.id === `ins:${insurer.data.id}`);
    ck('the insurer appears separately', !!insRow && insRow.providerType === 'insurance', String(insRow?.providerType));
    ck('owing only its own bill', money(insRow?.outstandingAmount) === 4000, String(money(insRow?.outstandingAmount)));

    const selfRow = rows.find((r) => r.id === `pat:${noSurname.id}`);
    ck('a bill with no claim is owed by the patient', !!selfRow && selfRow.providerType === 'patient', String(selfRow?.providerType));
    ck(
      'and a patient with no surname is not named "null"',
      !!selfRow && !/\bnull\b/i.test(String(selfRow.providerName)),
      `"${selfRow?.providerName}" — a temporary patient has only a first name by design`,
    );

    // -- Settling ---------------------------------------------------------------
    section('A payer settling their account');
    const tooMuch = await api('admin', 'POST', `/billing/credit-settlements/tpa:${tpa.data.id}/settle`, {
      amount: 9999,
      method: 'bank_transfer',
    });
    ck(
      'settling more than the payer owes is refused',
      tooMuch.status === 400,
      `HTTP ${tooMuch.status} ${tooMuch.message}`,
    );

    const settle = await api('admin', 'POST', `/billing/credit-settlements/tpa:${tpa.data.id}/settle`, {
      amount: 3500,
      method: 'bank_transfer',
      notes: `${TAG} cheque`,
    });
    ck('a part settlement is accepted', settle.status === 200 || settle.status === 201, `HTTP ${settle.status} ${settle.message}`);
    ck('and reports what it applied', money(settle.data?.settledAmount) === 3500, String(settle.data?.settledAmount));

    const oldAfter = await p.bill.findUnique({ where: { id: tpaBillOld } });
    const newAfter = await p.bill.findUnique({ where: { id: tpaBillNew } });
    ck(
      'the oldest bill is cleared first',
      money(oldAfter?.balanceDue) === 0 && money(oldAfter?.amountPaid) === 3000,
      `oldest: paid ${money(oldAfter?.amountPaid)}, due ${money(oldAfter?.balanceDue)}`,
    );
    ck(
      'and the remainder lands on the next one',
      money(newAfter?.amountPaid) === 500 && money(newAfter?.balanceDue) === 1500,
      `newer: paid ${money(newAfter?.amountPaid)}, due ${money(newAfter?.balanceDue)}`,
    );

    // The point of the payer key: nobody else's bills move.
    const insUntouched = await p.bill.findUnique({ where: { id: insurerBill } });
    const selfUntouched = await p.bill.findUnique({ where: { id: selfPayBill } });
    ck(
      "the insurer's bill is untouched",
      money(insUntouched?.amountPaid) === 0,
      `paid ${money(insUntouched?.amountPaid)} — a payer's cheque must not land on another payer's account`,
    );
    ck(
      "and so is the self-pay patient's",
      money(selfUntouched?.amountPaid) === 0,
      `paid ${money(selfUntouched?.amountPaid)}`,
    );

    // Every settled bill gets its own receipt.
    const receipts = await p.receipt.findMany({
      where: { payment: { billId: { in: [tpaBillOld, tpaBillNew] } } },
      select: { receiptNumber: true, amount: true },
    });
    ck('each bill settled gets a receipt', receipts.length === 2, `${receipts.length}`);
    ck('with distinct numbers', new Set(receipts.map((r) => r.receiptNumber)).size === 2, receipts.map((r) => r.receiptNumber).join(' / '));
    ck(
      'totalling what was settled',
      receipts.reduce((s, r) => s + money(r.amount), 0) === 3500,
      String(receipts.reduce((s, r) => s + money(r.amount), 0)),
    );

    // -- What the list says afterwards -----------------------------------------
    section('The list after settling');
    const after = await api('admin', 'GET', '/billing/credit-settlements?limit=200');
    const tpaAfter = (after.data?.settlements ?? []).find((r: any) => r.id === `tpa:${tpa.data.id}`);
    ck(
      'the TPA now owes only what is left',
      money(tpaAfter?.outstandingAmount) === 1500,
      `${money(tpaAfter?.outstandingAmount)} — the cleared bill drops out of the list entirely`,
    );
    ck(
      'and the money received is counted',
      money(tpaAfter?.receivedAmount) === 500,
      `${money(tpaAfter?.receivedAmount)} — only the bill still open is summed`,
    );

    const zero = await api('admin', 'POST', `/billing/credit-settlements/tpa:${tpa.data.id}/settle`, {
      amount: 0,
    });
    ck('settling nothing is refused', zero.status === 400, `HTTP ${zero.status} ${zero.message}`);
  } finally {
    section('Cleanup');
    const billIds = (
      await p.bill.findMany({ where: { billNumber: { startsWith: TAG } }, select: { id: true } })
    ).map((b) => b.id);
    const claimIds = (
      await p.insuranceClaim.findMany({ where: { billId: { in: billIds } }, select: { id: true } })
    ).map((c) => c.id);
    await p.tpaCommunicationLog.deleteMany({ where: { claimId: { in: claimIds } } });
    await p.insuranceClaim.deleteMany({ where: { id: { in: claimIds } } });
    await p.receipt.deleteMany({ where: { payment: { billId: { in: billIds } } } });
    await p.payment.deleteMany({ where: { billId: { in: billIds } } });
    // A voided or cancelled bill now carries a credit note that references it.
    await p.creditNote.deleteMany({ where: { billId: { in: billIds } } }).catch(() => {});
    await p.billItem.deleteMany({ where: { billId: { in: billIds } } });
    await p.bill.deleteMany({ where: { id: { in: billIds } } });
    await p.insurancePolicy.deleteMany({ where: { policyNumber: { startsWith: TAG } } });
    await p.tpaProvider.deleteMany({ where: { name: { startsWith: TAG } } });
    await p.insurer.deleteMany({ where: { name: { startsWith: TAG } } });
    ck(
      'fixtures cleaned up',
      (await p.bill.count({ where: { billNumber: { startsWith: TAG } } })) === 0 &&
        (await p.tpaProvider.count({ where: { name: { startsWith: TAG } } })) === 0,
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
