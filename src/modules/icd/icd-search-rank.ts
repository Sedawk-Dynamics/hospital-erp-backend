/**
 * Relevance ranking for ICD code search.
 *
 * The catalogue used to be 76 curated rows, where "order by code" was good
 * enough because almost everything that matched fitted on one screen. Against
 * the full WHO release (~12,300 codes) it stops working, and measurably so —
 * with `take: 20` and alphabetical order:
 *
 *   "fever"     R50.9 "Fever, unspecified" is the 95th of 96 matches. The
 *               screen is typhoid and paratyphoid.
 *   "pneumonia" J18.9 "Pneumonia, unspecified" is 54th of 74. The screen is
 *               salmonella and tuberculosis, which match only because
 *               "pneumonia" appears somewhere in their inclusion terms.
 *   "diabetes"  E11.9 is 22nd of 72 — two places past the cut.
 *   "asthma"    J45.9 is 9th, behind "Psychological and behavioural factors"
 *               and "Left ventricular failure".
 *
 * So the obvious code match is not what the doctor gets. Ranking is part of
 * ingesting the full catalogue, not a follow-up to it.
 *
 * The ordering below is the same shape the medicine search already uses: exact,
 * then prefix, then word-start, then anywhere.
 */

import { bestWordSimilarity, trigramSimilarity } from '../../shared/trigram';

export interface RankableIcd {
  code: string;
  title: string;
  /**
   * Deliberate slang: someone said "this is what people call it". Curated only
   * — WHO's inclusion terms are kept out, because they say which concepts
   * classify TO a code, not what a clinician means by the word.
   */
  keywords?: string[];
  /** Lowercased code + title + keywords + WHO inclusion terms. */
  searchTokens?: string | null;
  isBillable?: boolean;
  tenantId?: string | null;
}

/**
 * Lower is better.
 *
 * `KeywordExact` deliberately outranks `TitlePrefix`. A keyword is a person
 * saying "this is the code people mean when they type this word", which is a
 * stronger signal than a title that merely happens to begin with it. Measured:
 * with the two the other way round, "diabetes" returned "Diabetes insipidus"
 * and four pregnancy codes, and E11.9 — the code carrying the curated keyword
 * `diabetes` — did not make the first five at all.
 *
 * That only holds while `keywords` stays curated. It is also why WHO's
 * inclusion terms rank down at `SynonymWordStart` instead: they are searchable,
 * but "fever" must not return Puerperal sepsis just because O85 lists it.
 *
 * The last two tiers are for queries of more than one word, and both rank below
 * every contiguous-phrase match — a row containing the words scattered is a
 * weaker answer than one containing the phrase.
 */
const enum Tier {
  CodeExact = 0,
  CodePrefix = 1,
  KeywordExact = 2,
  TitlePrefix = 3,
  TitleWordStart = 4,
  KeywordWordStart = 5,
  SynonymWordStart = 6,
  Anywhere = 7,
  /** Every word present, but not as a phrase — "fracture femur". */
  AllWords = 8,
  /** All but one word present — "lower back pain" against "Low back pain". */
  MostWords = 9,
  /** Nothing matched literally, but a word is trigram-close — "diabtes". */
  Fuzzy = 10,
  NoMatch = 11,
}

/**
 * How close a word must be to count as a typo rather than a different word.
 * Kept in step with `pg_trgm.word_similarity_threshold` in `icd-fuzzy.ts`: the
 * database chooses the candidates and this decides where they sit, so a row the
 * database offered must not be scored as no match here and silently dropped.
 */
const FUZZY_MIN_SIMILARITY = 0.45;

/** Below this a query is served by prefix matching and fuzzy is only noise. */
const FUZZY_MIN_QUERY_LEN = 4;

/** The words of a query. Capped, so a pasted paragraph cannot fan out. */
export function queryWords(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
}

/** True when `term` starts a word in `text` — "fever" in "Typhoid fever". */
function startsWord(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) return false;
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true;
    from = at + 1;
  }
}

/**
 * How well one row answers `term`, which must already be lowercased and
 * trimmed.
 */
export function icdMatchTier(row: RankableIcd, term: string): Tier {
  const code = row.code.toLowerCase();
  if (code === term) return Tier.CodeExact;
  if (code.startsWith(term)) return Tier.CodePrefix;

  const keywords = (row.keywords ?? []).map((k) => k.toLowerCase());
  if (keywords.some((k) => k === term)) return Tier.KeywordExact;

  const title = row.title.toLowerCase();
  if (title.startsWith(term)) return Tier.TitlePrefix;
  if (startsWord(title, term)) return Tier.TitleWordStart;
  if (keywords.some((k) => startsWord(k, term))) return Tier.KeywordWordStart;
  const tokens = row.searchTokens ?? '';
  if (startsWord(tokens, term)) return Tier.SynonymWordStart;
  if (tokens.includes(term)) return Tier.Anywhere;

  // Nothing matched the phrase. For a multi-word query, fall back to how many
  // of its words the row carries at all — word order in a query rarely matches
  // ICD's own ("fracture femur" against "Fracture of neck of femur"), and its
  // vocabulary often differs by a word ("lower back pain" against "Low back
  // pain"), so demanding the exact phrase returned nothing at all.
  const words = queryWords(term);
  if (words.length > 1) {
    const hits = words.filter((w) => tokens.includes(w)).length;
    if (hits === words.length) return Tier.AllWords;
    if (hits === words.length - 1 && words.length > 2) return Tier.MostWords;
  }
  if (fuzzySimilarity(row, term) > 0) return Tier.Fuzzy;
  return Tier.NoMatch;
}

