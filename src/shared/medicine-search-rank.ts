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

import { trigramSimilarity } from './trigram';

const WORD_SPLIT = /[\s,\-/()+.]+/;

/**
 * Dosage-form / unit words that appear in almost every drug name. A query that
 * only matches one of these ("ca" → "Capsule", "ta" → "Tablet") is noise, not a
 * meaningful name match, so such words are ignored for the word-start tier
 * (they can still match as a plain substring, the lowest tier). Numeric/strength
 * tokens ("100mg", "500") are ignored for the same reason.
 */
const FORM_UNIT_WORDS = new Set([
  'capsule', 'capsules', 'cap', 'caps', 'caplet', 'caplets',
  'tablet', 'tablets', 'tab', 'tabs', 'pill', 'pills',
  'syrup', 'syrups', 'suspension', 'susp', 'solution', 'soln', 'sol',
  'injection', 'injections', 'inj', 'infusion', 'vial', 'vials', 'ampoule', 'ampoules', 'amp',
  'cream', 'gel', 'ointment', 'oint', 'lotion', 'paste', 'foam',
  'drops', 'drop', 'spray', 'inhaler', 'rotacap', 'respule', 'respules', 'nebuliser', 'nebulizer',
  'powder', 'granules', 'sachet', 'sachets', 'suppository', 'suppositories', 'pessary',
  'elixir', 'mouthwash', 'gargle', 'shampoo', 'soap', 'patch', 'kit', 'tube', 'bottle', 'strip', 'pack',
  'mg', 'mcg', 'ug', 'g', 'gm', 'gms', 'kg', 'ml', 'l', 'iu', 'unit', 'units',
]);

function isMeaningfulWord(w: string): boolean {
  if (!w) return false;
  if (FORM_UNIT_WORDS.has(w)) return false;
  if (/\d/.test(w)) return false; // strength tokens like "100mg", "500"
  return true;
}

// ── Fuzzy (typo-tolerant) tier ──────────────────────────────────────────────
// Below this length a query is served fine by prefix/substring and fuzzy is
// noise. Kept in sync with `medicine-fuzzy.ts` FUZZY_MIN_QUERY_LEN.
const FUZZY_MIN_QUERY_LEN = 4;
// Minimum trigram similarity for a word/name to count as a fuzzy match. Mirrors
// the Postgres pg_trgm default (0.3) so JS ranking agrees with the DB fetch.
const FUZZY_MIN_SIM = 0.3;

/**
 * Best fuzzy similarity of `query` against the whole value and its meaningful
 * words (so "cetrizine" matches the "Cetirizine" word inside a longer name).
 */
function fuzzyBestSimilarity(value: string, query: string): number {
  let best = trigramSimilarity(value, query);
  for (const w of value.split(WORD_SPLIT)) {
    if (isMeaningfulWord(w)) best = Math.max(best, trigramSimilarity(w, query));
  }
  return best;
}

function fieldScore(value: string | null | undefined, query: string, base: number): number {
  if (!value) return 100;
  const v = value.toLowerCase();
  if (v === query) return base; // exact
  if (v.startsWith(query)) return base + 1; // whole-string prefix (name starts with query)
  // word-start, but only on meaningful words — a match inside "Capsule"/"Tablet"
  // or a strength token doesn't earn this tier.
  if (v.split(WORD_SPLIT).some((w) => isMeaningfulWord(w) && w.startsWith(query))) return base + 2;
  if (v.includes(query)) return base + 3; // substring (anywhere, incl. form words)
  // Fuzzy tier — only for real words (len ≥ 4) with no substring hit at all, so
  // it never reorders existing exact/prefix/substring results, only fills slots
  // that would otherwise be empty. Score sits in (base+3, 100): worse than any
  // substring match, better than "no match", with closer matches scoring lower.
  if (query.length >= FUZZY_MIN_QUERY_LEN) {
    const sim = fuzzyBestSimilarity(v, query);
    if (sim >= FUZZY_MIN_SIM) return base + 4 + (1 - sim) * 3; // ≈ base+4 … base+6.1
  }
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
 * Merge two candidate lists de-duplicated by key, prefix rows first.
 *
 * Callers fetch a bounded window ordered alphabetically, then re-rank in JS.
 * With a big catalog that clips real prefix matches: searching "ca" fills the
 * window with alphabetically-earlier "A… (…Capsule)" substring rows, so a drug
 * actually named "Ca…" (sorted under C) never enters the window and can't be
 * ranked to the top. Fetching a dedicated prefix window and prepending it here
 * guarantees name-prefix matches are always present before ranking.
 */
export function mergePrefixFirst<T>(
  prefixRows: T[],
  otherRows: T[],
  key: (row: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...prefixRows, ...otherRows]) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
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
