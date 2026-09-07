import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  filePeriod,
  listFiledPeriods,
  getFiledPeriod,
} from '../../../../src/modules/gst/gst-reports.archive';

const TENANT = 'tenant-1';
const USER = 'user-1';

function billWith(items: Array<Record<string, unknown>>) {
  return {
    id: 'bill-1', billNumber: 'BILL-1', invoiceNumber: 'TI/2026-27/000001',
    gstDocumentType: 'tax_invoice', billDate: new Date('2026-09-03T00:00:00Z'),
    status: 'paid', financialYear: '2026-27', admissionId: null,
    recipientGstin: null, placeOfSupplyStateCode: '27', isInterState: false,
    patient: { id: 'p1', mrn: 'M', firstName: 'Asha', lastName: 'Rao' },
    generator: null,
    billItems: items.map((o, i) => ({
      id: `it-${i}`, description: 'Charge', category: 'other', quantity: 1,
      unitPrice: 100, discountAmount: 0, taxPercent: 0, taxableValue: 100,
      taxAmount: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0,
      totalAmount: 100, hsnSacCode: '999311', gstTreatment: 'exempt',
      rateSource: 'sac_master', requiresTaxResolution: false,
      createdAt: new Date('2026-09-03T00:00:00Z'), ...o,
    })),
  };
}

const TAXED = {
  category: 'room', unitPrice: 8000, taxPercent: 5, taxableValue: 8000,
  taxAmount: 400, cgstAmount: 200, sgstAmount: 200, totalAmount: 8400,
  hsnSacCode: '996311', gstTreatment: 'taxable',
};

const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.bill.findMany as any).mockResolvedValue([billWith([TAXED, {}])]);
  (prisma.creditNote.findMany as any).mockResolvedValue([]);
  (prisma.payment.findMany as any).mockResolvedValue([]);
  (prisma.drugBatch.findMany as any).mockResolvedValue([]);
  (prisma.gstFiledPeriod.upsert as any).mockResolvedValue({
    id: 'filed-1', filedAt: new Date('2026-10-05T00:00:00Z'),
  });
});

describe('filePeriod', () => {
  it('names the filing by its return period, as the portal does', async () => {
    const out = await filePeriod(TENANT, USER, PERIOD);
    expect(out.returnPeriod).toBe('092026');
    const arg = (prisma.gstFiledPeriod.upsert as any).mock.calls[0][0];
    expect(arg.where.tenantId_returnPeriod).toEqual({ tenantId: TENANT, returnPeriod: '092026' });
  });

  // There is only ever one answer to "what did you file for September" — a
  // revised return is still that one answer.
  it('replaces an earlier filing of the same month rather than adding a second', async () => {
    await filePeriod(TENANT, USER, PERIOD);
    const arg = (prisma.gstFiledPeriod.upsert as any).mock.calls[0][0];
    expect(arg.update).toBeDefined();
    expect(arg.update.snapshot).toBeDefined();
    expect(arg.update.filedBy).toBe(USER);
  });

  it('archives the return figures, not the register behind them', async () => {
    await filePeriod(TENANT, USER, PERIOD);
    const snap = (prisma.gstFiledPeriod.upsert as any).mock.calls[0][0].create.snapshot;
    expect(Object.keys(snap).sort()).toEqual([
      'capturedAt', 'exemptTurnover', 'gstr1', 'gstr3b', 'hsnSummary', 'itcReversal',
      'rateSummary', 'reportingDigits',
    ]);
    // A month's register is thousands of lines; the figures filed are not.
    expect(snap).not.toHaveProperty('rows');
    expect(snap.gstr3b.outwardTaxable.taxAmount).toBe(400);
    expect(snap.exemptTurnover.exemptTurnover).toBe(100);
  });

  it('refuses a period that ends before it starts', async () => {
    await expect(filePeriod(TENANT, USER, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow(
      /ends before it starts/,
    );
  });

  it('refuses a period with an unusable date', async () => {
    await expect(filePeriod(TENANT, USER, { from: 'not-a-date', to: '2026-09-30' })).rejects.toThrow(
      /valid from and to date/,
    );
  });
});

describe('listFiledPeriods', () => {
  it('lifts the headline figures out so the list answers the question', async () => {
    (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
      {
        id: 'f1', returnPeriod: '092026', financialYear: '2026-27',
        periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30'),
        filedAt: new Date('2026-10-05'), note: null,
        filer: { firstName: 'Book', lastName: 'Keeper' },
        snapshot: {
          gstr3b: { outwardTaxable: { taxAmount: 400 }, netTaxPayable: 400 },
          exemptTurnover: { exemptTurnover: 100 },
          gstr1: { reconciliation: { register: { agrees: true } } },
        },
      },
    ]);
    const r = await listFiledPeriods(TENANT);
    expect(r.periods[0]).toMatchObject({
      returnPeriod: '092026',
      outwardTax: 400,
      netTaxPayable: 400,
      exemptTurnover: 100,
      reconciled: true,
      filedBy: 'Book Keeper',
    });
  });

  it('survives a snapshot that predates a figure it looks for', async () => {
    (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
      {
        id: 'f1', returnPeriod: '082026', financialYear: '2026-27',
        periodFrom: new Date('2026-08-01'), periodTo: new Date('2026-08-31'),
        filedAt: new Date('2026-09-05'), note: null, filer: null, snapshot: {},
      },
    ]);
    const r = await listFiledPeriods(TENANT);
    expect(r.periods[0]).toMatchObject({ outwardTax: 0, reconciled: false, filedBy: null });
  });
});

describe('getFiledPeriod', () => {
  const filed = (taxAsFiled: number) => ({
    id: 'f1', returnPeriod: '092026', financialYear: '2026-27',
    periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30'),
    filedAt: new Date('2026-10-05'), note: 'September',
    filer: { firstName: 'Book', lastName: 'Keeper' },
    snapshot: { gstr3b: { outwardTaxable: { taxAmount: taxAsFiled } } },
  });

  it('says the figures have not moved when they have not', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(filed(400));
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.drift).toMatchObject({ outwardTaxAsFiled: 400, outwardTaxNow: 400, moved: false });
  });

  // The whole reason the archive exists: a bill in a filed month moved after
  // the return went in, and nothing else would have noticed.
  it('detects that a bill moved after the return went in', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(filed(250));
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.drift).toMatchObject({ outwardTaxAsFiled: 250, outwardTaxNow: 400, difference: 150, moved: true });
    expect(r.notes.join(' ')).toMatch(/correction belongs in the current month as a credit note/);
  });

  it('always says filing does not lock the period', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(filed(400));
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.notes.join(' ')).toMatch(/does not lock the period/);
  });

  it('refuses an id from another hospital rather than leaking it', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(null);
    await expect(getFiledPeriod(TENANT, 'f9')).rejects.toThrow(/has not been filed/);
    const where = (prisma.gstFiledPeriod.findFirst as any).mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
  });
});
