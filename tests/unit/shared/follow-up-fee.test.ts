import { describe, it, expect } from 'vitest';
import {
  combineRuleLayers,
  consultationLineDescription,
  describeRule,
  hospitalRuleSchema,
  overrideRuleSchema,
  priceUnderRule,
  type FollowUpRule,
  type FollowUpRuleLayer,
} from '../../../src/shared/follow-up-fee';

const layer = (over: Partial<FollowUpRuleLayer> = {}): FollowUpRuleLayer => ({
  freeDays: null,
  afterWindow: null,
  fixedFee: null,
  scope: null,
  dischargeStartsWindow: null,
  ...over,
});

const hospital = layer({
  freeDays: 7,
  afterWindow: 'fixed',
  fixedFee: 300,
  scope: 'same_doctor',
  dischargeStartsWindow: false,
});

const rule = (over: Partial<FollowUpRule> = {}): FollowUpRule => ({
  ...combineRuleLayers([{ level: 'hospital', layer: hospital }], true),
  ...over,
});

const price = (r: FollowUpRule, date: string, opts: { declared?: boolean; listFee?: number; from?: string | null } = {}) =>
  priceUnderRule(r, {
    listFee: opts.listFee ?? 500,
    declaredFollowUp: opts.declared ?? true,
    date,
    anchor:
      opts.from === null ? null : { date: new Date(`${opts.from ?? '2026-11-01'}T00:00:00.000Z`), kind: 'consultation' },
  });

describe('combining the levels', () => {
  it('uses the hospital default when the doctor has nothing', () => {
    const r = combineRuleLayers(
      [{ level: 'doctor', layer: layer() }, { level: 'hospital', layer: hospital }],
      true,
    );
    expect(r).toMatchObject({ freeDays: 7, afterWindow: 'fixed', fixedFee: 300, scope: 'same_doctor' });
    expect(r.sources.freeDays).toBe('hospital');
  });

  it('lets a doctor override one field and inherit the rest', () => {
    const r = combineRuleLayers(
      [{ level: 'hospital', layer: hospital }, { level: 'doctor', layer: layer({ freeDays: 14 }) }],
      true,
    );
    expect(r).toMatchObject({ freeDays: 14, afterWindow: 'fixed', fixedFee: 300 });
    expect(r.sources).toMatchObject({ freeDays: 'doctor', afterWindow: 'hospital' });
  });

  it('puts a department between the two', () => {
    const r = combineRuleLayers(
      [
        { level: 'hospital', layer: hospital },
        { level: 'department', layer: layer({ freeDays: 10, scope: 'same_department' }) },
        { level: 'doctor', layer: layer({ freeDays: 3 }) },
      ],
      true,
    );
    expect(r).toMatchObject({ freeDays: 3, scope: 'same_department', fixedFee: 300 });
  });

  it('treats a doctor with 0 days as none, not as inherit', () => {
    const r = combineRuleLayers(
      [{ level: 'hospital', layer: hospital }, { level: 'doctor', layer: layer({ freeDays: 0 }) }],
      true,
    );
    expect(r.freeDays).toBe(0);
    expect(price(r, '2026-11-01')).toMatchObject({ fee: 300, isFreeFollowUp: false });
  });

  it('never mixes one level’s mode with another level’s amount', () => {
    const r = combineRuleLayers(
      [{ level: 'hospital', layer: hospital }, { level: 'doctor', layer: layer({ afterWindow: 'full' }) }],
      true,
    );
    expect(r).toMatchObject({ afterWindow: 'full', fixedFee: null });
  });
});

