/**
 * Does a drug transfer actually reach the ward's shelf?
 *
 * The whole reason for naming a ward on a transfer. Before this, dispatch
 * decremented the pharmacy batch and receive did nothing at all — the medicine
 * left the pharmacy and was tracked nowhere, and every dispatched drug transfer
 * in the live database had produced zero ward-stock ledger rows.
 *
 *   npm run db:check-ward-transfer      (needs the dev server up)
 *
 * Creates its own fixtures, tagged WARDXFER-<timestamp>, and deletes them.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `WARDXFER-${Date.now()}`;
const p = new PrismaClient();

let pass = 0;
let fail = 0;
function ck(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass += 1;
  else fail += 1;
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

  // ── Fixture: an ORDINARY drug, to prove this is not narcotics-only ──
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT,
      drugName: `${TAG} Paracetamol 500`,
      genericName: 'Paracetamol (500mg)',
      composition: 'Paracetamol (500mg)',
      dosageForm: 'tablet',
      unitOfMeasurement: 'tablet',
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT,
      drugId: drug.id,
      batchNumber: `${TAG}-B1`,
      quantityReceived: 200,
      quantityInStock: 200,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 10,
      sellingPrice: 12,
      mrp: 12,
    } as never,
  });
  const ward: any = await p.ward.findFirst({ where: { tenantId: TENANT }, select: { id: true, name: true } });
  ck('fixture: an ordinary (non-narcotic) drug with stock', Boolean(drug.id && batch.id && ward?.id), ward?.name ?? '');

  // ── The flow: create → approve → dispatch → receive ──
  const created = await api('POST', '/inventory/transfers', {
    drugBatchId: batch.id,
    fromLocation: 'Main Pharmacy',
    toWardId: ward.id,
    toLocation: ward.name,
    quantityRequested: 25,
    reason: `${TAG} ward issue`,
  });
  const id = created.json?.data?.id;
  ck('transfer created naming a ward', Boolean(id), `status ${created.status} ${created.json?.message ?? ''}`);
  if (!id) return;

  await api('PATCH', `/inventory/transfers/${id}/approve`, {});

  // An ordinary drug needs no custodian — that is the narcotic rule only.
  const dispatched = await api('PATCH', `/inventory/transfers/${id}/dispatch`, {});
  ck('dispatch needs no custodian for an ordinary drug', dispatched.status < 400, `status ${dispatched.status}`);

  const afterDispatch: any = await p.drugBatch.findUnique({ where: { id: batch.id } });
  ck('pharmacy batch decremented', afterDispatch?.quantityInStock === 175, `qty ${afterDispatch?.quantityInStock}`);

  const received = await api('PATCH', `/inventory/transfers/${id}/receive`, {});
  ck('receive accepted', received.status < 400, `status ${received.status}`);

  // ── The point: is it on the ward's shelf? ──
  const shelf: any = await p.wardStock.findFirst({
    where: { tenantId: TENANT, wardId: ward.id, drugBatchId: batch.id },
  });
  ck('the stock is ON the ward shelf', shelf?.quantityInStock === 25, `ward holds ${shelf?.quantityInStock ?? 0}`);

  const ledger: any = await p.wardStockLedger.findFirst({
    where: { tenantId: TENANT, wardId: ward.id, drugBatchId: batch.id, movementType: 'received' },
  });
  ck('a received ledger row was written', Boolean(ledger), ledger?.reason ?? '');
  ck('the ledger names the transfer it came from', /ST-/.test(ledger?.reason ?? ''), ledger?.reason ?? '');

  // ── Nothing is double-counted ──
  const total = (afterDispatch?.quantityInStock ?? 0) + (shelf?.quantityInStock ?? 0);
  ck('pharmacy + ward equals what we started with', total === 200, `${afterDispatch?.quantityInStock} + ${shelf?.quantityInStock} = ${total}`);

  // ── Cleanup ──
  await p.wardStockLedger.deleteMany({ where: { drugBatchId: batch.id } });
  await p.wardStock.deleteMany({ where: { drugBatchId: batch.id } });
  await p.stockTransfer.deleteMany({ where: { drugBatchId: batch.id } });
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
  ck('fixtures cleaned up', (await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } })) === 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
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
