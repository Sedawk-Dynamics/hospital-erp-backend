import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getDailyCollection,
  getRevenueMix,
  getUnmappedItems,
  getSeriesContinuity,
  getDepartmentGst,
  getCancelledInvoices,
  getRateOverrides,
  getRateChangeImpact,
} from '../../../../src/modules/gst/gst-reports.control';

const TENANT = 'tenant-1';

function billWith(items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'bill-1', billNumber: 'BILL-1', invoiceNumber: 'INV/2026-27/000001',
    gstDocumentType: 'invoice_cum_bill_of_supply',
    billDate: new Date('2026-09-03T00:00:00Z'), status: 'paid',
    financialYear: '2026-27', admissionId: null, recipientGstin: null,
    placeOfSupplyStateCode: '27', isInterState: false,
    patient: { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    billItems: items.map((o, i) => ({
      id: `it-${i}`, description: 'Charge', category: 'other', quantity: 1,
      unitPrice: 100, discountAmount: 0, taxPercent: 0, taxableValue: 100,
      taxAmount: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0,
      totalAmount: 100, hsnSacCode: '999311', gstTreatment: 'exempt',
      rateSource: 'sac_master', requiresTaxResolution: false,
      createdAt: new Date('2026-09-03T00:00:00Z'), ...o,
    })),
    ...over,
  };
}

const TAXED = {
  category: 'room', unitPrice: 8000, taxPercent: 5, taxableValue: 8000,
  taxAmount: 400, cgstAmount: 200, sgstAmount: 200, totalAmount: 8400,
  hsnSacCode: '996311', gstTreatment: 'taxable',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDailyCollection (C-1)', () => {
  // A bill raised in March can be paid in April, so this is keyed on the
  // PAYMENT — it is the cash desk's question, not the return's.
  it('apportions the bill tax to a part payment by its share', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([
      {
        id: 'pay-1', paymentDate: new Date('2026-09-04T10:00:00Z'), amount: 4200,
        paymentMethod: 'cash', paymentType: 'regular', paymentSource: 'frontdesk',
        processor: { firstName: 'Front', lastName: 'Desk' },
        bill: { id: 'b1', billNumber: 'BILL-1', totalAmount: 8400, taxAmount: 400 },
      },
    ]);
    const r = await getDailyCollection(TENANT);
    expect(r.rows[0]).toMatchObject({ amount: 4200, taxCollected: 200, cashier: 'Front Desk' });
    expect(r.totals.collected).toBe(4200);
  });

  it('carries a refund back out again, tax and all', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([
      {
        id: 'pay-2', paymentDate: new Date('2026-09-05T10:00:00Z'), amount: 8400,
        paymentMethod: 'cash', paymentType: 'refund', paymentSource: 'frontdesk',
        processor: null,
        bill: { id: 'b1', billNumber: 'BILL-1', totalAmount: 8400, taxAmount: 400 },
      },
    ]);
    const r = await getDailyCollection(TENANT);
    expect(r.rows[0].amount).toBe(-8400);
    expect(r.rows[0].taxCollected).toBe(-400);
  });

  it('cuts the day by mode, counter and cashier', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([
      { id: 'a', paymentDate: new Date('2026-09-04T09:00:00Z'), amount: 100, paymentMethod: 'cash', paymentType: 'regular', paymentSource: 'frontdesk', processor: { firstName: 'A', lastName: null }, bill: null },
      { id: 'b', paymentDate: new Date('2026-09-04T11:00:00Z'), amount: 200, paymentMethod: 'upi', paymentType: 'regular', paymentSource: 'pharmacy', processor: { firstName: 'B', lastName: null }, bill: null },
    ]);
    const r = await getDailyCollection(TENANT);
    expect(r.byDay).toEqual([{ day: '2026-09-04', collected: 300, taxCollected: 0, count: 2 }]);
    expect(r.byMethod.map((m) => m.method).sort()).toEqual(['cash', 'upi']);
    expect(r.byCounter.map((c) => c.counter).sort()).toEqual(['frontdesk', 'pharmacy']);
    // A cashier with no surname must not appear as "A null".
    expect(r.byCashier.map((c) => c.cashier).sort()).toEqual(['A', 'B']);
  });
});

describe('getRevenueMix (C-2)', () => {
  it('trends the taxable share by month', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([TAXED, {}]),
      billWith([TAXED], { id: 'b2', billDate: new Date('2026-10-03T00:00:00Z') }),
    ]);
    const r = await getRevenueMix(TENANT);
    expect(r.byMonth.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(r.byMonth[0]).toMatchObject({ taxable: 8000, exempt: 100 });
    expect(r.byMonth[1].taxableSharePercent).toBe(100);
  });

  it('keeps an unclassified line out of both shares', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([billWith([TAXED, { gstTreatment: null }])]);
    const r = await getRevenueMix(TENANT);
    expect(r.byMonth[0]).toMatchObject({ taxable: 8000, exempt: 0, unclassified: 100 });
  });
});

