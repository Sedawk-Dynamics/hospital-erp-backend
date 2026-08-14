import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseSalts,
  normaliseSalt,
  buildRuleIndex,
  classify,
  CLASSIFIER_VERSION,
  type RuleIndex,
  type ScheduleRuleLike,
} from '../../../../src/modules/drug-master/drug-schedule.classifier';
import RULES from '../../../../src/seeds/data/drug-schedule-rules.json';

/**
 * The classifier is the piece that decides whether a medicine needs a
 * prescription, so these tests run against the REAL seeded rule set rather than
 * a hand-made fixture — a rule that gets dropped or mis-spelled must fail here.
 *
 * Compositions are written exactly as the drug catalog stores them
 * ("Codeine (10mg/5ml) + Triprolidine (1.25mg/5ml)"), and several cases are
 * lifted verbatim from the hospital's own formulary.
 */

let index: RuleIndex;
beforeAll(() => {
  index = buildRuleIndex(RULES as unknown as ScheduleRuleLike[]);
});

const run = (
  genericName: string,
  extra: { brandName?: string; dosageForm?: string; route?: string } = {},
) => classify({ genericName, ...extra }, index);

describe('normaliseSalt', () => {
  it('strips the trailing salt form so the schedule name matches the product', () => {
    expect(normaliseSalt('Chlorpheniramine Maleate')).toBe('chlorpheniramine');
    expect(normaliseSalt('Metoprolol Succinate')).toBe('metoprolol');
    expect(normaliseSalt('Amikacin Sulphate')).toBe('amikacin');
  });

  it('keeps a single-token name that happens to be a salt word', () => {
    expect(normaliseSalt('Sodium')).toBe('sodium');
  });

  it('lowercases and drops punctuation', () => {
    expect(normaliseSalt('Cis-Platin')).toBe('cis-platin');
    expect(normaliseSalt('5-Fluorouracil')).toBe('5-fluorouracil');
  });
});

describe('parseSalts', () => {
  it('splits a combination and reads each strength', () => {
    const s = parseSalts('Tramadol (37.5mg) + Paracetamol (325mg)');
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ norm: 'tramadol', strengthValue: 37.5, strengthUnit: 'mg' });
    expect(s[1]).toMatchObject({ norm: 'paracetamol', strengthValue: 325 });
  });

  it('reads a per-volume strength', () => {
    const [codeine] = parseSalts('Codeine (10mg/5ml) + Triprolidine (1.25mg/5ml)');
    expect(codeine).toMatchObject({
      norm: 'codeine', strengthValue: 10, strengthUnit: 'mg', perVolumeMl: 5,
    });
  });

  it('treats a slashed name as a synonym pair, not two ingredients', () => {
    const s = parseSalts('Paracetamol/Acetaminophen (325mg) + Tramadol (37.5mg)');
    expect(s).toHaveLength(2);
    expect(s[0].norm).toBe('paracetamol');
  });

  it('survives an unreadable strength', () => {
    const [s] = parseSalts('Codeine (NA)');
    expect(s.norm).toBe('codeine');
    expect(s.strengthValue).toBeNull();
  });

  it('returns nothing for blank or missing input', () => {
    expect(parseSalts(null)).toEqual([]);
    expect(parseSalts('')).toEqual([]);
    expect(parseSalts('   ')).toEqual([]);
  });

  it('handles microgram and percentage strengths', () => {
    expect(parseSalts('Fentanyl (50mcg)')[0]).toMatchObject({ strengthValue: 50, strengthUnit: 'mcg' });
    expect(parseSalts('Lidocaine (2% w/v)')[0]).toMatchObject({ strengthValue: 2, strengthUnit: '%' });
  });
});

describe('cascade — first match wins', () => {
  it('puts a Schedule X stimulant in X', () => {
    const r = run('Methylphenidate (10mg)');
    expect(r.schedule).toBe('X');
  });

  it('puts a Schedule H1 antibiotic in H1', () => {
    expect(run('Cefixime (200mg)').schedule).toBe('H1');
    expect(run('Cefdinir (300mg)').schedule).toBe('H1');
  });

  it('puts a plain Schedule H drug in H', () => {
    expect(run('Atorvastatin (10mg)').schedule).toBe('H');
    expect(run('Metoprolol Succinate (50mg)').schedule).toBe('H');
  });

  it('puts a Schedule G drug in G', () => {
    expect(run('Metformin (500mg)').schedule).toBe('G');
    expect(run('Chlorthalidone (12.5mg)').schedule).toBe('G');
  });

  it('leaves an unlisted molecule over the counter', () => {
    expect(run('Ambroxol (15mg) + Guaifenesin (50mg)').schedule).toBe('OTC');
    expect(run('Paracetamol (650mg)').schedule).toBe('OTC');
  });

  it('lets the stricter schedule win in a combination', () => {
    // Tramadol (H1) + Paracetamol (unlisted) must resolve H1, not OTC.
    expect(run('Tramadol (37.5mg) + Paracetamol (325mg)').schedule).toBe('H1');
    // Chlordiazepoxide (H1) + Amitriptyline (H) must resolve H1, not H.
    expect(run('Amitriptyline (12.5mg) + Chlordiazepoxide (5mg)').schedule).toBe('H1');
  });

  it('classifies nothing when there is no composition', () => {
    const r = classify({ brandName: 'Mystery Tablet', genericName: null }, index);
    expect(r.schedule).toBe('OTC');
    expect(r.reason).toMatch(/No composition/i);
  });
});

