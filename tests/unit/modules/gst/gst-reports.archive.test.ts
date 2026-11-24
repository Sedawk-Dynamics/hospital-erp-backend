import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  filePeriod,
  listFiledPeriods,
  getFiledPeriod,
  setFiledPeriodLock,
  canAmendFiledPeriod,
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
  (prisma.gstFiledPeriod.findUnique as any).mockResolvedValue(null);
  (prisma.gstFiledPeriod.create as any).mockResolvedValue({
    id: 'filed-1', filedAt: new Date('2026-10-05T00:00:00Z'), lockedAt: new Date('2026-10-05T00:00:00Z'),
  });
});

describe('filePeriod', () => {
  it('names the filing by its return period, as the portal does', async () => {
    const out = await filePeriod(TENANT, USER, PERIOD);
    expect(out.returnPeriod).toBe('092026');
    const where = (prisma.gstFiledPeriod.findUnique as any).mock.calls[0][0].where;
    expect(where.tenantId_returnPeriod).toEqual({ tenantId: TENANT, returnPeriod: '092026' });
    expect((prisma.gstFiledPeriod.create as any).mock.calls[0][0].data.returnPeriod).toBe('092026');
  });

  it('archives the return figures, not the register behind them', async () => {
    await filePeriod(TENANT, USER, PERIOD);
    const snap = (prisma.gstFiledPeriod.create as any).mock.calls[0][0].data.snapshot;
    expect(Object.keys(snap).sort()).toEqual([
      'capturedAt', 'exemptTurnover', 'gstr1', 'gstr1Json', 'gstr3b', 'hsnSummary',
      'itcReversal', 'rateSummary', 'reportingDigits',
    ]);
    // A month's register is thousands of lines; the figures filed are not.
    expect(snap).not.toHaveProperty('rows');
    expect(snap.gstr3b.outwardTaxable.taxAmount).toBe(400);
    expect(snap.exemptTurnover.exemptTurnover).toBe(100);
  });

  // Everything else in the snapshot is a total, and a total cannot answer
  // "which invoice changed" — which is the only question an amendment can be
  // built from. Only the three amendable sections are kept.
  it('keeps the document-level sections the amendment tables are built from', async () => {
    await filePeriod(TENANT, USER, PERIOD);
    const snap = (prisma.gstFiledPeriod.create as any).mock.calls[0][0].data.snapshot;
    // Null only where the capture itself failed — it is best-effort, because
    // the totals were the point of the archive before this and remain so.
    expect(snap).toHaveProperty('gstr1Json');
    if (snap.gstr1Json) {
      expect(Object.keys(snap.gstr1Json).sort()).toEqual(['b2b', 'b2cs', 'cdnr']);
    }
  });

  it('refuses a period that ends before it starts', async () => {
    await expect(filePeriod(TENANT, USER, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow(
      /ends before it starts/,
    );
  });

  // Gap item 281: filing a period LOCKS it in the same write, so the status
  // reads Filed–Locked and no new sale can be dated into it.
  it('locks the period as it files it', async () => {
    await filePeriod(TENANT, USER, PERIOD);
    const arg = (prisma.gstFiledPeriod.create as any).mock.calls[0][0];
    expect(arg.data.lockedAt).toBeInstanceOf(Date);
    expect(arg.data.lockedBy).toBe(USER);
  });

  it('refuses to file a period that has not ended yet', async () => {
    // Today in India, as the guard reads it.
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await expect(filePeriod(TENANT, USER, { from: today, to: today })).rejects.toThrow(/after it has ended/);
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

  it('returns the lock, so a locked period does not read as Open', async () => {
    (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
      {
        id: 'f1', returnPeriod: '092026', financialYear: '2026-27',
        periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30'),
        filedAt: new Date('2026-10-05'), note: null, filer: null,
        lockedAt: new Date('2026-10-05'), locker: { firstName: 'Book', lastName: 'Keeper' },
        snapshot: { gstr3b: { outwardTaxable: { taxableValue: 8000, taxAmount: 400 } } },
      },
    ]);
    const r = await listFiledPeriods(TENANT);
    expect(r.periods[0]).toMatchObject({ status: 'filed_locked', lockedBy: 'Book Keeper', outwardTax: 400, outwardTaxableValue: 8000 });
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

  // Gap item 281: filing locks; a period read back says which state it is in.
  it('says when a filed period has been re-opened', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(filed(400));
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.status).toBe('filed_open');
    expect(r.notes.join(' ')).toMatch(/filed but not locked/);
  });

  it('says a locked period cannot take new documents', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue({ ...filed(400), lockedAt: new Date() });
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.status).toBe('filed_locked');
    expect(r.notes.join(' ')).toMatch(/Filed and locked/);
  });

  it('refuses an id from another hospital rather than leaking it', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(null);
    await expect(getFiledPeriod(TENANT, 'f9')).rejects.toThrow(/has not been filed/);
    const where = (prisma.gstFiledPeriod.findFirst as any).mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
  });
});

