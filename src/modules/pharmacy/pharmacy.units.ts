import { inferLooseUnitLabel } from '../drug-master/drug-master.dataset';

// Gap 345: ONE pair of unit nouns per item and ONE way of wording a quantity.
//
// Every quantity in this system — DrugBatch.quantityInStock, BillItem.quantity,
// DispensingRecord.quantityDispensed, DrugReturn.quantity, the stock movements —
// is a count of BASE units (tablets). Nothing here changes that. This file only
// says how a base count READS, and everything that shows one goes through
// `formatQty`, so the POS, the clamp message, the bill, the receipt, the credit
// note, the stock list and the stock ledger all print the same words:
//
//   20 tablets, strip of 10  → "2 strips (20 tablets)"
//    5 tablets, strip of 10  → "5 tablets (loose)"
//   15 tablets, strip of 10  → "1 strip + 5 tablets (15 tablets)"
//    2 bottles, no pack      → "2 bottles"
//
// The frontend's lib/pharmacy-units.ts carries the same rules (the POS words a
// quantity while it is being typed). tests/unit/modules/pharmacy/units.test.ts
// and src/lib/pharmacy-units.test.ts run the SAME table of cases.

export interface UnitSource {
  looseUnitLabel?: string | null;
  unitOfMeasurement?: string | null;
  dosageForm?: string | null;
  drugName?: string | null;
  packSize?: number | null;
}

/** How an item's base count is worded. `packSize` 1 = sold only as a whole unit. */
export interface QtyUnits {
  packSize: number;
  packNoun: string;
  looseNoun: string;
}

/** Measures that take no plural: "100 ml", never "100 mls". */
const MEASURES = new Set(['ml', 'l', 'g', 'gm', 'kg', 'mg', 'mcg', 'iu', 'cc']);

const SYNONYMS: Record<string, string> = {
  tab: 'tablet', cap: 'capsule', btl: 'bottle', pc: 'piece', pcs: 'piece',
  no: 'unit', nos: 'unit', amp: 'ampoule', gram: 'gm', millilitre: 'ml', milliliter: 'ml',
};

/** Nouns that name a loose unit, so they cannot also name the pack holding it. */
const LOOSE_ONLY = new Set([
  'tablet', 'capsule', 'softgel', 'lozenge', 'suppository', 'piece', 'unit', 'ml', 'l', 'g', 'gm', 'mg', 'drop',
]);

/** Loose noun for an item with a pack breakdown but no configured label. */
const FORM_LOOSE: Record<string, string> = {
  tablet: 'tablet', capsule: 'capsule', syrup: 'ml', suspension: 'ml', solution: 'ml', drops: 'ml',
  inhaler: 'puff', cream: 'tube', ointment: 'tube', gel: 'tube', powder: 'sachet',
};

/** The whole container, for an item sold only whole — never "ml" for a bottle. */
const FORM_WHOLE: Record<string, string> = {
  tablet: 'tablet', capsule: 'capsule', syrup: 'bottle', suspension: 'bottle', solution: 'bottle',
  drops: 'bottle', inhaler: 'inhaler', cream: 'tube', ointment: 'tube', gel: 'tube', powder: 'sachet',
};

