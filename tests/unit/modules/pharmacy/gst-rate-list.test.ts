import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { clearGstSlabCache } from '../../../../src/shared/gst-slabs';
import {
  applyGstRateList, listRetiredGstRates, parseEffectiveFrom, parseRate, previewGstRateList,
} from '../../../../src/modules/pharmacy/gst-rate-list.service';

// Gap #262 — the list of medicines still on a retired rate, and the import that
// loads the rates the client supplies. Nothing here invents a rate.

const T = 'tenant-1';
const U = 'user-1';
const ROLES = ['pharmacy_admin'];
const p = prisma as any;

const drug = (over: Record<string, unknown>) => ({
  strength: null, manufacturer: null, category: 'drug', hsnCode: '30049099', taxPercent: 12, gstTreatment: null, gtin: null,
  casePackGtin: null, manufacturerCode: null, isActive: true, packSize: 10, looseUnitLabel: 'Tablet', unitOfMeasurement: 'Strip',
  dosageForm: 'tablet', ...over,
});

const DRUGS = [
  drug({ id: 'old', drugName: 'Oldcillin', strength: '500mg', gtin: '8901234567894' }),
  drug({ id: 'old2', drugName: 'Oldmycin' }),
  drug({ id: 'ten', drugName: 'Tenpercent', taxPercent: 10, hsnCode: null }),
  drug({ id: 'ok', drugName: 'Finemol', taxPercent: 5 }),
  drug({ id: 'nutra', drugName: 'Proteinax', taxPercent: 18 }),
  drug({ id: 'exempt', drugName: 'Freevax', taxPercent: 0, gstTreatment: 'exempt' }),
  drug({ id: 'byhsn', drugName: 'Defaulted', taxPercent: null, hsnCode: '90189099', looseUnitLabel: null, packSize: null, unitOfMeasurement: 'Piece' }),
  drug({ id: 'twinA', drugName: 'Twin', manufacturer: 'Cipla', taxPercent: 5 }),
  drug({ id: 'twinB', drugName: 'Twin', manufacturer: 'Sun', taxPercent: 5 }),
];

const SLABS = [
  { ratePercent: 12, effectiveFrom: new Date('2017-07-01'), effectiveTo: new Date('2025-09-21') },
  ...[0, 5, 18, 40].map((r) => ({ ratePercent: r, effectiveFrom: new Date('2025-09-22'), effectiveTo: null })),
].map((s) => ({ label: `${s.ratePercent}%`, note: null, ...s }));

beforeEach(() => {
  vi.clearAllMocks();
  clearGstSlabCache();
  p.gstSlab.findMany.mockResolvedValue(SLABS);
  p.hsnGstRate.findMany.mockResolvedValue([
    { hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: null },
    { hsnCode: '9018', gstRate: 12, treatment: 'taxable', description: null },
  ]);
  p.gstCategoryDefault.findMany.mockResolvedValue([]);
  p.drugFormulary.findMany.mockResolvedValue(DRUGS);
  p.drugFormulary.findFirst.mockImplementation(async ({ where }: any) => DRUGS.find((d: any) => d.id === where.id) ?? null);
  p.drugFormulary.updateMany.mockResolvedValue({ count: 1 });
  p.drugBatch.groupBy.mockResolvedValue([{ drugId: 'old', _sum: { quantityInStock: 45 } }]);
});

const preview = (rows: any[]) => previewGstRateList(T, ROLES, { rows: rows.map((r, i) => ({ rowNumber: i + 2, ...r })) });
const future = '01/04/2099';

describe('262 — medicines with a retired GST rate', () => {
  it('lists drug, HSN, rate, stock and where the rate comes from', async () => {
    const r = await listRetiredGstRates(T, ROLES);
    expect(r.allowed).toBe('0%, 5%, 18% or 40%');
    expect(r.items.map((i) => i.drugId)).toEqual(['old', 'byhsn', 'old2', 'ten']); // in stock first
    expect(r.items[0]).toMatchObject({
      drugName: 'Oldcillin', hsnCode: '30049099', ratePercent: 12, sourceLabel: 'Set on the medicine',
      reason: 'Retired — last legal on 21/09/2025', stockOnHand: 45, stockText: '4 strips + 5 tablets (45 tablets)',
    });
    expect(r.items.find((i) => i.drugId === 'byhsn')).toMatchObject({ ratePercent: 12, sourceLabel: 'HSN default (9018)' });
    expect(r.items.find((i) => i.drugId === 'ten')!.reason).toBe('Not a GST rate');
    expect(r).toMatchObject({ total: 4, inStock: 1 });
  });

  it('is limited to the roles that may edit medicine GST rates', async () => {
    for (const role of ['admin', 'super_admin', 'pharmacy_admin', 'inventory_manager', 'billing_admin']) {
      await expect(listRetiredGstRates(T, [role])).resolves.toBeTruthy();
    }
    for (const role of ['pharmacist', 'cashier', 'front_desk', 'nurse']) {
      await expect(listRetiredGstRates(T, [role])).rejects.toThrow(/Only a pharmacy admin/);
      await expect(previewGstRateList(T, [role], { rows: [] })).rejects.toThrow(/Only a pharmacy admin/);
      await expect(applyGstRateList(T, U, [role], { reason: 'x', rows: [] })).rejects.toThrow(/Only a pharmacy admin/);
    }
  });
});

