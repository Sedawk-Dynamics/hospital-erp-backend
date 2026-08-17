/**
 * Classify a drug from its STRUCTURED composition.
 *
 * The string classifier next door reads a text field, parses it into molecules,
 * normalises each one and matches it against the rule table by name — on every
 * classification of every drug. This one is handed the molecules already
 * resolved, with their schedules attached, and only has to apply the statutory
 * logic to them.
 *
 * Everything that was a string comparison is gone. What remains is the part that
 * was never a lookup in the first place: the strictest-molecule cascade, the two
 * exemptions written into the schedules themselves, and the NDPS overlay.
 *
 * ── Where this differs from the string classifier ─────────────────────────
 * It was written as a port, and across all 253,987 catalog products the two
 * agree on 253,984. The three that differ are all the same case, and the salt
 * path is the correct one:
 *
 *   Sulphacetamide + Chlorpheniramine eye drops.  Chlorpheniramine is named in
 *   Schedule G; sulphacetamide is covered by Schedule H's "Para-Amino Benzene
 *   Sulphonamide, its Salts & Derivatives" entry. The string classifier only
 *   consulted the class entries when NOTHING ELSE in the product had matched —
 *   a product-level test — so the Schedule G hit suppressed the Schedule H one
 *   and the drops came out as G. Here every molecule carries its own schedule,
 *   the class included, so the strictest genuinely wins. A sulphacetamide eye
 *   drop is a prescription drug; G was under-restrictive.
 *
 * The other honest difference: a molecule nobody has scheduled contributes
 * nothing to the cascade, so a product made only of unscheduled molecules is
 * over-the-counter — exactly as before. Those molecules are visible as work in
 * the salt review queue rather than being silently treated as safe.
 */

import {
  type ScheduleCode,
  type ControlledClass,
  type ClassificationResult,
  type ParsedSalt,
  CLASSIFIER_VERSION,
} from './drug-schedule.classifier';

/** Cascade order. NDPS is absent by design — an overlay, not a rung. */
const PRECEDENCE: Exclude<ScheduleCode, 'H2' | 'OTC'>[] = ['X', 'H1', 'H', 'G'];

const TOPICAL_WORDS = /\b(ointment|gel|lotion|topical|external|cream|balm|liniment|salve|patch)\b/i;
const SYSTEMIC_FORMS = new Set(['tablet', 'capsule', 'syrup', 'injection', 'inhaler']);

/** One molecule of a product, as it comes back from the DrugSalt join. */
export interface SaltRow {
  name: string;
  scheduleCode: string | null;
  controlledClass: string | null;
  narcoticClass: string | null;
  vaultControlled: boolean;
  exemptIfCombination: boolean;
  maxPerUnitMg: number | null;
  maxConcentrationPercent: number | null;
  fallbackSchedule: string | null;
  topicalExempt: boolean;
  /** Therapeutic classes this molecule belongs to, with their schedules. */
  classes?: { name: string; scheduleCode: string }[];

  strengthValue: number | null;
  strengthUnit: string | null;
  perVolumeValue: number | null;
}

export interface SaltClassificationInput {
  brandName?: string | null;
  dosageForm?: string | null;
  route?: string | null;
  salts: SaltRow[];
}

function isTopical(input: SaltClassificationInput): boolean {
  const form = (input.dosageForm ?? '').toLowerCase().trim();
  if (form === 'cream') return true;
  if (input.route && TOPICAL_WORDS.test(input.route)) return true;
  if (SYSTEMIC_FORMS.has(form)) return false;
  return TOPICAL_WORDS.test(input.brandName ?? '');
}

function toMilligrams(value: number, unit: string | null): number | null {
  switch ((unit ?? '').toLowerCase()) {
    case 'mg': return value;
    case 'mcg': return value / 1000;
    case 'g':
    case 'gm': return value * 1000;
    default: return null; // %, IU and ml carry no mass to compare against a mg limit
  }
}

/**
 * The codeine decision tree, unchanged in meaning — but now reading numbers
 * instead of re-parsing them out of text on every run.
 */
function withinExemptionLimits(
  salt: SaltRow,
  saltCount: number,
): { within: boolean; unknown: boolean; singleIngredient?: boolean } {
  if (saltCount < 2) return { within: false, unknown: false, singleIngredient: true };
  if (salt.strengthValue === null) return { within: false, unknown: true };

  const mg = toMilligrams(salt.strengthValue, salt.strengthUnit);
  if (mg === null) return { within: false, unknown: true };

  if (salt.perVolumeValue && salt.perVolumeValue > 0) {
    if (salt.maxConcentrationPercent === null) return { within: false, unknown: true };
    const percent = (mg / (salt.perVolumeValue * 1000)) * 100;
    return { within: percent <= salt.maxConcentrationPercent, unknown: false };
  }

  if (salt.maxPerUnitMg === null) return { within: false, unknown: true };
  return { within: mg <= salt.maxPerUnitMg, unknown: false };
}

