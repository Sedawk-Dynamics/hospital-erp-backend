import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getB2bRegister, getB2cSummary, getSalesRegister } from '../../../../src/modules/gst/gst-reports.sales';
import { buildGstr1Json } from '../../../../src/modules/gst/gst-reports.gstr1-json';
import { getGstr3bSummary } from '../../../../src/modules/gst/gst-reports.returns';
import { buildIrnPayload, buildNoteIrnPayload } from '../../../../src/modules/gst/gst-einvoice.service';
import { buildGstBlock, gstIdentityFields } from '../../../../src/modules/billing/billing.gst-layout';
import { getMissingSacReport } from '../../../../src/modules/gst/gst-reports.missing-sac';

// #265: the register, GSTR-1 (screen and file), GSTR-3B, the e-invoice and the
// printed bill all read one place of supply — the hospital's, unless the bill
// itself carries an exception.

const T = 'tenant-1';
const p = prisma as any;
const HOME = '33AAACS2601K1ZR';
const MH = '27AAPFU0939F1ZV';
const PERIOD = { from: '2026-11-01', to: '2026-11-30' };
const SELLER = { gstin: HOME, legalName: 'Hospital', tradeName: null, address: '1 Road, Chennai 600001', city: 'Chennai', state: 'Tamil Nadu', phone: null, email: null };

const item = (over: Record<string, unknown> = {}) => ({
  id: `i-${Math.random()}`, description: 'Executive health check', category: 'other', quantity: 1, unitPrice: 1000, discountAmount: 0,
  taxPercent: 18, taxableValue: 1000, taxAmount: 180, cgstRate: 9, cgstAmount: 90, sgstRate: 9, sgstAmount: 90, igstRate: 0, igstAmount: 0,
  cessAmount: 0, totalAmount: 1180, hsnSacCode: '999312', gstTreatment: 'taxable', rateSource: 'item_master', requiresTaxResolution: false, ...over,
});
const igst = (over: Record<string, unknown> = {}) =>
  item({ category: 'consumable', hsnSacCode: '9018', cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0, igstRate: 18, igstAmount: 180, ...over });