describe('262 — rate list preview', () => {
  it('matches by code, by name and by name + strength, and writes nothing', async () => {
    const r = await preview([
      { drugCode: '08901234567894', gstPercent: '5%' },
      { drugName: ' oldmycin ', gstPercent: 5 },
      { drugName: 'Tenpercent', gstPercent: 'Nil' },
    ]);
    expect(r.rows.map((x) => [x.status, x.matchedBy])).toEqual([['ready', 'code'], ['ready', 'name'], ['ready', 'name']]);
    expect(r.rows[0]!.changes[0]).toMatchObject({ drugId: 'old', currentRate: 12, newRate: 5, stockText: '4 strips + 5 tablets (45 tablets)' });
    // A nil rate is recorded as nil-rated; a bare 0 would fall to the HSN default.
    expect(r.rows[2]!.changes[0]).toMatchObject({ newRate: 0, newTreatment: 'nil_rated' });
    expect(r.summary).toMatchObject({ ready: 3, medicines: 3 });
    expect(r.notCovered.map((d) => d.drugId)).toEqual(['byhsn']);
    expect(p.drugFormulary.updateMany).not.toHaveBeenCalled();
    expect((await preview([{ drugName: 'Oldcillin 500mg', gstPercent: 5 }])).rows[0]!.status).toBe('ready');
  });

  it('lists what it could not match instead of guessing', async () => {
    const r = await preview([
      { drugName: 'Nosuchdrug', gstPercent: 5 },
      { drugName: 'Twin', gstPercent: 18 },
      { drugCode: 'ABC12', drugName: 'Alsomissing', hsnCode: '3004', gstPercent: 5 },
      { hsnCode: '2106', gstPercent: 5 },
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(['unmatched', 'unmatched', 'unmatched', 'unmatched']);
    expect(r.rows[1]!.message).toMatch(/2 medicines match: Twin \(Cipla\); Twin \(Sun\)/);
    // An unmatched medicine never falls back to re-rating its whole heading.
    expect(r.rows[2]!.changes).toEqual([]);
  });

  it('rejects rates and dates that cannot be used, naming the slabs', async () => {
    const r = await preview([
      { drugName: 'Oldcillin', gstPercent: 12 },
      { drugName: 'Oldmycin', gstPercent: 'five' },
      { drugName: 'Oldmycin', gstPercent: '' },
      { drugName: 'Oldmycin', gstPercent: 5, effectiveFrom: '31/02/2026' },
      { gstPercent: 5 },
      { drugName: 'Freevax', gstPercent: 5 },
      { drugName: 'Oldcillin', hsnCode: '9018', gstPercent: 5 },
    ]);
    expect(r.rows.every((x) => x.status === 'error')).toBe(true);
    expect(r.rows[0]!.message).toMatch(/12% is not a legal GST rate on \d\d\/\d\d\/\d{4}\. Allowed: 0%, 5%, 18% or 40%/);
    expect(r.rows[3]!.message).toMatch(/not a date/);
    expect(r.rows[5]!.message).toMatch(/marked exempt/);
    expect(r.rows[6]!.message).toMatch(/has HSN 30049099, the file says 9018/);
  });

  it('12% with a start date when it was legal is still refused: the rate applies from now', async () => {
    expect((await preview([{ drugName: 'Finemol', gstPercent: 12, effectiveFrom: '01/06/2025' }])).rows[0]!.status).toBe('error');
  });

  it('holds a future-dated row and explains why', async () => {
    const r = await preview([{ drugName: 'Oldcillin', gstPercent: 5, effectiveFrom: future }]);
    expect(r.rows[0]!.status).toBe('not_due');
    expect(r.rows[0]!.message).toMatch(/one current rate with no start date/);
    expect(r.effectiveDateNote).toMatch(/future date is not stored/);
  });

  it('an HSN row reaches only medicines on a retired rate, after the named rows', async () => {
    const r = await preview([
      { hsnCode: '3004', gstPercent: 5 },
      { drugName: 'Oldcillin', gstPercent: 18 },
    ]);
    expect(r.rows[0]!.changes.map((c) => c.drugId)).toEqual(['old2']); // not old (own row), not nutra at 18%, not ok at 5%
    expect(r.rows[1]!.changes[0]).toMatchObject({ drugId: 'old', newRate: 18 });
  });

  it('refuses two rows that set one medicine differently', async () => {
    const r = await preview([
      { drugName: 'Oldcillin', gstPercent: 5 }, { drugCode: '8901234567894', gstPercent: 18 }, { drugName: 'Finemol', gstPercent: 5 },
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(['ready', 'error', 'unchanged']);
    expect(r.rows[1]!.message).toMatch(/Row 2 sets Oldcillin to 5%/);
  });

  it('parses the ways people write a rate and a date', () => {
    expect([parseRate('5%'), parseRate(' 18 '), parseRate('nil'), parseRate('5.5'), parseRate('-5'), parseRate('abc')]).toEqual([5, 18, 0, 5.5, null, null]);
    expect([parseEffectiveFrom('22/09/2025'), parseEffectiveFrom('2025-9-22'), parseEffectiveFrom('22.09.2025'), parseEffectiveFrom('13/13/2025')])
      .toEqual(['2025-09-22', '2025-09-22', '2025-09-22', null]);
    expect(parseEffectiveFrom('')).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

describe('262 — applying the confirmed rows', () => {
  const apply = (rows: any[], reason = 'Client list of 25/11/2026') => applyGstRateList(T, U, ROLES, { reason, rows });

  it('writes only the rows sent, logs the rate change with its reason, and audits it', async () => {
    const r = await apply([{ drugId: 'old', gstPercent: 5, expectedRate: 12, effectiveFrom: '22/09/2025', rowNumber: 2 }]);
    expect(r).toMatchObject({ appliedCount: 1, skippedCount: 0 });
    expect(p.drugFormulary.updateMany).toHaveBeenCalledTimes(1);
    expect(p.drugFormulary.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'old', tenantId: T, taxPercent: 12 },
      data: { taxPercent: 5, gstRateReason: 'Client list of 25/11/2026' },
    });
    expect(p.gstItemRateChange.create.mock.calls[0][0].data).toMatchObject({
      itemType: 'drug', itemId: 'old', previousRate: 12, newRate: 5, changedBy: U,
      reason: 'Client list of 25/11/2026 (rate list, effective from 22/09/2025)',
    });
    expect(p.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: T, userId: U, entityType: 'drug_formulary', entityId: 'old',
      oldValues: { taxPercent: 12, gstTreatment: null },
    });
    // No issued document is touched.
    for (const m of [p.billItem.update, p.billItem.updateMany, p.bill.update, p.drugBatch.update, p.drugBatch.updateMany]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it('re-checks every row: stale, illegal, future, exempt, missing, repeated', async () => {
    const r = await apply([
      { drugId: 'old', gstPercent: 5, expectedRate: 18 },
      { drugId: 'old2', gstPercent: 12, expectedRate: 12 },
      { drugId: 'ten', gstPercent: 5, expectedRate: 10, effectiveFrom: future },
      { drugId: 'exempt', gstPercent: 5, expectedRate: 0 },
      { drugId: 'gone', gstPercent: 5, expectedRate: null },
      { drugId: 'old', gstPercent: 5, expectedRate: 12 },
    ]);
    expect(r.appliedCount).toBe(0);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/Changed to 12% since the preview/),
      expect.stringMatching(/12% is not a legal GST rate/),
      expect.stringMatching(/Import this row again/),
      expect.stringMatching(/marked exempt/),
      'No longer in the medicine list.',
      'Listed twice.',
    ]);
    expect(p.drugFormulary.updateMany).not.toHaveBeenCalled();
  });

  it('a concurrent edit wins, and a nil rate is stored as nil-rated', async () => {
    p.drugFormulary.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await apply([
      { drugId: 'old', gstPercent: 5, expectedRate: 12 },
      { drugId: 'old2', gstPercent: 0, expectedRate: 12 },
    ]);
    expect(r.skipped[0]!.reason).toMatch(/Edited by somebody else/);
    expect(p.drugFormulary.updateMany.mock.calls[1][0].data).toMatchObject({ taxPercent: 0, gstTreatment: 'nil_rated', gstTreatmentSource: 'manual' });
  });

  it('needs a reason and at least one row', async () => {
    await expect(apply([{ drugId: 'old', gstPercent: 5, expectedRate: 12 }], '  ')).rejects.toThrow(/reason/);
    await expect(apply([])).rejects.toThrow(/at least one row/);
  });
});
