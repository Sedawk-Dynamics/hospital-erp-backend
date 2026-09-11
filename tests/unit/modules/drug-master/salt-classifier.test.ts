import { describe, it, expect } from 'vitest';
import { classifyFromSalts, type SaltRow } from '../../../../src/modules/drug-master/salt-classifier';

/**
 * The salt classifier decides a schedule from structured molecules instead of
 * parsing text. Its agreement with the string classifier is proven across all
 * 253,987 catalog products by `npm run db:diff-salt-classifier`; these tests pin
 * the statutory logic that no diff could have exercised — the branches that
 * depend on data the catalog happens not to contain.
 */

const salt = (over: Partial<SaltRow> & { name: string }): SaltRow => ({
  scheduleCode: null,
  controlledClass: null,
  narcoticClass: null,
  vaultControlled: false,
  exemptIfCombination: false,
  maxPerUnitMg: null,
  maxConcentrationPercent: null,
  fallbackSchedule: null,
  topicalExempt: false,
  strengthValue: null,
  strengthUnit: null,
  perVolumeValue: null,
  ...over,
});

const PARACETAMOL = salt({ name: 'Paracetamol', strengthValue: 500, strengthUnit: 'mg' });
const TRAMADOL = salt({
  name: 'Tramadol', scheduleCode: 'H1', controlledClass: 'psychotropic',
  strengthValue: 50, strengthUnit: 'mg',
});
const CODEINE = (over: Partial<SaltRow> = {}) => salt({
  name: 'Codeine', scheduleCode: 'H1', controlledClass: 'narcotic', vaultControlled: true,
  exemptIfCombination: true, maxPerUnitMg: 100, maxConcentrationPercent: 2.5,
  fallbackSchedule: 'H1', strengthValue: 30, strengthUnit: 'mg', ...over,
});
const CHLORPHENIRAMINE = salt({
  name: 'Chlorpheniramine', scheduleCode: 'G', topicalExempt: true,
  strengthValue: 4, strengthUnit: 'mg',
});

describe('the cascade', () => {
  it('lets the strictest molecule decide a combination', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL, TRAMADOL] });
    expect(r.schedule).toBe('H1');
    expect(r.matchedRule).toBe('Tramadol');
  });

  it('reports over-the-counter when nothing is scheduled', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL] });
    expect(r.schedule).toBe('OTC');
  });

  it('treats a molecule nobody has scheduled as no opinion, not as safe', () => {
    // scheduleCode NULL means undecided. It must not out-vote a real schedule.
    const r = classifyFromSalts({ salts: [salt({ name: 'Warfarin' }), TRAMADOL] });
    expect(r.schedule).toBe('H1');
  });

  it('says nothing at all for a product with no molecules', () => {
    const r = classifyFromSalts({ salts: [] });
    expect(r.schedule).toBe('OTC');
    expect(r.reason).toMatch(/No composition recorded/);
  });
});

describe('the label, where the molecules leave the answer open', () => {
  // Undecided: nobody has scheduled it yet (scheduleCode NULL).
  const BRIVARACETAM = salt({ name: 'Brivaracetam', strengthValue: 50, strengthUnit: 'mg' });

  it('makes a prescription-only product Schedule H while a molecule is undecided', () => {
    const r = classifyFromSalts({ salts: [BRIVARACETAM], prescriptionOnly: true });
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/prescription only/i);
    expect(r.reason).toMatch(/Brivaracetam/);
  });

  it('never overrules a decided molecule', () => {
    // Decided over-the-counter, and a Schedule G molecule exempt as topical.
    const decided = salt({ name: 'Paracetamol', scheduleCode: 'OTC' });
    expect(classifyFromSalts({ salts: [decided], prescriptionOnly: true }).schedule).toBe('OTC');
    const cream = classifyFromSalts({ salts: [CHLORPHENIRAMINE], dosageForm: 'cream', prescriptionOnly: true });
    expect(cream.schedule).toBe('OTC');
  });

  it('changes nothing without the label', () => {
    expect(classifyFromSalts({ salts: [BRIVARACETAM] }).schedule).toBe('OTC');
    expect(classifyFromSalts({ salts: [BRIVARACETAM], prescriptionOnly: false }).schedule).toBe('OTC');
  });

  it('leaves a scheduled product on its own schedule', () => {
    const r = classifyFromSalts({ salts: [BRIVARACETAM, TRAMADOL], prescriptionOnly: true });
    expect(r.schedule).toBe('H1');
    expect(r.matchedRule).toBe('Tramadol');
  });

  it('treats a prescription-only product with no composition as Schedule H', () => {
    const r = classifyFromSalts({ salts: [], prescriptionOnly: true });
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/no composition/i);
  });
});

