import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { taxResolverFor, clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import { priceMedicineLine } from '../../../../src/modules/pharmacy/pharmacy.service';
import { determineTax } from '../../../../src/shared/gst-determination';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';

// How the counter prices one medicine line, from the only two tax facts the
// formulary row carries: its HSN code and its GST %.
//
// Pinned because of what it cannot express. A medicine exempted by NOTIFICATION
// rather than by tariff heading — the drugs listed in Annexure I of Notification
// No. 10/2025-Central Tax (Rate), S. No. 113 — has no combination of those two
// fields that reaches a nil line. S. No. 113 names the drugs, not a code (its
// heading column reads "30 or any other Chapter"), so an HSN-master row cannot
// single them out either.

const TENANT = 'tenant-1';
const VALID_GSTIN = '27AAPFU0939F1ZV';

// MRP, tax-inclusive: at 5% a ₹105 strip is ₹100 of value and ₹5 of tax.
const MRP = { unitPrice: 105, quantity: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  clearGstMasterCache();
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { gst: { registered: true, gstin: VALID_GSTIN } },
  });
  // The seeded masters, as far as a medicine is concerned.
  (prisma.hsnGstRate.findMany as any).mockResolvedValue([
    { hsnCode: '3002', gstRate: 5, treatment: 'taxable', description: 'Blood, antisera, vaccines' },
    { hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: 'Medicaments' },
    { hsnCode: '30049010', gstRate: 0, treatment: 'nil_rated', description: 'ORS' },
  ]);
  (prisma.gstCategoryDefault.findMany as any).mockResolvedValue([
    { supplyKind: 'medicine', ratePercent: 5, treatment: 'taxable' },
  ]);
});

/** A line the counter will actually bill at no tax: not taxed, and not refused. */
const sellableAtNil = (d: { treatment: string; requiresResolution: boolean }) =>
  d.treatment !== 'taxable' && !d.requiresResolution;

describe('priceMedicineLine — a zero on the formulary', () => {
  // A bare 0 is the absence of an answer, not a nil rating. That guard is
  // deliberate and stays: 394 of 430 drugs here once carried no rate at all.
  it('is not a nil rating — a coded medicine takes its heading rate', async () => {
    const r = await taxResolverFor(TENANT);
    const p = priceMedicineLine(r, { hsnCode: '3004', taxPercent: 0 }, MRP);
    expect(p.determination).toMatchObject({
      treatment: 'taxable',
      ratePercent: 5,
      source: 'hsn_master',
    });
    expect(p.money.taxAmount).toBe(5);
  });

  // `createPharmacySale` refuses any line with requiresResolution set, so
  // this medicine cannot be sold at all until somebody classifies it.
  it('with no code, falls to the medicine default and is flagged', async () => {
    const r = await taxResolverFor(TENANT);
    const p = priceMedicineLine(r, { hsnCode: null, taxPercent: 0 }, MRP);
    expect(p.determination).toMatchObject({
      treatment: 'taxable',
      ratePercent: 5,
      source: 'category_default',
      requiresResolution: true,
    });
  });
});

describe('priceMedicineLine — a medicine exempt by notification', () => {
  // Every way the formulary can describe a drug such as Daratumumab (Annexure
  // I, item 9). None reaches a nil line: each is taxed at 5% or refused.
  const formularyRows: Array<Record<string, unknown>> = [
    { hsnCode: '3002', taxPercent: 0 },
    { hsnCode: '3002', taxPercent: null },
    { hsnCode: '3004', taxPercent: 0 },
    { hsnCode: null, taxPercent: 0 },
    { hsnCode: null, taxPercent: null },
    // The existing "vital / life-saving" flag only bypasses the IP credit
    // gate. It has no GST effect, and the pricing call never reads it.
    { hsnCode: '3002', taxPercent: 0, isLifeSaving: true },
  ];

  for (const row of formularyRows) {
    it(`cannot be billed at nil: ${JSON.stringify(row)}`, async () => {
      const r = await taxResolverFor(TENANT);
      const p = priceMedicineLine(r, row, MRP);
      expect(sellableAtNil(p.determination)).toBe(false);
    });
  }

  // The one zero a medicine can reach is an HSN-master row, and the only such
  // row is ORS. Stamping ORS's code on another drug would misreport it in
  // GSTR-1 Table 12, which groups by the code the line carries.
  it('reaches nil only through a code that is not the drug’s own', async () => {
    const r = await taxResolverFor(TENANT);
    const p = priceMedicineLine(r, { hsnCode: '30049010', taxPercent: 0 }, MRP);
    expect(p.determination).toMatchObject({ treatment: 'nil_rated', hsnSacCode: '30049010' });
  });

  // The gap is in what the callers pass, not in the rules: step 5 of the
  // engine already honours an exempt classification ahead of the HSN master.
  it('the engine honours an exempt item classification — nothing supplies one', () => {
    const d = determineTax(
      { kind: 'medicine', on: new Date(), hsnCode: '3002', itemTreatment: 'exempt' },
      {
        profile: mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true, gstin: VALID_GSTIN }),
        hsnMatch: { code: '3002', ratePercent: 5, treatment: 'taxable' },
      },
    );
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'item_master' });
  });
});
