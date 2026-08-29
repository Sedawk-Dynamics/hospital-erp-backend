import { describe, it, expect } from 'vitest';
import { compositionText, cleanSalts } from '../../../../src/modules/drug-master/composition';
import { parseSalts } from '../../../../src/modules/drug-master/drug-schedule.classifier';

/**
 * Structured salts and the text form have to be two views of one truth. If
 * compositionText() writes something parseSalts() reads back differently, the
 * next classification disagrees with the one before it — which is how the
 * strengths were lost the first time.
 */

describe('compositionText', () => {
  it('round-trips through the parser without losing anything', () => {
    const salts = [
      { name: 'Paracetamol', strengthValue: 500, strengthUnit: 'mg' },
      { name: 'Caffeine', strengthValue: 65, strengthUnit: 'mg' },
    ];
    const text = compositionText(salts)!;
    expect(text).toBe('Paracetamol (500mg) + Caffeine (65mg)');

    const back = parseSalts(text);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ norm: 'paracetamol', strengthValue: 500, strengthUnit: 'mg' });
    expect(back[1]).toMatchObject({ norm: 'caffeine', strengthValue: 65, strengthUnit: 'mg' });
  });

  it('round-trips a per-volume strength', () => {
    const text = compositionText([
      { name: 'Codeine', strengthValue: 10, strengthUnit: 'mg', perVolumeValue: 5, perVolumeUnit: 'ml' },
    ])!;
    expect(text).toBe('Codeine (10mg/5ml)');
    expect(parseSalts(text)[0]).toMatchObject({ strengthValue: 10, perVolumeMl: 5 });
  });

  it('writes a bare name when no strength was given', () => {
    // A molecule with an unknown strength is still a molecule; it must not be
    // dropped just because the quantity box was left empty.
    expect(compositionText([{ name: 'Paracetamol' }])).toBe('Paracetamol');
  });

  it('returns null when there is nothing to write', () => {
    expect(compositionText([])).toBeNull();
    expect(compositionText([{ name: '   ' }])).toBeNull();
  });
});

describe('cleanSalts', () => {
  it('drops the blank rows a half-filled form sends', () => {
    expect(cleanSalts([{ name: 'Paracetamol' }, { name: '' }, { name: '  ' }])).toHaveLength(1);
  });

  it('collapses a molecule named twice', () => {
    // Two rows for one molecule would violate the (drug, salt) unique key.
    const out = cleanSalts([
      { name: 'Paracetamol', strengthValue: 500, strengthUnit: 'mg' },
      { name: 'paracetamol', strengthValue: 325, strengthUnit: 'mg' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].strengthValue).toBe(500); // the first wins
  });

  it('lowercases the unit so mg and MG are one thing', () => {
    expect(cleanSalts([{ name: 'X', strengthValue: 1, strengthUnit: 'MG' }])[0].strengthUnit).toBe('mg');
  });

  it('is safe on nothing at all', () => {
    expect(cleanSalts(undefined)).toEqual([]);
    expect(cleanSalts(null)).toEqual([]);
  });
});
