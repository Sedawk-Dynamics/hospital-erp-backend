import { describe, it, expect } from 'vitest';
import { b2clThreshold, isB2cLarge } from '../../../src/shared/b2cl-threshold';

// #282: GSTR-1 Table 5 takes inter-State B2C invoices ABOVE Rs 1 lakh from
// 1 Aug 2024; before that the limit was Rs 2.5 lakh.
describe('B2C large limit', () => {
  it('is Rs 2.5 lakh before 1 Aug 2024 and Rs 1 lakh from that day, by Indian date', () => {
    expect(b2clThreshold('2024-07-31')).toBe(250000);
    expect(b2clThreshold('2024-08-01')).toBe(100000);
    // 31 Jul 2024 20:00 UTC is already 1 Aug in India.
    expect(b2clThreshold(new Date('2024-07-31T20:00:00Z'))).toBe(100000);
    expect(b2clThreshold(new Date('2024-07-31T18:00:00Z'))).toBe(250000);
    expect(b2clThreshold(new Date('2026-11-20T05:00:00Z'))).toBe(100000);
  });

  it('is strictly above the limit, and inter-State only', () => {
    const d = '2026-11-20';
    expect(isB2cLarge(true, 100000, d)).toBe(false);
    expect(isB2cLarge(true, 100000.01, d)).toBe(true);
    expect(isB2cLarge(false, 500000, d)).toBe(false);
    expect(isB2cLarge(true, 200000, '2024-07-01')).toBe(false);
    expect(isB2cLarge(true, 250000.01, '2024-07-01')).toBe(true);
  });
});
