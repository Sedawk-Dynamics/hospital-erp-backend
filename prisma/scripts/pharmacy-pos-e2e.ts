/**
 * The pharmacy counter, walked end to end.
 *
 * A sale at the POS is the busiest write in the system: it moves stock, takes
 * money in several tenders at once, derives GST out of an MRP, prints a legal
 * invoice, and — for a scheduled drug — creates the record an inspector will
 * later read. Any one of those going quietly wrong is a shortfall somebody has
 * to explain at the end of the day.
 *
 *   npm run db:check-pharmacy-pos      (needs the dev server up)
 *
 * Fixtures are tagged POS-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `POS-${Date.now()}`;
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
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin@123' }),
  });
  const j: any = await res.json();
  tokens[key] = j?.data?.accessToken ?? j?.data?.tokens?.accessToken ?? '';
  return Boolean(tokens[key]);
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

/**
 * The counter returns { bill, hospital } — an invoice needs a letterhead. Every
 * assertion here is about the bill, so unwrap it once.
 *
 * The first run of this walk did not, and every money check read `undefined`.
 * Worse, `undefined` reached a Prisma `where: { billId }`, which Prisma treats
 * as "no filter" — so a payment check meant for one bill matched every payment
 * in the hospital. Hence `billOf`, which refuses to hand back an id it does
 * not have.
 */
const billOf = (res: any) => res?.data?.bill ?? res?.data;
const idOf = (res: any) => {
  const id = billOf(res)?.id;
  if (!id) throw new Error(`no bill id in the response: ${JSON.stringify(res?.json)?.slice(0, 200)}`);
  return id as string;
};

const sell = (body: unknown, as = 'pharm') => api(as, 'POST', '/pharmacy/sales', body);
const qty = async (id: string) =>
  (await p.drugBatch.findUnique({ where: { id }, select: { quantityInStock: true } }))?.quantityInStock ?? -1;
const money = (n: unknown) => Number(n ?? 0);
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) < tol;

