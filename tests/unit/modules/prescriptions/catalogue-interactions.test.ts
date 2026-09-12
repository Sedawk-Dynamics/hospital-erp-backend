import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  catalogueInteractionPairs,
  severityRank,
  type CatalogueHint,
} from '../../../../src/modules/prescriptions/catalogue-interactions';

/**
 * The catalogue carries the vendor's interaction list on 175,216 products.
 * These pin the promises that make it safe to put in front of a prescriber:
 *
 *  - it warns, it never blocks (nothing it produces is 'contraindicated')
 *  - a molecule is matched as a molecule and a brand as a brand, exactly —
 *    a substring rule would pair "Nise" with "Nisoldipine"
 *  - both directions are checked, because only one side usually records it
 */

const MASTERS = [
  {
    id: 'm-ecosprin',
    name: 'Ecosprin 75 Tablet',
    saltsJson: [{ raw: 'Aspirin', norm: 'aspirin' }],
    drugInteractions: { drug: ['Warfarin', 'Methotrexate'], effect: ['Severe', 'Life-threatening'] },
    monograph: { interactions: 11 },
  },
  {
    id: 'm-warf',
    name: 'Warf 5mg Tablet',
    saltsJson: [{ raw: 'Warfarin', norm: 'warfarin' }],
    drugInteractions: null,
    monograph: null,
  },
  {
    id: 'm-dolo',
    name: 'Dolo 650 Tablet',
    saltsJson: [{ raw: 'Paracetamol', norm: 'paracetamol' }],
    // A brand-style entry: the vendor named a product, not a molecule, and
    // left the severity blank.
    drugInteractions: { drug: ['Nise Tablet'], effect: [''] },
    monograph: null,
  },
  {
    id: 'm-nise',
    name: 'Nise Tablet',
    saltsJson: [{ raw: 'Nimesulide', norm: 'nimesulide' }],
    drugInteractions: { drug: ['Tacrolimus'], effect: ['Severe'] },
    monograph: null,
  },
  {
    id: 'm-nisoldipine',
    name: 'Nisoldipine 20mg Tablet',
    saltsJson: [{ raw: 'Nisoldipine', norm: 'nisoldipine' }],
    drugInteractions: null,
    monograph: null,
  },
  {
    id: 'm-zinc',
    name: 'Zincovit Tablet',
    saltsJson: [{ raw: 'Zinc', norm: 'zinc' }],
    drugInteractions: null,
    monograph: null,
  },
];

const byName = (n: string) => MASTERS.find((m) => m.name.toLowerCase() === n.toLowerCase());

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.drugMaster.findMany as any).mockImplementation(({ where }: any) => {
    if (where?.id?.in) return Promise.resolve(MASTERS.filter((m) => where.id.in.includes(m.id)));
    const wanted: string[] = (where?.OR ?? []).map((c: any) => String(c.name.equals).toLowerCase());
    return Promise.resolve(
      MASTERS.filter((m) => wanted.includes(m.name.toLowerCase())).map((m) => ({
        id: m.id,
        name: m.name,
        drugInteractions: m.drugInteractions,
      })),
    );
  });
  (prisma.drugText.findMany as any).mockResolvedValue([
    { id: 11, body: '{{name}} & Warfarin : <p> Watch for bleeding and consult your doctor.' },
  ]);
});