/** "Strip (UQC PAC)" → "strip"; "strip of 10 tablets" → "strip"; "Tablets" → "tablet"; "10x10" → "". */
export function unitNoun(raw?: string | null): string {
  let s = (raw ?? '').toLowerCase().replace(/\(.*?(\)|$)/g, ' ').split(/\bof\b/)[0].trim().replace(/\s+/g, ' ');
  if (!s || !/^[a-z]/.test(s)) return '';
  if (SYNONYMS[s]) return SYNONYMS[s];
  if (/ies$/.test(s)) s = `${s.slice(0, -3)}y`;
  else if (/(x|ch|sh|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  return SYNONYMS[s] ?? s;
}

/** The pack noun from the Unit of Measurement; blank or unusable → "pack". */
export function packUnitNoun(unitOfMeasurement?: string | null): string {
  return unitNoun(unitOfMeasurement) || 'pack';
}

export function qtyUnitsOf(drug: UnitSource | null | undefined): QtyUnits {
  const form = String(drug?.dosageForm ?? '').toLowerCase();
  const configured = unitNoun(drug?.looseUnitLabel);
  const inferred = unitNoun(inferLooseUnitLabel(drug?.dosageForm ?? null, drug?.drugName ?? null));
  const uom = unitNoun(drug?.unitOfMeasurement);
  const packSize = Math.trunc(Number(drug?.packSize ?? 0));
  if (packSize > 1) {
    const looseNoun = configured || inferred || FORM_LOOSE[form] || 'unit';
    // A "Tablet" unit of measurement on a pack of 10 names the tablet, not the pack.
    const packNoun = uom && uom !== looseNoun && !LOOSE_ONLY.has(uom) ? uom : 'pack';
    return { packSize, packNoun, looseNoun };
  }
  const single = configured || uom || inferred || FORM_WHOLE[form] || 'unit';
  return { packSize: 1, packNoun: single, looseNoun: single };
}

/** The pair of nouns alone — kept for callers that only label a control. */
export function saleUnitNouns(drug: UnitSource | null | undefined): { packNoun: string; looseNoun: string } {
  const { packNoun, looseNoun } = qtyUnitsOf(drug);
  return { packNoun, looseNoun };
}

export function pluralUnit(count: number, unit: string): string {
  if (Math.abs(count) === 1 || MEASURES.has(unit.toLowerCase())) return unit;
  if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  if (/(x|ch|sh|ss)$/i.test(unit)) return `${unit}es`;
  if (/s$/i.test(unit)) return unit;
  return `${unit}s`;
}

export function formatUnits(count: number, unit: string): string {
  return `${count} ${pluralUnit(count, unit)}`;
}

/**
 * A base-unit count in words — packs AND the individual units they hold. Never
 * a fractional pack: 15 tablets of a 10-strip is "1 strip + 5 tablets".
 */
export function formatQty(baseQty: number, units: QtyUnits): string {
  const n = Math.round(Number(baseQty) || 0);
  if (n < 0) return `-${formatQty(-n, units)}`;
  const { packSize, packNoun, looseNoun } = units;
  if (packSize <= 1 || n === 0) return formatUnits(n, looseNoun);
  const packs = Math.floor(n / packSize);
  const loose = n % packSize;
  if (packs === 0) return `${formatUnits(n, looseNoun)} (loose)`;
  if (loose === 0) return `${formatUnits(packs, packNoun)} (${formatUnits(n, looseNoun)})`;
  return `${formatUnits(packs, packNoun)} + ${formatUnits(loose, looseNoun)} (${formatUnits(n, looseNoun)})`;
}

/** The same, straight from the drug. */
export function formatDrugQty(baseQty: number, drug: UnitSource | null | undefined): string {
  return formatQty(baseQty, qtyUnitsOf(drug));
}

/**
 * How a sold quantity reads on the bill line. The words follow the BASE count,
 * not the button the cashier pressed: 20 tablets sold loose and 2 strips are
 * the same stock, so they read the same on the bill, the ledger and the return.
 */
export function describeSaleQty(
  baseQty: number,
  _saleUnit: 'pack' | 'loose',
  packSize: number,
  nouns: { packNoun: string; looseNoun: string },
): string {
  return formatQty(baseQty, { packSize, packNoun: nouns.packNoun, looseNoun: nouns.looseNoun });
}

/** Units stored on a bill line / dispense, or null when the row predates them. */
export function unitsFromSnapshot(v: unknown): QtyUnits | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.looseNoun !== 'string' || !o.looseNoun) return null;
  const packSize = Math.trunc(Number(o.packSize));
  return {
    packSize: packSize > 1 ? packSize : 1,
    packNoun: typeof o.packNoun === 'string' && o.packNoun ? o.packNoun : o.looseNoun,
    looseNoun: o.looseNoun,
  };
}

/** Words for a row with a snapshot; null when it has none (older documents). */
export function snapshotQtyText(baseQty: number, snapshot: unknown): string | null {
  const units = unitsFromSnapshot(snapshot);
  return units ? formatQty(baseQty, units) : null;
}

/** The drug columns `qtyUnitsOf` reads — spread into a Prisma select. */
export const UNIT_SELECT = {
  packSize: true,
  looseUnitLabel: true,
  unitOfMeasurement: true,
  dosageForm: true,
} as const;
