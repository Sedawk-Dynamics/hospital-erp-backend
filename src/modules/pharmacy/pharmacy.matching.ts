// ============================================================
// Pharmacy fuzzy name matching (G1)
// ============================================================
// The single biggest operational pain reported in the field was duplicate /
// split medicine entries: a distributor invoice says "Telmac 40 Tab" while the
// system already has "Telmac 40", so staff create a NEW row and the 200-tablet
// stock silently splits into two 100-tablet entries. This module gives the
// pharmacy module a way to detect those near-duplicates BEFORE a new formulary
// row is created (on manual inward / add-drug), so the user can map to the
// existing record instead.
//
// Matching is heuristic and intentionally explainable (no ML): normalize the
// name (strip dosage-form words like Tab/Inj/Syp, collapse spacing, unify
// strength tokens) then blend a bigram Dice coefficient with a token-set
// Jaccard, with boosts/penalties for strength, dosage form, manufacturer and
// generic name — mirroring the design doc's "multi-factor similarity" rules.

export interface DrugLike {
  drugName: string;
  genericName?: string | null;
  /** Salt composition — a distinct field from genericName (see DrugFormulary). */
  composition?: string | null;
  manufacturer?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
}

// Trailing/embedded dosage-form words that distributors append inconsistently.
// These carry no identity ("Telmac 40" == "Telmac 40 Tab") so they are dropped
// before scoring. Order matters only for readability.
const FORM_WORDS = new Set([
  'tab', 'tabs', 'tablet', 'tablets',
  'cap', 'caps', 'capsule', 'capsules',
  'inj', 'injection', 'injections', 'amp', 'ampoule', 'vial', 'vials',
  'syp', 'syr', 'syrup', 'syrups',
  'susp', 'suspension',
  'sol', 'soln', 'solution',
  'drop', 'drops',
  'cream', 'oint', 'ointment', 'gel', 'lotion',
  'sachet', 'sachets', 'powder', 'spray', 'inhaler', 'rotacap', 'respules',
  'tube', 'bottle', 'strip', 'strips', 'pack',
]);

// A strength with its unit. We reduce "650 mg" / "650mg" / "650" all to the bare
// number "650" so spacing/unit variations don't change tokens, while the number
// itself stays (it is identity-bearing: Telma 20 must NOT match Telma 40).
const STRENGTH_UNIT = /(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g|gm|iu|%|units?)\b/gi;

/** Lowercase, strip punctuation, fold strength units, drop dosage-form words. */
export function normalizeDrugName(raw: string): string {
  if (!raw) return '';
  let s = ` ${raw.toLowerCase()} `;
  // Reduce "650 mg" / "650mg" -> "650" so a unit-less invoice name still lines
  // up with the stored one.
  s = s.replace(STRENGTH_UNIT, (_m, num) => ` ${num} `);
  // Replace runs of anything that isn't a letter/digit/dot with a space (handles
  // +, -, /, parentheses…). Dots are kept so decimal strengths (12.5) survive.
  s = s.replace(/[^a-z0-9.]+/g, ' ');
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, '').trim()) // drop stray leading/trailing dots
    .filter(Boolean)
    .filter((t) => !FORM_WORDS.has(t));
  return tokens.join(' ');
}

/** Pull the numeric strength core(s) (e.g. "650", "12.5") out of a string. */
function strengthTokens(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter((t) => /\d/.test(t))
    .map((t) => t.replace(/[^0-9.]/g, ''))
    .filter(Boolean);
}

// ── Units ───────────────────────────────────────────────────────────────────
// `normalizeDrugName` folds "650 mg" down to "650" so spacing and unit-less
// invoice names still line up. That is right for the name comparison, but it
// also means 500 mg and 500 ml became indistinguishable — two completely
// different products scored a perfect 100. So units are read separately, off
// the RAW text, before that folding happens.

const UNIT_ALIASES: Record<string, string> = {
  mcg: 'mcg', ug: 'mcg',
  mg: 'mg',
  g: 'g', gm: 'g', gms: 'g',
  ml: 'ml', l: 'l',
  iu: 'iu', u: 'iu', unit: 'iu', units: 'iu',
  '%': '%',
};

const VALUE_UNIT = /(\d+(?:\.\d+)?)\s*(mcg|ug|mg|gms|gm|g|ml|l|iu|units|unit|u|%)\b/gi;

/** value → set of declared units, e.g. "500" → {"mg"}. Empty when unit-less. */
function unitsByValue(raw: string | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!raw) return out;
  for (const m of raw.matchAll(VALUE_UNIT)) {
    const value = String(parseFloat(m[1]));
    const unit = UNIT_ALIASES[m[2].toLowerCase()] ?? m[2].toLowerCase();
    const set = out.get(value) ?? new Set<string>();
    set.add(unit);
    out.set(value, set);
  }
  return out;
}

