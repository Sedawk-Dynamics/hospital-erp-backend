import { describe, it, expect } from 'vitest';
import { findCatalogIssues, isPlaceholderText, normaliseTestName } from '../../../../src/modules/lab/lab-catalog-quality';
import { isPlatformTestRecord } from '../../../../src/modules/lab/lab-units.service';

describe('lab catalogue review flags (gap 369)', () => {
  it('detects the placeholder text QA found, not real content', () => {
    expect(isPlaceholderText('specimen collections notes')).toBe(true);
    expect(isPlaceholderText('description patient instructions')).toBe(true);
    expect(isPlaceholderText('3 mL EDTA whole blood (purple top)')).toBe(false);
    expect(isPlaceholderText('Fasting 10-12 hours')).toBe(false);
    expect(isPlaceholderText(null)).toBe(false);
  });

  it('flags near-duplicate names and an analyte priced above its panel', () => {
    const issues = findCatalogIssues([
      { id: 'a', testName: 'Thyroid Profile (T3, T4, TSH)', price: 500 },
      { id: 'b', testName: 'Thyroid profile', price: 450 },
      { id: 'c', testName: 'Free Thyroid Profile (FT3, FT4, TSH)', price: 600 },
      { id: 'h', testName: 'Haemoglobin', price: 700, specimen: 'specimen collections notes' },
      { id: 'cbc', testName: 'Complete Blood Count (CBC)', price: 350, parameters: [{ name: 'Hemoglobin' }, { name: 'WBC' }] },
    ]);
    expect(issues.map((i) => i.kind)).toContain('placeholder_text');
    const dup = issues.find((i) => i.kind === 'duplicate_name')!;
    expect([...dup.testIds].sort()).toEqual(['a', 'b']);
    const price = issues.find((i) => i.kind === 'price_above_panel')!;
    expect(price.testIds).toEqual(['h', 'cbc']);
    expect(normaliseTestName('Haemoglobin')).toBe('hemoglobin');
  });
});

describe('platform test unit groups (gap 314)', () => {
  it("hides QA/staging global groups but never a hospital's own rows", () => {
    expect(isPlatformTestRecord({ tenantId: null, code: 'qa_units', name: 'QA Units — QA STAGING ONLY - edited group' })).toBe(true);
    expect(isPlatformTestRecord({ tenantId: null, code: 'concentration', name: 'Concentration' })).toBe(false);
    expect(isPlatformTestRecord({ tenantId: 't1', code: 'qa_units', name: 'QA Units' })).toBe(false);
  });
});
