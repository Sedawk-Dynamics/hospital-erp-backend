import { prisma } from "../../config/database";
import { kStringMaxLength } from "buffer";
import { map } from "zod";
import { SnomedSearchResult,PatientMapContext,SnomedMapCandidate,SnomedMapResult } from "./snomed.types";
import { ruleSatisfied,labelFromAdvice } from "./snomed.utils";

const FSN = '900000000000003001'

export const searchSnomedConcepts = async (q: string, limit?: string) => {
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
        take: 70,
        select: { conceptId: true, term: true, typeId: true },
    })

    const result = new Map<string, SnomedSearchResult>()
    for (const r of rows) {
        const existing = result.get(r.conceptId);

        if (!existing) {
            result.set(r.conceptId, { conceptId: r.conceptId, term: r.term });

        } else if (r.typeId === FSN) {
            existing.term = r.term;
        }
    }

    return Array.from(result.values()).slice(0, limit ? parseInt(limit, 10) : undefined);  // unique concepts, capped
}


const NOT_POSSIBLE = 'MAPPING NOT POSSIBLE';
const NEEDS_SPEC = 'REQUIRES SPECIFICATION';


export const selectedSnomed = async (snomedCode: string,ctx?: PatientMapContext): Promise<SnomedMapResult> => {
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
  let candidates: SnomedMapCandidate[] | undefined;
  let needsDetail = false;

  for (const group of groups.values()) {
    const specRows = group.filter((r) => (r.mapAdvice ?? '').toUpperCase().includes(NEEDS_SPEC));
    if (specRows.length) {
      needsDetail = true;
      candidates = specRows
        .filter((r) => r.mapTarget)
        .map((r) => ({ icdCode: r.mapTarget as string, label: labelFromAdvice(r.mapAdvice), advice: r.mapAdvice ?? '' }));
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

  return { snomedCode: snomedCode, status, icdCodes, candidates };
};
