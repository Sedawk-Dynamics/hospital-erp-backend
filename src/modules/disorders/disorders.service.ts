import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { rankIcdResults, queryWords } from '../icd/icd-search-rank';
import { fuzzyDisorderMatchIds } from './disorders.fuzzy';
import type { CreateDisorderInput } from './disorders.validation';

/**
 * The disorder list a patient or clinician picks from.
 *
 * Seeded from the ICD-10 disease chapters and then owned by the super admin —
 * see seeds/disorders.ts for why it is not just the ICD table.
 */

const DISORDER_SELECT = {
  id: true,
  name: true,
  icdCode: true,
  category: true,
  keywords: true,
  searchTokens: true,
  isCustom: true,
  tenantId: true,
} as const;

/** Candidates pulled per window before ranking. */
const SEARCH_WINDOW = 60;

function buildSearchTokens(name: string, code: string | null | undefined, keywords: string[]): string {
  return [name, code ?? '', ...keywords].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Search the platform list plus this hospital's own additions.
 *
 * Runs the same windows-then-rank shape the ICD search does, and reuses its
 * ranker outright: a disorder is a name and an optional code, which is exactly
 * what that scores. Without ranking, "asthma" on a 7,000-row list answers with
 * whatever the alphabet left first.
 */
export async function searchDisorders(tenantId: string, q: string, limit = 20) {
  const term = q.trim().toLowerCase();
  if (!term) return [];

  const visible: Prisma.DisorderWhereInput = {
    isActive: true,
    OR: [{ tenantId: null }, { tenantId }],
  };
  const window = (extra: Prisma.DisorderWhereInput) =>
    prisma.disorder.findMany({
      where: { ...visible, ...extra },
      take: SEARCH_WINDOW,
      orderBy: [{ name: 'asc' }],
      select: DISORDER_SELECT,
    });

  const words = queryWords(term);
  const [byName, byCode, byWords, anywhere] = await Promise.all([
    window({ name: { startsWith: term, mode: 'insensitive' } }),
    window({ icdCode: { startsWith: term, mode: 'insensitive' } }),
    words.length > 1
      ? window({ AND: words.map((w) => ({ searchTokens: { contains: w } })) })
      : Promise.resolve([]),
    window({
      AND: [
        {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { searchTokens: { contains: term } },
          ],
        },
      ],
    }),
  ]);

  // The ranker speaks in code/title; a disorder's name is its title.
  const forRanker = (rows: typeof byName) =>
    rows.map((d) => ({ ...d, code: d.icdCode ?? '', title: d.name }));

  let ranked = rankIcdResults(
    forRanker([...byName, ...byCode, ...byWords, ...anywhere]),
    term,
    limit,
  );

  // Last resort: the query may simply be misspelled. Everything above matches
  // letter for letter, so "asthama" found nothing at all on a 7,200-row list.
  // Only where the alternative is an empty picker.
  if (!ranked.length) {
    const ids = await fuzzyDisorderMatchIds({ query: term, tenantId, limit: SEARCH_WINDOW });
    if (ids.length) {
      const rows = await prisma.disorder.findMany({
        where: { ...visible, id: { in: ids } },
        select: DISORDER_SELECT,
      });
      ranked = rankIcdResults(forRanker(rows), term, limit);
    }
  }

  return ranked.map((d) => ({
    id: d.id,
    name: d.name,
    icdCode: d.icdCode,
    category: d.category,
    isCustom: d.isCustom,
    tenantId: d.tenantId,
  }));
}

/** Super-admin paginated view of the platform list. */
export async function listDisorders(query: {
  q?: string;
  page?: number;
  limit?: number;
  includeInactive?: boolean;
}) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const where: Prisma.DisorderWhereInput = { tenantId: null };
  if (!query.includeInactive) where.isActive = true;
  if (query.q) {
    const term = query.q.trim().toLowerCase();
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { icdCode: { contains: term, mode: 'insensitive' } },
      { searchTokens: { contains: term } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.disorder.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ name: 'asc' }],
    }),
    prisma.disorder.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function createDisorder(userId: string, data: CreateDisorderInput) {
  const keywords = data.keywords ?? [];
  try {
    return await prisma.disorder.create({
      data: {
        tenantId: null,
        name: data.name,
        icdCode: data.icdCode || null,
        category: data.category || null,
        keywords,
        searchTokens: buildSearchTokens(data.name, data.icdCode, keywords),
        // Marks it as the super admin's own, not something the seed produced —
        // which is what makes it safe to remove outright.
        isCustom: true,
        isActive: true,
        createdById: userId,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw AppError.badRequest(`"${data.name}" is already on the list`);
    }
    throw err;
  }
}

/**
 * Remove a disorder from every picker.
 *
 * A SEEDED row is deactivated rather than deleted. The seed adds any name it
 * has not seen, so a hard delete would come straight back on the next boot and
 * deletion would mean nothing. Deactivating is invisible to every picker, which
 * is what "deleted" means to the person clicking it, and it survives re-seeding.
 *
 * A row the super admin added themselves has no seed behind it, so it is
 * removed outright.
 */
export async function deleteDisorder(id: string) {
  const found = await prisma.disorder.findFirst({
    where: { id, tenantId: null },
    select: { id: true, isCustom: true },
  });
  if (!found) throw AppError.notFound('Disorder not found');

  if (found.isCustom) {
    await prisma.disorder.delete({ where: { id } });
    return { removed: true as const };
  }
  await prisma.disorder.update({ where: { id }, data: { isActive: false } });
  return { removed: false as const };
}

/** Put a deactivated disorder back on the list. */
export async function restoreDisorder(id: string) {
  const found = await prisma.disorder.findFirst({ where: { id, tenantId: null }, select: { id: true } });
  if (!found) throw AppError.notFound('Disorder not found');
  return prisma.disorder.update({ where: { id }, data: { isActive: true } });
}
