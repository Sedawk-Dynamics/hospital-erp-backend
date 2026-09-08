/**
 * The ward-stock flow, walked end to end.
 *
 * A ward shelf is a second inventory. Stock leaves the pharmacy's batch, sits
 * on the shelf under the ward's control, and leaves again as a dose given to a
 * patient, a return to the pharmacy, or a correction after a physical count.
 * Four movements, two ledgers, and one number that must never drift: the total
 * quantity in the building.
 *
 * This walks all of it against the running server:
 *
 *   npm run db:check-ward-stock       (needs the dev server up)
 *
 * Fixtures are tagged WARDSTOCK-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `WARDSTOCK-${Date.now()}`;
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
function section(t: string) {
  console.log(`\n${t}`);
}

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

const batchQty = async (id: string) =>
  (await p.drugBatch.findUnique({ where: { id }, select: { quantityInStock: true } }))?.quantityInStock ?? -1;
const shelfQty = async (wardId: string, batchId: string) =>
  (
    await p.wardStock.findFirst({
      where: { tenantId: TENANT, wardId, drugBatchId: batchId },
      select: { quantityInStock: true },
    })
  )?.quantityInStock ?? 0;
const ledgerRows = (wardId: string, batchId: string) =>
  p.wardStockLedger.findMany({
    where: { tenantId: TENANT, wardId, drugBatchId: batchId },
    orderBy: { createdAt: 'asc' },
  });

async function main() {
  section('Signing in');
  ck('pharmacy admin', await login('pharm', 'pharmacyadmin1@email.com'));
  const nurseUser = await p.user.findFirst({
    where: {
      tenantId: TENANT,
      isActive: true,
      userRoles: { some: { role: { name: { in: ['nurse', 'nurse_admin'] } } } },
    },
    select: { email: true },
  });
  const haveNurse = nurseUser ? await login('nurse', nurseUser.email) : false;
  ck('a nurse (the person at the bedside)', haveNurse, nurseUser?.email ?? 'no nurse user found');
  if (!tokens.pharm) return;

  // -- Fixtures ------------------------------------------------------------
  section('Fixtures');
  // A run that throws half way leaves its fixtures behind. Sweep them, or the
  // next run measures a shelf that still holds the last run's tablets.
  const stale = await p.drugFormulary.findMany({
    where: { tenantId: TENANT, drugName: { startsWith: 'WARDSTOCK-' } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((d) => d.id);
    const staleBatches = (await p.drugBatch.findMany({ where: { drugId: { in: ids } }, select: { id: true } })).map((b) => b.id);
    await p.wardStockLedger.deleteMany({ where: { drugBatchId: { in: staleBatches } } });
    await p.wardStock.deleteMany({ where: { drugBatchId: { in: staleBatches } } });
    // A voided or cancelled bill now carries a credit note that references it.
    await p.creditNote.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: 'WARDSTOCK-' } } }).catch(() => {});
    await p.billItem.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: 'WARDSTOCK-' } } });
    await p.drugBatch.deleteMany({ where: { drugId: { in: ids } } });
    await p.drugFormulary.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (swept ${stale.length} leftover fixture drug(s) from an earlier run)`);
  }
  const START = 300;
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: `${TAG} Paracetamol 500`,
      genericName: 'Paracetamol (500mg)',
      composition: 'Paracetamol (500mg)',
      dosageForm: 'tablet',
      unitOfMeasurement: 'tablet',
      price: 10,
      taxPercent: 5,
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-B1`,
      quantityReceived: START,
      quantityInStock: START,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 8,
      sellingPrice: 10,
      mrp: 10,
    } as never,
  });
  const ward: any = await p.ward.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  const admission: any = await p.admission.findFirst({
    where: { tenantId: TENANT, status: 'admitted' },
    select: { id: true, patientId: true, patient: { select: { mrn: true } } },
    orderBy: { admissionDate: 'desc' },
  });
  ck('an ordinary drug with 300 in the pharmacy', (await batchQty(batch.id)) === START);
  ck('a ward to stock', Boolean(ward?.id), ward?.name ?? '');
  ck('a patient currently admitted', Boolean(admission?.id), admission?.patient?.mrn ?? 'none admitted');
  if (!ward?.id) return;

  const stock = (body: unknown, as = 'pharm') => api(as, 'POST', '/pharmacy/ward-stock/transfer', body);

  // -- 1. Stocking the shelf -----------------------------------------------
  section('1. Stocking the shelf');

  const zero = await stock({ wardId: ward.id, drugBatchId: batch.id, quantity: 0 });
  ck('refuses a quantity of zero', zero.status >= 400, zero.message);

  const tooMuch = await stock({ wardId: ward.id, drugBatchId: batch.id, quantity: START + 1 });
  ck('refuses more than the pharmacy holds', tooMuch.status >= 400, tooMuch.message);
  ck('...and says how much there is', /have 300/.test(tooMuch.message), tooMuch.message);

  if (haveNurse) {
    const byNurse = await stock({ wardId: ward.id, drugBatchId: batch.id, quantity: 5 }, 'nurse');
    ck('a nurse cannot move stock out of the pharmacy', byNurse.status >= 400, `status ${byNurse.status}`);
  }

  const ghostWard = await stock({
    wardId: '00000000-0000-0000-0000-000000000000',
    drugBatchId: batch.id,
    quantity: 5,
  });
  ck('refuses a ward that does not exist', ghostWard.status >= 400, ghostWard.message);

  const issued = await stock({ wardId: ward.id, drugBatchId: batch.id, quantity: 100 });
  ck('stocks the shelf', issued.status < 400, issued.message);
  ck('the shelf holds 100', (await shelfQty(ward.id, batch.id)) === 100, `${await shelfQty(ward.id, batch.id)}`);
  ck('the pharmacy is down to 200', (await batchQty(batch.id)) === 200, `${await batchQty(batch.id)}`);
  ck('nothing was created or lost', (await batchQty(batch.id)) + (await shelfQty(ward.id, batch.id)) === START);

  const again = await stock({ wardId: ward.id, drugBatchId: batch.id, quantity: 20 });
  ck(
    'a second issue adds to the same shelf row',
    again.status < 400 && (await shelfQty(ward.id, batch.id)) === 120,
    `${await shelfQty(ward.id, batch.id)}`,
  );
  ck(
    'it does not open a duplicate shelf row',
    (await p.wardStock.count({ where: { tenantId: TENANT, wardId: ward.id, drugBatchId: batch.id } })) === 1,
  );

  let led = await ledgerRows(ward.id, batch.id);
  ck(
    'both issues are in the ledger as received',
    led.filter((r) => r.movementType === 'received').length === 2,
    `${led.length} rows`,
  );

  // Expired and recalled stock must not leave the pharmacy at all.
  const expired: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-EXPIRED`,
      quantityReceived: 50,
      quantityInStock: 50,
      expiryDate: new Date(Date.now() - 30 * 864e5),
      purchasePrice: 8,
      sellingPrice: 10,
      mrp: 10,
    } as never,
  });
  const recalled: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-RECALLED`,
      quantityReceived: 50,
      quantityInStock: 50,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      isRecalled: true,
      purchasePrice: 8,
      sellingPrice: 10,
      mrp: 10,
    } as never,
  });
  const expOut = await stock({ wardId: ward.id, drugBatchId: expired.id, quantity: 5 });
  ck('an expired batch cannot be sent to a ward', expOut.status >= 400, expOut.message);
  const recOut = await stock({ wardId: ward.id, drugBatchId: recalled.id, quantity: 5 });
  ck('a recalled batch cannot be sent to a ward', recOut.status >= 400, recOut.message);

  // -- 2. Reading the shelf ------------------------------------------------
  section('2. Reading the shelf');
  const readAs = haveNurse ? 'nurse' : 'pharm';
  const view = await api(readAs, 'GET', `/pharmacy/ward-stock?wardId=${ward.id}`);
  ck('the nurse can read her own ward stock', view.status < 400, `status ${view.status}`);
  const mine = (view.data?.items ?? []).find((r: any) => r.drugBatchId === batch.id);
  ck('the drug is on the list', Boolean(mine), mine?.drugName ?? '');
  ck('with the quantity on hand', mine?.quantityInStock === 120, `${mine?.quantityInStock}`);
  ck('and the batch and expiry a nurse needs to check', Boolean(mine?.batchNumber && mine?.expiryDate));

  const ledView = await api(readAs, 'GET', `/pharmacy/ward-stock/ledger?wardId=${ward.id}`);
  ck(
    'the ledger reads back',
    ledView.status < 400 && (ledView.data?.items ?? []).length > 0,
    `${(ledView.data?.items ?? []).length} rows`,
  );

  // -- 3. Giving a dose to a patient ---------------------------------------
  section('3. Giving a dose to a patient');
  const dispense = (body: unknown, as = readAs) => api(as, 'POST', '/pharmacy/ward-stock/dispense', body);
  if (!admission?.id) {
    ck('SKIPPED - no admitted patient to dose', false, 'admit a patient and re-run');
  } else {
    const overDose = await dispense({
      wardId: ward.id,
      drugBatchId: batch.id,
      patientId: admission.patientId,
      quantity: 999,
    });
    ck('refuses more than the shelf holds', overDose.status >= 400, overDose.message);

    // A patient over their deposit is stopped. That is the IP credit gate
    // doing its job, and it has to be got past deliberately before the rest of
    // this section means anything — the first run of this walk had every
    // "expired stock is refused" check passing on a credit error.
    const credit = await p.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(SUM(b.total_amount),0)::float billed FROM bills b
       WHERE b.tenant_id = $1 AND b.patient_id = $2 AND b.bill_number NOT LIKE 'ADV-%'`,
      TENANT, admission.patientId,
    );
    const overDeposit = Number(credit[0]?.billed ?? 0) > 0;
    if (overDeposit) {
      const blocked = await dispense({
        wardId: ward.id,
        drugBatchId: batch.id,
        patientId: admission.patientId,
        quantity: 10,
      });
      ck(
        'a patient over their deposit is stopped until someone clears it',
        blocked.status >= 400 && /Credit Limit/i.test(blocked.message),
        blocked.message.slice(0, 60),
      );
    }

    const given = await dispense({
      wardId: ward.id,
      drugBatchId: batch.id,
      patientId: admission.patientId,
      quantity: 10,
      override: true,
    });
    ck('records the dose', given.status < 400, given.message || `status ${given.status}`);
    ck('the shelf is down to 110', (await shelfQty(ward.id, batch.id)) === 110, `${await shelfQty(ward.id, batch.id)}`);
    ck(
      'the pharmacy batch is untouched - the stock already left it',
      (await batchQty(batch.id)) === 180,
      `${await batchQty(batch.id)}`,
    );

    const billId = given.data?.billId;
    const bill: any = billId ? await p.bill.findUnique({ where: { id: billId }, include: { billItems: true } }) : null;
    ck('the dose is charged to a bill', Boolean(bill), given.data?.billNumber ?? '');
    ck('never to the ADV- advance bucket', !/^ADV-/.test(bill?.billNumber ?? ''), bill?.billNumber ?? '');
    ck(
      'the bill belongs to this stay',
      bill?.admissionId === admission.id,
      `${bill?.admissionId?.slice(0, 8)} vs ${admission.id.slice(0, 8)}`,
    );
    const item = (bill?.billItems ?? []).find(
      (i: any) => i.referenceType === 'ward_dispense' && String(i.description).includes(TAG),
    );
    ck('the line names the drug and the batch', Boolean(item), item?.description ?? '');
    ck('charged 10 x 10', Number(item?.totalAmount) === 100, `${item?.totalAmount}`);
    // A medicine issued from the ward shelf to an ADMITTED patient is part of a
    // composite supply with their treatment, and the treatment is exempt. The
    // patient pays the same 100 either way — the price is an MRP — but the
    // hospital no longer reports output tax on treatment income.
    ck(
      'and exempt, because the ward issued it to an inpatient',
      Number(item?.taxAmount) === 0 && item?.gstTreatment === 'exempt',
      `tax ${item?.taxAmount}, treatment ${item?.gstTreatment}`,
    );
    ck(
      'the whole price is exempt turnover',
      Math.abs(Number(item?.taxableValue) - 100) < 0.02,
      `taxable ${item?.taxableValue}`,
    );
    ck(
      'and the line says which rule decided that',
      item?.rateSource === 'inpatient_composite',
      `source ${item?.rateSource}`,
    );

    led = await ledgerRows(ward.id, batch.id);
    const disp = led.find((r) => r.movementType === 'dispensed');
    ck('the movement is in the ward ledger', Boolean(disp));
    ck('the ledger row names the patient', disp?.patientId === admission.patientId);
    ck('and the bill it was charged to', Boolean(billId) && disp?.billId === billId, `${disp?.billId ?? 'null'}`);
    // The bill is scoped to the stay even when the caller did not name it. The
    // ledger row should be scoped the same way, or a per-stay consumption
    // report reads zero for every dose given from a ward shelf.
    ck(
      'and the stay it belongs to',
      disp?.admissionId === admission.id,
      `ledger admissionId ${disp?.admissionId ?? 'null'} vs bill ${bill?.admissionId?.slice(0, 8)}`,
    );

    const ledgerNamed = await api(readAs, 'GET', `/pharmacy/ward-stock/ledger?wardId=${ward.id}`);
    const shown = (ledgerNamed.data?.items ?? []).find(
      (r: any) => r.movementType === 'dispensed' && String(r.drugName).includes(TAG),
    );
    ck(
      'the ledger screen shows who it was given to',
      Boolean(shown?.patientMrn),
      shown ? `${shown.patient} ${shown.patientMrn}` : 'this dose is not on the ledger screen',
    );
  }

  // -- 4. Stock that goes bad AFTER it reaches the ward ---------------------
  // transferToWard refuses expired and recalled batches, but that is the
  // pharmacy door. A batch can pass through it and go bad later, sitting in the
  // ward cupboard.
  section('4. Stock that goes bad after it reaches the ward');
  const shelfExpired: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-SHELF-EXP`,
      quantityReceived: 20,
      quantityInStock: 20,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 8,
      sellingPrice: 10,
      mrp: 10,
    } as never,
  });
  await stock({ wardId: ward.id, drugBatchId: shelfExpired.id, quantity: 10 });
  await p.drugBatch.update({
    where: { id: shelfExpired.id },
    data: { expiryDate: new Date(Date.now() - 864e5), isExpired: true },
  });

  const shelfRecalled: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-SHELF-REC`,
      quantityReceived: 20,
      quantityInStock: 20,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 8,
      sellingPrice: 10,
      mrp: 10,
    } as never,
  });
  await stock({ wardId: ward.id, drugBatchId: shelfRecalled.id, quantity: 10 });
  await p.drugBatch.update({
    where: { id: shelfRecalled.id },
    data: { isRecalled: true, recallReason: `${TAG} test recall` },
  });

  if (admission?.id) {
    const expiredDose = await dispense({
      wardId: ward.id,
      drugBatchId: shelfExpired.id,
      patientId: admission.patientId,
      quantity: 1,
      override: true,
    });
    ck(
      'an expired batch on the shelf cannot be given to a patient',
      expiredDose.status >= 400 && /expir/i.test(expiredDose.message),
      `status ${expiredDose.status} ${expiredDose.message.slice(0, 70)}`,
    );
    const recalledDose = await dispense({
      wardId: ward.id,
      drugBatchId: shelfRecalled.id,
      patientId: admission.patientId,
      quantity: 1,
      override: true,
    });
    ck(
      'a recalled batch on the shelf cannot be given to a patient',
      recalledDose.status >= 400 && /recall/i.test(recalledDose.message),
      `status ${recalledDose.status} ${recalledDose.message.slice(0, 70)}`,
    );
  }

  const badView = await api(readAs, 'GET', `/pharmacy/ward-stock?wardId=${ward.id}`);
  const expRow = (badView.data?.items ?? []).find((r: any) => r.drugBatchId === shelfExpired.id);
  const recRow = (badView.data?.items ?? []).find((r: any) => r.drugBatchId === shelfRecalled.id);
  ck(
    'the shelf shows the expiry date, so a nurse can spot expired stock',
    Boolean(expRow?.expiryDate) && new Date(expRow.expiryDate) < new Date(),
    expRow?.expiryDate ? String(expRow.expiryDate).slice(0, 10) : 'no expiry shown',
  );
  ck(
    'the shelf flags a recalled batch',
    Boolean(recRow) && (recRow.isRecalled === true || recRow.recalled === true),
    'the ward stock view carries no recall flag - a recalled batch looks normal on the shelf',
  );

  // -- 5. Sending stock back ------------------------------------------------
  section('5. Sending stock back to the pharmacy');
  const beforeReturn = await batchQty(batch.id);
  const shelfBefore = await shelfQty(ward.id, batch.id);
  const back = await api('pharm', 'POST', '/pharmacy/ward-stock/return', {
    wardId: ward.id,
    drugBatchId: batch.id,
    quantity: 20,
    reason: `${TAG} ward overstocked`,
  });
  ck('the ward can send stock back', back.status < 400, back.message);
  ck(
    'the shelf drops by 20',
    (await shelfQty(ward.id, batch.id)) === shelfBefore - 20,
    `${await shelfQty(ward.id, batch.id)}`,
  );
  ck('the pharmacy gets it back', (await batchQty(batch.id)) === beforeReturn + 20, `${await batchQty(batch.id)}`);
  led = await ledgerRows(ward.id, batch.id);
  const ret = led.find((r) => r.movementType === 'returned');
  ck('logged as returned, with the reason', Boolean(ret) && /overstocked/.test(ret?.reason ?? ''), ret?.reason ?? '');
  const tooMuchBack = await api('pharm', 'POST', '/pharmacy/ward-stock/return', {
    wardId: ward.id,
    drugBatchId: batch.id,
    quantity: 9999,
  });
  ck('cannot send back more than the ward holds', tooMuchBack.status >= 400, tooMuchBack.message);

  // -- 6. Correcting a physical count --------------------------------------
  section('6. Correcting a physical count');
  const centralBefore = await batchQty(batch.id);
  const onShelf = await shelfQty(ward.id, batch.id);
  const short = await api('pharm', 'POST', '/pharmacy/ward-stock/adjust', {
    wardId: ward.id,
    drugBatchId: batch.id,
    newQuantity: onShelf - 3,
    reason: `${TAG} breakage`,
  });
  ck('a count correction is accepted', short.status < 400, short.message);
  ck('the shelf now reads the counted figure', (await shelfQty(ward.id, batch.id)) === onShelf - 3);
  ck('the pharmacy is NOT touched - this corrects the ward only', (await batchQty(batch.id)) === centralBefore);
  led = await ledgerRows(ward.id, batch.id);
  const down = led.filter((r) => r.movementType === 'adjusted').pop();
  ck(
    'logged as adjusted, with the reason and both figures',
    Boolean(down) && /breakage/.test(down?.reason ?? '') && /→|->/.test(down?.reason ?? ''),
    down?.reason ?? '',
  );

  // A found-again correction goes the other way. The ledger has to say which
  // way, or a stock report cannot add the column up.
  const nowShelf = await shelfQty(ward.id, batch.id);
  await api('pharm', 'POST', '/pharmacy/ward-stock/adjust', {
    wardId: ward.id,
    drugBatchId: batch.id,
    newQuantity: nowShelf + 5,
    reason: `${TAG} found in the cupboard`,
  });
  led = await ledgerRows(ward.id, batch.id);
  const up = led.filter((r) => r.movementType === 'adjusted').pop();
  ck(
    'an upward correction is distinguishable from a downward one',
    (up?.quantity ?? 0) > 0 && (down?.quantity ?? 0) < 0,
    `found +5 stored as ${up?.quantity}, breakage -3 stored as ${down?.quantity}`,
  );
  const negative = await api('pharm', 'POST', '/pharmacy/ward-stock/adjust', {
    wardId: ward.id,
    drugBatchId: batch.id,
    newQuantity: -1,
    reason: `${TAG} impossible`,
  });
  ck('a negative count is refused', negative.status >= 400, negative.message);

  // -- 7. Nothing leaked ----------------------------------------------------
  section('7. Nothing leaked');
  const finalCentral = await batchQty(batch.id);
  const finalShelf = await shelfQty(ward.id, batch.id);
  led = await ledgerRows(ward.id, batch.id);
  const dispensed = led.filter((r) => r.movementType === 'dispensed').reduce((s, r) => s + Math.abs(r.quantity), 0);
  // Read off the signed quantity now that adjustments carry one. Reading the
  // direction out of the English in `reason` was only ever a workaround for
  // that sign being thrown away.
  const adjustedNet = led
    .filter((r) => r.movementType === 'adjusted')
    .reduce((s, r) => s + r.quantity, 0);
  const accounted = finalCentral + finalShelf + dispensed - adjustedNet;
  ck(
    'pharmacy + ward + doses given, less corrections, is what we started with',
    accounted === START,
    `${finalCentral} + ${finalShelf} + ${dispensed} - (${adjustedNet}) = ${accounted}, started ${START}`,
  );

  section('8. One hospital cannot see another one');
  // The earlier version of this check sent a made-up tenant id and called the
  // empty result a pass. That proves nothing: an id nobody owns matches nobody.
  // A real shelf under the OTHER hospital is the only thing worth asking about.
  const otherTenant = await p.tenant.findFirst({ where: { id: { not: TENANT } }, select: { id: true, name: true } });
  const otherWard = otherTenant
    ? await p.ward.findFirst({ where: { tenantId: otherTenant.id }, select: { id: true } })
    : null;
  if (otherTenant && otherWard) {
    const foreign: any = await p.wardStock.create({
      data: {
        tenantId: otherTenant.id,
        wardId: otherWard.id,
        drugId: drug.id,
        drugBatchId: batch.id,
        quantityInStock: 42,
      } as never,
    });
    const own = await api('pharm', 'GET', `/pharmacy/ward-stock?wardId=${ward.id}`);
    const leaked = (own.data?.items ?? []).some((r: any) => r.id === foreign.id);
    ck('this hospital cannot see the other hospital shelf', !leaked, `${otherTenant.name}`);
    const askForTheirs = await api('pharm', 'GET', `/pharmacy/ward-stock?wardId=${otherWard.id}`);
    ck(
      'and asking for their ward by id returns nothing',
      (askForTheirs.data?.items ?? []).length === 0,
      `${(askForTheirs.data?.items ?? []).length} rows`,
    );
    await p.wardStock.delete({ where: { id: foreign.id } });
  } else {
    ck('SKIPPED - only one hospital in this database', true, 'nothing to cross');
  }

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const drugBatchIds = (await p.drugBatch.findMany({ where: { drugId: drug.id }, select: { id: true } })).map(
    (b) => b.id,
  );
  const billIds = [
    ...new Set(
      (
        await p.wardStockLedger.findMany({
          where: { drugBatchId: { in: drugBatchIds } },
          select: { billId: true },
        })
      )
        .map((r) => r.billId)
        .filter((x): x is string => !!x),
    ),
  ];
  await p.wardStockLedger.deleteMany({ where: { drugBatchId: { in: drugBatchIds } } });
  await p.wardStock.deleteMany({ where: { drugBatchId: { in: drugBatchIds } } });
  // A voided or cancelled bill now carries a credit note that references it.
  await p.creditNote.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: TAG } } }).catch(() => {});
  await p.billItem.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: TAG } } });
  for (const id of billIds) {
    const remaining = await p.billItem.count({ where: { billId: id } });
    if (remaining === 0) await p.bill.deleteMany({ where: { id, billNumber: { startsWith: 'IPW' } } });
  }
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
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
