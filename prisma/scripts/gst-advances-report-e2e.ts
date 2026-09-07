/**
 * Walk the A-10 advances report through the real API.
 *
 * The report is the only place three separate money movements are stitched into
 * one picture — an advance received, an advance drawn down against an invoice,
 * and an advance handed back — so a walk has to make all three happen and then
 * read the report, rather than assert each writer in isolation.
 *
 * Two things a unit test cannot catch and this can:
 *   - `validate()` REPLACES req.query with the parsed object, so a filter that
 *     is not named in the zod schema is silently dropped. Every filter is sent
 *     over the wire here for that reason.
 *   - deposit money moving ONTO a bill is also a paymentType 'advance' row. If
 *     the IPDEP: exclusion ever stopped matching, the report would double-count
 *     every deposit it has already reported once.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';
import * as billing from '../../src/modules/billing/billing.service';
import * as clinical from '../../src/modules/clinical/clinical.service';

const BASE = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `ADVRPT-${Date.now()}`;

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;
/** `[].every()` is true, and a walk that passes on no rows has asserted nothing. */
const all = (xs: any, fn: (x: any) => boolean) =>
  Array.isArray(xs) && xs.length > 0 && xs.every(fn);
const today = () => new Date().toISOString().slice(0, 10);

async function api(path: string, opts: any = {}, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Tenant-Id': TENANT,
      ...(opts.headers ?? {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@hospital.com', password: 'Admin@123' },
  });
  ck('logged in', login.status === 200, `status ${login.status}`);
  const token = login.json?.data?.accessToken;
  if (!token) throw new Error('no token');

  const actor = await prisma.user.findFirst({ where: { email: 'admin@hospital.com' }, select: { id: true } });
  const doctor = await prisma.doctorProfile.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  if (!actor || !doctor) throw new Error('need a user and a doctor');
  const ACTOR = actor.id;
  const ledgerActor = { userId: ACTOR, roles: ['admin'] };

  // A patient of their own, so the report can be scoped and the figures are
  // exactly what this walk put there. No surname: a patient with none is the
  // ordinary TEMP case and the report must not print "null" for them.
  const patient = await prisma.patient.create({
    data: { tenantId: TENANT, mrn: TAG, firstName: 'Advance', notes: TAG },
  });

  const report = async (query = '') => {
    const r = await api(`/gst/reports/advances?patientId=${patient.id}${query}`, {}, token);
    return r;
  };

  // ── 1. Two advances at the desk, one taxable and one not ──
  const taxable = await api('/billing/payments/advance', {
    method: 'POST',
    body: {
      patientId: patient.id,
      amount: 10000,
      paymentMethod: 'cash',
      // Against a deluxe room the hospital already knows is over the threshold,
      // so tax falls due at receipt rather than at the invoice.
      purpose: 'accommodation',
      notes: `${TAG} deluxe room`,
    },
  }, token);
  ck('a taxable advance was accepted', taxable.status === 201,
     `status ${taxable.status} ${JSON.stringify(taxable.json).slice(0, 160)}`);

  const exempt = await api('/billing/payments/advance', {
    method: 'POST',
    body: { patientId: patient.id, amount: 5000, paymentMethod: 'upi', notes: `${TAG} deposit` },
  }, token);
  ck('an ordinary advance was accepted', exempt.status === 201, `status ${exempt.status}`);

  let r = await report();
  ck('the report is reachable', r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  let d = r.json?.data;
  ck('both advances are reported', d?.rows?.length === 2, `${d?.rows?.length} rows`);
  ck('the money received is the money taken', near(Number(d?.summary?.amountReceived), 15000),
     `${d?.summary?.amountReceived}`);
  ck('nothing is adjusted yet, so all of it is still held',
     near(Number(d?.summary?.balanceOutstanding), 15000), `${d?.summary?.balanceOutstanding}`);

  // Table 11A is the taxable half only. An exempt deposit is exempt turnover.
  const t11a = d?.summary?.taxDueOnAdvances;
  ck('only the taxable advance sits in table 11A', t11a?.count === 1, `${t11a?.count}`);
  ck('its tax is dug OUT of the money taken, not added on top',
     near(Number(t11a?.taxableValue), 9523.81) && near(Number(t11a?.taxAmount), 476.19),
     `${t11a?.taxableValue} + ${t11a?.taxAmount}`);
  ck('and it is split CGST/SGST for a patient in this state',
     near(Number(t11a?.cgstAmount) + Number(t11a?.sgstAmount), 476.19) && Number(t11a?.igstAmount) === 0,
     `c${t11a?.cgstAmount} s${t11a?.sgstAmount} i${t11a?.igstAmount}`);
  ck('every advance carries a receipt voucher number',
     all(d?.rows, (x: any) => /^RV\/\d{4}-\d{2}\/\d{6}$/.test(String(x.voucherNumber ?? ''))),
     `${d?.rows?.map((x: any) => x.voucherNumber).join(', ')}`);
  ck('a patient with no surname is not named "null"',
     all(d?.rows, (x: any) => x.patientName === 'Advance'), `${d?.rows?.[0]?.patientName}`);
  ck('both came in at the desk', all(d?.rows, (x: any) => x.source === 'desk_advance'));
  ck('nothing is unclassified', d?.summary?.unclassifiedCount === 0,
     `${d?.summary?.unclassifiedCount}`);

  // ── 2. Draw part of it down against a bill — table 11B ──
  const bill = await billing.createBill(TENANT, ACTOR, { patientId: patient.id } as any);
  // Through pull-charges, because a line needs a category for the resolver to
  // classify it — finalising refuses a line whose GST position is unknown.
  const charged = await api(`/billing/${bill.id}/pull-charges`, {
    method: 'POST',
    body: {
      charges: [{
        referenceType: 'manual_clinical', referenceId: `${TAG}-consult`,
        description: `${TAG} consultation`, quantity: 1, unitPrice: 4000,
        category: 'consultation', taxRate: 0,
      }],
    },
  }, token);
  ck('a charge was pulled onto the bill', charged.status === 201,
     `status ${charged.status} ${JSON.stringify(charged.json).slice(0, 160)}`);

  // A draft bill is still open for charges, so nothing can be set against it.
  await billing.finalizeBill(TENANT, ACTOR, bill.id);

  const adjusted = await api('/billing/payments/advance/adjust', {
    method: 'POST',
    body: { patientId: patient.id, billId: bill.id, amount: 4000 },
  }, token);
  ck('an advance was adjusted onto a bill', adjusted.status === 200 || adjusted.status === 201,
     `status ${adjusted.status} ${JSON.stringify(adjusted.json).slice(0, 200)}`);

  d = (await report()).json?.data;
  ck('the adjustment is reported under table 11B',
     d?.summary?.adjustedAgainstInvoices?.count === 1 &&
       near(Number(d?.summary?.adjustedAgainstInvoices?.amount), 4000),
     JSON.stringify(d?.summary?.adjustedAgainstInvoices));
  ck('and it comes off what is still held',
     near(Number(d?.summary?.balanceOutstanding), 11000), `${d?.summary?.balanceOutstanding}`);
  const withAdj = d?.rows?.find((x: any) => x.adjustments?.length);
  ck('the adjustment names the document it went onto',
     !!withAdj?.adjustments?.[0]?.billNumber, JSON.stringify(withAdj?.adjustments?.[0]));

  // ── 3. An admission deposit reports beside a desk advance ──
  const visit = await prisma.visit.create({
    data: {
      tenantId: TENANT, patientId: patient.id, doctorId: doctor.id,
      visitDate: new Date(), visitType: 'ip', status: 'completed', chiefComplaint: TAG,
    },
  });
  const adm: any = await clinical.createAdmission(TENANT, ACTOR, {
    visitId: visit.id,
    patientId: patient.id,
    doctorId: doctor.id,
    admissionDate: new Date().toISOString(),
    admissionReason: TAG,
    depositAmount: 20000,
    depositPaymentMethod: 'card',
  } as any);
  ck('admitted with a deposit', !!adm?.id);

  d = (await report()).json?.data;
  ck('the deposit is reported as an advance', d?.rows?.length === 3, `${d?.rows?.length} rows`);
  const dep = d?.rows?.find((x: any) => x.source === 'admission_deposit');
  ck('and is marked as coming in at admission, not at the desk', !!dep, 'no admission_deposit row');
  ck('a treatment deposit is exempt — no tax invented on the way in',
     dep?.gstTreatment === 'exempt' && Number(dep?.taxAmount) === 0,
     `${dep?.gstTreatment} / ${dep?.taxAmount}`);
  ck('all of the money is accounted for', near(Number(d?.summary?.amountReceived), 35000),
     `${d?.summary?.amountReceived}`);

  // ── 4. Applying the deposit must not read as new money ──
  // A charge to apply it against — the deposit cannot come off an empty bill.
  await billing.addIpCharge(TENANT, ACTOR, adm.id, {
    description: `${TAG} ward charge`, quantity: 1, unitPrice: 6000, category: 'procedure',
  }, ['admin']).catch((e: any) => console.log('    (addIpCharge: ' + e.message + ')'));
  await billing.applyDepositToBill(TENANT, ACTOR, adm.id, ledgerActor, { amount: 6000 })
    .catch((e: any) => console.log('    (applyDepositToBill: ' + e.message + ')'));

  const applied = await prisma.payment.findFirst({
    where: { tenantId: TENANT, patientId: patient.id, transactionId: { startsWith: 'IPDEP:' } },
  });
  ck('the applied deposit really is an advance-typed row', applied?.paymentType === 'advance',
     `${applied?.paymentType}`);
  d = (await report()).json?.data;
  // If the exclusion ever broke, this is where it shows: 4 rows and ₹41,000
  // received, on a patient who only ever handed over ₹35,000.
  ck('applying it is money moving, not money arriving', d?.rows?.length === 3,
     `${d?.rows?.length} rows`);
  ck('so the money received does not grow', near(Number(d?.summary?.amountReceived), 35000),
     `${d?.summary?.amountReceived}`);

  // ── 5. Hand some back — a refund voucher, not an adjustment ──
  await billing.refundDeposit(TENANT, ACTOR, adm.id, ledgerActor, {
    amount: 5000, reason: `${TAG} returned`,
  }).catch((e: any) => console.log('    (refundDeposit: ' + e.message + ')'));

  d = (await report()).json?.data;
  ck('the money handed back is reported as refunded',
     near(Number(d?.summary?.amountRefunded), 5000), `${d?.summary?.amountRefunded}`);
  // Nothing was supplied for it, so reporting it under 11B would claim a supply
  // that never happened.
  ck('and NOT as an advance adjusted against an invoice',
     d?.summary?.adjustedAgainstInvoices?.count === 1,
     `${d?.summary?.adjustedAgainstInvoices?.count}`);
  const refunded = d?.rows?.find((x: any) => x.refunds?.length);
  ck('the refund carries its own voucher number',
     /^RFV\/\d{4}-\d{2}\/\d{6}$/.test(String(refunded?.refunds?.[0]?.voucherNumber ?? '')),
     `${refunded?.refunds?.[0]?.voucherNumber}`);
  ck('an exempt deposit reverses no tax, and prints no "-0.00"',
     Number(refunded?.refunds?.[0]?.taxReversed) === 0 &&
       !Object.is(Number(refunded?.refunds?.[0]?.taxReversed), -0),
     `${refunded?.refunds?.[0]?.taxReversed}`);

  // ── 6. The filters survive validate() ──
  d = (await report('&treatment=taxable')).json?.data;
  ck('the treatment filter reaches the query', d?.rows?.length === 1, `${d?.rows?.length} rows`);
  ck('and it is the taxable one', d?.rows?.[0]?.gstTreatment === 'taxable',
     `${d?.rows?.[0]?.gstTreatment}`);

  d = (await report(`&from=${today()}&to=${today()}`)).json?.data;
  ck('a period covering today keeps every row', d?.rows?.length === 3, `${d?.rows?.length} rows`);
  d = (await report('&from=2020-01-01&to=2020-01-31')).json?.data;
  ck('a period before any of it keeps none', d?.rows?.length === 0, `${d?.rows?.length} rows`);

  const bad = await api('/gst/reports/advances?from=01-09-2026', {}, token);
  ck('a malformed date is refused rather than silently ignored', bad.status === 400,
     `status ${bad.status}`);

  // ── 7. The gate ──
  // billing:read is too wide — a doctor holds it. The report shows the
  // hospital's whole turnover and tax position, so it needs billing:approve.
  const doc = await prisma.user.findFirst({
    where: { tenantId: TENANT, isActive: true, userRoles: { some: { role: { name: 'doctor' } } } },
    select: { email: true },
  });
  if (doc?.email) {
    const asDoc = await api('/auth/login', {
      method: 'POST', body: { email: doc.email, password: 'Admin@123' },
    });
    if (asDoc.status === 200) {
      const denied = await api('/gst/reports/advances', {}, asDoc.json?.data?.accessToken);
      ck('a doctor cannot read the hospital-wide advances report', denied.status === 403,
         `status ${denied.status}`);
    } else {
      console.log('    (skipped the doctor gate — could not sign one in)');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .finally(async () => {
    const pat = await prisma.patient.findFirst({ where: { mrn: TAG }, select: { id: true } });
    if (pat) {
      const pays = await prisma.payment.findMany({ where: { patientId: pat.id }, select: { id: true } });
      const ids = pays.map((p) => p.id);
      await prisma.refund.deleteMany({ where: { paymentId: { in: ids } } });
      // Self-relation: a drawdown points at the receipt it came out of, so the
      // links have to go before the rows.
      await prisma.payment.updateMany({
        where: { sourceAdvancePaymentId: { in: ids } },
        data: { sourceAdvancePaymentId: null },
      });
      await prisma.receipt.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.payment.deleteMany({ where: { id: { in: ids } } });
      const bills = await prisma.bill.findMany({ where: { patientId: pat.id }, select: { id: true } });
      const billIds = bills.map((b) => b.id);
      await prisma.billItem.deleteMany({ where: { billId: { in: billIds } } });
      await prisma.bill.deleteMany({ where: { id: { in: billIds } } });
      await prisma.admission.deleteMany({ where: { patientId: pat.id, admissionReason: TAG } });
      await prisma.visit.deleteMany({ where: { patientId: pat.id } });
      await prisma.patient.deleteMany({ where: { id: pat.id } });
    }
    // NOTE: the document series counter is deliberately NOT reset. Rolling it
    // back would hand an already-issued voucher number out a second time.
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
