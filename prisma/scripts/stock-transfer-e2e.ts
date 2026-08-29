/**
 * The whole stock-transfer flow, over real HTTP.
 *
 * Stock transfer is now the one place stock moves, for every kind of drug, so
 * the walk covers the whole lifecycle rather than the happy path: each state
 * transition, both item kinds (a drug that lands on a ward shelf and a
 * consumable that stays department-scoped), the refusals that keep it honest,
 * and the ward operations that spend what arrived.
 *
 * The property that matters throughout is CONSERVATION — the pharmacy batch and
 * the ward shelf are disjoint ledgers, so every movement between them must
 * leave the total unchanged. A transfer that loses stock is exactly the bug
 * this flow used to have.
 *
 *   npm run db:stock-transfer-e2e      (needs the dev server up)
 *
 * Creates its own fixtures, tagged STE2E-<timestamp>, and deletes them.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `STE2E-${Date.now()}`;
const p = new PrismaClient();

let pass = 0;
let fail = 0;
const lines: string[] = [];
function ck(name: string, ok: boolean, detail = '') {
  lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass += 1;
  else fail += 1;
}
function section(title: string) {
  lines.push(`\n── ${title} ──`);
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
  return { status: res.status, json, msg: json?.message ?? '' };
}

const batchQty = async (id: string) =>
  (await p.drugBatch.findUnique({ where: { id }, select: { quantityInStock: true } }))?.quantityInStock ?? 0;
const shelfQty = async (wardId: string, drugBatchId: string) =>
  (await p.wardStock.findFirst({ where: { tenantId: TENANT, wardId, drugBatchId } }))?.quantityInStock ?? 0;

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pharmacyadmin1@email.com', password: 'Admin@123' }),
  });
  const lj: any = await login.json();
  token = lj?.data?.accessToken ?? lj?.data?.tokens?.accessToken ?? '';
  ck('login as pharmacy_admin', Boolean(token));
  if (!token) return;

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: `${TAG} Paracetamol 500`,
      genericName: 'Paracetamol (500mg)',
      composition: 'Paracetamol (500mg)',
      dosageForm: 'tablet',
      unitOfMeasurement: 'tablet',
      price: 12,
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-B1`,
      quantityReceived: 200, quantityInStock: 200,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 10, sellingPrice: 12, mrp: 12,
    } as never,
  });
  const ward: any = await p.ward.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  const dept: any = await p.department.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  const patient: any = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('fixtures ready', Boolean(drug.id && batch.id && ward?.id && dept?.id),
    `${ward?.name} · ${dept?.name} · 200 in pharmacy`);

  const START = 200;

  // ── 1. Creating ──────────────────────────────────────────────────────────
  section('creating');

  const noDest = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id, fromLocation: 'Main Pharmacy', quantityRequested: 5,
  });
  ck('refuses a transfer with no destination', noDest.status >= 400, `${noDest.status}`);

  const bothKinds = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id, inventoryItemId: batch.id,
    fromLocation: 'Main Pharmacy', toWardId: ward.id, quantityRequested: 5,
  });
  ck('refuses both a drug and an item on one transfer', bothKinds.status >= 400, `${bothKinds.status}`);

  const created = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id,
    fromLocation: 'Main Pharmacy',
    toWardId: ward.id,
    toLocation: ward.name,
    quantityRequested: 40,
    reason: `${TAG} ward issue`,
  });
  const id = created.json?.data?.id;
  ck('creates a drug transfer naming a ward', Boolean(id), `${created.status} ${created.msg}`);
  ck('it starts pending', created.json?.data?.status === 'pending', created.json?.data?.status);
  ck('nothing has moved yet', (await batchQty(batch.id)) === START, `pharmacy ${await batchQty(batch.id)}`);

  // ── 2. Out-of-order transitions ──────────────────────────────────────────
  section('order of operations');

  const earlyDispatch = await api('PATCH', `/inventory/transfers/${id}/dispatch`, {});
  ck('refuses to dispatch before approval', earlyDispatch.status >= 400 && /approved/i.test(earlyDispatch.msg),
    earlyDispatch.msg.slice(0, 50));

  const earlyReceive = await api('PATCH', `/inventory/transfers/${id}/receive`, {});
  ck('refuses to receive before dispatch', earlyReceive.status >= 400 && /dispatched/i.test(earlyReceive.msg),
    earlyReceive.msg.slice(0, 50));

  // ── 3. Reject, then a fresh one ──────────────────────────────────────────
  section('reject and cancel');

  const toReject = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id, fromLocation: 'Main Pharmacy', toWardId: ward.id,
    toLocation: ward.name, quantityRequested: 5,
  });
  const rejected = await api('PATCH', `/inventory/transfers/${toReject.json?.data?.id}/reject`, {
    rejectionReason: 'Not needed on the ward',
  });
  ck('a transfer can be rejected with a reason', rejected.json?.data?.status === 'rejected', rejected.json?.data?.status);
  ck('rejecting moves no stock', (await batchQty(batch.id)) === START, `pharmacy ${await batchQty(batch.id)}`);

  const toCancel = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id, fromLocation: 'Main Pharmacy', toWardId: ward.id,
    toLocation: ward.name, quantityRequested: 5,
  });
  const cancelled = await api('PATCH', `/inventory/transfers/${toCancel.json?.data?.id}/cancel`, {
    reason: 'Raised by mistake',
  });
  ck('a transfer can be cancelled', cancelled.json?.data?.status === 'cancelled', cancelled.json?.data?.status);
  ck('cancelling moves no stock', (await batchQty(batch.id)) === START, `pharmacy ${await batchQty(batch.id)}`);

  // ── 4. Approve → dispatch → receive ──────────────────────────────────────
  section('the movement itself');

  const approved = await api('PATCH', `/inventory/transfers/${id}/approve`, {});
  ck('approve moves it to approved', approved.json?.data?.status === 'approved', approved.json?.data?.status);
  ck('approving still moves no stock', (await batchQty(batch.id)) === START);

  const overDraw = await api('PATCH', `/inventory/transfers/${id}/dispatch`, { quantityDispatched: 9999 });
  ck('refuses to dispatch more than the batch holds',
    overDraw.status >= 400 && /Insufficient/i.test(overDraw.msg), overDraw.msg.slice(0, 46));

  // Dispatch LESS than requested — the shelf must get what actually moved.
  const dispatched = await api('PATCH', `/inventory/transfers/${id}/dispatch`, { quantityDispatched: 25 });
  ck('dispatches an ordinary drug with no custodian', dispatched.status < 400, `${dispatched.status}`);
  ck('pharmacy decremented by what was DISPATCHED, not requested',
    (await batchQty(batch.id)) === START - 25, `pharmacy ${await batchQty(batch.id)} (requested 40, sent 25)`);
  ck('nothing on the shelf until it is received', (await shelfQty(ward.id, batch.id)) === 0);

  const received = await api('PATCH', `/inventory/transfers/${id}/receive`, {});
  ck('receive accepted', received.status < 400, `${received.status}`);
  ck('the shelf holds what was dispatched', (await shelfQty(ward.id, batch.id)) === 25,
    `ward ${await shelfQty(ward.id, batch.id)}`);
  ck('CONSERVATION: pharmacy + ward = the start',
    (await batchQty(batch.id)) + (await shelfQty(ward.id, batch.id)) === START,
    `${await batchQty(batch.id)} + ${await shelfQty(ward.id, batch.id)} = ${START}`);

  const ledgerIn = await p.wardStockLedger.findFirst({
    where: { tenantId: TENANT, wardId: ward.id, drugBatchId: batch.id, movementType: 'received' },
  });
  ck('a received ledger row names the transfer', /ST-/.test(ledgerIn?.reason ?? ''), ledgerIn?.reason ?? '');

  const twice = await api('PATCH', `/inventory/transfers/${id}/receive`, {});
  ck('refuses to receive the same transfer twice', twice.status >= 400, `${twice.status}`);
  ck('...and the shelf was not credited again', (await shelfQty(ward.id, batch.id)) === 25);

  // ── 5. Spending what arrived ─────────────────────────────────────────────
  section('ward operations');

  if (patient?.id) {
    const dispense = await api('POST', '/pharmacy/ward-stock/dispense', {
      wardId: ward.id, drugBatchId: batch.id, patientId: patient.id, quantity: 5,
    });
    ck('dispense to a patient from the ward shelf', dispense.status < 400, `${dispense.status} ${dispense.msg}`);
    ck('the shelf went down by the dose', (await shelfQty(ward.id, batch.id)) === 20,
      `ward ${await shelfQty(ward.id, batch.id)}`);
  } else {
    ck('dispense skipped — no patient in this tenant', true);
  }

  const before = await batchQty(batch.id);
  const ret = await api('POST', '/pharmacy/ward-stock/return', {
    wardId: ward.id, drugBatchId: batch.id, quantity: 4, reason: `${TAG} surplus`,
  });
  ck('return surplus to the pharmacy', ret.status < 400, `${ret.status} ${ret.msg}`);
  ck('the pharmacy got it back', (await batchQty(batch.id)) === before + 4,
    `pharmacy ${before} → ${await batchQty(batch.id)}`);

  const shelfNow = await shelfQty(ward.id, batch.id);
  const adjust = await api('POST', '/pharmacy/ward-stock/adjust', {
    wardId: ward.id, drugBatchId: batch.id, newQuantity: shelfNow - 1, reason: `${TAG} count correction`,
  });
  ck('correct the ward count', adjust.status < 400, `${adjust.status} ${adjust.msg}`);
  ck('the corrected count stuck', (await shelfQty(ward.id, batch.id)) === shelfNow - 1,
    `ward ${shelfNow} → ${await shelfQty(ward.id, batch.id)}`);

  const moves = await p.wardStockLedger.findMany({
    where: { tenantId: TENANT, wardId: ward.id, drugBatchId: batch.id },
    select: { movementType: true },
  });
  const kinds = new Set(moves.map((m) => m.movementType));
  ck('every movement is on the ledger', kinds.has('received') && kinds.has('returned') && kinds.has('adjusted'),
    [...kinds].join(', '));

  // ── 6. A ward is for medicines ───────────────────────────────────────────
  section('destination rules');

  const item: any = await p.inventoryItem.findFirst({
    where: { tenantId: TENANT }, select: { id: true, itemName: true, currentStock: true },
  });
  if (item?.id) {
    const wardConsumable = await api('POST', '/inventory/transfers', {
      inventoryItemId: item.id, fromLocation: 'Store', toWardId: ward.id, quantityRequested: 1,
    });
    ck('refuses a consumable sent to a ward shelf', wardConsumable.status >= 400,
      `${wardConsumable.status} ${wardConsumable.msg.slice(0, 44)}`);

    const deptTransfer = await api('POST', '/inventory/transfers', {
      inventoryItemId: item.id, fromLocation: 'Store', toDepartmentId: dept.id, quantityRequested: 1,
    });
    ck('a consumable to a DEPARTMENT still works', deptTransfer.status < 400,
      `${deptTransfer.status} ${deptTransfer.msg}`);
    if (deptTransfer.json?.data?.id) {
      await api('PATCH', `/inventory/transfers/${deptTransfer.json.data.id}/cancel`, { reason: 'e2e' });
    }
  } else {
    ck('consumable checks skipped — no inventory item in this tenant', true);
  }

  // ── 7. It shows up where people look ─────────────────────────────────────
  section('visibility');

  const list = await api('GET', '/inventory/transfers?limit=100');
  const mine = (list.json?.data ?? []).find((t: any) => t.id === id);
  ck('the transfer is on the board', Boolean(mine), mine ? `status ${mine.status}` : 'not found');
  ck('it carries the ward it went to', mine?.toWardId === ward.id, mine?.toWardId ?? 'none');

  // The endpoint answers { items, total }, not a bare array.
  const shelf = await api('GET', `/pharmacy/ward-stock?wardId=${ward.id}`);
  const shelfRows: any[] = shelf.json?.data?.items ?? shelf.json?.data ?? [];
  ck('the ward-stock screen shows it', shelfRows.some((r) => r.drugBatchId === batch.id),
    `${shelfRows.length} line(s) on the shelf`);

  const led = await api('GET', `/pharmacy/ward-stock/ledger?wardId=${ward.id}`);
  const ledRows: any[] = led.json?.data?.items ?? led.json?.data ?? [];
  ck('the ledger screen shows the movements', ledRows.length > 0, `${ledRows.length} row(s)`);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await p.wardStockLedger.deleteMany({ where: { drugBatchId: batch.id } });
  await p.wardStock.deleteMany({ where: { drugBatchId: batch.id } });
  await p.dispensingRecord.deleteMany({ where: { drugBatchId: batch.id } });
  await p.stockTransfer.deleteMany({ where: { drugBatchId: batch.id } });
  await p.stockTransfer.deleteMany({ where: { reason: { contains: TAG } } });
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
  const left = await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } });
  ck('fixtures cleaned up', left === 0);
}

main()
  .catch((e) => {
    console.error(e);
    fail += 1;
  })
  .finally(async () => {
    console.log('\n══ stock transfer, end to end ══');
    console.log(lines.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await p.$disconnect();
    process.exit(fail ? 1 : 0);
  });
