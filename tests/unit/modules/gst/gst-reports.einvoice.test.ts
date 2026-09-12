import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getEInvoiceRegister,
  getFailedIrnReport,
  getEwayBillRegister,
} from '../../../../src/modules/gst/gst-reports.einvoice';

const TENANT = 'tenant-1';
const GSTIN = '27AAPFU0939F1ZV';
const RECIPIENT = '24AAACC1206D1ZM';

// The clock is frozen for every test in this file — see beforeEach — and these
// dates are offsets from the frozen instant, so the deadline assertions still
// do not rot. The 30-day window is the profile's default; 60 days ago is
// comfortably past it and 5 days ago is comfortably inside.
//
// The freeze is what makes them deterministic. daysAgo builds a document date
// to the millisecond and the report reads its own `new Date()` a fraction of a
// millisecond later, so a document 40 days old against a 30-day window is
// -10 days minus an epsilon. Math.floor turns that into -11 whenever the two
// reads straddle a millisecond tick, which measured at about 1 run in 100.
const NOW = new Date('2026-09-15T09:30:00.000Z');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

const PROFILE = {
  registered: true,
  gstin: GSTIN,
  stateCode: '27',
  effectiveFrom: null,
  eInvoiceApplicable: true,
  eWayBillApplicable: true,
  eInvoiceUploadDays: 30,
  eWayBillThreshold: 50_000,
};

vi.mock('../../../../src/modules/hospital-settings/hospital-settings.service', () => ({
  getGstProfile: vi.fn(async () => PROFILE),
}));

function bill(o: Record<string, unknown> = {}) {
  return {
    id: 'b1', invoiceNumber: 'TI/2026-27/000001', billDate: daysAgo(60),
    cancelledAt: null, recipientGstin: RECIPIENT,
    taxableValue: 10_000, taxAmount: 500, totalAmount: 10_500,
    irn: null, irnAckNo: null, irnAckDate: null, irnStatus: null,
    irnError: null, irnAttemptedAt: null, irnCancelledAt: null,
    patient: { firstName: 'Asha', lastName: 'Rao' },
    ...o,
  };
}

beforeEach(() => {
  // Date only. The flake is two clock reads, not a timer: nothing in these
  // reports schedules work, so faking setTimeout as well would buy nothing and
  // would leave a way for a later test to hang on a clock nobody advances.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  Object.assign(PROFILE, {
    registered: true, gstin: GSTIN, effectiveFrom: null,
    eInvoiceApplicable: true, eWayBillApplicable: true,
    eInvoiceUploadDays: 30, eWayBillThreshold: 50_000,
  });
  (prisma.bill.findMany as any).mockResolvedValue([]);
  (prisma.creditNote.findMany as any).mockResolvedValue([]);
  (prisma.drugReturn.findMany as any).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('D-1 — the e-invoice register', () => {
  // Correction 14: "Don't make that a permanent hard-coded rule ... Applicable
  // where e-invoicing/e-way bill requirements apply to the hospital for the
  // relevant period."
  it('states applicability in the words the correction asked for, and never a turnover', async () => {
    const out = await getEInvoiceRegister(TENANT);
    expect(out.applicability.statement).toBe(
      'Applicable where e-invoice requirements apply to the hospital for the relevant period.',
    );
    expect(JSON.stringify(out)).not.toMatch(/crore|5,00,00,000|50000000/i);
  });

  it('reads applicability off the hospital settings rather than deciding it', async () => {
    PROFILE.eInvoiceApplicable = false;
    const out = await getEInvoiceRegister(TENANT);
    expect(out.applicability.applicable).toBe(false);
    expect(out.note).toMatch(/do not currently apply/);
  });

  it('separates a document nobody sent from one the portal refused', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ id: 'a', invoiceNumber: 'A', irn: 'x'.repeat(64), irnAckNo: '112', irnStatus: 'registered' }),
      bill({ id: 'b', invoiceNumber: 'B', irnStatus: 'failed', irnError: '2150: Duplicate IRN' }),
      bill({ id: 'c', invoiceNumber: 'C' }),
    ]);
    const out = await getEInvoiceRegister(TENANT);
    expect(out.summary).toMatchObject({ required: 3, registered: 1, failed: 1, notSent: 1 });
    expect(out.rows.map((r) => r.status)).toEqual(['registered', 'failed', 'not_sent']);
  });

  // A patient's bill is B2C and needs no IRN at any turnover. Listing every
  // hospital bill as "missing its IRN" would be wrong and alarming.
  it('leaves B2C out entirely', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([]);
    const out = await getEInvoiceRegister(TENANT);
    const where = (prisma.bill.findMany as any).mock.calls[0][0].where;
    expect(where.recipientGstin).toEqual({ not: null });
    expect(out.rows).toHaveLength(0);
  });

  it('reports a credit note beside the invoices, because a B2B note needs an IRN too', async () => {
    (prisma.creditNote.findMany as any).mockResolvedValue([
      {
        id: 'n1', creditNoteNumber: 'CN/1', issueDate: daysAgo(10), noteType: 'credit',
        recipientGstin: RECIPIENT, taxableValue: -1000, taxAmount: -50, totalAmount: -1050,
        irn: null, irnAckNo: null, irnAckDate: null, irnStatus: null,
        irnError: null, irnAttemptedAt: null, patient: null,
      },
    ]);
    const out = await getEInvoiceRegister(TENANT);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].kind).toBe('credit_note');
  });

  // Exposure does not cancel: an unregistered credit note is not negative risk.
  it('totals magnitudes rather than netting a credit note off the register', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([bill({ totalAmount: 10_000 })]);
    (prisma.creditNote.findMany as any).mockResolvedValue([
      {
        id: 'n1', creditNoteNumber: 'CN/1', issueDate: daysAgo(10), noteType: 'credit',
        recipientGstin: RECIPIENT, taxableValue: -2000, taxAmount: 0, totalAmount: -2000,
        irn: null, irnAckNo: null, irnAckDate: null, irnStatus: null,
        irnError: null, irnAttemptedAt: null, patient: null,
      },
    ]);
    const out = await getEInvoiceRegister(TENANT);
    expect(out.summary.totalValue).toBe(12_000);
  });

  // An empty table means two opposite things and the rows cannot say which.
  it('says why it is empty rather than leaving a blank table to read as good news', async () => {
    const out = await getEInvoiceRegister(TENANT);
    expect(out.note).toMatch(/no B2B document/i);
  });
});