describe('multi-salt schedule entries still match the plain molecule', () => {
  it('matches Diclofenac against "Diclofenac Sodium/Potassium/Acid"', () => {
    const r = run('Diclofenac (25mg)');
    expect(r.schedule).toBe('H');
    expect(r.matchedRule).toMatch(/Diclofenac/);
  });

  it('matches either isosorbide ester', () => {
    expect(run('Isosorbide Mononitrate (20mg)').schedule).toBe('H');
    expect(run('Isosorbide Dinitrate (10mg)').schedule).toBe('H');
  });
});

describe('therapeutic-class entries', () => {
  it('catches an antibiotic that is not individually listed', () => {
    // Schedule H item 32 is literally "Antibiotics".
    const r = run('Azithromycin (200mg/5ml)');
    expect(r.schedule).toBe('H');
    expect(r.matchedRule).toBe('Antibiotics');
  });

  it('catches a corticosteroid via the class entry', () => {
    expect(run('Fluticasone (50mcg)').schedule).toBe('H');
  });

  it('prefers a named molecule over the class it belongs to', () => {
    // Cefixime is named in Schedule H1; the H "Antibiotics" class must not win.
    const r = run('Cefixime (200mg)');
    expect(r.schedule).toBe('H1');
    expect(r.matchedRule).not.toBe('Antibiotics');
  });
});

describe('Schedule H2 — brand matched, QR tracked', () => {
  it('matches the whole trade name and asks for a QR scan', () => {
    const r = classify({ brandName: 'DOLO 650 MG TABLET 15', genericName: 'Paracetamol (650mg)' }, index);
    expect(r.schedule).toBe('H2');
    expect(r.requiresQrScan).toBe(true);
  });

  it('is case-insensitive on the brand', () => {
    expect(classify({ brandName: 'dolo 650 mg tablet 15', genericName: null }, index).schedule).toBe('H2');
  });

  it('does not fire on a similar but different pack', () => {
    const r = classify({ brandName: 'DOLO 650 MG TABLET 30', genericName: 'Paracetamol (650mg)' }, index);
    expect(r.schedule).not.toBe('H2');
    expect(r.requiresQrScan).toBe(false);
  });
});

describe('Schedule G topical exemption', () => {
  it('exempts a topical Schedule G preparation', () => {
    const r = classify(
      { brandName: 'Antihistamine Cream', genericName: 'Diphenhydramine (2%)', dosageForm: 'cream' },
      index,
    );
    expect(r.schedule).toBe('OTC');
    expect(r.reason).toMatch(/topical/i);
  });

  it('keeps an oral Schedule G preparation in G', () => {
    const r = classify(
      { brandName: 'Cypon Syrup', genericName: 'Cyproheptadine (2mg)', dosageForm: 'syrup' },
      index,
    );
    expect(r.schedule).toBe('G');
  });

  it('detects a topical route from the product name when the form is coarse', () => {
    const r = classify(
      { brandName: 'Some Ointment', genericName: 'Chlorpheniramine (1%)', dosageForm: 'other' },
      index,
    );
    expect(r.schedule).toBe('OTC');
  });

  it('does NOT exempt a topical Schedule H drug (Note 4 keeps steroids in)', () => {
    const r = classify(
      { brandName: 'Betamethasone Cream', genericName: 'Betamethasone (0.1%)', dosageForm: 'cream' },
      index,
    );
    expect(r.schedule).toBe('H');
  });
});

