/**
 * Walk a concession granted AFTER the invoice was issued.
 *
 * Section 34 says the difference travels on a credit note. This asserts one is
 * raised, that it carries the line's own tax, that a second concession credits
 * only the increment, and that a concession on a DRAFT raises nothing.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';
import * as billing from '../../src/modules/billing/billing.service';

const TENANT = '0ae28771-4678-4473-8807-74789e08346c';
const TAG = `DISCCN-${Date.now()}`;

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

/** A bill with one taxable room line, issued and numbered. */
async function issuedBill(actorId: string, patientId: string) {
  const bill = await billing.createBill(TENANT, actorId, { patientId } as any);
  await prisma.billItem.create({
    data: {
      billId: bill.id, description: `${TAG} deluxe room`, category: 'room',
      quantity: 1, unitPrice: 8000, taxPercent: 5, taxableValue: 8000,
      taxAmount: 400, cgstAmount: 200, sgstAmount: 200, totalAmount: 8400,
      hsnSacCode: '996311', gstTreatment: 'taxable', rateSource: 'room_rule',
    } as any,
  });
  await billing.finalizeBill(TENANT, actorId, bill.id);
  return bill.id;
}

const notesOn = (billId: string) =>
  prisma.creditNote.findMany({ where: { billId }, orderBy: { createdAt: 'asc' } });

async function main() {
  const actor = await prisma.user.findFirst({ where: { email: 'admin@hospital.com' }, select: { id: true } });
  const other = await prisma.user.findFirst({
    where: { email: { not: 'admin@hospital.com' }, isActive: true }, select: { id: true },
  });
  if (!actor || !other) throw new Error('need two users');
  const patient = await prisma.patient.create({
    data: { tenantId: TENANT, mrn: TAG, firstName: 'Concession', notes: TAG },
  });

  // ── A concession after the invoice is issued ──
  const billId = await issuedBill(actor.id, patient.id);
  const issued = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
  ck('the bill was issued and numbered', !!issued.invoiceNumber, `${issued.invoiceNumber}`);

  await billing.applyDiscount(
    TENANT, billId, { discountType: 'fixed', discountValue: 840, reason: `${TAG} goodwill` } as any, actor.id,
  );

  const after = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
  const notes = await notesOn(billId);
  ck('the concession came off what the patient owes', near(Number(after.totalAmount), 7560),
     `${after.totalAmount}`);
  ck('a credit note was raised for it', notes.length === 1, `${notes.length} note(s)`);
  ck('under the post-supply discount reason', notes[0]?.reason === 'post_supply_discount',
     `${notes[0]?.reason}`);
  ck('for the amount of the concession', near(Math.abs(Number(notes[0]?.totalAmount)), 840),
     `${notes[0]?.totalAmount}`);
  // 840 of 8400 is a tenth of the invoice, so a tenth of its 400 tax.
  ck('carrying a tenth of the line’s own tax, not a blended rate',
     near(Math.abs(Number(notes[0]?.taxAmount)), 40), `${notes[0]?.taxAmount}`);
  ck('split the way the line was', near(Math.abs(Number(notes[0]?.cgstAmount)), 20) &&
     near(Math.abs(Number(notes[0]?.sgstAmount)), 20),
     `c${notes[0]?.cgstAmount} s${notes[0]?.sgstAmount}`);
  ck('numbered from the credit note series',
     /^CN\/\d{4}-\d{2}\/\d{6}$/.test(notes[0]?.creditNoteNumber ?? ''),
     `${notes[0]?.creditNoteNumber}`);
  // The invoice already went to the patient; restating it would rewrite a
  // document they are holding.
  ck('and the invoice’s own tax was NOT rewritten', near(Number(after.taxAmount), 400),
     `${after.taxAmount}`);

  // ── A second concession credits only the increment ──
  await billing.applyDiscount(
    TENANT, billId, { discountType: 'fixed', discountValue: 420, reason: `${TAG} more goodwill` } as any, actor.id,
  );
  const notes2 = await notesOn(billId);
  ck('a further concession raises a second note', notes2.length === 2, `${notes2.length} note(s)`);
  ck('for the INCREMENT only, not the running total',
     near(Math.abs(Number(notes2[1]?.totalAmount)), 420), `${notes2[1]?.totalAmount}`);
  ck('so the credited total equals the concession granted',
     near(notes2.reduce((t, n) => t + Math.abs(Number(n.totalAmount)), 0), 1260),
     'credited total does not match');

  // ── A concession on a DRAFT is pricing, not a reversal ──
  const draft = await billing.createBill(TENANT, actor.id, { patientId: patient.id } as any);
  await prisma.billItem.create({
    data: {
      billId: draft.id, description: `${TAG} draft line`, category: 'room',
      quantity: 1, unitPrice: 1000, taxPercent: 0, taxableValue: 1000,
      taxAmount: 0, totalAmount: 1000, gstTreatment: 'exempt', rateSource: 'room_rule',
    } as any,
  });
  // The line was inserted directly, so the header still reads zero until the
  // totals are rebuilt — the discount guard measures against the subtotal.
  await billing.recalculateBillTotalsPublic(draft.id);
  await billing.applyDiscount(
    TENANT, draft.id, { discountType: 'fixed', discountValue: 100, reason: `${TAG} draft` } as any, actor.id,
  );
  ck('a concession on a draft raises no credit note', (await notesOn(draft.id)).length === 0,
     'a draft was credited');

  // ── A concession awaiting approval moves nothing ──
  await billing.updateDiscountApprovalSettings(TENANT, actor.id, {
    enabled: true, maxAmountWithoutApproval: 1, maxPercentWithoutApproval: 0,
  } as any).catch((e: any) => console.log('    (settings: ' + e.message + ')'));
  const gated = await issuedBill(actor.id, patient.id);
  const req: any = await billing.applyDiscount(
    TENANT, gated, { discountType: 'fixed', discountValue: 500, reason: `${TAG} needs sign-off` } as any, actor.id,
  );
  if (req?.discountPendingApproval) {
    ck('a concession awaiting approval raises no note yet', (await notesOn(gated)).length === 0,
       'credited before anybody approved it');
    await billing.decideDiscount(TENANT, other.id, req.id, { approve: true });
    const decided = await notesOn(gated);
    ck('and raises one the moment it is approved', decided.length === 1, `${decided.length} note(s)`);
    ck('for the approved amount', near(Math.abs(Number(decided[0]?.totalAmount)), 500),
       `${decided[0]?.totalAmount}`);
  } else {
    console.log('    (skipped the approval gate — the policy did not require sign-off)');
  }
  await billing.updateDiscountApprovalSettings(TENANT, actor.id, {
    enabled: false, maxAmountWithoutApproval: 0, maxPercentWithoutApproval: 0,
  } as any).catch(() => undefined);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .finally(async () => {
    const pat = await prisma.patient.findFirst({ where: { mrn: TAG }, select: { id: true } });
    if (pat) {
      const bills = await prisma.bill.findMany({ where: { patientId: pat.id }, select: { id: true } });
      const ids = bills.map((b) => b.id);
      await prisma.creditNoteItem.deleteMany({ where: { creditNote: { billId: { in: ids } } } });
      await prisma.creditNote.deleteMany({ where: { billId: { in: ids } } });
      await prisma.discount.deleteMany({ where: { billId: { in: ids } } });
      await prisma.billItem.deleteMany({ where: { billId: { in: ids } } });
      await prisma.bill.deleteMany({ where: { id: { in: ids } } });
      await prisma.patient.delete({ where: { id: pat.id } });
    }
    await prisma.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