const bill = (id: string, items: any[], over: Record<string, unknown> = {}) => ({
  id, billNumber: id, invoiceNumber: `INV/${id}`, gstDocumentType: 'tax_invoice', billDate: new Date('2026-11-10T06:00:00Z'), status: 'paid',
  financialYear: '2026-27', admissionId: null, encounterType: null, recipientGstin: null, recipientLegalName: 'Acme', recipientAddress: 'Pune 411001',
  placeOfSupplyStateCode: '33', isInterState: false, supplierGstin: HOME, supplierStateCode: '33', billOfSupplyNumber: null, roundOff: 0,
  patient: { id: 'pat', mrn: 'M', firstName: 'A', lastName: 'B' }, generator: null, billItems: items, ...over,
});
function seed(bills: any[], notes: any[] = []) {
  p.bill.findMany.mockImplementation(async (a: any) =>
    bills.filter((b) => {
      const g = a?.where?.recipientGstin;
      if (g === undefined) return true;
      return g === null ? !b.recipientGstin : !!b.recipientGstin;
    }),
  );
  p.creditNote.findMany.mockResolvedValue(notes);
  p.payment.findMany.mockResolvedValue([]);
  p.tenant.findFirst.mockResolvedValue({ themeConfig: { gst: { registered: true, gstin: HOME, stateCode: '33' } } });
}
const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1', creditNoteNumber: 'CN/1', noteType: 'credit', issueDate: new Date('2026-11-12T06:00:00Z'), financialYear: '2026-27', reason: 'cancellation',
  reasonNote: null, patientId: null, patient: null, issuer: null, recipientGstin: null, placeOfSupplyStateCode: '29', withinTimeLimit: true,
  supplierGstin: HOME, taxableValue: -1000, cgstAmount: 0, sgstAmount: 0, igstAmount: -180, cessAmount: 0, taxAmount: -180, totalAmount: -1180,
  items: [{ description: 'Implant', hsnSacCode: '9018', gstTreatment: 'taxable', quantity: -1, taxPercent: 18, taxableValue: -1000, cgstAmount: 0, sgstAmount: 0, igstAmount: -180, cessAmount: 0, taxAmount: -180, totalAmount: -1180, billItem: null }],
  bill: { id: 'ship', billNumber: 'ship', invoiceNumber: 'INV/ship', gstDocumentType: 'tax_invoice', billDate: new Date('2026-11-10T06:00:00Z'), status: 'cancelled', _count: { billItems: 1 },
    billOfSupplyNumber: null, recipientGstin: MH, recipientLegalName: 'Acme', recipientAddress: 'Pune 411001', supplierStateCode: '33', placeOfSupplyStateCode: '29', isInterState: true },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('a service to an out-of-state registered buyer', () => {
  const b2b = bill('svc', [item()], { recipientGstin: MH });

  it('is intra-state in the B2B register and the GSTR-1 file', async () => {
    seed([b2b]);
    const reg = await getB2bRegister(T, PERIOD);
    expect(reg.invoices[0]).toMatchObject({ recipientGstin: MH, placeOfSupplyStateCode: '33', isInterState: false, cgstAmount: 90, sgstAmount: 90, igstAmount: 0 });
    const inv = ((await buildGstr1Json(T, PERIOD)).json.b2b as any[])[0].inv[0];
    expect(inv.pos).toBe('33');
    expect(inv.itms[0].itm_det).toMatchObject({ camt: 90, samt: 90, iamt: 0 });
  });

  it('sends the e-invoice portal the hospital state and CGST + SGST', () => {
    const out: any = buildIrnPayload(b2b as any, SELLER);
    expect(out.payload.BuyerDtls).toMatchObject({ Gstin: MH, Stcd: '27', Pos: '33' });
    expect(out.payload.ItemList[0]).toMatchObject({ GstRt: 18, CgstAmt: 90, SgstAmt: 90, IgstAmt: 0 });
    expect(out.payload.ValDtls).toMatchObject({ CgstVal: 90, SgstVal: 90, IgstVal: 0 });
  });

  it('falls back to the hospital state, not the buyer state, when none is stamped', () => {
    const out: any = buildIrnPayload({ ...b2b, placeOfSupplyStateCode: null } as any, SELLER);
    expect(out.payload.BuyerDtls.Pos).toBe('33');
  });

  it('is refused in words when place of supply and tax disagree', () => {
    const out: any = buildIrnPayload({ ...b2b, placeOfSupplyStateCode: '27' } as any, SELLER);
    expect(out.problems.join()).toMatch(/place of supply \(state 27\) does not match the tax/);
  });

  it('prints the hospital state and the buyer, on the draft too', () => {
    const profile = { registered: true, gstin: HOME, stateCode: '33' } as any;
    const draft = buildGstBlock(profile, [{ recipientGstin: MH, placeOfSupplyStateCode: '27', supplyType: 'performed_at_hospital' } as any], []);
    expect(draft).toMatchObject({ placeOfSupplyStateCode: '33', supplyTypeLabel: null });
    const shipped = buildGstBlock(profile, [{ supplyType: 'goods_shipped', supplyDestinationStateCode: '29' } as any], []);
    expect(shipped).toMatchObject({ placeOfSupplyStateCode: '29', supplyTypeLabel: 'Goods shipped to another place' });
    const issued = buildGstBlock(profile, [b2b as any], []);
    expect(issued.placeOfSupplyStateName).toBe('Tamil Nadu');
    const lines = Object.fromEntries(gstIdentityFields(issued));
    expect(lines['GSTIN (Buyer)']).toBe(MH);
  });
});

describe('a bill issued before the rule changed', () => {
  it('keeps the split it was issued with, everywhere', async () => {
    const old = bill('old', [igst({ category: 'other', hsnSacCode: '999312' })], { recipientGstin: MH, placeOfSupplyStateCode: '27', isInterState: true });
    seed([old]);
    expect((await getB2bRegister(T, PERIOD)).invoices[0]).toMatchObject({ placeOfSupplyStateCode: '27', isInterState: true, igstAmount: 180 });
    expect(((await buildGstr1Json(T, PERIOD)).json.b2b as any[])[0].inv[0]).toMatchObject({ pos: '27' });
    const out: any = buildIrnPayload(old as any, SELLER);
    expect(out.payload.BuyerDtls.Pos).toBe('27');
    expect(out.payload.ItemList[0]).toMatchObject({ GstRt: 18, IgstAmt: 180, CgstAmt: 0 });
    expect(buildGstBlock({ registered: true, gstin: HOME, stateCode: '33' } as any, [old as any], [])).toMatchObject({ placeOfSupplyStateCode: '27', isInterState: true });
  });
});

