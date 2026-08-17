/**
 * Drug schedule classifier — decides which schedule a medicine falls in, and
 * whether it is a controlled (NDPS) substance.
 *
 * Pure and database-free: callers load the DrugScheduleRule rows once, build an
 * index, and classify as many products as they like against it. That keeps the
 * 254K-row backfill to a single rule query and makes every branch unit-testable.
 *
 * THE CASCADE (first match wins, per the workflow spec):
 *   1. exact trade-name match in the Schedule H2 brand list  → H2 + QR scan
 *   2. otherwise extract the salts and the dosage form
 *   3. any salt in Schedule X                                → X
 *   4. any salt in Schedule H1                               → H1
 *   5. any salt in Schedule H                                → H
 *   6. any salt in Schedule G   → topical ? OTC : G
 *   7. nothing matched                                       → OTC
 *
 * THE NDPS OVERLAY is a SECOND, INDEPENDENT axis applied afterwards. A molecule
 * can be Schedule H1 (what the counter collects) *and* a psychotropic (which
 * register it appears in) at the same time — tramadol is exactly that. Folding
 * the two into one flag is what would wrongly put every tramadol SKU under vault
 * custody, so `schedule` and `controlledClass` are always reported separately.
 *
 * The one case where the overlay does move the schedule is the codeine rule from
 * the NDPS Rules: a COMBINATION preparation that stays within both the per-unit
 * and the concentration limit falls back to Schedule H1 instead of full narcotic
 * control. A single-ingredient preparation is never exempt, and an unknown
 * strength fails safe to full control with `needsReview` set.
 */

/**
 * Bump when the logic below changes, so a re-run can find stale rows. The
 * deploy backfill re-classifies anything not at the current version, which is
 * what makes a logic change roll out by itself.
 *
 * 2 — an NDPS-listed drug is Schedule H even when no salt rule names it, so
 *     morphine and fentanyl no longer come out as OTC.
 */
export const CLASSIFIER_VERSION = 2;

export type ScheduleCode = 'X' | 'H1' | 'H' | 'G' | 'H2' | 'OTC';
export type ControlledClass = 'narcotic' | 'psychotropic';

/** Cascade order. NDPS is absent by design — it is an overlay, not a rung. */
const PRECEDENCE: Exclude<ScheduleCode, 'H2' | 'OTC'>[] = ['X', 'H1', 'H', 'G'];

// Trailing salt forms are stripped so the schedule's "Chlorpheniramine" matches
// a product's "Chlorpheniramine Maleate". Kept in sync with the seed builder.
const SALT_FORMS = new Set([
  'hydrochloride', 'hydrobromide', 'hcl', 'dihydrochloride', 'sulphate', 'sulfate',
  'sodium', 'potassium', 'calcium', 'magnesium', 'maleate', 'meleate', 'tartrate',
  'citrate', 'besylate', 'besilate', 'mesylate', 'mesilate', 'acetate', 'phosphate',
  'succinate', 'fumarate', 'lactate', 'bisulphate', 'disodium', 'napadisylate',
  'valerate', 'dipropionate', 'propionate', 'butyrate', 'enanthate', 'decanoate',
  'undecanoate', 'furoate', 'acetonide', 'palmitate', 'stearate', 'nitrate',
  'bromide', 'chloride', 'oxalate', 'salicylate', 'gluconate', 'trometamol',
  'tromethamine', 'monohydrate', 'anhydrous', 'dihydrate', 'trihydrate',
  'hemihydrate', 'bitartrate', 'aspartate', 'glycinate', 'orotate',
]);

/**
 * Topical / external route detection. The DosageForm enum only has `cream`
 * (ointments, gels and lotions all land in `other`), so the product name and the
 * route are checked too.
 */
const TOPICAL_WORDS = /\b(ointment|gel|lotion|topical|external|cream|balm|liniment|salve|patch)\b/i;

export interface ParsedSalt {
  /** The molecule exactly as written in the composition. */
  raw: string;
  /** Lookup key: lowercased, punctuation-free, trailing salt form removed. */
  norm: string;
  strengthValue: number | null;
  strengthUnit: string | null;
  /** For "10mg/5ml" this is 5 — the volume the strength is expressed per. */
  perVolumeMl: number | null;
}

/** The subset of a DrugScheduleRule row the classifier needs. */
export interface ScheduleRuleLike {
  scheduleCode: string;
  matchType: string;
  matchValue: string;
  matchNorm: string;
  aliases?: string[] | null;
  pattern?: string | null;
  controlledClass?: string | null;
  narcoticClass?: string | null;
  vaultControlled?: boolean | null;
  exemptIfCombination?: boolean | null;
  maxPerUnitMg?: unknown;
  maxConcentrationPercent?: unknown;
  fallbackSchedule?: string | null;
  topicalExempt?: boolean | null;
}

