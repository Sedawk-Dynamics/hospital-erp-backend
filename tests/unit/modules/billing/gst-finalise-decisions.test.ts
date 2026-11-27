import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  addIpCharge,
  adjustAdvanceToBill,
  billDiagnosticOrder,
  billOtRequest,
  consolidateAdmissionBill,
  finalizeBill,
  issueDocumentForExistingBill,
  refreshDraftBillTax,
  updateBillItem,
} from '../../../../src/modules/billing/billing.service';
import { setBillBuyer, setBillSupplyType } from '../../../../src/modules/billing/billing.buyer.service';
import { mergeRegistrationFee, DEFAULT_REGISTRATION_FEE } from '../../../../src/shared/registration-fee';

// #264 (missing SAC) and #265 (place of supply), through the paths that issue.

vi.mock('../../../../src/modules/compliance/ot-rules', () => ({
  OT_CHARGE_REFERENCE_TYPES: ['ot_request'],
  OT_NO_CHARGE_LABEL: 'no charge',
  otChargeLineDescription: (_l: unknown, name: string) => name,
  resolveOtCharge: vi.fn(async () => ({
    amount: 20000,
    lines: [{ referenceType: 'ot_request', component: 'procedure', label: 'Procedure', amount: 20000 }],
  })),
}));

const T = 'tenant-1';
const U = 'user-1';
const HOME = '33AAACS2601K1ZR'; // Tamil Nadu
const MH_BUYER = '27AAPFU0939F1ZV'; // Maharashtra

let profile: Record<string, unknown>;
const p = prisma as any;

const line = (over: Record<string, unknown> = {}) => ({
  id: 'i1', description: 'Health check', category: 'other', hsnSacCode: '999312', gstTreatment: 'taxable',
  quantity: 1, unitPrice: 1000, discountAmount: 0, taxPercent: 18, taxableValue: 1000, taxAmount: 180,
  cgstRate: 9, cgstAmount: 90, sgstRate: 9, sgstAmount: 90, igstRate: 0, igstAmount: 0, totalAmount: 1180,
  serviceTariffId: null, referenceType: null, referenceId: null, taxReason: null, ...over,
});
const bill = (items: any[], over: Record<string, unknown> = {}) => ({
  id: 'b1', tenantId: T, patientId: 'pat', billNumber: 'BILL-1', billDate: new Date('2026-11-20T06:00:00Z'),
  status: 'draft', invoiceNumber: null, recipientGstin: null, admissionId: null, placeOfSupplyStateCode: null,
  isInterState: false, supplyType: 'performed_at_hospital', supplyDestinationStateCode: null,
  supplierGstin: null, supplierStateCode: null, totalAmount: 1180, balanceDue: 1180, billItems: items, ...over,
});

function seed(b: any) {
  p.bill.findFirst.mockImplementation(async (a: any) => (a?.select?.billDate && Object.keys(a.select).length === 1 ? { billDate: b.billDate } : b));
  p.bill.findUnique.mockResolvedValue({ tenantId: T, status: 'draft' });
  p.billItem.findMany.mockResolvedValue(b.billItems);
  p.billItem.count.mockResolvedValue(0);
  p.bill.update.mockImplementation(async (a: any) => ({ ...b, ...a.data }));
}
/** The update that moved the bill out of draft, if there was one. */
const finalUpdate = () => p.bill.update.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.status === 'pending');

beforeEach(() => {
  vi.resetAllMocks();
  profile = { registered: true, gstin: HOME, stateCode: '33' };
  p.tenant.findFirst.mockImplementation(async () => ({ themeConfig: { gst: profile }, hospitalCode: 'TST' }));
  p.tenant.findUnique.mockImplementation(async () => ({ themeConfig: { gst: profile }, hospitalCode: 'TST' }));
  p.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
  for (const m of ['bill', 'billItem', 'payment', 'discount', 'serviceTariff', 'otRequest', 'hsnCode', 'sacCode', 'gstCategoryDefault',
    'gstTaxSlab', 'gstFiledPeriod', 'creditNote', 'refund', 'insuranceClaim', 'labOrder', 'imagingRequest', 'visit', 'dispensingRecord', 'admission']) {
    try {
      p[m].findMany.mockResolvedValue([]);
      p[m].count.mockResolvedValue(0);
      p[m].aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
      p[m].updateMany.mockResolvedValue({ count: 1 });
      p[m].deleteMany.mockResolvedValue({ count: 0 });
    } catch { /* a model this schema does not have */ }
  }
  p.gstDocumentSeries.upsert.mockResolvedValue({ prefix: 'INV', lastNumber: 1 });
  p.$queryRaw.mockResolvedValue([]);
  p.billItem.create.mockImplementation(async (a: any) => ({ id: `new-${Math.random()}`, ...a.data }));
});

