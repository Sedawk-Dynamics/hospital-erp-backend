import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GST_PROFILE,
  GstProfileError,
  mergeGstProfile,
  gstAppliesOn,
  defaultPlaceOfSupply,
} from '../../../src/shared/gst-profile';

const VALID = '27AAPFU0939F1ZV'; // Maharashtra

describe('DEFAULT_GST_PROFILE', () => {
  // A hospital that never opens the screen must behave exactly as it does
  // today: no tax, no tax invoices, nothing to file.
  it('starts unregistered, so nothing changes for a hospital that ignores it', () => {
    expect(DEFAULT_GST_PROFILE.registered).toBe(false);
    expect(DEFAULT_GST_PROFILE.gstin).toBeNull();
    expect(DEFAULT_GST_PROFILE.stateCode).toBeNull();
    expect(DEFAULT_GST_PROFILE.registrationType).toBe('unregistered');
  });

  it('defaults the auditor switches to the ordinary legal position', () => {
    expect(DEFAULT_GST_PROFILE.inpatientCompositeExempt).toBe(true);
    expect(DEFAULT_GST_PROFILE.dischargeMedicinesTaxable).toBe(true);
    expect(DEFAULT_GST_PROFILE.roomUpgradeTreatment).toBe('accommodation');
  });

  it('leaves applicability off until the hospital states its turnover', () => {
    expect(DEFAULT_GST_PROFILE.sixDigitHsn).toBe(false);
    expect(DEFAULT_GST_PROFILE.eInvoiceApplicable).toBe(false);
    expect(DEFAULT_GST_PROFILE.eWayBillApplicable).toBe(false);
  });
});

describe('mergeGstProfile', () => {
  it('ignores a patch that is not an object', () => {
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, null)).toBe(DEFAULT_GST_PROFILE);
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, 'nope')).toBe(DEFAULT_GST_PROFILE);
  });

  // The state is what decides CGST+SGST against IGST, so it is never typed
  // separately — it comes out of the number and cannot disagree with it.
  it('derives the state from the GSTIN', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: VALID, registered: true });
    expect(p.gstin).toBe(VALID);
    expect(p.stateCode).toBe('27');
    expect(p.stateName).toBe('Maharashtra');
  });

  it('normalises a GSTIN typed in lower case with spaces', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: ' 27aapfu0939f1zv ' });
    expect(p.gstin).toBe(VALID);
  });

  // A wrong GSTIN is not a value to tidy up — it is an invoice that will be
  // rejected, so it is refused rather than stored.
  it('refuses a GSTIN that fails its check digit', () => {
    expect(() => mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: '27AAPFU0939F1ZA' })).toThrow(
      GstProfileError,
    );
  });

  it('refuses a GSTIN of the wrong shape', () => {
    expect(() => mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: 'ABC' })).toThrow(GstProfileError);
  });

  it('clears the number and the state together', () => {
    const on = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: VALID, registered: true });
    const off = mergeGstProfile(on, { gstin: null });
    expect(off.gstin).toBeNull();
    expect(off.stateCode).toBeNull();
    expect(off.stateName).toBeNull();
    // Registration cannot survive the number it depends on.
    expect(off.registered).toBe(false);
  });

  it('refuses to mark a hospital registered with no GSTIN', () => {
    expect(() => mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true })).toThrow(
      /GSTIN is required/,
    );
  });

  it('moves an unregistered type to regular once a number is given', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: VALID, registered: true });
    expect(p.registrationType).toBe('regular');
  });

  it('keeps composition when that is what was chosen', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, {
      gstin: VALID,
      registered: true,
      registrationType: 'composition',
    });
    expect(p.registrationType).toBe('composition');
  });

  it('ignores a registration type it does not know', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { registrationType: 'made-up' });
    expect(p.registrationType).toBe('unregistered');
  });

  it('backfills the state on a profile saved before the state was derived', () => {
    const legacy = { ...DEFAULT_GST_PROFILE, gstin: VALID, registered: true, stateCode: null };
    const p = mergeGstProfile(legacy, { legalName: 'Green City Hospital Pvt Ltd' });
    expect(p.stateCode).toBe('27');
    expect(p.stateName).toBe('Maharashtra');
  });

  it('keeps names inside the column width and turns a blank into null', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { legalName: 'x'.repeat(500), tradeName: '  ' });
    expect(p.legalName).toHaveLength(200);
    expect(p.tradeName).toBeNull();
  });

  it('accepts a cut-over date and rejects a shape that is not one', () => {
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, { effectiveFrom: '2026-04-01' }).effectiveFrom).toBe(
      '2026-04-01',
    );
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, { effectiveFrom: '01/04/2026' }).effectiveFrom).toBeNull();
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, { effectiveFrom: '2026-13-45' }).effectiveFrom).toBeNull();
    expect(mergeGstProfile(DEFAULT_GST_PROFILE, { effectiveFrom: null }).effectiveFrom).toBeNull();
  });

  it('carries the applicability flags and the auditor switches', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, {
      sixDigitHsn: true,
      eInvoiceApplicable: true,
      dischargeMedicinesTaxable: false,
      roomUpgradeTreatment: 'other_service',
    });
    expect(p.sixDigitHsn).toBe(true);
    expect(p.eInvoiceApplicable).toBe(true);
    expect(p.dischargeMedicinesTaxable).toBe(false);
    expect(p.roomUpgradeTreatment).toBe('other_service');
    // Untouched fields keep their value.
    expect(p.inpatientCompositeExempt).toBe(true);
  });

  it('ignores a room-upgrade treatment it does not know', () => {
    expect(
      mergeGstProfile(DEFAULT_GST_PROFILE, { roomUpgradeTreatment: 'luxury' }).roomUpgradeTreatment,
    ).toBe('accommodation');
  });
});

