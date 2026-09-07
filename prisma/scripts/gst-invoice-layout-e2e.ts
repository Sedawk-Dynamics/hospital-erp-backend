/**
 * Walk a real IP bill onto paper and assert it is a GST document.
 *
 * The layout is the one place where being wrong is invisible in the data and
 * obvious to an auditor: the numbers can all be right while the paper fails to
 * say what it is, what the HSN was, or how the tax split. So this builds a
 * MIXED stay — an exempt inpatient medicine beside a deluxe room above the
 * threshold, which is the ordinary Indian hospital bill — finalises it so a
 * document number is allotted, and then reads both renderings.
 *
 * The PDF is saved and its text extracted separately (PyMuPDF), because a
 * column that silently truncates looks perfect in JSON.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../src/config/database';
import * as billing from '../../src/modules/billing/billing.service';
import * as clinical from '../../src/modules/clinical/clinical.service';

const BASE = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `INVLAY-${Date.now()}`;
const OUT = process.env.PDF_OUT ?? path.join(process.cwd(), 'tmp-invoice-layout.pdf');

/** 128 characters — the longest bill line this database actually holds. */
const LONG_DESCRIPTION =
  `IndentAntibiotic-${TAG} (Batch B-${TAG}-605912, exp 07/07/2027) — ward indent IND-20260707-0001, 2 pack(s)`;

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

  // No surname on purpose: every TEMP patient has none, and the name must not
  // print as "null" on the one document the patient keeps.
  const patient = await prisma.patient.create({
    data: { tenantId: TENANT, mrn: TAG, firstName: 'Invoice', notes: TAG },
  });
  const visit = await prisma.visit.create({
    data: {
      tenantId: TENANT, patientId: patient.id, doctorId: doctor.id,
      visitDate: new Date(), visitType: 'ip', status: 'completed', chiefComplaint: TAG,
    },
  });
  const adm: any = await clinical.createAdmission(TENANT, ACTOR, {
    visitId: visit.id, patientId: patient.id, doctorId: doctor.id,
    admissionDate: new Date().toISOString(), admissionReason: TAG,
  } as any);
  ck('admitted', !!adm?.id);

  // ── An exempt line: a medicine given to an admitted patient is part of the
  // treatment, and the treatment is exempt. Its description is the longest one
  // in the database, so the column either wraps or loses half of it.
  const added: any = await billing.addIpCharge(TENANT, ACTOR, adm.id, {
    description: LONG_DESCRIPTION, quantity: 2, unitPrice: 120, category: 'pharmacy',
  }, ['admin']);
  const billId = added.billId;
  ck('the ward medicine is exempt', added.item?.gstTreatment === 'exempt',
     `${added.item?.gstTreatment}`);

  // ── A taxable line: room rent above the threshold is taxed on the WHOLE
  // day's rent, and it beats the composite rule.
  const pulled = await api(`/billing/${billId}/pull-charges`, {
    method: 'POST',
    body: {
      charges: [{
        referenceType: 'manual_clinical', referenceId: `${TAG}-room`,
        description: `${TAG} Deluxe AC room — 1 day`, quantity: 1, unitPrice: 8000,
        category: 'room', dailyRate: 8000,
      }],
    },
  }, token);
  ck('the room charge was pulled on', pulled.status === 201,
     `status ${pulled.status} ${JSON.stringify(pulled.json).slice(0, 200)}`);

  const roomItem = await prisma.billItem.findFirst({
    where: { billId, description: { contains: 'Deluxe AC room' } },
  });
  ck('the deluxe room is taxable at 5%',
     roomItem?.gstTreatment === 'taxable' && Number(roomItem?.taxPercent) === 5,
     `${roomItem?.gstTreatment} @ ${roomItem?.taxPercent}`);

  // ── Finalising is what ISSUES the document and allots its number.
  await billing.finalizeBill(TENANT, ACTOR, billId);

  const docRes = await api(`/billing/admissions/${adm.id}/bill-document`, {}, token);
  ck('the bill document is reachable', docRes.status === 200, `status ${docRes.status}`);
  const d = docRes.json?.data;
  const g = d?.gst;

  // ── What the document calls itself ──
  ck('a mixed bill is an Invoice-cum-Bill of Supply',
     g?.documentType === 'invoice_cum_bill_of_supply', `${g?.documentType}`);
  // Issued means issued: a numbered document declared in a return cannot print
  // titled "Interim Bill" just because the patient is still on the ward.
  ck('and that is the title on the paper, admitted or not',
     d?.documentTitle === 'Invoice-cum-Bill of Supply', `${d?.documentTitle}`);
  ck('while the still-accruing warning stays on it', d?.isDischarged === false,
     `${d?.isDischarged}`);
  ck('it carries the allotted number', /\/\d{4}-\d{2}\/\d{6}$/.test(g?.invoiceNumbers?.[0] ?? ''),
     `${g?.invoiceNumbers}`);
  ck('and the hospital GSTIN it was issued under', /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(g?.supplierGstin ?? ''),
     `${g?.supplierGstin}`);
  ck('the place of supply is named, not just coded', !!g?.placeOfSupplyStateName,
     `${g?.placeOfSupplyStateCode} ${g?.placeOfSupplyStateName}`);
  ck('a patient in the same state is billed CGST/SGST, not IGST', g?.isInterState === false,
     `${g?.isInterState}`);

  // ── Per line ──
  const lines = (d?.groups ?? []).flatMap((x: any) => x.lines);
  const room = lines.find((l: any) => String(l.description).includes('Deluxe AC room'));
  const med = lines.find((l: any) => String(l.description).includes('IndentAntibiotic'));
  ck('the taxable line carries its own split',
     near(Number(room?.cgstAmount) + Number(room?.sgstAmount), Number(room?.taxAmount)) &&
       Number(room?.taxAmount) > 0,
     `c${room?.cgstAmount} s${room?.sgstAmount} of ${room?.taxAmount}`);
  ck('room rent is taxed on the WHOLE day, not the excess',
     near(Number(room?.taxableValue) + Number(room?.taxAmount), Number(room?.totalAmount)) &&
       near(Number(room?.taxableValue), 8000),
     `${room?.taxableValue} + ${room?.taxAmount} = ${room?.totalAmount}`);
  ck('the exempt line says so in words the patient can read',
     med?.treatmentLabel === 'Exempt' && Number(med?.taxAmount) === 0,
     `${med?.treatmentLabel} / ${med?.taxAmount}`);

  // ── The rate-wise summary ──
  ck('the summary has one row per rate', g?.taxSummary?.length === 2,
     JSON.stringify(g?.taxSummary?.map((r: any) => `${r.label} ${r.ratePercent}%`)));
  const taxedRow = g?.taxSummary?.find((r: any) => r.treatment === 'taxable');
  const exemptRow = g?.taxSummary?.find((r: any) => r.treatment === 'exempt');
  ck('the taxed row is the room at 5%',
     taxedRow?.ratePercent === 5 && near(Number(taxedRow?.taxableValue), 8000),
     JSON.stringify(taxedRow));
  ck('the exempt row carries value but no tax',
     near(Number(exemptRow?.taxableValue), 240) && Number(exemptRow?.taxAmount) === 0,
     JSON.stringify(exemptRow));
  ck('the summary adds up to the document total',
     near(Number(g?.totals?.taxAmount),
          Number(taxedRow?.taxAmount ?? 0) + Number(exemptRow?.taxAmount ?? 0)),
     `${g?.totals?.taxAmount}`);
  ck('the reverse-charge declaration is on a tax invoice',
     (g?.notes ?? []).some((n: string) => n.includes('reverse charge')), JSON.stringify(g?.notes));
  ck('and the exemption the untaxed lines rely on is named',
     (g?.notes ?? []).some((n: string) => n.includes('12/2017')), JSON.stringify(g?.notes));

  // ── The PDF ──
  const pdfRes = await fetch(`${BASE}/billing/admissions/${adm.id}/bill-document/pdf`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': TENANT },
  });
  ck('the PDF is served', pdfRes.status === 200, `status ${pdfRes.status}`);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  fs.writeFileSync(OUT, buf);
  ck('and it is a real PDF', buf.subarray(0, 5).toString() === '%PDF-', `${buf.length} bytes`);
  console.log(`\n  pdf: ${OUT}`);
  console.log(`  admission: ${adm.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .finally(async () => {
    if (process.env.KEEP === '1') { await prisma.$disconnect(); return; }
    const pat = await prisma.patient.findFirst({ where: { mrn: TAG }, select: { id: true } });
    if (pat) {
      const pays = await prisma.payment.findMany({ where: { patientId: pat.id }, select: { id: true } });
      const ids = pays.map((x) => x.id);
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
      await prisma.admission.deleteMany({ where: { patientId: pat.id, admissionReason: TAG } });
      await prisma.visit.deleteMany({ where: { patientId: pat.id } });
      await prisma.patient.deleteMany({ where: { id: pat.id } });
    }
    // The document series counter is NOT rolled back — reissuing a number that
    // has already been on paper is the one thing a series must never do.
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