describe('getUnmappedItems (C-3)', () => {
  it('keeps the three kinds of exception apart', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([
        TAXED,
        { gstTreatment: null, hsnSacCode: null, description: 'Nothing decided' },
        { gstTreatment: 'exempt', hsnSacCode: null, description: 'No code' },
        { gstTreatment: 'taxable', taxPercent: 18, hsnSacCode: null, requiresTaxResolution: true, rateSource: 'item_master', description: 'Typed at the counter' },
      ]),
    ]);
    const r = await getUnmappedItems(TENANT);
    expect(r.withoutTreatment.totals.count).toBe(1);
    // The typed-rate line has no code either, so it appears in both — they are
    // different problems fixed in different places.
    expect(r.withoutCode.items.map((i) => i.description).sort()).toEqual([
      'No code', 'Typed at the counter',
    ]);
    expect(r.typedRate.totals.count).toBe(1);
    expect(r.typedRate.lines[0]).toMatchObject({ ratePercent: 18, rateSource: 'item_master' });
  });

  it('rolls repeated lines up by item, with what they were rated at', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([
        { gstTreatment: null, description: 'Dressing', totalAmount: 100 },
        { gstTreatment: null, description: 'Dressing', totalAmount: 150, taxPercent: 5 },
      ]),
    ]);
    const r = await getUnmappedItems(TENANT);
    expect(r.withoutTreatment.items).toHaveLength(1);
    expect(r.withoutTreatment.items[0]).toMatchObject({ lines: 2, value: 250, rates: [0, 5] });
  });

  it('says nothing is wrong when everything is classified', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([billWith([TAXED])]);
    const r = await getUnmappedItems(TENANT);
    expect(r.totals.exceptions).toBe(0);
    expect(r.totals.linesChecked).toBe(1);
  });
});

describe('getSeriesContinuity (C-4)', () => {
  const series = (over: Record<string, unknown> = {}) => ({
    documentType: 'tax_invoice', financialYear: '2026-27', prefix: 'TI', lastNumber: 3, ...over,
  });
  const bill = (num: string, over: Record<string, unknown> = {}) => ({
    invoiceNumber: num, gstDocumentType: 'tax_invoice', financialYear: '2026-27',
    status: 'paid', billDate: new Date('2026-09-03T00:00:00Z'), cancellationReason: null, ...over,
  });

  function seed(seriesRows: unknown[], bills: unknown[], notes: unknown[] = []) {
    (prisma.gstDocumentSeries.findMany as any).mockResolvedValue(seriesRows);
    (prisma.bill.findMany as any).mockResolvedValue(bills);
    (prisma.creditNote.findMany as any).mockResolvedValue(notes);
  }

  it('reports a continuous series as continuous', async () => {
    seed([series()], [bill('TI/2026-27/000001'), bill('TI/2026-27/000002'), bill('TI/2026-27/000003')]);
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0]).toMatchObject({ firstIssued: 1, lastIssued: 3, issuedCount: 3, continuous: true, burned: 0 });
    expect(r.totals.withGaps).toBe(0);
  });

  // A hole is not proof of anything wrong, but it is always a question — and
  // the hospital should be the one holding the answer.
  it('names every missing number', async () => {
    seed([series({ lastNumber: 4 })], [bill('TI/2026-27/000001'), bill('TI/2026-27/000004')]);
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0].missing).toEqual([2, 3]);
    expect(r.series[0].continuous).toBe(false);
  });

  it('names a duplicated number too', async () => {
    seed([series({ lastNumber: 2 })], [bill('TI/2026-27/000001'), bill('TI/2026-27/000001'), bill('TI/2026-27/000002')]);
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0].duplicated).toEqual([1]);
    expect(r.totals.withDuplicates).toBe(1);
  });

  // The counter ran ahead of the last document: numbers were allotted inside a
  // transaction that rolled back. Explainable, but it has to be explained.
  it('counts the numbers the counter burned', async () => {
    seed([series({ lastNumber: 7 })], [bill('TI/2026-27/000001')]);
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0].burned).toBe(6);
  });

  // Cancelling an issued bill keeps its number and raises a credit note; that
  // is what keeps the series continuous, so it is listed, not treated as a gap.
  it('lists a cancelled invoice without calling it a gap', async () => {
    seed(
      [series({ lastNumber: 2 })],
      [bill('TI/2026-27/000001'), bill('TI/2026-27/000002', { status: 'cancelled', cancellationReason: 'Wrong patient' })],
    );
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0].continuous).toBe(true);
    expect(r.series[0].cancelled).toEqual([
      { number: 'TI/2026-27/000002', date: new Date('2026-09-03T00:00:00Z'), reason: 'Wrong patient' },
    ]);
  });

  it('checks the credit-note series as well as the invoice series', async () => {
    seed(
      [series({ documentType: 'credit_note', prefix: 'CN', lastNumber: 2 })],
      [],
      [
        { creditNoteNumber: 'CN/2026-27/000001', financialYear: '2026-27', issueDate: new Date() },
        { creditNoteNumber: 'CN/2026-27/000002', financialYear: '2026-27', issueDate: new Date() },
      ],
    );
    const r = await getSeriesContinuity(TENANT);
    expect(r.series[0]).toMatchObject({ documentType: 'credit_note', issuedCount: 2, continuous: true });
  });
});

