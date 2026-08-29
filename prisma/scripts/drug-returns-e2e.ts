/**
 * Drug returns, walked end to end.
 *
 * Three different things share one table, and they move stock in opposite
 * directions: a PATIENT brings medicine back (stock in, money out), a WALK-IN
 * hands something over the counter with no bill behind it (stock in, maybe
 * money out), and the pharmacy sends damaged stock BACK TO A VENDOR (stock out,
 * money in as a credit note). A controlled drug does none of those — it is held
 * in quarantine, because a narcotic that has left the building cannot go back
 * on the sellable shelf.
 *
 * The ways this goes wrong are about quantity and money: returning more than
 * was sold, returning the same line twice, refunding at the wrong price,
 * crediting a vendor for stock that was never there.
 *
 *   npm run db:check-drug-returns      (needs the dev server up)
 *
 * Fixtures are tagged RET-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `RET-${Date.now()}`;
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

const billOf = (res: any) => res?.data?.bill ?? res?.data;
const idOf = (res: any) => {
  const id = billOf(res)?.id;
  if (!id) throw new Error(`no bill id: ${JSON.stringify(res?.json)?.slice(0, 200)}`);
  return id as string;
};
const qty = async (id: string) =>
  (await p.drugBatch.findUnique({ where: { id }, select: { quantityInStock: true } }))?.quantityInStock ?? -1;
const money = (n: unknown) => Number(n ?? 0);
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) < tol;

const ret = (body: unknown, as = 'pharm') => api(as, 'POST', '/pharmacy/returns', body);
const process_ = (id: string, body: unknown, as = 'pharm') =>
  api(as, 'PATCH', `/pharmacy/returns/${id}/process`, body);

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
  // Only an admin can flip the controlled-drug policy — a pharmacy admin
  // cannot, which is the point of that gate.
  const haveAdmin = await login('admin', 'admin@hospital.com');
  ck('an administrator, for the policy switch', haveAdmin);

  // -- Sweep leftovers -----------------------------------------------------
  const stale = await p.drugFormulary.findMany({
    where: { tenantId: TENANT, drugName: { startsWith: 'RET-' } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((d) => d.id);
    const b = (await p.drugBatch.findMany({ where: { drugId: { in: ids } }, select: { id: true } })).map((x) => x.id);
    const bills = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: b } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
    await p.drugReturn.deleteMany({ where: { OR: [{ drugBatchId: { in: b } }, { drugId: { in: ids } }] } });
    await p.refund.deleteMany({ where: { billId: { in: bills } } });
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
  const START = 500;
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT, drugName: `${TAG} Paracetamol 500`, genericName: 'Paracetamol',
      composition: 'Paracetamol (500mg)', strength: '500mg',
      dosageForm: 'tablet', unitOfMeasurement: 'tablet',
      packSize: 10, looseUnitLabel: 'tablet',
      price: 2, taxPercent: 12, hsnCode: '3004', schedule: 'OTC',
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
  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true, mrn: true } });
  const supplier = await p.supplier.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  ck('a drug with 500 in stock', (await qty(batch.id)) === START);
  ck('a patient', Boolean(patient?.id), patient?.mrn ?? '');
  ck('a supplier to send stock back to', Boolean(supplier?.id), supplier?.name ?? '');

  // -- 1. A patient brings medicine back -----------------------------------
  section('1. A patient brings medicine back');
  const sale = await api('pharm', 'POST', '/pharmacy/sales', {
    patientId: patient!.id,
    items: [{ drugBatchId: batch.id, quantity: 5, saleUnit: 'pack' }],
    paymentMethod: 'cash',
  });
  ck('sold 5 packs of 10 to a named patient', sale.status < 400, sale.message);
  const billId = idOf(sale);
  const soldBill = billOf(sale);
  const rec = await p.dispensingRecord.findFirst({ where: { billId }, select: { id: true, quantityDispensed: true } });
  ck('...which is 50 tablets on one dispensing line', rec?.quantityDispensed === 50, `${rec?.quantityDispensed}`);
  const afterSale = await qty(batch.id);

  const pickable = await api('pharm', 'GET', `/pharmacy/returnable?patientId=${patient!.id}`);
  ck(
    'the counter can look up what this patient can bring back',
    pickable.status < 400 && (pickable.data?.items ?? pickable.data?.dispenses ?? []).length >= 0,
    `status ${pickable.status}`,
  );

  const tooMany = await ret({
    returnType: 'patient_return', dispensingRecordId: rec!.id,
    quantity: 51, reason: `${TAG} too many`,
  });
  ck('cannot bring back more than was sold', tooMany.status >= 400, tooMany.message);
  ck('...saying how many are still returnable', /still returnable/.test(tooMany.message), tooMany.message);

  const r1 = await ret({
    returnType: 'patient_return', dispensingRecordId: rec!.id,
    quantity: 10, reason: `${TAG} wrong strength`,
  });
  ck('a partial return is accepted', r1.status < 400, r1.message);
  // Deliberately immediate — there is no approve step. The customer is standing
  // at the counter, so the stock goes back and the refund is booked at once.
  ck('it applies straight away', r1.data?.status === 'processed', r1.data?.status ?? '');
  ck('the stock goes back on the shelf', (await qty(batch.id)) === afterSale + 10, `${await qty(batch.id)}`);
  ck(
    'the refund is worked out from what was billed',
    near(money(r1.data?.refundAmount), 20),
    `${r1.data?.refundAmount} for 10 tablets at 2`,
  );
  const refund = await p.refund.findFirst({ where: { billId }, select: { amount: true, status: true } });
  ck('a refund is raised against the original sale', Boolean(refund), `${refund?.amount} ${refund?.status}`);
  ck('...for the refunded amount', near(money(refund?.amount), 20), `${refund?.amount}`);
  const billNow = await p.bill.findUnique({ where: { id: billId }, select: { amountPaid: true, balanceDue: true, totalAmount: true } });
  ck(
    'and the bill stops counting that money as collected',
    near(money(billNow?.amountPaid), money(soldBill?.amountPaid) - 20),
    `paid ${billNow?.amountPaid}, was ${soldBill?.amountPaid}`,
  );

  const twice = await process_(r1.data.id, { status: 'processed' });
  ck('a return cannot be approved twice', twice.status >= 400, twice.message);

  const r2 = await ret({
    returnType: 'patient_return', dispensingRecordId: rec!.id,
    quantity: 41, reason: `${TAG} the rest`,
  });
  ck('the earlier return counts against what is left', r2.status >= 400, r2.message);
  ck('...only 40 of the 50 remain', /only 40/.test(r2.message), r2.message);

  const rest = await ret({
    returnType: 'patient_return', dispensingRecordId: rec!.id,
    quantity: 40, reason: `${TAG} the rest`,
  });
  ck('returning exactly the remainder is allowed', rest.status < 400, rest.message);
  ck('all 50 are back on the shelf', (await qty(batch.id)) === afterSale + 50, `${await qty(batch.id)}`);

  // -- 2. Approving and rejecting ------------------------------------------
  section('2. Approving and rejecting');
  // Every return type is processed the moment it is recorded, so nothing is
  // ever left pending — which makes the whole approve/reject endpoint
  // unreachable. Worth pinning either way: if returns ever go back to needing
  // approval, these say what changed.
  const anyPending = await p.drugReturn.count({ where: { tenantId: TENANT, status: 'pending' } });
  ck('no return is ever left waiting for approval', anyPending === 0, `${anyPending} pending`);
  const reprocess = await process_(r1.data.id, { status: 'processed' });
  ck('so the approve endpoint has nothing to approve', reprocess.status >= 400, reprocess.message);
  const rejectIt = await process_(r1.data.id, { status: 'rejected' });
  ck('and nothing to reject', rejectIt.status >= 400, rejectIt.message);
  // Which means a mis-keyed return cannot be undone through the API: the stock
  // is already back and the refund already booked.
  ck(
    'a mistaken return has no way back',
    rejectIt.status >= 400 && /Only pending/.test(rejectIt.message),
    'recorded here rather than asserted away - there is no reversal path',
  );

  // -- 3. A line the bill says cannot come back ----------------------------
  section('3. A line marked non-returnable');
  const sale3 = await api('pharm', 'POST', '/pharmacy/sales', {
    patientId: patient!.id,
    items: [{ drugBatchId: batch.id, quantity: 1, saleUnit: 'pack', nonReturnable: true }],
    paymentMethod: 'cash',
  });
  const rec3 = await p.dispensingRecord.findFirst({ where: { billId: idOf(sale3) }, select: { id: true } });
  const noReturn = await ret({
    returnType: 'patient_return', dispensingRecordId: rec3!.id,
    quantity: 1, reason: `${TAG} changed mind`,
  });
  ck('it cannot be brought back', noReturn.status >= 400 && /non-returnable/i.test(noReturn.message), noReturn.message);

  // -- 4. A voided sale ----------------------------------------------------
  section('4. A sale that was voided');
  // The stock already went back when the sale was voided. Taking a return on
  // top would put it back a second time, and refund money that was already
  // reversed. The record survives now (the register needs it), so this has to
  // be refused explicitly rather than by the row being missing.
  const sale4 = await api('pharm', 'POST', '/pharmacy/sales', {
    patientId: patient!.id,
    items: [{ drugBatchId: batch.id, quantity: 2, saleUnit: 'pack' }],
    paymentMethod: 'cash',
  });
  const rec4 = await p.dispensingRecord.findFirst({ where: { billId: idOf(sale4) }, select: { id: true } });
  await api('pharm', 'PATCH', `/pharmacy/sales/${idOf(sale4)}/cancel`, { reason: `${TAG} voided` });
  const afterVoid = await qty(batch.id);
  const onVoided = await ret({
    returnType: 'patient_return', dispensingRecordId: rec4!.id,
    quantity: 20, reason: `${TAG} return a voided sale`,
  });
  ck('a voided sale cannot be returned', onVoided.status >= 400, onVoided.message.slice(0, 90));
  ck('...and the stock is not put back twice', (await qty(batch.id)) === afterVoid, `${await qty(batch.id)}`);
  const picker = await api('pharm', 'GET', `/pharmacy/returnable?patientId=${patient!.id}`);
  const offered = (picker.data?.items ?? picker.data?.dispenses ?? picker.data ?? []) as any[];
  ck(
    'nor is it offered on the returns picker',
    Array.isArray(offered) && !offered.some((d: any) => d.id === rec4!.id),
    `${Array.isArray(offered) ? offered.length : '?'} line(s) offered`,
  );

  // -- 5. Over the counter, with no bill behind it -------------------------
  section('5. A walk-in hands something back over the counter');
  const beforeCounter = await qty(batch.id);
  const counter = await ret({
    returnType: 'counter_return', drugId: drug.id, drugBatchId: batch.id,
    quantity: 4, reason: `${TAG} unopened strip`, refundAmount: 8,
  });
  ck('a counter return is accepted', counter.status < 400, counter.message);
  ck('...and applies straight away, with no approve step', counter.data?.status === 'processed', counter.data?.status ?? '');
  ck('the stock goes back', (await qty(batch.id)) === beforeCounter + 4, `${await qty(batch.id)}`);
  ck('the money handed over is recorded', near(money(counter.data?.refundAmount), 8), `${counter.data?.refundAmount}`);

  const noDrug = await ret({ returnType: 'counter_return', quantity: 1, reason: `${TAG} nothing` });
  ck('it has to name a medicine', noDrug.status >= 400, noDrug.message);

  // A batch nobody has heard of, with an expiry — the counter can still take it
  // back, opening a batch to hold it.
  const newBatchNo = `${TAG}-CUSTOMER`;
  const unknown = await ret({
    returnType: 'counter_return', drugId: drug.id,
    batchNumber: newBatchNo, expiryDate: new Date(Date.now() + 300 * 864e5).toISOString(),
    quantity: 3, reason: `${TAG} bought elsewhere`,
  });
  ck('a batch the system has never seen is accepted', unknown.status < 400, unknown.message);
  const opened = await p.drugBatch.findFirst({ where: { tenantId: TENANT, drugId: drug.id, batchNumber: newBatchNo } });
  ck('...and a batch is opened to hold it', Boolean(opened), `${opened?.quantityInStock ?? 0} unit(s)`);
  ck('...holding what came back', opened?.quantityInStock === 3, `${opened?.quantityInStock}`);
  ck('...with a barcode, since it is going back on the shelf', Boolean(opened?.barcode));

  // -- 6. Sending stock back to the vendor ---------------------------------
  section('6. Sending damaged stock back to the vendor');
  if (havePharmacist) {
    const byStaff = await ret({
      returnType: 'vendor_return', drugBatchId: batch.id, supplierId: supplier!.id,
      quantity: 5, reason: `${TAG} damaged`,
    }, 'staff');
    ck('a counter pharmacist cannot send stock back to a vendor', byStaff.status >= 400, `status ${byStaff.status}`);
  }
  const noVendor = await ret({
    returnType: 'vendor_return', drugBatchId: batch.id,
    quantity: 5, reason: `${TAG} damaged`,
  });
  ck('a vendor return has to name a vendor', noVendor.status >= 400, noVendor.message);

  const held = await qty(batch.id);
  const beforeVendor = held;
  const overStock = await ret({
    returnType: 'vendor_return', drugBatchId: batch.id, supplierId: supplier!.id,
    quantity: held + 50, reason: `${TAG} more than we hold`,
  });
  ck('cannot send back more than the shelf holds', overStock.status >= 400, overStock.message);
  ck('...saying how much there is', /only has \d+ in stock/.test(overStock.message), overStock.message);

  const vendor = await ret({
    returnType: 'vendor_return', drugBatchId: batch.id, supplierId: supplier!.id,
    quantity: 5, reason: `${TAG} damaged in transit`,
  });
  ck('a vendor return is accepted', vendor.status < 400, vendor.message);
  ck(
    'the credit is valued at what we paid, not what we sell for',
    near(money(vendor.data?.creditAmount), 6),
    `${vendor.data?.creditAmount} for 5 at cost 1.2`,
  );
  // A vendor return moves stock the other way — out of the building.
  ck('and it takes the stock OFF the shelf', (await qty(batch.id)) === beforeVendor - 5, `${await qty(batch.id)}`);
  ck('...rather than putting it back', (await qty(batch.id)) < beforeVendor);

  // -- 7. A controlled drug coming back ------------------------------------
  section('7. A controlled drug coming back');
  const ctrl: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT, drugName: `${TAG} Alprazolam 0.5`, genericName: 'Alprazolam',
      composition: 'Alprazolam (0.5mg)', strength: '0.5mg',
      dosageForm: 'tablet', unitOfMeasurement: 'tablet', packSize: 10,
      price: 5, taxPercent: 12, hsnCode: '3004',
      schedule: 'X', scheduleReason: 'Schedule X', controlledClass: 'psychotropic',
      isNarcotic: true, vaultControlled: true,
    } as never,
  });
  const ctrlBatch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: ctrl.id, batchNumber: `${TAG}-X1`,
      quantityReceived: 100, quantityInStock: 100,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 3, sellingPrice: 5, mrp: 5,
    } as never,
  });
  // Quarantine is gated on the hospital's controlled-drug MODE. Left at the
  // default (`legacy_block`), a returned narcotic goes straight back on the
  // sellable shelf — deliberately, so that switching the feature on is what
  // changes behaviour, not deploying it. So: check the default first, then turn
  // the mode on and check what it buys.
  const ctrlBefore = await qty(ctrlBatch.id);
  const settingsBefore = await api('pharm', 'GET', '/hospital-settings/controlled-drugs');
  const modeWas = settingsBefore.data?.mode ?? 'legacy_block';

  const defaultRet = await ret({
    returnType: 'counter_return', drugId: ctrl.id, drugBatchId: ctrlBatch.id,
    quantity: 6, reason: `${TAG} default mode`,
  });
  ck('in the default mode a controlled return is simply taken back', defaultRet.status < 400, defaultRet.message);
  ck(
    '...straight onto the sellable shelf, which is what that mode means',
    (await qty(ctrlBatch.id)) === ctrlBefore + 6,
    `${await qty(ctrlBatch.id)}, was ${ctrlBefore}`,
  );

  const byPharmacyAdmin = await api('pharm', 'PUT', '/hospital-settings/controlled-drugs', { mode: 'inline' });
  ck('a pharmacy admin cannot change the controlled-drug policy', byPharmacyAdmin.status === 403, `status ${byPharmacyAdmin.status}`);
  const switched = await api('admin', 'PUT', '/hospital-settings/controlled-drugs', { mode: 'inline' });
  ck('the hospital can switch controlled handling on', switched.status < 400, `status ${switched.status} ${switched.message}`);

  const heldBefore = await qty(ctrlBatch.id);

  // With the mode on, a narcotic coming back needs a second person to witness
  // it — someone had custody of a controlled drug outside the building, and one
  // person's word is not a record.
  const noWitness = await ret({
    returnType: 'counter_return', drugId: ctrl.id, drugBatchId: ctrlBatch.id,
    quantity: 6, reason: `${TAG} patient died`,
  });
  ck('it now needs a witness', noWitness.status >= 400 && /witness/i.test(noWitness.message), noWitness.message.slice(0, 70));
  ck('...and nothing moved while it was refused', (await qty(ctrlBatch.id)) === heldBefore, `${await qty(ctrlBatch.id)}`);

  // The witness lookup is tenant-scoped, so the witness has to work at THIS
  // hospital — the platform super-admin is not one of its staff.
  const witnessUser = await p.user.findFirst({
    where: { tenantId: TENANT, isActive: true, email: 'pharmacist1@email.com' },
    select: { id: true },
  });
  const pharmUser = await p.user.findFirst({ where: { email: 'pharmacyadmin1@email.com' }, select: { id: true } });

  const selfWitness = await ret({
    returnType: 'counter_return', drugId: ctrl.id, drugBatchId: ctrlBatch.id,
    quantity: 6, reason: `${TAG} patient died`,
    witnessedById: pharmUser!.id, witnessPassword: 'Admin@123',
  });
  ck(
    'and the witness cannot be the person accepting it',
    selfWitness.status >= 400 && /different person/i.test(selfWitness.message),
    selfWitness.message.slice(0, 70),
  );

  const wrongPassword = await ret({
    returnType: 'counter_return', drugId: ctrl.id, drugBatchId: ctrlBatch.id,
    quantity: 6, reason: `${TAG} patient died`,
    witnessedById: witnessUser!.id, witnessPassword: 'not-the-password',
  });
  ck(
    'a name picked from a list is not a signature — the witness enters their own password',
    wrongPassword.status >= 400 && /could not be verified/i.test(wrongPassword.message),
    wrongPassword.message.slice(0, 70),
  );

  const ctrlRet = await ret({
    returnType: 'counter_return', drugId: ctrl.id, drugBatchId: ctrlBatch.id,
    quantity: 6, reason: `${TAG} patient died`,
    witnessedById: witnessUser!.id, witnessPassword: 'Admin@123',
  });
  ck('witnessed properly, it is accepted', ctrlRet.status < 400, `status ${ctrlRet.status} ${ctrlRet.message.slice(0, 70)}`);

  let quarantinedBatchId: string | null = null;
  if (ctrlRet.status < 400) {
    const ctrlBefore2 = heldBefore;
    const quar = await p.drugBatch.findFirst({
      where: { tenantId: TENANT, drugId: ctrl.id, batchNumber: { startsWith: 'QUAR-' } },
    });
    ck('it is held in quarantine, not put back on the sellable shelf', Boolean(quar), `${quar?.batchNumber ?? 'no quarantine batch'}`);
    ck('...holding what came back', quar?.quantityInStock === 6, `${quar?.quantityInStock}`);
    ck('...and the sellable batch is untouched', (await qty(ctrlBatch.id)) === ctrlBefore2, `${await qty(ctrlBatch.id)}, was ${ctrlBefore2}`);
    ck('...flagged so nothing can dispense it', quar?.isRecalled === true);
    quarantinedBatchId = quar?.id ?? null;
  }

  // Leave the hospital as we found it — this walk runs against the live dev
  // database and a mode left flipped would change how the counter behaves.
  await api('admin', 'PUT', '/hospital-settings/controlled-drugs', { mode: modeWas });
  const restored = await api('pharm', 'GET', '/hospital-settings/controlled-drugs');
  ck('the controlled-drug mode is put back as it was', restored.data?.mode === modeWas, `${restored.data?.mode} vs ${modeWas}`);

  // Now that the mode is back and a Schedule X sale needs only a prescription,
  // the quarantine flag is the ONLY thing left that can stop this — which is
  // what makes the refusal mean something. With the mode on, the witness rule
  // fired first and proved nothing about the quarantine.
  if (quarantinedBatchId) {
    const paper = await api('pharm', 'POST', '/pharmacy/external-prescriptions', {
      prescriberName: `${TAG} Dr Paper`,
      prescriberRegNo: `${TAG}-REG`,
      prescribedDate: new Date().toISOString().slice(0, 10),
    });
    const sellQuar = await api('pharm', 'POST', '/pharmacy/sales', {
      items: [{ drugBatchId: quarantinedBatchId, quantity: 1 }],
      ...(paper.status < 400 ? { externalPrescriptionId: paper.data?.id } : {}),
      paymentMethod: 'cash',
    });
    ck(
      'the counter refuses to sell quarantined stock, on the quarantine and not some other rule',
      sellQuar.status >= 400 && /recall/i.test(sellQuar.message),
      sellQuar.message.slice(0, 70),
    );
    ck('...leaving it where it is', (await qty(quarantinedBatchId)) === 6, `${await qty(quarantinedBatchId)}`);
  }

  // -- 8. What the register shows ------------------------------------------
  section('8. What the statutory register shows');
  const win = `fromDate=${new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)}&toDate=${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}`;
  const reg = await api('pharm', 'GET', `/pharmacy/controlled-register?${win}`);
  const ctrlRows = (reg.data?.rows ?? []).filter((r: any) => r.itemName === `${TAG} Alprazolam 0.5`);
  ck('the controlled return is on the register', ctrlRows.some((r: any) => r.txnType === 'Return'), ctrlRows.map((r: any) => r.txnType).join(', ') || 'no rows');
  ck(
    'a quarantine batch is not ALSO counted as a receipt',
    ctrlRows.filter((r: any) => r.txnType === 'Receipt (GRN)' && /^QUAR-/.test(r.batchNumber ?? '')).length === 0,
  );
  const s = reg.data?.summary ?? {};
  ck(
    'and the register still adds up',
    s.openingStock + s.inward - s.outward - (s.transferredOut ?? 0) + (s.outwardAlreadyIssued ?? 0) === s.closingBalance,
    `${s.openingStock} + ${s.inward} - ${s.outward} - ${s.transferredOut} + ${s.outwardAlreadyIssued} vs closing ${s.closingBalance}`,
  );

  // -- 9. Listing them ------------------------------------------------------
  section('9. Listing returns');
  const list = await api('pharm', 'GET', '/pharmacy/returns?limit=200');
  ck('the returns list loads', list.status < 400, `status ${list.status}`);
  const rows = (list.data?.returns ?? list.data?.items ?? list.data ?? []) as any[];
  ck('and includes the ones just made', Array.isArray(rows) && rows.some((r: any) => (r.reason ?? '').includes(TAG)), `${Array.isArray(rows) ? rows.length : '?'} row(s)`);
  const byId = await api('pharm', 'GET', `/pharmacy/returns/${r1.data.id}`);
  const oneReturn = byId.data?.return ?? byId.data;
  ck('one can be opened on its own', byId.status < 400 && oneReturn?.id === r1.data.id, `status ${byId.status}, got ${oneReturn?.id?.slice(0, 8)}`);

  // -- 10. Nothing leaked ---------------------------------------------------
  section('10. Nothing leaked');
  const sold = await p.dispensingRecord.aggregate({
    where: { drugBatchId: batch.id, cancelledAt: null },
    _sum: { quantityDispensed: true },
  });
  const returned = await p.drugReturn.aggregate({
    where: { drugBatchId: batch.id, status: 'processed', returnType: { in: ['patient_return', 'counter_return'] } },
    _sum: { quantity: true },
  });
  const toVendor = await p.drugReturn.aggregate({
    where: { drugBatchId: batch.id, status: 'processed', returnType: 'vendor_return' },
    _sum: { quantity: true },
  });
  const onShelf = await qty(batch.id);
  const accounted = onShelf + (sold._sum.quantityDispensed ?? 0) - (returned._sum.quantity ?? 0) + (toVendor._sum.quantity ?? 0);
  ck(
    'shelf + sold - brought back + sent to the vendor is what we started with',
    accounted === START,
    `${onShelf} + ${sold._sum.quantityDispensed} - ${returned._sum.quantity} + ${toVendor._sum.quantity} = ${accounted}, started ${START}`,
  );

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const drugIds = [drug.id, ctrl.id];
  const batchIds = (await p.drugBatch.findMany({ where: { drugId: { in: drugIds } }, select: { id: true } })).map((b) => b.id);
  const billIds = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: batchIds } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
  await p.drugReturn.deleteMany({ where: { OR: [{ drugBatchId: { in: batchIds } }, { drugId: { in: drugIds } }] } });
  await p.refund.deleteMany({ where: { billId: { in: billIds } } });
  await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.payment.deleteMany({ where: { billId: { in: billIds } } });
  await p.billItem.deleteMany({ where: { billId: { in: billIds } } });
  await p.bill.deleteMany({ where: { id: { in: billIds } } });
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
