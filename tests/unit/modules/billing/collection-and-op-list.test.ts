import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { collectionDocumentNumber } from '../../../../src/modules/billing/bill-payment-ledger';
import { getBills, getPayments } from '../../../../src/modules/billing/billing.service';
import {
  getRevenueRows,
  revenueDayWindow,
  RECOGNISED_REVENUE_WHERE,
  ADVANCES_RECEIVED_WHERE,
} from '../../../../src/modules/dashboard/dashboard.service';

const TENANT = 'tenant-1';
beforeEach(() => vi.clearAllMocks());

// Gap item 361 — every collection row names its own document.
describe('collectionDocumentNumber', () => {
  it('prints the receipt voucher number for an advance, not the shared ADV- bill number', () => {
    const bill = { billNumber: 'ADV-9818e2c5-1795156229288' };
    expect(collectionDocumentNumber({ paymentType: 'advance', voucherNumber: 'X/RV/2026-27/000001', receipt: { receiptNumber: 'RCP-1' }, bill })).toBe('X/RV/2026-27/000001');
    expect(collectionDocumentNumber({ paymentType: 'advance', voucherNumber: 'X/RV/2026-27/000002', receipt: { receiptNumber: 'RCP-2' }, bill })).toBe('X/RV/2026-27/000002');
  });

  it('prints the receipt number for an ordinary payment', () => {
    expect(collectionDocumentNumber({ paymentType: 'regular', voucherNumber: null, receipt: { receiptNumber: 'RCP-9' }, bill: { billNumber: 'BILL-1' } })).toBe('RCP-9');
  });
});

describe('getPayments collectionOnly', () => {
  it('leaves advance applications out and tags each row with its document number', async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([
      { id: 'p1', paymentType: 'advance', paymentMethod: 'cash', transactionId: 'IPDEPRCPT:a', voucherNumber: 'RV/1', receipt: { receiptNumber: 'R1' }, bill: { billNumber: 'ADV-x' } },
    ] as never);
    vi.mocked(prisma.payment.count).mockResolvedValue(1 as never);

    const res = await getPayments(TENANT, { collectionOnly: 'true' } as never);

    const where = vi.mocked(prisma.payment.findMany).mock.calls[0][0]!.where as any;
    expect(where.AND).toEqual(expect.arrayContaining([
      { OR: [{ sourceAdvancePaymentId: null }, { paymentType: 'refund' }] },
      { OR: [{ paymentType: { not: 'advance' } }, { paymentMethod: { not: 'advance' } }] },
    ]));
    expect(res.payments[0]).toMatchObject({ documentNumber: 'RV/1', isAdjustment: false });
  });
});

// Gap item 288 — the OP List is issued outpatient bills only.
describe('getBills OP List', () => {
  it('excludes drafts, admission bills and IP running bills', async () => {
    vi.mocked(prisma.bill.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bill.count).mockResolvedValue(0 as never);

    await getBills(TENANT, { billType: 'op', finalised: 'true' } as never);

    const where = vi.mocked(prisma.bill.findMany).mock.calls[0][0]!.where as any;
    expect(where.status).toEqual({ not: 'draft' });
    expect(where.admissionId).toBeNull();
    expect(where.AND).toEqual([
      { billNumber: { not: { startsWith: 'IPW-' } } },
      { OR: [{ visitId: null }, { visit: { visitType: 'op' } }] },
    ]);
  });
});

// Gap item 360 — the tile and the rows it links to read one definition.
describe('getRevenueRows', () => {
  it('uses the tile filter and day, so its total is the tile', async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([
      { id: 'a', amount: 900, paymentType: 'advance', paymentMethod: 'advance', transactionId: 'IPDEP:adm-1', bill: { billNumber: 'IPW-1' } },
      { id: 'b', amount: 300, paymentType: 'regular', paymentMethod: 'cash', bill: { billNumber: 'BILL-1' }, receipt: { receiptNumber: 'R-1' } },
    ] as never);

    const res = await getRevenueRows(TENANT, { date: '2026-11-20' });

    const where = vi.mocked(prisma.payment.findMany).mock.calls[0][0]!.where as any;
    const day = revenueDayWindow('2026-11-20');
    expect(where).toMatchObject({ ...RECOGNISED_REVENUE_WHERE, paymentDate: { gte: day.gte, lte: day.lte } });
    expect(res.total).toBe(1_200);
    expect(res.rows[0]).toMatchObject({ fromAdvance: true });
  });

  it('lists advance receipts for the advances tile', async () => {
    await getRevenueRows(TENANT, { date: '2026-11-20', kind: 'advances' });
    const where = vi.mocked(prisma.payment.findMany).mock.calls[0][0]!.where as any;
    expect(where).toMatchObject(ADVANCES_RECEIVED_WHERE);
  });
});
