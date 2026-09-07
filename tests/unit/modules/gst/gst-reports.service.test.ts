import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getAdvancesReport } from '../../../../src/modules/gst/gst-reports.service';

const TENANT = 'tenant-1';

/**
 * The prisma mock ignores `where`, so a test about which rows come back has to
 * feed the two queries in order: receipts first, then their drawdowns.
 */
function seed(receipts: any[], drawdowns: any[] = []) {
  (prisma.payment.findMany as any)
    .mockResolvedValueOnce(receipts)
    .mockResolvedValueOnce(drawdowns);
}

const patient = { id: 'p1', mrn: 'MRN-1', firstName: 'Asha', lastName: 'Rao' };

function advance(over: Record<string, unknown> = {}) {
  return {
    id: 'adv-1',
    paymentDate: new Date('2026-09-01T06:00:00.000Z'),
    amount: 10000,
    paymentMethod: 'cash',
    transactionId: 'TXN-1',
    notes: null,
    gstTreatment: 'exempt',
    taxRatePercent: 0,
    taxableValue: 10000,
    taxAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    voucherType: 'receipt_voucher',
    voucherNumber: 'RV/2026-27/000001',
    patient,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAdvancesReport', () => {
  it('reports a taxable advance under table 11A with its tax split', async () => {
    seed([
      advance({
        gstTreatment: 'taxable',
        taxRatePercent: 5,
        taxableValue: 9523.81,
        taxAmount: 476.19,
        cgstAmount: 238.1,
        sgstAmount: 238.09,
      }),
    ]);

    const r = await getAdvancesReport(TENANT);

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      voucherNumber: 'RV/2026-27/000001',
      gstTreatment: 'taxable',
      amount: 10000,
      taxAmount: 476.19,
      // Nothing drawn against it yet, so the whole receipt is still held.
      adjusted: 0,
      refunded: 0,
      balance: 10000,
      unclassified: false,
    });
    expect(r.summary.taxDueOnAdvances).toMatchObject({
      count: 1,
      taxableValue: 9523.81,
      taxAmount: 476.19,
      cgstAmount: 238.1,
      sgstAmount: 238.09,
      igstAmount: 0,
    });
  });

  // The ordinary hospital advance. Its money is reported; its tax is not,
  // because an exempt deposit belongs in exempt turnover and not in table 11A.
  it('keeps an exempt deposit out of the tax-due figures but counts its money', async () => {
    seed([advance()]);

    const r = await getAdvancesReport(TENANT);

    expect(r.summary.amountReceived).toBe(10000);
    expect(r.summary.taxDueOnAdvances).toMatchObject({ count: 0, taxAmount: 0 });
    expect(r.summary.byTreatment).toEqual([
      { treatment: 'exempt', count: 1, amount: 10000, taxableValue: 10000, taxAmount: 0 },
    ]);
  });

  it('names the patient without printing "null" for a missing surname', async () => {
    seed([advance({ patient: { ...patient, lastName: null } })]);
    const r = await getAdvancesReport(TENANT);
    expect(r.rows[0].patientName).toBe('Asha');
  });

  it('tells an admission deposit apart from a desk advance', async () => {
    seed([
      advance({ id: 'a', transactionId: 'IPDEPRCPT:adm-1' }),
      advance({ id: 'b', transactionId: 'TXN-9' }),
    ]);
    const r = await getAdvancesReport(TENANT);
    expect(r.rows.map((x) => x.source)).toEqual(['admission_deposit', 'desk_advance']);
  });

  it('reports what has been adjusted against an invoice under table 11B', async () => {
    seed(
      [advance({ amount: 10000 })],
      [
        {
          id: 'd1',
          sourceAdvancePaymentId: 'adv-1',
          paymentType: 'regular',
          paymentDate: new Date('2026-09-03T06:00:00.000Z'),
          amount: 4000,
          taxAmount: 0,
          voucherNumber: null,
          bill: {
            billNumber: 'BILL-1',
            invoiceNumber: 'BOS/2026-27/000004',
            gstDocumentType: 'bill_of_supply',
          },
        },
      ],
    );

    const r = await getAdvancesReport(TENANT);

    expect(r.rows[0]).toMatchObject({ adjusted: 4000, balance: 6000 });
    expect(r.rows[0].adjustments[0]).toMatchObject({
      amount: 4000,
      invoiceNumber: 'BOS/2026-27/000004',
      billNumber: 'BILL-1',
    });
    expect(r.summary.adjustedAgainstInvoices).toEqual({ count: 1, amount: 4000 });
    expect(r.summary.balanceOutstanding).toBe(6000);
  });

  // A refund is not an adjustment: nothing was supplied, the money went back.
  // Reporting it under 11B would claim a supply that never happened.
  it('separates a refund voucher from an adjustment', async () => {
    seed(
      [advance({ amount: 10000, gstTreatment: 'taxable', taxAmount: 476.19 })],
      [
        {
          id: 'r1',
          sourceAdvancePaymentId: 'adv-1',
          paymentType: 'refund',
          paymentDate: new Date('2026-09-04T06:00:00.000Z'),
          amount: 2500,
          taxAmount: -119.05,
          voucherNumber: 'RFV/2026-27/000001',
          bill: null,
        },
      ],
    );

    const r = await getAdvancesReport(TENANT);

    expect(r.rows[0]).toMatchObject({ adjusted: 0, refunded: 2500, balance: 7500 });
    expect(r.rows[0].refunds[0]).toMatchObject({
      voucherNumber: 'RFV/2026-27/000001',
      taxReversed: -119.05,
    });
    expect(r.summary.adjustedAgainstInvoices.count).toBe(0);
    expect(r.summary.amountRefunded).toBe(2500);
  });

  it('never reports a negative balance when more went out than came in', async () => {
    seed(
      [advance({ amount: 1000 })],
      [
        {
          id: 'd1',
          sourceAdvancePaymentId: 'adv-1',
          paymentType: 'regular',
          paymentDate: new Date(),
          amount: 900,
          taxAmount: 0,
          voucherNumber: null,
          bill: null,
        },
        {
          id: 'r1',
          sourceAdvancePaymentId: 'adv-1',
          paymentType: 'refund',
          paymentDate: new Date(),
          amount: 400,
          taxAmount: 0,
          voucherNumber: 'RFV/2026-27/000002',
          bill: null,
        },
      ],
    );

    const r = await getAdvancesReport(TENANT);
    expect(r.rows[0].balance).toBe(0);
  });

  // An advance taken before advances carried a tax position at all. Saying its
  // treatment is unknown beats reporting it as exempt on no evidence.
  it('flags a legacy advance with no recorded treatment', async () => {
    seed([advance({ gstTreatment: null, voucherNumber: null, voucherType: null })]);
    const r = await getAdvancesReport(TENANT);
    expect(r.rows[0].unclassified).toBe(true);
    expect(r.summary.unclassifiedCount).toBe(1);
    expect(r.summary.byTreatment[0].treatment).toBe('unclassified');
  });

  it('excludes deposit money moving ONTO a bill, which is not a receipt', async () => {
    seed([]);
    await getAdvancesReport(TENANT);
    const where = (prisma.payment.findMany as any).mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: TENANT, status: 'completed', paymentType: 'advance' });
    // Null-safe, and it has to be: `NOT (col LIKE ...)` is NULL rather than
    // true where the column is null, and most advances carry no reference
    // number at all — the plain spelling returned 5 of 65 rows on real data.
    expect(where.OR).toEqual([
      { transactionId: null },
      { NOT: { transactionId: { startsWith: 'IPDEP:' } } },
    ]);
  });

  // If these two ever collided, every admission deposit would be dropped from
  // the report entirely — so the shapes are pinned here as well as at the writer.
  it('does not let a deposit RECEIPT marker match the applied-deposit prefix', () => {
    expect('IPDEPRCPT:adm-1'.startsWith('IPDEP:')).toBe(false);
  });

  it('skips the drawdown query when nothing matched', async () => {
    seed([]);
    await getAdvancesReport(TENANT);
    expect((prisma.payment.findMany as any).mock.calls).toHaveLength(1);
  });

  it('passes the period, patient and treatment filters through to the query', async () => {
    seed([]);
    await getAdvancesReport(TENANT, {
      from: '2026-09-01',
      to: '2026-09-30',
      patientId: 'p1',
      treatment: 'taxable',
    });
    const where = (prisma.payment.findMany as any).mock.calls[0][0].where;
    expect(where.patientId).toBe('p1');
    expect(where.gstTreatment).toBe('taxable');
    // The closing day is inclusive — what a person means by "to".
    expect(where.paymentDate.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(where.paymentDate.lte.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });
});
