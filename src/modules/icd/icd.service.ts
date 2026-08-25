import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import type { IcdCodeInput, UpdateIcdInput } from './icd.validation';
import { rankIcdResults, queryWords } from './icd-search-rank';
import { fuzzyIcdMatchIds } from './icd-fuzzy';

const ICD_WRITER_ROLES = new Set(['super_admin']);

function assertCanManagePlatform(roles: string[]): void {
  if (!roles.some((r) => ICD_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only platform administrators can manage ICD codes');
  }
}

function buildSearchTokens(code: string, title: string, keywords: string[] = []): string {
  return [code, title, ...keywords].join(' ').toLowerCase();
}

const ICD_SEARCH_SELECT = {
  id: true,
  code: true,
  title: true,
  category: true,
  chapter: true,
  isBillable: true,
  isCustom: true,
  tenantId: true,
  keywords: true,
  searchTokens: true,
} as const;

/** Candidates pulled per window before ranking; 20 are returned. */
const ICD_SEARCH_WINDOW = 60;

/**
 * Search ICD codes available to a tenant: the shared platform set (tenantId
 * null) plus the tenant's own custom codes. Matches code, title or keywords.
 *
 * The substring window alone is not enough now that the catalogue is the full
 * WHO release. It is capped, and a plain `contains` puts the obvious answer
 * wherever the alphabet happens to leave it — "pneumonia" returned salmonella
 * and tuberculosis while J18.9 sat 54th. So the code-prefix, title-prefix and
 * exact-keyword matches are fetched as their own windows, guaranteeing the
 * strongest matches survive the cap, and {@link rankIcdResults} then orders the
 * union. Same shape as the drug catalogue search.
 */
export async function searchIcdCodes(tenantId: string, q: string, limit = 20) {
  const term = q.trim().toLowerCase();
  if (!term) return [];

  const visible: Prisma.IcdCodeWhereInput = {
    isActive: true,
    OR: [{ tenantId: null }, { tenantId }],
  };
  const window = (extra: Prisma.IcdCodeWhereInput) =>
    prisma.icdCode.findMany({
      where: { ...visible, ...extra },
      take: ICD_SEARCH_WINDOW,
      orderBy: [{ code: 'asc' }],
      select: ICD_SEARCH_SELECT,
    });

  // Every word present, in any order. The phrase windows above only match text
  // written the way ICD writes it, so "fracture femur" found nothing at all
  // against "Fracture of neck of femur".
  const words = queryWords(term);
  const allWords = (ws: string[]) => window({ AND: ws.map((w) => ({ searchTokens: { contains: w } })) });

  const [byCode, byTitle, byKeyword, anywhere, byWords] = await Promise.all([
    window({ code: { startsWith: term, mode: 'insensitive' } }),
    window({ title: { startsWith: term, mode: 'insensitive' } }),
    window({ keywords: { has: term } }),
    window({
      AND: [
        {
          OR: [
            { code: { contains: term, mode: 'insensitive' } },
            { title: { contains: term, mode: 'insensitive' } },
            { searchTokens: { contains: term } },
          ],
        },
      ],
    }),
    words.length > 1 ? allWords(words) : Promise.resolve([]),
  ]);

  let ranked = rankIcdResults([...byCode, ...byTitle, ...byKeyword, ...anywhere, ...byWords], term, limit);

  // Still nothing, and enough words to spare one: ICD's vocabulary differs from
  // clinical speech by a word more often than it differs by two. "lower back
  // pain" against "Low back pain", "severe chest pain" against "Chest pain on
  // breathing". Dropping each word in turn recovers those; requiring three
  // words to start with keeps it from degenerating into a single-word search.
  //
  // This costs one extra round of queries and only runs where the alternative
  // is showing the doctor "No matching ICD codes".
  if (!ranked.length && words.length > 2) {
    const partial = await Promise.all(
      words.map((_, i) => allWords(words.filter((__, j) => j !== i))),
    );
    ranked = rankIcdResults(partial.flat(), term, limit);
  }

  // Last resort: the query may simply be misspelled. Everything above matches
  // letter for letter, so "diabtes" finds nothing at all — and an empty picker
  // gives the doctor nothing to correct from. Trigram-similar rows are fetched
  // only here, where the alternative is an empty screen, and the ranker scores
  // them in a tier below every literal match, so no working search is disturbed.
  if (!ranked.length) {
    const fuzzyIds = await fuzzyIcdMatchIds({ query: term, tenantId, limit: ICD_SEARCH_WINDOW });
    if (fuzzyIds.length) {
      const fuzzyRows = await prisma.icdCode.findMany({
        where: { ...visible, id: { in: fuzzyIds } },
        select: ICD_SEARCH_SELECT,
      });
      ranked = rankIcdResults(fuzzyRows, term, limit);
    }
  }

  // `keywords` and `searchTokens` are only here to rank with — neither is part
  // of the picker's shape.
  return ranked.map(({ keywords: _keywords, searchTokens: _searchTokens, ...row }) => row);
}

/** Super-admin paginated list of the platform catalog. */
export async function listIcdCodes(query: {
  q?: string;
  category?: string;
  page?: number;
  limit?: number;
  includeInactive?: boolean;
}) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const where: Prisma.IcdCodeWhereInput = { tenantId: null };
  if (!query.includeInactive) where.isActive = true;
  if (query.category) where.category = query.category;
  if (query.q) {
    const term = query.q.trim().toLowerCase();
    where.OR = [
      { code: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { searchTokens: { contains: term } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.icdCode.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ code: 'asc' }],
    }),
    prisma.icdCode.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function createIcdCode(roles: string[], userId: string, data: IcdCodeInput) {
  assertCanManagePlatform(roles);
  try {
    return await prisma.icdCode.create({
      data: {
        tenantId: null,
        code: data.code.trim(),
        title: data.title.trim(),
        category: data.category?.trim(),
        chapter: data.chapter?.trim(),
        isBillable: data.isBillable ?? true,
        keywords: data.keywords ?? [],
        searchTokens: buildSearchTokens(data.code, data.title, data.keywords),
        isCustom: false,
        createdById: userId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`ICD code ${data.code} already exists`);
    }
    throw err;
  }
}

export async function updateIcdCode(roles: string[], id: string, data: UpdateIcdInput) {
  assertCanManagePlatform(roles);
  const existing = await prisma.icdCode.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('ICD code not found');

  const code = data.code?.trim() ?? existing.code;
  const title = data.title?.trim() ?? existing.title;
  const keywords = data.keywords ?? existing.keywords;

  return prisma.icdCode.update({
    where: { id },
    data: {
      code,
      title,
      category: data.category?.trim() ?? existing.category,
      chapter: data.chapter?.trim() ?? existing.chapter,
      isBillable: data.isBillable ?? existing.isBillable,
      isActive: data.isActive ?? existing.isActive,
      keywords,
      searchTokens: buildSearchTokens(code, title, keywords),
    },
  });
}

export async function deleteIcdCode(roles: string[], id: string) {
  assertCanManagePlatform(roles);
  const existing = await prisma.icdCode.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('ICD code not found');
  await prisma.icdCode.delete({ where: { id } });
  return { id };
}

/** Hospital admin adds a tenant-scoped custom code. */
export async function createCustomIcdCode(tenantId: string, userId: string, data: IcdCodeInput) {
  try {
    return await prisma.icdCode.create({
      data: {
        tenantId,
        code: data.code.trim(),
        title: data.title.trim(),
        category: data.category?.trim(),
        chapter: data.chapter?.trim(),
        isBillable: data.isBillable ?? true,
        keywords: data.keywords ?? [],
        searchTokens: buildSearchTokens(data.code, data.title, data.keywords),
        isCustom: true,
        createdById: userId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`ICD code ${data.code} already exists for this hospital`);
    }
    throw err;
  }
}