// ── Gap 281: the amendment workflow ─────────────────────────────────────────
describe('reopening a filed period (gap 281)', () => {
  const ADMIN = { userId: USER, roles: ['admin'] };
  const lockedRow = {
    id: 'f1', tenantId: TENANT, returnPeriod: '102026',
    lockedAt: new Date('2026-11-05T00:00:00Z'), lockedBy: USER,
  };

  beforeEach(() => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue(lockedRow);
    (prisma.gstFiledPeriod.update as any).mockResolvedValue({ id: 'f1', returnPeriod: '102026', lockedAt: null });
  });

  // QA: PATCH lock with `locked: false` and no reason succeeded.
  it('refuses to unlock without a correction reason (400)', async () => {
    await expect(setFiledPeriodLock(TENANT, ADMIN, 'f1', false)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setFiledPeriodLock(TENANT, ADMIN, 'f1', false, '   ')).rejects.toThrow(/correction reason is required/);
    expect(prisma.gstFiledPeriod.update).not.toHaveBeenCalled();
    expect(prisma.gstFiledPeriodHistory.create).not.toHaveBeenCalled();
  });

  it('refuses to unlock for a role without the amendment right (403)', async () => {
    const cashier = { userId: USER, roles: ['front_desk', 'cashier'] };
    await expect(setFiledPeriodLock(TENANT, cashier, 'f1', false, 'Wrong rate on INV/7')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(prisma.gstFiledPeriod.update).not.toHaveBeenCalled();
  });

  it('lets admin and billing admin reopen, nobody else', () => {
    expect(canAmendFiledPeriod(['admin'])).toBe(true);
    expect(canAmendFiledPeriod(['billing_admin'])).toBe(true);
    expect(canAmendFiledPeriod(['super_admin'])).toBe(true);
    expect(canAmendFiledPeriod(['front_desk', 'insurance_staff'])).toBe(false);
    expect(canAmendFiledPeriod([])).toBe(false);
  });

  it('records the reopen in the history and the audit log with user, reason and period', async () => {
    await setFiledPeriodLock(TENANT, ADMIN, 'f1', false, 'INV-7 billed at 12% instead of 5%');
    expect((prisma.gstFiledPeriod.update as any).mock.calls[0][0].data).toEqual({ lockedAt: null, lockedBy: null });
    const hist = (prisma.gstFiledPeriodHistory.create as any).mock.calls[0][0].data;
    expect(hist).toMatchObject({
      tenantId: TENANT, filedPeriodId: 'f1', returnPeriod: '102026', action: 'unlocked',
      reason: 'INV-7 billed at 12% instead of 5%', userId: USER,
    });
    const audit = (prisma.auditLog.create as any).mock.calls[0][0].data;
    expect(audit).toMatchObject({ tenantId: TENANT, userId: USER, entityType: 'gst_filed_period', entityId: 'f1' });
    expect(audit.description).toMatch(/Oct 2026 reopened for correction/);
    expect(audit.description).toMatch(/Reason: INV-7 billed at 12% instead of 5%/);
  });

  it('never touches the original snapshot when reopening', async () => {
    await setFiledPeriodLock(TENANT, ADMIN, 'f1', false, 'Correction');
    expect((prisma.gstFiledPeriod.update as any).mock.calls[0][0].data).not.toHaveProperty('snapshot');
  });

  it('locks again without needing a reason', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue({ ...lockedRow, lockedAt: null });
    (prisma.gstFiledPeriod.update as any).mockResolvedValue({ id: 'f1', returnPeriod: '102026', lockedAt: new Date() });
    const out = await setFiledPeriodLock(TENANT, { userId: USER, roles: ['front_desk'] }, 'f1', true);
    expect(out.lockedAt).toBeInstanceOf(Date);
    expect((prisma.gstFiledPeriodHistory.create as any).mock.calls[0][0].data.action).toBe('locked');
  });
});

