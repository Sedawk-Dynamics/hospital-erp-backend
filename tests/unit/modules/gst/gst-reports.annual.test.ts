import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getGstr9Summary } from '../../../../src/modules/gst/gst-reports.annual';

const TENANT = 'tenant-1';

function billWith(items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'bill-1', billNumber: 'BILL-1', invoiceNumber: 'INV/2026-27/000001',
    gstDocumentType: 'invoice_cum_bill_of_supply',
    billDate: new Date('2026-09-03T00:00:00Z'), status: 'paid',
    financialYear: '2026-27', admissionId: null, recipientGstin: null,
    placeOfSupplyStateCode: '27', isInterState: false,
    patient: { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    generator: null,
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

const note = (over: Record<string, unknown> = {}) => ({
  id: 'cn-1', creditNoteNumber: 'CN/1', noteType: 'credit',
  issueDate: new Date('2026-10-10T00:00:00Z'), financialYear: '2026-27',
  reason: 'refund', reasonNote: null, patientId: 'p1', recipientGstin: null,
  placeOfSupplyStateCode: '27', taxableValue: -1000, cgstAmount: -25, sgstAmount: -25,
  igstAmount: 0, cessAmount: 0, taxAmount: -50, totalAmount: -1050, withinTimeLimit: true,
  items: [{ taxPercent: 5, taxableValue: -1000, cgstAmount: -25, sgstAmount: -25, igstAmount: 0,
    cessAmount: 0, taxAmount: -50, description: 'Returned', hsnSacCode: '9963', quantity: 1,
    gstTreatment: 'taxable', billItem: null }],
  bill: { billNumber: 'BILL-1', invoiceNumber: 'INV/1', gstDocumentType: 'tax_invoice',
    billDate: new Date('2026-09-03T00:00:00Z'), status: 'paid', _count: { billItems: 1 } },
  patient: null, issuer: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.payment.findMany as any).mockResolvedValue([]);
  (prisma.drugBatch.findMany as any).mockResolvedValue([]);
  (prisma.creditNote.findMany as any).mockResolvedValue([]);
  (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([]);
});

/** The B2B register filters on a GSTIN in the query; honour it, as Postgres would. */
function seedBills(bills: Array<{ recipientGstin: string | null }>) {
  (prisma.bill.findMany as any).mockImplementation(async (args: any) => {
    const g = args?.where?.recipientGstin;
    if (g === null) return bills.filter((b) => !b.recipientGstin);
    if (g && typeof g === 'object' && 'not' in g) return bills.filter((b) => !!b.recipientGstin);
    return bills;
  });
}

const row = (t: { rows: Array<{ ref: string }> }, ref: string) => t.rows.find((r) => r.ref === ref) as any;

describe('getGstr9Summary', () => {
  // Gap item 277: exempt turnover is 5D, not 4A as well.
  it('puts only taxable supplies in 4A, and exempt ones only in 5D', async () => {
    seedBills([billWith([TAXED, { taxableValue: 1000, totalAmount: 1000 }])]);
    const r = await getGstr9Summary(TENANT, { financialYear: '2026-27' });
    expect(row(r.tables.table4, '4A').taxableValue).toBe(8000);
    expect(row(r.tables.table5, '5D').taxableValue).toBe(1000);
    expect(r.reconciliation.agrees).toBe(true);
  });

  // Gap item 277: a voided sale is already gone from the register.
  it('counts each cancellation once in 4I', async () => {
    seedBills([billWith([TAXED])]);
    (prisma.creditNote.findMany as any).mockResolvedValue([
      note(),
      note({ id: 'cn-2', creditNoteNumber: 'CN/2', bill: { billNumber: 'B9', invoiceNumber: 'INV/9',
        gstDocumentType: 'tax_invoice', billDate: new Date('2026-09-05T00:00:00Z'), status: 'cancelled',
        _count: { billItems: 0 } } }),
    ]);
    const r = await getGstr9Summary(TENANT, { financialYear: '2026-27' });
    expect(row(r.tables.table4, '4I').taxableValue).toBe(-1000);
    expect(r.documents.creditNotesExcluded).toBe(1);
  });

  // Gap item 277 (retest): a cancelled exempt invoice stays in the gross
  // register and is reversed by its credit note in 5H. The tie-back used to net
  // 5H off one side only and read "₹6,400 against ₹7,400".
  it('ties with taxable, exempt and cancelled-exempt invoices, and Table 5 ties to the months', async () => {
    seedBills([
      billWith([{ ...TAXED, unitPrice: 5000, taxableValue: 5000, taxAmount: 250, cgstAmount: 125, sgstAmount: 125, totalAmount: 5250 }]),
      billWith([{ taxableValue: 1400, totalAmount: 1400 }], { id: 'bill-2', billNumber: 'BILL-2' }),
      billWith([{ taxableValue: 1000, totalAmount: 1000 }], {
        id: 'bill-3', billNumber: 'BILL-3', status: 'cancelled', billDate: new Date('2026-10-02T00:00:00Z'),
      }),
    ]);
    (prisma.creditNote.findMany as any).mockResolvedValue([
      note({
        id: 'cn-3', creditNoteNumber: 'CN/3', reason: 'cancellation',
        taxableValue: -1000, cgstAmount: 0, sgstAmount: 0, taxAmount: 0, totalAmount: -1000,
        items: [{ taxPercent: 0, taxableValue: -1000, cgstAmount: 0, sgstAmount: 0, igstAmount: 0,
          cessAmount: 0, taxAmount: 0, description: 'Cancelled', hsnSacCode: '999311', quantity: 1,
          gstTreatment: 'exempt', billItem: null }],
        bill: { billNumber: 'BILL-3', invoiceNumber: 'BOS/3', gstDocumentType: 'bill_of_supply',
          billDate: new Date('2026-10-02T00:00:00Z'), status: 'cancelled', _count: { billItems: 1 } },
      }),
    ]);
    const r = await getGstr9Summary(TENANT, { financialYear: '2026-27' });

    expect(row(r.tables.table5, '5D').taxableValue).toBe(2400);
    expect(row(r.tables.table5, '5H').taxableValue).toBe(-1000);
    expect(r.tables.table5.total).toBe(1400);
    expect(row(r.tables.table4, '4I').taxableValue).toBe(0);

    expect(r.reconciliation.registerTaxableValue).toBe(7400);
    expect(r.reconciliation.partsTaxableValue).toBe(7400);
    expect(r.reconciliation.notesTaxableValue).toBe(-1000);
    expect(r.reconciliation.agrees).toBe(true);

    expect(r.monthlyCheck.agrees).toBe(true);
    expect(r.table5Check).toMatchObject({ annual: 1400, sumOfMonths: 1400, agrees: true });
  });

  // Gap item 312: Table 4 is checked against the months summed separately.
  it('checks Table 4 against the sum of the monthly returns, head by head', async () => {
    seedBills([
      billWith([TAXED]),
      billWith([TAXED], { id: 'bill-2', billNumber: 'BILL-2', billDate: new Date('2026-10-03T00:00:00Z') }),
    ]);
    (prisma.creditNote.findMany as any).mockResolvedValue([note()]);
    const r = await getGstr9Summary(TENANT, { financialYear: '2026-27' });
    expect(r.monthlyCheck.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(r.monthlyCheck.sumOfMonths).toMatchObject({ taxableValue: 15000, cgstAmount: 375, sgstAmount: 375 });
    expect(r.monthlyCheck.annual).toMatchObject({ taxableValue: 15000, cgstAmount: 375, sgstAmount: 375 });
    expect(r.monthlyCheck.agrees).toBe(true);
    expect(r.monthlyCheck.cgstSgstGap).toBe(0);
  });
});
