import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateLabTemplateInput,
  UpdateLabTemplateInput,
  ListLabTemplatesQuery,
  CloneOneLabTemplateInput,
  CloneAllLabTemplatesInput,
} from './lab.validation';

// ─────────────────────────────────────────────────────────────
// Role guards
// ─────────────────────────────────────────────────────────────
// Only super_admin manages platform-wide templates; hospital admin (+
// super_admin) can clone them into their own catalog.
const TEMPLATE_WRITER_ROLES = new Set(['super_admin']);
const TEMPLATE_CLONER_ROLES = new Set(['super_admin', 'admin']);

function assertCanWriteTemplates(roles: string[]): void {
  if (!roles.some((r) => TEMPLATE_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only super admins can manage lab test templates.');
  }
}

function assertCanCloneTemplates(roles: string[]): void {
  if (!roles.some((r) => TEMPLATE_CLONER_ROLES.has(r))) {
    throw AppError.forbidden('Only hospital admins can clone lab test templates.');
  }
}

// ─────────────────────────────────────────────────────────────
// Templates CRUD
// ─────────────────────────────────────────────────────────────

export async function listLabTemplates(query: ListLabTemplatesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Record<string, unknown> = {};
  if (query.departmentName) where.departmentName = query.departmentName;
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
      { departmentName: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.labTestTemplate.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { catalogs: true } },
      },
    }),
    prisma.labTestTemplate.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getLabTemplate(id: string) {
  const tpl = await prisma.labTestTemplate.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { catalogs: true } },
    },
  });
  if (!tpl) throw AppError.notFound('Lab test template not found');
  return tpl;
}

export async function createLabTemplate(
  userId: string,
  roles: string[],
  data: CreateLabTemplateInput,
) {
  assertCanWriteTemplates(roles);

  // Name is globally unique — surface a friendlier 409 instead of letting
  // Prisma's P2002 bubble up as a 500.
  const dup = await prisma.labTestTemplate.findUnique({ where: { name: data.name } });
  if (dup) throw AppError.conflict('A template with that name already exists');

  const tpl = await prisma.labTestTemplate.create({
    data: {
      name: data.name,
      code: data.code ?? null,
      departmentName: data.departmentName,
      sampleType: data.sampleType ?? null,
      specimen: data.specimen ?? null,
      instructions: data.instructions ?? null,
      description: data.description ?? null,
      defaultPrice: data.defaultPrice ?? null,
      turnaroundHours: data.turnaroundHours ?? null,
      parameters: data.parameters as unknown as Prisma.InputJsonValue,
      interpretation: data.interpretation ?? null,
      isPublished: data.isPublished,
      version: 1,
      createdById: userId,
    },
  });
  logger.info({ id: tpl.id, name: tpl.name }, 'Lab test template created');
  return tpl;
}

export async function updateLabTemplate(
  roles: string[],
  id: string,
  data: UpdateLabTemplateInput,
) {
  assertCanWriteTemplates(roles);

  const existing = await prisma.labTestTemplate.findUnique({
    where: { id },
    select: { id: true, version: true, name: true },
  });
  if (!existing) throw AppError.notFound('Lab test template not found');

  if (data.name && data.name !== existing.name) {
    const dup = await prisma.labTestTemplate.findFirst({
      where: { name: data.name, id: { not: id } },
    });
    if (dup) throw AppError.conflict('A template with that name already exists');
  }

  // Bump version when parameters or interpretation changes — so hospitals
  // that already cloned can show a "template updated" badge if we want to
  // surface that later.
  const schemaChanged = data.parameters !== undefined || data.interpretation !== undefined;

  const tpl = await prisma.labTestTemplate.update({
    where: { id },
    data: {
      name: data.name,
      code: data.code,
      departmentName: data.departmentName,
      sampleType: data.sampleType,
      specimen: data.specimen,
      instructions: data.instructions,
      description: data.description,
      defaultPrice: data.defaultPrice,
      turnaroundHours: data.turnaroundHours,
      parameters:
        data.parameters !== undefined
          ? (data.parameters as unknown as Prisma.InputJsonValue)
          : undefined,
      interpretation: data.interpretation,
      isPublished: data.isPublished,
      version: schemaChanged ? existing.version + 1 : undefined,
    },
  });
  return tpl;
}