/**
 * How close the row is to `term` as a misspelling, or 0 if it is not one.
 *
 * Scored against the TITLE first and the curated keywords second, deliberately
 * NOT against `searchTokens`. The database selects fuzzy candidates by word
 * similarity across the whole token blob, which ranks "Myasthenic syndromes in
 * endocrine diseases" above E11 for "diabtes" — its WHO inclusion terms mention
 * diabetes. What the doctor means is a code whose own name is the word they
 * mistyped.
 */
export function fuzzySimilarity(row: RankableIcd, term: string): number {
  if (term.length < FUZZY_MIN_QUERY_LEN) return 0;
  const title = row.title.toLowerCase();

  const wordScore = (w: string) => {
    let best = bestWordSimilarity(title, w);
    for (const k of row.keywords ?? []) {
      // A keyword is a whole phrase people use, so it is compared as one.
      best = Math.max(best, trigramSimilarity(k.toLowerCase(), w));
    }
    return best;
  };

  const words = queryWords(term);
  if (words.length > 1) {
    // A multi-word query is usually one mistyped word among correct ones —
    // "cerebal infarction". Every word still has to be accounted for, or
    // "cerebal appendicitis" would match on the strength of one of them.
    const tokens = row.searchTokens ?? '';
    const scores = words.map((w) => (tokens.includes(w) ? 1 : wordScore(w)));
    if (scores.some((sc) => sc < FUZZY_MIN_SIMILARITY)) return 0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  const best = wordScore(term);
  return best >= FUZZY_MIN_SIMILARITY ? best : 0;
}

/** How many query words start a word of the title — a multi-word tiebreak. */
function titleWordHits(row: RankableIcd, words: string[]): number {
  if (words.length < 2) return 0;
  const title = row.title.toLowerCase();
  return words.filter((w) => startsWord(title, w)).length;
}

/**
 * Order candidates by how well they answer `term` and keep the best `limit`.
 *
 * Ties break on, in order:
 *   • the hospital's own custom codes before the platform set — a hospital adds
 *     one precisely because it wants to use it;
 *   • billable leaves before groupings — a doctor coding a diagnosis wants
 *     J45.9 "Asthma, unspecified", not the J45 "Asthma" heading it sits under;
 *   • the shorter title, which is the more direct answer to the same words;
 *   • the code, so the result is stable rather than dependent on row order.
 */
export function rankIcdResults<T extends RankableIcd>(rows: T[], q: string, limit: number): T[] {
  const term = q.trim().toLowerCase();
  if (!term) return rows.slice(0, limit);

  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    // The candidate windows overlap by design, so the same row arrives more
    // than once. Key on code + tenant: a hospital may hold its own version of
    // a platform code.
    const key = `${row.tenantId ?? ''}|${row.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const words = queryWords(term);
  return unique
    .map((row, i) => ({
      row,
      i,
      tier: icdMatchTier(row, term),
      titleHits: titleWordHits(row, words),
      fuzzy: fuzzySimilarity(row, term),
    }))
    // A row that carries none of the words is not a result. It can arrive here
    // from a window that matched on something the ranker does not score.
    .filter((s) => s.tier < Tier.NoMatch)
    // A short term matches a substring almost everywhere, and none of it means
    // anything: "tb" pulled in "Heartburn", "Flatback syndrome" and four kinds
    // of frostbite alongside the tuberculosis code that actually carries the
    // keyword. Better to return the few real matches than to pad with noise.
    .filter((s) => term.length > 2 || s.tier < Tier.Anywhere)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        // Within the fuzzy tier, the closest spelling wins — this is what
        // corrects the database's own ordering.
        b.fuzzy - a.fuzzy ||
        // Among equally-scattered matches, the row whose TITLE carries more of
        // the words is the better answer: for "upper abdominal pain" that is
        // R10.1 "Pain localized to upper abdomen" rather than R10.0 "Acute
        // abdomen", which only qualifies through its inclusion terms.
        b.titleHits - a.titleHits ||
        Number(!!b.row.tenantId) - Number(!!a.row.tenantId) ||
        Number(b.row.isBillable ?? false) - Number(a.row.isBillable ?? false) ||
        a.row.title.length - b.row.title.length ||
        a.row.code.localeCompare(b.row.code) ||
        a.i - b.i,
    )
    .slice(0, limit)
    .map((s) => s.row);
}
