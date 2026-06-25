import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import type { IcdCodeInput, UpdateIcdInput } from './icd.validation';

const ICD_WRITER_ROLES = new Set(['super_admin']);

function assertCanManagePlatform(roles: string[]): void {
  if (!roles.some((r) => ICD_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only platform administrators can manage ICD codes');
  }
}

function buildSearchTokens(code: string, title: string, keywords: string[] = []): string {
  return [code, title, ...keywords].join(' ').toLowerCase();
}

/**
 * Search ICD codes available to a tenant: the shared platform set (tenantId
 * null) plus the tenant's own custom codes. Matches code, title or keywords.
 */
export async function searchIcdCodes(tenantId: string, q: string, limit = 20) {
  const term = q.trim().toLowerCase();
  const where: Prisma.IcdCodeWhereInput = {
    isActive: true,
    OR: [{ tenantId: null }, { tenantId }],
    AND: [
      {
        OR: [
          { code: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { searchTokens: { contains: term } },
          { keywords: { has: term } },
        ],
      },
    ],
  };

  return prisma.icdCode.findMany({
    where,
    take: limit,
    // Exact/prefix code matches first, then alphabetical by code.
    orderBy: [{ code: 'asc' }],
    select: {
      id: true,
      code: true,
      title: true,
      category: true,
      chapter: true,
      isBillable: true,
      isCustom: true,
      tenantId: true,
    },
  });
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