describe('pricing under a rule', () => {
  it('is free through day N and charged from day N+1', () => {
    expect(price(rule(), '2026-11-08')).toMatchObject({
      fee: 0, isFreeFollowUp: true, dayNumber: 7, label: 'Free follow-up, day 7 of 7',
    });
    expect(price(rule(), '2026-11-09')).toMatchObject({
      fee: 300,
      isFreeFollowUp: false,
      kind: 'paid_follow_up',
      dayNumber: 8,
      label: 'Follow-up fee ₹300 (day 8, free follow-up ended on day 7)',
    });
  });

  it('reads "day 4 of 7" on the fourth day', () => {
    expect(price(rule(), '2026-11-05').label).toBe('Free follow-up, day 4 of 7');
  });

  it('counts IST calendar days, not 24-hour periods', () => {
    // Discharged 1 Nov 23:30 IST; visit on 8 Nov is day 7. A minute past the
    // next IST midnight the same discharge is day 6.
    const at = (iso: string) =>
      priceUnderRule(rule(), {
        listFee: 500, declaredFollowUp: true, date: '2026-11-08',
        anchor: { date: new Date(iso), kind: 'discharge' },
      }).dayNumber;
    expect(at('2026-11-01T18:00:00.000Z')).toBe(7); // 23:30 IST, 1 Nov
    expect(at('2026-11-01T18:31:00.000Z')).toBe(6); // 00:01 IST, 2 Nov
    expect(at('2026-11-02T00:10:00.000Z')).toBe(6); // 05:40 IST, 2 Nov
  });

  it('charges the full fee after the window in full mode', () => {
    const r = rule({ afterWindow: 'full', fixedFee: null });
    expect(price(r, '2026-11-09')).toMatchObject({ fee: 500, kind: 'paid_follow_up' });
  });

  it('allows a follow-up fee of zero without calling it a waiver', () => {
    const r = rule({ fixedFee: 0 });
    expect(price(r, '2026-11-20')).toMatchObject({ fee: 0, isFreeFollowUp: false, kind: 'paid_follow_up' });
  });

  it('never inherits the waiver when the admin gives no free days', () => {
    expect(price(rule({ freeDays: 0 }), '2026-11-01')).toMatchObject({ fee: 300, isFreeFollowUp: false });
  });

  it('charges the full fee for a "follow-up" with nothing to follow up', () => {
    const out = price(rule(), '2026-11-05', { from: null });
    expect(out).toMatchObject({ fee: 500, kind: 'consultation', isFreeFollowUp: false });
    expect(out.label).toContain('no earlier paid visit with this doctor');
  });

  it('keeps a consultation inside the window free and charges it in full after', () => {
    expect(price(rule(), '2026-11-08', { declared: false })).toMatchObject({ fee: 0, isFreeFollowUp: true });
    expect(price(rule(), '2026-11-09', { declared: false })).toMatchObject({ fee: 500, kind: 'consultation' });
  });

  it('does not call a doctor with no fee a free follow-up', () => {
    expect(price(rule(), '2026-11-05', { declared: false, listFee: 0 })).toMatchObject({ fee: 0, isFreeFollowUp: false });
  });
});

describe('wording', () => {
  it('summarises a rule', () => {
    expect(describeRule(rule())).toBe('Free for 7 days, then ₹300');
    expect(describeRule(rule({ freeDays: 1, afterWindow: 'full' }))).toBe('Free for 1 day, then full consultation fee');
    expect(describeRule(rule({ freeDays: 0, fixedFee: 1250.5 }))).toBe('No free days, follow-ups cost ₹1,250.50');
  });

  it('puts the rule on the bill line', () => {
    expect(consultationLineDescription(price(rule(), '2026-11-05'), 'Consultation Fee')).toBe(
      'Consultation Fee — Waived (Follow-up) — Free follow-up, day 4 of 7',
    );
    expect(consultationLineDescription(price(rule(), '2026-11-09'), 'Consultation Fee')).toContain('Follow-up fee ₹300');
    expect(consultationLineDescription(price(rule(), '2026-11-09', { declared: false }), 'Consultation Fee')).toBe(
      'Consultation Fee',
    );
  });
});

describe('what an admin may save', () => {
  const ok = { freeDays: 7, afterWindow: 'full', fixedFee: null, scope: 'same_doctor', dischargeStartsWindow: false };
  it.each([0, 90])('accepts %i free days', (freeDays) => {
    expect(hospitalRuleSchema.safeParse({ ...ok, freeDays }).success).toBe(true);
  });
  it.each([-1, 91, 2.5, '7', null])('refuses %s free days', (freeDays) => {
    expect(hospitalRuleSchema.safeParse({ ...ok, freeDays }).success).toBe(false);
  });
  it('needs an amount of zero or more for a fixed fee', () => {
    const fixed = { ...ok, afterWindow: 'fixed' };
    expect(hospitalRuleSchema.safeParse({ ...fixed, fixedFee: 0 }).success).toBe(true);
    expect(hospitalRuleSchema.safeParse({ ...fixed, fixedFee: -1 }).success).toBe(false);
    expect(hospitalRuleSchema.safeParse({ ...fixed, fixedFee: 10.005 }).success).toBe(false);
    expect(hospitalRuleSchema.safeParse(fixed).success).toBe(false);
  });
  it('lets an override leave every field to the default', () => {
    expect(
      overrideRuleSchema.safeParse({ freeDays: null, afterWindow: null, fixedFee: null, scope: null, dischargeStartsWindow: null }).success,
    ).toBe(true);
  });
});
