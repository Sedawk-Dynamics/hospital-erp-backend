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
  ParameterSpec,
} from './lab.validation';

// ─────────────────────────────────────────────────────────────
// Search tokens
// ─────────────────────────────────────────────────────────────
// Single lowercase string that concatenates everything searchable about a
// test: name, code, aliases, tags, parameter names + codes, department,
// sample type. Persisted on LabTestTemplate.searchTokens and
// LabTestCatalog.searchTokens so the dynamic-search endpoint can match
// "hemoglobin" → CBC even though "hemoglobin" only appears inside the
// parameter list.
//
// Exported so the catalog (lab.service.ts) can reuse the same shape — keep
// these two columns in sync.
export function buildSearchTokens(input: {
  name?: string | null;
  code?: string | null;
  departmentName?: string | null;
  sampleType?: string | null;
  aliases?: string[] | null;
  tags?: string[] | null;
  parameters?: ParameterSpec[] | null;
}): string {
  const tokens: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    tokens.push(String(s).toLowerCase().trim());
  };
  push(input.name);
  push(input.code);
  push(input.departmentName);
  push(input.sampleType);
  (input.aliases ?? []).forEach(push);
  (input.tags ?? []).forEach(push);
  (input.parameters ?? []).forEach((p) => {
    push(p.name);
    push(p.code);
    push(p.group);
  });
  // Dedupe + collapse whitespace; pipe-separator keeps tokens distinct so a
  // search for "blood" doesn't accidentally match "bloodgroup".
  return Array.from(new Set(tokens.filter(Boolean))).join(' | ');
}

// Normalise the alias/tag arrays the same way for both templates + catalogs.
export function normaliseAliases(aliases?: string[] | null): string[] {
  if (!aliases?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const v = String(raw).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function normaliseTags(tags?: string[] | null): string[] {
  if (!tags?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const v = String(raw).trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

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
    const q = query.search;
    // Match name/code/department directly AND the denormalised searchTokens
    // column so a search for "FBC" or "hemoglobin" hits the right test
    // even when those strings only live in aliases/tags/parameter names.
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
      { departmentName: { contains: q, mode: 'insensitive' } },
      { searchTokens: { contains: q.toLowerCase() } },
      { aliases: { has: q } },
      { tags: { has: q.toLowerCase() } },
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

  const aliases = normaliseAliases(data.aliases);
  const tags = normaliseTags(data.tags);
  const searchTokens = buildSearchTokens({
    name: data.name,
    code: data.code,
    departmentName: data.departmentName,
    sampleType: data.sampleType,
    aliases,
    tags,
    parameters: data.parameters,
  });

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
      aliases,
      tags,
      searchTokens,
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

  // searchTokens recompute whenever any field that contributes to it
  // changes. Fall back to the existing row's values for fields the caller
  // didn't supply so we don't accidentally blow away the alias/tag list.
  const fullExisting = await prisma.labTestTemplate.findUnique({ where: { id } });
  const aliases =
    data.aliases !== undefined ? normaliseAliases(data.aliases) : fullExisting?.aliases ?? [];
  const tags = data.tags !== undefined ? normaliseTags(data.tags) : fullExisting?.tags ?? [];
  const nextParameters =
    data.parameters !== undefined ? data.parameters : (fullExisting?.parameters as ParameterSpec[] | null);
  const searchTokens = buildSearchTokens({
    name: data.name ?? fullExisting?.name ?? null,
    code: data.code ?? fullExisting?.code ?? null,
    departmentName: data.departmentName ?? fullExisting?.departmentName ?? null,
    sampleType: data.sampleType ?? fullExisting?.sampleType ?? null,
    aliases,
    tags,
    parameters: nextParameters,
  });

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
      aliases: data.aliases !== undefined ? aliases : undefined,
      tags: data.tags !== undefined ? tags : undefined,
      searchTokens,
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
  const aliases = template.aliases ?? [];
  const tags = template.tags ?? [];
  const params = template.parameters as unknown as ParameterSpec[] | null;
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
    aliases,
    tags,
    searchTokens: buildSearchTokens({
      name: template.name,
      code: template.code,
      departmentName: template.departmentName,
      sampleType: template.sampleType,
      aliases,
      tags,
      parameters: params,
    }),
    isCustom: false,
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
      const aliases = tpl.aliases ?? [];
      const tags = tpl.tags ?? [];
      const params = tpl.parameters as unknown as ParameterSpec[] | null;
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
          aliases,
          tags,
          searchTokens: buildSearchTokens({
            name: tpl.name,
            code: tpl.code,
            departmentName: tpl.departmentName,
            sampleType: tpl.sampleType,
            aliases,
            tags,
            parameters: params,
          }),
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