describe('NDPS overlay — a second, independent axis', () => {
  it('keeps tramadol on the counter as H1 while still flagging it controlled', () => {
    const r = run('Tramadol (50mg)');
    expect(r.schedule).toBe('H1');
    expect(r.controlledClass).toBe('psychotropic');
    // The whole point: 26 SKUs in this formulary must not land in a vault.
    expect(r.vaultControlled).toBe(false);
  });

  it('treats the benzodiazepines the same way', () => {
    for (const g of ['Alprazolam (0.5mg)', 'Diazepam (5mg)', 'Clonazepam (0.5mg)', 'Zolpidem (10mg)']) {
      const r = run(g);
      expect(r.controlledClass, g).toBe('psychotropic');
      expect(r.vaultControlled, g).toBe(false);
    }
  });

  it('vaults the true narcotics', () => {
    for (const g of ['Morphine (10mg)', 'Fentanyl (50mcg)', 'Pethidine (50mg)', 'Ketamine (50mg)']) {
      const r = run(g);
      expect(r.vaultControlled, g).toBe(true);
    }
    expect(run('Morphine (10mg)').controlledClass).toBe('narcotic');
  });

  it('leaves an ordinary drug uncontrolled', () => {
    const r = run('Atorvastatin (10mg)');
    expect(r.controlledClass).toBeNull();
    expect(r.vaultControlled).toBe(false);
  });
});

describe('codeine decision tree', () => {
  it('single ingredient → full narcotic control', () => {
    const r = run('Codeine (15mg)');
    expect(r.controlledClass).toBe('narcotic');
    expect(r.vaultControlled).toBe(true);
  });

  it('combination within the liquid limit → Schedule H1, no vault', () => {
    // 10 mg per 5 ml = 0.2% w/v, well under the 2.5% limit.
    const r = run('Chlorpheniramine Maleate (4mg/5ml) + Codeine (10mg/5ml)');
    expect(r.schedule).toBe('H1');
    expect(r.vaultControlled).toBe(false);
    expect(r.reason).toMatch(/within the NDPS concentration limits/i);
  });

  it('combination over the liquid limit → full narcotic control', () => {
    // 200 mg per 5 ml = 4% w/v, over the 2.5% limit.
    const r = run('Chlorpheniramine Maleate (4mg/5ml) + Codeine (200mg/5ml)');
    expect(r.vaultControlled).toBe(true);
    expect(r.reason).toMatch(/exceeds the NDPS concentration limit/i);
  });

  it('solid combination within the per-unit limit → Schedule H1', () => {
    const r = run('Paracetamol (650mg) + Codeine (30mg)');
    expect(r.schedule).toBe('H1');
    expect(r.vaultControlled).toBe(false);
  });

  it('solid combination over the per-unit limit → full narcotic control', () => {
    const r = run('Paracetamol (650mg) + Codeine (150mg)');
    expect(r.vaultControlled).toBe(true);
  });

  it('exactly at the limit counts as within it', () => {
    const r = run('Paracetamol (650mg) + Codeine (100mg)');
    expect(r.vaultControlled).toBe(false);
  });

  it('unreadable strength fails safe to full control and asks for review', () => {
    const r = run('Chlorpheniramine Maleate (NA) + Codeine (NA)');
    expect(r.vaultControlled).toBe(true);
    expect(r.needsReview).toBe(true);
  });

  it('never exempts a single-ingredient preparation, whatever the strength', () => {
    const r = run('Codeine (10mg/5ml)');
    expect(r.vaultControlled).toBe(true);
    expect(r.needsReview).toBe(false);
  });
});

describe('reporting', () => {
  it('always explains itself', () => {
    for (const g of ['Tramadol (50mg)', 'Atorvastatin (10mg)', 'Paracetamol (650mg)', 'Codeine (15mg)']) {
      expect(run(g).reason.length, g).toBeGreaterThan(10);
    }
  });

  it('rebuilds a clean composition string for the empty column', () => {
    const r = run('Tramadol (37.5mg) + Paracetamol (325mg)');
    expect(r.composition).toBe('Tramadol + Paracetamol');
  });

  it('leaves composition null when nothing could be parsed', () => {
    expect(classify({ genericName: null }, index).composition).toBeNull();
  });

  it('exposes a version so a re-run can find stale rows', () => {
    expect(CLASSIFIER_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('robustness', () => {
  it('never throws on messy real-world input', () => {
    const nasty = [
      '', '   ', '+++', 'Salt ()', '(500mg)', 'A + B + C + D + E',
      'Hydroxypropylmethylcellulose (0.3% w/v) + Glycerin (0.2% w/v)',
      'Progesterone (Natural Micronized) (25mg)',
    ];
    for (const g of nasty) {
      expect(() => run(g), g).not.toThrow();
    }
  });

  it('ignores a malformed class pattern instead of failing the classification', () => {
    const broken = buildRuleIndex([
      { scheduleCode: 'H', matchType: 'class', matchValue: 'Broken', matchNorm: 'broken', pattern: '([unclosed' },
    ] as ScheduleRuleLike[]);
    expect(() => classify({ genericName: 'Paracetamol (650mg)' }, broken)).not.toThrow();
    expect(classify({ genericName: 'Paracetamol (650mg)' }, broken).schedule).toBe('OTC');
  });
});
