import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { buildDrugSearchTokens } from './drug-master.dataset';
import type {
  SearchDrugMasterQuery,
  ListDrugMasterQuery,
  CreateDrugMasterInput,
  UpdateDrugMasterInput,
  SuggestDrugMasterInput,
} from './drug-master.validation';

// Only super_admin authors / edits the platform-wide drug catalog. Hospitals
// consume it read-only (search) and clone rows into their own formulary.
const DRUG_MASTER_WRITER_ROLES = new Set(['super_admin']);

function assertCanManage(roles: string[]): void {
  if (!roles.some((r) => DRUG_MASTER_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only platform administrators can manage the drug catalog');
  }
}

// buildDrugSearchTokens lives in drug-master.dataset.ts (shared with refresh).

// ─────────────────────────────────────────────────────────────
// Search (public to any pharmacy/prescriptions reader)
// ─────────────────────────────────────────────────────────────
export async function searchDrugMaster(query: SearchDrugMasterQuery) {
  const terms = query.q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const where: Prisma.DrugMasterWhereInput = {
    isPublished: true,
    ...(query.includeDiscontinued ? {} : { isDiscontinued: false }),
    // Every term must appear somewhere in the token blob (AND), so
    // "para 500" narrows rather than widens.
    AND: terms.map((term) => ({
      searchTokens: { contains: term, mode: 'insensitive' as const },
    })),
  };

  const drugs = await prisma.drugMaster.findMany({
    where,
    select: {
      id: true,
      name: true,
      genericName: true,
      manufacturer: true,
      dosageForm: true,
      strength: true,
      packSizeLabel: true,
      mrp: true,
      type: true,
      schedule: true,
    },
    take: query.limit ?? 20,
    orderBy: { name: 'asc' },
  });

  return drugs;
}

// ─────────────────────────────────────────────────────────────
// Super-admin management
// ─────────────────────────────────────────────────────────────
export async function listDrugMaster(query: ListDrugMasterQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.DrugMasterWhereInput = {};
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;
  if (!query.includeDiscontinued) where.isDiscontinued = false;
  if (query.search) {
    const term = query.search.toLowerCase().trim();
    where.searchTokens = { contains: term, mode: 'insensitive' };
  }

  const [items, total] = await Promise.all([
    prisma.drugMaster.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
    prisma.drugMaster.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getDrugMasterById(id: string) {
  const drug = await prisma.drugMaster.findUnique({ where: { id } });
  if (!drug) throw AppError.notFound('Drug not found in catalog');
  return drug;
}

export async function createDrugMaster(
  roles: string[],
  userId: string,
  data: CreateDrugMasterInput,
) {
  assertCanManage(roles);

  const aliases = data.aliases ?? [];
  const tags = data.tags ?? [];
  const drug = await prisma.drugMaster.create({
    data: {
      name: data.name,
      genericName: data.genericName ?? null,
      manufacturer: data.manufacturer ?? null,
      type: data.type ?? null,
      dosageForm: (data.dosageForm ?? null) as any,
      strength: data.strength ?? null,
      packSizeLabel: data.packSizeLabel ?? null,
      mrp: data.mrp ?? null,
      isDiscontinued: data.isDiscontinued ?? false,
      schedule: data.schedule ?? null,
      aliases,
      tags,
      searchTokens: buildDrugSearchTokens({
        name: data.name,
        genericName: data.genericName,
        manufacturer: data.manufacturer,
        aliases,
        tags,
      }),
      isPublished: data.isPublished ?? true,
      createdById: userId,
    },
  });

  logger.info({ drugMasterId: drug.id }, 'Drug master entry created');
  return drug;
}

/**
 * G11: a hospital pharmacist suggests a brand that isn't in the national master
 * yet. Unlike createDrugMaster (super-admin only), this is open to any pharmacy
 * user but always lands UNPUBLISHED — it's a pending suggestion that a platform
 * admin reviews and publishes (via updateDrugMaster) before it becomes a live
 * catalogue entry. createdById records the suggesting user for traceability.
 */
export async function suggestDrugMaster(userId: string, data: SuggestDrugMasterInput) {
  const drug = await prisma.drugMaster.create({
    data: {
      name: data.name,
      genericName: data.genericName ?? null,
      manufacturer: data.manufacturer ?? null,
      type: data.type ?? null,
      dosageForm: (data.dosageForm ?? null) as any,
      strength: data.strength ?? null,
      packSizeLabel: data.packSizeLabel ?? null,
      schedule: data.schedule ?? null,
      searchTokens: buildDrugSearchTokens({
        name: data.name,
        genericName: data.genericName,
        manufacturer: data.manufacturer,
        aliases: [],
        tags: [],
      }),
      // Always pending review — never auto-published from a tenant suggestion.
      isPublished: false,
      createdById: userId,
    },
  });
  logger.info({ drugMasterId: drug.id, userId }, 'Drug master suggestion submitted');
  return drug;
}

export async function updateDrugMaster(
  roles: string[],
  id: string,
  data: UpdateDrugMasterInput,
) {
  assertCanManage(roles);

  const existing = await prisma.drugMaster.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Drug not found in catalog');

  const name = data.name ?? existing.name;
  const genericName = data.genericName !== undefined ? data.genericName : existing.genericName;
  const manufacturer =
    data.manufacturer !== undefined ? data.manufacturer : existing.manufacturer;
  const aliases = data.aliases ?? existing.aliases;
  const tags = data.tags ?? existing.tags;

  const drug = await prisma.drugMaster.update({
    where: { id },
    data: {
      name,
      genericName,
      manufacturer,
      type: data.type !== undefined ? data.type : undefined,
      dosageForm: data.dosageForm !== undefined ? (data.dosageForm as any) : undefined,
      strength: data.strength !== undefined ? data.strength : undefined,
      packSizeLabel: data.packSizeLabel !== undefined ? data.packSizeLabel : undefined,
      mrp: data.mrp !== undefined ? data.mrp : undefined,
      isDiscontinued: data.isDiscontinued ?? undefined,
      schedule: data.schedule !== undefined ? data.schedule : undefined,
      aliases: data.aliases ?? undefined,
      tags: data.tags ?? undefined,
      isPublished: data.isPublished ?? undefined,
      searchTokens: buildDrugSearchTokens({ name, genericName, manufacturer, aliases, tags }),
    },
  });

  logger.info({ drugMasterId: drug.id }, 'Drug master entry updated');
  return drug;
}

export async function deleteDrugMaster(roles: string[], id: string) {
  assertCanManage(roles);

  const existing = await prisma.drugMaster.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Drug not found in catalog');

  // FK on DrugFormulary.drugMasterId is optional → set-null on delete, so any
  // hospital rows imported from this entry simply lose their provenance link.
  await prisma.drugMaster.delete({ where: { id } });
  logger.info({ drugMasterId: id }, 'Drug master entry deleted');
  return { id };
}