describe('Schedule G topical exemption', () => {
  it('exempts a topical preparation', () => {
    const r = classifyFromSalts({ salts: [CHLORPHENIRAMINE], dosageForm: 'cream' });
    expect(r.schedule).toBe('OTC');
    expect(r.reason).toMatch(/topical\/external/);
  });

  it('keeps an oral preparation in G', () => {
    const r = classifyFromSalts({ salts: [CHLORPHENIRAMINE], dosageForm: 'syrup' });
    expect(r.schedule).toBe('G');
  });

  it('does not read a flavour name as a route', () => {
    // The bug that put an antihistamine syrup over the counter on the word
    // "Cream" in "American Ice Cream".
    const r = classifyFromSalts({
      salts: [CHLORPHENIRAMINE],
      brandName: 'Aroget DX Syrup American Ice Cream',
      dosageForm: 'syrup',
    });
    expect(r.schedule).toBe('G');
  });
});

describe('the NDPS overlay', () => {
  it('keeps schedule and controlled class independent', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL, TRAMADOL] });
    expect(r.schedule).toBe('H1');
    expect(r.controlledClass).toBe('psychotropic');
    expect(r.vaultControlled).toBe(false);
  });

  it('exempts a codeine combination inside the per-unit limit', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL, CODEINE()] });
    expect(r.schedule).toBe('H1');
    expect(r.vaultControlled).toBe(false);
    expect(r.reason).toMatch(/within the NDPS concentration limits/);
  });

  it('refuses a single-ingredient narcotic on the right ground', () => {
    const r = classifyFromSalts({ salts: [CODEINE({ strengthValue: 15 })] });
    expect(r.vaultControlled).toBe(true);
    expect(r.reason).toMatch(/only active ingredient/);
    expect(r.reason).not.toMatch(/exceeds/);
  });

  it('refuses a combination over the per-unit limit', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL, CODEINE({ strengthValue: 150 })] });
    expect(r.vaultControlled).toBe(true);
    expect(r.reason).toMatch(/exceeds/);
  });

  it('reads a liquid by concentration, not by mass', () => {
    // 10mg per 5ml is 0.2% w/v, inside the 2.5% limit.
    const r = classifyFromSalts({
      salts: [PARACETAMOL, CODEINE({ strengthValue: 10, perVolumeValue: 5 })],
    });
    expect(r.vaultControlled).toBe(false);
  });

  it('fails safe when the strength cannot be read', () => {
    const r = classifyFromSalts({
      salts: [PARACETAMOL, CODEINE({ strengthValue: null, strengthUnit: null })],
    });
    expect(r.vaultControlled).toBe(true);
    expect(r.needsReview).toBe(true);
  });

  it('never leaves an NDPS drug over the counter', () => {
    const morphine = salt({
      name: 'Morphine', scheduleCode: null, controlledClass: 'narcotic', vaultControlled: true,
      strengthValue: 30, strengthUnit: 'mg',
    });
    const r = classifyFromSalts({ salts: [morphine] });
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/NDPS Act/);
    expect(r.reason).not.toMatch(/over the counter/);
  });
});

describe('therapeutic class provenance', () => {
  it('explains a class-derived schedule instead of naming a molecule not on the list', () => {
    // Sulphacetamide is not named in Schedule H; it is covered by a category.
    // "matched Sulphacetamide" would send a pharmacist hunting the H list.
    const sulph = salt({
      name: 'Sulphacetamide', scheduleCode: 'H',
      classes: [{ name: 'Para-Amino Benzene Sulphonamide, its Salts & Derivatives', scheduleCode: 'H' }],
      strengthValue: 20, strengthUnit: '%',
    });
    const r = classifyFromSalts({ salts: [sulph, CHLORPHENIRAMINE], dosageForm: 'drops' });
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/falls under the "Para-Amino Benzene Sulphonamide/);
  });
});

describe('Schedule H2', () => {
  it('rides alongside the schedule without replacing it', () => {
    const r = classifyFromSalts(
      { salts: [PARACETAMOL] },
      { requiresQrScan: true, qrFormulation: 'DOLO 650 MG TABLET 15' },
    );
    expect(r.schedule).toBe('OTC');
    expect(r.requiresQrScan).toBe(true);
    expect(r.reason).toMatch(/QR\/barcode/);
  });
});

describe('the composition it reports', () => {
  it('renders strengths back without needing the original text', () => {
    const r = classifyFromSalts({ salts: [PARACETAMOL, CODEINE()] });
    expect(r.composition).toBe('Paracetamol (500mg) + Codeine (30mg)');
  });

  it('renders a per-volume strength', () => {
    const r = classifyFromSalts({ salts: [CODEINE({ strengthValue: 10, perVolumeValue: 5 })] });
    expect(r.composition).toBe('Codeine (10mg/5ml)');
  });
});
