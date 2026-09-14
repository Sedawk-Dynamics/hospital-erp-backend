import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  LegacyMatcher,
  mergeReports,
  productFingerprint,
  readManifest,
  textHash,
  upsertProducts,
  type LegacyTarget,
  type ProductDraft,
} from '../../../../src/modules/drug-master/drug-catalog.release';
import { normalizeVendorRow } from '../../../../src/modules/drug-master/drug-catalog.normalize';

const target = (
  id: string,
  name: string,
  manufacturer: string | null,
  packSizeLabel: string | null,
  composition: string | null = null,
): LegacyTarget => ({ id, name, manufacturer, packSizeLabel, composition });

const product = (
  sourceId: string | null,
  name: string,
  manufacturer: string | null,
  packSizeLabel: string | null,
  composition: string | null = null,
) => ({ sourceId, name, manufacturer, packSizeLabel, composition });

describe('LegacyMatcher', () => {
  it('prefers the product whose name, maker and pack all agree', () => {
    const m = new LegacyMatcher([target('old', 'Dolo 650 Tablet', 'Micro Labs Ltd', 'strip of 15 tablets')]);
    m.observe(product('DRS1', 'Dolo 650 Tablet', 'Micro Labs Ltd', 'strip of 10 tablets'));
    m.observe(product('DRS2', 'Dolo 650 Tablet', 'Micro Labs Ltd', 'strip of 15 tablets'));
    expect(m.results().get('old')).toEqual({
      sourceId: 'DRS2',
      tier: 'name+manufacturer+pack',
      sameComposition: false,
    });
  });

  it('matches a name respelt by the new catalogue from the same maker and pack', () => {
    const m = new LegacyMatcher([target('old', 'Dolowin-Plus Tablet', 'Micro Labs Ltd', 'strip of 10 tablets')]);
    m.observe(product('DRS9', 'dOLOwin - Plus Tablet', 'Micro Labs Ltd', 'strip of 10 tablets'));
    expect(m.results().get('old')?.tier).toBe('spelling+manufacturer+pack');
  });

  it('within one tier, prefers the product with the same composition', () => {
    const m = new LegacyMatcher([
      target('old', 'Pan 40 Tablet', 'Alkem', null, 'Pantoprazole (40mg)'),
    ]);
    m.observe(product('DRS1', 'Pan 40 Tablet', 'Alkem', 'strip of 10 tablets', 'Pantoprazole (20mg)'));
    m.observe(product('DRS2', 'Pan 40 Tablet', 'Alkem', 'strip of 15 tablets', 'Pantoprazole (40mg)'));
    expect(m.results().get('old')).toEqual({ sourceId: 'DRS2', tier: 'name+manufacturer', sameComposition: true });
  });

  it('matches on the name alone only when the release lists that name exactly once', () => {
    const once = new LegacyMatcher([target('old', 'Rare Drug Tablet', 'Gone Pharma', null)]);
    once.observe(product('DRS5', 'Rare Drug Tablet', 'New Owner Ltd', 'strip of 10 tablets'));
    expect(once.results().get('old')?.tier).toBe('unique-name');

    const twice = new LegacyMatcher([target('old', 'Common Tablet', 'Gone Pharma', null)]);
    twice.observe(product('DRS6', 'Common Tablet', 'Maker A', null));
    twice.observe(product('DRS7', 'Common Tablet', 'Maker B', null));
    expect(twice.results().has('old')).toBe(false);
  });

  it('leaves a product the new catalogue does not have unmatched', () => {
    const m = new LegacyMatcher([target('old', 'Cipward 250mg Tablet', 'Edward Young Labs', 'strip of 10 tablets')]);
    m.observe(product('DRS1', 'Ciplox 250 Tablet', 'Cipla Ltd', 'strip of 10 tablets'));
    expect(m.results().size).toBe(0);
  });

  it('ignores a product without an id — nothing could point at it', () => {
    const m = new LegacyMatcher([target('old', 'Dolo 650 Tablet', 'Micro Labs Ltd', 'strip of 15 tablets')]);
    m.observe(product(null, 'Dolo 650 Tablet', 'Micro Labs Ltd', 'strip of 15 tablets'));
    expect(m.results().size).toBe(0);
  });
});

describe('mergeReports', () => {
  it("adds a resumed run's audit to what the interrupted run recorded", () => {
    const prior = {
      tiers: { 'name+manufacturer+pack': 300 },
      carried: [{ legacy: 'Dolo 650', product: 'Dolo 650 Tablet', fields: ['gtin'] }],
      unlinked: [{ tenant: 'Green city', drug: 'Cipward 250', legacy: 'Cipward 250mg Tablet' }],
    };
    const merged = mergeReports(prior, {
      tiers: { 'name+manufacturer+pack': 2, 'unique-name': 1 },
      carried: [],
      unlinked: [{ tenant: 'Green city', drug: 'Dolosen', legacy: 'Dolosen 500mg Tablet' }],
    });
    expect(merged.tiers).toEqual({ 'name+manufacturer+pack': 302, 'unique-name': 1 });
    expect(merged.carried).toHaveLength(1);
    expect(merged.unlinked.map((u) => u.drug)).toEqual(['Cipward 250', 'Dolosen']);
  });

  it('starts from nothing when there is no earlier attempt', () => {
    expect(mergeReports(null, { tiers: {}, carried: [], unlinked: [] })).toEqual({
      tiers: {},
      carried: [],
      unlinked: [],
    });
  });
});

