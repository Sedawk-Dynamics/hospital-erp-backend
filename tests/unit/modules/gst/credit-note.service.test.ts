import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  issueCreditNote,
  issueCreditNoteBestEffort,
  isWithinCreditNoteTimeLimit,
} from '../../../../src/modules/gst/credit-note.service';

const TENANT = 'tenant-1';

const BILL = {
  id: 'bill-1',
  patientId: 'pat-1',
  billDate: new Date('2026-06-01T06:00:00Z'),
  supplierGstin: '27AAPFU0939F1ZV',
  recipientGstin: null,
  placeOfSupplyStateCode: '27',
};

/** A taxable room line and an exempt surgery line — the ordinary hospital bill. */
const ITEMS = [
  {
    id: 'li-room',
    description: 'Deluxe room',
    hsnSacCode: '996311',
    gstTreatment: 'taxable',
    quantity: 3,
    unitPrice: 6000,
    taxableValue: 18000,
    taxPercent: 5,
    taxAmount: 900,
    cgstAmount: 450,
    sgstAmount: 450,
    igstAmount: 0,
    cessAmount: 0,
    totalAmount: 18900,
  },
  {
    id: 'li-surgery',
    description: 'Appendectomy',
    hsnSacCode: '9993',
    gstTreatment: 'exempt',
    quantity: 1,
    unitPrice: 35000,
    taxableValue: 35000,
    taxPercent: 0,
    taxAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    cessAmount: 0,
    totalAmount: 35000,
  },
];

function setup(items = ITEMS) {
  (prisma.bill.findFirst as any).mockResolvedValue(BILL);
  (prisma.billItem.findMany as any).mockResolvedValue(items);
  (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'CN', lastNumber: 4 });
  (prisma.creditNote.create as any).mockImplementation(async ({ data }: any) => ({
    id: 'cn-1',
    creditNoteNumber: data.creditNoteNumber,
    totalAmount: data.totalAmount,
  }));
}

describe('isWithinCreditNoteTimeLimit', () => {
  // 30 November following the end of the financial year the supply fell in.
  it('allows a note up to 30 November after the year end', () => {
    const supply = new Date('2026-06-01T06:00:00Z'); // FY 2026-27
    expect(isWithinCreditNoteTimeLimit(supply, new Date('2027-11-30T06:00:00Z'))).toBe(true);
    expect(isWithinCreditNoteTimeLimit(supply, new Date('2027-12-01T06:00:00Z'))).toBe(false);
  });

  it('allows one raised the same day', () => {
    const supply = new Date('2026-06-01T06:00:00Z');
    expect(isWithinCreditNoteTimeLimit(supply, supply)).toBe(true);
  });
});

describe('issueCreditNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('credits a whole bill when no lines are named', async () => {
    setup();
    const note = await issueCreditNote(prisma, TENANT, {
      billId: 'bill-1',
      reason: 'cancellation',
      on: new Date('2026-06-10T06:00:00Z'),
    });
    expect(note).toMatchObject({ creditNoteNumber: 'CN/2026-27/000004' });
    const data = (prisma.creditNote.create as any).mock.calls[0][0].data;
    // Negative throughout — the note records what comes OFF the supply.
    expect(data.totalAmount).toBe(-53900);
    expect(data.taxableValue).toBe(-53000);
    expect(data.taxAmount).toBe(-900);
    expect(data.cgstAmount).toBe(-450);
    expect(data.sgstAmount).toBe(-450);
    expect(data.items.create).toHaveLength(2);
  });

  // The rule the whole file exists for: the note copies the line's own figures
  // rather than recomputing them, so a rate that moved cannot leave a residue.
  it('mirrors the line rather than recomputing it', async () => {
    setup();
    await issueCreditNote(prisma, TENANT, { billId: 'bill-1', reason: 'sales_return' });
    const room = (prisma.creditNote.create as any).mock.calls[0][0].data.items.create.find(
      (i: any) => i.description === 'Deluxe room',
    );
    expect(room).toMatchObject({
      hsnSacCode: '996311',
      gstTreatment: 'taxable',
      taxPercent: 5,
      taxableValue: -18000,
      taxAmount: -900,
      cgstAmount: -450,
      sgstAmount: -450,
      billItemId: 'li-room',
    });
  });

  it('scales a partial credit by its share, tax included', async () => {
    setup();
    await issueCreditNote(prisma, TENANT, {
      billId: 'bill-1',
      reason: 'sales_return',
      lines: [{ billItemId: 'li-room', share: 1 / 3 }],
    });
    const data = (prisma.creditNote.create as any).mock.calls[0][0].data;
    // One of three days back: a third of the value AND a third of the tax.
    expect(data.taxableValue).toBe(-6000);
    expect(data.taxAmount).toBe(-300);
    expect(data.cgstAmount).toBe(-150);
    expect(data.sgstAmount).toBe(-150);
    expect(data.totalAmount).toBe(-6300);
  });

  it('carries the document identity from the bill it reverses', async () => {
    setup();
    await issueCreditNote(prisma, TENANT, { billId: 'bill-1', reason: 'cancellation' });
    expect((prisma.creditNote.create as any).mock.calls[0][0].data).toMatchObject({
      supplierGstin: '27AAPFU0939F1ZV',
      placeOfSupplyStateCode: '27',
      billId: 'bill-1',
      patientId: 'pat-1',
    });
  });

  it('marks a note raised after the deadline as out of time', async () => {
    setup();
    await issueCreditNote(prisma, TENANT, {
      billId: 'bill-1',
      reason: 'sales_return',
      on: new Date('2028-01-15T06:00:00Z'),
    });
    expect((prisma.creditNote.create as any).mock.calls[0][0].data.withinTimeLimit).toBe(false);
  });

  it('writes nothing for a bill with no lines', async () => {
    setup([]);
    expect(
      await issueCreditNote(prisma, TENANT, { billId: 'bill-1', reason: 'cancellation' }),
    ).toBeNull();
    expect(prisma.creditNote.create as any).not.toHaveBeenCalled();
  });

  it('writes nothing when nothing actually comes back', async () => {
    setup();
    const note = await issueCreditNote(prisma, TENANT, {
      billId: 'bill-1',
      reason: 'sales_return',
      lines: [{ billItemId: 'li-room', share: 0 }],
    });
    expect(note).toBeNull();
  });

  it('refuses a bill that is not this tenant', async () => {
    (prisma.bill.findFirst as any).mockResolvedValue(null);
    await expect(
      issueCreditNote(prisma, TENANT, { billId: 'nope', reason: 'cancellation' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('issueCreditNoteBestEffort', () => {
  beforeEach(() => vi.clearAllMocks());

  // The refund has already happened. Refusing to hand a patient their money
  // back because a document could not be written is the wrong trade.
  it('never throws, so a failed document cannot undo a refund', async () => {
    (prisma.bill.findFirst as any).mockRejectedValue(new Error('database is gone'));
    await expect(
      issueCreditNoteBestEffort(prisma, TENANT, { billId: 'bill-1', reason: 'reversal' }),
    ).resolves.toBeUndefined();
  });
});
