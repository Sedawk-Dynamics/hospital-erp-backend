import { describe, it, expect } from 'vitest';
import {
  parsePackSize,
  inferLooseUnitLabel,
} from '../../../../src/modules/drug-master/drug-master.dataset';

describe('parsePackSize', () => {
  it('extracts the count of countable units from a pack label', () => {
    expect(parsePackSize('strip of 10 tablets')).toBe(10);
    expect(parsePackSize('strip of 15 tablets')).toBe(15);
    expect(parsePackSize('10 tablets')).toBe(10);
    expect(parsePackSize('packet of 4 capsules')).toBe(4);
    expect(parsePackSize("10's")).toBe(10);
    expect(parsePackSize('1*10')).toBe(10);
    expect(parsePackSize('10 x 1')).toBe(10);
    expect(parsePackSize('30 capsules')).toBe(30);
    expect(parsePackSize('jar of 50 sachets')).toBe(50);
  });

  it('returns null for indivisible containers and empty input', () => {
    expect(parsePackSize('bottle of 100 ml syrup')).toBeNull();
    expect(parsePackSize('tube of 30 gm')).toBeNull();
    expect(parsePackSize('1 vial')).toBeNull();
    expect(parsePackSize('vial of 1 injection')).toBeNull();
    expect(parsePackSize('box of 1 device')).toBeNull();
    expect(parsePackSize('')).toBeNull();
    expect(parsePackSize(null)).toBeNull();
  });
});

describe('inferLooseUnitLabel', () => {
  it('labels countable solid forms', () => {
    expect(inferLooseUnitLabel('tablet', 'Crocin 500')).toBe('Tablet');
    expect(inferLooseUnitLabel('capsule', 'Amoxil 250')).toBe('Capsule');
  });

  it('returns null for forms not sold loose', () => {
    expect(inferLooseUnitLabel('syrup', 'Benadryl Cough')).toBeNull();
    expect(inferLooseUnitLabel('injection', 'Monocef 1g')).toBeNull();
    expect(inferLooseUnitLabel('cream', 'Betnovate N')).toBeNull();
    expect(inferLooseUnitLabel(null, null)).toBeNull();
  });
});
