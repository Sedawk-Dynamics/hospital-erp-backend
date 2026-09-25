import { describe, it, expect } from 'vitest';
import RULES from '../../../src/seeds/data/drug-schedule-rules.json';

/**
 * Guards on the drug schedule reference fixture.
 *
 * These rules are extracted from a CDSCO PDF whose text layer is imperfect OCR
 * and then hand-corrected, so the fixture is the one place a silent data
 * regression could mis-classify a controlled medicine. Nothing here touches the
 * database — it validates the shape and the statutory facts that the classifier
 * will depend on in the next phase.
 */

interface Rule {
  scheduleCode: string;
  matchType: string;
  matchValue: string;
  matchNorm: string;
  aliases?: string[];
  pattern?: string;
  controlledClass?: string;
  isNarcotic?: boolean;
  narcoticClass?: string;
  vaultControlled?: boolean;
  exemptIfCombination?: boolean;
  maxPerUnitMg?: number;
  maxConcentrationPercent?: number;
  fallbackSchedule?: string;
  topicalExempt?: boolean;
  notes?: string;
}

const rules = RULES as Rule[];
const bySchedule = (code: string) => rules.filter((r) => r.scheduleCode === code);
const find = (code: string, norm: string) =>
  rules.find((r) => r.scheduleCode === code && r.matchNorm === norm);

describe('drug schedule rules fixture — shape', () => {
  it('has every rule fully formed', () => {
    for (const r of rules) {
      expect(r.scheduleCode, JSON.stringify(r)).toBeTruthy();
      expect(['X', 'H1', 'H', 'G', 'H2', 'NDPS']).toContain(r.scheduleCode);
      expect(['salt', 'brand', 'class']).toContain(r.matchType);
      expect(r.matchValue.trim().length).toBeGreaterThan(0);
      expect(r.matchNorm.trim().length).toBeGreaterThan(0);
      expect(r.matchNorm).toBe(r.matchNorm.toLowerCase());
    }
  });

  it('has no duplicate (scheduleCode, matchType, matchNorm) — the upsert key', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of rules) {
      const key = `${r.scheduleCode}|${r.matchType}|${r.matchNorm}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    expect(dupes).toEqual([]);
  });

  it('gives every class rule a regex, and no salt/brand rule one', () => {
    for (const r of rules) {
      if (r.matchType === 'class') {
        expect(r.pattern, r.matchValue).toBeTruthy();
        expect(() => new RegExp(r.pattern!)).not.toThrow();
      } else {
        expect(r.pattern ?? null, r.matchValue).toBeNull();
      }
    }
  });

  it('never leaves an alias blank or non-normalised', () => {
    for (const r of rules) {
      for (const a of r.aliases ?? []) {
        expect(a.trim().length, `${r.matchValue}: empty alias`).toBeGreaterThan(0);
        expect(a, `${r.matchValue}: alias not normalised`).toBe(a.toLowerCase());
      }
    }
  });
});

describe('drug schedule rules fixture — statutory content', () => {
  it('carries the published entry counts', () => {
    // Schedule H publishes 552 serials, 30 of which are repealed placeholders.
    expect(bySchedule('X')).toHaveLength(15);
    expect(bySchedule('H1')).toHaveLength(51);
    expect(bySchedule('H2')).toHaveLength(300);
    expect(bySchedule('H').length).toBeGreaterThanOrEqual(515);
    expect(bySchedule('G').length).toBeGreaterThanOrEqual(60);
  });

  it('matches Schedule H2 on the brand name, never on a salt', () => {
    for (const r of bySchedule('H2')) expect(r.matchType).toBe('brand');
    expect(find('H2', 'dolo 650 mg tablet 15')).toBeDefined();
  });

  it('marks Schedule G as topical-exempt, per the Schedule’s own Note', () => {
    for (const r of bySchedule('G')) expect(r.topicalExempt).toBe(true);
  });

  it('keeps the H1 molecules that the NDPS list also names', () => {
    // These sit in BOTH lists. Schedule H1 governs what the counter collects;
    // the NDPS overlay governs which register they appear in. Losing the H1 row
    // would wrongly push them into vault custody.
    for (const n of ['tramadol', 'codeine', 'alprazolam', 'diazepam', 'zolpidem',
                     'buprenorphine', 'pentazocine', 'midazolam', 'nitrazepam',
                     'chlordiazepoxide', 'diphenoxylate']) {
      expect(find('H1', n), `Schedule H1 missing ${n}`).toBeDefined();
    }
  });

  it('includes the 2026 Pregabalin Schedule H1 amendment', () => {
    const pregabalin = find('H1', 'pregabalin');
    expect(pregabalin).toBeDefined();
    expect(pregabalin?.notes).toMatch(/G\.S\.R\. 377\(E\).*13 May 2026/);
  });

  it('resolves multi-salt Schedule H entries down to the plain molecule', () => {
    // "Diclofenac Sodium/Potassium/Acid" must still match a product whose
    // composition simply says "Diclofenac".
    const diclofenac = bySchedule('H').find((r) => r.aliases?.includes('diclofenac'));
    expect(diclofenac).toBeDefined();
    const isosorbide = bySchedule('H').find((r) => r.aliases?.includes('isosorbide'));
    expect(isosorbide).toBeDefined();
  });

  it('carries Indian labelling spellings as aliases', () => {
    const pheno = rules.find((r) => r.matchNorm === 'phenobarbitone');
    expect(pheno?.aliases).toContain('phenobarbital');
  });
});

describe('drug schedule rules fixture — NDPS overlay', () => {
  const ndps = bySchedule('NDPS');

  it('never wins the cascade on its own — every NDPS row carries a class', () => {
    for (const r of ndps) {
      expect(['narcotic', 'psychotropic'], r.matchValue).toContain(r.controlledClass);
      expect(r.isNarcotic).toBe(r.controlledClass === 'narcotic');
    }
  });

  it('vaults the opioids and leaves the benzodiazepines on the counter', () => {
    for (const n of ['morphine', 'fentanyl', 'pethidine', 'methadone', 'ketamine']) {
      expect(find('NDPS', n)?.vaultControlled, `${n} must be vault-controlled`).toBe(true);
    }
    // Dispensed normally under Schedule H1 with a register entry — vaulting these
    // would strand every tramadol and benzodiazepine SKU in the formulary.
    for (const n of ['tramadol', 'zolpidem', 'alprazolam', 'diazepam', 'lorazepam',
                     'clonazepam', 'carisoprodol']) {
      expect(find('NDPS', n)?.vaultControlled, `${n} must NOT be vault-controlled`).toBe(false);
    }
  });

  it('encodes the codeine concentration exemption', () => {
    const codeine = find('NDPS', 'codeine');
    expect(codeine).toBeDefined();
    expect(codeine!.exemptIfCombination).toBe(true);
    expect(codeine!.maxPerUnitMg).toBe(100);
    expect(codeine!.maxConcentrationPercent).toBe(2.5);
    expect(codeine!.fallbackSchedule).toBe('H1');
  });

  it('only allows a fallback schedule where a threshold defines one', () => {
    for (const r of ndps) {
      if (r.fallbackSchedule) {
        expect(r.exemptIfCombination, r.matchValue).toBe(true);
        expect(
          r.maxPerUnitMg != null || r.maxConcentrationPercent != null,
          `${r.matchValue}: fallback without a limit would exempt everything`,
        ).toBe(true);
      }
    }
  });
});