// ── #264 ───────────────────────────────────────────────────────────────────

describe('#264: a taxed service with no SAC blocks the bill', () => {
  it('refuses with a code and the service names, before anything is written', async () => {
    seed(bill([line({ hsnSacCode: null, description: 'Botox' }), line({ id: 'i2', description: 'Consultation', category: 'consultation', hsnSacCode: null, taxPercent: 0, taxAmount: 0, gstTreatment: 'exempt' })]));
    await expect(finalizeBill(T, U, 'b1')).rejects.toMatchObject({
      statusCode: 409, code: 'SAC_REQUIRED', details: { services: ['Botox'] },
      message: expect.stringContaining('Botox'),
    });
    expect(p.bill.update).not.toHaveBeenCalled();
    expect(p.billItem.update).not.toHaveBeenCalled();
    expect(p.gstDocumentSeries.upsert).not.toHaveBeenCalled();
  });

  it('blocks on tax in rupees even when the stored rate reads 0', async () => {
    seed(bill([line({ hsnSacCode: null, taxPercent: 0, taxAmount: 5 })]));
    await expect(finalizeBill(T, U, 'b1')).rejects.toMatchObject({ code: 'SAC_REQUIRED' });
  });

  // #264 "prevent regression": one bill, one taxable and one exempt service,
  // each classified on its own service.
  it('finalises a bill with a taxable and an exempt service, each keeping its own SAC and tax', async () => {
    const cosmetic = line({ id: 'i1', description: 'Cosmetic peel', hsnSacCode: null, serviceTariffId: 't-tax' });
    const consult = line({
      id: 'i2', description: 'Consultation', category: 'consultation', hsnSacCode: null, serviceTariffId: 't-exempt',
      gstTreatment: 'exempt', taxPercent: 0, taxAmount: 0, cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0, totalAmount: 1000,
    });
    seed(bill([cosmetic, consult], { totalAmount: 2180, balanceDue: 2180 }));
    p.serviceTariff.findMany.mockResolvedValue([
      { id: 't-tax', sacCode: '999319' },
      { id: 't-exempt', sacCode: '999312' },
    ]);
    // As the database does: the stamped code is on the line the bill is read back with.
    p.billItem.update.mockImplementation(async (a: any) => Object.assign([cosmetic, consult].find((l) => l.id === a.where.id)!, a.data));

    const out = await finalizeBill(T, U, 'b1');

    expect(finalUpdate()).toBeTruthy();
    expect(out.gstWarnings ?? []).not.toContainEqual(expect.stringMatching(/no SAC code/));
    const stamped = Object.fromEntries(p.billItem.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data.hsnSacCode]));
    expect(stamped).toMatchObject({ i1: '999319', i2: '999312' });
    // Neither line's tax was touched: 18% stays on the taxable one, none on the exempt one.
    for (const c of p.billItem.update.mock.calls) expect(c[0].data).not.toHaveProperty('taxAmount');
  });

  it('a mixed bill is stopped only for its taxed service when that one has no SAC', async () => {
    seed(bill([
      line({ id: 'i1', description: 'Cosmetic peel', hsnSacCode: null }),
      line({ id: 'i2', description: 'Consultation', category: 'consultation', hsnSacCode: '999312', gstTreatment: 'exempt', taxPercent: 0, taxAmount: 0 }),
    ]));
    await expect(finalizeBill(T, U, 'b1')).rejects.toMatchObject({ code: 'SAC_REQUIRED', details: { services: ['Cosmetic peel'] } });
  });

  it('warns and allows the same service at 0%', async () => {
    seed(bill([line({ description: 'Dressing', hsnSacCode: null, taxPercent: 0, taxAmount: 0, cgstAmount: 0, sgstAmount: 0, gstTreatment: 'exempt', totalAmount: 1000 })]));
    const out = await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toBeTruthy();
    expect(out.gstWarnings[0]).toMatch(/no SAC code: Dressing/);
  });

  it('never blocks goods, or an unregistered hospital', async () => {
    seed(bill([line({ category: 'pharmacy', hsnSacCode: null })]));
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toBeTruthy();

    vi.clearAllMocks();
    profile = { registered: false };
    seed(bill([line({ hsnSacCode: null })]));
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toBeTruthy();
  });

  it('picks the code up from the service once the admin has set it, and stamps the line', async () => {
    seed(bill([line({ hsnSacCode: null, serviceTariffId: 't1' })]));
    p.serviceTariff.findMany.mockResolvedValue([{ id: 't1', sacCode: '999722' }]);
    await finalizeBill(T, U, 'b1');
    expect(p.billItem.update.mock.calls[0][0]).toMatchObject({ where: { id: 'i1' }, data: { hsnSacCode: '999722' } });
    expect(finalUpdate()).toBeTruthy();
  });

  it('the registration fee takes its SAC from its own setting', async () => {
    (profile as any).registered = true;
    p.tenant.findFirst.mockImplementation(async () => ({ themeConfig: { gst: profile, registrationFee: { enabled: true, amount: 100, gstRatePercent: 18, sacCode: '999799' } } }));
    p.tenant.findUnique.mockImplementation(async () => ({ themeConfig: { gst: profile, registrationFee: { enabled: true, amount: 100, gstRatePercent: 18, sacCode: '999799' } } }));
    seed(bill([line({ hsnSacCode: null, category: 'registration', description: 'Registration Fee' })]));
    await finalizeBill(T, U, 'b1');
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ hsnSacCode: '999799' });
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { sacCode: '12' }).sacCode).toBeNull();
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { amount: 5 }).sacCode).toBeUndefined();
  });

  it('a bill created already payable stays unnumbered', async () => {
    const b = bill([line({ hsnSacCode: null })], { status: 'pending' });
    seed(b);
    expect(await issueDocumentForExistingBill(T, 'b1')).toBeNull();
    expect(p.gstDocumentSeries.upsert).not.toHaveBeenCalled();
  });

  it('collecting from an advance shows the reason, not "refresh the bill"', async () => {
    seed(bill([line({ hsnSacCode: null, description: 'Laser' })]));
    await expect(adjustAdvanceToBill(T, U, { patientId: 'pat', billId: 'b1', amount: 10 })).rejects.toMatchObject({
      code: 'SAC_REQUIRED', message: expect.stringContaining('Laser'),
    });
  });

  it('an OP department charge stays on a draft with the reason, instead of vanishing', async () => {
    const draft = bill([line({ hsnSacCode: null, description: 'Cosmetic face scan' })]);
    p.patient.findFirst.mockResolvedValue({ id: 'pat', mrn: 'M' });
    p.admission.findFirst.mockResolvedValue(null);
    p.bill.findFirst.mockResolvedValue(draft);
    p.bill.findUnique.mockResolvedValue({ tenantId: T, status: 'draft' });
    p.bill.create.mockResolvedValue({ id: 'b1', billNumber: 'BILL-1' });
    p.bill.update.mockImplementation(async (a: any) => ({ ...draft, ...a.data }));
    p.billItem.findFirst.mockResolvedValue(null);
    p.billItem.count.mockImplementation(async (a: any) => (a?.where?.requiresTaxResolution ? 0 : 1));
    const out = await billDiagnosticOrder(T, U, {
      source: 'imaging', patientId: 'pat',
      charges: [{ referenceType: 'imaging_request', referenceId: 'r1', description: 'Cosmetic face scan', unitPrice: 1000, isCosmetic: true, gstTreatment: 'taxable', gstApproved: true, taxRate: 18 }],
    });
    expect(out).toMatchObject({ billId: 'b1', billStatus: 'draft' });
    expect(out!.issueBlockedReason).toMatch(/Cosmetic face scan.*no SAC code.*draft bill BILL-1/s);
    // A scan that is not diagnostic never borrows the diagnostic code.
    expect(p.billItem.create.mock.calls[0][0].data.hsnSacCode).toBeNull();
  });

  it('an OP surgery is refused before a bill exists, so it can be posted again', async () => {
    p.otRequest.findFirst.mockResolvedValue({
      id: 'ot1', patientId: 'pat', visitId: null, procedureName: 'Rhinoplasty (cosmetic)', surgeon: null, doctor: null,
      serviceTariff: { id: 't1', sacCode: null, gstTreatment: 'taxable', gstRatePercent: 18, isCosmetic: true, gstApproved: true },
    });
    p.billItem.findFirst.mockResolvedValue(null);
    p.admission.findFirst.mockResolvedValue(null);
    await expect(billOtRequest(T, 'ot1', U)).rejects.toMatchObject({ code: 'SAC_REQUIRED', message: expect.stringContaining('Rhinoplasty') });
    expect(p.bill.create).not.toHaveBeenCalled();
    expect(p.billItem.create).not.toHaveBeenCalled();
  });

  it('a bedside charge is refused on a stay bill that is already issued, allowed on its draft', async () => {
    p.admission.findFirst.mockResolvedValue({ id: 'adm', patientId: 'pat', status: 'admitted', doctorId: null });
    p.admission.findUnique.mockResolvedValue({ id: 'adm', patientId: 'pat', status: 'admitted' });
    p.serviceTariff.findFirst.mockResolvedValue({ id: 't1', category: 'procedure', serviceName: 'Laser', sacCode: null, gstTreatment: 'taxable', gstRatePercent: 18, gstApproved: true, isCosmetic: false });
    p.bill.findFirst.mockResolvedValue(bill([], { status: 'pending', invoiceNumber: 'INV/1', admissionId: 'adm' }));
    p.bill.findUnique.mockResolvedValue({ tenantId: T, status: 'pending' });
    const charge = { category: 'procedure', description: 'Laser', unitPrice: 1000, serviceTariffId: 't1' };
    await expect(addIpCharge(T, U, 'adm', charge, ['billing_admin'])).rejects.toMatchObject({ code: 'SAC_REQUIRED' });
    expect(p.billItem.create).not.toHaveBeenCalled();

    p.bill.findFirst.mockResolvedValue(bill([], { admissionId: 'adm' }));
    await addIpCharge(T, U, 'adm', charge, ['billing_admin']);
    expect(p.billItem.create).toHaveBeenCalled();
  });

  it('Generate Bill on an issued stay bill takes back the charges it pulled when it is refused', async () => {
    const issued = bill([], { status: 'pending', invoiceNumber: 'INV/1', admissionId: 'adm' });
    p.patient.findFirst.mockResolvedValue({ id: 'pat', mrn: 'M' });
    p.admission.findFirst.mockResolvedValue({ id: 'adm', patientId: 'pat', status: 'admitted', admissionDate: new Date() });
    let current: any = { ...issued };
    p.bill.findFirst.mockImplementation(async (a: any) => {
      if (a?.where?.status === 'draft' && !a?.where?.id) return null; // no live draft
      return { ...current, billItems: [line({ id: 'pulled-1', hsnSacCode: null, description: 'Laser OT' })] };
    });
    p.bill.findUnique.mockImplementation(async () => ({ tenantId: T, status: current.status }));
    p.bill.update.mockImplementation(async (a: any) => { current = { ...current, ...a.data }; return current; });
    p.insuranceClaim.count.mockResolvedValue(0);
    p.otRequest.findMany.mockResolvedValue([
      { id: 'ot1', patientId: 'pat', status: 'completed', procedureName: 'Laser OT', surgeon: null, doctor: null, createdAt: new Date(), scheduledDate: null,
        serviceTariff: { id: 't1', sacCode: null, gstTreatment: 'taxable', gstRatePercent: 18, isCosmetic: true, gstApproved: true } },
    ]);
    p.billItem.findFirst.mockResolvedValue(null);
    p.billItem.create.mockResolvedValue({ id: 'pulled-1' });
    p.billItem.count.mockImplementation(async (a: any) => (a?.where?.requiresTaxResolution ? 0 : 1));
    await expect(consolidateAdmissionBill(T, U, 'adm', { finalize: true })).rejects.toMatchObject({ code: 'SAC_REQUIRED' });
    expect(p.billItem.deleteMany).toHaveBeenCalledWith({ where: { billId: 'b1', id: { in: ['pulled-1'] } } });
    // Back to issued and payable, as it was found.
    expect(current.status).toBe('pending');
  });
});

