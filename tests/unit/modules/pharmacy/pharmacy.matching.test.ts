import { describe, it, expect } from 'vitest';
import {
  normalizeDrugName,
  scoreMatch,
  MATCH_SUGGEST_THRESHOLD,
  MATCH_BLOCK_THRESHOLD,
} from '../../../../src/modules/pharmacy/pharmacy.matching';

describe('normalizeDrugName', () => {
  it('strips trailing dosage-form words', () => {
    expect(normalizeDrugName('Telmac 40 Tab')).toBe('telmac 40');
    expect(normalizeDrugName('Pantop 40 Injection')).toBe('pantop 40');
    expect(normalizeDrugName('Ascoril Syp')).toBe('ascoril');
  });

  it('folds strength units and spacing to the bare number', () => {
    expect(normalizeDrugName('Crocin Advance 650 mg')).toBe('crocin advance 650');
    expect(normalizeDrugName('Crocin Advance 650mg')).toBe('crocin advance 650');
    expect(normalizeDrugName('Calpol 2.5mg Drops')).toBe('calpol 2.5');
  });

  it('drops punctuation', () => {
    expect(normalizeDrugName('Telma-H (40+12.5)')).toBe('telma h 40 12.5');
  });
});

describe('scoreMatch', () => {
  it('treats abbreviation variants as the same drug (field example)', () => {
    // "Telmac 40" already on file; invoice says "Telmac 40 Tab".
    const score = scoreMatch(
      { drugName: 'Telmac 40 Tab' },
      { drugName: 'Telmac 40' },
    );
    expect(score).toBeGreaterThanOrEqual(MATCH_BLOCK_THRESHOLD);
  });

  it('matches truncated / spaced brand names (Crocin Adv example)', () => {
    const score = scoreMatch(
      { drugName: 'Crocin Adv 650' },
      { drugName: 'Crocin Advance 650mg' },
    );
    expect(score).toBeGreaterThanOrEqual(MATCH_SUGGEST_THRESHOLD);
  });

  it('does NOT match different strengths of the same brand', () => {
    // Telma 20 must stay distinct from Telma 40 — strength is identity-bearing.
    const score = scoreMatch(
      { drugName: 'Telma 20' },
      { drugName: 'Telma 40' },
    );
    expect(score).toBeLessThan(MATCH_BLOCK_THRESHOLD);
  });

  it('does not match unrelated drugs', () => {
    const score = scoreMatch(
      { drugName: 'Paracetamol 500' },
      { drugName: 'Amoxicillin 250' },
    );
    expect(score).toBeLessThan(MATCH_SUGGEST_THRESHOLD);
  });

  it('boosts when manufacturer and generic also agree', () => {
    const withMeta = scoreMatch(
      { drugName: 'Pantium 40', genericName: 'Pantoprazole', manufacturer: 'Sun Pharma', dosageForm: 'tablet' },
      { drugName: 'Pantium 40 Tab', genericName: 'Pantoprazole', manufacturer: 'Sun Pharma', dosageForm: 'tablet' },
    );
    expect(withMeta).toBeGreaterThanOrEqual(MATCH_BLOCK_THRESHOLD);
  });
});
