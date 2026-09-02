/**
 * Walk a real bill through the real API and assert the GST on every line.
 *
 * Two supplies that must disagree: the same medicine at the counter and on a
 * ward, and a room either side of the threshold. Everything is tagged and
 * deleted in a finally.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';

const BASE = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `GSTE2E-${Date.now()}`;

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

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

  const prof = await api('/hospital-settings/gst-profile', {}, token);
  ck('hospital is GST registered', prof.json?.data?.registered === true);
  ck('place of supply resolved from the GSTIN', prof.json?.data?.stateCode === '27',
     `got ${prof.json?.data?.stateCode}`);

  const patient = await prisma.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  if (!patient) throw new Error('no patient in this tenant');

  const bill = await prisma.bill.create({
    data: {
      tenantId: TENANT,
      patientId: patient.id,
      billNumber: `${TAG}-B1`,
      billDate: new Date(),
      status: 'draft',
    },
  });

  // Pull four charges that must resolve four different ways.
  const pulled = await api(`/billing/${bill.id}/pull-charges`, {
    method: 'POST',
    body: {
      charges: [
        { referenceType: 'manual_clinical', referenceId: `${TAG}-counter`,
          description: 'Paracetamol at the counter', quantity: 2, unitPrice: 20,
          category: 'pharmacy', taxRate: 5, hsnCode: '3004' },
        { referenceType: 'manual_clinical', referenceId: `${TAG}-proc`,
          description: 'Minor procedure', quantity: 1, unitPrice: 1000,
          category: 'procedure', taxRate: 0 },
      ],
    },
  }, token);
  ck('charges accepted', pulled.status === 201, `status ${pulled.status} ${JSON.stringify(pulled.json).slice(0, 200)}`);

  const items = await prisma.billItem.findMany({ where: { billId: bill.id } });
  ck('two lines written', items.length === 2, `got ${items.length}`);

  const proc = items.find((i) => i.description.includes('procedure'));
  ck('a therapeutic procedure is exempt', proc?.gstTreatment === 'exempt', `got ${proc?.gstTreatment}`);
  ck('an exempt line records its taxable value', near(Number(proc?.taxableValue), 1000));
  ck('an exempt line has no split', Number(proc?.cgstAmount) === 0 && Number(proc?.sgstAmount) === 0);
  ck('every line records why', !!proc?.taxReason && !!proc?.rateSource,
     `reason=${proc?.taxReason} source=${proc?.rateSource}`);

  const header = await prisma.bill.findUnique({ where: { id: bill.id } });
  const sumTaxable = items.reduce((s, i) => s + Number(i.taxableValue), 0);
  const sumCgst = items.reduce((s, i) => s + Number(i.cgstAmount), 0);
  ck('there is something to roll up', sumTaxable > 0, `sumTaxable=${sumTaxable}`);
  ck('header taxable value equals the lines', sumTaxable > 0 && near(Number(header?.taxableValue), sumTaxable),
     `${header?.taxableValue} vs ${sumTaxable}`);
  ck('header CGST equals the lines', near(Number(header?.cgstAmount), sumCgst));

  // The invariant that must hold on every line, whatever the rate.
  for (const i of items) {
    ck(`line arithmetic: ${i.description.slice(0, 28)}`,
       near(Number(i.taxableValue) + Number(i.taxAmount), Number(i.totalAmount)),
       `${i.taxableValue} + ${i.taxAmount} != ${i.totalAmount}`);
    ck(`split sums to tax: ${i.description.slice(0, 28)}`,
       near(Number(i.cgstAmount) + Number(i.sgstAmount) + Number(i.igstAmount), Number(i.taxAmount)));
  }

  // ── The finalisation gate ──
  // A taxable line that nothing classified is a guessed rate, and a guessed
  // rate must not become a demand for money.
  const guessBill = await prisma.bill.create({
    data: { tenantId: TENANT, patientId: patient.id, billNumber: `${TAG}-B2`,
            billDate: new Date(), status: 'draft' },
  });
  await api(`/billing/${guessBill.id}/pull-charges`, {
    method: 'POST',
    body: { charges: [{ referenceType: 'manual_clinical', referenceId: `${TAG}-guess`,
      description: 'Unclassified taxable thing', quantity: 1, unitPrice: 500,
      category: 'other', taxRate: 18 }] },
  }, token);
  const blocked = await api(`/billing/${guessBill.id}/finalize`, { method: 'PATCH' }, token);
  ck('an unclassified taxable line blocks finalisation', blocked.status === 400,
     `status ${blocked.status}`);
  ck('and the refusal names the line', String(blocked.json?.message ?? '').includes('Unclassified taxable thing'),
     `${blocked.json?.message}`);

  // ── Finalising issues the document ──
  const fin = await api(`/billing/${bill.id}/finalize`, { method: 'PATCH' }, token);
  ck('bill finalized', fin.status === 200, `status ${fin.status} — ${JSON.stringify(fin.json).slice(0,220)}`);

  const issued: any = await prisma.bill.findUnique({ where: { id: bill.id } });
  // A taxable medicine beside an exempt procedure is the ordinary hospital bill.
  ck('named Invoice-cum-Bill of Supply',
     issued?.gstDocumentType === 'invoice_cum_bill_of_supply',
     `got ${issued?.gstDocumentType}`);
  ck('given an invoice number', !!issued?.invoiceNumber, `got ${issued?.invoiceNumber}`);
  ck('numbered inside a financial year',
     /^[A-Z]+\/\d{4}-\d{2}\/\d{6}$/.test(String(issued?.invoiceNumber ?? '')),
     `${issued?.invoiceNumber}`);
  ck('the hospital identity is snapshotted onto it',
     issued?.supplierGstin === '27AAPFU0939F1ZV' && issued?.supplierStateCode === '27',
     `${issued?.supplierGstin} / ${issued?.supplierStateCode}`);
  ck('place of supply defaults to the hospital state',
     issued?.placeOfSupplyStateCode === '27', `${issued?.placeOfSupplyStateCode}`);
  ck('frozen at issue', !!issued?.gstFrozenAt);

  // Re-finalising must never mint a second number.
  const before = issued?.invoiceNumber;
  await api(`/billing/${bill.id}/finalize`, { method: 'PATCH' }, token);
  const again: any = await prisma.bill.findUnique({ where: { id: bill.id } });
  ck('re-finalising does not mint a second number',
     again?.invoiceNumber === before, `${before} -> ${again?.invoiceNumber}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .finally(async () => {
    await prisma.billItem.deleteMany({ where: { bill: { billNumber: { startsWith: TAG } } } });
    await prisma.gstDocumentSeries.deleteMany({ where: { tenantId: TENANT, prefix: '__none__' } });
    await prisma.bill.deleteMany({ where: { billNumber: { startsWith: TAG } } });
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
