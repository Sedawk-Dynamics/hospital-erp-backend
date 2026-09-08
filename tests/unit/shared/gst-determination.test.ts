import { describe, it, expect } from 'vitest';
import {
  determineTax,
  roomTaxRate,
  isCriticalCareAccommodation,
  ROOM_GST_THRESHOLD_PER_DAY,
  ROOM_ACCOMMODATION_SAC,
  type SupplyContext,
  type TaxMasters,
} from '../../../src/shared/gst-determination';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../src/shared/gst-profile';

const REGISTERED = mergeGstProfile(DEFAULT_GST_PROFILE, {
  gstin: '27AAPFU0939F1ZV',
  registered: true,
});

const ON = new Date('2026-09-02T06:00:00.000Z');

const masters = (over: Partial<TaxMasters> = {}): TaxMasters => ({
  profile: REGISTERED,
  ...over,
});

const ctx = (over: Partial<SupplyContext> = {}): SupplyContext => ({
  kind: 'medicine',
  on: ON,
  ...over,
});

describe('critical care', () => {
  it('recognises the units that are exempt at any rate', () => {
    expect(isCriticalCareAccommodation('icu', null)).toBe(true);
    expect(isCriticalCareAccommodation(null, 'nicu')).toBe(true);
    expect(isCriticalCareAccommodation(null, 'picu')).toBe(true);
    // A coronary care unit recorded as free text would otherwise be taxed on
    // rent that is plainly exempt.
    expect(isCriticalCareAccommodation('CCU', null)).toBe(true);
    expect(isCriticalCareAccommodation('standard', 'general')).toBe(false);
  });
});

describe('roomTaxRate — preserved behaviour', () => {
  it('exempts a bed at or below the threshold', () => {
    expect(roomTaxRate(1500)).toBe(0);
    expect(roomTaxRate(ROOM_GST_THRESHOLD_PER_DAY)).toBe(0);
  });

  it('charges the statutory rate a rupee above the threshold', () => {
    expect(roomTaxRate(5001)).toBe(5);
  });

  it('exempts critical care however expensive', () => {
    expect(roomTaxRate(12000, { wardType: 'icu', bedType: 'icu' })).toBe(0);
  });

  it('honours a configured rate once over the threshold', () => {
    expect(roomTaxRate(7500, { configuredRate: 12 })).toBe(12);
  });

  // The regression this rule exists for: a hospital whose room tariffs are
  // mostly deluxe at 5% must not have that 5% applied to a cheap ward bed.
  it('does not let a taxable tariff spill onto a cheap bed', () => {
    expect(roomTaxRate(1200, { configuredRate: 5 })).toBe(0);
  });
});

describe('determineTax — the hospital is not charging GST', () => {
  it('exempts everything when the hospital is not registered', () => {
    const d = determineTax(ctx({ hsnCode: '3004', itemRatePercent: 5, itemTreatment: 'taxable' }), {
      profile: DEFAULT_GST_PROFILE,
    });
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'not_registered' });
    expect(d.reason).toContain('not registered');
  });

  // The cut-over is what makes it safe to switch this on mid-year.
  it('exempts a document dated before the cut-over', () => {
    const profile = mergeGstProfile(REGISTERED, { effectiveFrom: '2026-10-01' });
    const d = determineTax(ctx({ itemTreatment: 'taxable', itemRatePercent: 18 }), { profile });
    expect(d.source).toBe('not_registered');
    expect(d.reason).toContain('before this hospital started filing');
  });
});

