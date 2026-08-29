/**
 * End-to-end walk of the NDPS flow, over real HTTP against a running server.
 *
 * Kept because this flow spans four modules — inventory transfers, the NDPS
 * statutory records, the controlled register and the PDF documents — and the
 * faults that matter only appear when they run together. The unit suites all
 * passed while the register was reporting an opening balance of MINUS FIVE.
 *
 *   npm run db:ndps-e2e        (needs the dev server up and Redis running)
 *
 * Creates its own fixtures, tags them E2E-NDPS-<timestamp>, and deletes them
 * at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `E2E-NDPS-${Date.now()}`;
const p = new PrismaClient();

let pass = 0;
let fail = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  if (ok) pass += 1;
  else fail += 1;
  results.push('  ' + line);
}

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
  return { status: res.status, json };
}

async function apiRaw(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': TENANT },
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pharmacyadmin1@email.com', password: 'Admin@123' }),
  });
  const lj: any = await login.json();
  token = lj?.data?.accessToken ?? lj?.data?.tokens?.accessToken ?? '';
  check('login as pharmacy_admin', Boolean(token));
  if (!token) {
    console.log(results.join('\n'));
    return;
  }

  // ── Fixture: a vault-controlled narcotic with stock ──
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: `${TAG} Morphine Inj`,
      genericName: 'Morphine (10mg)',
      composition: 'Morphine (10mg)',
      dosageForm: 'injection',
      schedule: 'X',
      controlledClass: 'narcotic',
      vaultControlled: true,
      isNarcotic: true,
      unitOfMeasurement: 'vial',
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-B1`,
      quantityReceived: 100,
      quantityInStock: 100,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 100,
      sellingPrice: 120,
      mrp: 120,
    } as never,
  });
  const dept: any = await p.department.findFirst({ where: { tenantId: TENANT } });
  const custodian: any = await p.user.findFirst({
    where: { tenantId: TENANT, email: 'nurse1@email.com' },
    select: { id: true },
  });
  const me: any = await p.user.findFirst({
    where: { tenantId: TENANT, email: 'pharmacyadmin1@email.com' },
    select: { id: true },
  });
  const coSigner: any = await p.user.findFirst({
    where: { tenantId: TENANT, email: 'nurse2@email.com' },
    select: { id: true },
  });
  const patient: any = await p.patient.findFirst({
    where: { tenantId: TENANT },
    select: { id: true, mrn: true },
  });
  check('fixture: vault narcotic + batch', Boolean(drug.id && batch.id), 'qty 100');

  // ── 1. The removed transfer endpoint ──
  const gone = await api('POST', '/ndps/transfers', {
    drugFormularyId: drug.id,
    fromLocationId: custodian.id,
    toLocationId: custodian.id,
    quantity: 1,
    counterpartyId: custodian.id,
  });
  check('removed POST /ndps/transfers is gone', gone.status === 404, `got ${gone.status}`);

  // ── 2. Form 3C receipt ──
  const locs = await api('GET', '/ndps/locations');
  const vault = (locs.json?.data ?? []).find((l: any) => l.type === 'main_vault');
  check('NDPS vault location resolves', Boolean(vault), vault?.name ?? '');

  const recv = await api('POST', '/ndps/consignments', {
    drugFormularyId: drug.id,
    quantity: 20,
    batchNumber: `${TAG}-3C`,
    expiryDate: new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10),
    ndpsLicenseNumber: `${TAG}-LIC`,
    form3cNumber: `${TAG}-3CNO`,
    transportDetails: 'E2E courier',
  });
  check(
    'Form 3C receipt accepted',
    recv.status === 200 || recv.status === 201,
    `status ${recv.status} ${recv.json?.message ?? ''} ${JSON.stringify(recv.json?.errors ?? '')}`.trim(),
  );

  // ── 3. Transfer through the board, with the custody gate ──
  const created = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id,
    fromLocation: 'Main Pharmacy Vault',
    toDepartmentId: dept.id,
    quantityRequested: 5,
    reason: `${TAG} custody test`,
  });
  const transferId = created.json?.data?.id;
  check('narcotic stock transfer created', Boolean(transferId),
    `status ${created.status} ${created.json?.message ?? ''} ${JSON.stringify(created.json?.errors ?? '')}`.trim());

  if (transferId) {
    await api('PATCH', `/inventory/transfers/${transferId}/approve`, {});

    const noCust = await api('PATCH', `/inventory/transfers/${transferId}/dispatch`, {});
    check(
      'dispatch REFUSED with nobody taking custody',
      noCust.status >= 400 && /receiving/i.test(noCust.json?.message ?? ''),
      `${noCust.status}: ${(noCust.json?.message ?? '').slice(0, 60)}`,
    );

    const selfCust = await api('PATCH', `/inventory/transfers/${transferId}/dispatch`, {
      custodianId: me.id,
    });
    check(
      'dispatch REFUSED when custodian is the dispatcher',
      selfCust.status >= 400 && /cannot be the person/i.test(selfCust.json?.message ?? ''),
      `${selfCust.status}`,
    );

    const ok = await api('PATCH', `/inventory/transfers/${transferId}/dispatch`, {
      custodianId: custodian.id,
    });
    check('dispatch ACCEPTED with a proper hand-over', ok.status < 400, `status ${ok.status}`);

    const row: any = await p.stockTransfer.findUnique({ where: { id: transferId } });
    check(
      'custody recorded on the transfer',
      row?.custodianId === custodian.id && Boolean(row?.custodyAt),
    );
    const after: any = await p.drugBatch.findUnique({ where: { id: batch.id } });
    check('batch decremented by the dispatch', after?.quantityInStock === 95, `qty ${after?.quantityInStock}`);
  }

  // ── 3b. Form 3E administration and disposal, from their new home ──
  // Both moved off the deleted NDPS page onto the Controlled Register. They
  // draw on an NDPS LOCATION balance, which the Form 3C receipt above credited
  // to the vault — so this also proves the receipt actually landed somewhere
  // spendable rather than only writing an audit row.
  const consume = await api('POST', '/ndps/consumption', {
    drugFormularyId: drug.id,
    fromLocationId: vault?.id,
    quantity: 2,
    patientId: patient?.id,
    doctorRegNo: 'NMC-9875',
    bedNumber: 'ICU-04',
    diagnosis: 'Post-operative pain',
  });
  check('Form 3E administration accepted', consume.status === 200 || consume.status === 201,
    `status ${consume.status} ${consume.json?.message ?? ''}`);

  const disposal = await api('POST', '/ndps/disposals', {
    drugFormularyId: drug.id,
    locationId: vault?.id,
    quantity: 1,
    reasonCode: 'breakage',
    referenceNumber: `${TAG}-POLICE-1`,
    coSignById: coSigner?.id,
  });
  check('disposal accepted with a reference and a co-sign',
    disposal.status === 200 || disposal.status === 201,
    `status ${disposal.status} ${disposal.json?.message ?? ''}`);

  const noRef = await api('POST', '/ndps/disposals', {
    drugFormularyId: drug.id, locationId: vault?.id, quantity: 1,
    reasonCode: 'breakage', coSignById: coSigner?.id,
  });
  check('disposal REFUSED without a destruction reference', noRef.status >= 400, `${noRef.status}`);

  // ── 3c. Form 3H daily close ──
  const close = await api('POST', '/ndps/daily-close', {});
  check('Form 3H daily close runs', close.status === 200 || close.status === 201,
    `status ${close.status}`);

  // Narrowed server-side: the mapped response carries drugName but NOT
  // drugFormularyId, so filtering by id on the client would silently match
  // nothing and report a failure that is not there.
  const daily = await api('GET', `/ndps/daily-balances?drugFormularyId=${drug.id}`);
  const mine = (daily.json?.data?.items ?? daily.json?.data ?? [])[0];
  check('the daily account balances: opening + received − dispensed − disposed = closing',
    Boolean(mine) &&
      mine.openingBalance + mine.received - mine.dispensed - mine.disposed === mine.closingBalance,
    mine
      ? `${mine.openingBalance} + ${mine.received} − ${mine.dispensed} − ${mine.disposed} = ${mine.closingBalance}`
      : 'no daily row for this drug');

  // ── 4. The register sees it (the 8th source) ──
  const from = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const reg = await api(
    'GET',
    `/pharmacy/controlled-register?fromDate=${from}&toDate=${to}&drugIds=${drug.id}`,
  );
  const rows = reg.json?.data?.rows ?? [];
  check('register returns rows for the drug', rows.length > 0, `${rows.length} rows`);

  const xfer = rows.find((r: any) => r.txnType === 'Internal Transfer');
  check(
    'the board transfer appears in the register',
    Boolean(xfer),
    xfer ? `${xfer.txnId} qty=${xfer.transferQty} · ${xfer.patientOrDept}` : 'NOT FOUND',
  );
  check(
    'transfer shows as custody, not stock leaving',
    Boolean(xfer) && xfer.transferQty === 5 && xfer.qtyOut === 0,
  );
  check('the custodian is named as verification', Boolean(xfer?.verification), xfer?.verification ?? '');

  const inward = rows.find((r: any) => r.qtyIn > 0);
  check('the Form 3C receipt appears as inward', Boolean(inward), inward ? `${inward.txnType} +${inward.qtyIn}` : 'none');

  const admin3e = rows.find((r: any) => /3E/i.test(r.txnType));
  check('the Form 3E administration appears as outward', Boolean(admin3e) && admin3e.qtyOut === 2,
    admin3e ? `${admin3e.txnType} −${admin3e.qtyOut} · ${admin3e.patientOrDept} · ${admin3e.prescriber}` : 'NOT FOUND');
  check('the prescriber registration number is carried through',
    admin3e?.prescriber === 'NMC-9875', admin3e?.prescriber ?? '');

  const disp = rows.find((r: any) => /disposal/i.test(r.txnType));
  check('the disposal appears as outward', Boolean(disp) && disp.qtyOut === 1,
    disp ? `${disp.txnType} −${disp.qtyOut}` : 'NOT FOUND');

  // ── 5. Filters ──
  const onlyXfer = await api(
    'GET',
    `/pharmacy/controlled-register?fromDate=${from}&toDate=${to}&drugIds=${drug.id}&reportType=transfer`,
  );
  const xr = onlyXfer.json?.data?.rows ?? [];
  check(
    'reportType=transfer narrows to transfers',
    xr.length > 0 && xr.every((r: any) => r.transferQty > 0),
    `${xr.length} rows`,
  );

  const sched = await api('GET', `/pharmacy/controlled-register?fromDate=${from}&toDate=${to}&scheduleType=X`);
  check('scheduleType=X filter works', sched.status === 200, `${(sched.json?.data?.rows ?? []).length} rows`);

  const search = await api('GET', `/pharmacy/controlled-register?fromDate=${from}&toDate=${to}&search=${TAG}-B1`);
  check('search by batch number works', (search.json?.data?.rows ?? []).length > 0, `${(search.json?.data?.rows ?? []).length} rows`);

  const opts = await api('GET', '/pharmacy/controlled-register/drugs');
  check('the drug is offered in the item picker', (opts.json?.data ?? []).some((d: any) => d.id === drug.id));

  // ── 6. Summary arithmetic ──
  const s = reg.json?.data?.summary;
  // The identity must hold AND the opening must be physically possible. The
  // first check alone passed on an opening of -5, which is nonsense a drug
  // inspector would query first.
  check(
    'summary identity holds: opening + in − out − transferred = closing',
    Boolean(s) &&
      s.openingStock + s.inward - s.outward - (s.transferredOut ?? 0) === s.closingBalance,
    s ? `${s.openingStock} + ${s.inward} − ${s.outward} − ${s.transferredOut ?? 0} = ${s.closingBalance}` : '',
  );
  check('opening stock is not negative', Boolean(s) && s.openingStock >= 0, `opening ${s?.openingStock}`);
  // Derived, never hardcoded. A literal here went stale the moment the walk
  // gained its Form 3E and disposal steps — the arithmetic was right and the
  // constant was not, which is a test reporting a bug that is not there.
  const [live]: any[] = await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM(quantity_in_stock), 0)::int AS n FROM drug_batches WHERE drug_id = $1`,
    drug.id,
  );
  check('closing matches the live batch total', Boolean(s) && s.closingBalance === live.n,
    `closing ${s?.closingBalance} vs live ${live.n}`);

  // ── 7. The documents ──
  const pdf = await apiRaw(
    `/pharmacy/controlled-register/pdf?format=form35&fromDate=${from}&toDate=${to}&drugIds=${drug.id}`,
  );
  check(
    'Form 35 PDF renders',
    pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF',
    `${pdf.buf.length} bytes`,
  );

  const reg2 = await apiRaw(
    `/pharmacy/controlled-register/pdf?fromDate=${from}&toDate=${to}&drugIds=${drug.id}`,
  );
  check(
    'house register PDF still renders',
    reg2.status === 200 && reg2.buf.slice(0, 4).toString() === '%PDF',
    `${reg2.buf.length} bytes`,
  );

  // ── 8. Cleanup ──
  await p.stockTransfer.deleteMany({ where: { drugBatchId: batch.id } });
  await p.ndpsDailyBalance.deleteMany({ where: { drugFormularyId: drug.id } });
  await p.ndpsTransaction.deleteMany({ where: { drugFormularyId: drug.id } });
  await p.ndpsStockBalance.deleteMany({ where: { drugFormularyId: drug.id } });
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
  const left = await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } });
  check('fixtures cleaned up', left === 0);

  console.log('\n== NDPS end-to-end ==');
  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