describe('getDepartmentGst (C-7)', () => {
  it('splits each department into taxable and exempt turnover', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([TAXED, { category: 'pharmacy', totalAmount: 240, taxableValue: 240 }]),
    ]);
    const r = await getDepartmentGst(TENANT);
    expect(r.departments[0]).toMatchObject({ department: 'room', taxableTurnover: 8000, taxAmount: 400 });
    expect(r.departments[1]).toMatchObject({ department: 'pharmacy', exemptTurnover: 240, taxAmount: 0 });
  });
});

describe('getCancelledInvoices (C-9)', () => {
  const cancelled = (over: Record<string, unknown> = {}) => ({
    id: 'b1', billNumber: 'BILL-1', invoiceNumber: 'TI/2026-27/000002',
    gstDocumentType: 'tax_invoice', billDate: new Date('2026-09-03T00:00:00Z'),
    totalAmount: 8400, taxAmount: 400, cancellationReason: 'Wrong patient',
    updatedAt: new Date('2026-09-04T00:00:00Z'),
    canceller: { firstName: 'Front', lastName: 'Desk' },
    patient: { mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    creditNotes: [{ creditNoteNumber: 'CN/2026-27/000001', taxAmount: 400, totalAmount: 8400 }],
    ...over,
  });

  it('shows who cancelled an issued invoice and what reversed it', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([cancelled()]);
    const r = await getCancelledInvoices(TENANT);
    expect(r.rows[0]).toMatchObject({
      invoiceNumber: 'TI/2026-27/000002',
      cancelledBy: 'Front Desk',
      reason: 'Wrong patient',
      unreversed: false,
    });
    expect(r.rows[0].creditNotes[0].creditNoteNumber).toBe('CN/2026-27/000001');
  });

  // The exception worth finding: the money came off, the tax did not, and the
  // return still declares it.
  it('flags an issued invoice cancelled with no credit note behind it', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([cancelled({ creditNotes: [] })]);
    const r = await getCancelledInvoices(TENANT);
    expect(r.rows[0].unreversed).toBe(true);
    expect(r.totals.unreversed).toBe(1);
  });

  it('does not flag a bill that was cancelled before it was ever issued', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([cancelled({ invoiceNumber: null, creditNotes: [] })]);
    const r = await getCancelledInvoices(TENANT);
    expect(r.rows[0].unreversed).toBe(false);
  });
});