export function classifyFromSalts(
  input: SaltClassificationInput,
  opts: { requiresQrScan?: boolean; qrFormulation?: string | null } = {},
): ClassificationResult {
  const salts = input.salts;
  const qrScan = Boolean(opts.requiresQrScan);

  // ── The cascade. First molecule to claim a rung keeps it. ──
  const hits = new Map<string, SaltRow>();
  for (const s of salts) {
    if (!s.scheduleCode || s.scheduleCode === 'OTC') continue;
    if (!hits.has(s.scheduleCode)) hits.set(s.scheduleCode, s);
  }

  // There is deliberately no separate "therapeutic class" pass here. Class
  // membership is resolved into the molecule's own scheduleCode when the salt
  // master is seeded, so sulphacetamide simply IS Schedule H and competes in the
  // cascade like any other molecule. `SaltRow.classes` survives as provenance —
  // it is what lets the reason say WHY, and it is what a reviewer edits.

  let schedule: ScheduleCode = 'OTC';
  let matchedRule: string | null = null;
  let reason = salts.length
    ? 'No scheduled substance found in the composition — over the counter.'
    : 'No composition recorded, so no schedule could be resolved.';

  const topical = isTopical(input);

  for (const code of PRECEDENCE) {
    const hit = hits.get(code);
    if (!hit) continue;

    if (code === 'G' && topical && hit.topicalExempt) {
      // Schedule G's own Note: topical/external preparations are not covered.
      schedule = 'OTC';
      matchedRule = hit.name;
      reason = `${hit.name} is Schedule G, but this is a topical/external preparation, which the Schedule excludes.`;
      break;
    }

    schedule = code;
    matchedRule = hit.name;
    // Say WHY when the molecule is covered by a category rather than named —
    // "matched Sulphacetamide" would leave a pharmacist hunting the H list for
    // a molecule that is not on it.
    const viaClass = hit.classes?.find((c) => c.scheduleCode === code);
    reason = viaClass
      ? `Schedule ${code} — ${hit.name} falls under the "${viaClass.name}" class entry.`
      : `Schedule ${code} — matched ${hit.name}.`;
    break;
  }

  // ── NDPS overlay — a second axis, applied after the schedule is settled ──
  let controlledClass: ControlledClass | null = null;
  let narcoticClass: string | null = null;
  let vaultControlled = false;
  let needsReview = false;

  for (const s of salts) {
    if (!s.controlledClass) continue;
    controlledClass = s.controlledClass as ControlledClass;
    narcoticClass = s.narcoticClass ?? null;
    vaultControlled = s.vaultControlled;

    if (s.exemptIfCombination) {
      const exempt = withinExemptionLimits(s, salts.length);
      if (exempt.unknown) {
        needsReview = true;
        reason += ` ${s.name} strength could not be read, so full NDPS control is assumed.`;
      } else if (exempt.within) {
        vaultControlled = false;
        if (s.fallbackSchedule && schedule !== 'X') {
          schedule = s.fallbackSchedule as ScheduleCode;
          matchedRule = s.name;
        }
        reason = `${s.name} combination within the NDPS concentration limits — dispensed as Schedule ${schedule}.`;
      } else if (exempt.singleIngredient) {
        reason = `${s.name} is the only active ingredient. The NDPS exemption covers combination preparations only, so full narcotic control applies.`;
      } else {
        reason = `${s.name} exceeds the NDPS concentration limit — full narcotic control applies.`;
      }
    }
    break; // the first controlled molecule decides; two in one product is not a real case
  }

  // Schedule H names the NDPS Act as an entry in its own right.
  if (controlledClass && schedule === 'OTC') {
    schedule = 'H';
    reason = `${matchedRule ?? 'This drug'} is listed in the NDPS Act, 1985, which Schedule H covers as an entry in its own right — so it is a prescription drug.`;
  }

  const parsed: ParsedSalt[] = salts.map((s) => ({
    raw: s.name,
    norm: s.name.toLowerCase(),
    strengthValue: s.strengthValue,
    strengthUnit: s.strengthUnit,
    perVolumeMl: s.perVolumeValue,
  }));

  return {
    schedule,
    reason: qrScan
      ? `${reason} Also a Schedule H2 formulation ("${opts.qrFormulation ?? 'notified'}") — the pack carries a QR/barcode to be scanned at sale.`
      : reason,
    matchedRule,
    controlledClass,
    narcoticClass,
    vaultControlled,
    requiresQrScan: qrScan,
    salts: parsed,
    composition: salts.length
      ? salts
          .map((s) =>
            s.strengthValue !== null && s.strengthUnit
              ? `${s.name} (${s.strengthValue}${s.strengthUnit}${s.perVolumeValue ? `/${s.perVolumeValue}ml` : ''})`
              : s.name,
          )
          .join(' + ')
      : null,
    needsReview,
  };
}

export { CLASSIFIER_VERSION };
