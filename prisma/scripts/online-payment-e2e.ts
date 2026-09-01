/**
 * Online payment settlement, walked end to end — without Razorpay test keys.
 *
 * Creating the order and paying it needs live gateway credentials, which this
 * hospital does not have yet. Everything AFTER the money moves does not: the
 * webhook and the verify callback are both plain HMAC-signed HTTP, and the
 * settlement they trigger is ordinary local code. Those are also the parts
 * where getting it wrong costs money — a forged webhook marks a bill paid, and
 * a replayed one could pay the hospital twice.
 *
 * So the order and the transfer are stood up directly in the database, exactly
 * as `createOnlineOrder` would leave them, and the walk starts from the moment
 * Razorpay calls back.
 *
 *   npm run db:check-online-payment      (needs the dev server up)
 *
 * Fixtures are tagged PAY-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `PAY-${Date.now()}`;
const p = new PrismaClient();

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';

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

/** Post a webhook body exactly as Razorpay would, signing it or not. */
async function webhook(payload: unknown, opts: { sign?: boolean | string } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.sign === true) {
    headers['x-razorpay-signature'] = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');
  } else if (typeof opts.sign === 'string') {
    headers['x-razorpay-signature'] = opts.sign;
  }
  const res = await fetch(`${API}/online-payments/webhook`, {
    method: 'POST',
    headers,
    body: raw,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, message: json?.message ?? '' };
}

const money = (v: unknown) => Number(v ?? 0);

