import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { resolveVisitContext } from '../../shared/visit-context';
import {
  formSchemaShape,
  type FormField,
  type FormSchemaJson,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type CreateHospitalFormInput,
  type UpdateHospitalFormInput,
  type CloneTemplateInput,
  type ArchiveFormInput,
  type CreateSubmissionInput,
  type ListTemplatesQuery,
  type ListHospitalFormsQuery,
  type ListSubmissionsQuery,
} from './forms.validation';

// ─────────────────────────────────────────────────────────────
// Role guards
// ─────────────────────────────────────────────────────────────
// `super_admin` is the only role allowed to manage cross-hospital
// templates. `admin` (hospital admin) is the only non-platform role
// allowed to manage hospital forms; other roles get rejected even if
// somebody mis-grants forms:create to them.
const TEMPLATE_WRITER_ROLES = new Set(['super_admin']);
const HOSPITAL_FORM_WRITER_ROLES = new Set(['admin', 'super_admin']);

function assertCanWriteTemplates(roles: string[]): void {
  if (!roles.some((r) => TEMPLATE_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only super admins can manage form templates.');
  }
}

function assertCanManageHospitalForms(roles: string[]): void {
  if (!roles.some((r) => HOSPITAL_FORM_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only hospital admins can manage forms.');
  }
}

// ─────────────────────────────────────────────────────────────
// Submission validation — re-checks the field shape against the
// form's published schema so a malicious client can't slip in an
// extra "approved=true" key or skip required fields.
// ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asFormSchema(raw: unknown): FormSchemaJson {
  // Schema rows on FormTemplate / HospitalForm are Json; re-parse
  // before use so corruption (or a manual SQL edit) surfaces here.
  return formSchemaShape.parse(raw);
}

function coerceFieldValue(field: FormField, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') {
    if (field.required) {
      throw AppError.badRequest(`Field "${field.label}" is required`);
    }
    return null;
  }
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const s = String(raw);
      const max = (field as { maxLength?: number | null }).maxLength;
      if (max && s.length > max) {
        throw AppError.badRequest(`Field "${field.label}" exceeds max length of ${max}`);
      }
      return s;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw AppError.badRequest(`Field "${field.label}" must be a number`);
      const min = (field as { min?: number | null }).min;
      const max = (field as { max?: number | null }).max;
      if (min != null && n < min) throw AppError.badRequest(`Field "${field.label}" must be ≥ ${min}`);
      if (max != null && n > max) throw AppError.badRequest(`Field "${field.label}" must be ≤ ${max}`);
      return n;
    }
    case 'date':
    case 'datetime': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) {
        throw AppError.badRequest(`Field "${field.label}" must be a valid date`);
      }
      return d.toISOString();
    }
    case 'select':
    case 'radio': {
      const allowed = new Set(field.options.map((o) => o.value));
      const v = String(raw);
      if (!allowed.has(v)) throw AppError.badRequest(`Field "${field.label}" has invalid option`);
      return v;
    }
    case 'multiselect': {
      const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const allowed = new Set(field.options.map((o) => o.value));
      for (const v of arr) {
        if (!allowed.has(v)) throw AppError.badRequest(`Field "${field.label}" has invalid option "${v}"`);
      }
      return arr;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      throw AppError.badRequest(`Field "${field.label}" must be a boolean`);
    }
    case 'section':
    case 'divider':
      return null; // layout-only; never persisted
  }
}

function validateAndNormalizeSubmissionData(
  schema: FormSchemaJson,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(raw)) throw AppError.badRequest('Submission data must be an object');
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.type === 'section' || field.type === 'divider') continue;
    out[field.key] = coerceFieldValue(field, raw[field.key]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Templates (super-admin)
// ─────────────────────────────────────────────────────────────

export async function listTemplates(query: ListTemplatesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Record<string, unknown> = {};
  if (query.category) where.category = query.category;
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;

  const [items, total] = await Promise.all([
    prisma.formTemplate.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { hospitalForms: true } },
      },
    }),
    prisma.formTemplate.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getTemplate(id: string) {
  const tpl = await prisma.formTemplate.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { hospitalForms: true } },
    },
  });
  if (!tpl) throw AppError.notFound('Form template not found');
  return tpl;
}