describe('catalogueInteractionPairs', () => {
  it('matches a molecule named on the other product', async () => {
    const pairs = await catalogueInteractionPairs(['Ecosprin 75 Tablet', 'Warf 5mg Tablet']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].drugs).toEqual(['Ecosprin 75 Tablet', 'Warf 5mg Tablet']);
    expect(pairs[0].severity).toBe('major');
    expect(pairs[0].description).toContain('severe interaction with Warfarin');
  });

  it('carries the advice sentence from the monograph', async () => {
    const [pair] = await catalogueInteractionPairs(['Ecosprin 75 Tablet', 'Warf 5mg Tablet']);
    expect(pair.description).toContain('Watch for bleeding and consult your doctor.');
  });

  it('never returns a blocking severity, not even for life-threatening', async () => {
    // 123,412 entries say life-threatening. If those blocked, prescribing stops.
    const pairs = await catalogueInteractionPairs(['Ecosprin 75 Tablet', 'Methotrexate']);
    for (const p of pairs) expect(p.severity).not.toBe('contraindicated');
    expect(pairs[0]?.severity).toBe('major');
    expect(pairs[0]?.description).toContain('life-threatening');
  });

  it('matches a brand-name entry, and rates a blank severity as moderate', async () => {
    const [pair] = await catalogueInteractionPairs(['Dolo 650 Tablet', 'Nise Tablet']);
    expect(pair.severity).toBe('moderate');
    expect(pair.description).toContain('unrated interaction with Nise Tablet');
  });

  it('does not pair a brand with a molecule that merely starts the same way', async () => {
    // "Nise Tablet" must not match Nisoldipine.
    const pairs = await catalogueInteractionPairs(['Dolo 650 Tablet', 'Nisoldipine 20mg Tablet']);
    expect(pairs).toEqual([]);
  });

  it('checks both directions — only one side usually records the pair', async () => {
    // Warf's own list is empty; the pair is only found from Ecosprin's side.
    const reversed = await catalogueInteractionPairs(['Warf 5mg Tablet', 'Ecosprin 75 Tablet']);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].drugs).toEqual(['Warf 5mg Tablet', 'Ecosprin 75 Tablet']);
  });

  it('returns nothing for drugs that do not interact', async () => {
    expect(await catalogueInteractionPairs(['Dolo 650 Tablet', 'Zincovit Tablet'])).toEqual([]);
  });

  it('needs two drugs before it queries anything', async () => {
    expect(await catalogueInteractionPairs(['Dolo 650 Tablet'])).toEqual([]);
    expect(prisma.drugMaster.findMany).not.toHaveBeenCalled();
  });

  it('uses the hospital mapping instead of looking the name up again', async () => {
    const hints = new Map<string, CatalogueHint>([
      ['aspirin 75', { drugMasterId: 'm-ecosprin', drugName: 'Aspirin 75', saltsJson: [{ norm: 'aspirin' }] }],
      ['warfarin sodium', { drugMasterId: 'm-warf', drugName: 'Warfarin Sodium', saltsJson: [{ norm: 'warfarin' }] }],
    ]);
    const pairs = await catalogueInteractionPairs(['Aspirin 75', 'Warfarin Sodium'], hints);
    expect(pairs).toHaveLength(1);
    // The alert names what the caller passed, not the catalogue's spelling.
    expect(pairs[0].drugs).toEqual(['Aspirin 75', 'Warfarin Sodium']);
    // No name lookup was needed — only the fetch by id.
    const calls = (prisma.drugMaster.findMany as any).mock.calls;
    expect(calls.every((c: any[]) => !c[0].where.OR)).toBe(true);
  });

  it('prefers the pack that has the interaction list when a name is duplicated', async () => {
    // Same product, two pack sizes; only one carries the data. Picking the
    // other one silently loses the alert.
    (prisma.drugMaster.findMany as any).mockImplementation(({ where }: any) => {
      if (where?.id?.in) return Promise.resolve(MASTERS.filter((m) => where.id.in.includes(m.id)));
      return Promise.resolve([
        { id: 'm-dolo-empty', name: 'Dolo 650 Tablet', drugInteractions: null },
        { id: 'm-dolo', name: 'Dolo 650 Tablet', drugInteractions: MASTERS[2].drugInteractions },
        { id: 'm-nise', name: 'Nise Tablet', drugInteractions: MASTERS[3].drugInteractions },
      ]);
    });
    const pairs = await catalogueInteractionPairs(['Dolo 650 Tablet', 'Nise Tablet']);
    expect(pairs).toHaveLength(1);
  });

  it('does not pair a drug with itself under two names', async () => {
    const hints = new Map<string, CatalogueHint>([
      ['dolo 650 tablet', { drugMasterId: 'm-dolo', drugName: 'Dolo 650 Tablet', saltsJson: [] }],
      ['dolo 650', { drugMasterId: 'm-dolo', drugName: 'Dolo 650 Tablet', saltsJson: [] }],
    ]);
    expect(await catalogueInteractionPairs(['Dolo 650 Tablet', 'Dolo 650'], hints)).toEqual([]);
  });
});

describe('severityRank', () => {
  it('orders worst first', () => {
    expect(severityRank('contraindicated')).toBeLessThan(severityRank('major'));
    expect(severityRank('major')).toBeLessThan(severityRank('moderate'));
    expect(severityRank('moderate')).toBeLessThan(severityRank('minor'));
  });
});
