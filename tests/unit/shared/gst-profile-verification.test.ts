import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GST_PROFILE,
  applyGstinVerification,
  gstinVerificationCaption,
  mergeGstProfile,
  type GstinVerificationRecord,
} from '../../../src/shared/gst-profile';
import { buildGstBlock, gstIdentityFields } from '../../../src/modules/billing/billing.gst-layout';

// Gap #311: the GSTIN counts as verified only for the exact number the
// provider confirmed as active — and a sandbox pass is always labelled.

const GSTIN = '27AAPFU0939F1ZV';
const OTHER = '33AAACS2601K1ZR';
const profile = mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true, gstin: GSTIN, legalName: 'Acme Hospital Pvt. Ltd.' });

const row = (over: Partial<GstinVerificationRecord> = {}): GstinVerificationRecord => ({
  checkedGstin: GSTIN,
  verifiedGstin: GSTIN,
  resultStatus: 'verified',
  provider: 'http:test-gsp',
  sandbox: false,
  legalName: 'ACME HOSPITAL PRIVATE LIMITED',
  tradeName: null,
  registrationStatus: 'Active',
  lastError: null,
  lastCheckedAt: new Date('2026-11-20T10:00:00Z'),
  verifiedAt: new Date('2026-11-20T10:00:00Z'),
  ...over,
});

describe('applyGstinVerification', () => {
  it('a profile on its own is never verified', () => {
    expect(mergeGstProfile(profile, { gstinVerified: true }).gstinVerified).toBe(false);
  });

  it('is verified for the matching GSTIN with an active answer', () => {
    const p = applyGstinVerification(profile, row());
    expect(p.gstinVerified).toBe(true);
    expect(p.gstinVerification).toMatchObject({ status: 'verified', legalName: 'ACME HOSPITAL PRIVATE LIMITED', registrationStatus: 'Active' });
    expect(p.gstinVerification?.verifiedAt).toBe('2026-11-20T10:00:00.000Z');
  });

  it('is NOT verified when the stored answer was for a different GSTIN', () => {
    const p = applyGstinVerification(profile, row({ checkedGstin: OTHER, verifiedGstin: OTHER }));
    expect(p.gstinVerified).toBe(false);
    expect(p.gstinVerification?.status).toBe('stale');
    expect(p.gstinVerification?.legalName).toBeNull();
  });

  it.each(['not_found', 'inactive', 'error'])('stays unverified after a %s lookup', (status) => {
    const p = applyGstinVerification(profile, row({ resultStatus: status, verifiedGstin: null, lastError: 'x' }));
    expect(p.gstinVerified).toBe(false);
    expect(p.gstinVerification?.status).toBe(status);
  });

  it('is unverified, not broken, when the record cannot be read', () => {
    const p = applyGstinVerification(profile, undefined);
    expect(p.registered).toBe(true);
    expect(p.gstinVerified).toBe(false);
    expect(p.gstinVerification?.status).toBe('unreadable');
  });

  it('says never_checked when there is no record', () => {
    expect(applyGstinVerification(profile, null).gstinVerification?.status).toBe('never_checked');
  });

  it('compares legal names loosely, and flags a real mismatch', () => {
    expect(applyGstinVerification(profile, row()).gstinVerification?.legalNameMatches).toBe(true);
    expect(applyGstinVerification(profile, row({ legalName: 'SOMEONE ELSE LLP' })).gstinVerification?.legalNameMatches).toBe(false);
  });
});

describe('gstinVerificationCaption', () => {
  it('says not verified until the provider confirms it', () => {
    expect(gstinVerificationCaption(applyGstinVerification(profile, null))).toMatch(/not verified/);
    expect(gstinVerificationCaption(applyGstinVerification(profile, row()))).toBeNull();
  });

  it('labels a sandbox pass even though it counts as verified', () => {
    const p = applyGstinVerification(profile, row({ sandbox: true, provider: 'sandbox' }));
    expect(p.gstinVerified).toBe(true);
    expect(gstinVerificationCaption(p)).toMatch(/SANDBOX/);
  });

  it('says not verified for a bill issued under a different GSTIN', () => {
    const p = applyGstinVerification(profile, row());
    expect(gstinVerificationCaption(p, OTHER)).toMatch(/not verified/);
  });
});

describe('the hospital GSTIN on a bill', () => {
  const hospitalGstinField = (p: ReturnType<typeof applyGstinVerification>, supplierGstin = GSTIN) =>
    gstIdentityFields(buildGstBlock(p, [{ supplierGstin, invoiceNumber: 'INV-1' }], [])).find(
      ([k]) => k === 'GSTIN (Hospital)',
    )?.[1];

  it('prints "not verified" until the provider confirms it', () => {
    expect(hospitalGstinField(applyGstinVerification(profile, null))).toBe(`${GSTIN} (not verified with the GST portal)`);
    expect(hospitalGstinField(applyGstinVerification(profile, row()))).toBe(GSTIN);
  });

  it('prints the sandbox label after a sandbox pass', () => {
    expect(hospitalGstinField(applyGstinVerification(profile, row({ sandbox: true })))).toMatch(/SANDBOX/);
  });

  it('prints "not verified" on a bill issued under an older GSTIN', () => {
    expect(hospitalGstinField(applyGstinVerification(profile, row()), OTHER)).toMatch(/not verified/);
  });
});