async function main() {
  console.log(`Online payment settlement, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) return;
  ck(
    'a webhook secret is configured',
    WEBHOOK_SECRET.length > 0,
    WEBHOOK_SECRET.length ? `${WEBHOOK_SECRET.length} chars` : 'EMPTY — every signature check below is meaningless',
  );

  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient);
  if (!patient) return;

  let seq = 0;
  /** A pending bill with an online payment awaiting the gateway, as
   *  `createOnlineOrder` leaves things once Razorpay has issued an order. */
  async function makeOrder(amount: number) {
    seq += 1;
    const bill = await p.bill.create({
      data: {
        tenantId: TENANT,
        patientId: patient!.id,
        billNumber: `${TAG}-B${seq}`,
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
    const orderId = `order_${TAG}_${seq}`;
    const payment = await p.payment.create({
      data: {
        tenantId: TENANT,
        billId: bill.id,
        patientId: patient!.id,
        paymentDate: new Date(),
        amount,
        paymentMethod: 'upi',
        paymentSource: 'online',
        paymentType: 'regular',
        status: 'pending',
        gatewayReference: orderId,
        notes: 'Online payment via Razorpay',
      },
      select: { id: true },
    });
    await p.paymentTransfer.create({
      data: {
        tenantId: TENANT,
        paymentId: payment.id,
        razorpayOrderId: orderId,
        totalAmount: amount,
        commissionAmount: 0,
        hospitalAmount: amount,
        commissionPercent: 0,
        transferStatus: 'pending',
      },
    });
    return { billId: bill.id, paymentId: payment.id, orderId };
  }

  const captured = (orderId: string, rzpPaymentId: string) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: rzpPaymentId, order_id: orderId } } },
  });

  try {
    // -- A forged webhook must not settle anything ----------------------------
    section('A webhook nobody can prove came from the gateway');
    const forged = await makeOrder(1500);
    const noSig = await webhook(captured(forged.orderId, 'pay_forged_1'));
    ck(
      'an unsigned webhook is refused',
      noSig.status === 401,
      `HTTP ${noSig.status} ${noSig.message} — this endpoint has no auth by design, so the ` +
        `signature is the only thing standing between the internet and marking bills paid`,
    );

    const badSig = await webhook(captured(forged.orderId, 'pay_forged_2'), { sign: 'deadbeef' });
    ck('a wrongly-signed webhook is refused', badSig.status === 401, `HTTP ${badSig.status} ${badSig.message}`);

    const stillPending = await p.payment.findUnique({ where: { id: forged.paymentId } });
    const forgedBill = await p.bill.findUnique({ where: { id: forged.billId } });
    ck(
      'and neither moved any money',
      stillPending?.status === 'pending' && money(forgedBill?.amountPaid) === 0,
      `payment ${stillPending?.status}, bill paid ${money(forgedBill?.amountPaid)}`,
    );

    // -- The real thing --------------------------------------------------------
    section('The gateway reporting a captured payment');
    const good = await makeOrder(2400);
    const ok = await webhook(captured(good.orderId, 'pay_real_1'), { sign: true });
    ck('a correctly-signed webhook is accepted', ok.status === 200, `HTTP ${ok.status} ${ok.message}`);

    const settled = await p.payment.findUnique({
      where: { id: good.paymentId },
      include: { receipt: true },
    });
    ck('the payment is completed', settled?.status === 'completed', String(settled?.status));
    ck('the gateway reference is kept', settled?.transactionId === 'pay_real_1', String(settled?.transactionId));
    ck(
      'a receipt is issued, as at the counter',
      !!settled?.receipt?.receiptNumber,
      settled?.receipt?.receiptNumber ?? 'none — a patient who paid online had nothing to download',
    );
    const goodBill = await p.bill.findUnique({ where: { id: good.billId } });
    ck(
      'and the bill is settled',
      goodBill?.status === 'paid' && money(goodBill?.balanceDue) === 0,
      `${goodBill?.status}, due ${money(goodBill?.balanceDue)}`,
    );

    // -- Razorpay retries. It must not pay twice -------------------------------
    section('The same webhook arriving again');
    const replay = await webhook(captured(good.orderId, 'pay_real_1'), { sign: true });
    ck('a replay is accepted rather than retried forever', replay.status === 200, `HTTP ${replay.status}`);
    const afterReplay = await p.bill.findUnique({ where: { id: good.billId } });
    ck(
      'but the bill is not paid a second time',
      money(afterReplay?.amountPaid) === 2400,
      `paid ${money(afterReplay?.amountPaid)}, expected 2400`,
    );
    ck(
      'and only one receipt exists for it',
      (await p.receipt.count({ where: { payment: { billId: good.billId } } })) === 1,
      String(await p.receipt.count({ where: { payment: { billId: good.billId } } })),
    );

    // -- A payment that failed at the gateway ----------------------------------
    section('The gateway reporting a failure');
    const failed = await makeOrder(900);
    const failEvent = await webhook(
      {
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_failed_1', order_id: failed.orderId } } },
      },
      { sign: true },
    );
    ck('the failure is accepted', failEvent.status === 200, `HTTP ${failEvent.status}`);
    const failedPayment = await p.payment.findUnique({ where: { id: failed.paymentId } });
    ck('the payment is marked failed', failedPayment?.status === 'failed', String(failedPayment?.status));
    const failedBill = await p.bill.findUnique({ where: { id: failed.billId } });
    ck(
      'and the bill still owes the money',
      money(failedBill?.balanceDue) === 900,
      `due ${money(failedBill?.balanceDue)}`,
    );

    // -- An event for an order this hospital never placed -----------------------
    section('An event for an order we know nothing about');
    const unknown = await webhook(captured('order_never_seen', 'pay_x'), { sign: true });
    ck(
      'it is acknowledged, not retried forever',
      unknown.status === 200,
      `HTTP ${unknown.status} — a 500 here would have Razorpay re-sending indefinitely`,
    );

    // -- The browser callback --------------------------------------------------
    section('The browser reporting back after checkout');
    const viaVerify = await makeOrder(1800);
    const badVerify = await api('admin', 'POST', '/online-payments/verify', {
      razorpay_order_id: viaVerify.orderId,
      razorpay_payment_id: 'pay_browser_1',
      razorpay_signature: 'not-the-right-signature',
    });
    ck(
      'a forged callback is refused',
      badVerify.status === 400,
      `HTTP ${badVerify.status} ${badVerify.message}`,
    );
    ck(
      'and it settles nothing',
      (await p.payment.findUnique({ where: { id: viaVerify.paymentId } }))?.status === 'pending',
    );

    const realSig = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${viaVerify.orderId}|pay_browser_1`)
      .digest('hex');
    const goodVerify = await api('admin', 'POST', '/online-payments/verify', {
      razorpay_order_id: viaVerify.orderId,
      razorpay_payment_id: 'pay_browser_1',
      razorpay_signature: realSig,
    });
    ck('a genuine callback is accepted', goodVerify.status === 200, `HTTP ${goodVerify.status} ${goodVerify.message}`);
    ck('and settles the bill without waiting for the webhook', goodVerify.data?.alreadySettled === false, String(goodVerify.data?.alreadySettled));
    const verifyBill = await p.bill.findUnique({ where: { id: viaVerify.billId } });
    ck('the bill is paid', verifyBill?.status === 'paid', String(verifyBill?.status));

    // The webhook then arrives for the same payment — it must be a no-op.
    const lateWebhook = await webhook(captured(viaVerify.orderId, 'pay_browser_1'), { sign: true });
    ck('the webhook arriving afterwards is harmless', lateWebhook.status === 200, `HTTP ${lateWebhook.status}`);
    ck(
      'and the bill is still paid exactly once',
      money((await p.bill.findUnique({ where: { id: viaVerify.billId } }))?.amountPaid) === 1800,
      'whichever of the two arrives second must be a no-op',
    );

    // -- Ordering online when the hospital cannot be paid ----------------------
    section('Asking for an order the hospital cannot receive');
    const noBank = await makeOrder(500);
    const order = await api('admin', 'POST', '/online-payments/create-order', { billId: noBank.billId });
    const tenant = await p.tenant.findUnique({
      where: { id: TENANT },
      select: { linkedAccountId: true, bankVerified: true },
    });
    if (!tenant?.linkedAccountId || !tenant.bankVerified) {
      ck(
        'an unlinked hospital is told so, rather than the patient reaching a broken checkout',
        order.status === 400 && /bank/i.test(order.message),
        `HTTP ${order.status} ${order.message}`,
      );
    } else {
      ck('the hospital has a linked account, so ordering needs live keys', true, 'skipped');
    }
  } finally {
    section('Cleanup');
    const billIds = (
      await p.bill.findMany({ where: { billNumber: { startsWith: TAG } }, select: { id: true } })
    ).map((b) => b.id);
    await p.paymentTransfer.deleteMany({ where: { payment: { billId: { in: billIds } } } });
    await p.receipt.deleteMany({ where: { payment: { billId: { in: billIds } } } });
    await p.payment.deleteMany({ where: { billId: { in: billIds } } });
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
