/**
 * Walk an admission deposit and assert it leaves a documentary trail.
 *
 * The gap: money was written to Admission.depositAmount as a bare number, with
 * no Payment, no Receipt, no date, no tender and nobody named. This asserts the
 * receipt now exists AND — just as important — that adding it moved none of the
 * deposit arithmetic that already worked.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';
import * as clinical from '../../src/modules/clinical/clinical.service';

const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `DEPRCPT-${Date.now()}`;

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

async function main() {
  const patient = await prisma.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  const doctor = await prisma.doctorProfile.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  // admitted_by and processed_by are real FKs, so the walk acts as a real user.
  const actor = await prisma.user.findFirst({ where: { email: 'admin@hospital.com' }, select: { id: true } });
  if (!patient || !doctor || !actor) throw new Error('need a patient, a doctor and a user');
  const ACTOR = actor.id;

  const visit = await prisma.visit.create({
    data: {
      tenantId: TENANT, patientId: patient.id, doctorId: doctor.id,
      visitDate: new Date(), visitType: 'ip', status: 'completed',
      chiefComplaint: TAG,
    },
  });

  // ── Admit with a deposit ──
  const adm: any = await clinical.createAdmission(TENANT, ACTOR, {
    visitId: visit.id,
    patientId: patient.id,
    doctorId: doctor.id,
    admissionDate: new Date().toISOString(),
    admissionReason: TAG,
    depositAmount: 20000,
    depositPaymentMethod: 'upi',
  } as any);
  ck('admitted with a deposit', !!adm?.id, `${adm?.id}`);
  ck('the pool is still on the admission', Number(adm.depositAmount) === 20000, `${adm.depositAmount}`);

  const receiptPay: any = await prisma.payment.findFirst({
    where: { tenantId: TENANT, transactionId: `IPDEPRCPT:${adm.id}` },
    include: { receipt: true },
  });
  ck('a payment records the money coming in', !!receiptPay, 'none written');
  ck('for the amount taken', near(Number(receiptPay?.amount), 20000), `${receiptPay?.amount}`);
  ck('with the tender the desk took', receiptPay?.paymentMethod === 'upi', `${receiptPay?.paymentMethod}`);
  ck('naming who took it', receiptPay?.processedBy === ACTOR, `${receiptPay?.processedBy}`);
  ck('and there is a receipt to hand the patient', !!receiptPay?.receipt?.receiptNumber,
     `${receiptPay?.receipt?.receiptNumber}`);
  // A deposit is money against treatment, and treatment is exempt.
  ck('the GST position is recorded as exempt', receiptPay?.gstTreatment === 'exempt',
     `${receiptPay?.gstTreatment}`);
  ck('the whole amount is exempt turnover', near(Number(receiptPay?.taxableValue), 20000),
     `${receiptPay?.taxableValue}`);
  ck('and it carries a receipt voucher number', !!receiptPay?.voucherNumber, `${receiptPay?.voucherNumber}`);

  // ── The arithmetic that already worked must not have moved ──
  const billing = await import('../../src/modules/billing/billing.service');
  const before: any = await billing.getPatientAdvanceBalance(TENANT, patient.id);
  ck('a stay deposit is NOT counted as a desk advance',
     Number(before.totalAdvanceCollected) === 0,
     `collected ${before.totalAdvanceCollected}`);

  // The assertion that matters most: adding a receipt row must not have moved
  // any figure the deposit arithmetic already produced.
  const outstanding: any = await billing.getAdmissionOutstanding(TENANT, adm.id).catch((e) => {
    console.log('    (outstanding threw: ' + e.message + ')');
    return null;
  });
  ck('the outstanding view still reads the deposit on file',
     Number(outstanding?.depositOnFile) === 20000, `depositOnFile ${outstanding?.depositOnFile}`);
  // The receipt row must NEVER be mistaken for deposit money already spent —
  // that prefix collision would read every deposit as fully applied the moment
  // it was taken, and availableToApply would sit at zero.
  ck('and none of it reads as already applied',
     Number(outstanding?.depositApplied ?? 0) === 0, `depositApplied ${outstanding?.depositApplied}`);
  // availableToApply is derived as onFile minus applied, and both are asserted
  // exactly above, so a separate check of it would only restate them.

  // ── Topping it up records only the increase ──
  await clinical.updateAdmission(TENANT, adm.id, { depositAmount: 27000 } as any, ACTOR);
  const tops = await prisma.payment.findMany({
    where: { tenantId: TENANT, transactionId: `IPDEPRCPT:${adm.id}` },
    orderBy: { createdAt: 'asc' },
  });
  ck('a top-up writes a second receipt', tops.length === 2, `${tops.length} receipts`);
  ck('for the INCREASE only, not the new total',
     near(Number(tops[1]?.amount), 7000), `${tops[1]?.amount}`);

  // Lowering it is a correction, not money coming in.
  await clinical.updateAdmission(TENANT, adm.id, { depositAmount: 25000 } as any, ACTOR);
  const afterCut = await prisma.payment.count({
    where: { tenantId: TENANT, transactionId: `IPDEPRCPT:${adm.id}` },
  });
  ck('lowering the deposit invents no receipt', afterCut === 2, `${afterCut} receipts`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .finally(async () => {
    const adms = await prisma.admission.findMany({ where: { admissionReason: TAG }, select: { id: true } });
    const pays = await prisma.payment.findMany({
      where: { transactionId: { in: adms.map((a) => `IPDEPRCPT:${a.id}`) } },
      select: { id: true },
    });
    await prisma.receipt.deleteMany({ where: { paymentId: { in: pays.map((p) => p.id) } } });
    await prisma.payment.deleteMany({ where: { id: { in: pays.map((p) => p.id) } } });
    await prisma.admission.deleteMany({ where: { id: { in: adms.map((a) => a.id) } } });
    await prisma.visit.deleteMany({ where: { chiefComplaint: TAG } });
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
