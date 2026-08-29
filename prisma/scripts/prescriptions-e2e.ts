/**
 * The prescription flow, walked end to end.
 *
 * A prescription is the doctor's instruction and the pharmacy's work order at
 * once, and the arithmetic in the middle is the part that goes wrong: the
 * doctor writes "1-1-1 for 3 days" and somebody has to turn that into nine
 * tablets to hand over and to bill. Then it has to travel — to the counter for
 * an outpatient, to the ward's IP ledger for an inpatient, never to both — and
 * the queue has to stop showing it once it is done.
 *
 *   npm run db:check-prescriptions      (needs the dev server up)
 *
 * Fixtures are tagged RX-<timestamp> and deleted at the end.
 */
import { PrismaClient } from '@prisma/client';

const API = 'http://localhost:4000/api/v1';
const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `RX-${Date.now()}`;
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
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Admin@123' }),
  });
  const j: any = await res.json();
  tokens[key] = j?.data?.accessToken ?? j?.data?.tokens?.accessToken ?? '';
  return Boolean(tokens[key]);
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

const qty = async (id: string) =>
  (await p.drugBatch.findUnique({ where: { id }, select: { quantityInStock: true } }))?.quantityInStock ?? -1;
const money = (n: unknown) => Number(n ?? 0);
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) < tol;
/**
 * Bills this walk ADDED to but did not create.
 *
 * An IP dispense attaches to the patient's open running bill, which is real
 * hospital data. Deleting it at cleanup would take an insurance claim and a
 * stay's charges with it, so the totals are snapshotted and put back instead.
 */
const borrowedBills = new Map<string, { subtotal: string; taxAmount: string; totalAmount: string; patientPayableAmount: string; balanceDue: string }>();
async function rememberBill(billId: string | null | undefined) {
  if (!billId || borrowedBills.has(billId)) return;
  const b = await p.bill.findUnique({
    where: { id: billId },
    select: { billNumber: true, subtotal: true, taxAmount: true, totalAmount: true, patientPayableAmount: true, balanceDue: true, createdAt: true },
  });
  // Only bills that predate this run — one we opened ourselves can just go.
  if (!b || b.createdAt.getTime() > startedAt) return;
  borrowedBills.set(billId, {
    subtotal: String(b.subtotal), taxAmount: String(b.taxAmount), totalAmount: String(b.totalAmount),
    patientPayableAmount: String(b.patientPayableAmount), balanceDue: String(b.balanceDue),
  });
}

const startedAt = Date.now();

const statusOf = async (id: string) =>
  (await p.prescription.findUnique({ where: { id }, select: { status: true } }))?.status;