export async function deleteLabTemplate(roles: string[], id: string) {
  assertCanWriteTemplates(roles);

  const cloneCount = await prisma.labTestCatalog.count({ where: { templateId: id } });
  if (cloneCount > 0) {
    throw AppError.conflict(
      `Template has ${cloneCount} hospital clone(s). Unlink them first or unpublish instead.`,
    );
  }
  await prisma.labTestTemplate.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────
// Clone helpers — used by both single-clone and clone-all flows
// ─────────────────────────────────────────────────────────────

async function ensureTenantDepartment(tenantId: string, departmentName: string) {
  const existing = await prisma.labDepartment.findFirst({
    where: { tenantId, name: departmentName },
  });
  if (existing) return existing;
  return prisma.labDepartment.create({
    data: { tenantId, name: departmentName, isActive: true },
  });
}

// Build the LabTestCatalog payload from a template + tenant department.
function buildCatalogDataFromTemplate(
  tenantId: string,
  template: Awaited<ReturnType<typeof prisma.labTestTemplate.findUnique>>,
  departmentId: string,
  overridePrice?: number,
  overrideTurnaroundHours?: number,
) {
  if (!template) throw new Error('template required');
  return {
    tenantId,
    labDepartmentId: departmentId,
    templateId: template.id,
    testName: template.name,
    testCode: template.code,
    description: template.description,
    // Keep the legacy "normalRange" column as a short summary so the existing
    // list/search column has something readable; per-parameter ranges live in
    // parameters[].
    normalRange: null,
    unit: null,
    price: overridePrice ?? template.defaultPrice,
    turnaroundHours: overrideTurnaroundHours ?? template.turnaroundHours,
    sampleType: template.sampleType,
    specimen: template.specimen,
    instructions: template.instructions,
    parameters: template.parameters as Prisma.InputJsonValue,
    interpretation: template.interpretation,
    isActive: true,
  };
}

// ─────────────────────────────────────────────────────────────
// Clone one template into the calling tenant's catalog
// ─────────────────────────────────────────────────────────────

export async function cloneOneLabTemplate(
  tenantId: string,
  roles: string[],
  templateId: string,
  body: CloneOneLabTemplateInput,
) {
  assertCanCloneTemplates(roles);

  const template = await prisma.labTestTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw AppError.notFound('Lab test template not found');
  if (!template.isPublished) throw AppError.badRequest('Template is not published');

  // If this tenant already cloned the same template, hand back the existing
  // catalog row instead of creating a duplicate. Hospitals can use the catalog
  // edit screen to tweak it from there, or re-clone via clone-all with
  // overwriteExisting=true.
  const existing = await prisma.labTestCatalog.findFirst({
    where: { tenantId, templateId: template.id },
    include: { labDepartment: { select: { id: true, name: true } } },
  });
  if (existing) return { catalog: existing, status: 'already_cloned' as const };

  const department = await ensureTenantDepartment(tenantId, template.departmentName);

  const catalog = await prisma.labTestCatalog.create({
    data: buildCatalogDataFromTemplate(
      tenantId,
      template,
      department.id,
      body.overridePrice,
      body.overrideTurnaroundHours,
    ),
    include: { labDepartment: { select: { id: true, name: true } } },
  });

  logger.info({ tenantId, templateId, catalogId: catalog.id }, 'Lab template cloned (single)');
  return { catalog, status: 'created' as const };
}

// ─────────────────────────────────────────────────────────────
// Clone all published templates into the calling tenant's catalog
// ─────────────────────────────────────────────────────────────

export async function cloneAllLabTemplates(
  tenantId: string,
  roles: string[],
  body: CloneAllLabTemplatesInput,
) {
  assertCanCloneTemplates(roles);

  const templates = await prisma.labTestTemplate.findMany({
    where: {
      isPublished: true,
      ...(body.departmentName ? { departmentName: body.departmentName } : {}),
    },
    orderBy: { name: 'asc' },
  });
  if (templates.length === 0) {
    return { created: 0, updated: 0, skipped: 0, total: 0 };
  }

  // Pre-load existing catalog clones keyed by templateId so we don't N+1 in
  // the loop below.
  const existingClones = await prisma.labTestCatalog.findMany({
    where: { tenantId, templateId: { in: templates.map((t) => t.id) } },
    select: { id: true, templateId: true },
  });
  const existingByTemplateId = new Map(existingClones.map((c) => [c.templateId, c.id]));

  // Cache per-tenant department lookups to avoid hammering the DB.
  const deptCache = new Map<string, string>();
  async function deptFor(name: string) {
    const cached = deptCache.get(name);
    if (cached) return cached;
    const dept = await ensureTenantDepartment(tenantId, name);
    deptCache.set(name, dept.id);
    return dept.id;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const departmentId = await deptFor(tpl.departmentName);
    const existingId = existingByTemplateId.get(tpl.id);
    if (existingId) {
      if (!body.overwriteExisting) {
        skipped += 1;
        continue;
      }
      await prisma.labTestCatalog.update({
        where: { id: existingId },
        data: {
          // Re-snapshot the template's schema but leave price untouched —
          // hospitals frequently customise pricing locally and a re-clone
          // shouldn't reset it.
          labDepartmentId: departmentId,
          sampleType: tpl.sampleType,
          specimen: tpl.specimen,
          instructions: tpl.instructions,
          parameters: tpl.parameters as Prisma.InputJsonValue,
          interpretation: tpl.interpretation,
          turnaroundHours: tpl.turnaroundHours ?? undefined,
        },
      });
      updated += 1;
    } else {
      await prisma.labTestCatalog.create({
        data: buildCatalogDataFromTemplate(tenantId, tpl, departmentId),
      });
      created += 1;
    }
  }

  logger.info({ tenantId, created, updated, skipped }, 'Lab templates cloned (bulk)');
  return { created, updated, skipped, total: templates.length };
}
