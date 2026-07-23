/**
 * Relevance ranking for medicine / drug name search.
 *
 * Everywhere a drug is searched by name we want the closest textual match to
 * come first: typing "DOLO" should surface "DOLO 650" (exact / prefix / word-
 * start) ahead of "PARACETADOLO" (a mere substring). Postgres cannot express
 * this in a single `orderBy`, so callers fetch a candidate set (ordered
 * alphabetically) and re-rank it in JS with the score + comparator here.
 *
 * Lower score = better. The drug NAME always outranks the generic name, and
 * within each, exact < prefix < word-start < substring.
 */

const WORD_SPLIT = /[\s,\-/()+.]+/;

function fieldScore(value: string | null | undefined, query: string, base: number): number {
  if (!value) return 100;
  const v = value.toLowerCase();
  if (v === query) return base; // exact
  if (v.startsWith(query)) return base + 1; // whole-string prefix
  if (v.split(WORD_SPLIT).some((w) => w && w.startsWith(query))) return base + 2; // word-start
  if (v.includes(query)) return base + 3; // substring
  return 100; // no match on this field
}

/**
 * Score a candidate by how well `name`/`generic` match `query`.
 * 0–3 = name match tiers, 10–13 = generic match tiers, 100 = no match.
 */
export function medicineSearchScore(
  query: string,
  name?: string | null,
  generic?: string | null,
): number {
  const q = (query || '').trim().toLowerCase();
  if (!q) return 100;
  return Math.min(fieldScore(name, q, 0), fieldScore(generic, q, 10));
}

/**
 * Comparator for search results: best textual match first, then in-stock
 * items, then alphabetical. Pass accessors so it works for any row shape.
 */
export function makeMedicineRankComparator<T>(
  query: string,
  get: (row: T) => { name?: string | null; generic?: string | null; inStock?: boolean },
): (a: T, b: T) => number {
  return (a, b) => {
    const ga = get(a);
    const gb = get(b);
    const sa = medicineSearchScore(query, ga.name, ga.generic);
    const sb = medicineSearchScore(query, gb.name, gb.generic);
    if (sa !== sb) return sa - sb;
    // Prefer stocked items when relevance ties.
    const stockA = ga.inStock ? 0 : 1;
    const stockB = gb.inStock ? 0 : 1;
    if (stockA !== stockB) return stockA - stockB;
    return (ga.name || '').localeCompare(gb.name || '');
  };
}
