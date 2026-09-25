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

  it('puts Pregabalin and its formulations in H1 under the 2026 amendment', () => {
    expect(run('Pregabalin (75mg)').schedule).toBe('H1');
    expect(run('Pregabalin (75mg) + Methylcobalamin (750mcg)').schedule).toBe('H1');
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

describe('the label, when no molecule is scheduled', () => {
  // Brivaracetam is named by no schedule: an antiepileptic sold on prescription.
  it('makes a prescription-only product Schedule H', () => {
    const r = classify({ genericName: 'Brivaracetam (50mg)', prescriptionOnly: true }, index);
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/prescription only/i);
  });

  it('never outranks a molecule the schedules name', () => {
    expect(classify({ genericName: 'Metformin (500mg)', prescriptionOnly: true }, index).schedule).toBe('G');
    expect(classify({ genericName: 'Cefixime (200mg)', prescriptionOnly: true }, index).schedule).toBe('H1');
  });

  it('leaves the topical exemption Schedule G writes for itself standing', () => {
    const r = classify(
      { genericName: 'Chlorpheniramine (4mg)', dosageForm: 'cream', prescriptionOnly: true },
      index,
    );
    expect(r.schedule).toBe('OTC');
  });

  it('changes nothing without the label', () => {
    expect(run('Brivaracetam (50mg)').schedule).toBe('OTC');
  });

  it('treats a prescription-only product with no composition as Schedule H', () => {
    const r = classify({ brandName: 'Mystery Tablet', genericName: null, prescriptionOnly: true }, index);
    expect(r.schedule).toBe('H');
    expect(r.reason).toMatch(/no composition/i);
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

  it('does not let a named ingredient hide a stricter class match on another ingredient', () => {
    // Chlorpheniramine is named in G. Sulphacetamide is covered by the H
    // sulphonamide class. The old product-level fallback stopped after seeing
    // the G hit and incorrectly returned G for these eye drops.
    const r = run('Sulphacetamide (15% w/v) + Chlorpheniramine Maleate (0.01% w/v)', {
      dosageForm: 'drops',
    });
    expect(r.schedule).toBe('H');
    expect(r.matchedRule).toMatch(/Para-Amino Benzene Sulphonamide/);
  });
});

describe('molecules published in more than one schedule', () => {
  it('always applies the strictest published schedule', () => {
    // Each molecule has duplicate entries in the real fixture.
    expect(run('Bleomycin (15IU)').schedule).toBe('H');
    expect(run('Doxorubicin (50mg)').schedule).toBe('H');
    expect(run('Cefotaxime (1000mg)').schedule).toBe('H1');
  });
});

describe('the stated reason is the one a pharmacist can check', () => {
  /**
   * The reason is shown on the drug page and to an inspector, so a sentence
   * that contradicts itself or cites the wrong ground is a defect in its own
   * right — these are the drugs whose explanation gets read most carefully.
   */
  it('does not call an NDPS narcotic over-the-counter on its way to Schedule H', () => {
    const r = run('Morphine (30mg)');
    expect(r.schedule).toBe('H');
    expect(r.reason).not.toMatch(/over the counter/i);
    expect(r.reason).toMatch(/NDPS Act/);
  });

  it('refuses a single-ingredient narcotic on the right ground', () => {
    // 15mg is well UNDER the 100mg limit — saying it "exceeds" it is false.
    // The actual ground is that the exemption covers combinations only.
    const r = run('Codeine (15mg)');
    expect(r.vaultControlled).toBe(true);
    expect(r.reason).toMatch(/only active ingredient/i);
    expect(r.reason).not.toMatch(/exceeds/i);
  });

  it('still says "exceeds" when the strength genuinely exceeds the limit', () => {
    const r = run('Codeine (150mg) + Paracetamol (500mg)');
    expect(r.reason).toMatch(/exceeds/i);
  });
});

describe('the derived composition round-trips', () => {
  /**
   * The result's `composition` is written back to the column the classifier
   * PREFERS on the next run. If it drops the strength, the next run cannot read
   * it — and the codeine exemption, which is the one rule that needs a strength,
   * fails safe and vaults an ordinary codeine tablet. 178 products were in that
   * state against 32 correctly exempted.
   */
  it('keeps the strength, so re-classifying gives the same answer', () => {
    const first = run('Paracetamol (650mg) + Codeine (30mg)');
    expect(first.composition).toBe('Paracetamol (650mg) + Codeine (30mg)');

    // Feed the derived composition back in, exactly as the next run would.
    const second = classify({ composition: first.composition, genericName: null }, index);
    expect(second.schedule).toBe(first.schedule);
    expect(second.vaultControlled).toBe(first.vaultControlled);
    expect(second.needsReview).toBe(false);
  });

  it('keeps a per-volume strength', () => {
    const r = run('Codeine (10mg/5ml) + Triprolidine (1.25mg/5ml)');
    expect(r.composition).toContain('Codeine (10mg/5ml)');
    expect(classify({ composition: r.composition, genericName: null }, index).needsReview).toBe(false);
  });

  it('exempts a codeine combination that is within the per-unit limit', () => {
    // 30mg is well under the 100mg/unit limit, and it is a combination — so it
    // dispenses as H1 rather than from the safe.
    const r = run('Paracetamol (650mg) + Codeine (30mg)');
    expect(r.schedule).toBe('H1');
    expect(r.vaultControlled).toBe(false);
    expect(r.controlledClass).toBe('narcotic');
  });

  it('still writes a bare name when there is no strength to keep', () => {
    expect(run('Paracetamol').composition).toBe('Paracetamol');
  });

  it('repairs a stripped composition from the generic name', () => {
    // The state 246,485 catalog rows are already in.
    const r = classify(
      {
        composition: 'Paracetamol + Codeine',
        genericName: 'Paracetamol (650mg) + Codeine (30mg)',
      },
      index,
    );
    expect(r.vaultControlled).toBe(false);
    expect(r.needsReview).toBe(false);
    expect(r.composition).toBe('Paracetamol (650mg) + Codeine (30mg)');
  });

  it('still prefers the curated composition when it carries strengths', () => {
    const r = classify(
      { composition: 'Codeine (10mg)', genericName: 'Something Else (999mg)' },
      index,
    );
    expect(r.composition).toBe('Codeine (10mg)');
  });

  it('leaves a genuinely strengthless drug alone', () => {
    const r = classify({ composition: 'Paracetamol', genericName: 'Paracetamol' }, index);
    expect(r.composition).toBe('Paracetamol');
  });
});

describe('topical detection does not run on a flavour name', () => {
  it('does not treat an oral syrup as an external preparation', () => {
    // "Aroget DX Syrup American Ice Cream" was read as topical on the word
    // "Cream", which exempted its Schedule G antihistamine down to OTC.
    const r = classify(
      {
        brandName: 'Aroget DX Syrup American Ice Cream',
        genericName: 'Phenylephrine (5mg/5ml) + Chlorpheniramine Maleate (2mg/5ml)',
        dosageForm: 'syrup',
      },
      index,
    );
    expect(r.schedule).toBe('G');
  });

  it('still exempts a genuine topical preparation', () => {
    const r = classify(
      { brandName: 'Some Cream', genericName: 'Chlorpheniramine Maleate (2mg)', dosageForm: 'cream' },
      index,
    );
    expect(r.schedule).toBe('OTC');
  });

  it('still guesses from the name when the dosage form is the coarse bucket', () => {
    // Ointments and lotions all land in `other`, which is why the guess exists.
    const r = classify(
      { brandName: 'Something Ointment', genericName: 'Chlorpheniramine Maleate (2mg)', dosageForm: 'other' },
      index,
    );
    expect(r.schedule).toBe('OTC');
  });
});

describe('Schedule H2 — a QR obligation, never a schedule', () => {
  /**
   * H2 is the anti-counterfeiting list under Rule 96(6)-(7), not a prescription
   * control. It used to be the top rung of the cascade and returned early, so a
   * brand hit replaced the real schedule and blanked the NDPS fields. Both of
   * the drugs below are on the notified list AND need a prescription, which is
   * exactly the combination that used to be lost.
   */
  it('raises the QR flag without touching the schedule', () => {
    const r = classify(
      { brandName: 'DOLO 650 MG TABLET 15', genericName: 'Paracetamol (650mg)' },
      index,
    );
    expect(r.requiresQrScan).toBe(true);
    expect(r.schedule).toBe('OTC'); // paracetamol is not scheduled
    expect(r.schedule).not.toBe('H2');
  });

  it('never downgrades a prescription drug that is on the list', () => {
    const r = classify(
      { brandName: 'MERONEM 1000 MG INJECTION 1', genericName: 'Meropenem (1000mg)' },
      index,
    );
    expect(r.requiresQrScan).toBe(true);
    expect(r.schedule).toBe('H1'); // meropenem is named in H1, which the cascade still reaches
  });

  it('never blanks the NDPS overlay for a listed brand', () => {
    // Deca Durabolin is nandrolone — Schedule H via the anabolic-steroid class
    // entry. A brand hit must not wipe what the composition established.
    const r = classify(
      { brandName: 'DECA DURABOLIN 50 MG INJECTION 1', genericName: 'Nandrolone Decanoate (50mg)' },
      index,
    );
    expect(r.requiresQrScan).toBe(true);
    expect(r.schedule).toBe('H');
  });

  it('is case-insensitive and ignores the pack the list was notified with', () => {
    // The notified name carries a pack count; no catalog writes one. Matching
    // on the pack is why this list matched 0 of 253,987 catalog rows.
    for (const brand of ['dolo 650 mg tablet 15', 'Dolo 650 Tablet', 'DOLO 650MG TABLET 30']) {
      expect(classify({ brandName: brand, genericName: null }, index).requiresQrScan, brand).toBe(true);
    }
  });

  it('still separates two strengths of the same brand', () => {
    // "Pan 40" is notified; the number is what distinguishes it from Pan 20, so
    // dropping the pack must not drop the strength too.
    expect(classify({ brandName: 'PAN 40 MG TABLET 15', genericName: null }, index).requiresQrScan).toBe(true);
    expect(classify({ brandName: 'PAN 20 MG TABLET 15', genericName: null }, index).requiresQrScan).toBe(false);
  });

  it('leaves an unlisted brand alone', () => {
    expect(classify({ brandName: 'Some Unlisted Brand', genericName: null }, index).requiresQrScan).toBe(false);
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

  it('never labels a controlled drug OTC', () => {
    // Schedule H names "Narcotic Drugs listed in the NDPS Act, 1985" as an
    // entry in its own right. Nothing in the salt lists spells out morphine, so
    // without that the cascade returned OTC and a register would have printed
    // "OTC" beside a vault-controlled narcotic.
    for (const g of ['Morphine (10mg)', 'Fentanyl (50mcg)', 'Pethidine (50mg)']) {
      const r = run(g);
      expect(r.schedule, g).not.toBe('OTC');
      expect(r.controlledClass, g).toBeTruthy();
    }
    expect(run('Morphine (10mg)').reason).toMatch(/NDPS Act/i);
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
    // Normalised spacing and separators, but the strengths are kept — this
    // string is read back as input on the next run, so dropping them would
    // lose the only data the codeine exemption depends on.
    const r = run('Tramadol  (37.5mg)  +   Paracetamol (325mg)');
    expect(r.composition).toBe('Tramadol (37.5mg) + Paracetamol (325mg)');
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