async function main() {
  section('Signing in');
  ck('pharmacy admin', await login('pharm', 'pharmacyadmin1@email.com'));
  if (!tokens.pharm) return;
  const staff = await p.user.findFirst({
    where: {
      tenantId: TENANT, isActive: true, email: { not: 'pharmacyadmin1@email.com' },
      userRoles: { some: { role: { name: 'pharmacist' } } },
    },
    select: { email: true },
  });
  const havePharmacist = staff ? await login('staff', staff.email) : false;
  ck('a counter pharmacist', havePharmacist, staff?.email ?? 'no plain pharmacist user');

  // -- Sweep leftovers from a crashed run ----------------------------------
  const stale = await p.drugFormulary.findMany({
    where: { tenantId: TENANT, drugName: { startsWith: 'POS-' } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((d) => d.id);
    const b = (await p.drugBatch.findMany({ where: { drugId: { in: ids } }, select: { id: true } })).map((x) => x.id);
    const bills = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: b } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
    await p.drugReturn.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.payment.deleteMany({ where: { billId: { in: bills } } });
    await p.billItem.deleteMany({ where: { billId: { in: bills } } });
    await p.bill.deleteMany({ where: { id: { in: bills } } });
    await p.drugBatch.deleteMany({ where: { drugId: { in: ids } } });
    await p.drugFormulary.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (swept ${stale.length} leftover fixture drug(s) from an earlier run)`);
  }

  // -- Fixtures ------------------------------------------------------------
  section('Fixtures');
  const START = 1000;
  // A strip of 10, priced at MRP with GST inside it — the ordinary case.
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: `${TAG} Paracetamol 500`,
      genericName: 'Paracetamol',
      composition: 'Paracetamol (500mg)',
      strength: '500mg', dosageForm: 'tablet', unitOfMeasurement: 'tablet',
      packSize: 10, looseUnitLabel: 'tablet',
      price: 2, taxPercent: 12, hsnCode: '3004',
      schedule: 'OTC',
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-B1`,
      quantityReceived: START, quantityInStock: START,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 1.2, sellingPrice: 2, mrp: 2,
    } as never,
  });
  ck('a 10-tablet strip at MRP 2, 12% GST inside it', (await qty(batch.id)) === START);

  const line = (n: number, over: Record<string, unknown> = {}) => ({
    drugBatchId: batch.id, quantity: n, saleUnit: 'pack', ...over,
  });

  // -- 1. An ordinary sale -------------------------------------------------
  section('1. An ordinary walk-in sale');
  const one = await sell({ items: [line(3)], paymentMethod: 'cash' });
  ck('the sale goes through', one.status < 400, one.message || `status ${one.status}`);
  const bill1 = billOf(one);
  ck('it gets a PH- invoice number', /^PH-/.test(bill1?.billNumber ?? ''), bill1?.billNumber ?? '');
  ck('3 packs of 10 takes 30 tablets off the shelf', (await qty(batch.id)) === START - 30, `${await qty(batch.id)}`);
  ck('billed at 30 x 2', near(money(bill1?.totalAmount), 60), `${bill1?.totalAmount}`);
  ck(
    'GST is derived out of the MRP, not added on top',
    near(money(bill1?.taxAmount), 6.43),
    `tax ${bill1?.taxAmount} on a total of ${bill1?.totalAmount}`,
  );
  ck('paid in full', bill1?.status === 'paid' && near(money(bill1?.balanceDue), 0), `${bill1?.status}`);
  const item1 = (bill1?.billItems ?? [])[0];
  ck('the line says how many packs of what size', /pack of 10/.test(item1?.description ?? ''), item1?.description ?? '');
  ck('...and carries the batch and expiry a customer can check', /Batch .*Exp \d\d\/\d\d\/\d{4}/.test(item1?.description ?? ''));
  ck('a walk-in with no patient still gets billed to someone', Boolean(bill1?.patient?.id), bill1?.patient?.mrn ?? '');
  ck('one dispensing record was written', (await p.dispensingRecord.count({ where: { billId: bill1.id } })) === 1);

  // -- 2. Loose sale -------------------------------------------------------
  section('2. Selling loose tablets out of a strip');
  const loose = await sell({ items: [line(7, { saleUnit: 'loose' })], paymentMethod: 'cash' });
  ck('a loose sale goes through', loose.status < 400, loose.message);
  ck('7 loose tablets is 7 units, not 7 strips', (await qty(batch.id)) === START - 37, `${await qty(batch.id)}`);
  ck('billed at 7 x 2', near(money(billOf(loose)?.totalAmount), 14), `${billOf(loose)?.totalAmount}`);
  ck(
    'the line says loose, so the customer knows what they bought',
    /loose/.test((billOf(loose)?.billItems ?? [])[0]?.description ?? ''),
    (billOf(loose)?.billItems ?? [])[0]?.description ?? '',
  );

  // -- 3. What the counter must refuse -------------------------------------
  section('3. What the counter refuses');
  const none = await sell({ items: [line(0)], paymentMethod: 'cash' });
  ck('a quantity of zero', none.status >= 400, none.message);

  const tooMany = await sell({ items: [line(500)], paymentMethod: 'cash' });
  ck('more than the shelf holds', tooMany.status >= 400, tooMany.message);
  ck('...saying how much there is', /Available: \d+/.test(tooMany.message), tooMany.message);

  const expired: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-EXP`,
      quantityReceived: 100, quantityInStock: 100,
      expiryDate: new Date(Date.now() - 30 * 864e5), isExpired: true,
      purchasePrice: 1.2, sellingPrice: 2, mrp: 2,
    } as never,
  });
  const sellExpired = await sell({ items: [{ drugBatchId: expired.id, quantity: 1 }], paymentMethod: 'cash' });
  ck('an expired batch', sellExpired.status >= 400 && /expired/i.test(sellExpired.message), sellExpired.message);

  const recalled: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-REC`,
      quantityReceived: 100, quantityInStock: 100,
      expiryDate: new Date(Date.now() + 400 * 864e5), isRecalled: true,
      purchasePrice: 1.2, sellingPrice: 2, mrp: 2,
    } as never,
  });
  const sellRecalled = await sell({ items: [{ drugBatchId: recalled.id, quantity: 1 }], paymentMethod: 'cash' });
  ck('a recalled batch', sellRecalled.status >= 400 && /recall/i.test(sellRecalled.message), sellRecalled.message);

  const ghost = await sell({ items: [{ drugBatchId: '00000000-0000-0000-0000-000000000000', quantity: 1 }], paymentMethod: 'cash' });
  ck('a batch that does not exist', ghost.status >= 400, ghost.message);

  // -- 4. Money ------------------------------------------------------------
  section('4. Money');
  const disc = await sell({
    items: [line(5, { discountPercent: 10 })],
    billDiscountAmount: 5,
    paymentMethod: 'cash',
  });
  // 50 tablets x 2 = 100, less 10% line = 90, less 5 flat = 85.
  ck('a line discount and a bill discount both apply', near(money(billOf(disc)?.totalAmount), 85), `${billOf(disc)?.totalAmount}`);
  ck('the discount is reported as the sum of both', near(money(billOf(disc)?.discountAmount), 15), `${billOf(disc)?.discountAmount}`);
  ck(
    'and the GST shrinks with the bill, rather than staying at the undiscounted figure',
    near(money(billOf(disc)?.taxAmount), 9.11, 0.05),
    `tax ${billOf(disc)?.taxAmount} on ${billOf(disc)?.totalAmount}`,
  );

  const free = await sell({ items: [line(1)], billDiscountPercent: 100, paymentMethod: 'cash' });
  ck('a 100% discount bills nothing', near(money(billOf(free)?.totalAmount), 0), `${billOf(free)?.totalAmount}`);
  ck('...and is settled, not left owing', billOf(free)?.status === 'paid', billOf(free)?.status ?? '');

  const overCap = await sell({ items: [line(1)], billDiscountAmount: 9999, paymentMethod: 'cash' });
  ck('a discount larger than the bill cannot make it negative', money(billOf(overCap)?.totalAmount) >= 0, `${billOf(overCap)?.totalAmount}`);

  const part = await sell({ items: [line(5)], payments: [{ method: 'cash', amount: 40 }] });
  ck('paying part of it leaves a balance', near(money(billOf(part)?.balanceDue), 60), `${billOf(part)?.balanceDue}`);
  ck('...and the bill says partially paid', billOf(part)?.status === 'partially_paid', billOf(part)?.status ?? '');

  const change = await sell({ items: [line(1)], payments: [{ method: 'cash', amount: 500 }] });
  ck('cash over the total is change, not a credit', near(money(billOf(change)?.amountPaid), 20), `recorded ${billOf(change)?.amountPaid} against a total of ${billOf(change)?.totalAmount}`);
  const changePayments = await p.payment.findMany({ where: { billId: idOf(change) }, select: { amount: true } });
  ck(
    'and the payment row records what was kept, not what was handed over',
    near(changePayments.reduce((s, x) => s + Number(x.amount), 0), 20),
    `${changePayments.map((x) => x.amount).join(' + ')}`,
  );

  const split = await sell({
    items: [line(10)],
    payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 100, reference: `${TAG}-UPI` }],
  });
  ck('a split tender settles the bill', billOf(split)?.status === 'paid', `${billOf(split)?.status} bal ${billOf(split)?.balanceDue}`);
  const splitRows = await p.payment.findMany({ where: { billId: idOf(split) }, select: { paymentMethod: true, amount: true } });
  ck('each tender is its own row, so the day-end breakup is real', splitRows.length === 2, splitRows.map((r) => `${r.paymentMethod} ${r.amount}`).join(', '));

  // -- 5. Schedules --------------------------------------------------------
  section('5. Schedules');
  const schedX: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT, drugName: `${TAG} Alprazolam 0.5`, genericName: 'Alprazolam',
      composition: 'Alprazolam (0.5mg)', strength: '0.5mg',
      dosageForm: 'tablet', unitOfMeasurement: 'tablet', packSize: 10,
      price: 5, taxPercent: 12, hsnCode: '3004',
      schedule: 'X', scheduleReason: 'Schedule X', controlledClass: 'psychotropic',
    } as never,
  });
  const xBatch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: schedX.id, batchNumber: `${TAG}-X1`,
      quantityReceived: 100, quantityInStock: 100,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 3, sellingPrice: 5, mrp: 5,
    } as never,
  });

  const pre = await api('pharm', 'POST', '/pharmacy/sales/compliance-check', {
    items: [{ drugBatchId: xBatch.id }],
  });
  ck('the pre-check runs before anything moves', pre.status < 400, `status ${pre.status}`);
  const noRx = await sell({ items: [{ drugBatchId: xBatch.id, quantity: 1 }], paymentMethod: 'cash' });
  ck(
    'a Schedule X sale with no prescription is refused',
    noRx.status >= 400,
    noRx.message.slice(0, 80),
  );
  ck(
    'and the pre-check agrees with the refusal, rather than waving it through',
    pre.data?.ok === false || (pre.data?.blockers ?? []).length > 0 || (pre.data?.warnings ?? []).length > 0,
    `ok=${pre.data?.ok} blockers=${(pre.data?.blockers ?? []).length} warnings=${(pre.data?.warnings ?? []).length}`,
  );
  ck('nothing left the shelf on a refused sale', (await qty(xBatch.id)) === 100, `${await qty(xBatch.id)}`);

  const extRx = await api('pharm', 'POST', '/pharmacy/external-prescriptions', {
    prescriberName: `${TAG} Dr Paper`,
    prescriberRegNo: `${TAG}-REG`,
    prescribedDate: new Date().toISOString().slice(0, 10),
  });
  if (extRx.status < 400) {
    const withPaper = await sell({
      items: [{ drugBatchId: xBatch.id, quantity: 1 }],
      externalPrescriptionId: extRx.data?.id,
      paymentMethod: 'cash',
    });
    ck(
      'a paper prescription presented at the counter backs the sale',
      withPaper.status < 400,
      withPaper.message.slice(0, 80),
    );
    if (withPaper.status < 400) {
      const rec = await p.dispensingRecord.findFirst({
        where: { billId: idOf(withPaper) },
        select: { externalPrescriptionId: true },
      });
      ck('and is recorded on the dispense, not only on the bill', rec?.externalPrescriptionId === extRx.data?.id);
    }
  }

  // -- 6. A scheduled sale reaches the register ----------------------------
  section('6. A scheduled sale reaches the statutory register');
  const win = `fromDate=${new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)}&toDate=${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}`;
  const reg = await api('pharm', 'GET', `/pharmacy/controlled-register?${win}`);
  const xRows = (reg.data?.rows ?? []).filter((r: any) => r.itemName === `${TAG} Alprazolam 0.5`);
  ck('the counter sale is on the register', xRows.some((r: any) => r.txnType === 'Patient Disp.'), `${xRows.length} row(s)`);
  ck(
    'naming the prescriber it was sold against',
    xRows.some((r: any) => (r.prescriber ?? '').includes(`${TAG}-REG`)),
    xRows.map((r: any) => r.prescriber).filter(Boolean).join(' | ') || 'no prescriber on any row',
  );

  // -- 7. Voiding a sale ---------------------------------------------------
  section('7. Voiding a sale');
  const toVoid = await sell({ items: [line(2)], paymentMethod: 'cash' });
  ck('a sale to void', toVoid.status < 400, `${toVoid.status} ${toVoid.message} :: ${JSON.stringify(billOf(toVoid))?.slice(0, 120)}`);
  const voidId = idOf(toVoid);
  const before = await qty(batch.id);
  if (havePharmacist) {
    const byStaff = await api('staff', 'PATCH', `/pharmacy/sales/${voidId}/cancel`, { reason: `${TAG} test` });
    ck('a counter pharmacist cannot void a sale on their own', byStaff.status >= 400, `status ${byStaff.status}`);
  }
  const voided = await api('pharm', 'PATCH', `/pharmacy/sales/${voidId}/cancel`, { reason: `${TAG} wrong customer` });
  ck('a pharmacy admin can void it', voided.status < 400, voided.message);
  ck('the stock comes back', (await qty(batch.id)) === before + 20, `${await qty(batch.id)}`);
  ck('the bill is marked cancelled, not deleted', billOf(voided)?.status === 'cancelled', billOf(voided)?.status ?? '');
  ck('with the reason on it', /wrong customer/.test(billOf(voided)?.cancellationReason ?? ''), billOf(voided)?.cancellationReason ?? '');
  const reversed = await p.payment.findMany({ where: { billId: voidId }, select: { status: true } });
  ck('the money is reversed', reversed.every((r) => r.status === 'reversed'), reversed.map((r) => r.status).join(','));
  const twice = await api('pharm', 'PATCH', `/pharmacy/sales/${voidId}/cancel`, { reason: 'again' });
  ck('and it cannot be voided a second time', twice.status >= 400, twice.message);

  // A void must not erase the statutory record. Voiding a scheduled sale is
  // exactly when someone would want it gone, and exactly when it must not be.
  const xSale = await sell({
    items: [{ drugBatchId: xBatch.id, quantity: 1 }],
    ...(extRx.status < 400 ? { externalPrescriptionId: extRx.data?.id } : {}),
    paymentMethod: 'cash',
  });
  if (xSale.status < 400) {
    const regBefore = await api('pharm', 'GET', `/pharmacy/controlled-register?${win}`);
    const countBefore = (regBefore.data?.rows ?? []).filter((r: any) => r.itemName === `${TAG} Alprazolam 0.5` && r.txnType === 'Patient Disp.').length;
    const xVoid = await api('pharm', 'PATCH', `/pharmacy/sales/${idOf(xSale)}/cancel`, { reason: `${TAG} voided` });
    ck('the scheduled sale is voided', xVoid.status < 400, xVoid.message);
    const regAfter = await api('pharm', 'GET', `/pharmacy/controlled-register?${win}`);
    const countAfter = (regAfter.data?.rows ?? []).filter((r: any) => r.itemName === `${TAG} Alprazolam 0.5` && r.txnType === 'Patient Disp.').length;
    ck(
      'voiding a scheduled sale does not erase it from the register',
      countAfter >= countBefore,
      `${countBefore} dispense row(s) before the void, ${countAfter} after`,
    );
    ck(
      'and the register still balances against the shelf afterwards',
      regAfter.data?.summary?.closingBalance !== undefined &&
        regAfter.data?.summary?.openingStock + regAfter.data?.summary?.inward - regAfter.data?.summary?.outward
          - (regAfter.data?.summary?.transferredOut ?? 0) + (regAfter.data?.summary?.outwardAlreadyIssued ?? 0)
          === regAfter.data?.summary?.closingBalance,
      `closing ${regAfter.data?.summary?.closingBalance}`,
    );
  }

  // -- 8. The invoice and the day's takings --------------------------------
  section('8. The invoice and the day takings');
  const fetched = await api('pharm', 'GET', `/pharmacy/sales/${bill1.id}`);
  ck('an invoice can be reprinted', fetched.status < 400 && billOf(fetched)?.billNumber === bill1.billNumber, billOf(fetched)?.billNumber ?? '');
  ck('...with its lines and its tenders', (billOf(fetched)?.billItems ?? []).length > 0 && (billOf(fetched)?.payments ?? []).length > 0);

  const list = await api('pharm', 'GET', '/pharmacy/sales?limit=200');
  ck('the transactions page lists it', list.status < 400 && (list.data ?? []).some?.((b: any) => b.id === bill1.id), `${(list.data ?? []).length} invoice(s) listed`);

  const today = new Date().toISOString().slice(0, 10);
  const eod = await api('pharm', 'GET', `/pharmacy/reports/daily-transactions?date=${today}`);
  ck('the day-end report runs', eod.status < 400, `status ${eod.status}`);

  // -- 9. Two counters at once ---------------------------------------------
  section('9. Two counters billing at the same moment');
  // Invoice numbers are globally unique, so two tills claiming the same slot is
  // a real collision, not a hypothetical one. It must never reach the cashier.
  const together = await Promise.all([
    sell({ items: [line(1)], paymentMethod: 'cash' }),
    sell({ items: [line(1)], paymentMethod: 'cash' }),
    sell({ items: [line(1)], paymentMethod: 'cash' }),
  ]);
  ck('all three sales go through', together.every((r) => r.status < 400), together.map((r) => r.status).join(','));
  const numbers = together.map((r) => billOf(r)?.billNumber);
  ck('each gets its own invoice number', new Set(numbers).size === 3, numbers.join(', '));

  // -- 10. Nothing leaked ---------------------------------------------------
  section('10. Nothing leaked');
  const sold = await p.dispensingRecord.aggregate({
    where: { drugBatchId: batch.id },
    _sum: { quantityDispensed: true },
  });
  const onShelf = await qty(batch.id);
  ck(
    'what is left, plus what was sold, is what we started with',
    onShelf + (sold._sum.quantityDispensed ?? 0) === START,
    `${onShelf} + ${sold._sum.quantityDispensed} = ${onShelf + (sold._sum.quantityDispensed ?? 0)}, started ${START}`,
  );

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const drugIds = [drug.id, schedX.id];
  const batchIds = (await p.drugBatch.findMany({ where: { drugId: { in: drugIds } }, select: { id: true } })).map((b) => b.id);
  const billIds = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: batchIds } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
  const allBills = [...new Set([...billIds, ...(await p.billItem.findMany({ where: { description: { contains: TAG } }, select: { billId: true } })).map((b) => b.billId)])];
  await p.drugReturn.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.payment.deleteMany({ where: { billId: { in: allBills } } });
  await p.billItem.deleteMany({ where: { billId: { in: allBills } } });
  await p.bill.deleteMany({ where: { id: { in: allBills } } });
  await p.externalPrescription.deleteMany({ where: { prescriberRegNo: `${TAG}-REG` } });
  await p.drugBatch.deleteMany({ where: { drugId: { in: drugIds } } });
  await p.drugFormulary.deleteMany({ where: { id: { in: drugIds } } });
  ck('fixtures cleaned up', (await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } })) === 0);

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
