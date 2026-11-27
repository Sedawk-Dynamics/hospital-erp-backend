import { describe, it, expect } from 'vitest';
import {
  formatQty, formatDrugQty, qtyUnitsOf, unitNoun, pluralUnit, snapshotQtyText, unitsFromSnapshot,
} from '../../../../src/modules/pharmacy/pharmacy.units';

// Gap 345 — the wording rules. The SAME table runs in the frontend
// (src/lib/pharmacy-units.test.ts), so the POS and the server cannot word one
// item two ways. Change both together.

const STRIP = { drugName: 'Dolo 650 Tablet', dosageForm: 'tablet', unitOfMeasurement: 'Strip (UQC PAC)', packSize: 10, looseUnitLabel: 'Tablet' };

export const UNIT_CASES: Array<[string, Record<string, unknown>, number, string]> = [
  ['whole packs', STRIP, 20, '2 strips (20 tablets)'],
  ['one pack', STRIP, 10, '1 strip (10 tablets)'],
  ['loose only', STRIP, 5, '5 tablets (loose)'],
  ['one loose', STRIP, 1, '1 tablet (loose)'],
  ['mixed', STRIP, 15, '1 strip + 5 tablets (15 tablets)'],
  ['mixed, one left over', STRIP, 21, '2 strips + 1 tablet (21 tablets)'],
  ['nothing', STRIP, 0, '0 tablets'],
  ['negative', STRIP, -15, '-1 strip + 5 tablets (15 tablets)'],
  ['bottle sold whole', { drugName: 'Ascoril Syrup', dosageForm: 'syrup', unitOfMeasurement: 'Bottle (UQC BTL)' }, 2, '2 bottles'],
  ['syrup with no unit set is a bottle, not ml', { drugName: 'Benadryl', dosageForm: 'syrup' }, 1, '1 bottle'],
  ['tube', { drugName: 'Betnovate', dosageForm: 'cream' }, 3, '3 tubes'],
  ['vial', { drugName: 'Monocef', dosageForm: 'injection', unitOfMeasurement: 'Vial (UQC NOS)', packSize: 1 }, 4, '4 vials'],
  ['box', { drugName: 'Gloves', unitOfMeasurement: 'Box (UQC BOX)' }, 2, '2 boxes'],
  ['catalogue pack label as unit of measurement', { ...STRIP, unitOfMeasurement: 'strip of 10 tablets', looseUnitLabel: null }, 20, '2 strips (20 tablets)'],
  ['truncated catalogue label', { ...STRIP, unitOfMeasurement: 'Strip (UQC PA' }, 20, '2 strips (20 tablets)'],
  ['unusable unit of measurement', { ...STRIP, unitOfMeasurement: '10x10' }, 20, '2 packs (20 tablets)'],
  ['unit of measurement names the tablet', { ...STRIP, unitOfMeasurement: 'Tablet (UQC TBS)' }, 20, '2 packs (20 tablets)'],
  ['capsules inferred from the form', { drugName: 'Omez', dosageForm: 'capsule', packSize: 15, unitOfMeasurement: 'Strip' }, 16, '1 strip + 1 capsule (16 capsules)'],
  ['sachets', { drugName: 'ORS Sachet', packSize: 4, unitOfMeasurement: 'Box' }, 6, '1 box + 2 sachets (6 sachets)'],
  ['nothing known at all', { drugName: 'Thing' }, 3, '3 units'],
  ['pack with nothing else known', { drugName: 'Thing', packSize: 5 }, 12, '2 packs + 2 units (12 units)'],
];

describe('345 — one way to word a quantity', () => {
  it.each(UNIT_CASES)('%s', (_name, drug, qty, words) => {
    expect(formatDrugQty(qty, drug as never)).toBe(words);
  });

  it('never prints a fraction of a pack', () => {
    for (let n = 0; n <= 100; n++) {
      expect(formatDrugQty(n, STRIP)).not.toMatch(/\d\.\d/);
    }
  });

  it('plurals', () => {
    expect(pluralUnit(2, 'ml')).toBe('ml');
    expect(pluralUnit(2, 'suppository')).toBe('suppositories');
    expect(pluralUnit(2, 'tray')).toBe('trays');
    expect(pluralUnit(1, 'box')).toBe('box');
    expect(unitNoun('Tablets')).toBe('tablet');
    expect(unitNoun('boxes')).toBe('box');
  });

  it('rewords an old line from the units it was sold in, not the drug today', () => {
    const sold = { ...qtyUnitsOf(STRIP) };
    expect(snapshotQtyText(20, JSON.parse(JSON.stringify(sold)))).toBe('2 strips (20 tablets)');
    // The pack size has since moved to 15; the document still says what it said.
    expect(formatQty(20, qtyUnitsOf({ ...STRIP, packSize: 15 }))).toBe('1 strip + 5 tablets (20 tablets)');
    // A line raised before the snapshot existed has none, and is not reworded.
    expect(snapshotQtyText(20, null)).toBeNull();
    expect(unitsFromSnapshot({ packSize: 10 })).toBeNull();
  });
});