describe('goods shipped out of the state to an unregistered buyer', () => {
  const ship = bill('ship', [igst()], { placeOfSupplyStateCode: '29', isInterState: true });
  const big = bill('big', [igst({ taxableValue: 250000, taxAmount: 45000, igstAmount: 45000, totalAmount: 295000 })], { placeOfSupplyStateCode: '29', isInterState: true });

  it('is B2C large above the threshold and small below it — screen and file alike', async () => {
    seed([ship, big]);
    const a5 = await getB2cSummary(T, PERIOD);
    expect(a5.largeInterState.map((r) => r.billId)).toEqual(['big']);
    const { json } = await buildGstr1Json(T, PERIOD);
    expect((json.b2cl as any[])[0]).toMatchObject({ pos: '29', inv: [{ inum: 'INV/big' }] });
    expect((json.b2cs as any[])[0]).toMatchObject({ sply_ty: 'INTER', pos: '29', iamt: 180, camt: 0, samt: 0 });
  });

  // #282: Rs 1 lakh from 1 Aug 2024. Rs 1.5 lakh used to stay in Table 7.
  it('an invoice of Rs 1.5 lakh is B2C large now, in the screen and the file', async () => {
    const mid = bill('mid', [igst({ taxableValue: 127118.64, taxAmount: 22881.36, igstAmount: 22881.36, totalAmount: 150000 })], { placeOfSupplyStateCode: '29', isInterState: true });
    seed([mid, ship]);
    const a5 = await getB2cSummary(T, PERIOD);
    expect(a5.largeInterState.map((r) => r.billId)).toEqual(['mid']);
    expect(a5.threshold).toBe(100000);
    expect(((await buildGstr1Json(T, PERIOD)).json.b2cl as any[])[0].inv[0].inum).toBe('INV/mid');
  });

  it('large is judged on the whole invoice, exempt lines included, in both', async () => {
    const mixed = bill('mixed', [
      igst({ taxableValue: 200000, taxAmount: 36000, igstAmount: 36000, totalAmount: 236000 }),
      igst({ gstTreatment: 'exempt', taxPercent: 0, taxableValue: 20000, taxAmount: 0, igstAmount: 0, totalAmount: 20000 }),
    ], { placeOfSupplyStateCode: '29', isInterState: true });
    seed([mixed]);
    expect((await getB2cSummary(T, PERIOD)).largeInterState.map((r) => r.billId)).toEqual(['mixed']);
    expect(((await buildGstr1Json(T, PERIOD)).json.b2cl as any[])[0].inv[0].inum).toBe('INV/mixed');
  });

  it('is in GSTR-3B 3.2 by place of supply, and a credit note takes it back out', async () => {
    seed([ship, bill('svc', [item()])]);
    expect((await getGstr3bSummary(T, PERIOD)).interStateUnregistered).toEqual([{ placeOfSupplyStateCode: '29', taxableValue: 1000, igstAmount: 180 }]);
    seed([ship], [note()]);
    const r = await getGstr3bSummary(T, PERIOD);
    expect(r.interStateUnregistered).toEqual([{ placeOfSupplyStateCode: '29', taxableValue: 0, igstAmount: 0 }]);
    expect(r.outwardTaxable.igstAmount).toBe(0);
  });

  it('a credit note follows the original document', async () => {
    seed([ship], [note()]);
    const { json } = await buildGstr1Json(T, PERIOD);
    expect((json.cdnur as any[])[0]).toMatchObject({ pos: '29', inum: 'INV/ship' });
    const out: any = buildNoteIrnPayload(note({ recipientGstin: MH }) as any, SELLER);
    expect(out.payload.BuyerDtls.Pos).toBe('29');
    expect(out.payload.ItemList[0]).toMatchObject({ IgstAmt: 180, CgstAmt: 0 });
  });
});

it('a counter sale with no place of supply stamped reads as the hospital state in every report', async () => {
  seed([bill('ph', [item({ category: 'pharmacy', hsnSacCode: '3004' })], { placeOfSupplyStateCode: null, supplierStateCode: null })]);
  expect((await getSalesRegister(T, PERIOD)).rows[0]).toMatchObject({ placeOfSupplyStateCode: '33', isInterState: false });
  expect((await getB2cSummary(T, PERIOD)).summary[0].placeOfSupplyStateCode).toBe('33');
  expect(((await buildGstr1Json(T, PERIOD)).json.b2cs as any[])[0]).toMatchObject({ sply_ty: 'INTRA', pos: '33' });
});