export async function createTemplate(userId: string, roles: string[], data: CreateTemplateInput) {
  assertCanWriteTemplates(roles);
  const tpl = await prisma.formTemplate.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      category: data.category,
      schema: data.schema,
      isPublished: data.isPublished,
      version: 1,
      createdById: userId,
    },
  });
  logger.info({ id: tpl.id, name: tpl.name }, 'Form template created');
  return tpl;
}

export async function updateTemplate(
  roles: string[],
  id: string,
  data: UpdateTemplateInput,
) {
  assertCanWriteTemplates(roles);
  const existing = await prisma.formTemplate.findUnique({ where: { id }, select: { version: true } });
  if (!existing) throw AppError.notFound('Form template not found');
  const tpl = await prisma.formTemplate.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      category: data.category,
      schema: data.schema,
      isPublished: data.isPublished,
      // Bump version when schema changes so hospitals that cloned earlier
      // versions can show "template updated" badges if we want that later.
      version: data.schema ? existing.version + 1 : undefined,
    },
  });
  return tpl;
}

export async function deleteTemplate(roles: string[], id: string) {
  assertCanWriteTemplates(roles);
  const cloneCount = await prisma.hospitalForm.count({ where: { templateId: id } });
  if (cloneCount > 0) {
    throw AppError.conflict(
      `Template has ${cloneCount} hospital clone(s). Unlink them first or archive instead.`,
    );
  }
  await prisma.formTemplate.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────
// Hospital forms
// ─────────────────────────────────────────────────────────────

export async function listHospitalForms(tenantId: string, query: ListHospitalFormsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Record<string, unknown> = { tenantId };
  if (query.status === 'active') where.archivedAt = null;
  else if (query.status === 'archived') where.archivedAt = { not: null };
  if (query.category) where.category = query.category;
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;

  const [items, total] = await Promise.all([
    prisma.hospitalForm.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        archivedBy: { select: { id: true, firstName: true, lastName: true } },
        template: { select: { id: true, name: true } },
        _count: { select: { submissions: true } },
      },
    }),
    prisma.hospitalForm.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getHospitalForm(tenantId: string, id: string) {
  const form = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    include: {
      createdBy: { select: { id: true, firstName: true, lastName: true } },
      archivedBy: { select: { id: true, firstName: true, lastName: true } },
      template: { select: { id: true, name: true } },
      _count: { select: { submissions: true } },
    },
  });
  if (!form) throw AppError.notFound('Form not found');
  return form;
}

export async function createHospitalForm(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateHospitalFormInput,
) {
  assertCanManageHospitalForms(roles);
  const form = await prisma.hospitalForm.create({
    data: {
      tenantId,
      name: data.name,
      description: data.description ?? null,
      category: data.category,
      schema: data.schema,
      isPublished: data.isPublished,
      version: 1,
      createdById: userId,
    },
  });
  logger.info({ id: form.id, tenantId, name: form.name }, 'Hospital form created');
  return form;
}

export async function updateHospitalForm(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateHospitalFormInput,
) {
  assertCanManageHospitalForms(roles);
  const existing = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    select: { id: true, version: true, archivedAt: true },
  });
  if (!existing) throw AppError.notFound('Form not found');
  if (existing.archivedAt) {
    throw AppError.badRequest('Cannot edit an archived form. Restore it first.');
  }
  return prisma.hospitalForm.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      category: data.category,
      schema: data.schema,
      isPublished: data.isPublished,
      version: data.schema ? existing.version + 1 : undefined,
    },
  });
}

export async function cloneTemplateToHospital(
  tenantId: string,
  userId: string,
  roles: string[],
  templateId: string,
  data: CloneTemplateInput,
) {
  assertCanManageHospitalForms(roles);
  const tpl = await prisma.formTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) throw AppError.notFound('Template not found');
  if (!tpl.isPublished) {
    throw AppError.badRequest('Template is not published yet');
  }
  // Snapshot: store the template's current schema as the new hospital form's
  // schema (deep copy via JSON round-trip). Future template edits do not
  // retroactively change the cloned form.
  const schemaSnapshot = JSON.parse(JSON.stringify(tpl.schema));
  return prisma.hospitalForm.create({
    data: {
      tenantId,
      templateId: tpl.id,
      name: data.name?.trim() || `${tpl.name} (cloned)`,
      description: tpl.description,
      category: tpl.category,
      schema: schemaSnapshot,
      isPublished: true,
      version: 1,
      createdById: userId,
    },
  });
}

