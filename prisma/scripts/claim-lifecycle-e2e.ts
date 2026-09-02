/**
 * Claim arithmetic and the paths that had never run — walked end to end.
 *
 * `pre_authorization_requests` had 0 rows and `calc-responsibility`,
 * partial approval and the resubmission chain had never been exercised. What
 * matters in all of them is arithmetic: a deductible comes off first, co-pay is
 * a share of what is left, and the coverage limit caps the insurer — get the
 * order wrong and the patient is billed the difference.
 *
 * Worked example used throughout: a 10,000 bill on a policy with a 1,000
 * deductible and 20% co-pay.
 *     deductible 1,000 -> 9,000 left
 *     co-pay     1,800 (20% of 9,000)
 *     insurer    7,200
 *     patient    2,800  (= 1,000 + 1,800)
 *
 *   npm run db:check-claim-lifecycle      (needs the dev server up)
 *
 * Fixtures are tagged CLM-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const OTHER_TENANT = 'db6df4e2-d729-41a1-8153-243fb9d31ab8';
const TAG = `CLM-${Date.now()}`;
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
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Admin@123' }),
    });
    const j: any = await res.json();
    const token = j?.data?.accessToken ?? j?.data?.tokens?.accessToken ?? '';
    if (token) {
      tokens[key] = token;
      return true;
    }
  } catch {
    /* fall through */
  }
  const user = await p.user.findFirst({
    where: { email },
    select: {
      id: true,
      tenantId: true,
      email: true,
      userRoles: { select: { role: { select: { name: true } } } },
    },
  });
  if (!user) return false;
  tokens[key] = jwt.sign(
    {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.userRoles.map((r) => r.role.name),
    },
    process.env.JWT_ACCESS_SECRET as string,
    { expiresIn: '30m' },
  );
  console.log('        (login endpoint unavailable — signed a token directly; Redis is down)');
  return true;
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

const money = (v: unknown) => Number(v ?? 0);

