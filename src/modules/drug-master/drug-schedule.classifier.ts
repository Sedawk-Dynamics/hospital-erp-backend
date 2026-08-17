/**
 * Drug schedule classifier — decides which schedule a medicine falls in, and
 * whether it is a controlled (NDPS) substance.
 *
 * Pure and database-free: callers load the DrugScheduleRule rows once, build an
 * index, and classify as many products as they like against it. That keeps the
 * 254K-row backfill to a single rule query and makes every branch unit-testable.
 *
 * THE CASCADE (first match wins, per the workflow spec):
 *   1. extract the salts and the dosage form
 *   2. any salt in Schedule X                                → X
 *   3. any salt in Schedule H1                               → H1
 *   4. any salt in Schedule H                                → H
 *   5. any salt in Schedule G   → topical ? OTC : G
 *   6. nothing matched                                       → OTC
 *
 * THE NDPS OVERLAY is a SECOND, INDEPENDENT axis applied afterwards. A molecule
 * can be Schedule H1 (what the counter collects) *and* a psychotropic (which
 * register it appears in) at the same time — tramadol is exactly that. Folding
 * the two into one flag is what would wrongly put every tramadol SKU under vault
 * custody, so `schedule` and `controlledClass` are always reported separately.
 *
 * SCHEDULE H2 IS A THIRD AXIS, not a rung of the cascade. Its 300 entries are
 * the formulations notified under Rule 96(6)-(7) that must carry a QR/barcode so
 * the pack can be authenticated — an ANTI-COUNTERFEITING obligation, chosen by
 * sales volume, not a prescription control. The list contains a pregnancy test
 * kit and two multivitamins, and it also contains meropenem and an anabolic
 * steroid. Treating it as the strictest rung (which it was) meant a brand match
 * replaced the real schedule, wiped controlledClass and vaultControlled, and
 * returned a code the counter does not gate on — quietly turning meropenem into
 * a no-prescription-needed sale. So a brand hit now only raises requiresQrScan
 * and the salt cascade still decides the schedule.
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
 * 3 — Schedule H2 became a flag instead of a schedule, and brand keys ignore
 *     pack size so the QR obligation matches at all.
 * 4 — the derived composition keeps its strengths (it is read back on the next
 *     run, and dropping them broke the codeine exemption), and an explicit oral
 *     dosage form outranks the topical guess made from the brand name.
 * 5 — reason wording only: an NDPS drug no longer reads "over the counter" and
 *     then "Schedule H" in the same sentence, and a single-ingredient narcotic
 *     is refused on that ground rather than on a limit it is under.
 * 6 — classification now reads the salt master by join instead of matching the
 *     composition text by name. Same answers everywhere except three
 *     sulphacetamide eye drops, which were under-restrictive before.
 */
export const CLASSIFIER_VERSION = 6;

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

/**
 * Dosage forms that settle the question on their own — swallowed, injected or
 * inhaled, none of them an "external preparation". `drops` is deliberately
 * absent (eye and ear drops are arguably external) and so is `other`, which is
 * the coarse bucket the brand-name guess exists to serve.
 */
const SYSTEMIC_FORMS = new Set(['tablet', 'capsule', 'syrup', 'injection', 'inhaler']);

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

/** Pack units, as opposed to strength units — the tail of a notified name. */
const PACK_UNITS = 'ml|gm|mdi|kit|rotacap|md|respule|vial|amp';

/**
 * Reduce a trade name to a comparable key for the Schedule H2 brand list.
 *
 * The two sides are written differently and neither can be changed: the notified
 * list carries the pack it was notified with ("ACILOC 150 MG TABLET 30"), while
 * the catalog names the product ("Aciloc 150 Tablet"). So the pack tail goes,
 * and the strength UNIT goes while the strength NUMBER stays — the catalog
 * routinely omits "mg" but never the number, and the number is what separates
 * "Pan 40" from "Pan 20", which are separately notified.
 *
 * Matching is deliberately tolerant now that a hit only raises a QR flag. Before
 * this was a flag, a false positive silently dropped a drug's schedule; now the
 * worst it can do is ask a counter to scan a pack it did not have to.
 */
export function normaliseBrand(raw: string | null | undefined): string {
  let s = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/([\d./]+)\s*(mg|mcg|ml|iu|gm|g|%)\b/g, '$1$2'); // "150 mg" -> "150mg"
  s = s.replace(new RegExp(`(\\s+\\d+(\\s*(${PACK_UNITS}))?)+$`, 'g'), ''); // drop the pack
  s = s.replace(/([\d./]+)\s*(mg|mcg|ml|iu|gm|g)\b/g, '$1'); // "150mg" -> "150"
  return s.replace(/\s+/g, ' ').trim();
}

// "10mg/5ml", "1.25mg", "50mcg", "0.3% w/v"
const STRENGTH_RE = /([\d.]+)\s*(mcg|mg|gm|g|ml|iu|%)\s*(?:\/\s*([\d.]+)?\s*(ml|gm|g))?/i;

