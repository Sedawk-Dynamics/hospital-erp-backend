import { describe, it, expect } from 'vitest';
import { rankIcdResults, type RankableIcd } from '../../../../src/modules/icd/icd-search-rank';

/**
 * Ranking exists because the catalogue grew from 76 curated rows to the full
 * WHO release. At 76 rows "order by code, take 20" was fine — almost everything
 * that matched fitted on one screen. At ~12,300 it hides the answer.
 *
 * Every case below is one that was measured against the real seeded catalogue,
 * so these are regressions rather than invented examples.
 */

function icd(code: string, title: string, extra: Partial<RankableIcd> = {}): RankableIcd {
  return {
    code,
    title,
    keywords: [],
    isBillable: true,
    tenantId: null,
    // Mirrors how the seed builds it: code + title + keywords + WHO inclusions.
    searchTokens: [code, title, ...(extra.keywords ?? [])].join(' ').toLowerCase(),
    ...extra,
  };
}

const codes = (rows: RankableIcd[]) => rows.map((r) => r.code);

describe('ranking ICD search results', () => {
  it('puts the obvious answer first instead of wherever the alphabet left it', () => {
    // Measured: alphabetically, R50.9 "Fever, unspecified" was the 95th of 96
    // matches for "fever". The first twenty were typhoid and paratyphoid, which
    // match only because "fever" is a word inside their titles.
    const rows = [
      icd('A01.0', 'Typhoid fever'),
      icd('A01.1', 'Paratyphoid fever A'),
      icd('A01.2', 'Paratyphoid fever B'),
      icd('R50.9', 'Fever, unspecified'),
    ];
    expect(codes(rankIcdResults(rows, 'fever', 4))[0]).toBe('R50.9');
  });

  it('ranks an exact code match above everything', () => {
    const rows = [
      icd('E11.0', 'Type 2 diabetes mellitus, with coma'),
      icd('E11', 'Type 2 diabetes mellitus', { isBillable: false }),
    ];
    expect(codes(rankIcdResults(rows, 'e11', 2))[0]).toBe('E11');
  });

  it('prefers a curated keyword to a title that merely starts with the word', () => {
    // Measured: with these the other way round, "diabetes" returned "Diabetes
    // insipidus" and four pregnancy codes, and E11.9 — the code carrying the
    // curated keyword `diabetes` — did not make the first five at all.
    const rows = [
      icd('E23.2', 'Diabetes insipidus'),
      icd('O24.4', 'Diabetes mellitus arising in pregnancy'),
      icd('E11.9', 'Type 2 diabetes mellitus, without complications', {
        keywords: ['diabetes', 'dm', 't2dm', 'sugar'],
      }),
    ];
    expect(codes(rankIcdResults(rows, 'diabetes', 3))[0]).toBe('E11.9');
  });

  it('does not let a WHO inclusion term outrank a real title match', () => {
    // O85 lists "fever" as an inclusion — puerperal fever does classify there.
    // That is a statement about classification, not about what a clinician
    // means by the word, so it must not beat "Fever, unspecified". This is why
    // the inclusions live in searchTokens and not in keywords.
    const rows = [
      icd('O85', 'Puerperal sepsis', {
        searchTokens: 'o85 puerperal sepsis puerperal fever puerperal peritonitis',
      }),
      icd('R50.9', 'Fever, unspecified'),
    ];
    expect(codes(rankIcdResults(rows, 'fever', 2))).toEqual(['R50.9', 'O85']);
  });

  it('still finds a code by its WHO inclusion term', () => {
    // The trade above must not cost recall: "anterolateral" appears nowhere in
    // I21.0's title, and it is how the infarct is described in practice.
    const rows = [
      icd('I21.0', 'Acute transmural myocardial infarction of anterior wall', {
        searchTokens: 'i21.0 acute transmural myocardial infarction of anterior wall anterolateral',
      }),
    ];
    expect(codes(rankIcdResults(rows, 'anterolateral', 5))).toEqual(['I21.0']);
  });

  it('drops bare substring noise for a very short term', () => {
    // Measured: "tb" returned Heartburn, Flatback syndrome and four kinds of
    // frostbite alongside the one tuberculosis code that carries the keyword.
    const rows = [
      icd('R12', 'Heartburn'),
      icd('M40.3', 'Flatback syndrome'),
      icd('T33.4', 'Superficial frostbite of arm'),
      icd('A15.9', 'Respiratory tuberculosis unspecified', { keywords: ['tb', 'tuberculosis'] }),
    ];
    expect(codes(rankIcdResults(rows, 'tb', 10))).toEqual(['A15.9']);
  });

  it('keeps substring matches once the term is long enough to mean something', () => {
    const rows = [icd('A02.2', 'Localized salmonella infections', {
      searchTokens: 'a02.2 localized salmonella infections salmonella pneumonia',
    })];
    expect(codes(rankIcdResults(rows, 'pneumonia', 5))).toEqual(['A02.2']);
  });

  it("puts a hospital's own code above the platform set at equal relevance", () => {
    // A hospital adds a custom code precisely because it wants to use it.
    const rows = [
      icd('J45.9', 'Asthma, unspecified'),
      icd('J45.9', 'Asthma, unspecified', { tenantId: 'tenant-1' }),
    ];
    expect(rankIcdResults(rows, 'asthma', 2)[0].tenantId).toBe('tenant-1');
  });

  it('prefers a billable leaf to the grouping above it', () => {
    // A doctor coding a diagnosis wants J45.9 "Asthma, unspecified", not the
    // J45 "Asthma" heading it sits under.
    const rows = [
      icd('J45', 'Asthma', { isBillable: false }),
      icd('J45.9', 'Asthma, unspecified', { isBillable: true }),
    ];
    expect(codes(rankIcdResults(rows, 'asthma', 2))).toEqual(['J45.9', 'J45']);
  });

  it('collapses the same row arriving from more than one window', () => {
    // The candidate windows overlap by design — a code-prefix hit is usually
    // also a substring hit — so without this the picker shows duplicates and
    // the limit returns fewer distinct codes than it claims.
    const row = icd('E11.9', 'Type 2 diabetes mellitus, without complications');
    expect(codes(rankIcdResults([row, { ...row }, { ...row }], 'e11', 5))).toEqual(['E11.9']);
  });

  it('keeps a tenant code distinct from the platform code it shadows', () => {
    const rows = [
      icd('N39.0', 'Urinary tract infection, site not specified'),
      icd('N39.0', 'UTI (house definition)', { tenantId: 'tenant-1' }),
    ];
    expect(rankIcdResults(rows, 'n39', 5)).toHaveLength(2);
  });

  it('honours the limit', () => {
    const rows = Array.from({ length: 40 }, (_, i) => icd(`J45.${i}`, `Asthma variant ${i}`));
    expect(rankIcdResults(rows, 'asthma', 20)).toHaveLength(20);
  });

  it('orders deterministically when everything else ties', () => {
    const rows = [icd('J45.8', 'Mixed asthma'), icd('J45.1', 'Mixed asthma')];
    expect(codes(rankIcdResults(rows, 'asthma', 2))).toEqual(['J45.1', 'J45.8']);
    expect(codes(rankIcdResults([...rows].reverse(), 'asthma', 2))).toEqual(['J45.1', 'J45.8']);
  });
});