describe('D-2 — the failed IRN report', () => {
  it('counts what was refused and what was never sent as separate things', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ id: 'a', invoiceNumber: 'A', irnStatus: 'failed', irnError: '2150: Duplicate IRN' }),
      bill({ id: 'b', invoiceNumber: 'B' }),
    ]);
    const out = await getFailedIrnReport(TENANT);
    expect(out.summary).toMatchObject({ outstanding: 2, rejected: 1, neverSent: 1 });
  });

  it("repeats the portal's own words rather than paraphrasing them", async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ irnStatus: 'failed', irnError: '2172: For intra-state supply IGST is not applicable' }),
    ]);
    const out = await getFailedIrnReport(TENANT);
    expect(out.rows[0].reason).toBe('2172: For intra-state supply IGST is not applicable');
  });

  // The deadline is a question about NOW. Measuring it against the end of the
  // range asked for made a July invoice read as 230 days overdue merely
  // because somebody had asked for the whole financial year.
  it('measures the deadline against today, not the end of the period asked for', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([bill({ billDate: daysAgo(40) })]);
    const wholeYear = await getFailedIrnReport(TENANT, { from: '2020-04-01', to: '2099-03-31' });
    expect(wholeYear.rows[0].daysToDeadline).toBe(-10);
    expect(wholeYear.rows[0].overdue).toBe(true);
  });

  // The window is a count of calendar days ending at the close of the last one,
  // not a stopwatch started at the minute the invoice was cut. An invoice
  // raised at 09:00 used to turn red at 09:00 on its last day, while the
  // hospital still had the whole working day to file it.
  it('leaves the last day alone until IST midnight, however late in the day it is', async () => {
    // Raised 09:00 IST on 16 August. With the 30-day window the last day is
    // 15 September, and it lasts until midnight.
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ billDate: new Date('2026-08-16T09:00:00+05:30') }),
    ]);

    vi.setSystemTime(new Date('2026-09-15T23:50:00+05:30'));
    const lastDay = await getFailedIrnReport(TENANT);
    expect(lastDay.rows[0].daysToDeadline).toBe(0);
    expect(lastDay.rows[0].overdue).toBe(false);

    // Twenty minutes later, and a day late.
    vi.setSystemTime(new Date('2026-09-16T00:10:00+05:30'));
    const nextDay = await getFailedIrnReport(TENANT);
    expect(nextDay.rows[0].daysToDeadline).toBe(-1);
    expect(nextDay.rows[0].overdue).toBe(true);
  });

  // A bill raised between midnight and 05:30 IST is stored on the PREVIOUS UTC
  // date, so counting the window in UTC put every early-morning bill a day out
  // and reported it overdue while it still had a day to run.
  it("counts from the bill's IST date, not the UTC date it is stored on", async () => {
    // 02:00 IST on 1 September is 20:30Z on 31 August. The hospital's date is
    // the 1st, so the last day is 1 October.
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ billDate: new Date('2026-09-01T02:00:00+05:30') }),
    ]);
    vi.setSystemTime(new Date('2026-10-01T12:00:00+05:30'));
    const out = await getFailedIrnReport(TENANT);
    expect(out.rows[0].daysToDeadline).toBe(0);
    expect(out.rows[0].overdue).toBe(false);
  });

  it('takes the window from the hospital settings rather than compiling it in', async () => {
    PROFILE.eInvoiceUploadDays = 90;
    (prisma.bill.findMany as any).mockResolvedValue([bill({ billDate: daysAgo(40) })]);
    const out = await getFailedIrnReport(TENANT);
    expect(out.uploadDays).toBe(90);
    expect(out.rows[0].overdue).toBe(false);
  });

  it('puts the one with least time left first', async () => {
    (prisma.bill.findMany as any).mockResolvedValue([
      bill({ id: 'a', invoiceNumber: 'RECENT', billDate: daysAgo(5) }),
      bill({ id: 'b', invoiceNumber: 'OLD', billDate: daysAgo(90) }),
    ]);
    const out = await getFailedIrnReport(TENANT);
    expect(out.rows.map((r) => r.documentNumber)).toEqual(['OLD', 'RECENT']);
  });
});