describe('getRateOverrides (C-5)', () => {
  const typed = {
    description: 'Cosmetic touch-up', category: 'procedure',
    gstTreatment: 'taxable', taxPercent: 18, hsnSacCode: null,
    requiresTaxResolution: true, rateSource: 'item_master',
    taxableValue: 5000, taxAmount: 900, totalAmount: 5900,
  };

  it('lists only the lines where a rate was typed', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([TAXED, typed], { generator: { firstName: 'Front', lastName: 'Desk' } }),
    ]);
    const r = await getRateOverrides(TENANT);
    expect(r.totals.linesChecked).toBe(2);
    expect(r.totals.overrides).toBe(1);
    expect(r.rows[0]).toMatchObject({
      description: 'Cosmetic touch-up',
      ratePercent: 18,
      taxAmount: 900,
      rateSource: 'item_master',
      raisedBy: 'Front Desk',
    });
  });

  it('groups by who raised the document, and totals the tax they charged', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      billWith([typed, typed], { generator: { firstName: 'Front', lastName: 'Desk' } }),
    ]);
    const r = await getRateOverrides(TENANT);
    expect(r.byPerson).toEqual([{ person: 'Front Desk', lines: 2, taxCharged: 1800, value: 11800 }]);
  });

  // "Raised by" is the bill's author, not provably the person who typed the
  // rate — the report has to say so rather than imply a precision it lacks.
  it('says what "raised by" actually means, and that no reason is recorded', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([billWith([typed])]);
    const r = await getRateOverrides(TENANT);
    expect(r.notes.join(' ')).toMatch(/not provably the person who typed the rate/);
    expect(r.notes.join(' ')).toMatch(/No reason is recorded/);
    // The gate means a new one cannot get through, so everything here is old.
    expect(r.notes.join(' ')).toMatch(/What appears here is legacy/);
  });

  it('attributes a line to nobody rather than guessing when the bill has no author', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([billWith([typed], { generator: null })]);
    const r = await getRateOverrides(TENANT);
    expect(r.rows[0].raisedBy).toBeNull();
    expect(r.byPerson[0].person).toBe('unattributed');
  });

  it('reports nothing when every rate came from a master', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([billWith([TAXED])]);
    const r = await getRateOverrides(TENANT);
    expect(r.totals.overrides).toBe(0);
    expect(r.byPerson).toEqual([]);
  });
});

describe('getRateChangeImpact (C-8)', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    id: 'rc1',
    changedAt: new Date('2026-09-10T00:00:00Z'),
    codeType: 'hsn',
    code: '3004',
    description: 'Medicaments',
    action: 'update',
    previousRate: 12,
    newRate: 5,
    previousTreatment: 'taxable',
    newTreatment: 'taxable',
    changer: { firstName: 'Super', lastName: 'Admin' },
    ...over,
  });

  const line = (createdAt: string, taxPercent: number) => ({
    hsnSacCode: '3004',
    taxPercent,
    taxAmount: 100,
    totalAmount: 1100,
    description: 'Paracetamol',
    createdAt: new Date(createdAt),
    bill: { billNumber: 'BILL-1', invoiceNumber: 'INV/1', billDate: new Date(createdAt) },
  });

  function seed(changes: unknown[], lines: unknown[] = []) {
    (prisma.gstRateChange.findMany as any).mockResolvedValue(changes);
    (prisma.billItem.findMany as any).mockResolvedValue(lines);
  }

  it('splits the affected lines at the moment of the change', async () => {
    seed([change()], [line('2026-09-05T00:00:00Z', 12), line('2026-09-15T00:00:00Z', 5)]);
    const r = await getRateChangeImpact(TENANT);
    expect(r.changes[0]).toMatchObject({
      code: '3004', previousRate: 12, newRate: 5, changedBy: 'Super Admin',
    });
    expect(r.changes[0].linesBefore.count).toBe(1);
    expect(r.changes[0].linesAfter.count).toBe(1);
  });

  // A line billed before the change keeps the rate that applied on the day —
  // freezing the tax onto the line is the whole point — so it is NOT out of step.
  it('does not call a line billed before the change out of step', async () => {
    seed([change()], [line('2026-09-05T00:00:00Z', 12)]);
    const r = await getRateChangeImpact(TENANT);
    expect(r.changes[0].outOfStep).toEqual([]);
    expect(r.totals.outOfStep).toBe(0);
  });

  // Billed AFTER the change and still carrying the old rate: the masters and
  // the bills have parted company, and that is the finding.
  it('flags a line billed after the change that still carries the old rate', async () => {
    seed([change()], [line('2026-09-15T00:00:00Z', 12)]);
    const r = await getRateChangeImpact(TENANT);
    expect(r.changes[0].outOfStep).toHaveLength(1);
    expect(r.changes[0].outOfStep[0]).toMatchObject({ ratePercent: 12, billNumber: 'INV/1' });
    expect(r.totals.outOfStep).toBe(1);
  });

  it('says so plainly when nothing changed, rather than showing an empty table', async () => {
    seed([]);
    const r = await getRateChangeImpact(TENANT);
    expect(r.changes).toEqual([]);
    expect(r.notes[0]).toMatch(/Nothing on a tax master changed/);
    // Never queries the bill lines when there is no change to attribute to them.
    expect(prisma.billItem.findMany).not.toHaveBeenCalled();
  });

  it('records a deactivation as a change too', async () => {
    seed([change({ action: 'deactivate', newRate: null, newTreatment: null })]);
    const r = await getRateChangeImpact(TENANT);
    expect(r.changes[0]).toMatchObject({ action: 'deactivate', newRate: null });
    // No new rate means nothing to compare a later line against.
    expect(r.changes[0].outOfStep).toEqual([]);
  });
});
