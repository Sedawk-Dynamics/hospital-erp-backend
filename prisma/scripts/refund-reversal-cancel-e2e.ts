/**
 * Refund, reversal and cancellation — walked end to end.
 *
 * These are the three ways money that has already been collected gets undone,
 * and between them they had one row on the live database. Each moves the same
 * two figures — what the bill says was paid, and what it says is still due — so
 * the assertions below are about those numbers, not about status codes.
 *
 * The money must be counted exactly once. A refund writes TWO rows: the Refund
 * itself and a payout Payment marked `refund`, and `computeBillPaid` subtracts
 * the first while excluding the second. Count both and the bill goes doubly
 * unpaid; count neither and the cash walks out untracked.
 *
 *   npm run db:check-refund-reversal      (needs the dev server up)
 *
 * Fixtures are tagged RRC-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `RRC-${Date.now()}`;
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

async function billState(billId: string) {
  const b = await p.bill.findUnique({
    where: { id: billId },
    select: { status: true, amountPaid: true, balanceDue: true, totalAmount: true },
  });
  return {
    status: String(b?.status),
    paid: money(b?.amountPaid),
    due: money(b?.balanceDue),
    total: money(b?.totalAmount),
  };
}

async function main() {
  console.log(`Refund, reversal and cancellation, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) return;

  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient);
  if (!patient) return;

  let billSeq = 0;
  async function makeBill(amount: number, status = 'pending') {
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
        description: `${TAG} service`,
        category: 'procedure',
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
      },
    });
    return bill.id;
  }

  /** Collect the full amount through the counter, so the ledger is real. */
  async function pay(billId: string, amount: number) {
    const res = await api('admin', 'POST', '/billing/payments', {
      billId,
      amount,
      paymentMethod: 'cash',
    });
    return res;
  }

  try {
    // -- Refund ---------------------------------------------------------------
    section('Refunding part of what was collected');
    const b1 = await makeBill(2000);
    const pay1 = await pay(b1, 2000);
    ck('the bill is paid in full', pay1.status === 201 || pay1.status === 200, `HTTP ${pay1.status} ${pay1.message}`);
    const paidState = await billState(b1);
    ck('and reads as paid', paidState.status === 'paid' && paidState.paid === 2000, JSON.stringify(paidState));

    const paymentId = (await p.payment.findFirst({
      where: { billId: b1, paymentType: 'regular' },
      select: { id: true },
    }))!.id;

    const tooMuch = await api('admin', 'POST', '/billing/refunds', {
      paymentId,
      amount: 2500,
      reason: 'More than was paid',
    });
    ck('refunding more than was paid is refused', tooMuch.status === 400, `HTTP ${tooMuch.status} ${tooMuch.message}`);

    const req1 = await api('admin', 'POST', '/billing/refunds', {
      paymentId,
      amount: 500,
      reason: 'Procedure not performed',
    });
    ck('a refund can be requested', req1.status === 201 || req1.status === 200, `HTTP ${req1.status} ${req1.message}`);
    ck('it starts as a request, not a payout', req1.data?.status === 'requested', String(req1.data?.status));
    ck('and records who asked', !!req1.data?.requestedBy, String(req1.data?.requestedBy));

    const whileRequested = await billState(b1);
    ck(
      'requesting a refund moves no money',
      whileRequested.paid === 2000 && whileRequested.status === 'paid',
      JSON.stringify(whileRequested) + ' — the money must not leave before approval',
    );

    const approve1 = await api('admin', 'PATCH', `/billing/refunds/${req1.data?.id}/approve`);
    ck('the refund can be approved', approve1.status === 200, `HTTP ${approve1.status} ${approve1.message}`);

    const afterRefund = await billState(b1);
    ck(
      'the bill now shows only what the patient really paid',
      afterRefund.paid === 1500,
      `paid ${afterRefund.paid}, expected 1500 — a refund writes both a Refund row and a payout ` +
        `Payment; counting both would show 1000`,
    );
    ck('with the balance reopened', afterRefund.due === 500, `due ${afterRefund.due}`);
    ck('and the bill back to partly paid', afterRefund.status === 'partially_paid', afterRefund.status);

    const payout = await p.payment.findFirst({
      where: { billId: b1, paymentType: 'refund' },
      include: { receipt: true },
    });
    ck('cash leaving the counter is recorded as its own payment', !!payout, 'so the drawer can be tallied');
    ck('marked as a refund, not a collection', payout?.paymentType === 'refund', String(payout?.paymentType));
    ck('handed back the way it came in', payout?.paymentMethod === 'cash', String(payout?.paymentMethod));
    ck('and the patient signs for it', !!payout?.receipt?.receiptNumber, String(payout?.receipt?.receiptNumber));

    const overRest = await api('admin', 'POST', '/billing/refunds', {
      paymentId,
      amount: 1600,
      reason: 'Over the remainder',
    });
    ck(
      'a second refund cannot take more than is left of that payment',
      overRest.status === 400,
      `HTTP ${overRest.status} ${overRest.message}`,
    );

    // -- Rejecting a refund ----------------------------------------------------
    section('A rejected refund pays out nothing');
    const req2 = await api('admin', 'POST', '/billing/refunds', {
      paymentId,
      amount: 300,
      reason: 'Will be rejected',
    });
    const beforeReject = await billState(b1);
    const reject = await api('admin', 'PATCH', `/billing/refunds/${req2.data?.id}/reject`, {
      reason: 'Service was delivered',
    });
    ck('the rejection is accepted', reject.status === 200, `HTTP ${reject.status} ${reject.message}`);
    const afterReject = await billState(b1);
    ck(
      'and the bill is untouched',
      afterReject.paid === beforeReject.paid && afterReject.due === beforeReject.due,
      `${JSON.stringify(beforeReject)} -> ${JSON.stringify(afterReject)}`,
    );
    ck(
      'no second payout was written',
      (await p.payment.count({ where: { billId: b1, paymentType: 'refund' } })) === 1,
    );

    // -- Reversal --------------------------------------------------------------
    section('Reversing a payment taken in error');
    const b2 = await makeBill(1200);
    await pay(b2, 1200);
    const pay2Id = (await p.payment.findFirst({
      where: { billId: b2, paymentType: 'regular' },
      select: { id: true },
    }))!.id;

    const rev = await api('admin', 'POST', '/billing/reversals', {
      paymentId: pay2Id,
      reason: 'Charged the wrong patient',
    });
    ck('the reversal is accepted', rev.status === 201 || rev.status === 200, `HTTP ${rev.status} ${rev.message}`);
    const afterRev = await billState(b2);
    ck(
      'the bill goes back to owing the whole amount',
      afterRev.paid === 0 && afterRev.due === 1200,
      JSON.stringify(afterRev),
    );
    ck('and is pending again, not paid', afterRev.status === 'pending', afterRev.status);
    const reversed = await p.payment.findUnique({ where: { id: pay2Id } });
    ck('the payment is marked reversed', reversed?.status === 'reversed', String(reversed?.status));
    ck(
      'and says why, on the row itself',
      (reversed?.notes ?? '').includes('Charged the wrong patient'),
      reversed?.notes ?? '(none)',
    );

    const revAgain = await api('admin', 'POST', '/billing/reversals', {
      paymentId: pay2Id,
      reason: 'Trying again',
    });
    ck('reversing twice is refused', revAgain.status === 400, `HTTP ${revAgain.status} ${revAgain.message}`);

    // -- Where the two undo paths meet -----------------------------------------
    // A payment that has already been refunded in part is still `completed`, so
    // nothing stops it being reversed as well. Reversal drops it out of the
    // collected sum while the approved Refund is still subtracted, so the same
    // ₹500 comes off twice.
    section('Reversing a payment that was already partly refunded');
    const b3 = await makeBill(2000);
    await pay(b3, 2000);
    const pay3Id = (await p.payment.findFirst({
      where: { billId: b3, paymentType: 'regular' },
      select: { id: true },
    }))!.id;
    const r3 = await api('admin', 'POST', '/billing/refunds', {
      paymentId: pay3Id,
      amount: 500,
      reason: 'Partial refund first',
    });
    await api('admin', 'PATCH', `/billing/refunds/${r3.data?.id}/approve`);
    ck('after a ₹500 refund the bill shows ₹1,500 paid', (await billState(b3)).paid === 1500);

    const doubleUndo = await api('admin', 'POST', '/billing/reversals', {
      paymentId: pay3Id,
      reason: 'And now reverse the whole thing',
    });
    const afterBoth = await billState(b3);
    ck(
      'the bill never claims the patient is owed money',
      afterBoth.paid >= 0,
      `paid ${afterBoth.paid} — reversal removes the ₹2,000 from the collected sum while the ` +
        `approved ₹500 refund is still subtracted, so the same ₹500 is taken off twice ` +
        `(reversal returned HTTP ${doubleUndo.status})`,
    );
    ck(
      'and never claims more is due than the bill is worth',
      afterBoth.due <= afterBoth.total,
      `due ${afterBoth.due} on a bill of ${afterBoth.total}`,
    );

    // -- Cancellation ----------------------------------------------------------
    section('Cancelling a bill');
    const b4 = await makeBill(800);
    await pay(b4, 800);
    const cancelPaid = await api('admin', 'PATCH', `/billing/${b4}/cancel`, {
      reason: 'Raised against the wrong patient',
    });
    ck(
      'a bill with money on it cannot simply be cancelled',
      cancelPaid.status === 400,
      `HTTP ${cancelPaid.status} ${cancelPaid.message}`,
    );

    const b5 = await makeBill(800);
    const cancelClean = await api('admin', 'PATCH', `/billing/${b5}/cancel`, {
      reason: 'Duplicate of another bill',
    });
    ck('an unpaid bill can be', cancelClean.status === 200, `HTTP ${cancelClean.status} ${cancelClean.message}`);
    ck(
      'and a cancellation receipt is issued for the record',
      !!cancelClean.data?.cancellationReceiptNumber,
      String(cancelClean.data?.cancellationReceiptNumber),
    );
    const cancelReceipt = await p.receipt.findFirst({
      where: { receiptNumber: cancelClean.data?.cancellationReceiptNumber },
    });
    ck('for zero rupees, since no money moved', money(cancelReceipt?.amount) === 0, String(money(cancelReceipt?.amount)));
    ck('the bill reads as cancelled', (await billState(b5)).status === 'cancelled');

    const cancelTwice = await api('admin', 'PATCH', `/billing/${b5}/cancel`, {
      reason: 'Again',
    });
    ck('cancelling twice is refused', cancelTwice.status === 400, `HTTP ${cancelTwice.status}`);

    // A reversed payment leaves nothing collected, so the bill can be cancelled.
    const cancelAfterReversal = await api('admin', 'PATCH', `/billing/${b2}/cancel`, {
      reason: 'Reversed, now void the bill',
    });
    ck(
      'a bill whose only payment was reversed can be cancelled',
      cancelAfterReversal.status === 200,
      `HTTP ${cancelAfterReversal.status} ${cancelAfterReversal.message}`,
    );
  } finally {
    section('Cleanup');
    const billIds = (
      await p.bill.findMany({ where: { billNumber: { startsWith: TAG } }, select: { id: true } })
    ).map((b) => b.id);
    await p.refund.deleteMany({ where: { billId: { in: billIds } } });
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
