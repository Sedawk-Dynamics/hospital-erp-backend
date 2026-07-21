import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

// Personal medicine nicknames. A pharmacist maps their own shorthand ("para",
// "bp med") to a formulary drug; when THAT user types the nickname in any drug
// search, the linked medicine surfaces first. Everything is scoped per
// (tenant, user), so one pharmacist's shorthand never affects another's.

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const drugSelect = {
  id: true,
  drugName: true,
  genericName: true,
  strength: true,
  dosageForm: true,
  manufacturer: true,
} as const;

export async function listNicknames(tenantId: string, userId: string) {
  return prisma.drugNickname.findMany({
    where: { tenantId, userId },
    orderBy: { nickname: 'asc' },
    include: { drug: { select: drugSelect } },
  });
}

export async function createNickname(
  tenantId: string,
  userId: string,
  data: { drugFormularyId: string; nickname: string },
) {
  const nickname = data.nickname.trim();
  const nicknameNorm = norm(nickname);
  if (!nicknameNorm) throw AppError.badRequest('Nickname is required');

  const drug = await prisma.drugFormulary.findFirst({
    where: { id: data.drugFormularyId, tenantId },
    select: { id: true },
  });
  if (!drug) throw AppError.notFound('Medicine not found in your formulary');

  try {
    return await prisma.drugNickname.create({
      data: { tenantId, userId, drugFormularyId: drug.id, nickname, nicknameNorm },
      include: { drug: { select: drugSelect } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`You already use the nickname "${nickname}" — edit or delete it first`);
    }
    throw err;
  }
}

export async function updateNickname(
  tenantId: string,
  userId: string,
  id: string,
  data: { drugFormularyId?: string; nickname?: string },
) {
  const existing = await prisma.drugNickname.findFirst({ where: { id, tenantId, userId } });
  if (!existing) throw AppError.notFound('Nickname not found');

  const patch: Prisma.DrugNicknameUpdateInput = {};
  if (data.nickname !== undefined) {
    const nickname = data.nickname.trim();
    if (!norm(nickname)) throw AppError.badRequest('Nickname is required');
    patch.nickname = nickname;
    patch.nicknameNorm = norm(nickname);
  }
  if (data.drugFormularyId !== undefined) {
    const drug = await prisma.drugFormulary.findFirst({
      where: { id: data.drugFormularyId, tenantId },
      select: { id: true },
    });
    if (!drug) throw AppError.notFound('Medicine not found in your formulary');
    patch.drug = { connect: { id: drug.id } };
  }

  try {
    return await prisma.drugNickname.update({
      where: { id },
      data: patch,
      include: { drug: { select: drugSelect } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('You already use that nickname — pick another');
    }
    throw err;
  }
}

export async function deleteNickname(tenantId: string, userId: string, id: string) {
  const existing = await prisma.drugNickname.findFirst({ where: { id, tenantId, userId } });
  if (!existing) throw AppError.notFound('Nickname not found');
  await prisma.drugNickname.delete({ where: { id } });
  return { id };
}

/**
 * The user's nickname for each of the given drugs → Map<drugId, nickname>. Used
 * to show an existing nickname on a product even when the search matched on the
 * real name (so the shorthand is always visible, not only when it was typed).
 */
export async function getNicknamesForDrugs(
  tenantId: string,
  userId: string | undefined,
  drugIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userId || !drugIds.length) return map;
  const rows = await prisma.drugNickname.findMany({
    where: { tenantId, userId, drugFormularyId: { in: drugIds } },
    select: { drugFormularyId: true, nickname: true },
  });
  for (const r of rows) if (!map.has(r.drugFormularyId)) map.set(r.drugFormularyId, r.nickname);
  return map;
}

/**
 * Nicknames (for THIS user) whose text matches the search term → a map of the
 * linked formulary drugId to the nickname that matched. Used by the drug-search
 * endpoints to surface the linked medicine when its owner types the nickname.
 * Returns an empty map when there's no user, no term, or nothing matches (so
 * callers can no-op cheaply).
 */
export async function resolveNicknameMatches(
  tenantId: string,
  userId: string | undefined,
  search: string | undefined,
): Promise<Map<string, string>> {
  const q = norm(search ?? '');
  const map = new Map<string, string>();
  if (!userId || !q) return map;
  const rows = await prisma.drugNickname.findMany({
    where: { tenantId, userId, nicknameNorm: { contains: q } },
    select: { drugFormularyId: true, nickname: true, nicknameNorm: true },
    take: 10,
  });
  // Exact nickname matches rank above prefix/substring ones.
  rows.sort((a, b) => Number(b.nicknameNorm === q) - Number(a.nicknameNorm === q));
  for (const r of rows) if (!map.has(r.drugFormularyId)) map.set(r.drugFormularyId, r.nickname);
  return map;
}
