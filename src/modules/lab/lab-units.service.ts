import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';

// ─────────────────────────────────────────────────────────────
// Lab Unit Groups + Units
// ─────────────────────────────────────────────────────────────
// Two-tier hierarchy finalised in the 2026-05-23 meeting. Super-admin owns
// the global catalogue (tenantId = null); hospital admin can add local
// groups + units (tenantId = req tenant) without polluting the global
// catalogue. List endpoints merge global + tenant so the parameter builder
// shows one unified dropdown.
//
// Role rules:
//   super_admin  → can write global (tenantId = null) and read any tenant
//   admin        → can write tenant-local (tenantId = req tenant)
//   everyone     → can read merged catalogue
// ─────────────────────────────────────────────────────────────

const GLOBAL_WRITER_ROLES = new Set(['super_admin']);
const LOCAL_WRITER_ROLES = new Set(['super_admin', 'admin']);

function canWriteGlobal(roles: string[]): boolean {
  return roles.some((r) => GLOBAL_WRITER_ROLES.has(r));
}
function canWriteLocal(roles: string[]): boolean {
  return roles.some((r) => LOCAL_WRITER_ROLES.has(r));
}

// ─────────────────────────────────────────────────────────────
// Unit Groups
// ─────────────────────────────────────────────────────────────

export async function listUnitGroups(tenantId: string) {
  // Merge global (tenantId null) + tenant-local. UI shows them grouped
  // with a "Hospital" badge for local rows.
  const groups = await prisma.labUnitGroup.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }] },
    include: {
      units: {
        orderBy: [{ isBase: 'desc' }, { sortOrder: 'asc' }, { symbol: 'asc' }],
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return groups;
}

export async function getUnitGroupByCode(tenantId: string, code: string) {
  // Tenant-local override wins over global when both share a code.
  const local = await prisma.labUnitGroup.findFirst({
    where: { tenantId, code },
    include: { units: { orderBy: [{ isBase: 'desc' }, { sortOrder: 'asc' }] } },
  });
  if (local) return local;
  const global = await prisma.labUnitGroup.findFirst({
    where: { tenantId: null, code },
    include: { units: { orderBy: [{ isBase: 'desc' }, { sortOrder: 'asc' }] } },
  });
  if (!global) throw AppError.notFound('Unit group not found');
  return global;
}

type CreateUnitGroupInput = {
  code: string;
  name: string;
  description?: string | null;
  sortOrder?: number;
  isGlobal?: boolean;
};

export async function createUnitGroup(
  tenantId: string,
  roles: string[],
  input: CreateUnitGroupInput,
) {
  // isGlobal flag lets super-admin author at the platform level; admins
  // are always local even if they tried to set it.
  const wantsGlobal = !!input.isGlobal && canWriteGlobal(roles);
  if (!wantsGlobal && !canWriteLocal(roles)) {
    throw AppError.forbidden('Not permitted to create unit groups');
  }
  const scope: { tenantId: string | null } = { tenantId: wantsGlobal ? null : tenantId };

  // Code is unique per scope. Conflict surfaces a 409 instead of P2002.
  const dup = await prisma.labUnitGroup.findFirst({
    where: { ...scope, code: input.code },
  });
  if (dup) throw AppError.conflict('A unit group with this code already exists in this scope');

  const group = await prisma.labUnitGroup.create({
    data: {
      tenantId: scope.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      isSystem: false,
    },
  });
  logger.info({ id: group.id, code: group.code, scope: scope.tenantId ?? 'global' }, 'Lab unit group created');
  return group;
}

type UpdateUnitGroupInput = Partial<Pick<CreateUnitGroupInput, 'name' | 'description' | 'sortOrder'>>;

export async function updateUnitGroup(
  tenantId: string,
  roles: string[],
  id: string,
  input: UpdateUnitGroupInput,
) {
  const existing = await prisma.labUnitGroup.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Unit group not found');

  // Global rows are super-admin-only. Tenant-local rows: admin of the
  // owning tenant or super_admin.
  if (existing.tenantId === null) {
    if (!canWriteGlobal(roles)) throw AppError.forbidden('Only super admins can edit global unit groups');
  } else {
    if (existing.tenantId !== tenantId) throw AppError.forbidden('Cannot edit another tenant\'s unit group');
    if (!canWriteLocal(roles)) throw AppError.forbidden('Not permitted to edit unit groups');
  }

  const updated = await prisma.labUnitGroup.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      sortOrder: input.sortOrder ?? undefined,
    },
  });
  return updated;
}