describe('#264: the registration fee, where no draft exists to refuse', () => {
  const fee = (sacCode?: string) => ({ gst: profile, registrationFee: { enabled: true, amount: 100, gstRatePercent: 18, label: 'Registration Fee', ...(sacCode ? { sacCode } : {}) } });

  it('the portal is refused before a bill is made, in words a patient can act on', async () => {
    const { registrationFees } = await import('../../../../src/modules/patient-portal/patient-portal.service');
    const tenant = { id: T, slug: 'h', themeConfig: fee() };
    p.tenant.findUnique.mockResolvedValue(tenant);
    p.tenant.findFirst.mockResolvedValue(tenant);
    p.user.findUnique.mockResolvedValue({ id: U, email: 'p@x.in' });
    p.patient.findFirst.mockResolvedValue({ id: 'pat', mrn: 'M' });
    p.billItem.findFirst.mockResolvedValue(null);
    await expect(registrationFees(U, 'h')).rejects.toMatchObject({ code: 'SAC_REQUIRED', message: expect.stringMatching(/front desk/) });
    expect(p.bill.create).not.toHaveBeenCalled();
    expect(p.billItem.create).not.toHaveBeenCalled();
  });

  it('the front desk is refused before the appointment bill is made, and named the fee', async () => {
    const { frontdeskCheckout } = await import('../../../../src/modules/appointments/appointments.service');
    p.tenant.findUnique.mockResolvedValue({ themeConfig: fee() });
    p.tenant.findFirst.mockResolvedValue({ themeConfig: fee() });
    p.appointment.findFirst.mockResolvedValue({
      id: 'apt', tenantId: T, patientId: 'pat', doctorId: 'doc', status: 'booked', consultationType: null, createdAt: new Date(),
      appointmentDate: new Date('2026-11-20'), doctor: { id: 'doc', consultationFee: 500, freeFollowUpDays: null },
    });
    p.bill.findFirst.mockResolvedValue(null);
    p.billItem.findFirst.mockResolvedValue(null);
    p.patient.findFirst.mockResolvedValue({ id: 'pat', createdAt: new Date() });
    p.appointment.count.mockResolvedValue(0);
    p.visit.count.mockResolvedValue(0);
    p.admission.count.mockResolvedValue(0);
    await expect(frontdeskCheckout(T, 'apt', U, { collectNow: false } as any)).rejects.toMatchObject({
      code: 'SAC_REQUIRED', message: expect.stringContaining('Registration Fee'),
    });
    expect(p.bill.create).not.toHaveBeenCalled();
  });
});