export async function archiveHospitalForm(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: ArchiveFormInput,
) {
  assertCanManageHospitalForms(roles);
  const existing = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    select: { id: true, archivedAt: true },
  });
  if (!existing) throw AppError.notFound('Form not found');
  if (existing.archivedAt) throw AppError.badRequest('Form is already archived');
  return prisma.hospitalForm.update({
    where: { id },
    data: {
      archivedAt: new Date(),
      archivedById: userId,
      archiveReason: data.reason ?? null,
    },
  });
}

export async function restoreHospitalForm(
  tenantId: string,
  roles: string[],
  id: string,
) {
  assertCanManageHospitalForms(roles);
  const existing = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    select: { id: true, archivedAt: true },
  });
  if (!existing) throw AppError.notFound('Form not found');
  if (!existing.archivedAt) throw AppError.badRequest('Form is not archived');
  return prisma.hospitalForm.update({
    where: { id },
    data: { archivedAt: null, archivedById: null, archiveReason: null },
  });
}

// ─────────────────────────────────────────────────────────────
// Submissions
// ─────────────────────────────────────────────────────────────

export async function createSubmission(
  tenantId: string,
  userId: string,
  formId: string,
  body: CreateSubmissionInput,
) {
  const form = await prisma.hospitalForm.findFirst({
    where: { id: formId, tenantId },
    select: {
      id: true,
      tenantId: true,
      schema: true,
      version: true,
      isPublished: true,
      archivedAt: true,
    },
  });
  if (!form) throw AppError.notFound('Form not found');
  if (form.archivedAt) throw AppError.badRequest('This form has been archived and is no longer accepting submissions');
  if (!form.isPublished) throw AppError.badRequest('This form is a draft and is not accepting submissions');

  const ctx = await resolveVisitContext(tenantId, body.patientId, {
    visitId: body.visitId,
    admissionId: body.admissionId,
    appointmentId: body.appointmentId,
  });

  const schema = asFormSchema(form.schema);
  const normalized = validateAndNormalizeSubmissionData(schema, body.data);

  // formSnapshot = deep copy of the form's current schema. Renderers use
  // this when displaying old submissions so a later admin edit can't
  // misrepresent what the nurse actually saw.
  const snapshot = JSON.parse(JSON.stringify(form.schema));

  const submission = await prisma.hospitalFormSubmission.create({
    data: {
      tenantId,
      formId: form.id,
      formVersion: form.version,
      formSnapshot: snapshot,
      patientId: body.patientId,
      visitId: ctx.visitId,
      admissionId: ctx.admissionId ?? null,
      appointmentId: ctx.appointmentId ?? null,
      submittedById: userId,
      data: normalized as Prisma.InputJsonValue,
    },
    include: {
      submittedBy: { select: { id: true, firstName: true, lastName: true } },
      form: { select: { id: true, name: true, category: true } },
    },
  });
  logger.info({ id: submission.id, formId: form.id, patientId: body.patientId }, 'Form submission saved');
  return submission;
}

export async function listSubmissions(tenantId: string, query: ListSubmissionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Record<string, unknown> = { tenantId };
  if (query.patientId) where.patientId = query.patientId;
  if (query.formId) where.formId = query.formId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.admissionId) where.admissionId = query.admissionId;

  const [items, total] = await Promise.all([
    prisma.hospitalFormSubmission.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true } },
        form: { select: { id: true, name: true, category: true, archivedAt: true } },
      },
    }),
    prisma.hospitalFormSubmission.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getSubmission(tenantId: string, id: string) {
  const submission = await prisma.hospitalFormSubmission.findFirst({
    where: { id, tenantId },
    include: {
      submittedBy: { select: { id: true, firstName: true, lastName: true } },
      form: { select: { id: true, name: true, category: true, archivedAt: true } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });
  if (!submission) throw AppError.notFound('Submission not found');
  return submission;
}
