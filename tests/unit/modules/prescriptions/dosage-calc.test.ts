import { describe, it, expect } from 'vitest';
import {
  parseFrequencyPerDay,
  parseDurationDays,
  parseDoseMultiplier,
  calcDispenseQuantity,
} from '../../../../src/modules/prescriptions/dosage-calc';

describe('dosage-calc', () => {
  describe('parseFrequencyPerDay', () => {
    it('sums the M-A-N slots', () => {
      expect(parseFrequencyPerDay('1-1-1')).toBe(3);
      expect(parseFrequencyPerDay('1-0-1')).toBe(2);
      expect(parseFrequencyPerDay('0-0-1')).toBe(1);
      expect(parseFrequencyPerDay('2-2-2')).toBe(6);
    });

    it('handles fractional doses', () => {
      expect(parseFrequencyPerDay('1/2-0-1/2')).toBe(1);
      expect(parseFrequencyPerDay('1/2-0-0')).toBe(0.5);
    });

    it('tolerates the timing suffix the doctor UI appends', () => {
      expect(parseFrequencyPerDay('1-1-1 - After Meal')).toBe(3);
      expect(parseFrequencyPerDay('0-1-0 - Before Breakfast')).toBe(1);
    });

    it('treats Stat as a single dose', () => {
      expect(parseFrequencyPerDay('Stat')).toBe(1);
      expect(parseFrequencyPerDay('stat')).toBe(1);
    });

    it('returns null for PRN / as-needed', () => {
      expect(parseFrequencyPerDay('SOS')).toBeNull();
      expect(parseFrequencyPerDay('As Needed (SOS)')).toBeNull();
      expect(parseFrequencyPerDay('PRN')).toBeNull();
    });

    it('returns null for non M-A-N codes and empty input', () => {
      expect(parseFrequencyPerDay('BD')).toBeNull();
      expect(parseFrequencyPerDay('Q6H')).toBeNull();
      expect(parseFrequencyPerDay('')).toBeNull();
      expect(parseFrequencyPerDay(null)).toBeNull();
      expect(parseFrequencyPerDay(undefined)).toBeNull();
    });
  });

  describe('parseDurationDays', () => {
    it('parses days / weeks / months / years', () => {
      expect(parseDurationDays('7 days')).toBe(7);
      expect(parseDurationDays('2 weeks')).toBe(14);
      expect(parseDurationDays('1 month')).toBe(30);
      expect(parseDurationDays('1 year')).toBe(365);
    });

    it('defaults a bare number to days', () => {
      expect(parseDurationDays('5')).toBe(5);
    });

    it('returns null for missing or zero duration', () => {
      expect(parseDurationDays('')).toBeNull();
      expect(parseDurationDays(null)).toBeNull();
      expect(parseDurationDays('0 days')).toBeNull();
    });
  });

  describe('parseDoseMultiplier', () => {
    it('defaults to 1 for missing / blank / invalid input', () => {
      expect(parseDoseMultiplier(undefined)).toBe(1);
      expect(parseDoseMultiplier(null)).toBe(1);
      expect(parseDoseMultiplier('')).toBe(1);
      expect(parseDoseMultiplier('abc')).toBe(1);
    });

    it('defaults to 1 for zero / negative doses', () => {
      expect(parseDoseMultiplier(0)).toBe(1);
      expect(parseDoseMultiplier(-2)).toBe(1);
    });

    it('passes through positive numbers and numeric strings', () => {
      expect(parseDoseMultiplier(2)).toBe(2);
      expect(parseDoseMultiplier('1.5')).toBe(1.5);
    });
  });

  describe('calcDispenseQuantity', () => {
    it('computes the headline example: 1-1-1 for 3 days = 9', () => {
      expect(calcDispenseQuantity('1-1-1', '3 days')).toBe(9);
    });

    it('multiplies through weeks and months', () => {
      expect(calcDispenseQuantity('1-0-1', '1 week')).toBe(14); // 2/day × 7
      expect(calcDispenseQuantity('0-0-1', '1 month')).toBe(30); // 1/day × 30
    });

    it('rounds up so the course can be completed', () => {
      expect(calcDispenseQuantity('1/2-0-0', '7 days')).toBe(4); // 3.5 → 4
    });

    it('works with the encoded frequency string from the UI', () => {
      expect(calcDispenseQuantity('1-1-1 - After Meal', '3 days')).toBe(9);
    });

    it('defaults the per-intake dose to 1', () => {
      expect(calcDispenseQuantity('1-1-1', '3 days')).toBe(9);
      expect(calcDispenseQuantity('1-1-1', '3 days', undefined)).toBe(9);
    });

    it('multiplies by the per-intake dose when supplied', () => {
      expect(calcDispenseQuantity('1-1-1', '3 days', 2)).toBe(18); // 3 × 3 × 2
      expect(calcDispenseQuantity('0-0-1', '5 days', 2)).toBe(10); // 1 × 5 × 2
      expect(calcDispenseQuantity('1-0-1', '1 week', '2')).toBe(28); // 2 × 7 × 2
    });

    it('treats a zero / negative dose as the default 1', () => {
      expect(calcDispenseQuantity('1-1-1', '3 days', 0)).toBe(9);
      expect(calcDispenseQuantity('1-1-1', '3 days', -5)).toBe(9);
    });

    it('rounds up fractional per-intake doses', () => {
      expect(calcDispenseQuantity('1-0-0', '3 days', 1.5)).toBe(5); // 1 × 3 × 1.5 = 4.5 → 5
    });

    it('returns null when it cannot be derived (PRN, no duration)', () => {
      expect(calcDispenseQuantity('SOS', '3 days')).toBeNull();
      expect(calcDispenseQuantity('1-1-1', null)).toBeNull();
      expect(calcDispenseQuantity('BD', '5 days')).toBeNull();
    });
  });
});
