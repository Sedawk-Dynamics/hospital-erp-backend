import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  computeAdvanceTax,
  advancePaymentTaxFields,
} from '../../../../src/modules/gst/advance-gst.service';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';

const REGISTERED = mergeGstProfile(DEFAULT_GST_PROFILE, {
  gstin: '27AAPFU0939F1ZV',
  registered: true,
});

describe('computeAdvanceTax', () => {
  // The ordinary hospital advance. A deposit is money against treatment, and
  // treatment is exempt, so nothing is due when it is taken.
  it('exempts a deposit taken against treatment', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 10000 });
    expect(t).toMatchObject({
      gstTreatment: 'exempt',
      taxRatePercent: 0,
      taxableValue: 10000,
      taxAmount: 0,
    });
    expect(t.reason).toContain('exempt supply');
  });

  it('exempts one taken against nothing in particular', () => {
    expect(computeAdvanceTax(REGISTERED, { amount: 5000, purpose: 'other' }).gstTreatment).toBe(
      'exempt',
    );
  });

  // For a service the time of supply is the earlier of invoice or payment, so
  // an advance against a taxable supply fixes the liability at receipt.
  it('taxes an advance against a room above the threshold', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 10000, purpose: 'accommodation' });
    expect(t.gstTreatment).toBe('taxable');
    expect(t.taxRatePercent).toBe(5);
    // Money in hand is tax-inclusive: the patient handed over 10,000.
    expect(t.taxableValue).toBe(9523.81);
    expect(t.taxAmount).toBe(476.19);
    expect(t.cgstAmount + t.sgstAmount).toBeCloseTo(476.19, 2);
  });

  it('taxes an advance against non-therapeutic work at 18%', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 20000, purpose: 'non_therapeutic' });
    expect(t.taxRatePercent).toBe(18);
    expect(t.taxableValue).toBe(16949.15);
    expect(t.taxAmount).toBe(3050.85);
  });

  it('honours a rate the hospital states over the default', () => {
    const t = computeAdvanceTax(REGISTERED, {
      amount: 10000,
      purpose: 'accommodation',
      ratePercent: 12,
    });
    expect(t.taxRatePercent).toBe(12);
  });

  it('routes an out-of-state advance to IGST', () => {
    const t = computeAdvanceTax(REGISTERED, {
      amount: 10000,
      purpose: 'non_therapeutic',
      placeOfSupplyStateCode: '29',
    });
    expect(t.igstAmount).toBeGreaterThan(0);
    expect(t.cgstAmount).toBe(0);
    expect(t.sgstAmount).toBe(0);
  });

  // Never invent tax on a hospital that is not registered.
  it('charges nothing when the hospital is not registered', () => {
    const t = computeAdvanceTax(DEFAULT_GST_PROFILE, { amount: 10000, purpose: 'accommodation' });
    expect(t).toMatchObject({ gstTreatment: 'exempt', taxAmount: 0 });
    expect(t.reason).toContain('not registered');
  });

  it('charges nothing before the cut-over', () => {
    const p = mergeGstProfile(REGISTERED, { effectiveFrom: '2027-04-01' });
    const t = computeAdvanceTax(p, {
      amount: 10000,
      purpose: 'accommodation',
      on: new Date('2026-09-02T06:00:00Z'),
    });
    expect(t.taxAmount).toBe(0);
    expect(t.reason).toContain('before this hospital started filing');
  });

  // The taxable value plus the tax must always be the money that changed hands.
  it('never collects more than the patient handed over', () => {
    for (const purpose of ['treatment', 'accommodation', 'non_therapeutic'] as const) {
      const t = computeAdvanceTax(REGISTERED, { amount: 7777, purpose });
      expect(t.taxableValue + t.taxAmount).toBeCloseTo(7777, 2);
    }
  });
});

describe('advancePaymentTaxFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allots a receipt voucher number for a registered hospital', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'RV', lastNumber: 2 });
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', REGISTERED, { amount: 5000 });
    expect(f.voucherType).toBe('receipt_voucher');
    expect(f.voucherNumber).toBe('RV/2026-27/000002');
    expect(f.gstTreatment).toBe('exempt');
  });

  it('records the position without a number when unregistered', async () => {
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', DEFAULT_GST_PROFILE, {
      amount: 5000,
    });
    expect(f.voucherNumber).toBeNull();
    expect(prisma.gstDocumentSeries.upsert as any).not.toHaveBeenCalled();
  });

  // Taking a patient's money must not fail because a number could not be
  // allotted. The tax position is still recorded.
  it('still records the tax when the voucher number cannot be allotted', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockRejectedValue(new Error('series is locked'));
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', REGISTERED, {
      amount: 10000,
      purpose: 'accommodation',
    });
    expect(f.voucherNumber).toBeNull();
    expect(f.gstTreatment).toBe('taxable');
    expect(f.taxAmount).toBe(476.19);
  });
});
