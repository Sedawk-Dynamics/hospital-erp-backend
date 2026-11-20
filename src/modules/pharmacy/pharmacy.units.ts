import { inferLooseUnitLabel } from '../drug-master/drug-master.dataset';

// Gap 345: ONE pair of selling-unit nouns per item — the same rule the POS uses
// (frontend lib/pharmacy-units.ts `sellingUnits`) — so the quantity field, the
// stock-clamp message and the bill line all name the same unit. A drug with no
// pack breakdown used to bill a whole bottle as "1 ml".

/** "Strip (UQC PAC)" → "strip"; blank → "pack". */
export function packUnitNoun(unitOfMeasurement?: string | null): string {
  const raw = (unitOfMeasurement ?? '').replace(/\(.*?\)/g, '').trim().toLowerCase();
  return raw || 'pack';
}

export function saleUnitNouns(drug: {
  looseUnitLabel?: string | null;
  unitOfMeasurement?: string | null;
  dosageForm?: string | null;
  drugName?: string | null;
  packSize?: number | null;
} | null | undefined): { packNoun: string; looseNoun: string } {
  const packNoun = packUnitNoun(drug?.unitOfMeasurement);
  const inferred = inferLooseUnitLabel(drug?.dosageForm ?? null, drug?.drugName ?? null);
  if (drug?.packSize && drug.packSize > 1) {
    return { packNoun, looseNoun: drug.looseUnitLabel?.trim() || inferred || 'unit' };
  }
  const single =
    drug?.looseUnitLabel?.trim() || (drug?.unitOfMeasurement ? packNoun : '') || inferred || 'unit';
  return { packNoun: single, looseNoun: single };
}

export function pluralUnit(count: number, unit: string): string {
  if (count === 1) return unit;
  if (/y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  if (/s$/i.test(unit)) return unit;
  return `${unit}s`;
}

export function formatUnits(count: number, unit: string): string {
  return `${count} ${pluralUnit(count, unit)}`;
}

/** How a sold quantity reads on the bill line. `baseQty` is in base units. */
export function describeSaleQty(
  baseQty: number,
  saleUnit: 'pack' | 'loose',
  packSize: number,
  nouns: { packNoun: string; looseNoun: string },
): string {
  if (packSize > 1 && saleUnit === 'pack') {
    const packs = baseQty / packSize;
    return `${formatUnits(packs, nouns.packNoun)} of ${formatUnits(packSize, nouns.looseNoun)}`;
  }
  if (packSize > 1) return `${formatUnits(baseQty, nouns.looseNoun)}, loose`;
  return formatUnits(baseQty, nouns.looseNoun);
}