// ── #265 ───────────────────────────────────────────────────────────────────

describe('#265: the place of supply is the hospital', () => {
  it('charges CGST + SGST to an out-of-state buyer', async () => {
    seed(bill([line()], { recipientGstin: MH_BUYER, placeOfSupplyStateCode: '27' })); // stamped by the old rule
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toMatchObject({ placeOfSupplyStateCode: '33', isInterState: false, supplierStateCode: '33' });
    expect(p.billItem.update).not.toHaveBeenCalled();
  });

  it('moves a draft line that was split as IGST back to CGST + SGST', async () => {
    seed(bill([line({ cgstAmount: 0, sgstAmount: 0, igstAmount: 180, cgstRate: 0, sgstRate: 0, igstRate: 18 })], { recipientGstin: MH_BUYER }));
    await finalizeBill(T, U, 'b1');
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ cgstAmount: 90, sgstAmount: 90, igstAmount: 0 });
  });

  it('goods shipped out of state are IGST, to a buyer with or without a GSTIN', async () => {
    seed(bill([line({ category: 'consumable', hsnSacCode: '9018' })], { supplyType: 'goods_shipped', supplyDestinationStateCode: '29' }));
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toMatchObject({ placeOfSupplyStateCode: '29', isInterState: true });
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ igstAmount: 180, cgstAmount: 0, sgstAmount: 0 });
  });

  it('refuses, unsplit, when a service performed here was added to a shipped-goods bill afterwards', async () => {
    seed(bill([line({ category: 'consumable', hsnSacCode: '9018' }), line({ id: 'i2', description: 'ECG', category: 'procedure' })], { supplyType: 'goods_shipped', supplyDestinationStateCode: '29' }));
    await expect(finalizeBill(T, U, 'b1')).rejects.toMatchObject({ code: 'SUPPLY_TYPE_CONFLICT', message: expect.stringContaining('ECG') });
    expect(p.billItem.update).not.toHaveBeenCalled();
    expect(p.bill.update).not.toHaveBeenCalled();
  });

  it('an off-site service needs its buyer to still be in the destination state', async () => {
    const off = { supplyType: 'off_site_service', supplyDestinationStateCode: '27' };
    seed(bill([line()], { ...off, recipientGstin: MH_BUYER }));
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toMatchObject({ placeOfSupplyStateCode: '27', isInterState: true });

    vi.clearAllMocks();
    seed(bill([line()], { ...off, recipientGstin: null }));
    await expect(finalizeBill(T, U, 'b1')).rejects.toMatchObject({ code: 'SUPPLY_TYPE_CONFLICT' });
  });

  it('a reopened bill that is already numbered keeps the split it was issued with', async () => {
    seed(bill([line({ cgstAmount: 0, sgstAmount: 0, igstAmount: 180, igstRate: 18 }), line({ id: 'i2' })], {
      invoiceNumber: 'INV/1', recipientGstin: MH_BUYER, placeOfSupplyStateCode: '27', isInterState: true, supplierStateCode: '33', supplierGstin: HOME,
    }));
    await finalizeBill(T, U, 'b1');
    expect(finalUpdate()).toMatchObject({ placeOfSupplyStateCode: '27', isInterState: true });
    // Only the line added since, still priced intra-state, follows the document.
    expect(p.billItem.update.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(['i2']);
  });
});

