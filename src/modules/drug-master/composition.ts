/**
 * A composition entered as DATA rather than typed as a sentence.
 *
 * The catalogue's compositions arrived as text — "Paracetamol (500mg) +
 * Caffeine (65mg)" — so everything downstream had to parse them, and every
 * parser is a place a molecule or a strength can be lost. Two real faults came
 * from exactly that: strengths destroyed by a lossy round-trip, and an
 * unrecognised molecule silently deleted from a drug's own composition.
 *
 * When a caller sends structured salts they are AUTHORITATIVE: no parsing runs,
 * the strength is a number and the unit is a unit. The text form is still
 * produced and stored, because search, the register and every existing screen
 * read it — but it is now derived FROM the data rather than being the data.
 *
 * Text input still works. Bulk imports, older clients and pasted compositions
 * all take the parsing path exactly as before.
 */

/** One molecule of a composition, as the client sends it. */
export interface SaltInput {
  name: string;
  strengthValue?: number | null;
  strengthUnit?: string | null;
  /** For "10mg/5ml" this is 5 — the volume the strength is expressed per. */
  perVolumeValue?: number | null;
  perVolumeUnit?: string | null;
}

/** The units a strength may be expressed in. */
export const STRENGTH_UNITS = ['mg', 'mcg', 'g', 'ml', 'iu', '%'] as const;
export type StrengthUnit = (typeof STRENGTH_UNITS)[number];

/**
 * Render structured salts back to the catalogue's text form.
 *
 * The output has to match what parseSalts() would read back, or the two
 * representations drift and the next classification disagrees with the one
 * before it.
 */
export function compositionText(salts: SaltInput[]): string | null {
  const parts = salts
    .map((s) => {
      const name = (s.name ?? '').trim();
      if (!name) return null;
      if (s.strengthValue === null || s.strengthValue === undefined || !s.strengthUnit) {
        return name;
      }
      const per =
        s.perVolumeValue && s.perVolumeUnit ? `/${s.perVolumeValue}${s.perVolumeUnit}` : '';
      return `${name} (${s.strengthValue}${s.strengthUnit}${per})`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' + ') : null;
}

/**
 * Drop blank rows and collapse a molecule named twice.
 *
 * An empty row is what a half-filled form sends; the same molecule twice would
 * violate the (drug, salt) unique key on the link table. Neither should be the
 * caller's problem to avoid.
 */
export function cleanSalts(salts: SaltInput[] | undefined | null): SaltInput[] {
  if (!salts?.length) return [];
  const seen = new Set<string>();
  const out: SaltInput[] = [];
  for (const s of salts) {
    const name = (s.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      strengthValue: s.strengthValue ?? null,
      strengthUnit: s.strengthUnit ? String(s.strengthUnit).toLowerCase() : null,
      perVolumeValue: s.perVolumeValue ?? null,
      perVolumeUnit: s.perVolumeUnit ? String(s.perVolumeUnit).toLowerCase() : null,
    });
  }
  return out;
}
