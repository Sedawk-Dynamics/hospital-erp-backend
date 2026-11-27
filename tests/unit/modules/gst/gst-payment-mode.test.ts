import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getDailyCollection, getDailyGstLiability } from '../../../../src/modules/gst/gst-reports.control';
import { getGstr1Summary } from '../../../../src/modules/gst/gst-reports.returns';
import { buildGstr1Json } from '../../../../src/modules/gst/gst-reports.gstr1-json';

// #280: GST by payment mode, against GSTR-1, for every tender the counter takes —
// and a cancelled invoice read the same way by both.

const T = 'tenant-1';
const p = prisma as any;
const HOME = '33AAACS2601K1ZR';
const PERIOD = { from: '2026-11-01', to: '2026-11-30' };

interface Sale { id: string; taxable: number; tax: number; status?: string; tenders: Array<[method: string, amount: number, status?: string, type?: string]>; noteId?: string; voided?: boolean }

// CGST and SGST in whole paise, odd paisa to CGST — as a bill line stores them.
const half = (t: number) => Math.ceil(Math.round(t * 100) / 2) / 100;
const rest = (t: number) => Math.round((t - half(t)) * 100) / 100;

/** One set of facts, served to both reports the way the database would. */
function seed(sales: Sale[]) {
  const total = (s: Sale) => Math.round((s.taxable + s.tax) * 100) / 100;
  const bills = sales.map((s) => ({
    id: s.id, billNumber: s.id, invoiceNumber: `INV/${s.id}`, gstDocumentType: 'tax_invoice', billDate: new Date('2026-11-10T06:00:00Z'),
    status: s.status ?? 'paid', financialYear: '2026-27', admissionId: null, encounterType: 'op', recipientGstin: null,
    placeOfSupplyStateCode: '33', isInterState: false, supplierStateCode: '33', patient: null, generator: null,
    // A voided counter sale loses its lines and its header figures.
    billItems: s.voided ? [] : [{
      id: `i-${s.id}`, description: 'Medicine', category: 'pharmacy', quantity: 1, unitPrice: s.taxable, discountAmount: 0, taxPercent: 5,
      taxableValue: s.taxable, taxAmount: s.tax, cgstAmount: half(s.tax), sgstAmount: rest(s.tax), igstAmount: 0, cessAmount: 0, totalAmount: total(s),
      hsnSacCode: '3004', gstTreatment: 'taxable', rateSource: 'hsn_master', requiresTaxResolution: false,
    }],
  }));
  const payments = sales.flatMap((s) => s.tenders.map(([method, amount, status, type], i) => ({
    id: `${s.id}-${i}`, paymentDate: new Date('2026-11-10T07:00:00Z'), amount, paymentMethod: method, paymentType: type ?? 'regular', status: status ?? 'completed',
    paymentSource: 'pharmacy', transactionId: null, notes: null, voucherNumber: null, sourceAdvancePaymentId: null, processor: null,
    bill: { id: s.id, billNumber: s.id, totalAmount: s.voided ? 0 : total(s), taxAmount: s.voided ? 0 : s.tax },
  })));
  const notes = sales.filter((s) => s.noteId).map((s) => ({
    id: s.noteId, creditNoteNumber: `CN/${s.id}`, noteType: 'credit', issueDate: new Date('2026-11-11T06:00:00Z'), financialYear: '2026-27', reason: 'cancellation',
    reasonNote: null, patientId: null, patient: null, issuer: null, recipientGstin: null, placeOfSupplyStateCode: '33', withinTimeLimit: true,
    taxableValue: -s.taxable, cgstAmount: -half(s.tax), sgstAmount: -rest(s.tax), igstAmount: 0, cessAmount: 0, taxAmount: -s.tax, totalAmount: -total(s),
    items: [{ description: 'Medicine', hsnSacCode: '3004', gstTreatment: 'taxable', quantity: -1, taxPercent: 5, taxableValue: -s.taxable, cgstAmount: -half(s.tax), sgstAmount: -rest(s.tax), igstAmount: 0, cessAmount: 0, taxAmount: -s.tax, totalAmount: -total(s), billItem: null }],
    bill: { billNumber: s.id, invoiceNumber: `INV/${s.id}`, gstDocumentType: 'tax_invoice', billDate: new Date('2026-11-10T06:00:00Z'), status: s.status, _count: { billItems: s.voided ? 0 : 1 } },
  }));
  p.bill.findMany.mockImplementation(async (a: any) => (a?.where?.recipientGstin?.not === null ? [] : bills));
  p.creditNote.findMany.mockResolvedValue(notes);
  // The payment query asks for completed rows; a reversed one is not returned.
  p.payment.findMany.mockImplementation(async (a: any) =>
    payments.filter((x) => (a?.where?.status ? x.status === a.where.status : true) && (a?.where?.paymentType ? x.paymentType === a.where.paymentType : true)));
  p.tenant.findFirst.mockResolvedValue({ themeConfig: { gst: { registered: true, gstin: HOME, stateCode: '33' } } });
}
const byMode = async () => Object.fromEntries((await getDailyCollection(T, PERIOD)).byMode.map((m) => [m.mode, m]));
const gstr1Tax = async () => {
  const s = await getGstr1Summary(T, PERIOD);
  return Math.round((s.tables.b2c.taxAmount + s.tables.b2b.taxAmount + s.tables.creditNotes.taxAmount) * 100) / 100;
};

beforeEach(() => vi.clearAllMocks());

