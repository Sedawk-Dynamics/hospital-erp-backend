import { describe, it, expect } from 'vitest';
import { trigrams, trigramSimilarity, bestWordSimilarity } from '../../../src/shared/trigram';

/**
 * The database chooses which rows are fuzzy candidates; this decides where they
 * sit once they arrive. If the two disagree about what "similar" means, a row
 * Postgres offered gets scored as no match in JS and silently disappears —
 * which is exactly how "cerebal infarction" came back empty while the query had
 * found I63.9 perfectly well.
 *
 * So the values below are not invented. Each is what `similarity()` returned
 * from the real database, to six places.
 */

/** Straight from `SELECT similarity($1, $2)` on PostgreSQL 18 with pg_trgm. */
const POSTGRES: [string, string, number][] = [
  ['diabetes', 'diabtes', 0.545455],
  ['asthma', 'asthama', 0.5],
  ['malaria', 'maleria', 0.454545],
  ['anaemia', 'anemia', 0.5],
  ['pneumonia', 'pnemonia', 0.583333],
  ['fever', 'fevr', 0.375],
  ['cerebral', 'cerebal', 0.545455],
  ['appendicitis', 'apendicitis', 0.785714],
  ['cholera', 'fracture', 0],
];

describe('trigram similarity', () => {
  it.each(POSTGRES)('matches Postgres for %s / %s', (a, b, expected) => {
    expect(trigramSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it('pads the way pg_trgm pads, so word edges count', () => {
    // Two leading spaces and one trailing. Without the padding "diabtes" would
    // score lower and drop under the threshold.
    expect([...trigrams('ab')]).toEqual(['  a', ' ab', 'ab ']);
  });

  it('is symmetric', () => {
    expect(trigramSimilarity('asthma', 'asthama')).toBe(trigramSimilarity('asthama', 'asthma'));
  });

  it('is 1 for identical strings and 0 for an empty one', () => {
    expect(trigramSimilarity('malaria', 'malaria')).toBe(1);
    expect(trigramSimilarity('', 'malaria')).toBe(0);
    expect(trigramSimilarity('malaria', '')).toBe(0);
  });
});

describe('best word similarity', () => {
  it('finds the mistyped word inside a long title', () => {
    // This is the whole point. Jaccard over the full string divides by the
    // union, so a long title drowns a short query: scored whole, "diabtes"
    // against this title is far below any usable threshold.
    const title = 'type 2 diabetes mellitus, without complications';
    expect(trigramSimilarity(title, 'diabtes')).toBeLessThan(0.2);
    expect(bestWordSimilarity(title, 'diabtes')).toBeCloseTo(0.545455, 5);
  });

  it('never scores below the whole-string similarity', () => {
    expect(bestWordSimilarity('anaemia', 'anemia')).toBeCloseTo(0.5, 5);
  });

  it('skips short words, which are similar to far too much', () => {
    // "of", "and" and "in" run through most ICD titles; letting them match
    // would make half the catalogue a candidate for any short query.
    expect(bestWordSimilarity('fracture of neck of femur', 'off')).toBe(
      trigramSimilarity('fracture of neck of femur', 'off'),
    );
  });

  it('splits on punctuation, not only spaces', () => {
    // ICD titles are full of commas and brackets: "Dengue fever [classical
    // dengue]", "Essential (primary) hypertension".
    expect(bestWordSimilarity('essential (primary) hypertension', 'hypertention')).toBeGreaterThan(
      0.6,
    );
  });

  it('returns 0 when either side is empty', () => {
    expect(bestWordSimilarity('', 'fever')).toBe(0);
    expect(bestWordSimilarity('fever, unspecified', '')).toBe(0);
  });
});