export interface RuleIndex {
  bySalt: Map<string, ScheduleRuleLike[]>;
  byBrand: Map<string, ScheduleRuleLike>;
  classes: ScheduleRuleLike[];
  ndps: Map<string, ScheduleRuleLike>;
}

export interface ClassificationInput {
  brandName?: string | null;
  genericName?: string | null;
  /** Falls back to genericName when the composition column is not populated. */
  composition?: string | null;
  dosageForm?: string | null;
  route?: string | null;
}

export interface ClassificationResult {
  schedule: ScheduleCode;
  /** Why, in words — surfaced on the drug page and to an inspector. */
  reason: string;
  /** The rule's published name, e.g. "Diclofenac Sodium/Potassium/Acid". */
  matchedRule: string | null;
  controlledClass: ControlledClass | null;
  narcoticClass: string | null;
  vaultControlled: boolean;
  requiresQrScan: boolean;
  salts: ParsedSalt[];
  /** Cleaned salt list, for backfilling the empty `composition` column. */
  composition: string | null;
  /**
   * True when the decision rests on data we could not read — e.g. a narcotic
   * whose strength is "(NA)", where we fail safe to full control. These rows
   * are worth a human's eyes before enforcement is switched on.
   */
  needsReview: boolean;
}

/** Lowercase, strip punctuation, drop the trailing salt form. */
export function normaliseSalt(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const toks = cleaned.split(' ').filter(Boolean);
  while (toks.length > 1 && SALT_FORMS.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

// "10mg/5ml", "1.25mg", "50mcg", "0.3% w/v"
const STRENGTH_RE = /([\d.]+)\s*(mcg|mg|gm|g|ml|iu|%)\s*(?:\/\s*([\d.]+)?\s*(ml|gm|g))?/i;

/**
 * Split a composition string into its molecules.
 *
 * The catalog writes them as "Salt (strength) + Salt (strength)", which is why
 * this parser can be simple. A slash inside a molecule name is a SYNONYM pair,
 * not two ingredients — "Paracetamol/Acetaminophen (325mg)" is one molecule —
 * so only the leading name is taken.
 */
export function parseSalts(composition: string | null | undefined): ParsedSalt[] {
  if (!composition || !composition.trim()) return [];
  const out: ParsedSalt[] = [];
  for (const part of composition.split('+')) {
    const m = /^\s*([^(]+?)\s*(?:\((.*?)\))?\s*$/.exec(part);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    const primary = name.split('/')[0].trim();
    const norm = normaliseSalt(primary);
    if (!norm) continue;

    let strengthValue: number | null = null;
    let strengthUnit: string | null = null;
    let perVolumeMl: number | null = null;
    const sm = STRENGTH_RE.exec(m[2] ?? '');
    if (sm) {
      const v = Number.parseFloat(sm[1]);
      if (Number.isFinite(v)) {
        strengthValue = v;
        strengthUnit = sm[2].toLowerCase();
        if (sm[3]) perVolumeMl = Number.parseFloat(sm[3]);
        else if (sm[4]) perVolumeMl = 1;
      }
    }
    out.push({ raw: name, norm, strengthValue, strengthUnit, perVolumeMl });
  }
  return out;
}

/** Index the rule table once; classify many products against it. */
export function buildRuleIndex(rules: ScheduleRuleLike[]): RuleIndex {
  const bySalt = new Map<string, ScheduleRuleLike[]>();
  const byBrand = new Map<string, ScheduleRuleLike>();
  const classes: ScheduleRuleLike[] = [];
  const ndps = new Map<string, ScheduleRuleLike>();

  const push = (map: Map<string, ScheduleRuleLike[]>, key: string, r: ScheduleRuleLike) => {
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  };

  for (const r of rules) {
    const keys = [r.matchNorm, ...(r.aliases ?? [])].filter(Boolean);
    if (r.scheduleCode === 'NDPS') {
      // First rule wins a key — the fixture has no NDPS key collisions.
      for (const k of keys) if (!ndps.has(k)) ndps.set(k, r);
      continue;
    }
    if (r.matchType === 'brand') {
      byBrand.set(r.matchNorm, r);
    } else if (r.matchType === 'class') {
      classes.push(r);
    } else {
      for (const k of keys) push(bySalt, k, r);
    }
  }
  return { bySalt, byBrand, classes, ndps };
}

/**
 * The lookup keys to try for one molecule, most specific first.
 *
 * Salt forms are stripped on BOTH sides, but a schedule may still name an ester
 * the product does not use — "Isosorbide Dinitrate/Mononitrate" indexes
 * "isosorbide dinitrate", while the product says "Isosorbide Mononitrate". So a
 * miss on the full name falls back to the bare leading molecule.
 *
 * The fallback is deliberately narrow: only the FIRST token, only when it is
 * long enough to be a molecule name and is not itself a salt word. That keeps
 * "Calcium Dobesilate" from ever being looked up as "calcium".
 */
function saltLookupKeys(norm: string): string[] {
  const keys = [norm];
  const toks = norm.split(' ');
  if (toks.length > 1) {
    const head = toks[0];
    if (head.length >= 6 && !SALT_FORMS.has(head)) keys.push(head);
  }
  return keys;
}

function lookupSalt(salt: ParsedSalt, index: RuleIndex): ScheduleRuleLike[] {
  for (const key of saltLookupKeys(salt.norm)) {
    const found = index.bySalt.get(key);
    if (found?.length) return found;
  }
  return [];
}

function lookupNdps(salt: ParsedSalt, index: RuleIndex): ScheduleRuleLike | undefined {
  for (const key of saltLookupKeys(salt.norm)) {
    const found = index.ndps.get(key);
    if (found) return found;
  }
  return undefined;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * Is this preparation topical/external?
 *
 * Only Schedule G acts on this: its own Note excludes preparations intended for
 * topical or external use. Schedule H has a comparable Note 2, but Note 4 then
 * pulls topical steroids and hydroquinone back in, and our dosage-form data is
 * too coarse to separate those reliably — so Schedule H is applied regardless of
 * route. Over-flagging a topical as Schedule H costs a warning; under-flagging
 * one would be a compliance hole, and the warning is the safer error.
 */
function isTopical(input: ClassificationInput): boolean {
  if ((input.dosageForm ?? '').toLowerCase() === 'cream') return true;
  if (input.route && TOPICAL_WORDS.test(input.route)) return true;
  return TOPICAL_WORDS.test(input.brandName ?? '');
}

export function classify(
  input: ClassificationInput,
  index: RuleIndex,
): ClassificationResult {
  const source = input.composition?.trim() || input.genericName?.trim() || '';
  const salts = parseSalts(source);
  const composition = salts.length ? salts.map((s) => s.raw).join(' + ') : null;

  const base = {
    salts,
    composition,
    narcoticClass: null as string | null,
    needsReview: false,
  };

  // ── 1. Schedule H2 — matched on the whole trade name, not on a salt ──
  const brandKey = (input.brandName ?? '').trim().toLowerCase();
  if (brandKey && index.byBrand.has(brandKey)) {
    const rule = index.byBrand.get(brandKey)!;
    return {
      ...base,
      schedule: 'H2',
      reason: `Schedule H2 formulation "${rule.matchValue}" — QR/barcode scan required at sale.`,
      matchedRule: rule.matchValue,
      controlledClass: null,
      vaultControlled: false,
      requiresQrScan: true,
    };
  }

  // ── 2-6. Salt cascade ──
  const hits = new Map<string, { salt: ParsedSalt; rule: ScheduleRuleLike }>();
  for (const salt of salts) {
    for (const rule of lookupSalt(salt, index)) {
      if (!hits.has(rule.scheduleCode)) hits.set(rule.scheduleCode, { salt, rule });
    }
  }
  // Therapeutic-class entries ("Antibiotics", "Corticosteroids") only apply when
  // no named molecule matched — a specific listing always beats a family.
  if (hits.size === 0) {
    for (const rule of index.classes) {
      if (!rule.pattern) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        continue; // a malformed pattern must never break a classification
      }
      const salt = salts.find((s) => re.test(s.norm));
      if (salt && !hits.has(rule.scheduleCode)) hits.set(rule.scheduleCode, { salt, rule });
    }
  }

  let schedule: ScheduleCode = 'OTC';
  let reason = salts.length
    ? 'No scheduled substance found in the composition — over the counter.'
    : 'No composition recorded, so no schedule could be resolved.';
  let matchedRule: string | null = null;

  const topical = isTopical(input);
  for (const code of PRECEDENCE) {
    const hit = hits.get(code);
    if (!hit) continue;
    if (code === 'G' && topical && hit.rule.topicalExempt) {
      // Schedule G's own Note: topical/external preparations are not covered.
      schedule = 'OTC';
      reason = `${hit.rule.matchValue} is Schedule G, but this is a topical/external preparation, which the Schedule excludes.`;
      matchedRule = hit.rule.matchValue;
    } else {
      schedule = code;
      matchedRule = hit.rule.matchValue;
      reason =
        hit.rule.matchType === 'class'
          ? `Schedule ${code} — ${hit.salt.raw} falls under the "${hit.rule.matchValue}" class entry.`
          : `Schedule ${code} — matched ${hit.rule.matchValue}.`;
    }
    break;
  }

  // ── 7. NDPS overlay — a separate axis, applied after the cascade ──
  let controlledClass: ControlledClass | null = null;
  let narcoticClass: string | null = null;
  let vaultControlled = false;
  let needsReview = false;

  for (const salt of salts) {
    const rule = lookupNdps(salt, index);
    if (!rule) continue;

    controlledClass = (rule.controlledClass as ControlledClass) ?? null;
    narcoticClass = rule.narcoticClass ?? null;
    vaultControlled = rule.vaultControlled ?? false;

    if (rule.exemptIfCombination) {
      const exempt = withinExemptionLimits(salt, salts.length, rule);
      if (exempt.unknown) {
        // Fail safe: an unreadable strength keeps full control and asks for eyes.
        needsReview = true;
        reason += ` ${rule.matchValue} strength could not be read, so full NDPS control is assumed.`;
      } else if (exempt.within) {
        vaultControlled = false;
        if (rule.fallbackSchedule && schedule !== 'X') {
          schedule = rule.fallbackSchedule as ScheduleCode;
          matchedRule = rule.matchValue;
        }
        reason = `${rule.matchValue} combination within the NDPS concentration limits — dispensed as Schedule ${schedule}.`;
      } else {
        reason = `${rule.matchValue} exceeds the NDPS concentration limit — full narcotic control applies.`;
      }
    }
    break; // the first controlled molecule decides; combinations of two are not a real case
  }

  // Schedule H names "Narcotic Drugs listed in the Narcotic Drugs &
  // Psychotropic Substances Act, 1985" as an entry in its own right, so a drug
  // the NDPS list covers is a prescription drug whether or not its molecule is
  // also spelled out by name. Without this, morphine and fentanyl come out of
  // the cascade as OTC — nothing in the salt lists names them — and a register
  // would print "OTC" beside a vault-controlled narcotic.
  if (controlledClass && schedule === 'OTC') {
    schedule = 'H';
    reason = `${reason} Covered by Schedule H as a drug listed in the NDPS Act, 1985.`;
  }

  return {
    ...base,
    schedule,
    reason,
    matchedRule,
    controlledClass,
    narcoticClass,
    vaultControlled,
    requiresQrScan: false,
    needsReview,
  };
}

/**
 * The codeine test from the NDPS Rules, generalised.
 *
 * A single-ingredient preparation is never exempt. A combination is exempt only
 * while it stays within BOTH published limits — mg per unit for solids, and
 * percentage concentration for liquids, where "10mg/5ml" is 0.2% w/v.
 */
function withinExemptionLimits(
  salt: ParsedSalt,
  saltCount: number,
  rule: ScheduleRuleLike,
): { within: boolean; unknown: boolean } {
  if (saltCount < 2) return { within: false, unknown: false };
  if (salt.strengthValue === null) return { within: false, unknown: true };

  const perUnitLimit = num(rule.maxPerUnitMg);
  const concentrationLimit = num(rule.maxConcentrationPercent);

  const mg = toMilligrams(salt.strengthValue, salt.strengthUnit);
  if (mg === null) return { within: false, unknown: true };

  if (salt.perVolumeMl && salt.perVolumeMl > 0) {
    // Liquid — compare concentration. 1 ml of water ≈ 1000 mg, so
    // percent w/v = mg / (ml × 1000) × 100.
    if (concentrationLimit === null) return { within: false, unknown: true };
    const percent = (mg / (salt.perVolumeMl * 1000)) * 100;
    return { within: percent <= concentrationLimit, unknown: false };
  }

  if (perUnitLimit === null) return { within: false, unknown: true };
  return { within: mg <= perUnitLimit, unknown: false };
}

function toMilligrams(value: number, unit: string | null): number | null {
  switch ((unit ?? '').toLowerCase()) {
    case 'mg':
      return value;
    case 'mcg':
      return value / 1000;
    case 'g':
    case 'gm':
      return value * 1000;
    default:
      // %, IU and ml carry no mass we can compare against a mg limit.
      return null;
  }
}
