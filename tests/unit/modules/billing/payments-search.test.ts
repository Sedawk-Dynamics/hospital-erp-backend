import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getPayments } from '../../../../src/modules/billing/billing.service';

// The Cash Counter has a "Search by bill number…" box. It was wired to state
// and sent as a query param, `search` is part of the shared pagination schema
// so it reached the service — and the service never looked at it. There is no
// client-side filter either, so the list came back whole and typing a bill
// number changed nothing on screen.

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
});

const whereOf = () => (vi.mocked(prisma.payment.findMany).mock.calls[0][0]!.where as any);

describe('Cash Counter payment search', () => {
  it('filters on what a cashier actually has in front of them', async () => {
    await getPayments(TENANT, { page: 1, limit: 50, search: 'BILL-2026-0001' } as never);

    const or = whereOf().OR as any[];
    const fields = or.map((c) => Object.keys(c)[0]);
    // The bill number on the slip, the payment's own reference, the receipt,
    // and the patient — any of which identifies the payment being looked for.
    expect(fields).toEqual(
      expect.arrayContaining(['bill', 'transactionId', 'gatewayReference', 'receipt', 'patient']),
    );
  });

  it('matches the bill number case-insensitively', async () => {
    await getPayments(TENANT, { page: 1, limit: 50, search: 'bill-2026' } as never);

    const or = whereOf().OR as any[];
    const byBill = or.find((c) => c.bill);
    expect(byBill.bill.billNumber).toEqual({ contains: 'bill-2026', mode: 'insensitive' });
  });

  it('does not filter when nothing was typed', async () => {
    await getPayments(TENANT, { page: 1, limit: 50 } as never);
    expect(whereOf().OR).toBeUndefined();
  });

  it('treats a whitespace-only search as no search', async () => {
    await getPayments(TENANT, { page: 1, limit: 50, search: '   ' } as never);
    expect(whereOf().OR).toBeUndefined();
  });

  it('keeps the day filter alongside the search', async () => {
    // The Cash Counter always scopes to today; searching must narrow within
    // that, not replace it.
    await getPayments(TENANT, { page: 1, limit: 50, fromDate: '2026-08-25', search: 'BILL' } as never);

    const where = whereOf();
    expect(where.paymentDate).toBeDefined();
    expect(where.OR).toBeDefined();
    expect(where.tenantId).toBe(TENANT);
  });
});
