import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getGstr1Amendments } from '../../../../src/modules/gst/gst-reports.amendments';

const TENANT = 'tenant-1';
const CTIN = '24AAACC1206D1ZM';

// What the file builder would return TODAY for a period being compared. Set
// per test; the amendment is whatever this disagrees with in the snapshot.
let today: Record<string, unknown> = {};

vi.mock('../../../../src/modules/gst/gst-reports.gstr1-json', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildGstr1Json: vi.fn(async () => ({ json: today, warnings: [] })),
  };
});

const inv = (o: Record<string, unknown> = {}) => ({
  inum: 'TI/1', idt: '03-09-2026', val: 10_000, pos: '27',
  itms: [{ num: 1, itm_det: { rt: 5, txval: 10_000, camt: 250, samt: 250, iamt: 0, csamt: 0 } }],
  ...o,
});

/** A filed period whose snapshot carries the document sections. */
function filedPeriod(sections: Record<string, unknown>, o: Record<string, unknown> = {}) {
  return {
    id: 'f1', returnPeriod: '092026',
    periodFrom: new Date('2026-09-01T00:00:00Z'),
    periodTo: new Date('2026-09-30T00:00:00Z'),
    filedAt: new Date('2026-10-05T00:00:00Z'),
    lockedAt: null,
    snapshot: { capturedAt: '2026-10-05', gstr1Json: sections },
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  today = {};
  (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([]);
});

describe('getGstr1Amendments', () => {
  // An amendment is a change to a return that has already gone in. Until one
  // has, corrections are simply edits — and saying "0 amendments" would imply
  // the question had been asked and answered.
  it('distinguishes having nothing to amend from having filed nothing', async () => {
    const out = await getGstr1Amendments(TENANT);
    expect(out.summary.amendments).toBe(0);
    expect(out.note).toMatch(/No period has been filed yet/);
  });

  // The difference between "nothing changed" and "nothing to compare against"
  // is the whole value of this report.
  it('refuses to call a period clean when its snapshot cannot be compared', async () => {
    (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
      { ...filedPeriod({}), snapshot: { capturedAt: '2026-10-05' } },
    ]);
    const out = await getGstr1Amendments(TENANT);
    expect(out.summary.comparablePeriods).toBe(0);
    expect(out.periods[0].comparable).toBe(false);
    expect(out.periods[0].note).toMatch(/nothing to compare against/);
    expect(out.note).toMatch(/predates the document-level snapshot/);
  });

  it('reports nothing when today still matches what went in', async () => {
    const sections = { b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] };
    (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([filedPeriod(sections)]);
    today = sections;
    const out = await getGstr1Amendments(TENANT);
    expect(out.summary.amendments).toBe(0);
    expect(out.note).toMatch(/still matches what went in/);
  });

  describe('table 9A — B2B invoices', () => {
    it('finds an invoice whose value has moved since filing', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] }),
      ]);
      today = { b2b: [{ ctin: CTIN, inv: [inv({ val: 11_000 })] }], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.summary.table9A).toBe(1);
      expect(out.rows[0]).toMatchObject({
        table: '9A', change: 'amended', originalNumber: 'TI/1',
        filedValue: 10_000, currentValue: 11_000, difference: 1000,
      });
    });

    // The pair the portal matches on is the ORIGINAL number and date; the rest
    // of the entry is the invoice as it stands today.
    it('tags the amendment with the number and date it was filed under', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] }),
      ]);
      today = { b2b: [{ ctin: CTIN, inv: [inv({ val: 11_000 })] }], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.sections.b2ba).toEqual([
        { ctin: CTIN, inv: [expect.objectContaining({ val: 11_000, oinum: 'TI/1', oidt: '03-09-2026' })] },
      ]);
    });

    it('notices a change in tax even where the invoice value did not move', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] }),
      ]);
      today = {
        b2b: [{ ctin: CTIN, inv: [inv({ itms: [{ num: 1, itm_det: { rt: 18, txval: 10_000, camt: 900, samt: 900 } }] })] }],
        b2cs: [], cdnr: [],
      };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0]).toMatchObject({ table: '9A', filedTax: 500, currentTax: 1800, difference: 0 });
    });

    it('calls out a recipient GSTIN that has changed, and says so', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] }),
      ]);
      today = { b2b: [{ ctin: '29AAACC1206D1ZM', inv: [inv()] }], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0].reason).toMatch(/recipient GSTIN changed/);
    });

    // There is nothing to amend it TO, and a fabricated zero-value invoice
    // with empty rate blocks is a row the portal rejects.
    it('reports a vanished invoice but keeps it out of the file', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] }),
      ]);
      today = { b2b: [], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0]).toMatchObject({ change: 'removed', currentValue: null, difference: -10_000 });
      expect(out.sections.b2ba).toEqual([]);
      expect(out.sections.vanished).toEqual(['TI/1 (092026)']);
    });

    // Not an amendment: there is no original row to replace, so it goes into
    // the current return's ordinary b2b section instead.
    it('flags a late invoice as missing from the return rather than as an amendment', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [], b2cs: [], cdnr: [] }),
      ]);
      today = { b2b: [{ ctin: CTIN, inv: [inv()] }], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0]).toMatchObject({ change: 'added', filedValue: null });
      expect(out.rows[0].reason).toMatch(/missing invoice rather than an amendment/);
      expect(out.sections.b2ba).toEqual([]);
    });
  });

  describe('table 10 — B2C, amended in aggregate', () => {
    const b2cs = (o: Record<string, unknown> = {}) => ({
      sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 5, txval: 1000,
      camt: 25, samt: 25, iamt: 0, csamt: 0, ...o,
    });

    it('compares the total for the state and rate, not the bills behind it', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [], b2cs: [b2cs()], cdnr: [] }),
      ]);
      today = { b2b: [], b2cs: [b2cs({ txval: 1500 })], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0]).toMatchObject({ table: '10', originalNumber: '27 @ 5%', difference: 500 });
      expect(out.sections.b2csa[0]).toMatchObject({ txval: 1500, omon: '092026' });
    });

    // Unlike an invoice, an aggregate of zero is a legitimate figure — it is
    // how the portal is told the supplies were removed.
    it('declares a row that has gone to nothing, at zero', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [], b2cs: [b2cs()], cdnr: [] }),
      ]);
      today = { b2b: [], b2cs: [], cdnr: [] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.rows[0]).toMatchObject({ table: '10', change: 'removed', difference: -1000 });
      expect(out.sections.b2csa[0]).toMatchObject({ pos: '27', rt: 5, txval: 0, omon: '092026' });
    });
  });

  describe('table 9C — credit and debit notes', () => {
    const nt = (o: Record<string, unknown> = {}) => ({
      ntty: 'C', nt_num: 'CN/1', nt_dt: '10-09-2026', val: 2000, pos: '27', ...o,
    });

    it('finds a note whose value has moved, and carries the original number', async () => {
      (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
        filedPeriod({ b2b: [], b2cs: [], cdnr: [{ ctin: CTIN, nt: [nt()] }] }),
      ]);
      today = { b2b: [], b2cs: [], cdnr: [{ ctin: CTIN, nt: [nt({ val: 2500 })] }] };
      const out = await getGstr1Amendments(TENANT);
      expect(out.summary.table9C).toBe(1);
      expect(out.sections.cdnra[0].nt[0]).toMatchObject({ val: 2500, ont_num: 'CN/1', ont_dt: '10-09-2026' });
    });
  });

  // A return cannot amend itself: the month being prepared is reported in the
  // ordinary tables, and an amendment row for it would declare the supply twice.
  it('can be told to leave the period being filed out of the comparison', async () => {
    await getGstr1Amendments(TENANT, { excludePeriod: '092026' });
    const where = (prisma.gstFiledPeriod.findMany as any).mock.calls[0][0].where;
    expect(where.returnPeriod).toEqual({ not: '092026' });
  });
});