describe('fingerprints', () => {
  const base = normalizeVendorRow('drug', {
    'Product ID': 'DRS003256',
    'Product Name': 'Acenac Tablet',
    Marketer: 'Medley Pharmaceuticals',
    Composition: 'Aceclofenac (100mg)',
    'Packaging Detail': 'strip of 10 tablets',
    MRP: '55.78',
  })!;
  const draft = (over: Partial<ProductDraft> = {}): ProductDraft => ({
    product: base,
    monograph: { intro: 1 },
    drugInteractions: null,
    ...over,
  });

  it('is stable for the same row and moves when anything the vendor owns moves', () => {
    expect(productFingerprint(draft())).toBe(productFingerprint(draft()));
    expect(productFingerprint(draft({ product: { ...base, mrp: 60 } }))).not.toBe(productFingerprint(draft()));
    expect(productFingerprint(draft({ monograph: { intro: 2 } }))).not.toBe(productFingerprint(draft()));
  });

  it('hashes a text to 32 hex characters, the same every time', () => {
    expect(textHash('abc')).toMatch(/^[0-9a-f]{32}$/);
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
  });
});

describe('upsertProducts', () => {
  const base = normalizeVendorRow('drug', {
    'Product ID': 'DRS003256',
    'Product Name': 'Acenac Tablet',
    Marketer: 'Medley Pharmaceuticals',
    Composition: 'Aceclofenac (100mg)',
    'Packaging Detail': 'strip of 10 tablets',
    MRP: '55.78',
  })!;

  /** A catalogue holding the product as the last release left it. */
  function fakeDb(existing: Record<string, unknown>) {
    const calls: Record<string, any[]> = {};
    const rec = (name: string, result: unknown) => async (arg: unknown) => {
      (calls[name] ??= []).push(arg);
      return result;
    };
    const db = {
      drugMaster: {
        findMany: rec('drugMaster.findMany', [existing]),
        update: rec('drugMaster.update', {}),
        createMany: rec('drugMaster.createMany', { count: 0 }),
        updateMany: rec('drugMaster.updateMany', { count: 0 }),
      },
      drugSalt: { deleteMany: rec('drugSalt.deleteMany', { count: 0 }) },
      drugFormulary: { updateMany: rec('drugFormulary.updateMany', { count: 0 }) },
    };
    return { db: db as never, calls };
  }
  const was = (over: Record<string, unknown> = {}) => ({
    id: 'm1', sourceId: 'DRS003256', sourceHash: 'the old fingerprint',
    sourceRelease: '2026-06', isDiscontinued: false,
    saltComposition: base.saltComposition, rxRequired: base.rxRequired ?? null,
    aliases: [], tags: [],
    ...over,
  });
  const draft = (over: Partial<typeof base> = {}): ProductDraft => ({
    product: { ...base, ...over },
    monograph: { intro: 1 },
    drugInteractions: null,
  });

  it('re-classifies a drug whose prescription flag flipped, keeping its salts', async () => {
    const { db, calls } = fakeDb(was({ rxRequired: false }));
    await upsertProducts(db, [draft({ rxRequired: true })], '2026-07');

    expect(calls['drugMaster.update'][0].data.classifierVersion).toBeNull();
    expect(calls['drugFormulary.updateMany'][0].data).toEqual({
      classifierVersion: null,
      gstClassifierVersion: null,
    });
    // Same composition, so the stored molecules are still right.
    expect(calls['drugSalt.deleteMany']).toBeUndefined();
  });

  it('keeps the schedule when nothing the classifier reads has changed', async () => {
    const { db, calls } = fakeDb(was());
    await upsertProducts(db, [draft({ mrp: 60 })], '2026-07');

    expect(calls['drugMaster.update'][0].data).not.toHaveProperty('classifierVersion');
    expect(calls['drugFormulary.updateMany']).toBeUndefined();
  });
});

describe('readManifest', () => {
  const dirWith = (manifest: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drug-catalog-'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  };
  const valid = {
    format: 1,
    release: '2026-06',
    builtAt: '2026-09-11T00:00:00+00:00',
    sources: [],
    placeholder: '{{name}}',
    texts: { files: [], count: 0 },
    drugs: { columns: [], files: [], count: 0 },
  };

  it('is null when the image carries no release', () => {
    expect(readManifest(mkdtempSync(path.join(tmpdir(), 'drug-catalog-')))).toBeNull();
  });

  it('reads a release it understands', () => {
    expect(readManifest(dirWith(valid))?.release).toBe('2026-06');
  });

  it('refuses a bundle it cannot read rather than importing it wrong', () => {
    expect(() => readManifest(dirWith({ ...valid, format: 2 }))).toThrow(/format 2/);
    expect(() => readManifest(dirWith({ ...valid, placeholder: '%NAME%' }))).toThrow(/placeholder/);
    expect(() => readManifest(dirWith({ ...valid, release: 'June' }))).toThrow(/YYYY-MM/);
  });
});
