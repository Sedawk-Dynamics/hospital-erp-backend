import { describe, it, expect } from 'vitest';
import ICD10 from '../../../src/seeds/data/icd10-who-2019.json';

/**
 * Guards on the WHO ICD-10 dataset the seed ships.
 *
 * The file is generated from the WHO ClaML XML by
 * prisma/scripts/parse-icd10-claml.py, so what is really being pinned here is
 * the parser: if someone regenerates it against a new release, or changes how
 * labels and modifiers are handled, these are the properties that must survive.
 *
 * The fourth-character expansion is the part most worth guarding. WHO expresses
 * subdivisions through a shared Modifier block rather than writing them out, so
 * a naive parse produces a catalogue with E11 but no E11.9 — and E11.9 is one
 * of the codes a hospital reaches for most.
 */

const RELEASE = ICD10 as {
  version: string;
  codes: { c: string; t: string; b: string | null; ch: string | null; leaf: boolean; k?: string[] }[];
};
const CODES = RELEASE.codes;
const BY_CODE = new Map(CODES.map((c) => [c.c, c]));

describe('the shipped ICD-10 dataset', () => {
  it('covers the catalogue rather than a starter set', () => {
    // The curated seed it replaces was 76 rows — under 1% of ICD-10. A parser
    // change that quietly halves coverage should fail here, not in a clinic.
    expect(CODES.length).toBeGreaterThan(12_000);
  });

  it('has no malformed codes', () => {
    const bad = CODES.filter((c) => !/^[A-Z][0-9]{2}(\.[0-9A-Z])?$/.test(c.c));
    expect(bad.map((c) => c.c)).toEqual([]);
  });

  it('has no duplicate codes', () => {
    // `IcdCode` is unique on (tenantId, code), so a duplicate would not merely
    // be untidy — createMany would silently drop one and the seed would report
    // a count it did not write.
    expect(CODES.length).toBe(BY_CODE.size);
  });

  it('fits the columns it is seeded into', () => {
    // code VarChar(20), title VarChar(500), category/chapter VarChar(255).
    expect(Math.max(...CODES.map((c) => c.c.length))).toBeLessThanOrEqual(20);
    expect(Math.max(...CODES.map((c) => c.t.length))).toBeLessThanOrEqual(500);
    expect(Math.max(...CODES.map((c) => (c.b ?? '').length))).toBeLessThanOrEqual(255);
    expect(Math.max(...CODES.map((c) => (c.ch ?? '').length))).toBeLessThanOrEqual(255);
  });

  it('resolves a block and chapter for every code', () => {
    // Both are walked up the SuperClass chain. A hierarchy change that breaks
    // the walk shows up as nulls, which the picker would render as a code with
    // no context at all.
    expect(CODES.filter((c) => !c.b || !c.ch)).toEqual([]);
  });

  describe('fourth-character subdivisions', () => {
    it('includes E11.9, which the raw XML does not contain', () => {
      expect(BY_CODE.get('E11.9')).toMatchObject({
        t: 'Type 2 diabetes mellitus, without complications',
        b: 'Diabetes mellitus',
        ch: 'Endocrine, nutritional and metabolic diseases',
        leaf: true,
      });
    });

    it('expands the whole shared modifier, not just the common member', () => {
      // E10-E14 all point at the same modifier block, so getting one right and
      // the rest wrong is a plausible failure.
      for (const code of ['E10.9', 'E12.9', 'E13.9', 'E14.9', 'E11.2', 'E11.7']) {
        expect(BY_CODE.get(code), code).toBeDefined();
      }
    });

    it('demotes a parent that gained subdivisions to a grouping', () => {
      // E11 is no longer something to code against on its own once E11.0-.9
      // exist beneath it; `leaf` is what becomes isBillable.
      expect(BY_CODE.get('E11')?.leaf).toBe(false);
    });
  });

  describe('inclusion terms', () => {
    it('keeps the terms clinicians actually search by', () => {
      expect(BY_CODE.get('I10')?.k).toContain('high blood pressure');
    });

    it('splits label fragments into separate terms', () => {
      // I21.0's inclusion rubric is a stem ("Transmural infarction (acute)(of):")
      // followed by fragments. Joining them yields one unsearchable string; a
      // doctor types "anterolateral".
      expect(BY_CODE.get('I21.0')?.k).toContain('anterolateral');
    });

    it('lowercases them, because the seed matches on exact array elements', () => {
      const withUppercase = CODES.filter((c) => (c.k ?? []).some((k) => k !== k.toLowerCase()));
      expect(withUppercase.map((c) => c.c)).toEqual([]);
    });
  });
});