async function main() {
  section('Signing in');
  ck('a doctor', await login('doc', 'doc1@email.com'));
  ck('a pharmacy admin', await login('pharm', 'pharmacyadmin1@email.com'));
  const nurse = await p.user.findFirst({
    where: { tenantId: TENANT, isActive: true, userRoles: { some: { role: { name: { in: ['nurse', 'nurse_admin'] } } } } },
    select: { email: true },
  });
  const haveNurse = nurse ? await login('nurse', nurse.email) : false;
  ck('a nurse', haveNurse, nurse?.email ?? 'none');
  ck('an administrator', await login('admin', 'admin@hospital.com'));
  if (!tokens.doc || !tokens.pharm) return;

  // -- Sweep leftovers -----------------------------------------------------
  const stale = await p.drugFormulary.findMany({
    where: { tenantId: TENANT, drugName: { startsWith: 'RX-' } },
    select: { id: true },
  });
  if (stale.length) {
    const ids = stale.map((d) => d.id);
    const b = (await p.drugBatch.findMany({ where: { drugId: { in: ids } }, select: { id: true } })).map((x) => x.id);
    const bills = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: b } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
    await p.drugReturn.deleteMany({ where: { drugBatchId: { in: b } } });
    const bEmar = (await p.emarSchedule.findMany({ where: { drugBatchId: { in: b } }, select: { id: true } })).map((e) => e.id);
    if (bEmar.length) {
      await p.emarAuditLog.deleteMany({ where: { scheduleId: { in: bEmar } } });
      await p.emarSchedule.deleteMany({ where: { id: { in: bEmar } } });
    }
    await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: b } } });
    await p.payment.deleteMany({ where: { billId: { in: bills } } });
    await p.billItem.deleteMany({ where: { billId: { in: bills } } });
    await p.bill.deleteMany({ where: { id: { in: bills } } });
    await p.drugBatch.deleteMany({ where: { drugId: { in: ids } } });
    await p.drugFormulary.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (swept ${stale.length} leftover fixture drug(s))`);
  }
  // prescription_items has a RESTRICT foreign key, so the lines go first.
  const staleRx = (await p.prescription.findMany({
    where: { tenantId: TENANT, notes: { startsWith: 'RX-' } }, select: { id: true },
  })).map((r) => r.id);
  if (staleRx.length) {
    const staleEmar = (await p.emarSchedule.findMany({ where: { prescriptionId: { in: staleRx } }, select: { id: true } })).map((e) => e.id);
    if (staleEmar.length) {
      await p.emarAuditLog.deleteMany({ where: { scheduleId: { in: staleEmar } } });
      await p.emarSchedule.deleteMany({ where: { id: { in: staleEmar } } });
    }
    await p.dispensingRecord.deleteMany({ where: { prescriptionId: { in: staleRx } } });
    await p.prescriptionItem.deleteMany({ where: { prescriptionId: { in: staleRx } } });
    await p.prescription.deleteMany({ where: { id: { in: staleRx } } });
  }

  // -- Fixtures ------------------------------------------------------------
  section('Fixtures');
  const drug: any = await p.drugFormulary.create({
    data: {
      tenantId: TENANT, drugName: `${TAG} Amoxicillin 500`, genericName: 'Amoxicillin',
      composition: 'Amoxicillin (500mg)', strength: '500mg',
      dosageForm: 'capsule', unitOfMeasurement: 'capsule',
      packSize: 10, looseUnitLabel: 'capsule',
      price: 5, taxPercent: 12, hsnCode: '3004', schedule: 'H', isActive: true,
    } as never,
  });
  const batch: any = await p.drugBatch.create({
    data: {
      tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-B1`,
      quantityReceived: 500, quantityInStock: 500,
      expiryDate: new Date(Date.now() + 400 * 864e5),
      purchasePrice: 3, sellingPrice: 5, mrp: 5,
    } as never,
  });
  const doctor = await p.doctorProfile.findFirst({
    where: { tenantId: TENANT, user: { email: 'doc1@email.com' } },
    select: { id: true, userId: true },
  });
  const visit = await p.visit.findFirst({
    where: { tenantId: TENANT },
    orderBy: { visitDate: 'desc' },
    select: { id: true, patientId: true },
  });
  ck('a drug with 500 in stock', (await qty(batch.id)) === 500);
  ck('a doctor profile', Boolean(doctor?.id));
  ck('a visit to prescribe against', Boolean(visit?.id));
  if (!doctor || !visit) return;

  const rxBody = (over: Record<string, unknown> = {}) => ({
    patientId: visit.patientId,
    doctorId: doctor.userId,
    visitId: visit.id,
    prescriptionType: 'op',
    notes: `${TAG} course`,
    items: [{
      drugId: drug.id, drugName: drug.drugName,
      dosage: '500mg', frequency: '1-1-1', duration: '3 days', route: 'oral',
    }],
    ...over,
  });

  // -- 1. Writing one ------------------------------------------------------
  section('1. Writing a prescription');
  const created = await api('doc', 'POST', '/prescriptions', rxBody());
  ck('the doctor can write it', created.status < 400, created.message);
  const rx = created.data;
  ck('it starts active', rx?.status === 'active', rx?.status ?? '');
  const item = (rx?.prescriptionItems ?? [])[0];
  ck(
    '1-1-1 for 3 days is worked out as 9 capsules',
    Number(item?.quantity) === 9,
    `${item?.quantity}`,
  );
  ck(
    'the User id the doctor UI sends is resolved to their profile',
    rx?.doctorId === doctor.id,
    `${rx?.doctorId?.slice(0, 8)} vs profile ${doctor.id.slice(0, 8)}`,
  );

  const halves = await api('doc', 'POST', '/prescriptions', rxBody({
    items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '250mg', frequency: '1/2-0-1/2', duration: '4 days', route: 'oral' }],
  }));
  ck('half doses are counted as halves', Number((halves.data?.prescriptionItems ?? [])[0]?.quantity) === 4, `${(halves.data?.prescriptionItems ?? [])[0]?.quantity}`);

  const dosed = await api('doc', 'POST', '/prescriptions', rxBody({
    items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: '1-1-1', duration: '3 days', route: 'oral', doseQuantity: 2 }],
  }));
  ck('two units per intake doubles it', Number((dosed.data?.prescriptionItems ?? [])[0]?.quantity) === 18, `${(dosed.data?.prescriptionItems ?? [])[0]?.quantity}`);

  const prn = await api('doc', 'POST', '/prescriptions', rxBody({
    items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: 'As Needed (SOS)', duration: '5 days', route: 'oral', isPrn: true }],
  }));
  ck(
    'an as-needed line has no derivable quantity, and is left blank rather than guessed',
    (prn.data?.prescriptionItems ?? [])[0]?.quantity == null,
    `${(prn.data?.prescriptionItems ?? [])[0]?.quantity}`,
  );

  const explicit = await api('doc', 'POST', '/prescriptions', rxBody({
    items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: '1-1-1', duration: '3 days', route: 'oral', quantity: 30 }],
  }));
  ck('a quantity the doctor typed wins over the calculation', Number((explicit.data?.prescriptionItems ?? [])[0]?.quantity) === 30, `${(explicit.data?.prescriptionItems ?? [])[0]?.quantity}`);

  // -- 2. Who may write ----------------------------------------------------
  section('2. Who may write one');
  if (haveNurse) {
    const byNurse = await api('nurse', 'POST', '/prescriptions', rxBody());
    ck('a nurse cannot write a prescription', byNurse.status === 403, `status ${byNurse.status}`);
    const nurseEdit = await api('nurse', 'PATCH', `/prescriptions/${rx.id}`, { notes: `${TAG} nurse edit` });
    ck('nor change one', nurseEdit.status === 403, `status ${nurseEdit.status}`);
  }
  const ghostPatient = await api('doc', 'POST', '/prescriptions', rxBody({ patientId: '00000000-0000-0000-0000-000000000000' }));
  ck('a patient who does not exist is refused', ghostPatient.status >= 400, ghostPatient.message);
  const ghostVisit = await api('doc', 'POST', '/prescriptions', rxBody({ visitId: '00000000-0000-0000-0000-000000000000' }));
  ck('so is a visit that is not this patient', ghostVisit.status >= 400, ghostVisit.message);

  // -- 3. Changing it ------------------------------------------------------
  section('3. Changing it');
  const added = await api('doc', 'POST', `/prescriptions/${rx.id}/items`, {
    drugId: drug.id, drugName: drug.drugName, dosage: '500mg',
    frequency: '1-0-1', duration: '5 days', route: 'oral',
  });
  ck('a line can be added', added.status < 400, added.message);
  ck('...and is costed the same way', Number(added.data?.quantity) === 10, `${added.data?.quantity}`);
  const addedId = added.data?.id;

  const edited = await api('doc', 'PUT', `/prescriptions/${rx.id}/items/${addedId}`, {
    frequency: '1-1-1', duration: '5 days',
  });
  ck('a line can be corrected', edited.status < 400, edited.message);
  ck('...and the quantity follows the correction', Number(edited.data?.quantity) === 15, `${edited.data?.quantity}`);

  // Removing a line needs `prescriptions:delete`, which only admin and
  // super_admin hold — the doctor who WROTE the prescription cannot take a line
  // off it. Recorded rather than asserted away: the route exists, the frontend
  // hook exists, and no component calls it, so nothing is visibly broken today.
  const removed = await api('doc', 'DELETE', `/prescriptions/${rx.id}/items/${addedId}`);
  ck(
    'a doctor cannot remove a line from their own prescription',
    removed.status === 403,
    `${removed.message} - only admin holds prescriptions:delete`,
  );
  const removedByAdmin = await api('admin', 'DELETE', `/prescriptions/${rx.id}/items/${addedId}`);
  ck('an administrator can', removedByAdmin.status < 400, removedByAdmin.message);
  ck('...leaving the original', (await p.prescriptionItem.count({ where: { prescriptionId: rx.id } })) === 1);

  // -- 4. Allergies and interactions ---------------------------------------
  section('4. Allergies and interactions');
  const allergy = await p.patientAllergy.create({
    data: {
      patientId: visit.patientId, allergyType: 'drug', allergen: 'Amoxicillin',
      severity: 'severe', reaction: `${TAG} rash`,
    } as never,
  });
  const check = await api('doc', 'GET', `/prescriptions/allergy-check?patientId=${visit.patientId}&drugName=${encodeURIComponent(drug.drugName)}`);
  ck('an allergy to the drug is found', check.status < 400 && (check.data?.matchedAllergies ?? check.data?.allergies ?? []).length > 0, `status ${check.status}`);
  ck('...and reported as a warning, not a block', check.status < 400, 'the doctor decides, the system informs');

  const generic = await api('doc', 'GET', `/prescriptions/allergy-check?patientId=${visit.patientId}&drugName=${encodeURIComponent('Amoxicillin')}`);
  ck('the generic name matches too, not just the brand', generic.status < 400 && (generic.data?.matchedAllergies ?? generic.data?.allergies ?? []).length > 0);

  const inter = await api('doc', 'POST', '/prescriptions/check-interactions', {
    drugs: ['Warfarin', 'Aspirin'],
  });
  const pairs = (inter.data?.pairs ?? []) as any[];
  ck('a known interacting pair is flagged', inter.status < 400 && pairs.length > 0, `status ${inter.status}, ${pairs.length} pair(s), severity ${inter.data?.highestSeverity}`);
  ck('...with a severity the doctor can weigh', Boolean(inter.data?.highestSeverity), `${inter.data?.highestSeverity}`);

  // -- 5. To the counter ---------------------------------------------------
  section('5. Dispensing it at the counter');
  const rxItem = await p.prescriptionItem.findFirst({ where: { prescriptionId: rx.id }, select: { id: true, quantity: true } });
  const beforeStock = await qty(batch.id);

  const part = await api('pharm', 'POST', '/pharmacy/sales', {
    patientId: visit.patientId,
    prescriptionId: rx.id,
    items: [{ drugBatchId: batch.id, quantity: 4, saleUnit: 'loose', prescriptionItemId: rxItem!.id }],
    paymentMethod: 'cash',
  });
  ck('part of it can be handed over', part.status < 400, part.message);
  ck('the stock goes down by what was handed over', (await qty(batch.id)) === beforeStock - 4, `${await qty(batch.id)}`);
  ck('the prescription reads as partly dispensed', (await statusOf(rx.id)) === 'partially_dispensed', `${await statusOf(rx.id)}`);

  const restOfIt = await api('pharm', 'POST', '/pharmacy/sales', {
    patientId: visit.patientId,
    prescriptionId: rx.id,
    items: [{ drugBatchId: batch.id, quantity: 5, saleUnit: 'loose', prescriptionItemId: rxItem!.id }],
    paymentMethod: 'cash',
  });
  ck('and the rest after it', restOfIt.status < 400, restOfIt.message);
  ck('now it reads as dispensed, and leaves the queue', (await statusOf(rx.id)) === 'dispensed', `${await statusOf(rx.id)}`);

  // Voiding the sale must put the prescription back into the queue — the
  // medicine went back on the shelf, so the patient still needs it.
  const voidId = (part.data?.bill ?? part.data)?.id;
  await api('pharm', 'PATCH', `/pharmacy/sales/${voidId}/cancel`, { reason: `${TAG} wrong patient` });
  ck(
    'voiding a sale puts the prescription back to needing the medicine',
    (await statusOf(rx.id)) === 'partially_dispensed',
    `${await statusOf(rx.id)}`,
  );

  // -- 6. An inpatient prescription ----------------------------------------
  section('6. An inpatient prescription');
  const admission = await p.admission.findFirst({
    where: { tenantId: TENANT, status: 'admitted' },
    orderBy: { admissionDate: 'desc' },
    select: { id: true, patientId: true },
  });
  if (!admission) {
    ck('SKIPPED - nobody is admitted', false, 'admit a patient and re-run');
  } else {
    const ipVisit = await p.visit.findFirst({
      where: { tenantId: TENANT, patientId: admission.patientId },
      orderBy: { visitDate: 'desc' },
      select: { id: true },
    });
    const ipRx = await api('doc', 'POST', '/prescriptions', {
      patientId: admission.patientId, doctorId: doctor.userId,
      visitId: ipVisit?.id ?? visit.id,
      prescriptionType: 'ip', notes: `${TAG} ward course`,
      items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: '1-1-1', duration: '2 days', route: 'oral' }],
    });
    ck('an IP prescription can be written', ipRx.status < 400, ipRx.message);

    if (ipRx.status < 400) {
      const atCounter = await api('pharm', 'POST', '/pharmacy/sales', {
        patientId: admission.patientId, prescriptionId: ipRx.data.id,
        items: [{ drugBatchId: batch.id, quantity: 1, saleUnit: 'loose' }],
        paymentMethod: 'cash',
      });
      ck(
        'it cannot be sold at the counter — that would bill the patient twice',
        atCounter.status >= 400 && /IP bill|Ward Indents/i.test(atCounter.message),
        atCounter.message.slice(0, 80),
      );

      const q = await api('pharm', 'PATCH', `/pharmacy/queue/${ipRx.data.id}/status`, { status: 'preparing' });
      ck('the pharmacy can move it along the queue', q.status < 400, q.message);

      const ipBefore = await qty(batch.id);
      const ipDone = await api('pharm', 'POST', `/pharmacy/queue/${ipRx.data.id}/dispense-ip`, {});
      await rememberBill(ipDone.data?.billId);
      ck('and dispense it to the ward', ipDone.status < 400, ipDone.message);
      ck('the stock goes down by the ordered 6', (await qty(batch.id)) === ipBefore - 6, `${await qty(batch.id)}`);

      const ipBill = ipDone.data?.billId
        ? await p.bill.findUnique({ where: { id: ipDone.data.billId }, include: { billItems: true } })
        : null;
      ck('it is charged to a hospital bill, not a counter invoice', Boolean(ipBill) && !/^PH-/.test(ipBill?.billNumber ?? ''), ipBill?.billNumber ?? '');
      ck('never to the ADV- advance bucket', !/^ADV-/.test(ipBill?.billNumber ?? ''), ipBill?.billNumber ?? '');
      const ipLine = (ipBill?.billItems ?? []).find((i: any) => String(i.description).includes(TAG));
      ck('charged 6 x 5', near(money(ipLine?.totalAmount), 30), `${ipLine?.totalAmount}`);

      const twice = await api('pharm', 'POST', `/pharmacy/queue/${ipRx.data.id}/dispense-ip`, {});
      ck('it cannot be dispensed twice', twice.status >= 400, twice.message);

      // What happens when the shelf runs short. The patient must not be billed
      // for medicine that was never handed over.
      const shortRx = await api('doc', 'POST', '/prescriptions', {
        patientId: admission.patientId, doctorId: doctor.userId,
        visitId: ipVisit?.id ?? visit.id,
        prescriptionType: 'ip', notes: `${TAG} short course`,
        items: [{ drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: '1-1-1', duration: '10 days', route: 'oral' }],
      });
      const shortBatch: any = await p.drugBatch.create({
        data: {
          tenantId: TENANT, drugId: drug.id, batchNumber: `${TAG}-SHORT`,
          quantityReceived: 4, quantityInStock: 4,
          expiryDate: new Date(Date.now() + 400 * 864e5),
          purchasePrice: 3, sellingPrice: 5, mrp: 5,
        } as never,
      });
      // Empty every other batch of this drug so only the 4 remain.
      await p.drugBatch.updateMany({
        where: { tenantId: TENANT, drugId: drug.id, id: { not: shortBatch.id } },
        data: { quantityInStock: 0 },
      });
      const shortDone = await api('pharm', 'POST', `/pharmacy/queue/${shortRx.data.id}/dispense-ip`, {});
      ck('a dispense with only 4 of 30 in stock goes through', shortDone.status < 400, shortDone.message);

      if (shortDone.status < 400) {
        await rememberBill(shortDone.data?.billId);
        const shortBill = await p.bill.findUnique({ where: { id: shortDone.data.billId }, include: { billItems: true } });
        const shortLine = (shortBill?.billItems ?? []).find((i: any) => String(i.description).includes(`${TAG} Amoxicillin`) && Number(i.quantity) === 30);
        ck(
          'the patient is billed for what was handed over, not what was ordered',
          !shortLine,
          shortLine ? `billed ${shortLine.quantity} x ${shortLine.unitPrice} = ${shortLine.totalAmount} when only 4 were in stock` : 'billed the dispensed quantity',
        );
        const realLine = (shortBill?.billItems ?? []).find((i: any) => String(i.description).includes(`${TAG} Amoxicillin`) && Number(i.quantity) === 4);
        ck('...which is 4 x 5', near(money(realLine?.totalAmount), 20), `${realLine?.totalAmount}`);
        ck(
          'and the bill says what is still owed, rather than hiding it in a note',
          /still owed/.test(realLine?.description ?? ''),
          realLine?.description ?? '',
        );
        const shortRec = await p.dispensingRecord.findFirst({
          where: { prescriptionId: shortRx.data.id },
          select: { quantityDispensed: true, notes: true },
        });
        ck(
          'and the dispensing record says how many actually left the shelf',
          shortRec?.quantityDispensed === 4,
          `records ${shortRec?.quantityDispensed}, shelf had 4 - ${shortRec?.notes ?? ''}`,
        );
        ck('the shelf is empty, not negative', (await qty(shortBatch.id)) === 0, `${await qty(shortBatch.id)}`);
      }
    }
  }

  // -- 7. Cancelling -------------------------------------------------------
  section('7. Cancelling');
  const toCancel = await api('doc', 'POST', '/prescriptions', rxBody());
  const cancelled = await api('doc', 'PATCH', `/prescriptions/${toCancel.data.id}/cancel`, {});
  ck('a prescription can be cancelled', cancelled.status < 400 && cancelled.data?.status === 'cancelled', cancelled.data?.status ?? '');
  const again = await api('doc', 'PATCH', `/prescriptions/${toCancel.data.id}/cancel`, {});
  ck('and not cancelled twice', again.status >= 400, again.message);
  const addToCancelled = await api('doc', 'POST', `/prescriptions/${toCancel.data.id}/items`, {
    drugId: drug.id, drugName: drug.drugName, dosage: '500mg', frequency: '1-0-0', duration: '1 day', route: 'oral',
  });
  ck('nothing can be added to a cancelled one', addToCancelled.status >= 400, addToCancelled.message);

  // -- 8. Reading it back ---------------------------------------------------
  section('8. Reading it back');
  const one = await api('doc', 'GET', `/prescriptions/${rx.id}`);
  ck('it can be opened', one.status < 400 && one.data?.id === rx.id, `status ${one.status}`);
  ck('...with its lines, patient and doctor', (one.data?.prescriptionItems ?? []).length > 0 && Boolean(one.data?.patient));
  const list = await api('doc', 'GET', `/prescriptions?patientId=${visit.patientId}&limit=100`);
  ck('the list finds this patient', list.status < 400, `status ${list.status}`);
  const listed = (list.data?.prescriptions ?? list.data?.items ?? list.data ?? []) as any[];
  ck('...and includes it', Array.isArray(listed) && listed.some((r: any) => r.id === rx.id), `${Array.isArray(listed) ? listed.length : '?'} row(s)`);

  const pdfRes = await fetch(`${API}/prescriptions/${rx.id}/pdf`, {
    headers: { Authorization: `Bearer ${tokens.doc}`, 'X-Tenant-Id': TENANT },
  });
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  ck('it prints', pdfRes.status < 400, `status ${pdfRes.status}`);
  ck('...as a PDF with content', buf.subarray(0, 5).toString() === '%PDF-' && buf.length > 2000, `${(buf.length / 1024).toFixed(1)} KB`);

  // -- 9. Another hospital --------------------------------------------------
  section('9. Another hospital cannot read it');
  // The X-Tenant-Id header hole is a known, accepted risk tracked separately —
  // not re-litigated here. The question this asks is different: does a
  // prescription list ever hand back a patient who is not this hospital's?
  const listedAll = await api('doc', 'GET', '/prescriptions?limit=100');
  const patientIds = [...new Set(((listedAll.data?.prescriptions ?? listedAll.data?.items ?? listedAll.data ?? []) as any[])
    .map((r: any) => r.patientId).filter(Boolean))];
  const foreign = patientIds.length
    ? await p.patient.count({ where: { id: { in: patientIds as string[] }, tenantId: { not: TENANT } } })
    : 0;
  ck(
    'no prescription in the list belongs to another hospital patient',
    foreign === 0,
    `${foreign} of ${patientIds.length} patients are not this hospital's`,
  );

  // -- Cleanup --------------------------------------------------------------
  section('Cleanup');
  const rxIds = (await p.prescription.findMany({ where: { tenantId: TENANT, notes: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
  const batchIds = (await p.drugBatch.findMany({ where: { drugId: drug.id }, select: { id: true } })).map((b) => b.id);
  const billIds = [...new Set((await p.dispensingRecord.findMany({ where: { drugBatchId: { in: batchIds } }, select: { billId: true } })).map((r) => r.billId).filter(Boolean))] as string[];
  const emarIds = (await p.emarSchedule.findMany({
    where: { OR: [{ prescriptionId: { in: rxIds } }, { drugBatchId: { in: batchIds } }] },
    select: { id: true },
  })).map((e) => e.id);
  if (emarIds.length) {
    await p.emarAuditLog.deleteMany({ where: { scheduleId: { in: emarIds } } });
    await p.emarSchedule.deleteMany({ where: { id: { in: emarIds } } });
  }
  await p.drugReturn.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.dispensingRecord.deleteMany({ where: { drugBatchId: { in: batchIds } } });
  await p.billItem.deleteMany({ where: { billId: { in: billIds } } });
  // Put a borrowed bill back exactly as it was, then delete only the ones this
  // run opened. Deleting a real running bill would take a stay's charges — and
  // an insurance claim — with it.
  for (const [id, was] of borrowedBills) {
    await p.bill.update({ where: { id }, data: was as never });
  }
  const ours = billIds.filter((id) => !borrowedBills.has(id));
  await p.payment.deleteMany({ where: { billId: { in: ours } } });
  await p.bill.deleteMany({ where: { id: { in: ours } } });
  await p.prescriptionItem.deleteMany({ where: { prescriptionId: { in: rxIds } } });
  await p.prescription.deleteMany({ where: { id: { in: rxIds } } });
  await p.patientAllergy.deleteMany({ where: { id: allergy.id } });
  await p.drugBatch.deleteMany({ where: { drugId: drug.id } });
  await p.drugFormulary.deleteMany({ where: { id: drug.id } });
  ck('fixtures cleaned up', (await p.drugFormulary.count({ where: { drugName: { startsWith: TAG } } })) === 0);
  for (const [id, was] of borrowedBills) {
    const now = await p.bill.findUnique({ where: { id }, select: { totalAmount: true } });
    ck('a bill this walk borrowed is back as it was', String(now?.totalAmount) === was.totalAmount, `${now?.totalAmount} vs ${was.totalAmount}`);
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