describe('determineTax — room rent', () => {
  it('taxes a deluxe room on the whole day rent', () => {
    const d = determineTax(
      ctx({ kind: 'room', dailyRate: 6000, wardType: 'private' }),
      masters(),
    );
    expect(d).toMatchObject({ treatment: 'taxable', ratePercent: 5, source: 'room_rule' });
    expect(d.reason).toContain('whole day');
  });

  it('exempts a bed below the threshold', () => {
    const d = determineTax(ctx({ kind: 'room', dailyRate: 1500 }), masters());
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'room_rule' });
  });

  it('exempts critical care and says why', () => {
    const d = determineTax(
      ctx({ kind: 'room', dailyRate: 12000, wardType: 'icu', bedType: 'icu' }),
      masters(),
    );
    expect(d.ratePercent).toBe(0);
    expect(d.reason).toContain('critical care');
  });

  // Room rent above the threshold is taxable EVEN FOR AN INPATIENT — it is the
  // exception the composite-supply exemption does not swallow.
  it('still taxes an expensive room for an admitted patient', () => {
    const d = determineTax(
      ctx({
        kind: 'room',
        dailyRate: 6000,
        wardType: 'private',
        patientAdmitted: true,
        issuedForTreatment: true,
      }),
      masters(),
    );
    expect(d).toMatchObject({ ratePercent: 5, source: 'room_rule' });
  });

  it('takes the threshold and rate from the platform rule when one is set', () => {
    const d = determineTax(
      ctx({ kind: 'room', dailyRate: 8000 }),
      masters({ roomRule: { thresholdPerDay: 10000, ratePercent: 12 } }),
    );
    expect(d.ratePercent).toBe(0);
    const e = determineTax(
      ctx({ kind: 'room', dailyRate: 12000 }),
      masters({ roomRule: { thresholdPerDay: 10000, ratePercent: 12 } }),
    );
    expect(e.ratePercent).toBe(12);
  });
});

