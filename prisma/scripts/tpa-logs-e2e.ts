/**
 * TPA communication logs, walked end to end.
 *
 * The table has existed since the insurance module was built and had never
 * held a row, because nothing wrote one. The interesting question is not
 * whether the endpoint returns 201 — it is whether an entry appears for the
 * claims a hospital actually has.
 *
 * On the live data every policy has `tpa_id` null and there are no TPA
 * providers at all, so the sharpest assertion here is the one in "Policy with
 * no TPA": a lifecycle step on such a policy must still be logged, with a null
 * TPA, rather than silently skipped. If that regressed, the feature would look
 * built and record nothing — which is how it got into this state.
 *
 *   npm run db:check-tpa-logs      (needs the dev server up)
 *
 * Fixtures are tagged TPALOG-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `TPALOG-${Date.now()}`;
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

/**
 * Sign in, or mint the same token login would have issued.
 *
 * Login writes the refresh token to Redis, so it 500s when Redis is not up —
 * but nothing else in the request path needs it. Falling back to signing an
 * access token with the app's own secret keeps the walk going through the real
 * HTTP stack: `authenticate` and `requirePermission` still run for every call
 * below, on a token indistinguishable from a real one.
 */
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
    /* fall through to minting */
  }

  const user = await p.user.findFirst({
    where: { email },
    select: { id: true, tenantId: true, email: true, userRoles: { select: { role: { select: { name: true } } } } },
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

/** The entries written against something, oldest first, so order reads as the story. */
async function logsFor(where: Record<string, unknown>) {
  return p.tpaCommunicationLog.findMany({ where, orderBy: { createdAt: 'asc' } });
}

/** Upload every required dossier item through the same API used by the UI. */
async function completeDossier(claimId: string) {
  const checklist = await api('admin', 'GET', `/insurance/claims/${claimId}/checklist`);
  if (checklist.status !== 200) {
    return { ok: false, detail: `checklist HTTP ${checklist.status} ${checklist.message}` };
  }

  const required = (checklist.data?.items ?? []).filter((item: any) => item.isRequired);
  for (const item of required) {
    const category = item.requirementCode === 'FINAL_BILL'
      ? 'billing'
      : item.requirementCode === 'DISCHARGE_SUMMARY'
        ? 'clinical'
        : 'authorization';
    const uploaded = await api('admin', 'POST', `/insurance/claims/${claimId}/documents`, {
      code: item.requirementCode,
      name: item.label,
      category,
      fileUrl: `https://example.test/${TAG}/${item.requirementCode}.pdf`,
      mimeType: 'application/pdf',
    });
    if (uploaded.status !== 201) {
      return {
        ok: false,
        detail: `${item.label}: HTTP ${uploaded.status} ${uploaded.message}`,
      };
    }
  }

  const completed = await api('admin', 'GET', `/insurance/claims/${claimId}/checklist`);
  return {
    ok: completed.status === 200 && completed.data?.complete === true,
    detail: completed.data?.missing?.join(', ') || `HTTP ${completed.status}`,
  };
}

async function main() {
  console.log(`TPA communication logs, end to end   [${TAG}]\n`);

  section('Sign in');
  ck('admin signs in', await login('admin', 'admin@hospital.com'));
  if (!tokens.admin) {
    console.log('\n  Cannot continue without a session.');
    return;
  }

  section('Fixtures');
  const patient = await p.patient.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  ck('a patient exists to bill', !!patient, patient ? '' : 'no patients on this tenant');
  if (!patient) return;

  const tpa = await api('admin', 'POST', '/insurance/tpa', { name: `${TAG} TPA` });
  ck('TPA provider created', tpa.status === 201, `HTTP ${tpa.status} ${tpa.message}`);

  const insurer = await api('admin', 'POST', '/insurance/insurers', { name: `${TAG} Insurer` });
  ck('insurer created', insurer.status === 201, `HTTP ${insurer.status} ${insurer.message}`);
  if (!tpa.data?.id || !insurer.data?.id) return;

  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString();
  const policyBody = {
    patientId: patient.id,
    insurerId: insurer.data.id,
    policyNumber: `${TAG}-P1`,
    coverageAmount: 500000,
    validFrom: yesterday,
    validTo: nextYear,
  };
  const withTpa = await api('admin', 'POST', '/insurance/policies', {
    ...policyBody,
    tpaId: tpa.data.id,
  });
  ck('policy WITH a TPA created', withTpa.status === 201, `HTTP ${withTpa.status} ${withTpa.message}`);

  const noTpa = await api('admin', 'POST', '/insurance/policies', {
    ...policyBody,
    policyNumber: `${TAG}-P2`,
  });
  ck('policy WITHOUT a TPA created', noTpa.status === 201, `HTTP ${noTpa.status} ${noTpa.message}`);
  if (!withTpa.data?.id || !noTpa.data?.id) return;

  let billSeq = 0;
  async function makeBill(amount: number) {
    billSeq += 1;
    return p.bill.create({
      data: {
        tenantId: TENANT,
        patientId: patient!.id,
        billNumber: `${TAG}-B${billSeq}`,
        billDate: new Date(),
        subtotal: amount,
        totalAmount: amount,
        patientPayableAmount: amount,
        balanceDue: amount,
      },
      select: { id: true },
    });
  }

  async function makeClaim(policyId: string, amount: number) {
    const bill = await makeBill(amount);
    const claim = await api('admin', 'POST', '/insurance/claims', {
      policyId,
      patientId: patient!.id,
      billId: bill.id,
      claimAmount: amount,
    });
    if (!claim.data?.id) return claim;
    return { ...claim, dossier: await completeDossier(claim.data.id) };
  }

  // -- Claim lifecycle -------------------------------------------------------
  section('Claim lifecycle writes a log at every step');
  const a = await makeClaim(withTpa.data.id, 10000);
  ck('claim A created', a.status === 201, `HTTP ${a.status} ${a.message}`);
  ck('claim A dossier completed', a.dossier?.ok === true, a.dossier?.detail ?? 'not created');
  if (!a.data?.id) return;

  const aSubmit = await api('admin', 'PATCH', `/insurance/claims/${a.data.id}/submit`);
  ck('claim A submitted', aSubmit.status === 200, `HTTP ${aSubmit.status} ${aSubmit.message}`);

  const aApprove = await api('admin', 'PATCH', `/insurance/claims/${a.data.id}/approve`, {
    approvedAmount: 8000,
  });
  ck('claim A approved', aApprove.status === 200, `HTTP ${aApprove.status} ${aApprove.message}`);

  const aSettle = await api('admin', 'PATCH', `/insurance/claims/${a.data.id}/settle`, {
    paidAmount: 8000,
  });
  ck('claim A settled', aSettle.status === 200, `HTTP ${aSettle.status} ${aSettle.message}`);

  const aLogs = await logsFor({ claimId: a.data.id });
  ck('three entries recorded for claim A', aLogs.length === 3, `got ${aLogs.length}`);
  ck(
    'submit is outbound, approve and settle inbound',
    aLogs.map((l) => l.direction).join(',') === 'outbound,inbound,inbound',
    aLogs.map((l) => `${l.subject}=${l.direction}`).join(' | '),
  );
  ck(
    'every entry is marked as written by the system',
    aLogs.every((l) => l.isSystem === true),
    aLogs.map((l) => l.isSystem).join(','),
  );
  ck(
    'the TPA from the policy is carried onto each entry',
    aLogs.every((l) => l.tpaId === tpa.data.id),
    aLogs.map((l) => String(l.tpaId)).join(','),
  );
  ck(
    'the approval entry states the amounts',
    /8000\.00/.test(aLogs[1]?.content ?? '') && /10000\.00/.test(aLogs[1]?.content ?? ''),
    aLogs[1]?.content ?? '(no content)',
  );
  ck(
    'each entry names the acting user',
    aLogs.every((l) => !!l.communicatedBy),
    aLogs.map((l) => String(l.communicatedBy)).join(','),
  );

  // -- Rejection and resubmission -------------------------------------------
  section('Rejection and resubmission');
  const b = await makeClaim(withTpa.data.id, 5000);
  await api('admin', 'PATCH', `/insurance/claims/${b.data.id}/submit`);
  const bReject = await api('admin', 'PATCH', `/insurance/claims/${b.data.id}/reject`, {
    rejectionReason: 'Policy excludes this procedure',
  });
  ck('claim B rejected', bReject.status === 200, `HTTP ${bReject.status} ${bReject.message}`);

  const bLogs = await logsFor({ claimId: b.data.id });
  ck(
    'the rejection entry carries the reason',
    (bLogs.at(-1)?.content ?? '').includes('Policy excludes this procedure'),
    bLogs.at(-1)?.content ?? '(no content)',
  );

  const bResub = await api('admin', 'POST', `/insurance/claims/${b.data.id}/resubmit`, {
    notes: 'Sending the operative note as well',
  });
  ck(
    'claim B resubmitted',
    bResub.status === 201 || bResub.status === 200,
    `HTTP ${bResub.status} ${bResub.message}`,
  );

  const resubLogs = await logsFor({ claimId: bResub.data?.id });
  ck(
    'the resubmission is logged against the NEW claim',
    resubLogs.length === 1 && /resubmitted as/i.test(resubLogs[0]?.subject ?? ''),
    `${resubLogs.length} entr(ies): ${resubLogs.map((l) => l.subject).join(' | ')}`,
  );
  ck(
    'and it names the claim it replaces',
    (resubLogs[0]?.content ?? '').includes(b.data.claimNumber ?? ' '),
    resubLogs[0]?.content ?? '(no content)',
  );
  ck(
    'the original claim gained no extra entry',
    (await logsFor({ claimId: b.data.id })).length === bLogs.length,
    'a resubmission should continue the conversation on the new claim only',
  );

  // -- Partial approval and cancellation ------------------------------------
  section('Partial approval and cancellation');
  const c = await makeClaim(withTpa.data.id, 7000);
  await api('admin', 'PATCH', `/insurance/claims/${c.data.id}/submit`);
  const cPartial = await api('admin', 'PATCH', `/insurance/claims/${c.data.id}/partial-approve`, {
    approvedAmount: 4000,
    rejectionReason: 'Room rent capped',
  });
  ck(
    'claim C partially approved',
    cPartial.status === 200,
    `HTTP ${cPartial.status} ${cPartial.message}`,
  );
  const cLogs = await logsFor({ claimId: c.data.id });
  ck(
    'the partial approval records the reason given',
    (cLogs.at(-1)?.content ?? '').includes('Room rent capped'),
    cLogs.at(-1)?.content ?? '(no content)',
  );

  const d = await makeClaim(withTpa.data.id, 3000);
  const dCancel = await api('admin', 'PATCH', `/insurance/claims/${d.data.id}/cancel`, {
    reason: 'Patient chose to self-pay',
  });
  ck('claim D cancelled', dCancel.status === 200, `HTTP ${dCancel.status} ${dCancel.message}`);
  const dLogs = await logsFor({ claimId: d.data.id });
  ck(
    'the cancellation is logged outbound with its reason',
    dLogs.at(-1)?.direction === 'outbound' &&
      (dLogs.at(-1)?.content ?? '').includes('Patient chose to self-pay'),
    `${dLogs.at(-1)?.direction} / ${dLogs.at(-1)?.content}`,
  );

  // -- The case every policy on the live data is in -------------------------
  section('Policy with no TPA still produces a log');
  const e = await makeClaim(noTpa.data.id, 2500);
  ck('claim E created on the TPA-less policy', e.status === 201, `HTTP ${e.status} ${e.message}`);
  const eSubmit = await api('admin', 'PATCH', `/insurance/claims/${e.data.id}/submit`);
  ck('claim E submitted', eSubmit.status === 200, `HTTP ${eSubmit.status} ${eSubmit.message}`);
  const eLogs = await logsFor({ claimId: e.data.id });
  ck(
    'an entry is written even though the policy names no TPA',
    eLogs.length === 1,
    `got ${eLogs.length} — this is the case every policy on the live data is in`,
  );
  ck('and its TPA is null rather than invented', eLogs[0]?.tpaId === null, String(eLogs[0]?.tpaId));

  // -- Pre-authorization ----------------------------------------------------
  section('Pre-authorization lifecycle');
  const pre = await api('admin', 'POST', '/insurance/pre-auth', {
    policyId: withTpa.data.id,
    patientId: patient.id,
    procedureDescription: 'Elective laparoscopic cholecystectomy',
    estimatedCost: 65000,
  });
  ck('pre-auth requested', pre.status === 201, `HTTP ${pre.status} ${pre.message}`);
  if (pre.data?.id) {
    const hold = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/hold`, {
      reason: 'Insurer asked for the ultrasound report',
    });
    ck('pre-auth put on hold', hold.status === 200, `HTTP ${hold.status} ${hold.message}`);

    const release = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/release-hold`);
    ck('hold released', release.status === 200, `HTTP ${release.status} ${release.message}`);

    const approve = await api('admin', 'PATCH', `/insurance/pre-auth/${pre.data.id}/approve`, {
      approvalNumber: `${TAG}-PA-1`,
      approvedAmount: 60000,
    });
    ck('pre-auth approved', approve.status === 200, `HTTP ${approve.status} ${approve.message}`);

    const preLogs = await logsFor({ preAuthId: pre.data.id });
    ck('four entries recorded for the pre-auth', preLogs.length === 4, `got ${preLogs.length}`);
    ck(
      'request outbound, hold inbound, release outbound, approval inbound',
      preLogs.map((l) => l.direction).join(',') === 'outbound,inbound,outbound,inbound',
      preLogs.map((l) => `${l.subject}=${l.direction}`).join(' | '),
    );
    ck(
      'the hold entry carries the query the insurer raised',
      (preLogs[1]?.content ?? '').includes('ultrasound report'),
      preLogs[1]?.content ?? '(no content)',
    );
    ck(
      'the procedure is in the content, not the subject',
      (preLogs[0]?.content ?? '').includes('cholecystectomy') &&
        !(preLogs[0]?.subject ?? '').includes('cholecystectomy'),
      `subject="${preLogs[0]?.subject}"`,
    );
  }

  // -- Logging by hand ------------------------------------------------------
  section('Logging a call by hand');
  const orphan = await api('admin', 'POST', '/insurance/tpa-logs', {
    communicationType: 'phone',
    direction: 'outbound',
    subject: 'Attached to nothing',
  });
  ck('a log attached to nothing is refused', orphan.status === 400, `HTTP ${orphan.status}`);

  const strayClaim = await api('admin', 'POST', '/insurance/tpa-logs', {
    claimId: '00000000-0000-4000-8000-000000000000',
    communicationType: 'phone',
    direction: 'outbound',
    subject: 'A claim belonging to another hospital',
  });
  ck('a claim outside this hospital is refused', strayClaim.status === 404, `HTTP ${strayClaim.status}`);

  const manual = await api('admin', 'POST', '/insurance/tpa-logs', {
    claimId: a.data.id,
    communicationType: 'phone',
    direction: 'inbound',
    subject: 'Called about the settlement',
    content: 'Spoke to the desk; the transfer goes out on Friday.',
  });
  ck('a call is logged by hand', manual.status === 201, `HTTP ${manual.status} ${manual.message}`);
  ck('it is not marked as system-written', manual.data?.isSystem === false, String(manual.data?.isSystem));
  ck(
    'the TPA is filled in from the claim without being asked for',
    manual.data?.tpaId === tpa.data.id,
    String(manual.data?.tpaId),
  );

  // -- Reading them back ----------------------------------------------------
  section('Reading the log back');
  const byClaim = await api('admin', 'GET', `/insurance/tpa-logs?claimId=${a.data.id}`);
  ck(
    'filtering by claim works',
    byClaim.status === 200 && byClaim.data?.length === 4,
    `HTTP ${byClaim.status}, ${byClaim.data?.length} row(s)`,
  );
  ck(
    'newest first',
    byClaim.data?.[0]?.subject === 'Called about the settlement',
    byClaim.data?.[0]?.subject ?? '(none)',
  );

  const inbound = await api('admin', 'GET', `/insurance/tpa-logs?claimId=${a.data.id}&direction=inbound`);
  ck('filtering by direction works', inbound.data?.length === 3, `${inbound.data?.length} row(s)`);

  const handWritten = await api('admin', 'GET', `/insurance/tpa-logs?claimId=${a.data.id}&isSystem=false`);
  ck(
    'separating hand-written entries works',
    handWritten.data?.length === 1,
    `${handWritten.data?.length} row(s) — if this is 4, validate() dropped the isSystem filter`,
  );

  const byPreAuth = await api('admin', 'GET', `/insurance/tpa-logs?preAuthId=${pre.data?.id}`);
  ck('filtering by pre-authorization works', byPreAuth.data?.length === 4, `${byPreAuth.data?.length} row(s)`);

  const searched = await api(
    'admin',
    'GET',
    `/insurance/tpa-logs?search=${encodeURIComponent('goes out on Friday')}`,
  );
  ck('searching the content works', (searched.data?.length ?? 0) >= 1, `${searched.data?.length} row(s)`);

  const listed = byClaim.data?.[0];
  ck(
    'the list names the claim, the TPA and the person',
    !!listed?.claim?.claimNumber && !!listed?.tpa?.name && !!listed?.communicator?.firstName,
    JSON.stringify({
      claim: listed?.claim?.claimNumber,
      tpa: listed?.tpa?.name,
      by: listed?.communicator?.firstName,
    }),
  );

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const claimIds = (
    await p.insuranceClaim.findMany({
      where: { bill: { billNumber: { startsWith: TAG } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const policyIds = [withTpa.data.id, noTpa.data.id];
  await p.tpaCommunicationLog.deleteMany({
    where: { OR: [{ claimId: { in: claimIds } }, { preAuth: { policyId: { in: policyIds } } }] },
  });
  await p.preAuthorizationRequest.deleteMany({ where: { policyId: { in: policyIds } } });
  await p.insuranceClaim.updateMany({
    where: { id: { in: claimIds } },
    data: { previousClaimId: null },
  });
  await p.insuranceClaim.deleteMany({ where: { id: { in: claimIds } } });
  await p.bill.deleteMany({ where: { billNumber: { startsWith: TAG } } });
  await p.insurancePolicy.deleteMany({ where: { policyNumber: { startsWith: TAG } } });
  await p.tpaProvider.deleteMany({ where: { name: { startsWith: TAG } } });
  await p.insurer.deleteMany({ where: { name: { startsWith: TAG } } });
  ck(
    'fixtures cleaned up',
    (await p.tpaCommunicationLog.count({ where: { claimId: { in: claimIds } } })) === 0 &&
      (await p.tpaProvider.count({ where: { name: { startsWith: TAG } } })) === 0,
  );

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
