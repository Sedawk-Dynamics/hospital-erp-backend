/**
 * Trigram similarity, matching Postgres `pg_trgm` closely enough to rank with.
 *
 * The database decides WHICH rows are fuzzy candidates — that is what the GIN
 * trigram indexes are for. This decides where those rows sit once they arrive,
 * so a JS ranker can score a typo match without a second round trip and can be
 * tested without a database.
 *
 * Both halves have to agree on what "similar" means, or a row the database
 * offered would be scored as no match and silently dropped. `similarity()` in
 * pg_trgm is the Jaccard index over the set of space-padded trigrams, which is
 * what {@link trigramSimilarity} computes; there is a test pinning the two
 * against real Postgres output.
 */

/**
 * The trigram set of a string, padded the way pg_trgm pads: two leading spaces
 * and one trailing, so the start and end of a word count as trigrams and
 * "paracetamol" scores well against "paracetmol".
 */
export function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard trigram similarity in [0,1] — pg_trgm's `similarity()`. */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The best similarity of `query` against `value` as a whole and against each of
 * its words — pg_trgm's `word_similarity()` in spirit.
 *
 * Whole-string similarity collapses on long values: "diabtes" against "Type 2
 * diabetes mellitus, without complications" scores about 0.15, because Jaccard
 * divides by the union and the title contributes far more trigrams than the
 * query. Scoring word by word finds the "diabetes" inside it instead.
 *
 * @param minWordLen words shorter than this are skipped — "of", "and" and "in"
 *                   are trigram-similar to a great many short queries.
 */
export function bestWordSimilarity(value: string, query: string, minWordLen = 4): number {
  if (!value || !query) return 0;
  let best = trigramSimilarity(value, query);
  for (const word of value.split(/[^a-z0-9]+/i)) {
    if (word.length >= minWordLen) best = Math.max(best, trigramSimilarity(word, query));
  }
  return best;
}