describe('determineTax — the inpatient composite rule', () => {
  const admitted = { patientAdmitted: true, issuedForTreatment: true };

  it('exempts a medicine given to an admitted patient, overriding its HSN rate', () => {
    const d = determineTax(
      ctx({ ...admitted, hsnCode: '3004', itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters({ hsnMatch: { code: '3004', ratePercent: 5, treatment: 'taxable' } }),
    );
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'inpatient_composite' });
    expect(d.reason).toContain('composite supply');
  });

  it('exempts a consumable used on an admitted patient', () => {
    const d = determineTax(
      ctx({ kind: 'consumable', ...admitted, itemTreatment: 'taxable', itemRatePercent: 12 }),
      masters(),
    );
    expect(d.source).toBe('inpatient_composite');
  });

  // Same drug, same code, same price — the other answer.
  it('taxes the identical medicine sold at the counter', () => {
    const d = determineTax(
      ctx({ hsnCode: '3004', itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters({ hsnMatch: { code: '3004', ratePercent: 5, treatment: 'taxable' } }),
    );
    expect(d).toMatchObject({ treatment: 'taxable', ratePercent: 5, source: 'item_master' });
  });

  it('taxes a discharge medicine the patient takes home', () => {
    const d = determineTax(
      ctx({ ...admitted, isTakeHome: true, itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters(),
    );
    expect(d).toMatchObject({ treatment: 'taxable', source: 'item_master' });
  });

  it('exempts a discharge medicine when the auditor said to', () => {
    const profile = mergeGstProfile(REGISTERED, { dischargeMedicinesTaxable: false });
    const d = determineTax(
      ctx({ ...admitted, isTakeHome: true, itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters({ profile }),
    );
    expect(d.source).toBe('inpatient_composite');
  });

  it('taxes an inpatient medicine when the hospital turned the exemption off', () => {
    const profile = mergeGstProfile(REGISTERED, { inpatientCompositeExempt: false });
    const d = determineTax(
      ctx({ ...admitted, itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters({ profile }),
    );
    expect(d.source).toBe('item_master');
    expect(d.ratePercent).toBe(5);
  });

  // Sold to an inpatient at the counter rather than used on them in the ward.
  it('does not exempt a medicine merely because the patient is admitted', () => {
    const d = determineTax(
      ctx({ patientAdmitted: true, issuedForTreatment: false, itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters(),
    );
    expect(d.source).toBe('item_master');
  });

  it('does not exempt a service just because the patient is admitted', () => {
    const d = determineTax(
      ctx({ kind: 'procedure', ...admitted, isCosmetic: true }),
      masters(),
    );
    expect(d.source).toBe('cosmetic');
  });
});

describe('determineTax — cosmetic procedures', () => {
  it('taxes a cosmetic procedure at 18% by default', () => {
    const d = determineTax(ctx({ kind: 'procedure', isCosmetic: true }), masters());
    expect(d).toMatchObject({ treatment: 'taxable', ratePercent: 18, source: 'cosmetic' });
  });

  it('uses the tariff rate when the tariff carries one', () => {
    const d = determineTax(
      ctx({ kind: 'procedure', isCosmetic: true, itemRatePercent: 12 }),
      masters(),
    );
    expect(d.ratePercent).toBe(12);
  });

  it('leaves a therapeutic procedure exempt', () => {
    const d = determineTax(ctx({ kind: 'procedure' }), masters());
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'no_rule' });
    expect(d.reason).toContain('Notification 12/2017');
  });
});

describe('determineTax — the masters, and the fallback safety rule', () => {
  it('takes an approved item classification as authoritative', () => {
    const d = determineTax(
      ctx({ hsnCode: '3004', itemTreatment: 'nil_rated', itemApproved: true }),
      masters({
        hsnMatch: { code: '3004', ratePercent: 5, treatment: 'taxable' },
        categoryDefault: { ratePercent: 18, treatment: 'taxable' },
      }),
    );
    expect(d).toMatchObject({ treatment: 'nil_rated', ratePercent: 0, source: 'item_master' });
    expect(d.requiresResolution).toBe(false);
    expect(d.reason).toContain('approved');
  });

  it('resolves goods through the HSN master', () => {
    const d = determineTax(
      ctx({ hsnCode: '30049099' }),
      masters({ hsnMatch: { code: '3004', ratePercent: 5, treatment: 'taxable' } }),
    );
    // The line reports the ITEM's code; the master row that priced it is named
    // in the reason. A heading prices many items, and the return groups by the
    // code the line carries.
    expect(d).toMatchObject({ ratePercent: 5, source: 'hsn_master', hsnSacCode: '30049099' });
    expect(d.reason).toBe('5% under HSN 3004');
  });

  it('reports a nil-rated HSN row as nil rather than as exempt', () => {
    const d = determineTax(
      ctx({ hsnCode: '30049010' }),
      masters({ hsnMatch: { code: '30049010', ratePercent: 0, treatment: 'nil_rated' } }),
    );
    expect(d).toMatchObject({ treatment: 'nil_rated', ratePercent: 0 });
    expect(d.reason).toContain('Nil-rated');
  });

  it('resolves services through the SAC master', () => {
    const d = determineTax(
      ctx({ kind: 'consultation', sacCode: '999312' }),
      masters({ sacMatch: { code: '999312', ratePercent: 0, treatment: 'exempt' } }),
    );
    expect(d).toMatchObject({ treatment: 'exempt', source: 'sac_master' });
  });

  // The safety rule the Changes document asks for, stated as a test: a
  // fallback may fill a blank but never overrule an approved classification.
  it('does not let a category default override an item classification', () => {
    const d = determineTax(
      ctx({ itemTreatment: 'exempt' }),
      masters({ categoryDefault: { ratePercent: 18, treatment: 'taxable' } }),
    );
    expect(d).toMatchObject({ treatment: 'exempt', source: 'item_master' });
  });

  it('does not let a category default override an HSN match', () => {
    const d = determineTax(
      ctx({ hsnCode: '3004' }),
      masters({
        hsnMatch: { code: '3004', ratePercent: 5, treatment: 'taxable' },
        categoryDefault: { ratePercent: 18, treatment: 'taxable' },
      }),
    );
    expect(d).toMatchObject({ ratePercent: 5, source: 'hsn_master' });
  });

  // A guessed taxable rate on a patient's bill is indefensible, so it is
  // flagged and the finalisation gate stops it.
  it('flags a taxable line that only a default produced', () => {
    const d = determineTax(
      ctx({ kind: 'other' }),
      masters({ categoryDefault: { ratePercent: 18, treatment: 'taxable' } }),
    );
    expect(d).toMatchObject({ ratePercent: 18, source: 'category_default' });
    expect(d.requiresResolution).toBe(true);
    expect(d.reason).toContain('no HSN or SAC code yet');
  });

  it('does not flag an EXEMPT line that a default produced', () => {
    const d = determineTax(
      ctx({ kind: 'lab' }),
      masters({ categoryDefault: { ratePercent: 0, treatment: 'exempt' } }),
    );
    expect(d.requiresResolution).toBe(false);
  });

  it('flags a typed-in taxable rate with no code and no approval', () => {
    const d = determineTax(ctx({ kind: 'other', itemTreatment: 'taxable', itemRatePercent: 2 }), masters());
    expect(d.requiresResolution).toBe(true);
  });

  it('does not flag a typed rate once it has a code behind it', () => {
    const d = determineTax(
      ctx({ kind: 'other', hsnCode: '9018', itemTreatment: 'taxable', itemRatePercent: 5 }),
      masters(),
    );
    expect(d.requiresResolution).toBe(false);
  });
});

describe('determineTax — nothing decided', () => {
  it('leaves a healthcare service exempt without flagging it', () => {
    const d = determineTax(ctx({ kind: 'lab' }), masters());
    expect(d).toMatchObject({ treatment: 'exempt', source: 'no_rule', requiresResolution: false });
  });

  // A medicine with no HSN is an unfinished setup, not an exempt supply.
  it('flags goods that reached the end of the rules with no code', () => {
    const d = determineTax(ctx({ kind: 'medicine' }), masters());
    expect(d).toMatchObject({ treatment: 'exempt', source: 'no_rule', requiresResolution: true });
    expect(d.reason).toContain('No HSN or SAC code');
  });

  it('carries the inclusive flag through untouched', () => {
    expect(determineTax(ctx({ taxInclusive: true }), masters()).taxInclusive).toBe(true);
    expect(determineTax(ctx({ kind: 'room', dailyRate: 6000 }), masters()).taxInclusive).toBe(false);
  });
});

describe('the room rule names the supply as well as rating it', () => {
  // Rule 46 wants the code on the invoice and Table 12 groups by it. A room
  // that went out with a rate and no code was a filed line the return could
  // not place.
  it('stamps the accommodation SAC on a taxable room', () => {
    const d = determineTax(
      { kind: 'room', dailyRate: 8000 },
      masters(),
    );
    expect(d).toMatchObject({
      treatment: 'taxable',
      ratePercent: 5,
      hsnSacCode: ROOM_ACCOMMODATION_SAC,
      source: 'room_rule',
    });
  });

  // An exempt room is still accommodation. Leaving the code off the cheap
  // rooms would put most of a hospital's room revenue outside Table 12.
  it('stamps it on an exempt room too', () => {
    expect(
      determineTax({ kind: 'room', dailyRate: 1500 }, { profile: REGISTERED }),
    ).toMatchObject({ treatment: 'exempt', hsnSacCode: ROOM_ACCOMMODATION_SAC });
  });

  it('and on critical care, which is exempt at any rate', () => {
    expect(
      determineTax(
        { kind: 'room', dailyRate: 12000, bedType: 'icu' },
        masters(),
      ),
    ).toMatchObject({ treatment: 'exempt', hsnSacCode: ROOM_ACCOMMODATION_SAC });
  });

  // A hospital that has mapped its room tariff to something else means it.
  it('never overrides a code that came with the charge', () => {
    expect(
      determineTax(
        { kind: 'room', dailyRate: 8000, sacCode: '996312' },
        masters(),
      ).hsnSacCode,
    ).toBe('996312');
  });

  it('lets the hospital configure a different default', () => {
    expect(
      determineTax(
        { kind: 'room', dailyRate: 8000 },
        masters({ roomRule: { thresholdPerDay: 5000, ratePercent: 5, sacCode: '9963' } }),
      ).hsnSacCode,
    ).toBe('9963');
  });

  // Naming the supply must not move its rate — the rule decides that.
  it('changes no rate by naming the supply', () => {
    const below = determineTax({ kind: 'room', dailyRate: 4999 }, { profile: REGISTERED });
    const above = determineTax({ kind: 'room', dailyRate: 5001 }, { profile: REGISTERED });
    expect(below.ratePercent).toBe(0);
    expect(above.ratePercent).toBe(5);
  });
});
