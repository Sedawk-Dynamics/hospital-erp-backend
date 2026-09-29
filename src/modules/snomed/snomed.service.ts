import { prisma } from '../../config/database';
import {
  PatientMapContext,
  SnomedMapCandidate,
  SnomedMapResult,
  SnomedSearchResult,
} from './snomed.types';
import { labelFromAdvice, ruleSatisfied } from './snomed.utils';

const FSN = '900000000000003001';

export async function searchSnomedConcepts(q: string, limit = 20): Promise<SnomedSearchResult[]> {
  const search = q.trim().toLowerCase();
  if (!search) return [];

  const rows = await prisma.snomedDescription.findMany({
    where: {
      active: true,
      OR: [
        { searchTokens: { contains: search } },
        { conceptId: { startsWith: search } },
      ],
    },
    // A concept can have several matching synonyms. Read a wider window before
    // deduplicating so a synonym-heavy concept cannot crowd out every result.
    take: Math.min(limit * 4, 200),
    orderBy: [{ conceptId: 'asc' }, { typeId: 'asc' }],
    select: { conceptId: true, term: true, typeId: true },
  });

  const result = new Map<string, SnomedSearchResult>();
  for (const row of rows) {
    const existing = result.get(row.conceptId);

    if (!existing) {
      result.set(row.conceptId, { conceptId: row.conceptId, term: row.term });
    } else if (row.typeId === FSN) {
      // A concept-id search can match every synonym. Prefer the canonical FSN
      // in that case so the same concept always has a stable display name.
      existing.term = row.term;
    }
  }

  return Array.from(result.values()).slice(0, limit);
}


const NOT_POSSIBLE = 'MAPPING NOT POSSIBLE';
const NEEDS_SPEC = 'REQUIRES SPECIFICATION';


export async function selectedSnomed(
  snomedCode: string,
  ctx?: PatientMapContext,
): Promise<SnomedMapResult> {
  const rows = await prisma.snomedIcdMap.findMany({
    where: { referencedComponentId: snomedCode, active: true },
    orderBy: [{ mapGroup: 'asc' }, { mapPriority: 'asc' }],
    select: { mapGroup: true, mapPriority: true, mapRule: true, mapAdvice: true, mapTarget: true },
  });

  if (rows.length === 0) {
    return { snomedCode: snomedCode, status: 'unmapped', icdCodes: [] };
  }

  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const g = groups.get(r.mapGroup) ?? [];
    g.push(r);
    groups.set(r.mapGroup, g);
  }

  const icdCodes: string[] = [];
  const candidates: SnomedMapCandidate[] = [];
  let needsDetail = false;

  for (const group of groups.values()) {
    const specRows = group.filter((r) => (r.mapAdvice ?? '').toUpperCase().includes(NEEDS_SPEC));
    if (specRows.length) {
      needsDetail = true;
      candidates.push(...specRows
        .filter((r) => r.mapTarget)
        .map((r) => ({
          icdCode: r.mapTarget as string,
          label: labelFromAdvice(r.mapAdvice),
          advice: r.mapAdvice ?? '',
        })));
      const fallback = group.find((r) => (r.mapRule ?? '').toUpperCase().includes('OTHERWISE TRUE'));
      if (fallback?.mapTarget) icdCodes.push(fallback.mapTarget);
      continue;
    }

    for (const r of group) {
      const advice = (r.mapAdvice ?? '').toUpperCase();
      if (advice.includes(NOT_POSSIBLE) || !r.mapTarget) break; // unmappable group
      if (ruleSatisfied(r.mapRule, ctx)) {
        icdCodes.push(r.mapTarget);
        break;
      }
    }
  }

  const status: SnomedMapResult['status'] =
    needsDetail ? 'needs_detail' : icdCodes.length ? 'resolved' : 'unmapped';

  return {
    snomedCode,
    status,
    icdCodes: [...new Set(icdCodes)],
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}
