// Pure helpers shared by the catalogue import (drug-catalog.normalize.ts), the
// super-admin create/update path and the formulary import: search tokens, the
// dosage-form guess from a name, and loose-unit pack sizes. NO prisma/io
// imports so it stays trivially testable.

export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'injection'
  | 'cream'
  | 'drops'
  | 'inhaler'
  | 'other';

/**
 * Denormalised lowercase token blob powering catalog search (brand + generic
 * + manufacturer + aliases/tags). Single source of truth for both the
 * create/update service path and the catalogue import.
 */
export function buildDrugSearchTokens(input: {
  name?: string | null;
  genericName?: string | null;
  manufacturer?: string | null;
  aliases?: string[] | null;
  tags?: string[] | null;
}): string {
  const tokens: string[] = [];
  const push = (s?: string | null) => {
    if (!s) return;
    tokens.push(String(s).toLowerCase().trim());
  };
  push(input.name);
  push(input.genericName);
  push(input.manufacturer);
  (input.aliases ?? []).forEach(push);
  (input.tags ?? []).forEach(push);
  return Array.from(new Set(tokens.filter(Boolean))).join(' | ');
}

/**
 * Dosage form guessed from a product's name and pack label. The vendor
 * catalogue states its form outright (see mapVendorForm); this is the fallback
 * for a row that does not.
 */
export function inferDosageForm(name: string, pack: string): DosageForm | null {
  const hay = `${name} ${pack}`.toLowerCase();
  if (/\btablet|\btab\b|\bdt\b/.test(hay)) return 'tablet';
  if (/\bcapsule|\bcap\b/.test(hay)) return 'capsule';
  if (/\bsyrup|suspension|\bsolution\b|\belixir\b|\bsachet\b/.test(hay)) return 'syrup';
  if (/\binjection|\binj\b|\bvial\b|\bampoule\b/.test(hay)) return 'injection';
  if (/\bcream|\bointment|\bgel\b|\blotion\b/.test(hay)) return 'cream';
  if (/\bdrops?\b|eye drop|ear drop|nasal/.test(hay)) return 'drops';
  if (/\binhaler|\brotacap|\brespule|\brotahaler/.test(hay)) return 'inhaler';
  return 'other';
}

/**
 * Best-effort count of individually sellable BASE units in a pack/strip, parsed
 * from a free-text pack label (e.g. "strip of 10 tablets" → 10, "10's" → 10,
 * "1*10" → 10, "packet of 4 capsules" → 4). Returns null when the label
 * describes a single indivisible container (a 100 ml bottle, a 30 gm tube, a
 * vial) where breaking into loose sub-units doesn't apply. Drives the numeric
 * DrugFormulary.packSize so a strip can be split into loose tablets at the
 * counter — stock + price are always tracked per base unit.
 */
export function parsePackSize(label?: string | null): number | null {
  const raw = String(label ?? '').toLowerCase().trim();
  if (!raw) return null;

  // "1*10", "10x1", "2 x 15" → strip layout; multiply the two factors.
  const mult = raw.match(/(\d+)\s*[*x×]\s*(\d+)/);
  if (mult) {
    const n = Number(mult[1]) * Number(mult[2]);
    return Number.isFinite(n) && n > 1 ? n : null;
  }

  // "<N> <countable-unit>" e.g. "strip of 10 tablets", "10 capsules", "10's".
  const countable = raw.match(
    /(\d+)\s*(?:'?s\b|tablets?|capsules?|caps?\b|tabs?\b|dt\b|chewables?|lozenges?|sachets?|suppositor\w*|pieces?|pcs?\b|softgels?|pills?)/,
  );
  if (countable) {
    const n = Number(countable[1]);
    return Number.isFinite(n) && n > 1 ? n : null;
  }

  return null;
}

/** Forms that ship as a strip of countable, loosely-sellable pieces. */
const COUNTABLE_SOLID_FORMS = new Set<string>(['tablet', 'capsule']);

/** Typical Indian strip size — the fallback pack for a countable solid whose
 *  free-text label doesn't state a number. */
export const DEFAULT_SOLID_PACK_SIZE = 10;

/**
 * Resolve the numeric pack size to STORE on a drug. Prefers the count parsed
 * from the free-text label (`parsePackSize`); when that can't be derived but the
 * drug is a countable solid (tablet/capsule), falls back to a typical strip of
 * {@link DEFAULT_SOLID_PACK_SIZE} so it is always sellable as loose units rather
 * than collapsing to a single "pack". Liquids / injections / creams stay null —
 * they're dispensed as one indivisible container.
 */
export function resolvePackSize(
  dosageForm?: DosageForm | string | null,
  packSizeLabel?: string | null,
): number | null {
  const parsed = parsePackSize(packSizeLabel);
  if (parsed != null) return parsed;
  if (COUNTABLE_SOLID_FORMS.has(String(dosageForm ?? '').toLowerCase())) {
    return DEFAULT_SOLID_PACK_SIZE;
  }
  return null;
}

/**
 * Human label for a single sellable sub-unit broken out of a pack (shown on the
 * POS loose-sale control), inferred from the dosage form / brand name. Returns
 * null for forms that aren't sold loose (liquids, creams, injections) so only
 * countable solids get a loose-unit option.
 */
export function inferLooseUnitLabel(
  dosageForm?: DosageForm | string | null,
  name?: string | null,
): string | null {
  const hay = `${String(dosageForm ?? '').toLowerCase()} ${String(name ?? '').toLowerCase()}`;
  if (/\bsoftgel/.test(hay)) return 'Softgel';
  if (/\bcapsule|\bcap\b/.test(hay)) return 'Capsule';
  if (/\bsachet/.test(hay)) return 'Sachet';
  if (/\blozenge/.test(hay)) return 'Lozenge';
  if (/\bsuppositor/.test(hay)) return 'Suppository';
  if (/\btablet|\btab\b|\bdt\b|\bchewable|\bpill/.test(hay)) return 'Tablet';
  return null;
}

/** Minimal RFC-4180 CSV parser (quoted fields + embedded commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore; \n handles the break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