/**
 * Write a parsed salt back the way the catalog writes it: "Codeine (30mg)".
 *
 * This has to round-trip. The classification result is used to backfill the
 * `composition` column, and the classifier PREFERS that column over the generic
 * name on the next run — so emitting the molecule without its strength quietly
 * destroys the strength as far as every later classification is concerned. That
 * is not hypothetical: it left "Paracetamol (650mg) + Codeine (30mg)" stored as
 * "Paracetamol + Codeine", after which the codeine exemption could no longer
 * read 30mg, failed safe, and put an ordinary codeine tablet under vault
 * custody. 178 products were reading "strength could not be read" against 32
 * correctly exempted.
 */
export function formatSalt(s: ParsedSalt): string {
  if (s.strengthValue === null || !s.strengthUnit) return s.raw;
  const per = s.perVolumeMl ? `/${s.perVolumeMl}ml` : '';
  return `${s.raw} (${s.strengthValue}${s.strengthUnit}${per})`;
}

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
      // Keyed off the raw trade name rather than the stored matchNorm: the
      // fixture's names carry the pack count they were notified with ("ACILOC
      // 150 MG TABLET 30") and no catalog names a pack. First rule wins — the
      // only collisions are one formulation notified in two tube sizes.
      const key = normaliseBrand(r.matchValue);
      if (key && !byBrand.has(key)) byBrand.set(key, r);
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
export function saltLookupKeys(norm: string): string[] {
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
  const form = (input.dosageForm ?? '').toLowerCase().trim();
  if (form === 'cream') return true;
  if (input.route && TOPICAL_WORDS.test(input.route)) return true;
  // A dosage form that states the medicine is swallowed or injected settles it.
  // The brand-name guess below exists only because the DosageForm enum lumps
  // ointments, gels and lotions into `other` — it must not overrule a form that
  // is already explicit, or a flavour name carries the decision: "Aroget DX
  // Syrup American Ice Cream" was read as topical on the word "Cream" and its
  // Schedule G antihistamine was exempted down to over-the-counter.
  if (SYSTEMIC_FORMS.has(form)) return false;
  return TOPICAL_WORDS.test(input.brandName ?? '');
}

/**
 * Choose which field to read the molecules from.
 *
 * Normally the curated `composition` column wins over the generic name. The
 * exception repairs our own damage: earlier versions backfilled that column
 * with the molecule names alone, so 246,485 catalog rows hold "Paracetamol +
 * Codeine" while the generic name still says "Paracetamol (650mg) + Codeine
 * (30mg)". Reading the stripped value would keep the strengths invisible for
 * good and keep the codeine exemption failing safe into the vault.
 *
 * So when the composition yields no strength at all and the generic name yields
 * one, the generic name is used. This can only ever add information — if the
 * composition already has strengths, or the generic name has none to offer, it
 * changes nothing.
 */
function pickSalts(input: ClassificationInput): ParsedSalt[] {
  const fromComposition = parseSalts(input.composition?.trim() || '');
  const hasStrength = (list: ParsedSalt[]) => list.some((s) => s.strengthValue !== null);
  if (fromComposition.length && !hasStrength(fromComposition)) {
    const fromGeneric = parseSalts(input.genericName?.trim() || '');
    if (hasStrength(fromGeneric)) return fromGeneric;
  }
  return fromComposition.length ? fromComposition : parseSalts(input.genericName?.trim() || '');
}

export function classify(
  input: ClassificationInput,
  index: RuleIndex,
): ClassificationResult {
  const salts = pickSalts(input);
  const composition = salts.length ? salts.map(formatSalt).join(' + ') : null;

  const base = {
    salts,
    composition,
    narcoticClass: null as string | null,
    needsReview: false,
  };

  // ── Schedule H2 — a QR obligation carried alongside, NOT a schedule ──
  // Matched on the whole trade name rather than a salt. It deliberately does not
  // return: the schedule still comes from the composition below. See the note at
  // the top of this file for why conflating the two was dangerous.
  const brandRule = index.byBrand.get(normaliseBrand(input.brandName));
  const qrScan = Boolean(brandRule);

  // ── 1-6. Salt cascade ──
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
      } else if (exempt.singleIngredient) {
        reason = `${rule.matchValue} is the only active ingredient. The NDPS exemption covers combination preparations only, so full narcotic control applies.`;
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
    // Replaces rather than appends. Appending produced "No scheduled substance
    // found — over the counter. Covered by Schedule H…", which contradicts
    // itself in one sentence, on exactly the drugs where the explanation is
    // read most carefully.
    reason = `${matchedRule ?? 'This drug'} is listed in the NDPS Act, 1985, which Schedule H covers as an entry in its own right — so it is a prescription drug.`;
  }

  return {
    ...base,
    schedule,
    reason: qrScan
      ? `${reason} Also a Schedule H2 formulation ("${brandRule!.matchValue}") — the pack carries a QR/barcode to be scanned at sale.`
      : reason,
    matchedRule,
    controlledClass,
    narcoticClass,
    vaultControlled,
    requiresQrScan: qrScan,
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
): { within: boolean; unknown: boolean; singleIngredient?: boolean } {
  // The exemption is written for COMBINATION preparations only, so a single
  // -ingredient one is refused on that ground, not on a limit it may well be
  // under. Reported separately or the explanation reads "15mg exceeds the
  // 100mg limit", which is plainly false to anyone checking it.
  if (saltCount < 2) return { within: false, unknown: false, singleIngredient: true };
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
