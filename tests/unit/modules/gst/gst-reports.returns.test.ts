import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getCreditNoteRegister,
  getGstr1Summary,
  getGstr3bSummary,
} from '../../../../src/modules/gst/gst-reports.returns';

const TENANT = 'tenant-1';

function note(over: Record<string, unknown> = {}) {
  return {
    id: 'cn-1',
    creditNoteNumber: 'CN/2026-27/000001',
    issueDate: new Date('2026-09-10T00:00:00Z'),
    financialYear: '2026-27',
    reason: 'refund',
    reasonNote: null,
    patientId: 'p1',
    recipientGstin: null,
    placeOfSupplyStateCode: '27',
    // NEGATIVE, as production stores them: a note MIRRORS the bill's lines with
    // the sign flipped, so summing a patient's documents nets to their real
    // position. The fixture used to carry positive figures, which is what let a
    // sign error in the set-off look correct.
    taxableValue: -1000,
    cgstAmount: -25,
    sgstAmount: -25,
    igstAmount: 0,
    cessAmount: 0,
    taxAmount: -50,
    totalAmount: -1050,
    withinTimeLimit: true,
    items: [{ id: 'i1', taxPercent: 5, taxableValue: -1000, cgstAmount: -25, sgstAmount: -25, igstAmount: 0, cessAmount: 0, taxAmount: -50, description: 'Reversed', hsnSacCode: '3004', quantity: 1 }],
    bill: {
      billNumber: 'BILL-1',
      invoiceNumber: 'INV/2026-27/000001',
      gstDocumentType: 'tax_invoice',
      billDate: new Date('2026-09-03T00:00:00Z'),
      status: 'paid',
      // The supply being reversed is still in the register, so the note is
      // allowed to take it out. A voided bill's lines are deleted, and netting
      // its note off as well would subtract the same supply twice.
      _count: { billItems: 1 },
    },
    patient: { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    issuer: { firstName: 'Front', lastName: 'Desk' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCreditNoteRegister (A-6)', () => {
  it('names the invoice each note reverses — Table 9B keys on it', async () => {
    (prisma.creditNote.findMany as any).mockResolvedValue([note()]);
    const r = await getCreditNoteRegister(TENANT);
    expect(r.rows[0]).toMatchObject({
      creditNoteNumber: 'CN/2026-27/000001',
      againstInvoiceNumber: 'INV/2026-27/000001',
      againstBillNumber: 'BILL-1',
      // Negative, because that is how a note is stored — it mirrors the bill's
      // lines with the sign flipped.
      taxAmount: -50,
      reportable: true,
    });
    expect(r.rows[0].issuedBy).toBe('Front Desk');
  });

  // A note against a bill that was never issued a number has nothing for Table
  // 9B to key on. It cannot be filed, and somebody has to know that.
  it('flags a note whose original was never issued a number', async () => {
    (prisma.creditNote.findMany as any).mockResolvedValue([
      note({ bill: { billNumber: 'BILL-2', invoiceNumber: null, gstDocumentType: null, billDate: new Date() } }),
    ]);
    const r = await getCreditNoteRegister(TENANT);
    expect(r.rows[0].reportable).toBe(false);
    expect(r.summary.notReportable).toBe(1);
  });

  it('splits registered from unregistered recipients, as Table 9B does', async () => {
    (prisma.creditNote.findMany as any).mockResolvedValue([
      note({ id: 'a', recipientGstin: '27AAPFU0939F1ZV' }),
      note({ id: 'b' }),
    ]);
    const r = await getCreditNoteRegister(TENANT);
    expect(r.summary.b2b).toMatchObject({ count: 1, taxAmount: -50 });
    expect(r.summary.b2c).toMatchObject({ count: 1, taxAmount: -50 });
  });

  it('counts notes issued past the section 34 deadline', async () => {
    (prisma.creditNote.findMany as any).mockResolvedValue([note({ withinTimeLimit: false })]);
    const r = await getCreditNoteRegister(TENANT);
    expect(r.summary.outsideTimeLimit).toBe(1);
  });
});

// ── The return views ───────────────────────────────────────────────────────

function billWith(items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'bill-1',
    billNumber: 'BILL-1',
    invoiceNumber: 'INV/2026-27/000001',
    gstDocumentType: 'invoice_cum_bill_of_supply',
    billDate: new Date('2026-09-03T00:00:00Z'),
    status: 'paid',
    financialYear: '2026-27',
    admissionId: null,
    recipientGstin: null,
    placeOfSupplyStateCode: '27',
    isInterState: false,
    patient: { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' },
    billItems: items.map((o, i) => ({
      id: `it-${i}`,
      description: 'Charge',
      category: 'other',
      quantity: 1,
      unitPrice: 100,
      discountAmount: 0,
      taxPercent: 0,
      taxableValue: 100,
      taxAmount: 0,
      cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0,
      totalAmount: 100,
      hsnSacCode: null,
      gstTreatment: 'exempt',
      rateSource: 'category_default',
      requiresTaxResolution: false,
      createdAt: new Date('2026-09-03T00:00:00Z'),
      ...o,
    })),
    ...over,
  };
}

const TAXED = {
  category: 'room', unitPrice: 8000, taxPercent: 5, taxableValue: 8000,
  taxAmount: 400, cgstAmount: 200, sgstAmount: 200, totalAmount: 8400,
  hsnSacCode: '996311', gstTreatment: 'taxable',
};

/** Everything the return views read, with nothing on the purchase side. */
function seedAll(bills: unknown[], notes: unknown[] = []) {
  (prisma.bill.findMany as any).mockResolvedValue(bills);
  (prisma.creditNote.findMany as any).mockResolvedValue(notes);
  (prisma.payment.findMany as any).mockResolvedValue([]);
  (prisma.drugBatch.findMany as any).mockResolvedValue([]);
}

describe('getGstr1Summary (A-8)', () => {
  it('fills each table by folding the register the way that table asks', async () => {
    seedAll([billWith([TAXED, {}])]);
    const r = await getGstr1Summary(TENANT);
    expect(r.tables.b2c).toMatchObject({ taxableValue: 8000, taxAmount: 400 });
    expect(r.tables.b2b.count).toBe(0);
    expect(r.tables.exemptTurnover).toMatchObject({ exempt: 100, total: 100 });
    expect(r.tables.hsn[0]).toMatchObject({ hsnSac: '9963', ratePercent: 5 });
  });

  it('routes a supply to a registered recipient into the B2B table', async () => {
    seedAll([billWith([TAXED], { recipientGstin: '27AAPFU0939F1ZV' })]);
    const r = await getGstr1Summary(TENANT);
    expect(r.tables.b2b.taxableValue).toBe(8000);
    expect(r.tables.b2c.taxableValue).toBe(0);
  });

  // The whole point of a return-ready view: the accountant files the number on
  // the screen, so it has to say when it does not agree with the register.
  it('reconciles the tables back to the register and says they agree', async () => {
    seedAll([billWith([TAXED, {}])]);
    const r = await getGstr1Summary(TENANT);
    expect(r.reconciliation.taxable.agrees).toBe(true);
    expect(r.reconciliation.register.agrees).toBe(true);
    expect(r.reconciliation.unclassifiedLines).toBe(0);
  });

  it('still reconciles, and counts them, when a line has no treatment', async () => {
    seedAll([billWith([TAXED, { gstTreatment: null }])]);
    const r = await getGstr1Summary(TENANT);
    expect(r.reconciliation.unclassifiedLines).toBe(1);
    // The unclassified line is carried in the reconciliation rather than
    // dropped, so the register still ties.
    expect(r.reconciliation.register.agrees).toBe(true);
  });
});

describe('getGstr3bSummary (A-9)', () => {
  it('nets a credit note off the outward liability for the month', async () => {
    seedAll([billWith([TAXED])], [note({ taxableValue: -1000, taxAmount: -50, cgstAmount: -25, sgstAmount: -25 })]);
    const r = await getGstr3bSummary(TENANT);
    expect(r.outwardTaxable).toMatchObject({ taxableValue: 7000, taxAmount: 350 });
  });

  // Past the section 34 deadline the money goes back and the tax does not.
  // Netting it off anyway would understate what the hospital owes.
  it('refuses to net off a note issued past the deadline', async () => {
    seedAll([billWith([TAXED])], [note({ withinTimeLimit: false })]);
    const r = await getGstr3bSummary(TENANT);
    expect(r.outwardTaxable.taxAmount).toBe(400);
    expect(r.creditNotesExcluded).toBe(1);
  });

  it('reports exempt and non-GST supplies in their own boxes', async () => {
    seedAll([billWith([TAXED, {}, { gstTreatment: 'non_gst' }])]);
    const r = await getGstr3bSummary(TENANT);
    expect(r.outwardExempt).toBe(100);
    expect(r.outwardNonGst).toBe(100);
  });

  it('pays the whole liability in cash when there is no credit to set off', async () => {
    seedAll([billWith([TAXED])]);
    const r = await getGstr3bSummary(TENANT);
    expect(r.inputTaxCredit).toMatchObject({ available: 0, reversed: 0, net: 0 });
    expect(r.netTaxPayable).toBe(400);
    expect(r.creditCarriedForward).toBe(0);
  });
});