describe('GST by payment mode (#280)', () => {
  it.each([
    ['cash', 'cash'], ['credit_card', 'card'], ['debit_card', 'card'], ['upi', 'upi'], ['net_banking', 'net_banking'], ['bank_transfer', 'net_banking'],
  ])('a bill paid by %s carries its whole tax under %s', async (method, mode) => {
    seed([{ id: 'a', taxable: 1000, tax: 50, tenders: [[method, 1050]] }]);
    const m = await byMode();
    expect(m[mode]).toMatchObject({ collected: 1050, taxCollected: 50, count: 1 });
    for (const other of Object.keys(m).filter((k) => k !== mode)) expect(m[other]).toMatchObject({ collected: 0, taxCollected: 0 });
    expect(await gstr1Tax()).toBe(50);
  });

  it('a split tender divides the tax by amount and adds up to the bill', async () => {
    seed([{ id: 'a', taxable: 1000, tax: 50, tenders: [['cash', 420], ['upi', 315], ['credit_card', 210], ['net_banking', 105]] }]);
    const m = await byMode();
    expect([m.cash, m.upi, m.card, m.net_banking].map((x) => x!.taxCollected)).toEqual([20, 15, 10, 5]);
    expect(await gstr1Tax()).toBe(50);
  });

  it('an uneven split loses no paisa to rounding', async () => {
    // 10.00 of tax over three equal tenders: 3.33 + 3.33 + 3.34, not 9.99.
    seed([{ id: 'a', taxable: 200, tax: 10, tenders: [['cash', 70], ['upi', 70], ['debit_card', 70]] }]);
    const m = await byMode();
    expect([m.cash, m.upi, m.card].map((x) => x!.taxCollected)).toEqual([3.33, 3.33, 3.34]);
    expect((await getDailyCollection(T, PERIOD)).totals.taxCollected).toBe(10);
  });

  it('a day of every tender ties to GSTR-1, to the file and to the liability report', async () => {
    seed([
      { id: 'a', taxable: 1000, tax: 50, tenders: [['cash', 1050]] },
      { id: 'b', taxable: 2000, tax: 100, tenders: [['credit_card', 2100]] },
      { id: 'c', taxable: 500, tax: 25, tenders: [['upi', 525]] },
      { id: 'd', taxable: 300, tax: 15, tenders: [['net_banking', 315]] },
      { id: 'e', taxable: 333.33, tax: 16.67, tenders: [['cash', 100], ['upi', 125], ['debit_card', 125]] },
    ]);
    const c = await getDailyCollection(T, PERIOD);
    expect(c.totals.taxCollected).toBe(206.67);
    expect(Math.round(c.byMode.reduce((t, m) => t + m.taxCollected, 0) * 100) / 100).toBe(206.67);
    expect(await gstr1Tax()).toBe(206.67);
    expect((await getDailyGstLiability(T, PERIOD)).liability.net.taxAmount).toBe(206.67);
    const b2cs = (await buildGstr1Json(T, PERIOD)).json.b2cs as any[];
    expect(Math.round(b2cs.reduce((t, r) => t + r.camt + r.samt, 0) * 100) / 100).toBe(206.67);
  });

  it('a part payment carries its part; the rest is liability, not collection', async () => {
    seed([{ id: 'a', taxable: 1000, tax: 50, status: 'partially_paid', tenders: [['cash', 420]] }]);
    expect((await byMode()).cash).toMatchObject({ taxCollected: 20 });
    expect(await gstr1Tax()).toBe(50);
  });
});

describe('a cancelled invoice (#280)', () => {
  const kept: Sale = { id: 'keep', taxable: 1000, tax: 50, tenders: [['cash', 1050]] };

  it('cancelled after its payment was reversed: nothing in either', async () => {
    seed([kept, { id: 'x', taxable: 2000, tax: 100, status: 'cancelled', noteId: 'n', tenders: [['upi', 2100, 'reversed']] }]);
    expect((await byMode()).upi).toMatchObject({ collected: 0, taxCollected: 0 });
    expect((await getDailyCollection(T, PERIOD)).totals.taxCollected).toBe(50);
    expect(await gstr1Tax()).toBe(50);
    expect((await getDailyGstLiability(T, PERIOD)).liability.net.taxAmount).toBe(50);
  });

  it('a voided counter sale (lines deleted): nothing in either, and not taken off twice', async () => {
    seed([kept, { id: 'x', taxable: 2000, tax: 100, status: 'cancelled', noteId: 'n', voided: true, tenders: [['cash', 2100, 'reversed']] }]);
    expect((await getDailyCollection(T, PERIOD)).totals.taxCollected).toBe(50);
    expect(await gstr1Tax()).toBe(50);
    expect((await buildGstr1Json(T, PERIOD)).json.cdnur).toBeUndefined();
  });

  it.each(['cash', 'credit_card', 'upi', 'net_banking'])('refunded in %s: the refund takes back exactly the tax that came in', async (method) => {
    seed([kept, { id: 'x', taxable: 2000, tax: 100, status: 'refunded', noteId: 'n', tenders: [[method, 2100], [method, 2100, 'completed', 'refund']] }]);
    const c = await getDailyCollection(T, PERIOD);
    expect(c.totals).toMatchObject({ collected: 1050, taxCollected: 50 });
    expect(await gstr1Tax()).toBe(50);
  });

  it('a split tender refunded through several modes nets to zero too', async () => {
    seed([{ id: 'x', taxable: 200, tax: 10, status: 'refunded', noteId: 'n', tenders: [['cash', 70], ['upi', 70], ['debit_card', 70], ['cash', 100, 'completed', 'refund'], ['upi', 110, 'completed', 'refund']] }]);
    expect((await getDailyCollection(T, PERIOD)).totals).toMatchObject({ collected: 0, taxCollected: 0 });
    expect(await gstr1Tax()).toBe(0);
  });
});
