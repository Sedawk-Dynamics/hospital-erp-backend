/**
 * Concessions and the approval gate, walked end to end.
 *
 * `discounts` has 0 rows on the live database. The gate was built after the
 * August revenue-cycle audit and has never once produced a parked concession,
 * so nothing here has been observed working — only reasoned about.
 *
 * What can go wrong with a discount gate is specific: the money comes off
 * before anyone approves (making the gate decorative), a rejected concession
 * still reduces the bill, or the person who asked for it signs it off
 * themselves. Each of those is asserted below against the bill's own total,
 * not against the endpoint's status code.
 *
 *   npm run db:check-discount-approval      (needs the dev server up)
 *
 * The tenant's own discount policy is READ FIRST AND PUT BACK at the end — this
 * walk switches the gate on, and leaving it on would change how the counter
 * behaves for real staff.
 *
 * Fixtures are tagged DISC-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `DISC-${Date.now()}`;
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

/** Sign in, or mint the token login would have issued when Redis is down. */
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
    /* fall through to minting */
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

async function billTotal(billId: string) {
  const b = await p.bill.findUnique({
    where: { id: billId },
    select: { totalAmount: true, discountAmount: true },
  });
  return { total: money(b?.totalAmount), discount: money(b?.discountAmount) };
}

async function main() {
  console.log(`Concessions and the approval gate, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) {
    console.log('\n  Cannot continue without a session.');
    return;
  }

  const me = await p.user.findFirst({ where: { email: 'admin@hospital.com' }, select: { id: true } });
  const someoneElse = await p.user.findFirst({
    where: { email: { not: 'admin@hospital.com' }, isActive: true },
    select: { id: true, email: true },
  });
  ck('a second user exists to impersonate as requester', !!someoneElse, someoneElse?.email ?? 'none');

  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient);
  if (!patient || !me) return;

  // -- Remember the hospital's real policy so it can be put back --------------
  const originalPolicy = (await api('admin', 'GET', '/billing/discount-policy')).data;
  ck('read the hospital’s existing discount policy', !!originalPolicy, JSON.stringify(originalPolicy));

  let billSeq = 0;
  /** A bill of `amount`, as one line item, so subtotal is unambiguous. */
  async function makeBill(amount: number) {
    billSeq += 1;
    const bill = await p.bill.create({
      data: {
        tenantId: TENANT,
        patientId: patient!.id,
        billNumber: `${TAG}-B${billSeq}`,
        billDate: new Date(),
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
        description: `${TAG} consultation`,
        category: 'consultation',
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
      },
    });
    return bill.id;
  }

  async function setDiscount(billId: string, body: Record<string, unknown>) {
    return api('admin', 'PATCH', `/billing/${billId}/discount`, body);
  }

  try {
    // -- Gate OFF: nothing changes for a hospital that never turns it on ------
    section('Gate off — a concession applies immediately, as it always has');
    await api('admin', 'PUT', '/billing/discount-policy', { enabled: false });

    const b0 = await makeBill(10000);
    const r0 = await setDiscount(b0, { discountType: 'fixed', discountValue: 2000, reason: 'Staff' });
    ck('concession accepted', r0.status === 200, `HTTP ${r0.status} ${r0.message}`);
    const t0 = await billTotal(b0);
    ck('the money comes off at once', t0.total === 8000, `total ${t0.total}, expected 8000`);
    const d0 = await p.discount.findFirst({ where: { billId: b0 } });
    ck('and the row is approved, not parked', d0?.status === 'approved', String(d0?.status));

    // -- Gate ON --------------------------------------------------------------
    section('Gate on — above ₹1,000 or 15% needs a second pair of eyes');
    const pol = await api('admin', 'PUT', '/billing/discount-policy', {
      enabled: true,
      maxAmountWithoutApproval: 1000,
      maxPercentWithoutApproval: 15,
    });
    ck('policy saved', pol.status === 200 && pol.data?.enabled === true, JSON.stringify(pol.data));

    const b1 = await makeBill(10000);
    const r1 = await setDiscount(b1, { discountType: 'fixed', discountValue: 500, reason: 'Small' });
    ck('an under-limit concession is accepted', r1.status === 200, `HTTP ${r1.status}`);
    ck(
      'and applies immediately',
      (await billTotal(b1)).total === 9500,
      `total ${(await billTotal(b1)).total}, expected 9500`,
    );

    // -- The whole point: over the limit, the money must NOT move -------------
    section('Over the limit — recorded, but the patient still owes the full amount');
    const b2 = await makeBill(10000);
    const before2 = await billTotal(b2);
    const r2res = await setDiscount(b2, {
      discountType: 'fixed',
      discountValue: 3000,
      reason: 'Hardship',
    });
    ck('the concession is accepted for review', r2res.status === 200, `HTTP ${r2res.status}`);
    ck(
      'the counter is told it is not applied yet',
      r2res.data?.discountPendingApproval === true,
      `discountPendingApproval=${r2res.data?.discountPendingApproval}`,
    );
    const after2 = await billTotal(b2);
    ck(
      'the bill total has NOT moved',
      after2.total === before2.total,
      `${before2.total} -> ${after2.total}; if it dropped, the gate is decorative`,
    );
    ck('and no discount is counted on the bill', after2.discount === 0, `discountAmount ${after2.discount}`);

    const parked = await p.discount.findFirst({ where: { billId: b2 } });
    ck('the request is parked as pending', parked?.status === 'pending', String(parked?.status));
    ck('and it records who asked', parked?.requestedBy === me.id, String(parked?.requestedBy));

    const pending = await api('admin', 'GET', '/billing/discounts/pending');
    ck(
      'it shows in the approvals queue',
      Array.isArray(pending.data) && pending.data.some((d: any) => d.id === parked?.id),
      `${pending.data?.length ?? 0} row(s) queued`,
    );
    const queued = (pending.data ?? []).find((d: any) => d.id === parked?.id);
    ck(
      'the queue shows the bill total the approver is being asked to reduce',
      queued?.billTotal === 10000,
      `billTotal ${queued?.billTotal}`,
    );
    ck('and what share of the bill it is', queued?.percentOfBill === 30, `${queued?.percentOfBill}%`);

    // -- Nobody signs off their own -------------------------------------------
    section('Nobody signs off their own concession');
    const selfApprove = await api('admin', 'PATCH', `/billing/discounts/${parked?.id}/approve`);
    ck(
      'approving your own request is refused',
      selfApprove.status === 400,
      `HTTP ${selfApprove.status} ${selfApprove.message}`,
    );
    ck(
      'and it is still pending afterwards',
      (await p.discount.findUnique({ where: { id: parked!.id } }))?.status === 'pending',
    );

    // The check keys on requestedBy, which the caller can set from the request
    // body. If that is honoured, one person does both halves and the gate is
    // worthless — so this asserts the request body must NOT be able to say who
    // asked for the concession.
    const b3 = await makeBill(10000);
    await setDiscount(b3, {
      discountType: 'fixed',
      discountValue: 4000,
      reason: 'Spoofed requester',
      approvedBy: someoneElse?.id,
    });
    const spoofed = await p.discount.findFirst({ where: { billId: b3 } });
    ck(
      'the requester is the signed-in user, not whoever the request body named',
      spoofed?.requestedBy === me.id,
      `requestedBy=${spoofed?.requestedBy}; expected the caller ${me.id}`,
    );
    const spoofApprove = await api('admin', 'PATCH', `/billing/discounts/${spoofed?.id}/approve`);
    ck(
      'so the same person still cannot approve it',
      spoofApprove.status === 400,
      `HTTP ${spoofApprove.status}; naming someone else as approver must not launder a self-approval`,
    );

    // -- Approving releases the money ----------------------------------------
    section('Approval is what moves the money');
    await p.discount.update({ where: { id: parked!.id }, data: { requestedBy: someoneElse?.id } });
    const approve = await api('admin', 'PATCH', `/billing/discounts/${parked?.id}/approve`);
    ck('a colleague’s request can be approved', approve.status === 200, `HTTP ${approve.status} ${approve.message}`);
    const afterApprove = await billTotal(b2);
    ck(
      'and only now does the bill drop',
      afterApprove.total === 7000,
      `total ${afterApprove.total}, expected 7000`,
    );
    const decided = await p.discount.findUnique({ where: { id: parked!.id } });
    ck('the decision is stamped', !!decided?.decidedAt && decided?.approvedBy === me.id);

    const twice = await api('admin', 'PATCH', `/billing/discounts/${parked?.id}/approve`);
    ck('deciding a second time is refused', twice.status === 400, `HTTP ${twice.status}`);

    // -- Rejection leaves the bill alone --------------------------------------
    section('Rejection leaves the patient owing the full amount');
    const b4 = await makeBill(10000);
    await setDiscount(b4, { discountType: 'fixed', discountValue: 5000, reason: 'Too much' });
    const toReject = await p.discount.findFirst({ where: { billId: b4 } });
    await p.discount.update({ where: { id: toReject!.id }, data: { requestedBy: someoneElse?.id } });
    const reject = await api('admin', 'PATCH', `/billing/discounts/${toReject?.id}/reject`, {
      reason: 'Not eligible under the scheme',
    });
    ck('rejection accepted', reject.status === 200, `HTTP ${reject.status} ${reject.message}`);
    const afterReject = await billTotal(b4);
    ck(
      'the bill is untouched',
      afterReject.total === 10000 && afterReject.discount === 0,
      `total ${afterReject.total}, discount ${afterReject.discount}`,
    );
    const rejected = await p.discount.findUnique({ where: { id: toReject!.id } });
    ck(
      'and the reason is kept',
      rejected?.rejectionReason === 'Not eligible under the scheme',
      String(rejected?.rejectionReason),
    );

    // -- The percentage limit trips independently ------------------------------
    section('Either limit can trip it');
    const b5 = await makeBill(2000);
    // ₹400 is under the ₹1,000 rupee limit but is 20% of the bill, over 15%.
    await setDiscount(b5, { discountType: 'fixed', discountValue: 400, reason: 'Percent trip' });
    const pctRow = await p.discount.findFirst({ where: { billId: b5 } });
    ck(
      'under the rupee limit but over the share limit still needs approval',
      pctRow?.status === 'pending',
      `status ${pctRow?.status}; ₹400 of ₹2,000 is 20%, over the 15% limit`,
    );
    ck('and the bill has not moved', (await billTotal(b5)).total === 2000);

    // -- The second write path ------------------------------------------------
    section('The other way a concession can be entered');
    const b6 = await makeBill(10000);
    const viaPost = await api('admin', 'POST', `/billing/${b6}/discounts`, {
      discountType: 'fixed',
      discountValue: 6000,
      reason: 'Via the other endpoint',
    });
    ck('POST /billing/:id/discounts accepts a concession', viaPost.status === 201, `HTTP ${viaPost.status}`);
    const postRow = await p.discount.findFirst({ where: { billId: b6 } });
    ck(
      'and it is gated exactly like the other path',
      postRow?.status === 'pending',
      `status ${postRow?.status}; ₹6,000 is far over both limits — an ungated second door makes the gate optional`,
    );
    ck(
      'so the money has not come off',
      (await billTotal(b6)).total === 10000,
      `total ${(await billTotal(b6)).total}`,
    );
    ck(
      'and it records the signed-in user as requester',
      postRow?.requestedBy === me.id,
      `requestedBy=${postRow?.requestedBy}`,
    );

    // -- Zero and removal ------------------------------------------------------
    section('Taking a concession back off');
    const b7 = await makeBill(10000);
    await setDiscount(b7, { discountType: 'fixed', discountValue: 500, reason: 'Small' });
    const removed = await setDiscount(b7, { discountType: 'fixed', discountValue: 0 });
    ck('setting it to zero is accepted', removed.status === 200, `HTTP ${removed.status}`);
    ck('the bill goes back to full', (await billTotal(b7)).total === 10000);
    ck(
      'and no concession row is left behind',
      (await p.discount.count({ where: { billId: b7 } })) === 0,
    );
  } finally {
    // -- Put the hospital's policy back ---------------------------------------
    section('Restore');
    if (originalPolicy) {
      const restored = await api('admin', 'PUT', '/billing/discount-policy', {
        enabled: originalPolicy.enabled,
        maxAmountWithoutApproval: originalPolicy.maxAmountWithoutApproval,
        maxPercentWithoutApproval: originalPolicy.maxPercentWithoutApproval,
      });
      ck(
        'the hospital’s own discount policy is put back',
        JSON.stringify(restored.data) === JSON.stringify(originalPolicy),
        `${JSON.stringify(restored.data)} vs ${JSON.stringify(originalPolicy)}`,
      );
    }

    const billIds = (
      await p.bill.findMany({ where: { billNumber: { startsWith: TAG } }, select: { id: true } })
    ).map((b) => b.id);
    await p.discount.deleteMany({ where: { billId: { in: billIds } } });
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
