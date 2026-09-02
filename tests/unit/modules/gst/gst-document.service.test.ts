import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  financialYearFor,
  decideDocument,
  allotDocumentNumber,
  issueDocumentForBill,
} from '../../../../src/modules/gst/gst-document.service';

const TENANT = 'tenant-1';

describe('financialYearFor', () => {
  it('starts the year in April', () => {
    expect(financialYearFor(new Date('2026-04-01T06:00:00Z'))).toBe('2026-27');
    expect(financialYearFor(new Date('2027-03-31T06:00:00Z'))).toBe('2026-27');
    expect(financialYearFor(new Date('2027-04-01T06:00:00Z'))).toBe('2027-28');
  });

  it('puts January to March in the year that began the previous April', () => {
    expect(financialYearFor(new Date('2027-01-15T06:00:00Z'))).toBe('2026-27');
  });

  // A bill raised at 02:00 IST on 1 April belongs to the new year; a server
  // reading UTC would still be calling it 31 March.
  it('decides the boundary in IST, not UTC', () => {
    // 02:00 IST on 1 April 2026 is 20:30 UTC on 31 March 2026.
    expect(financialYearFor(new Date('2026-03-31T20:30:00Z'))).toBe('2026-27');
  });
});

describe('decideDocument', () => {
  it('calls an all-exempt bill a Bill of Supply', () => {
    const d = decideDocument([{ taxAmount: 0 }, { taxAmount: 0 }]);
    expect(d.documentType).toBe('bill_of_supply');
    expect(d.label).toBe('Bill of Supply');
  });

  it('calls an all-taxable bill a Tax Invoice', () => {
    expect(decideDocument([{ taxAmount: 900 }]).documentType).toBe('tax_invoice');
  });

  // The ordinary hospital bill: a taxable room beside an exempt surgery.
  it('calls a mixed bill an Invoice-cum-Bill of Supply', () => {
    const d = decideDocument([{ taxAmount: 900 }, { taxAmount: 0 }]);
    expect(d.documentType).toBe('invoice_cum_bill_of_supply');
    expect(d.requiresSeparateBillOfSupply).toBe(false);
  });

  it('flags that a registered recipient is owed two documents', () => {
    const d = decideDocument([{ taxAmount: 900 }, { taxAmount: 0 }], {
      recipientGstin: '27AAPFU0939F1ZV',
    });
    expect(d.documentType).toBe('tax_invoice');
    expect(d.requiresSeparateBillOfSupply).toBe(true);
  });

  // The document follows what the patient was CHARGED. A life-saving drug is
  // classified taxable and charged nothing, so it belongs on the exempt side.
  it('treats a taxable line charged at nil as exempt for naming purposes', () => {
    const d = decideDocument([{ taxAmount: 0, gstTreatment: 'taxable' }]);
    expect(d.documentType).toBe('bill_of_supply');
  });
});

describe('allotDocumentNumber', () => {
  beforeEach(() => vi.clearAllMocks());

  // The counter row IS the sequence. A MAX() over issued documents cannot be
  // made safe — two counters finalising at once read the same maximum.
  it('increments the counter rather than reading a maximum', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'TI', lastNumber: 7 });
    const r = await allotDocumentNumber(prisma, TENANT, 'tax_invoice', new Date('2026-06-01T06:00:00Z'));
    expect(r.invoiceNumber).toBe('TI/2026-27/000007');
    expect(r.financialYear).toBe('2026-27');
    const call = (prisma.gstDocumentSeries.upsert as any).mock.calls[0][0];
    expect(call.update).toEqual({ lastNumber: { increment: 1 } });
    expect(call.where.tenantId_documentType_financialYear).toMatchObject({
      tenantId: TENANT,
      documentType: 'tax_invoice',
      financialYear: '2026-27',
    });
  });

  it('opens a new series at one', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'BOS', lastNumber: 1 });
    const r = await allotDocumentNumber(prisma, TENANT, 'bill_of_supply', new Date('2026-06-01T06:00:00Z'));
    expect(r.invoiceNumber).toBe('BOS/2026-27/000001');
    expect((prisma.gstDocumentSeries.upsert as any).mock.calls[0][0].create.lastNumber).toBe(1);
  });
});

describe('issueDocumentForBill', () => {
  beforeEach(() => vi.clearAllMocks());

  const bill = { id: 'bill-1', billDate: new Date('2026-06-01T06:00:00Z') };

  it('names and numbers a registered hospital bill', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'INV', lastNumber: 3 });
    (prisma.bill.update as any).mockResolvedValue({});
    const r = await issueDocumentForBill(
      prisma,
      TENANT,
      bill,
      [{ taxAmount: 900 }, { taxAmount: 0 }],
      { registered: true },
    );
    expect(r).toMatchObject({
      documentType: 'invoice_cum_bill_of_supply',
      invoiceNumber: 'INV/2026-27/000003',
    });
    const data = (prisma.bill.update as any).mock.calls[0][0].data;
    expect(data.financialYear).toBe('2026-27');
    expect(data.gstFrozenAt).toBeInstanceOf(Date);
  });

  // An unregistered hospital has no series and nothing to file, so no number is
  // correct rather than a failure — but the patient's bill should still say
  // what it is.
  it('names but does not number an unregistered hospital bill', async () => {
    (prisma.bill.update as any).mockResolvedValue({});
    const r = await issueDocumentForBill(prisma, TENANT, bill, [{ taxAmount: 0 }], {
      registered: false,
    });
    expect(r).toMatchObject({ documentType: 'bill_of_supply', invoiceNumber: null });
    expect(prisma.gstDocumentSeries.upsert as any).not.toHaveBeenCalled();
  });

  // Re-finalising must never mint a second number for one document.
  it('refuses to number a bill that already has one', async () => {
    const r = await issueDocumentForBill(
      prisma,
      TENANT,
      { ...bill, invoiceNumber: 'INV/2026-27/000003' },
      [{ taxAmount: 0 }],
      { registered: true },
    );
    expect(r).toBeNull();
    expect(prisma.gstDocumentSeries.upsert as any).not.toHaveBeenCalled();
    expect(prisma.bill.update as any).not.toHaveBeenCalled();
  });
});
