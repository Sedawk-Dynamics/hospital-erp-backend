import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  searchSnomedConcepts,
  selectedSnomed,
} from '../../../../src/modules/snomed/snomed.service';

describe('SNOMED service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not query for an empty search', async () => {
    await expect(searchSnomedConcepts('   ')).resolves.toEqual([]);
    expect(prisma.snomedDescription.findMany).not.toHaveBeenCalled();
  });

  it('deduplicates synonyms and prefers the canonical name', async () => {
    vi.mocked(prisma.snomedDescription.findMany).mockResolvedValue([
      { conceptId: '44054006', term: 'T2DM', typeId: '900000000000013009' },
      {
        conceptId: '44054006',
        term: 'Diabetes mellitus type 2 (disorder)',
        typeId: '900000000000003001',
      },
      { conceptId: '59621000', term: 'High blood pressure', typeId: '900000000000013009' },
    ] as never);

    const result = await searchSnomedConcepts('diabetes', 10);

    expect(result).toEqual([
      { conceptId: '44054006', term: 'Diabetes mellitus type 2 (disorder)' },
      { conceptId: '59621000', term: 'High blood pressure' },
    ]);
    expect(prisma.snomedDescription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 40 }),
    );
  });

  it('returns all ICD codes for a multi-group mapping without duplicates', async () => {
    vi.mocked(prisma.snomedIcdMap.findMany).mockResolvedValue([
      { mapGroup: 1, mapPriority: 1, mapRule: 'TRUE', mapAdvice: 'ALWAYS E11.3', mapTarget: 'E11.3' },
      { mapGroup: 2, mapPriority: 1, mapRule: 'TRUE', mapAdvice: 'ALWAYS H28', mapTarget: 'H28' },
      { mapGroup: 3, mapPriority: 1, mapRule: 'TRUE', mapAdvice: 'ALWAYS H28', mapTarget: 'H28' },
    ] as never);

    await expect(selectedSnomed('421895002')).resolves.toEqual({
      snomedCode: '421895002',
      status: 'resolved',
      icdCodes: ['E11.3', 'H28'],
    });
  });

  it('returns laterality candidates and the unspecified fallback', async () => {
    vi.mocked(prisma.snomedIcdMap.findMany).mockResolvedValue([
      {
        mapGroup: 1,
        mapPriority: 1,
        mapRule: 'TRUE',
        mapAdvice: 'MAP REQUIRES SPECIFICATION OF LATERALITY | LEFT',
        mapTarget: 'S52.31',
      },
      {
        mapGroup: 1,
        mapPriority: 2,
        mapRule: 'TRUE',
        mapAdvice: 'MAP REQUIRES SPECIFICATION OF LATERALITY | RIGHT',
        mapTarget: 'S52.32',
      },
      {
        mapGroup: 1,
        mapPriority: 3,
        mapRule: 'OTHERWISE TRUE',
        mapAdvice: 'UNSPECIFIED LATERALITY FALLBACK',
        mapTarget: 'S52.30',
      },
    ] as never);

    const result = await selectedSnomed('65966004');

    expect(result).toMatchObject({
      status: 'needs_detail',
      icdCodes: ['S52.30'],
      candidates: [
        { icdCode: 'S52.31', label: 'LEFT' },
        { icdCode: 'S52.32', label: 'RIGHT' },
      ],
    });
  });

  it('uses a conditional rule when context matches and otherwise falls back', async () => {
    vi.mocked(prisma.snomedIcdMap.findMany).mockResolvedValue([
      {
        mapGroup: 1,
        mapPriority: 1,
        mapRule: 'IFA 248152002 | Female |',
        mapAdvice: 'IF FEMALE CHOOSE N39.0',
        mapTarget: 'N39.0',
      },
      {
        mapGroup: 1,
        mapPriority: 2,
        mapRule: 'OTHERWISE TRUE',
        mapAdvice: 'OTHERWISE N39.9',
        mapTarget: 'N39.9',
      },
    ] as never);

    await expect(selectedSnomed('197927001', { gender: 'female' })).resolves.toMatchObject({
      status: 'resolved',
      icdCodes: ['N39.0'],
    });
    await expect(selectedSnomed('197927001', { gender: 'male' })).resolves.toMatchObject({
      status: 'resolved',
      icdCodes: ['N39.9'],
    });
  });

  it('reports concepts with no map rows as unmapped', async () => {
    vi.mocked(prisma.snomedIcdMap.findMany).mockResolvedValue([]);

    await expect(selectedSnomed('300916003')).resolves.toEqual({
      snomedCode: '300916003',
      status: 'unmapped',
      icdCodes: [],
    });
  });
});