describe('gstAppliesOn', () => {
  const registered = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: VALID, registered: true });

  it('is off for a hospital that is not registered', () => {
    expect(gstAppliesOn(DEFAULT_GST_PROFILE, new Date('2026-09-01T00:00:00Z'))).toBe(false);
  });

  it('is on from the start when no cut-over was chosen', () => {
    expect(gstAppliesOn(registered, new Date('2020-01-01T00:00:00Z'))).toBe(true);
  });

  // The cut-over is what makes it safe to switch this on mid-year: bills
  // before it are left exactly as they are.
  it('is off before the cut-over and on from it', () => {
    const p = mergeGstProfile(registered, { effectiveFrom: '2026-04-01' });
    expect(gstAppliesOn(p, new Date('2026-03-31T18:00:00Z'))).toBe(false);
    expect(gstAppliesOn(p, new Date('2026-04-05T00:00:00Z'))).toBe(true);
  });

  it('counts a bill raised in the IST morning of the cut-over day as on it', () => {
    const p = mergeGstProfile(registered, { effectiveFrom: '2026-04-01' });
    // 09:00 IST on 1 April is 03:30 UTC on 1 April.
    expect(gstAppliesOn(p, new Date('2026-04-01T03:30:00Z'))).toBe(true);
    // And 00:30 IST on 1 April, which is 19:00 UTC on 31 March.
    expect(gstAppliesOn(p, new Date('2026-03-31T19:00:00Z'))).toBe(true);
  });
});

describe('defaultPlaceOfSupply', () => {
  it('is the hospital own state, which is where a patient is served', () => {
    const p = mergeGstProfile(DEFAULT_GST_PROFILE, { gstin: VALID, registered: true });
    expect(defaultPlaceOfSupply(p)).toEqual({ stateCode: '27', stateName: 'Maharashtra' });
  });

  it('is nothing at all when the hospital has no registration', () => {
    expect(defaultPlaceOfSupply(DEFAULT_GST_PROFILE)).toEqual({ stateCode: null, stateName: null });
  });
});
