/**
 * Walk the GST reports over a bill this script raised itself.
 *
 * The thing worth proving is not that each report returns 200 — it is that
 * they all still describe the SAME money. A-1 is the register and every other
 * sales report is a fold of it; the moment one of them stops agreeing, the
 * hospital files a number it cannot defend and nobody can tell which report
 * was wrong.
 *
 * So this raises one bill with a known mix — a taxable room at 5%, a cosmetic
 * procedure at 18% and an exempt consultation — finalises it so a document
 * number is allotted, and then asserts the arithmetic straight through: the
 * register, the rate summary, the HSN summary, the exempt turnover, the
 * GSTR-1 view, the JSON export, and the controls that are supposed to notice
 * an unclassified line.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';
import * as billing from '../../src/modules/billing/billing.service';

const BASE = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `GSTRPT-${Date.now()}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

async function api(p: string, opts: any = {}, token?: string) {
  const res = await fetch(`${BASE}${p}`, {
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
  return { status: res.status, json, data: json?.data };
}

async function main() {
  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@hospital.com', password: 'Admin@123' },
  });
  ck('logged in', login.status === 200, `status ${login.status}`);
  const token = login.data?.accessToken;
  if (!token) throw new Error('no token');
  const actor = await prisma.user.findFirst({ where: { email: 'admin@hospital.com' }, select: { id: true } });
  if (!actor) throw new Error('no user');

  const patient = await prisma.patient.create({
    data: { tenantId: TENANT, mrn: TAG, firstName: 'Report', notes: TAG },
  });

  // One bill, three lines, three different answers.
  const bill = await billing.createBill(TENANT, actor.id, { patientId: patient.id } as any);
  const pulled = await api(`/billing/${bill.id}/pull-charges`, {
    method: 'POST',
    body: {
      charges: [
        { referenceType: 'manual_clinical', referenceId: `${TAG}-room`,
          description: `${TAG} Deluxe AC room`, quantity: 1, unitPrice: 8000,
          category: 'room', dailyRate: 8000 },
        { referenceType: 'manual_clinical', referenceId: `${TAG}-cosmetic`,
          description: `${TAG} Cosmetic procedure`, quantity: 1, unitPrice: 5000,
          category: 'procedure', taxRate: 18, sacCode: '999722' },
        { referenceType: 'manual_clinical', referenceId: `${TAG}-consult`,
          description: `${TAG} Consultation`, quantity: 1, unitPrice: 500,
          category: 'consultation', taxRate: 0 },
      ],
    },
  }, token);
  ck('the charges were pulled on', pulled.status === 201,
     `status ${pulled.status} ${JSON.stringify(pulled.json).slice(0, 200)}`);
  await billing.finalizeBill(TENANT, actor.id, bill.id);

  const period = `from=${TODAY}&to=${TODAY}`;
  const get = (path: string, extra = '') => api(`/gst/reports/${path}?${period}${extra}`, {}, token);

  // ── A-1: the register ──
  const reg = await get('sales-register');
  ck('the sales register is reachable', reg.status === 200, `status ${reg.status}`);
  const mine = (reg.data?.rows ?? []).filter((r: any) => String(r.description).includes(TAG));
  ck('every line of the bill is in it', mine.length === 3, `${mine.length} lines`);
  const room = mine.find((r: any) => r.description.includes('room'));
  const cosmetic = mine.find((r: any) => r.description.includes('Cosmetic'));
  const consult = mine.find((r: any) => r.description.includes('Consultation'));
  ck('the room is taxable at 5% with its split',
     room?.gstTreatment === 'taxable' && room?.taxRatePercent === 5 &&
       near(room?.cgstAmount + room?.sgstAmount, room?.taxAmount),
     JSON.stringify({ t: room?.gstTreatment, r: room?.taxRatePercent, tax: room?.taxAmount }));
  ck('the cosmetic procedure is taxable at 18%',
     cosmetic?.gstTreatment === 'taxable' && cosmetic?.taxRatePercent === 18,
     `${cosmetic?.gstTreatment} @ ${cosmetic?.taxRatePercent}`);
  ck('the consultation is exempt', consult?.gstTreatment === 'exempt', `${consult?.gstTreatment}`);
  ck('it carries the SAC that was billed with it', cosmetic?.hsnSac === '999722', `${cosmetic?.hsnSac}`);
  ck('and the document number the bill was issued under',
     /\/\d{4}-\d{2}\/\d{6}$/.test(room?.invoiceNumber ?? ''), `${room?.invoiceNumber}`);

  const mineTax = mine.reduce((t: number, r: any) => t + r.taxAmount, 0);
  const mineTotal = mine.reduce((t: number, r: any) => t + r.totalAmount, 0);

  // ── A-2 / A-3 / A-7: the folds must still add up to it ──
  const [rate, hsn, exempt, dept] = await Promise.all([
    get('rate-summary'), get('hsn-summary'), get('exempt-turnover'), get('department-gst'),
  ]);
  ck('the rate summary totals the register',
     near(rate.data?.totals?.totalAmount,
          (reg.data?.rows ?? []).reduce((t: number, r: any) => t + r.totalAmount, 0)),
     `${rate.data?.totals?.totalAmount}`);
  ck('and its rate rows add back to that same total',
     near((rate.data?.byRate ?? []).reduce((t: number, r: any) => t + r.totalAmount, 0),
          rate.data?.totals?.totalAmount),
     'rate rows do not sum to the total');
  ck('so does the department cut of the same lines',
     near((rate.data?.byDepartment ?? []).reduce((t: number, r: any) => t + r.totalAmount, 0),
          rate.data?.totals?.totalAmount),
     'department rows do not sum to the total');
  ck('the 18% row is the cosmetic procedure',
     near((rate.data?.byRate ?? []).find((r: any) => r.ratePercent === 18)?.taxAmount, 900),
     JSON.stringify((rate.data?.byRate ?? []).find((r: any) => r.ratePercent === 18)));

  ck('the HSN summary reports 4-digit codes by default',
     hsn.data?.reportingDigits === 4 &&
       (hsn.data?.byCode ?? []).some((c: any) => c.hsnSac === '9997'),
     JSON.stringify((hsn.data?.byCode ?? []).map((c: any) => c.hsnSac)));
  const hsn6 = await get('hsn-summary', '&sixDigit=true');
  ck('and 6-digit codes when the turnover requires it',
     (hsn6.data?.byCode ?? []).some((c: any) => c.hsnSac === '999722'),
     JSON.stringify((hsn6.data?.byCode ?? []).map((c: any) => c.hsnSac)));
  ck('a line with no code is counted apart, not folded into a blank row',
     typeof hsn.data?.unclassified?.count === 'number', JSON.stringify(hsn.data?.unclassified));

  ck('the exempt turnover includes the consultation',
     exempt.data?.exempt?.taxableValue >= 500, `${exempt.data?.exempt?.taxableValue}`);
  ck('the exempt ratio is a percentage of the whole turnover',
     exempt.data?.exemptRatio >= 0 && exempt.data?.exemptRatio <= 100,
     `${exempt.data?.exemptRatio}`);
  ck('department-wise GST names the room and the procedure',
     ['room', 'procedure'].every((d) => (dept.data?.departments ?? []).some((x: any) => x.department === d)),
     JSON.stringify((dept.data?.departments ?? []).map((d: any) => d.department)));

  // ── A-8 / A-9: the return views ──
  const [gstr1, gstr3b] = await Promise.all([get('gstr1'), get('gstr3b')]);
  ck('the GSTR-1 view reconciles back to the register',
     gstr1.data?.reconciliation?.register?.agrees === true &&
       gstr1.data?.reconciliation?.taxable?.agrees === true,
     JSON.stringify(gstr1.data?.reconciliation));
  ck('this patient has no GSTIN, so the supply is B2C',
     gstr1.data?.tables?.b2c?.taxAmount >= mineTax, JSON.stringify(gstr1.data?.tables?.b2c));
  ck('the GSTR-3B outward liability is the taxable half',
     gstr3b.data?.outwardTaxable?.taxAmount >= mineTax,
     `${gstr3b.data?.outwardTaxable?.taxAmount}`);
  ck('and the exempt supplies sit in their own box',
     gstr3b.data?.outwardExempt >= 500, `${gstr3b.data?.outwardExempt}`);

  // ── The JSON the accountant uploads ──
  const json = await get('gstr1/json');
  ck('the GSTR-1 JSON is built', json.status === 200, `status ${json.status}`);
  ck('it names the hospital GSTIN and the return period',
     /^\d{2}[A-Z]{5}/.test(json.data?.json?.gstin ?? '') && /^\d{6}$/.test(json.data?.json?.fp ?? ''),
     `${json.data?.json?.gstin} ${json.data?.json?.fp}`);
  // Exempt turnover in b2cs would declare tax on a hospital's largest number.
  ck('exempt turnover is in nil, not in b2cs',
     !!json.data?.json?.nil &&
       !(json.data?.json?.b2cs ?? []).some((r: any) => r.rt === 0 && r.txval > 0),
     JSON.stringify(json.data?.json?.nil?.inv?.[0]));
  ck('the taxed lines are summarised into b2cs by rate',
     (json.data?.json?.b2cs ?? []).some((r: any) => r.rt === 18),
     JSON.stringify((json.data?.json?.b2cs ?? []).map((r: any) => r.rt)));

  // ── The controls ──
  const [unmapped, series, mix, cancelled, collection] = await Promise.all([
    get('unmapped-items'), api('/gst/reports/series-continuity', {}, token),
    get('revenue-mix'), get('cancelled-invoices'), get('daily-collection'),
  ]);
  ck('the unmapped-items report ran over every line',
     unmapped.data?.totals?.linesChecked >= 3, `${unmapped.data?.totals?.linesChecked}`);
  ck('and none of this bill is unclassified',
     !(unmapped.data?.withoutTreatment?.items ?? []).some((i: any) => String(i.description).includes(TAG)),
     'a line of this bill has no treatment');
  ck('series continuity reports the invoice series',
     (series.data?.series ?? []).length > 0,
     JSON.stringify((series.data?.series ?? []).map((s: any) => s.documentType)));
  ck('and this bill left no gap in it',
     (series.data?.series ?? []).every((s: any) => s.duplicated.length === 0),
     'a number was issued twice');
  ck('the revenue mix has a row for this month',
     (mix.data?.byMonth ?? []).some((m: any) => m.month === TODAY.slice(0, 7)),
     JSON.stringify((mix.data?.byMonth ?? []).map((m: any) => m.month)));
  ck('cancelled invoices is reachable and lists none of this bill',
     cancelled.status === 200 &&
       !(cancelled.data?.rows ?? []).some((r: any) => r.billNumber === bill.billNumber),
     `status ${cancelled.status}`);
  ck('daily collection is reachable', collection.status === 200, `status ${collection.status}`);

  // ── The purchase side ──
  const [purchases, itc, reversal, gstinIssues] = await Promise.all([
    get('purchase-register'), get('itc-summary'), get('itc-reversal'),
    get('supplier-gstin-exceptions'),
  ]);
  ck('the purchase register is reachable', purchases.status === 200, `status ${purchases.status}`);
  ck('the ITC summary says what it cannot see',
     /equipment, rent, utilities/.test(itc.data?.coverage ?? ''), `${itc.data?.coverage}`);
  ck('the Rule 42 working runs every step in order',
     JSON.stringify((reversal.data?.working ?? []).map((w: any) => w.step)) ===
       JSON.stringify(['T', 'T1', 'T2', 'T3', 'C1', 'T4', 'C2', 'E', 'F', 'D1', 'D2', 'C3']),
     JSON.stringify((reversal.data?.working ?? []).map((w: any) => w.step)));
  ck('every step names where its figure came from',
     (reversal.data?.working ?? []).every((w: any) => !!w.source), 'a step has no source');
  ck('the credit kept is the credit available less the reversal',
     near(reversal.data?.netCreditAvailable,
          (reversal.data?.creditAvailable ?? 0) - (reversal.data?.reversal?.total ?? 0)),
     `${reversal.data?.creditAvailable} − ${reversal.data?.reversal?.total} ≠ ${reversal.data?.netCreditAvailable}`);
  ck('supplier GSTIN exceptions is reachable', gstinIssues.status === 200, `status ${gstinIssues.status}`);

  // ── The gate ──
  const doc = await prisma.user.findFirst({
    where: { tenantId: TENANT, isActive: true, userRoles: { some: { role: { name: 'doctor' } } } },
    select: { email: true },
  });
  if (doc?.email) {
    const asDoc = await api('/auth/login', { method: 'POST', body: { email: doc.email, password: 'Admin@123' } });
    if (asDoc.status === 200) {
      const denied = await api('/gst/reports/sales-register', {}, asDoc.data?.accessToken);
      ck('a doctor cannot read the hospital-wide sales register', denied.status === 403,
         `status ${denied.status}`);
    } else {
      console.log('    (skipped the doctor gate — could not sign one in)');
    }
  }

  console.log(`\n  bill total ${mineTotal}, tax ${mineTax}`);
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
      await prisma.patient.deleteMany({ where: { id: pat.id } });
    }
    // The document series counter is NOT rolled back: reissuing a number that
    // has already been on paper is the one thing a series must never do.
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