export async function deleteUnitGroup(tenantId: string, roles: string[], id: string) {
  const existing = await prisma.labUnitGroup.findUnique({
    where: { id },
    include: { _count: { select: { units: true } } },
  });
  if (!existing) throw AppError.notFound('Unit group not found');

  if (existing.tenantId === null) {
    if (!canWriteGlobal(roles)) throw AppError.forbidden('Only super admins can delete global unit groups');
    if (existing.isSystem) throw AppError.badRequest('Cannot delete a system-seeded unit group');
  } else {
    if (existing.tenantId !== tenantId) throw AppError.forbidden('Cannot delete another tenant\'s unit group');
    if (!canWriteLocal(roles)) throw AppError.forbidden('Not permitted to delete unit groups');
  }

  // Cascade deletes the units (Prisma onDelete: Cascade).
  await prisma.labUnitGroup.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────

type CreateUnitInput = {
  unitGroupId: string;
  symbol: string;
  name?: string | null;
  conversionFactor?: number | null;
  isBase?: boolean;
  sortOrder?: number;
};

export async function createUnit(
  tenantId: string,
  roles: string[],
  input: CreateUnitInput,
) {
  const group = await prisma.labUnitGroup.findUnique({ where: { id: input.unitGroupId } });
  if (!group) throw AppError.notFound('Unit group not found');

  // Adding to a global group → super_admin only. Adding to a tenant-local
  // group → admin of the owning tenant (or super_admin).
  if (group.tenantId === null) {
    if (!canWriteGlobal(roles)) throw AppError.forbidden('Only super admins can add units to a global group');
  } else {
    if (group.tenantId !== tenantId) throw AppError.forbidden('Cannot add unit to another tenant\'s group');
    if (!canWriteLocal(roles)) throw AppError.forbidden('Not permitted to add units');
  }

  const dup = await prisma.labUnit.findFirst({
    where: { unitGroupId: input.unitGroupId, symbol: input.symbol },
  });
  if (dup) throw AppError.conflict('A unit with this symbol already exists in the group');

  // Only one base unit per group — auto-flip the previous base if isBase=true.
  if (input.isBase) {
    await prisma.labUnit.updateMany({
      where: { unitGroupId: input.unitGroupId, isBase: true },
      data: { isBase: false },
    });
  }

  const unit = await prisma.labUnit.create({
    data: {
      tenantId: group.tenantId,
      unitGroupId: input.unitGroupId,
      symbol: input.symbol,
      name: input.name ?? null,
      conversionFactor: input.conversionFactor != null ? new Prisma.Decimal(input.conversionFactor) : null,
      isBase: input.isBase ?? false,
      sortOrder: input.sortOrder ?? 0,
      isSystem: false,
    },
  });
  logger.info({ id: unit.id, symbol: unit.symbol, group: group.code }, 'Lab unit created');
  return unit;
}

type UpdateUnitInput = Partial<Pick<CreateUnitInput, 'symbol' | 'name' | 'conversionFactor' | 'isBase' | 'sortOrder'>>;

export async function updateUnit(
  tenantId: string,
  roles: string[],
  id: string,
  input: UpdateUnitInput,
) {
  const existing = await prisma.labUnit.findUnique({
    where: { id },
    include: { unitGroup: true },
  });
  if (!existing) throw AppError.notFound('Unit not found');

  if (existing.unitGroup.tenantId === null) {
    if (!canWriteGlobal(roles)) throw AppError.forbidden('Only super admins can edit a global unit');
  } else {
    if (existing.unitGroup.tenantId !== tenantId) throw AppError.forbidden('Cannot edit another tenant\'s unit');
    if (!canWriteLocal(roles)) throw AppError.forbidden('Not permitted to edit units');
  }

  if (input.symbol && input.symbol !== existing.symbol) {
    const dup = await prisma.labUnit.findFirst({
      where: { unitGroupId: existing.unitGroupId, symbol: input.symbol, id: { not: id } },
    });
    if (dup) throw AppError.conflict('Another unit in this group already uses that symbol');
  }

  if (input.isBase) {
    await prisma.labUnit.updateMany({
      where: { unitGroupId: existing.unitGroupId, isBase: true, id: { not: id } },
      data: { isBase: false },
    });
  }

  const updated = await prisma.labUnit.update({
    where: { id },
    data: {
      symbol: input.symbol ?? undefined,
      name: input.name ?? undefined,
      conversionFactor:
        input.conversionFactor === undefined
          ? undefined
          : input.conversionFactor === null
            ? null
            : new Prisma.Decimal(input.conversionFactor),
      isBase: input.isBase ?? undefined,
      sortOrder: input.sortOrder ?? undefined,
    },
  });
  return updated;
}

export async function deleteUnit(tenantId: string, roles: string[], id: string) {
  const existing = await prisma.labUnit.findUnique({
    where: { id },
    include: { unitGroup: true },
  });
  if (!existing) throw AppError.notFound('Unit not found');

  if (existing.unitGroup.tenantId === null) {
    if (!canWriteGlobal(roles)) throw AppError.forbidden('Only super admins can delete a global unit');
    if (existing.isSystem) throw AppError.badRequest('Cannot delete a system-seeded unit');
  } else {
    if (existing.unitGroup.tenantId !== tenantId) throw AppError.forbidden('Cannot delete another tenant\'s unit');
    if (!canWriteLocal(roles)) throw AppError.forbidden('Not permitted to delete units');
  }

  await prisma.labUnit.delete({ where: { id } });
  return { deleted: true };
}
