import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { taxResolverFor, clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import { priceMedicineLine } from '../../../../src/modules/pharmacy/pharmacy.service';
import { determineTax } from '../../../../src/shared/gst-determination';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';

// The counter reads the formulary's HSN plus its optional product-specific GST
// treatment. The latter is essential for notification exemptions that name a
// medicine rather than an HSN code.

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
    { hsnCode: '30049010', gstRate: 5, treatment: 'taxable', description: 'ORS' },
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

describe('priceMedicineLine — product-specific treatment', () => {
  it('honours a notification exemption ahead of a taxable HSN heading', async () => {
    const r = await taxResolverFor(TENANT);
    const p = priceMedicineLine(
      r,
      { hsnCode: '3002', taxPercent: 0, gstTreatment: 'exempt', category: 'drug' },
      MRP,
    );
    expect(sellableAtNil(p.determination)).toBe(true);
    expect(p.determination).toMatchObject({ treatment: 'exempt', source: 'item_master' });
  });

  // The gap is in what the callers pass, not in the rules: step 5 of the
  // engine already honours an exempt classification ahead of the HSN master.
  it('the engine honours an exempt item classification', () => {
    const d = determineTax(
      { kind: 'medicine', on: new Date(), hsnCode: '3002', itemTreatment: 'exempt' },
      {
        profile: mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true, gstin: VALID_GSTIN }),
        hsnMatch: { code: '3002', ratePercent: 5, treatment: 'taxable' },
      },
    );
    expect(d).toMatchObject({ treatment: 'exempt', ratePercent: 0, source: 'item_master' });
  });

  it('does not classify a retail product as a medicine', async () => {
    const r = await taxResolverFor(TENANT);
    const p = priceMedicineLine(
      r,
      { hsnCode: null, taxPercent: 18, gstTreatment: 'taxable', category: 'product' },
      MRP,
    );
    expect(p.determination.reason).toContain('Classified on the item');
    expect(p.determination.ratePercent).toBe(18);
  });
});
