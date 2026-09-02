import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  taxResolverFor,
  resolveTaxFor,
  clearGstMasterCache,
} from '../../../../src/modules/gst/gst-resolver.service';

const TENANT = 'tenant-1';
const VALID_GSTIN = '27AAPFU0939F1ZV'; // Maharashtra, code 27

function registered(over: Record<string, unknown> = {}) {
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { gst: { registered: true, gstin: VALID_GSTIN, ...over } },
  });
}

function masters() {
  (prisma.hsnGstRate.findMany as any).mockResolvedValue([
    { hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: 'Medicaments' },
    { hsnCode: '30049010', gstRate: 0, treatment: 'nil_rated', description: 'ORS' },
    { hsnCode: '2106', gstRate: 18, treatment: 'taxable', description: 'Supplements' },
  ]);
  (prisma.sacCode.findMany as any).mockResolvedValue([
    { sacCode: '9993', gstRate: 0, treatment: 'exempt', description: 'Human health' },
    { sacCode: '999319', gstRate: 18, treatment: 'taxable', description: 'Other' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearGstMasterCache();
  masters();
  registered();
});

describe('taxResolverFor', () => {
  it('resolves a medicine through the HSN master', async () => {
    const r = await taxResolverFor(TENANT);
    const d = r.determine({ kind: 'medicine', hsnCode: '30041020' });
    expect(d).toMatchObject({ treatment: 'taxable', ratePercent: 5, source: 'hsn_master' });
  });

  it('resolves a consultation through the SAC master', async () => {
    const r = await taxResolverFor(TENANT);
    expect(r.determine({ kind: 'consultation', sacCode: '999312' })).toMatchObject({
      treatment: 'exempt',
      source: 'sac_master',
    });
  });

  // The rule that makes a hospital different from a shop.
  it('exempts the same medicine when it goes to an admitted patient', async () => {
    const r = await taxResolverFor(TENANT);
    expect(
      r.determine({
        kind: 'medicine',
        hsnCode: '30041020',
        patientAdmitted: true,
        issuedForTreatment: true,
      }),
    ).toMatchObject({ treatment: 'exempt', source: 'inpatient_composite' });
  });

  // A forty-line bill must read two tiny reference tables once, not eighty times.
  it('loads the masters once for the whole document', async () => {
    const r = await taxResolverFor(TENANT);
    for (let i = 0; i < 20; i++) r.determine({ kind: 'medicine', hsnCode: '3004' });
    expect((prisma.hsnGstRate.findMany as any)).toHaveBeenCalledTimes(1);
    expect((prisma.sacCode.findMany as any)).toHaveBeenCalledTimes(1);
  });

  it('caches the masters across resolvers, and the cache can be cleared', async () => {
    await taxResolverFor(TENANT);
    await taxResolverFor(TENANT);
    expect((prisma.hsnGstRate.findMany as any)).toHaveBeenCalledTimes(1);
    clearGstMasterCache();
    await taxResolverFor(TENANT);
    expect((prisma.hsnGstRate.findMany as any)).toHaveBeenCalledTimes(2);
  });

  // Billing must never fail because a settings read did, and of the two ways to
  // be wrong, charging tax that was never owed is the one you cannot undo.
  it('treats the hospital as unregistered when the profile cannot be read', async () => {
    (prisma.tenant.findFirst as any).mockRejectedValue(new Error('db down'));
    const r = await taxResolverFor(TENANT);
    expect(r.determine({ kind: 'medicine', hsnCode: '3004' })).toMatchObject({
      source: 'not_registered',
      ratePercent: 0,
    });
  });

  it('still resolves when the masters cannot be read', async () => {
    (prisma.hsnGstRate.findMany as any).mockRejectedValue(new Error('db down'));
    const r = await taxResolverFor(TENANT);
    expect(r.determine({ kind: 'lab' })).toMatchObject({ treatment: 'exempt', ratePercent: 0 });
  });
});

describe('price — classification and money in one step', () => {
  it('adds tax on top of a tax-exclusive room', async () => {
    const r = await taxResolverFor(TENANT);
    const { determination, money } = r.price(
      { kind: 'room', dailyRate: 6000, wardType: 'private' },
      { unitPrice: 6000, quantity: 3 },
    );
    expect(determination.ratePercent).toBe(5);
    expect(money.taxableValue).toBe(18000);
    expect(money.taxAmount).toBe(900);
    expect(money.totalAmount).toBe(18900);
    expect(money.cgst).toBe(450);
    expect(money.sgst).toBe(450);
  });

  // MRP already contains the tax. A 100 rupee strip must stay 100 rupees.
  it('digs the tax out of an MRP without changing what the patient pays', async () => {
    const r = await taxResolverFor(TENANT);
    const { money } = r.price(
      { kind: 'medicine', hsnCode: '3004', taxInclusive: true },
      { unitPrice: 20, quantity: 2 },
    );
    expect(money.totalAmount).toBe(40);
    expect(money.taxableValue).toBe(38.1);
    expect(money.taxAmount).toBe(1.9);
  });

  it('charges nothing on an exempt line and leaves the price alone', async () => {
    const r = await taxResolverFor(TENANT);
    const { money } = r.price({ kind: 'consultation', sacCode: '999312' }, { unitPrice: 500, quantity: 1 });
    expect(money.taxAmount).toBe(0);
    expect(money.totalAmount).toBe(500);
  });

  it('routes the tax to IGST when the place of supply is another state', async () => {
    const r = await taxResolverFor(TENANT);
    const { money } = r.price(
      { kind: 'room', dailyRate: 6000, placeOfSupplyStateCode: '29' },
      { unitPrice: 6000, quantity: 1 },
    );
    expect(money.igst).toBe(300);
    expect(money.cgst).toBe(0);
    expect(money.sgst).toBe(0);
  });

  it('keeps an unspecified place of supply in the hospital own state', async () => {
    const r = await taxResolverFor(TENANT);
    const { money } = r.price({ kind: 'room', dailyRate: 6000 }, { unitPrice: 6000, quantity: 1 });
    expect(money.igst).toBe(0);
    expect(money.cgst).toBe(150);
  });
});

describe('resolveTaxFor — the single-line convenience', () => {
  it('classifies one line without a resolver', async () => {
    const d = await resolveTaxFor(TENANT, { kind: 'medicine', hsnCode: '2106' });
    expect(d).toMatchObject({ ratePercent: 18, source: 'hsn_master' });
  });

  // The document's date decides, not now — a bill corrected next month must
  // resolve under the rules that applied when it was raised.
  it('honours the document date against the cut-over', async () => {
    registered({ effectiveFrom: '2026-04-01' });
    const before = await resolveTaxFor(
      TENANT,
      { kind: 'medicine', hsnCode: '3004' },
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(before.source).toBe('not_registered');
    const after = await resolveTaxFor(
      TENANT,
      { kind: 'medicine', hsnCode: '3004' },
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(after.source).toBe('hsn_master');
  });
});