// ── #264: the report ───────────────────────────────────────────────────────

describe('C-10 Missing SAC codes', () => {
  const ln = (over: Record<string, unknown>, b: Record<string, unknown> = {}) => ({
    id: `x${Math.random()}`, description: 'Dressing', category: 'procedure', serviceTariffId: null, referenceType: null,
    taxPercent: 0, taxAmount: 0, taxableValue: 100, totalAmount: 100, gstTreatment: 'exempt', ...over,
    bill: { id: 'b1', billNumber: 'BILL-1', invoiceNumber: 'INV/1', billDate: new Date('2026-11-10T06:00:00Z'), status: 'paid', ...b },
  });
  const run = async (items: any[], tariffs: any[] = [], q: any = PERIOD) => {
    seed([]);
    p.billItem.findMany.mockResolvedValue(items);
    p.serviceTariff.findMany.mockResolvedValue(tariffs);
    return getMissingSacReport(T, q);
  };

  it('groups by service: warn at 0%, blocked with GST, with lines, value and last bill', async () => {
    const out = await run([
      ln({}), ln({ description: 'dressing ' }, { id: 'b2', billNumber: 'BILL-2', invoiceNumber: 'INV/2', billDate: new Date('2026-11-12T06:00:00Z') }),
      ln({ description: 'Botox', serviceTariffId: 't1', taxPercent: 18, taxAmount: 180, taxableValue: 1000, gstTreatment: 'taxable' }, { id: 'd1', billNumber: 'BILL-9', invoiceNumber: null, status: 'draft' }),
      ln({ description: 'Paracetamol', category: 'pharmacy' }),
      ln({ description: 'Draft dressing' }, { status: 'draft' }),
    ], [{ id: 't1', serviceName: 'Botox session', serviceCode: 'BTX', category: 'procedure', sacCode: null, isActive: true, gstTreatment: 'taxable', gstRatePercent: 18, isCosmetic: true }]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ service: 'Botox session', serviceCode: 'BTX', status: 'blocked', blockedDrafts: 1, issuedTaxedLines: 0, lines: 1, value: 1000, fix: 'gst_classification' });
    expect(out.rows[1]).toMatchObject({ service: 'Dressing', status: 'warn', lines: 2, value: 200, lastBillNumber: 'INV/2' });
    expect(out.summary).toMatchObject({ services: 2, warn: 1, blocked: 1, blockedDrafts: 1 });
  });

  it('lists a service with no SAC that has not been billed, and says where each is fixed', async () => {
    const out = await run([ln({ description: 'Registration Fee', category: 'registration', taxPercent: 18, taxAmount: 18, gstTreatment: 'taxable' })], [
      { id: 'a', serviceName: 'Laser', serviceCode: 'L', category: 'procedure', sacCode: null, isActive: true, gstTreatment: 'taxable', gstRatePercent: 18, isCosmetic: false },
      { id: 'b', serviceName: 'Keepsake', serviceCode: 'K', category: 'radiology', sacCode: null, isActive: true, gstTreatment: null, gstRatePercent: 0, isCosmetic: true },
      { id: 'c', serviceName: 'CT', serviceCode: 'C', category: 'radiology', sacCode: null, isActive: true, gstTreatment: null, gstRatePercent: 0, isCosmetic: false },
      { id: 'd', serviceName: 'Coded', serviceCode: 'D', category: 'procedure', sacCode: '999312', isActive: true, gstTreatment: 'exempt', gstRatePercent: 0, isCosmetic: false },
    ]);
    const by = Object.fromEntries(out.rows.map((r) => [r.service, r]));
    expect(Object.keys(by).sort()).toEqual(['Keepsake', 'Laser', 'Registration Fee']);
    expect(by['Registration Fee']).toMatchObject({ fix: 'registration_fee', status: 'blocked', issuedTaxedLines: 1 });
    expect(by.Keepsake).toMatchObject({ fix: 'radiology_settings', status: 'blocked', lines: 0 });
  });

  it('filters by status and uses IST days', async () => {
    const out = await run([ln({})], [], { ...PERIOD, status: 'blocked' });
    expect(out.rows).toEqual([]);
    const where = p.billItem.findMany.mock.calls[0][0].where;
    expect(where.bill.billDate.gte.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(where.bill.status).toEqual({ not: 'cancelled' });
  });
});