function mergeUnitMaps(...sources: (string | null | undefined)[]): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const src of sources) {
    for (const [value, units] of unitsByValue(src)) {
      const set = merged.get(value) ?? new Set<string>();
      for (const u of units) set.add(u);
      merged.set(value, set);
    }
  }
  return merged;
}

/**
 * True when the two sides quote the SAME number with DIFFERENT units and never
 * agree on any number+unit pair — "500 mg" vs "500 ml". Deliberately narrow: it
 * only fires when both sides actually declare a unit for the same value, so
 * every unit-less name that matched before still matches.
 */
function unitConflict(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  let sawConflict = false;
  for (const [value, unitsA] of a) {
    const unitsB = b.get(value);
    if (!unitsB || unitsA.size === 0 || unitsB.size === 0) continue;
    const agrees = [...unitsA].some((u) => unitsB.has(u));
    if (agrees) return false; // some number+unit pair lines up — not a conflict
    sawConflict = true;
  }
  return sawConflict;
}

/** Set of character bigrams used for the Dice coefficient. */
function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/\s+/g, '');
  const map = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}

/** Sørensen–Dice coefficient over character bigrams (0..1). */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [g, countA] of A) {
    const countB = B.get(g);
    if (countB) overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (A.size + B.size);
}

/** Token-set Jaccard (0..1) — order-independent word overlap. */
function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Confidence that two drugs are the same product, 0..100. Blends a character
 * Dice coefficient (catches typos/abbreviations) with a token Jaccard (catches
 * reordering), then applies multi-factor adjustments:
 *  - hard penalty when both name strengths are present but differ (20 vs 40),
 *  - small boosts for matching dosage form / manufacturer / generic name.
 */
export function scoreMatch(incoming: DrugLike, existing: DrugLike): number {
  const a = normalizeDrugName(incoming.drugName);
  const b = normalizeDrugName(existing.drugName);
  if (!a || !b) return 0;

  const dice = diceCoefficient(a, b);
  const jac = tokenJaccard(a, b);
  // Dice carries most of the signal; Jaccard rewards shared whole words.
  let score = (dice * 0.65 + jac * 0.35) * 100;

  // Strength is identity-bearing. If both sides declare a numeric strength in
  // the name and they disagree, this is almost certainly a different SKU.
  const sa = new Set([...strengthTokens(a), ...(incoming.strength ? strengthTokens(normalizeDrugName(incoming.strength)) : [])]);
  const sb = new Set([...strengthTokens(b), ...(existing.strength ? strengthTokens(normalizeDrugName(existing.strength)) : [])]);
  if (sa.size && sb.size) {
    const shared = [...sa].some((t) => sb.has(t));
    if (!shared) score -= 35;
    // The numbers agree — but do the UNITS? "Paracip 500 mg" and "Paracip
    // 500 ml" both reduce to "500" once units are folded, and used to score a
    // perfect 100 and auto-map onto each other.
    else if (
      unitConflict(
        mergeUnitMaps(incoming.drugName, incoming.strength),
        mergeUnitMaps(existing.drugName, existing.strength),
      )
    ) {
      score -= 35;
    }
  }

  // Light multi-factor boosts (capped so they can't fabricate a match alone).
  if (
    incoming.dosageForm &&
    existing.dosageForm &&
    incoming.dosageForm.toLowerCase() === existing.dosageForm.toLowerCase()
  ) {
    score += 4;
  }
  if (
    incoming.manufacturer &&
    existing.manufacturer &&
    normalizeDrugName(incoming.manufacturer) === normalizeDrugName(existing.manufacturer)
  ) {
    score += 5;
  }
  if (incoming.genericName && existing.genericName) {
    const gi = normalizeDrugName(incoming.genericName);
    const ge = normalizeDrugName(existing.genericName);
    if (gi && ge) score += diceCoefficient(gi, ge) * 6;
  }

  // Salt composition is the strongest identity signal there is: two products
  // with the same composition are the same medicine whatever the brand, and
  // two with clearly different compositions are NOT the same product however
  // alike the names read. Only judged when BOTH sides declare it — most rows
  // still carry their molecule in `genericName` alone, and those are unchanged.
  if (incoming.composition && existing.composition) {
    const ci = normalizeDrugName(incoming.composition);
    const ce = normalizeDrugName(existing.composition);
    if (ci && ce) {
      const sim = Math.max(diceCoefficient(ci, ce), tokenJaccard(ci, ce));
      if (sim >= 0.75) score += 10;
      else if (sim < 0.35) score -= 25;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Confidence thresholds. SUGGEST = surface as a possible duplicate in the UI;
// BLOCK = high enough that we refuse to silently create a new row server-side
// unless the caller explicitly forces it (the design doc's "96% match — is this
// correct?" prompt). Kept here so both the service and tests share one source.
export const MATCH_SUGGEST_THRESHOLD = 60;
export const MATCH_BLOCK_THRESHOLD = 85;