describe('#265: setting the exception on a draft', () => {
  const get = (over: Record<string, unknown> = {}) =>
    p.bill.findFirst.mockResolvedValue({
      id: 'b1', billNumber: 'BILL-1', status: 'draft', invoiceNumber: null, recipientGstin: null, admissionId: null,
      supplyType: 'performed_at_hospital', supplyDestinationStateCode: null, supplyTypeReason: null,
      billItems: [{ description: 'Implant', category: 'consumable', referenceType: null }], ...over,
    });
  beforeEach(() => {
    p.bill.update.mockImplementation(async (a: any) => ({ id: 'b1', ...a.data }));
  });

  it('saves it and audits it', async () => {
    get();
    await setBillSupplyType(T, U, 'b1', { supplyType: 'goods_shipped', destinationStateCode: '29', reason: 'Shipped to Bengaluru' });
    expect(p.bill.update.mock.calls[0][0].data).toMatchObject({ supplyType: 'goods_shipped', supplyDestinationStateCode: '29', placeOfSupplyStateCode: null });
    expect(p.auditLog.create.mock.calls[0][0].data.description).toMatch(/Goods shipped.*Karnataka.*Shipped to Bengaluru/);
  });

  it.each([
    ['no destination', { supplyType: 'goods_shipped', reason: 'abc' }, {}, /destination state/],
    ['no reason', { supplyType: 'goods_shipped', destinationStateCode: '29' }, {}, /reason/],
    ['an unknown type', { supplyType: 'export' }, {}, /Choose where/],
    ['off site without a buyer GSTIN', { supplyType: 'off_site_service', destinationStateCode: '27', reason: 'abc' }, { billItems: [] }, /buyer's GSTIN/],
    ['off site in a state the buyer is not registered in', { supplyType: 'off_site_service', destinationStateCode: '29', reason: 'abc' }, { recipientGstin: MH_BUYER, billItems: [] }, /Maharashtra/],
    ['an inpatient bill', { supplyType: 'goods_shipped', destinationStateCode: '29', reason: 'abc' }, { admissionId: 'adm' }, /inpatient/],
    ['shipped goods with a service on the bill', { supplyType: 'goods_shipped', destinationStateCode: '29', reason: 'abc' }, { billItems: [{ description: 'X-ray', category: 'radiology' }] }, /X-ray/],
    ['off site with a visit on the bill', { supplyType: 'off_site_service', destinationStateCode: '27', reason: 'abc' }, { recipientGstin: MH_BUYER, billItems: [{ description: 'Consultation', category: 'consultation', referenceType: 'visit' }] }, /Consultation/],
    ['an issued bill', { supplyType: 'goods_shipped', destinationStateCode: '29', reason: 'abc' }, { status: 'pending', invoiceNumber: 'INV/1' }, /draft/],
    ['a reopened issued bill', { supplyType: 'goods_shipped', destinationStateCode: '29', reason: 'abc' }, { status: 'draft', invoiceNumber: 'INV/1' }, /issued as INV\/1/],
  ])('refuses %s', async (_n, input, over, msg) => {
    get(over as any);
    await expect(setBillSupplyType(T, U, 'b1', input as any)).rejects.toThrow(msg as RegExp);
    expect(p.bill.update).not.toHaveBeenCalled();
  });

  it('adding a buyer never moves the place of supply', async () => {
    get();
    await setBillBuyer(T, U, 'b1', { gstin: MH_BUYER, legalName: 'Acme' });
    expect(p.bill.update.mock.calls[0][0].data).toMatchObject({ recipientGstin: MH_BUYER, placeOfSupplyStateCode: null });
  });

  it('the buyer cannot be taken off an off-site service', async () => {
    get({ supplyType: 'off_site_service', supplyDestinationStateCode: '27', recipientGstin: MH_BUYER });
    await expect(setBillBuyer(T, U, 'b1', { gstin: null })).rejects.toThrow(/off site/);
  });
});

// ── #358 on the bill ───────────────────────────────────────────────────────

describe('#358: a cosmetic scan cannot be released at 0%', () => {
  it('editing a held line keeps it held, unless a rate is actually given', async () => {
    p.bill.findFirst.mockResolvedValue(bill([]));
    p.bill.findUnique.mockResolvedValue({ tenantId: T, status: 'draft' });
    p.billItem.findFirst.mockResolvedValue(line({ category: 'radiology', taxPercent: 0, taxAmount: 0, hsnSacCode: null, requiresTaxResolution: true, rateSource: 'cosmetic', taxReason: 'Cosmetic' }));
    await updateBillItem(T, 'b1', 'i1', { quantity: 2 } as any);
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ requiresTaxResolution: true });
    await updateBillItem(T, 'b1', 'i1', { quantity: 2, taxRate: 18 } as any);
    expect(p.billItem.update.mock.calls.at(-1)[0].data.requiresTaxResolution).toBe(false);
  });

  it('refreshing the draft re-reads a manual line from its tariff, cosmetic flag included', async () => {
    const it1 = line({ category: 'radiology', serviceTariffId: 't1', taxPercent: 0, taxAmount: 0, hsnSacCode: null, requiresTaxResolution: true });
    p.bill.findFirst.mockResolvedValue(bill([it1]));
    p.bill.findUnique.mockResolvedValue({ tenantId: T, status: 'draft' });
    p.patient.findFirst.mockResolvedValue({ id: 'pat' });
    p.billItem.findMany.mockResolvedValue([it1]);
    const tariff = { id: 't1', category: 'radiology', serviceName: 'Keepsake scan', isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 18, sacCode: '999799', gstApproved: false };
    p.serviceTariff.findMany.mockResolvedValue([tariff]);
    await refreshDraftBillTax(T, 'b1');
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ requiresTaxResolution: true, taxPercent: 0 });

    p.billItem.update.mockClear();
    p.serviceTariff.findMany.mockResolvedValue([{ ...tariff, gstApproved: true }]);
    await refreshDraftBillTax(T, 'b1');
    expect(p.billItem.update.mock.calls[0][0].data).toMatchObject({ requiresTaxResolution: false, taxPercent: 18, hsnSacCode: '999799', gstTreatment: 'taxable' });
  });
});
