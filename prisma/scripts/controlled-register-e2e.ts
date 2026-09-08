/**
 * The Controlled-Drug Register, walked end to end.
 *
 * This is the document a drug inspector asks for. Every movement of a scheduled
 * or narcotic medicine, from every path it can take, in one chronological
 * ledger with a running balance — and the balance has to be defensible, because
 * a register that does not add up is worse than no register.
 *
 * Eight sources feed it, each the canonical record of its own movement, and the
 * ways they can go wrong are specific: a receipt counted twice, a movement that
 * never arrives, an opening balance walked back over the wrong set. So this
 * makes one of each movement and then asks the register about them.
 *
 *   npm run db:check-controlled-register     (needs the dev server up)
 *
 * Fixtures are tagged CDR-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `CDR-${Date.now()}`;
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

let token = '';
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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

/** The register, over a window wide enough to hold everything made below. */
const WINDOW = `fromDate=${new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}&toDate=${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}`;
const register = (extra = '') => api('GET', `/pharmacy/controlled-register?${WINDOW}${extra}`);
const mine = (rows: any[], drugName: string) => rows.filter((r) => r.itemName === drugName);

async function main() {
  section('Signing in');
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pharmacyadmin1@email.com', password: 'Admin@123' }),
  });
  const lj: any = await login.json();
  token = lj?.data?.accessToken ?? lj?.data?.tokens?.accessToken ?? '';
  ck('pharmacy admin', Boolean(token));
  if (!token) return;

  // -- Sweep anything a crashed earlier run left behind ---------------------
  const stale = await p.drugFormulary.findMany({
    where: { tenantId: TENANT, drugName: { startsWith: 'CDR-' } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((d) => d.id);
    const b = (await p.drugBatch.findMany({ where: { drugId: { in: ids } }, select: { id: true } })).map((x) => x.id);
    await p.ndpsTransaction.deleteMany({ where: { drugFormularyId: { in: ids } } });
    await p.ndpsStockBalance.deleteMany({ where: { drugFormularyId: { in: ids } } });
    await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.drugReturn.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.stockTransfer.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.auditLog.deleteMany({ where: { entityId: { in: b } } });
    await p.wardStockLedger.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.wardStock.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.drugBatch.deleteMany({ where: { drugId: { in: ids } } });
    await p.drugFormulary.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (swept ${stale.length} leftover fixture drug(s) from an earlier run)`);
  }

  // -- Fixtures: one narcotic, and one of every movement it can make --------
  section('Fixtures: one narcotic and one of every movement');
  const NAME = `${TAG} Morphine 10mg`;
  const RECEIVED = 500;
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: NAME,
      genericName: 'Morphine sulphate',
      composition: 'Morphine sulphate (10mg)',
      strength: '10mg',
      dosageForm: 'injection',
      unitOfMeasurement: 'ampoule',
      price: 40,
      taxPercent: 5,
      isNarcotic: true,
      vaultControlled: true,
      schedule: 'X',
      scheduleReason: 'Narcotic under the NDPS Act',
      controlledClass: 'narcotic',
    } as never,
  });
  const supplier = await p.supplier.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-B1`,
      quantityReceived: RECEIVED,
      quantityInStock: RECEIVED,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 30,
      sellingPrice: 40,
      mrp: 40,
      ...(supplier ? { supplierId: supplier.id } : {}),
    } as never,
  });
  const admin = await p.user.findFirst({ where: { tenantId: TENANT, email: 'pharmacyadmin1@email.com' }, select: { id: true } });
  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true, mrn: true } });
  ck('a Schedule X narcotic with a 500-unit receipt', Boolean(batch.id));
  ck('a patient to dispense to', Boolean(patient?.id), patient?.mrn ?? '');

  // A counter dispense (DispensingRecord).
  const DISPENSED = 12;
  await p.dispensingRecord.create({
    data: {
      tenantId: TENANT,
      drugBatchId: batch.id,
      patientId: patient!.id,
      quantityDispensed: DISPENSED,
      dispensedAt: new Date(),
      dispensedBy: admin!.id,
      unitPrice: 40,
      lineTotal: 480,
    } as never,
  });
  await p.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { decrement: DISPENSED } } });

  // A bedside Form 3E administration, and a disposal (NdpsTransaction).
  const ADMINISTERED = 3;
  const DISPOSED = 2;
  await p.ndpsTransaction.create({
    data: {
      tenantId: TENANT, drugFormularyId: drug.id, entryType: 'dispense',
      quantity: ADMINISTERED, batchNumber: batch.batchNumber, patientId: patient!.id,
      doctorRegNo: `${TAG}-REG-9`, recordedById: admin!.id, occurredAt: new Date(),
    } as never,
  });
  await p.ndpsTransaction.create({
    data: {
      tenantId: TENANT, drugFormularyId: drug.id, entryType: 'disposal',
      quantity: DISPOSED, batchNumber: batch.batchNumber, reasonCode: 'breakage',
      referenceNumber: `${TAG}-MEMO-1`, recordedById: admin!.id, occurredAt: new Date(),
    } as never,
  });
  await p.drugBatch.update({
    where: { id: batch.id },
    data: { quantityInStock: { decrement: ADMINISTERED + DISPOSED } },
  });

  // A vault → sub-store custody hand-off (NdpsTransaction 'transfer'). This one
  // moves NdpsStockBalance and must NOT change the batch.
  const CHALLAN = 25;
  const locations = await p.ndpsLocation.findMany({ where: { tenantId: TENANT }, select: { id: true, name: true }, take: 2 });
  if (locations.length >= 2) {
    await p.ndpsTransaction.create({
      data: {
        tenantId: TENANT, drugFormularyId: drug.id, entryType: 'transfer',
        quantity: CHALLAN, batchNumber: batch.batchNumber,
        fromLocationId: locations[0].id, toLocationId: locations[1].id,
        recordedById: admin!.id, counterpartyId: admin!.id, occurredAt: new Date(),
      } as never,
    });
    // A challan moves NdpsStockBalance too. Writing only the transaction row
    // would leave a state the application never produces, and the register
    // would then be measured against a balance nobody credited.
    for (const [locationId, sign] of [[locations[0].id, -1], [locations[1].id, 1]] as const) {
      await p.ndpsStockBalance.upsert({
        where: { tenantId_drugFormularyId_locationId: { tenantId: TENANT, drugFormularyId: drug.id, locationId } },
        create: { tenantId: TENANT, drugFormularyId: drug.id, locationId, quantity: sign * CHALLAN },
        update: { quantity: { increment: sign * CHALLAN } },
      } as never);
    }
  }

  // A stock-transfer dispatch off the transfer board. This one DOES decrement
  // the batch, which is the difference that once made the opening balance
  // negative.
  const BOARD_TRANSFER = 40;
  const ward = await p.ward.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  await p.stockTransfer.create({
    data: {
      tenantId: TENANT,
      transferNumber: `${TAG}-ST1`,
      drugBatchId: batch.id,
      fromLocation: 'Main Pharmacy',
      toLocation: ward?.name ?? 'Ward',
      ...(ward ? { toWardId: ward.id } : {}),
      quantityRequested: BOARD_TRANSFER,
      quantityTransferred: BOARD_TRANSFER,
      status: 'dispatched',
      dispatchedAt: new Date(),
      requestedBy: admin!.id,
      dispatchedBy: admin!.id,
      reason: `${TAG} ward issue`,
    } as never,
  });
  await p.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { decrement: BOARD_TRANSFER } } });

  // A deliberate count correction (AuditLog).
  const ADJUST = -6;
  await p.auditLog.create({
    data: {
      tenantId: TENANT,
      entityType: 'drug_batch',
      entityId: batch.id,
      action: 'update',
      userId: admin!.id,
      newValues: { type: 'stock_adjustment', delta: ADJUST, reason: `${TAG} spillage` },
    } as never,
  });
  await p.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { increment: ADJUST } } });

  const liveNow = (await p.drugBatch.findUnique({ where: { id: batch.id }, select: { quantityInStock: true } }))!.quantityInStock;
  ck(
    'the batch now holds what all that leaves',
    liveNow === RECEIVED - DISPENSED - ADMINISTERED - DISPOSED - BOARD_TRANSFER + ADJUST,
    `${liveNow}`,
  );

  // -- 1. Every movement reaches the register ------------------------------
  section('1. Every movement reaches the register');
  const all = await register();
  ck('the register loads', all.status < 400, `status ${all.status} ${all.message}`);
  const rows = mine(all.data?.rows ?? [], NAME);
  ck('it found this drug', rows.length > 0, `${rows.length} row(s)`);
  const typed = (t: string) => rows.filter((r: any) => r.txnType === t);

  ck('the receipt is there, named as a GRN', typed('Receipt (GRN)').length === 1, typed('Receipt (GRN)')[0]?.txnId ?? '');
  ck('...for the quantity received', typed('Receipt (GRN)')[0]?.qtyIn === RECEIVED, `${typed('Receipt (GRN)')[0]?.qtyIn}`);
  ck('...naming the supplier it came from', Boolean(typed('Receipt (GRN)')[0]?.patientOrDept), typed('Receipt (GRN)')[0]?.patientOrDept ?? 'no supplier');
  ck('the counter dispense is there', typed('Patient Disp.').length === 1);
  ck('...naming the patient', /MRN/.test(typed('Patient Disp.')[0]?.patientOrDept ?? ''), typed('Patient Disp.')[0]?.patientOrDept ?? '');
  ck('the bedside Form 3E administration is there', typed('Form 3E Admin.').length === 1);
  ck('...naming the prescriber registration', typed('Form 3E Admin.')[0]?.prescriber === `${TAG}-REG-9`, typed('Form 3E Admin.')[0]?.prescriber ?? '');
  ck('the disposal is there', typed('Disposal').length === 1, `qty out ${typed('Disposal')[0]?.qtyOut}`);
  ck('the count correction is there', typed('Adjustment').length === 1, typed('Adjustment')[0]?.patientOrDept ?? '');
  ck('...on the out side, since it went down', typed('Adjustment')[0]?.qtyOut === -ADJUST, `in ${typed('Adjustment')[0]?.qtyIn} out ${typed('Adjustment')[0]?.qtyOut}`);

  const transfers = typed('Internal Transfer');
  ck('the transfer-board dispatch is there', transfers.some((r: any) => r.txnId === `${TAG}-ST1`), `${transfers.length} transfer row(s)`);
  if (locations.length >= 2) {
    ck('the vault-to-sub-store challan is there', transfers.some((r: any) => r.transferQty === CHALLAN && r.txnId !== `${TAG}-ST1`));
  }

  ck(
    'every row carries the active ingredient, not just the brand',
    rows.every((r: any) => r.apiStrength),
    rows.find((r: any) => !r.apiStrength)?.txnType ?? 'all rows have it',
  );
  ck('every row says why the drug is controlled', rows.every((r: any) => r.schedule && r.scheduleReason));

  // -- 2. The balance has to add up ----------------------------------------
  section('2. The balance has to add up');
  const s = all.data?.summary ?? {};
  ck('the opening balance is not negative', s.openingStock >= 0, `${s.openingStock}`);
  ck(
    'inward, outward and transfers are totalled off the rows shown',
    s.inward === (all.data?.rows ?? []).reduce((n: number, r: any) => n + r.qtyIn, 0) &&
      s.outward === (all.data?.rows ?? []).reduce((n: number, r: any) => n + r.qtyOut, 0),
    `in ${s.inward} out ${s.outward}`,
  );
  ck(
    'a custody move is counted as a transfer, not as stock leaving',
    s.internalTransfer >= BOARD_TRANSFER,
    `${s.internalTransfer} transferred`,
  );
  ck(
    'and the part of it that really left the pharmacy is reported separately',
    s.transferredOut >= BOARD_TRANSFER,
    `${s.transferredOut} left the dispensable pool`,
  );

  // The register's own claim: opening, plus everything shown, is the closing
  // balance — and that closing balance is the stock actually on the shelf.
  const walked = (all.data?.rows ?? []).reduce(
    (n: number, r: any) => n + (r.stockDelta || r.qtyIn - r.qtyOut),
    s.openingStock,
  );
  ck('opening plus every row equals the closing balance', walked === s.closingBalance, `${walked} vs ${s.closingBalance}`);

  const [{ live }]: any[] = await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM(b.quantity_in_stock),0)::int live FROM drug_batches b
      JOIN drug_formulary d ON d.id = b.drug_id
     WHERE b.tenant_id = $1 AND (d.controlled_class IS NOT NULL OR d.is_narcotic = true
           OR d.vault_controlled = true OR d.schedule IN ('X','H1'))`, TENANT);
  ck(
    'and the closing balance is the stock actually on the shelf',
    s.closingBalance === live,
    `register says ${s.closingBalance}, shelves hold ${live}`,
  );

  const chained = (all.data?.rows ?? []).every((r: any, i: number, arr: any[]) =>
    i === 0 || arr[i - 1].closing === r.opening);
  ck('each row opens where the one before it closed', chained);

  // -- 3. Nothing is counted twice -----------------------------------------
  section('3. Nothing is counted twice');
  // Form 3C inward creates a DrugBatch, so it must be read from the batch and
  // NOT from NdpsTransaction as well.
  const form3c: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `3C-${TAG}`,
      quantityReceived: 100, quantityInStock: 100,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 30, sellingPrice: 40, mrp: 40,
    } as never,
  });
  await p.ndpsTransaction.create({
    data: {
      tenantId: TENANT, drugFormularyId: drug.id, entryType: 'inward',
      quantity: 100, batchNumber: `3C-${TAG}`, form3cNumber: `${TAG}/3C/1`,
      recordedById: admin!.id, occurredAt: new Date(),
    } as never,
  });
  const afterFormC = await register();
  const fRows = mine(afterFormC.data?.rows ?? [], NAME);
  ck(
    'a Form 3C consignment appears exactly once',
    fRows.filter((r: any) => r.batchNumber === `3C-${TAG}`).length === 1,
    `${fRows.filter((r: any) => r.batchNumber === `3C-${TAG}`).length} row(s)`,
  );
  ck('...and is labelled as Form 3C inward, not an ordinary GRN',
    fRows.find((r: any) => r.batchNumber === `3C-${TAG}`)?.txnType === 'Form 3C Inward',
    fRows.find((r: any) => r.batchNumber === `3C-${TAG}`)?.txnType ?? '');

  // A quarantined return is held in its own batch. The return row is the
  // movement; counting the batch too would show the stock coming back twice.
  const quar: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `QUAR-${TAG}-B1`,
      quantityReceived: 5, quantityInStock: 5,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 30, sellingPrice: 40, mrp: 40, isRecalled: true,
    } as never,
  });
  const afterQuar = await register();
  ck(
    'a quarantine batch is not read as a receipt',
    !mine(afterQuar.data?.rows ?? [], NAME).some((r: any) => r.batchNumber === `QUAR-${TAG}-B1`),
  );

  // Opening stock is not a movement.
  const openingBatch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `NDPS-OPENING-${TAG}`,
      quantityReceived: 77, quantityInStock: 77,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 30, sellingPrice: 40, mrp: 40,
    } as never,
  });
  const afterOpening = await register();
  ck(
    'stock the hospital already held is not read as a receipt',
    !mine(afterOpening.data?.rows ?? [], NAME).some((r: any) => r.batchNumber === `NDPS-OPENING-${TAG}`),
  );
  ck('the opening balance is still not negative', (afterOpening.data?.summary?.openingStock ?? -1) >= 0,
    `${afterOpening.data?.summary?.openingStock}`);

  // -- 4. The filters ------------------------------------------------------
  section('4. The filters');
  const inward = await register('&reportType=inward');
  ck(
    'inward shows only what came in',
    (inward.data?.rows ?? []).every((r: any) => r.qtyIn > 0),
    `${(inward.data?.rows ?? []).length} row(s)`,
  );
  const outward = await register('&reportType=outward');
  ck('outward shows only what went out', (outward.data?.rows ?? []).every((r: any) => r.qtyOut > 0));
  const transferOnly = await register('&reportType=transfer');
  ck('transfer shows only custody moves', (transferOnly.data?.rows ?? []).every((r: any) => r.transferQty > 0));

  const byDrug = await register(`&drugIds=${drug.id}`);
  ck(
    'picking one item narrows to that item',
    (byDrug.data?.rows ?? []).length > 0 && (byDrug.data?.rows ?? []).every((r: any) => r.itemName === NAME),
    `${(byDrug.data?.rows ?? []).length} row(s)`,
  );

  const bySchedule = await register('&scheduleType=NDPS');
  ck('the NDPS list covers this narcotic', mine(bySchedule.data?.rows ?? [], NAME).length > 0);
  const byX = await register('&scheduleType=X');
  ck('so does Schedule X', mine(byX.data?.rows ?? [], NAME).length > 0);
  const byG = await register('&scheduleType=G');
  ck('and Schedule G does not', mine(byG.data?.rows ?? [], NAME).length === 0);

  const byBatch = await register(`&search=${TAG}-B1`);
  ck(
    'searching a batch number finds its movements',
    (byBatch.data?.rows ?? []).length > 0 && (byBatch.data?.rows ?? []).every((r: any) => r.batchNumber === `${TAG}-B1`),
    `${(byBatch.data?.rows ?? []).length} row(s)`,
  );
  const byMrn = await register(`&search=${patient!.mrn}`);
  ck('searching an MRN finds that patient', (byMrn.data?.rows ?? []).some((r: any) => (r.patientOrDept ?? '').includes(patient!.mrn)));

  const byDoc = await register(`&doctorRegNo=${TAG}-REG-9`);
  ck(
    'narrowing to one prescriber works',
    (byDoc.data?.rows ?? []).length > 0 && (byDoc.data?.rows ?? []).every((r: any) => (r.prescriber ?? '').includes(`${TAG}-REG-9`)),
    `${(byDoc.data?.rows ?? []).length} row(s)`,
  );

  if (locations.length >= 2) {
    const atLocation = await register(`&locationId=${locations[1].id}`);
    const unfiltered = await register();
    ck(
      'narrowing to one sub-store actually narrows something',
      (atLocation.data?.rows ?? []).length < (unfiltered.data?.rows ?? []).length,
      `${(atLocation.data?.rows ?? []).length} rows vs ${(unfiltered.data?.rows ?? []).length} unfiltered`,
    );
    ck(
      'and shows only movements that touched that safe',
      (atLocation.data?.rows ?? []).every((r: any) => r.txnType === 'Internal Transfer' || r.txnType === 'Form 3E Admin.' || r.txnType === 'Disposal'),
      [...new Set((atLocation.data?.rows ?? []).map((r: any) => r.txnType))].join(', '),
    );
    // The screen promises the balance re-bases to the safe. A vault-wide figure
    // beside rows from one cupboard would be worse than no figure.
    const safeBalance = await p.ndpsStockBalance.aggregate({
      where: { tenantId: TENANT, locationId: locations[1].id },
      _sum: { quantity: true },
    });
    ck(
      'the balance re-bases to that safe, as the screen promises',
      atLocation.data?.summary?.closingBalance === (safeBalance._sum.quantity ?? 0),
      `register says ${atLocation.data?.summary?.closingBalance}, the safe holds ${safeBalance._sum.quantity ?? 0}`,
    );
    ck(
      'and is not the pharmacy-wide figure',
      atLocation.data?.summary?.closingBalance !== unfiltered.data?.summary?.closingBalance,
      `${atLocation.data?.summary?.closingBalance} vs ${unfiltered.data?.summary?.closingBalance} pharmacy-wide`,
    );
  }

  const picker = await api('GET', '/pharmacy/controlled-register/drugs');
  ck('the item picker lists this drug', (picker.data ?? []).some((d: any) => d.id === drug.id), `${(picker.data ?? []).length} controlled drug(s)`);
  ck('...with its strength, for cross-referencing', Boolean((picker.data ?? []).find((d: any) => d.id === drug.id)?.apiStrength));

  // -- 5. A controlled dose given from a ward shelf ------------------------
  // Every pharmacy path writes a DispensingRecord, which is what the register
  // reads. The ward shelf is a separate inventory with its own ledger, so the
  // question is whether a controlled dose given at a bedside reaches the
  // register at all. An inspector does not care which internal table it came
  // from.
  //
  // A vault narcotic cannot be dispensed from ward stock — the controlled gate
  // sends it to the Form 3E workflow — so the case that matters is the tier
  // BELOW the vault: a Schedule H1 psychotropic like tramadol, which the
  // register covers and a ward may legitimately hold.
  section('5. A controlled dose given from a ward shelf');
  if (ward?.id) {
    const H1NAME = `${TAG} Tramadol 50mg`;
    const h1: any = await p.drugFormulary.create({
      data: {
        tenantId: TENANT,
        drugName: H1NAME,
        genericName: 'Tramadol hydrochloride',
        composition: 'Tramadol hydrochloride (50mg)',
        strength: '50mg', dosageForm: 'capsule', unitOfMeasurement: 'capsule',
        price: 12, taxPercent: 5,
        schedule: 'H1',
        scheduleReason: 'Schedule H1 - psychotropic',
        controlledClass: 'psychotropic',
        isNarcotic: false,
        vaultControlled: false,
      } as never,
    });
    const h1Batch: any = await p.drugBatch.create({
      data: {
        tenantId: TENANT, drugId: h1.id, batchNumber: `${TAG}-H1`,
        quantityReceived: 100, quantityInStock: 100,
        expiryDate: new Date(Date.now() + 400 * 864e5),
        purchasePrice: 8, sellingPrice: 12, mrp: 12,
      } as never,
    });
    await p.wardStock.create({
      data: { tenantId: TENANT, wardId: ward.id, drugId: h1.id, drugBatchId: h1Batch.id, quantityInStock: 20 } as never,
    });

    const before = await register();
    const beforeRows = mine(before.data?.rows ?? [], H1NAME).length;

    const dose = await api('POST', '/pharmacy/ward-stock/dispense', {
      wardId: ward.id, drugBatchId: h1Batch.id, patientId: patient!.id, quantity: 2, override: true,
    });
    ck('a Schedule H1 drug can be given from a ward shelf', dose.status < 400, `status ${dose.status} ${dose.message.slice(0, 60)}`);

    if (dose.status < 400) {
      const after = await register();
      const afterRows = mine(after.data?.rows ?? [], H1NAME);
      ck(
        'and that dose reaches the statutory register',
        afterRows.length > beforeRows,
        `${beforeRows} row(s) before the dose, ${afterRows.length} after - the ward ledger is not one of the register sources`,
      );
      ck(
        'naming the patient it was given to',
        afterRows.some((r: any) => (r.patientOrDept ?? '').includes(patient!.mrn)),
        'no row on the register names the patient',
      );
      // The balance was only checked before any ward movement existed, which is
      // how a unit test caught a double-count this walk had missed: a ward dose
      // spends stock that already left the batch when it was ISSUED, so taking
      // it off again is taking it twice.
      const [{ live2 }]: any[] = await p.$queryRawUnsafe(
        `SELECT COALESCE(SUM(b.quantity_in_stock),0)::int live2 FROM drug_batches b
          JOIN drug_formulary d ON d.id = b.drug_id
         WHERE b.tenant_id = $1 AND (d.controlled_class IS NOT NULL OR d.is_narcotic = true
               OR d.vault_controlled = true OR d.schedule IN ('X','H1'))`, TENANT);
      // The screen prints the sum as a line an inspector can follow:
      //   opening + inward - outward - transferredOut = closing
      // If that no longer adds up, the report contradicts itself in the one
      // place someone is most likely to check it with a pen.
      const t = after.data?.summary ?? {};
      ck(
        'the arithmetic printed on the screen still adds up',
        t.openingStock + t.inward - t.outward - (t.transferredOut ?? 0) + (t.outwardAlreadyIssued ?? 0) === t.closingBalance,
        `${t.openingStock} + ${t.inward} - ${t.outward} - ${t.transferredOut} + ${t.outwardAlreadyIssued} = ${t.openingStock + t.inward - t.outward - (t.transferredOut ?? 0) + (t.outwardAlreadyIssued ?? 0)}, but closing says ${t.closingBalance}`,
      );
      ck(
        'and the balance still matches the shelf afterwards',
        after.data?.summary?.closingBalance === live2,
        `register says ${after.data?.summary?.closingBalance}, shelves hold ${live2}`,
      );
    }

    await p.billItem.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: `${TAG} Tramadol` } } });
    await p.wardStockLedger.deleteMany({ where: { drugBatchId: h1Batch.id } });
    await p.wardStock.deleteMany({ where: { drugBatchId: h1Batch.id } });
    await p.dispensingRecord.deleteMany({ where: { drugBatchId: h1Batch.id } });
    await p.drugBatch.deleteMany({ where: { drugId: h1.id } });
    await p.drugFormulary.deleteMany({ where: { id: h1.id } });
  }

  // -- 5b. Moving a controlled drug onto a ward shelf ----------------------
  // The pharmacy's own transfer board writes a StockTransfer, which the
  // register reads. The ward-stock screen moves the same stock by a different
  // route, and the question is whether the register notices.
  //
  // The test is the OPENING balance. It is derived — today's stock, walked back
  // over everything that has moved since the window opened — so a movement the
  // walk-back does not know about silently rewrites the past. Nothing about
  // history changes by moving stock today, so asking the same question twice
  // must give the same answer.
  section('5b. Moving a controlled drug onto a ward shelf');
  if (ward?.id) {
    const beforeMove = await register();
    const openingBefore = beforeMove.data?.summary?.openingStock;
    const rowsBefore = (beforeMove.data?.rows ?? []).length;

    const moved = await api('POST', '/pharmacy/ward-stock/transfer', {
      wardId: ward.id, drugBatchId: batch.id, quantity: 30,
    });
    ck('a controlled drug can be sent to a ward shelf', moved.status < 400, `status ${moved.status} ${moved.message.slice(0, 60)}`);

    if (moved.status < 400) {
      const afterMove = await register();
      ck(
        'the movement appears on the register',
        (afterMove.data?.rows ?? []).length > rowsBefore,
        `${rowsBefore} rows before, ${(afterMove.data?.rows ?? []).length} after`,
      );
      ck(
        'and the opening balance, which is history, does not change',
        afterMove.data?.summary?.openingStock === openingBefore,
        `${openingBefore} before, ${afterMove.data?.summary?.openingStock} after - a move today rewrote the past`,
      );
    }
  }

  // -- 6. Form 35 ----------------------------------------------------------
  section('6. Form 35, the printed register');
  const pdfRes = await fetch(`${API}/pharmacy/controlled-register/pdf?${WINDOW}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': TENANT },
  });
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  ck('the register prints', pdfRes.status < 400, `status ${pdfRes.status}`);
  ck('...as a PDF', buf.subarray(0, 5).toString() === '%PDF-', buf.subarray(0, 8).toString().replace(/\n/g, ''));
  ck('...with content, not an empty page', buf.length > 3000, `${(buf.length / 1024).toFixed(1)} KB`);
  ck('...served as a download', /pdf/i.test(pdfRes.headers.get('content-type') ?? ''), pdfRes.headers.get('content-type') ?? '');

  // -- 7. Who can read it --------------------------------------------------
  section('7. Who can read it');
  const anon = await fetch(`${API}/pharmacy/controlled-register?${WINDOW}`, { headers: { 'X-Tenant-Id': TENANT } });
  ck('it is not readable without signing in', anon.status === 401, `status ${anon.status}`);

  const nurse = await p.user.findFirst({
    where: { tenantId: TENANT, isActive: true, userRoles: { some: { role: { name: 'nurse' } } } },
    select: { email: true },
  });
  if (nurse) {
    const nl = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: nurse.email, password: 'Admin@123' }),
    });
    const nj: any = await nl.json();
    const nt = nj?.data?.accessToken ?? nj?.data?.tokens?.accessToken ?? '';
    if (nt) {
      const asNurse = await fetch(`${API}/pharmacy/controlled-register?${WINDOW}`, {
        headers: { Authorization: `Bearer ${nt}`, 'X-Tenant-Id': TENANT },
      });
      ck('a nurse cannot pull the statutory register', asNurse.status === 403, `status ${asNurse.status}`);
    }
  }

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const batchIds = (await p.drugBatch.findMany({ where: { drugId: drug.id }, select: { id: true } })).map((b) => b.id);
  await p.ndpsTransaction.deleteMany({ where: { drugFormularyId: drug.id } });
  await p.ndpsStockBalance.deleteMany({ where: { drugFormularyId: drug.id } });
  await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.drugReturn.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.stockTransfer.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.auditLog.deleteMany({ where: { entityId: { in: batchIds } } });
  await p.billItem.deleteMany({ where: { referenceType: 'ward_dispense', description: { contains: TAG } } });
  await p.wardStockLedger.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.wardStock.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
  ck('fixtures cleaned up', (await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } })) === 0);
  void form3c; void quar; void openingBatch;

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
