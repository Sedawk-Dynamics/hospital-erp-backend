import { describe, it, expect } from 'vitest';
import { matchHsnGst, normalizeHsn } from '../../../../src/modules/drug-master/drug-master.service';

const rows = [
  { hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: 'Medicaments' },
  { hsnCode: '30049010', gstRate: 0, treatment: 'nil_rated', description: 'ORS' },
  { hsnCode: '2106', gstRate: 18, treatment: 'taxable', description: 'Supplements' },
  // A row written before the treatment column existed.
  { hsnCode: '9018', gstRate: 5, treatment: null, description: 'Instruments' },
  { hsnCode: '4015', gstRate: 0, treatment: null, description: 'Gloves' },
];

describe('normalizeHsn', () => {
  it('keeps only the digits', () => {
    expect(normalizeHsn('3004.90.10')).toBe('30049010');
    expect(normalizeHsn('3004 9010')).toBe('30049010');
    expect(normalizeHsn(null)).toBe('');
  });
});

describe('matchHsnGst', () => {
  it('matches a code to its chapter heading', () => {
    const m = matchHsnGst('30041020', rows)!;
    expect(m).toMatchObject({ matchedCode: '3004', gstRate: 5, treatment: 'taxable' });
  });

  // The whole reason longest-prefix matching exists: ORS must stay nil even
  // though its chapter heading is 5%.
  it('lets a specific tariff item beat its heading', () => {
    const m = matchHsnGst('30049010', rows)!;
    expect(m).toMatchObject({ matchedCode: '30049010', gstRate: 0, treatment: 'nil_rated' });
  });

  it('returns nothing when no row is a prefix', () => {
    expect(matchHsnGst('8471', rows)).toBeNull();
    expect(matchHsnGst('', rows)).toBeNull();
  });

  // A row saved before the column existed must not come back with an undefined
  // treatment — every consumer branches on it.
  it('reads a legacy row treatment from its rate', () => {
    expect(matchHsnGst('9018', rows)!.treatment).toBe('taxable');
    expect(matchHsnGst('4015', rows)!.treatment).toBe('nil_rated');
  });

  it('reports the code that was looked up alongside the row that matched', () => {
    const m = matchHsnGst('3004.10.20', rows)!;
    expect(m.hsnCode).toBe('30041020');
    expect(m.matchedCode).toBe('3004');
  });
});