/** The IST calendar day the claim series is keyed on. */
function istDateStr() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  return ist.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  console.log(`Claim arithmetic and lifecycle, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) return;

  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient);
  if (!patient) return;

  const insurer = await api('admin', 'POST', '/insurance/insurers', { name: `${TAG} Insurer` });
  ck('insurer created', insurer.status === 201, `HTTP ${insurer.status} ${insurer.message}`);
  if (!insurer.data?.id) return;

  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString();

  /** A policy with the given co-pay, deductible and coverage limit. */
  let polSeq = 0;
  async function makePolicy(opts: { coPay: number; deductible: number; coverage: number }) {
    polSeq += 1;
    const res = await api('admin', 'POST', '/insurance/policies', {
      patientId: patient!.id,
      insurerId: insurer.data.id,
      policyNumber: `${TAG}-P${polSeq}`,
      coverageAmount: opts.coverage,
      coPayPercent: opts.coPay,
      deductibleAmount: opts.deductible,
      validFrom: yesterday,
      validTo: nextYear,
    });
    return res.data?.id as string;
  }

  let billSeq = 0;
  async function makeBill(amount: number) {
    billSeq += 1;
    const bill = await p.bill.create({
      data: {
        tenantId: TENANT,
        patientId: patient!.id,
        billNumber: `${TAG}-B${billSeq}`,
        billDate: new Date(),
        status: 'pending',
        subtotal: amount,
        totalAmount: amount,
        patientPayableAmount: amount,
        balanceDue: amount,
      },
      select: { id: true },
    });
    await p.billItem.create({
      data: {
        billId: bill.id,
        description: `${TAG} treatment`,
        category: 'procedure',
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
      },
    });
    return bill.id;
  }

  try {
    // -- Co-pay and deductible -------------------------------------------------
    section('What the insurer pays and what the patient pays');
    const policy = await makePolicy({ coPay: 20, deductible: 1000, coverage: 500000 });
    const bill = await makeBill(10000);
    const calc = await api(
      'admin',
      'GET',
      `/insurance/calc-responsibility?policyId=${policy}&billId=${bill}`,
    );
    ck('the split can be worked out before claiming', calc.status === 200, `HTTP ${calc.status} ${calc.message}`);
    const split = calc.data?.split;
    ck('the deductible comes off first', split?.deductibleAmount === 1000, String(split?.deductibleAmount));
    ck(
      'co-pay is a share of what is left, not of the whole bill',
      split?.copayAmount === 1800,
      `${split?.copayAmount} — 20% of 9,000 is 1,800; 20% of 10,000 would be 2,000`,
    );
    ck('the insurer covers the rest', split?.coveredAmount === 7200, String(split?.coveredAmount));
    ck(
      'and the patient owes deductible plus co-pay',
      split?.patientResponsibility === 2800,
      `${split?.patientResponsibility} — 1,000 + 1,800`,
    );
    ck(
      'the two halves add back to the bill',
      money(split?.coveredAmount) + money(split?.patientResponsibility) === 10000,
      `${split?.coveredAmount} + ${split?.patientResponsibility}`,
    );

    // A coverage limit below the computed cover must bite.
    const cappedPolicy = await makePolicy({ coPay: 0, deductible: 0, coverage: 4000 });
    const bigBill = await makeBill(10000);
    const capped = await api(
      'admin',
      'GET',
      `/insurance/calc-responsibility?policyId=${cappedPolicy}&billId=${bigBill}`,
    );
    ck(
      'the coverage limit caps the insurer',
      capped.data?.split?.coveredAmount === 4000,
      String(capped.data?.split?.coveredAmount),
    );
    ck(
      'and the patient carries everything above it',
      capped.data?.split?.patientResponsibility === 6000,
      String(capped.data?.split?.patientResponsibility),
    );

    // -- Partial approval -----------------------------------------------------
    section('An insurer approving less than was claimed');
    const partialBill = await makeBill(10000);
    const partialClaim = await api('admin', 'POST', '/insurance/claims', {
      policyId: policy,
      patientId: patient.id,
      billId: partialBill,
      claimAmount: 10000,
    });
    ck('the claim is raised', partialClaim.status === 201, `HTTP ${partialClaim.status} ${partialClaim.message}`);
    ck(
      'the claim records the co-pay and deductible from the policy',
      money(partialClaim.data?.copayAmount) === 1800 && money(partialClaim.data?.deductibleAmount) === 1000,
      `copay ${partialClaim.data?.copayAmount}, deductible ${partialClaim.data?.deductibleAmount}`,
    );

    await api('admin', 'PATCH', `/insurance/claims/${partialClaim.data.id}/submit`);
    const overApprove = await api(
      'admin',
      'PATCH',
      `/insurance/claims/${partialClaim.data.id}/partial-approve`,
      { approvedAmount: 12000, rejectionReason: 'More than claimed' },
    );
    ck(
      'approving more than was claimed is refused',
      overApprove.status === 400,
      `HTTP ${overApprove.status} ${overApprove.message}`,
    );

    const partial = await api(
      'admin',
      'PATCH',
      `/insurance/claims/${partialClaim.data.id}/partial-approve`,
      { approvedAmount: 6000, rejectionReason: 'Room rent capped' },
    );
    ck('a partial approval is accepted', partial.status === 200, `HTTP ${partial.status} ${partial.message}`);
    ck('the claim reads as partially approved', partial.data?.status === 'partially_approved', String(partial.data?.status));
    ck(
      'and the patient picks up the shortfall',
      money(partial.data?.patientShare) === 4000,
      `${partial.data?.patientShare} — 10,000 claimed less 6,000 approved`,
    );
    const partialBillState = await p.bill.findUnique({ where: { id: partialBill } });
    ck(
      'the bill is split the same way',
      money(partialBillState?.insuranceCoveredAmount) === 6000 &&
        money(partialBillState?.patientPayableAmount) === 4000,
      `insurer ${money(partialBillState?.insuranceCoveredAmount)}, patient ${money(partialBillState?.patientPayableAmount)}`,
    );

    // -- Rejection then resubmission ------------------------------------------
    section('Rejected, then sent again');
    const resubBill = await makeBill(5000);
    const original = await api('admin', 'POST', '/insurance/claims', {
      policyId: policy,
      patientId: patient.id,
      billId: resubBill,
      claimAmount: 5000,
    });
    await api('admin', 'PATCH', `/insurance/claims/${original.data.id}/submit`);
    const rejected = await api('admin', 'PATCH', `/insurance/claims/${original.data.id}/reject`, {
      rejectionReason: 'Discharge summary missing',
    });
    ck('the claim is rejected', rejected.status === 200, `HTTP ${rejected.status}`);
    const rejectedBillState = await p.bill.findUnique({ where: { id: resubBill } });
    ck(
      'and the whole bill falls to the patient',
      money(rejectedBillState?.patientPayableAmount) === 5000 &&
        money(rejectedBillState?.insuranceCoveredAmount) === 0,
      `patient ${money(rejectedBillState?.patientPayableAmount)}, insurer ${money(rejectedBillState?.insuranceCoveredAmount)}`,
    );

    const resub = await api('admin', 'POST', `/insurance/claims/${original.data.id}/resubmit`, {
      notes: 'Discharge summary attached',
    });
    ck('it can be sent again', resub.status === 201, `HTTP ${resub.status} ${resub.message}`);
    ck('as a NEW claim with its own number', resub.data?.claimNumber !== original.data?.claimNumber,
      `${original.data?.claimNumber} -> ${resub.data?.claimNumber}`);
    ck(
      'that points back at the one it replaces',
      resub.data?.previousClaimId === original.data?.id,
      String(resub.data?.previousClaimId),
    );
    ck('and counts the attempt', resub.data?.resubmissionCount === 1, String(resub.data?.resubmissionCount));
    const originalNow = await p.insuranceClaim.findUnique({ where: { id: original.data.id } });
    ck(
      'the original is marked resubmitted, not left rejected',
      originalNow?.status === 'resubmitted',
      String(originalNow?.status),
    );

    const resubTwice = await api('admin', 'POST', `/insurance/claims/${original.data.id}/resubmit`, {
      notes: 'Again',
    });
    ck(
      'the same claim cannot be resubmitted twice',
      resubTwice.status === 400,
      `HTTP ${resubTwice.status} ${resubTwice.message}`,
    );

    // A settled claim is the end of the road.
    const approvedAgain = await api('admin', 'PATCH', `/insurance/claims/${resub.data.id}/approve`, {
      approvedAmount: 5000,
    });
    ck('the resubmitted claim can be approved', approvedAgain.status === 200, `HTTP ${approvedAgain.status}`);
    const settle = await api('admin', 'PATCH', `/insurance/claims/${resub.data.id}/settle`, {
      paidAmount: 5000,
    });
    ck('and settled', settle.status === 200, `HTTP ${settle.status} ${settle.message}`);
    ck('leaving nothing outstanding', money(settle.data?.outstandingAmount) === 0, String(settle.data?.outstandingAmount));
    const overSettle = await api('admin', 'PATCH', `/insurance/claims/${resub.data.id}/settle`, {
      paidAmount: 100,
    });
    ck(
      'paying more than was approved is refused',
      overSettle.status === 400,
      `HTTP ${overSettle.status} ${overSettle.message}`,
    );

    // -- Pre-authorization ----------------------------------------------------
    section('Pre-authorization, including the hold');
    const pre = await api('admin', 'POST', '/insurance/pre-auth', {
      policyId: policy,
      patientId: patient.id,
      procedureDescription: 'Total knee replacement',
      estimatedCost: 250000,
    });
    ck('a request can be raised', pre.status === 201, `HTTP ${pre.status} ${pre.message}`);
    ck('it starts pending', pre.data?.status === 'pending', String(pre.data?.status));

    const release0 = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/release-hold`);
    ck(
      'a request that is not on hold cannot be released',
      release0.status === 400,
      `HTTP ${release0.status} ${release0.message}`,
    );

    const hold = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/hold`, {
      reason: 'Insurer wants the X-ray report',
    });
    ck('it can be put on hold', hold.status === 200, `HTTP ${hold.status}`);
    ck('with the query recorded', hold.data?.holdReason === 'Insurer wants the X-ray report', String(hold.data?.holdReason));

    const release = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/release-hold`);
    ck('and released again', release.status === 200, `HTTP ${release.status}`);
    ck('back to pending', release.data?.status === 'pending', String(release.data?.status));
    ck('with the hold reason cleared', !release.data?.holdReason, String(release.data?.holdReason));

    const approvePre = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/approve`, {
      approvedAmount: 200000,
    });
    ck('it can be approved', approvePre.status === 200, `HTTP ${approvePre.status}`);
    ck('for the amount the insurer allowed', money(approvePre.data?.approvedAmount) === 200000, String(approvePre.data?.approvedAmount));
    ck('with an approval number issued', !!approvePre.data?.approvalNumber, String(approvePre.data?.approvalNumber));

    const approveTwice = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/approve`, {
      approvedAmount: 100,
    });
    ck('and cannot be approved twice', approveTwice.status === 400, `HTTP ${approveTwice.status}`);

    const cancelApproved = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/cancel`);
    ck(
      'an approved request cannot be cancelled',
      cancelApproved.status === 400,
      `HTTP ${cancelApproved.status} ${cancelApproved.message}`,
    );

    // -- Another hospital holding the next claim number -----------------------
    // Same shape as the receipt-number bug: claimNumber is @unique across the
    // whole database, but the day's highest is read within one tenant.
    section('Another hospital holding the next claim number');
    const today = istDateStr();
    const mine = await p.insuranceClaim.findFirst({
      where: { tenantId: TENANT, claimNumber: { startsWith: `CLM-${today}-` } },
      orderBy: { claimNumber: 'desc' },
      select: { claimNumber: true },
    });
    const nextSeq = mine?.claimNumber ? parseInt(mine.claimNumber.split('-').pop()!, 10) + 1 : 1;
    const contested = `CLM-${today}-${String(nextSeq).padStart(4, '0')}`;
    console.log(`        this hospital's next claim number would be ${contested}`);

    const otherPatient = await p.patient.findFirst({
      where: { tenantId: OTHER_TENANT },
      select: { id: true },
    });
    const otherInsurer = await p.insurer.create({
      data: { tenantId: OTHER_TENANT, name: `${TAG} Other Insurer` },
      select: { id: true },
    });
    const otherPolicy = await p.insurancePolicy.create({
      data: {
        tenantId: OTHER_TENANT,
        patientId: otherPatient?.id ?? patient.id,
        insurerId: otherInsurer.id,
        policyNumber: `${TAG}-OTHER`,
        validFrom: new Date(Date.now() - 86400000),
        validTo: new Date(Date.now() + 86400000),
      },
      select: { id: true },
    });
    const otherBill = await p.bill.create({
      data: {
        tenantId: OTHER_TENANT,
        patientId: otherPatient?.id ?? patient.id,
        billNumber: `${TAG}-OTHERB`,
        billDate: new Date(),
        subtotal: 100,
        totalAmount: 100,
        balanceDue: 100,
      },
      select: { id: true },
    });
    await p.insuranceClaim.create({
      data: {
        tenantId: OTHER_TENANT,
        patientId: otherPatient?.id ?? patient.id,
        policyId: otherPolicy.id,
        billId: otherBill.id,
        claimNumber: contested,
        claimAmount: 100,
        submissionDate: new Date(),
      },
    });
    ck('a second hospital now holds that number', true, contested);

    const contestedBill = await makeBill(1000);
    const contestedClaim = await api('admin', 'POST', '/insurance/claims', {
      policyId: policy,
      patientId: patient.id,
      billId: contestedBill,
      claimAmount: 1000,
    });
    ck(
      'this hospital can still raise a claim',
      contestedClaim.status === 201,
      `HTTP ${contestedClaim.status} ${contestedClaim.message} — claim_number is unique across all ` +
        `hospitals, so reading only this tenant's maximum hands out one already taken`,
    );
    ck(
      'with a number that avoids the one taken',
      !!contestedClaim.data?.claimNumber && contestedClaim.data.claimNumber !== contested,
      String(contestedClaim.data?.claimNumber),
    );
  } finally {
    section('Cleanup');
    const billIds = (
      await p.bill.findMany({ where: { billNumber: { startsWith: TAG } }, select: { id: true } })
    ).map((b) => b.id);
    const claimIds = (
      await p.insuranceClaim.findMany({ where: { billId: { in: billIds } }, select: { id: true } })
    ).map((c) => c.id);
    await p.tpaCommunicationLog.deleteMany({
      where: { OR: [{ claimId: { in: claimIds } }, { preAuth: { policy: { policyNumber: { startsWith: TAG } } } }] },
    });
    await p.preAuthorizationRequest.deleteMany({
      where: { policy: { policyNumber: { startsWith: TAG } } },
    });
    await p.insuranceClaim.updateMany({ where: { id: { in: claimIds } }, data: { previousClaimId: null } });
    await p.insuranceClaim.deleteMany({ where: { id: { in: claimIds } } });
    // A voided or cancelled bill now carries a credit note that references it.
    await p.creditNote.deleteMany({ where: { billId: { in: billIds } } }).catch(() => {});
    await p.billItem.deleteMany({ where: { billId: { in: billIds } } });
    await p.bill.deleteMany({ where: { id: { in: billIds } } });
    await p.insurancePolicy.deleteMany({ where: { policyNumber: { startsWith: TAG } } });
    await p.insurer.deleteMany({ where: { name: { startsWith: TAG } } });
    ck(
      'fixtures cleaned up',
      (await p.bill.count({ where: { billNumber: { startsWith: TAG } } })) === 0 &&
        (await p.insurer.count({ where: { name: { startsWith: TAG } } })) === 0,
    );
  }

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