describe('D-3 — the e-way bill register', () => {
  const vendorReturn = (o: Record<string, unknown> = {}) => ({
    id: 'r1', createdAt: daysAgo(10), quantity: 10, returnNumber: 'VR-1',
    status: 'processed', creditNoteNumber: null, creditAmount: 75_000,
    ewayBillNumber: null, ewayBillDate: null,
    drug: { drugName: 'Paracetamol', hsnCode: '3004' },
    supplier: { name: 'Acme', gstNumber: '27AAAAA0000A1Z5', address: 'Pune' },
    drugBatch: { purchasePrice: 100 },
    ...o,
  });

  it('lists only what crosses the threshold the hospital set', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      vendorReturn({ id: 'big', returnNumber: 'BIG', creditAmount: 75_000 }),
      vendorReturn({ id: 'small', returnNumber: 'SMALL', creditAmount: 20_000 }),
    ]);
    const out = await getEwayBillRegister(TENANT);
    expect(out.threshold).toBe(50_000);
    expect(out.summary).toMatchObject({ movements: 2, aboveThreshold: 1, missingBill: 1 });
    expect(out.rows.map((r) => r.documentNumber)).toEqual(['BIG']);
  });

  it('moves with the threshold rather than with a number in the code', async () => {
    PROFILE.eWayBillThreshold = 10_000;
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      vendorReturn({ creditAmount: 20_000 }),
    ]);
    const out = await getEwayBillRegister(TENANT);
    expect(out.summary.aboveThreshold).toBe(1);
  });

  it('counts a movement that already has a bill as covered', async () => {
    (prisma.drugReturn.findMany as any).mockResolvedValue([
      vendorReturn({ ewayBillNumber: '123456789012', ewayBillDate: daysAgo(9) }),
    ]);
    const out = await getEwayBillRegister(TENANT);
    expect(out.summary).toMatchObject({ aboveThreshold: 1, withBill: 1, missingBill: 0 });
  });

  // Only stock going back to a supplier leaves the building. A ward transfer
  // and a pharmacy issue never do.
  it('reads vendor returns and nothing else', async () => {
    await getEwayBillRegister(TENANT);
    expect((prisma.drugReturn.findMany as any).mock.calls[0][0].where.returnType).toBe('vendor_return');
  });
});