describe('re-filing a period (gap 281)', () => {
  const ORIGINAL = { id: 'f1', lockedAt: null, periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30') };

  beforeEach(() => {
    (prisma.gstFiledPeriod.findUnique as any).mockResolvedValue(ORIGINAL);
    (prisma.gstFiledPeriodHistory.count as any).mockResolvedValue(0);
    (prisma.gstFiledPeriod.update as any).mockResolvedValue({ id: 'f1', filedAt: new Date('2026-10-05'), lockedAt: new Date() });
  });

  it('keeps the original filed snapshot and stores the correction as version 2', async () => {
    const out = await filePeriod(TENANT, USER, { ...PERIOD, reason: 'Room rent rate corrected' }, ['billing_admin']);
    expect(out).toMatchObject({ correction: true, version: 2, id: 'f1' });
    // The original row is never re-created or overwritten...
    expect(prisma.gstFiledPeriod.create).not.toHaveBeenCalled();
    expect(prisma.gstFiledPeriod.upsert).not.toHaveBeenCalled();
    const upd = (prisma.gstFiledPeriod.update as any).mock.calls[0][0];
    expect(Object.keys(upd.data).sort()).toEqual(['lockedAt', 'lockedBy']);
    // ...and the corrected figures go into the history, versioned.
    const hist = (prisma.gstFiledPeriodHistory.create as any).mock.calls[0][0].data;
    expect(hist).toMatchObject({ action: 'refiled', version: 2, reason: 'Room rent rate corrected', userId: USER });
    expect(hist.snapshot.gstr3b.outwardTaxable.taxAmount).toBe(400);
    const audit = (prisma.auditLog.create as any).mock.calls[0][0].data;
    expect(audit.description).toMatch(/re-filed as correction version 2; original filed snapshot preserved/);
    expect(audit.description).toMatch(/Reason: Room rent rate corrected/);
  });

  it('numbers a further correction after the ones before it', async () => {
    (prisma.gstFiledPeriodHistory.count as any).mockResolvedValue(2);
    const out = await filePeriod(TENANT, USER, { ...PERIOD, reason: 'Third pass' }, ['admin']);
    expect(out.version).toBe(4);
  });

  it('refuses a correction without a reason', async () => {
    await expect(filePeriod(TENANT, USER, PERIOD, ['admin'])).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.gstFiledPeriodHistory.create).not.toHaveBeenCalled();
  });

  it('refuses a correction from a role without the amendment right', async () => {
    await expect(filePeriod(TENANT, USER, { ...PERIOD, reason: 'x' }, ['front_desk'])).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses to re-file a period that is still locked — it has to be reopened first', async () => {
    (prisma.gstFiledPeriod.findUnique as any).mockResolvedValue({ ...ORIGINAL, lockedAt: new Date() });
    await expect(filePeriod(TENANT, USER, { ...PERIOD, reason: 'Fix' }, ['admin'])).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('the filed-period trail (gap 281)', () => {
  it('shows the original as version 1 and every reopen and correction after it', async () => {
    (prisma.gstFiledPeriod.findFirst as any).mockResolvedValue({
      id: 'f1', returnPeriod: '092026', financialYear: '2026-27',
      periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30'),
      filedAt: new Date('2026-10-05'), filedBy: USER, note: null, lockedAt: new Date('2026-10-20'),
      filer: { firstName: 'Book', lastName: 'Keeper' },
      snapshot: { gstr3b: { outwardTaxable: { taxAmount: 400 } } },
      history: [
        { id: 'h1', action: 'unlocked', version: null, reason: 'Rate error', userId: USER, createdAt: new Date('2026-10-10') },
        {
          id: 'h2', action: 'refiled', version: 2, reason: 'Rate error', userId: USER, createdAt: new Date('2026-10-20'),
          snapshot: { gstr3b: { outwardTaxable: { taxAmount: 380 } } },
        },
      ],
    });
    (prisma.user.findMany as any).mockResolvedValue([{ id: USER, firstName: 'Book', lastName: 'Keeper' }]);
    const r = await getFiledPeriod(TENANT, 'f1');
    expect(r.filed.outwardTax).toBe(400); // the original, not the correction
    expect(r.versions).toBe(2);
    expect(r.history.map((h) => h.action)).toEqual(['filed', 'unlocked', 'refiled']);
    expect(r.history[1]).toMatchObject({ reason: 'Rate error', by: 'Book Keeper' });
    expect(r.latestCorrection?.figures.outwardTax).toBe(380);
  });
});
