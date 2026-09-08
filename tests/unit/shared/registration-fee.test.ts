import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGISTRATION_FEE,
  mergeRegistrationFee,
  registrationFeeTotals,
  shouldChargeRegistrationFee,
} from '../../../src/shared/registration-fee';

const fee = (over: Partial<typeof DEFAULT_REGISTRATION_FEE> = {}) => ({
  ...DEFAULT_REGISTRATION_FEE,
  enabled: true,
  amount: 200,
  ...over,
});

describe('mergeRegistrationFee', () => {
  it('starts from off, so a hospital that never sets one is unaffected', () => {
    expect(DEFAULT_REGISTRATION_FEE.enabled).toBe(false);
    expect(DEFAULT_REGISTRATION_FEE.amount).toBe(0);
  });

  it('applies a partial patch', () => {
    const s = mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { enabled: true, amount: 250 });
    expect(s).toMatchObject({ enabled: true, amount: 250, oncePerPatient: true });
  });

  // The settings come off the wire and out of a JSON column, so a bad value
  // must not be able to reach a patient's bill.
  it('clamps an amount that is negative or absurd', () => {
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { amount: -50 }).amount).toBe(0);
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { amount: 1e9 }).amount).toBe(100000);
  });

  it('rounds an amount to paise', () => {
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { amount: 199.999 }).amount).toBe(200);
  });

  it('bounds GST by the highest slab that has ever existed', () => {
    // 40 rather than 28: 28% stopped being a slab on 22 September 2025 and was
    // acting as this field's ceiling. Whether the value IS a slab today is
    // checked where the setting is saved — clamping here would silently change
    // a number the hospital typed.
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { gstRatePercent: 99 }).gstRatePercent).toBe(40);
    expect(mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, { gstRatePercent: -5 }).gstRatePercent).toBe(0);
  });

  it('ignores junk and keeps the base', () => {
    const base = fee();
    expect(mergeRegistrationFee(base, 'nope')).toEqual(base);
    expect(mergeRegistrationFee(base, { amount: 'free' }).amount).toBe(200);
    expect(mergeRegistrationFee(base, { enabled: 'yes' }).enabled).toBe(true);
  });

  it('will not let the label become blank', () => {
    expect(mergeRegistrationFee(fee(), { label: '   ' }).label).toBe('Registration Fee');
  });
});

describe('registrationFeeTotals', () => {
  it('is just the amount when there is no GST', () => {
    expect(registrationFeeTotals(fee())).toEqual({ unitPrice: 200, taxAmount: 0, totalAmount: 200 });
  });

  it('adds GST on top', () => {
    expect(registrationFeeTotals(fee({ amount: 100, gstRatePercent: 18 }))).toEqual({
      unitPrice: 100,
      taxAmount: 18,
      totalAmount: 118,
    });
  });

  it('rounds to paise rather than carrying float dust onto the bill', () => {
    const t = registrationFeeTotals(fee({ amount: 199.99, gstRatePercent: 5 }));
    expect(t.taxAmount).toBe(10);
    expect(t.totalAmount).toBe(209.99);
  });
});

describe('shouldChargeRegistrationFee', () => {
  const call = (over: Partial<Parameters<typeof shouldChargeRegistrationFee>[0]> = {}) =>
    shouldChargeRegistrationFee({
      settings: fee(),
      isFirstVisit: true,
      alreadyCharged: false,
      deskChoice: null,
      ...over,
    });

  it('charges a first-time patient', () => {
    expect(call()).toBe(true);
  });

  it('does not charge a returning patient', () => {
    expect(call({ isFirstVisit: false })).toBe(false);
  });

  it('charges nothing when the hospital has not switched it on', () => {
    expect(call({ settings: fee({ enabled: false }) })).toBe(false);
  });

  it('charges nothing when the amount is zero', () => {
    expect(call({ settings: fee({ amount: 0 }) })).toBe(false);
  });

  // The desk is looking at the patient and may know something the records do not.
  it('honours an explicit no from the desk', () => {
    expect(call({ deskChoice: false })).toBe(false);
  });

  it('honours an explicit yes for a returning patient', () => {
    expect(call({ isFirstVisit: false, deskChoice: true })).toBe(true);
  });

  // A slow double-click must not bill the fee twice.
  it('never charges twice while once-per-patient is on, even if the desk insists', () => {
    expect(call({ alreadyCharged: true })).toBe(false);
    expect(call({ alreadyCharged: true, deskChoice: true })).toBe(false);
  });

  it('allows a re-charge when the hospital turns once-per-patient off', () => {
    expect(
      call({ settings: fee({ oncePerPatient: false }), alreadyCharged: true, deskChoice: true }),
    ).toBe(true);
  });

  // Portal bookings never show a checkbox, so null has to fall back to the rule.
  it('falls back to the rule when the desk never said', () => {
    expect(call({ deskChoice: null, isFirstVisit: true })).toBe(true);
    expect(call({ deskChoice: null, isFirstVisit: false })).toBe(false);
  });

  // "Already registered on the portal" is not the same as "already been here".
  // isFirstVisit is computed per-hospital, so this function only ever sees the
  // per-hospital answer — pinned so the meaning does not drift.
  it('treats first-visit-here as the only trigger', () => {
    expect(call({ isFirstVisit: true, alreadyCharged: false })).toBe(true);
  });
});
