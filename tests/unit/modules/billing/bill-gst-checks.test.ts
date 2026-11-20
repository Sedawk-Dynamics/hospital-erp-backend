import { describe, it, expect, vi } from 'vitest';
import {
  normalizeBuyer,
  resplitLine,
  sacWarningFor,
  serviceLinesWithoutSac,
} from '../../../../src/modules/billing/billing.gst-checks';
import { tariffTaxContext, determineTax } from '../../../../src/shared/gst-determination';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';
import { issueCreditNoteBestEffort } from '../../../../src/modules/gst/credit-note.service';

const MH_GSTIN = '27AAPFU0939F1ZV';
const KA_GSTIN = '29AAPFU0939F1ZR';

// G-4: bills had no buyer GSTIN, so a B2B invoice was impossible.
describe('normalizeBuyer (G-4)', () => {
  it('accepts a valid GSTIN and takes the place of supply from its state code', () => {
    expect(normalizeBuyer({ gstin: ` ${KA_GSTIN.toLowerCase()} `, legalName: 'Acme Pvt Ltd', address: 'Bengaluru' })).toEqual({
      recipientGstin: KA_GSTIN,
      recipientLegalName: 'Acme Pvt Ltd',
      recipientAddress: 'Bengaluru',
      buyerStateCode: '29',
    });
  });

  it('refuses a GSTIN whose check digit is wrong', () => {
    expect(() => normalizeBuyer({ gstin: '29AAPFU0939F1ZV', legalName: 'Acme' })).toThrow(/check digit/i);
  });

  it('wants the legal name with a GSTIN', () => {
    expect(() => normalizeBuyer({ gstin: KA_GSTIN })).toThrow(/legal name/i);
  });

  it('a blank GSTIN clears the buyer (B2C)', () => {
    expect(normalizeBuyer({ gstin: '  ' }).recipientGstin).toBeNull();
    expect(normalizeBuyer(null).buyerStateCode).toBeNull();
  });
});

describe('resplitLine (G-4)', () => {
  const intra = { taxPercent: 18, taxAmount: 18, cgstAmount: 9, sgstAmount: 9, igstAmount: 0 };

  it('moves the whole tax to IGST for an out-of-state buyer', () => {
    expect(resplitLine(intra, true)).toEqual({
      cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0, igstRate: 18, igstAmount: 18,
    });
  });

  it('splits IGST back into CGST + SGST, odd paisa to CGST', () => {
    expect(resplitLine({ taxPercent: 5, cgstAmount: 0, sgstAmount: 0, igstAmount: 0.05 }, false)).toEqual({
      cgstRate: 2.5, cgstAmount: 0.03, sgstRate: 2.5, sgstAmount: 0.02, igstRate: 0, igstAmount: 0,
    });
  });

  it('leaves a line that already matches, or carries no tax', () => {
    expect(resplitLine(intra, false)).toBeNull();
    expect(resplitLine({ taxPercent: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0 }, true)).toBeNull();
  });
});

// G-3: a service line with no SAC is flagged on finalise — a warning, not a refusal.
describe('serviceLinesWithoutSac (G-3)', () => {
  const items = [
    { description: 'Consultation', category: 'consultation', hsnSacCode: null },
    { description: 'Paracetamol', category: 'pharmacy', hsnSacCode: null },
    { description: 'X-ray', category: 'radiology', hsnSacCode: '999316' },
  ];

  it('names the service lines with no code, never goods', () => {
    expect(serviceLinesWithoutSac(items, true)).toEqual(['Consultation']);
    expect(sacWarningFor(['Consultation'])).toMatch(/1 service line\(s\) have no SAC code: Consultation/);
  });

  it('says nothing for an unregistered hospital', () => {
    expect(serviceLinesWithoutSac(items, false)).toEqual([]);
    expect(sacWarningFor([])).toBeNull();
  });
});

// G-3: billing takes rate and SAC from the service tariff.
describe('tariffTaxContext (G-3)', () => {
  const profile = mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true, gstin: MH_GSTIN });
  const ON = new Date('2026-11-19T06:00:00Z');
  const tariff = {
    sacCode: '999722', gstTreatment: 'taxable', gstRatePercent: '18.00', gstApproved: false, isCosmetic: false,
  };

  it("uses a classified tariff's own rate before an auditor has approved it", () => {
    const d = determineTax({ kind: 'procedure', on: ON, ...tariffTaxContext(tariff, ON) }, { profile });
    expect(d).toMatchObject({ treatment: 'taxable', ratePercent: 18, hsnSacCode: '999722', source: 'item_master' });
    // It has a SAC behind it, so it is not a guessed rate.
    expect(d.requiresResolution).toBe(false);
  });

  it('does not apply a classification dated after the bill', () => {
    const ctx = tariffTaxContext({ ...tariff, gstEffectiveFrom: new Date('2026-12-01') }, ON);
    expect(ctx).toMatchObject({ sacCode: '999722', itemTreatment: null, itemRatePercent: null });
  });

  it('no tariff, no classification', () => {
    expect(tariffTaxContext(null, ON)).toMatchObject({ sacCode: null, itemTreatment: null });
  });
});

// G-7: a credit note that fails must not abort the void/refund it documents.
describe('issueCreditNoteBestEffort savepoint (G-7)', () => {
  it('rolls back to a savepoint when the note cannot be written', async () => {
    const raw = vi.fn().mockResolvedValue(0);
    const tx = {
      $executeRawUnsafe: raw,
      bill: { findFirst: vi.fn().mockRejectedValue(new Error('boom')) },
    };
    await expect(issueCreditNoteBestEffort(tx, 'tenant-1', { billId: 'b1', reason: 'cancellation' })).resolves.toBeUndefined();
    expect(raw.mock.calls.map((c) => c[0])).toEqual([
      'SAVEPOINT credit_note_best_effort',
      'ROLLBACK TO SAVEPOINT credit_note_best_effort',
    ]);
  });
});
