import { Prisma } from '@prisma/client';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { resolveVisitContext } from '../../shared/visit-context';
import {
  formSchemaShape,
  DURATION_UNITS,
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
    // A measurement (`number_unit`) is coerced exactly like a plain number —
    // the unit lives on the field definition, not on the answer, so there is
    // nothing extra to validate here and the stored value stays a bare number.
    case 'number':
    case 'number_unit': {
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
    case 'time': {
      // "HH:mm", 24-hour. Stored as the literal string: a clock time has no
      // day, and coercing it to a Date would invent one.
      const t = String(raw).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        throw AppError.badRequest(`Field "${field.label}" must be a time in HH:mm`);
      }
      return t;
    }
    case 'yesno': {
      // Tri-state. The empty cases were already returned above, so anything
      // arriving here is a real answer.
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'yes' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 'no' || raw === 0 || raw === '0') return false;
      throw AppError.badRequest(`Field "${field.label}" must be Yes or No`);
    }
    case 'text_duration': {
      if (!isPlainObject(raw)) {
        throw AppError.badRequest(`Field "${field.label}" must have a value and a duration`);
      }
      const text = raw.text === undefined || raw.text === null ? null : String(raw.text);
      const max = field.maxLength;
      if (max && text && text.length > max) {
        throw AppError.badRequest(`Field "${field.label}" exceeds max length of ${max}`);
      }
      const rawDuration = raw.duration;
      let duration: number | null = null;
      if (rawDuration !== undefined && rawDuration !== null && rawDuration !== '') {
        const n = Number(rawDuration);
        if (!Number.isFinite(n) || n < 0) {
          throw AppError.badRequest(`Field "${field.label}" duration must be a positive number`);
        }
        duration = n;
      }
      const allowed = field.durationUnits?.length ? field.durationUnits : DURATION_UNITS;
      const unit = raw.unit === undefined || raw.unit === null
        ? field.defaultDurationUnit
        : String(raw.unit);
      if (!(allowed as readonly string[]).includes(unit)) {
        throw AppError.badRequest(`Field "${field.label}" has an invalid duration unit`);
      }
      // Required means the text half is answered — a duration on its own says
      // nothing, and a symptom without one is still a usable record.
      if (field.required && !text) {
        throw AppError.badRequest(`Field "${field.label}" is required`);
      }
      return { text, duration, unit };
    }
    case 'number_date': {
      if (!isPlainObject(raw)) {
        throw AppError.badRequest(`Field "${field.label}" must have a value and a date`);
      }
      const rawValue = raw.value;
      let value: number | null = null;
      if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        const n = Number(rawValue);
        if (!Number.isFinite(n)) {
          throw AppError.badRequest(`Field "${field.label}" must be a number`);
        }
        if (field.min != null && n < field.min) {
          throw AppError.badRequest(`Field "${field.label}" must be ≥ ${field.min}`);
        }
        if (field.max != null && n > field.max) {
          throw AppError.badRequest(`Field "${field.label}" must be ≤ ${field.max}`);
        }
        value = n;
      }
      let date: string | null = null;
      if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
        const d = new Date(String(raw.date));
        if (Number.isNaN(d.getTime())) {
          throw AppError.badRequest(`Field "${field.label}" must have a valid date`);
        }
        date = d.toISOString();
      }
      // The reading is the point of the field; the date qualifies it.
      if (field.required && value === null) {
        throw AppError.badRequest(`Field "${field.label}" is required`);
      }
      return { value, date };
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
//
// Gap 304 — draft vs published.
//   • `schema` is what nurses fill. Before the first publish it is simply the
//     working copy (nobody but the admin can see an unpublished form).
//   • Once published, `schema` is frozen as the nurse-visible snapshot. Admin
//     edits land in `draftSchema` and stay invisible to nurses.
//   • Publishing copies the draft into `schema`, bumps `version`, records who
//     and when, and clears the draft. Discarding just clears the draft.
// Name / description / category are catalogue metadata and apply immediately;
// only the field schema is versioned.

export type HospitalFormStatus = 'draft' | 'published' | 'published_with_changes' | 'archived';

export const HOSPITAL_FORM_STATUS_LABEL: Record<HospitalFormStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  published_with_changes: 'Published · unpublished changes',
  archived: 'Archived',
};

interface FormStateLike {
  isPublished: boolean;
  version: number;
  draftSchema?: unknown;
  archivedAt?: Date | string | null;
}

/**
 * The one status both the forms list and the builder show. Derived on the
 * server so the two screens can never disagree again.
 */
export function deriveHospitalFormStatus(form: FormStateLike): HospitalFormStatus {
  if (form.archivedAt) return 'archived';
  if (!form.isPublished) return 'draft';
  return form.draftSchema != null ? 'published_with_changes' : 'published';
}

/**
 * Shape a form for the response. Managers get the draft too; everyone else
 * (nurses, doctors) only ever sees the published snapshot.
 */
export function presentHospitalForm<T extends FormStateLike>(form: T, canManage: boolean) {
  const status = deriveHospitalFormStatus(form);
  const out: { [key: string]: unknown } = {
    ...(form as object),
    status,
    statusLabel: HOSPITAL_FORM_STATUS_LABEL[status],
    hasUnpublishedChanges: form.isPublished && form.draftSchema != null,
    publishedVersion: form.isPublished ? form.version : null,
  };
  if (!canManage) delete out.draftSchema;
  return out as unknown as T & {
    status: HospitalFormStatus;
    statusLabel: string;
    hasUnpublishedChanges: boolean;
    publishedVersion: number | null;
  };
}

function canManageHospitalForms(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => HOSPITAL_FORM_WRITER_ROLES.has(r));
}

/** Key-order-independent JSON (Postgres jsonb does not keep key order). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function sameSchema(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const HOSPITAL_FORM_INCLUDE = {
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  archivedBy: { select: { id: true, firstName: true, lastName: true } },
  template: { select: { id: true, name: true } },
  _count: { select: { submissions: true } },
} as const;

export async function listHospitalForms(
  tenantId: string,
  query: ListHospitalFormsQuery,
  roles: string[] = [],
) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const canManage = canManageHospitalForms(roles);
  const where: Record<string, unknown> = { tenantId };
  if (query.status === 'active') where.archivedAt = null;
  else if (query.status === 'archived') where.archivedAt = { not: null };
  if (query.category) where.category = query.category;
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;
  // Nurses / doctors are never offered a form that has not been published.
  if (!canManage) where.isPublished = true;

  const [items, total] = await Promise.all([
    prisma.hospitalForm.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      include: HOSPITAL_FORM_INCLUDE,
    }),
    prisma.hospitalForm.count({ where }),
  ]);
  return { items: items.map((f) => presentHospitalForm(f, canManage)), total, page, limit };
}

export async function getHospitalForm(tenantId: string, id: string, roles: string[] = []) {
  const canManage = canManageHospitalForms(roles);
  const form = await prisma.hospitalForm.findFirst({
    where: canManage ? { id, tenantId } : { id, tenantId, isPublished: true },
    include: HOSPITAL_FORM_INCLUDE,
  });
  if (!form) throw AppError.notFound('Form not found');
  return presentHospitalForm(form, canManage);
}

/**
 * The version number a publish should carry. A republish bumps it. A first
 * publish keeps the form's version unless submissions already claim it (a
 * legacy form that was live once, then unpublished) — two different schemas
 * must never share a version number.
 */
async function nextPublishVersion(formId: string, current: { isPublished: boolean; version: number }) {
  if (current.isPublished) return current.version + 1;
  const agg = await prisma.hospitalFormSubmission.aggregate({
    where: { formId },
    _max: { formVersion: true },
  });
  const maxSubmitted = agg?._max?.formVersion ?? 0;
  return Math.max(current.version, maxSubmitted + 1);
}

export async function createHospitalForm(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CreateHospitalFormInput,
) {
  assertCanManageHospitalForms(roles);
  const publish = data.isPublished;
  const form = await prisma.hospitalForm.create({
    data: {
      tenantId,
      name: data.name,
      description: data.description ?? null,
      category: data.category,
      schema: data.schema,
      isPublished: publish,
      version: 1,
      createdById: userId,
      publishedAt: publish ? new Date() : null,
      publishedById: publish ? userId : null,
    },
  });
  logger.info({ id: form.id, tenantId, name: form.name, published: publish }, 'Hospital form created');
  return presentHospitalForm(form, true);
}

export async function updateHospitalForm(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateHospitalFormInput,
  userId?: string,
) {
  assertCanManageHospitalForms(roles);
  const existing = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    select: { id: true, version: true, archivedAt: true, isPublished: true, schema: true, draftSchema: true },
  });
  if (!existing) throw AppError.notFound('Form not found');
  if (existing.archivedAt) {
    throw AppError.badRequest('Cannot edit an archived form. Restore it first.');
  }
  if (data.isPublished === false && existing.isPublished) {
    // Un-publishing would pull a live form out from under the ward. Archive is
    // the way to withdraw it; Discard draft is the way to drop pending edits.
    throw AppError.badRequest(
      'A published form cannot be turned back into a draft. Archive it to withdraw it, or discard the unpublished changes.',
    );
  }

  const patch: Prisma.HospitalFormUpdateInput = {
    name: data.name,
    description: data.description,
    category: data.category,
  };

  // Where the edited schema goes: a never-published form edits its working
  // copy; a published form keeps `schema` (what nurses see) untouched and
  // collects the edit as a draft. A draft identical to what is live is no
  // draft at all.
  let workingSchema: unknown = existing.draftSchema ?? existing.schema;
  if (data.schema !== undefined) {
    workingSchema = data.schema;
    if (!existing.isPublished) {
      patch.schema = data.schema;
    } else {
      patch.draftSchema = sameSchema(data.schema, existing.schema)
        ? Prisma.DbNull
        : (data.schema as Prisma.InputJsonValue);
    }
  }

  if (data.isPublished === true) {
    const hasChanges = !existing.isPublished || !sameSchema(workingSchema, existing.schema);
    if (hasChanges) {
      patch.schema = workingSchema as Prisma.InputJsonValue;
      patch.draftSchema = Prisma.DbNull;
      patch.isPublished = true;
      patch.version = await nextPublishVersion(existing.id, existing);
      patch.publishedAt = new Date();
      patch.publishedById = userId ?? null;
    } else {
      // Already live and nothing pending — publishing again is a no-op, not
      // a new version.
      patch.draftSchema = Prisma.DbNull;
    }
  }

  const form = await prisma.hospitalForm.update({ where: { id }, data: patch });
  if (patch.isPublished) {
    logger.info({ id, tenantId, version: patch.version }, 'Hospital form published');
  }
  return presentHospitalForm(form, true);
}

/** Publish the pending draft (or a never-published form) as a new version. */
export async function publishHospitalForm(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
) {
  return updateHospitalForm(tenantId, roles, id, { isPublished: true }, userId);
}

/** Drop unpublished edits; the builder falls back to the published schema. */
export async function discardHospitalFormDraft(tenantId: string, roles: string[], id: string) {
  assertCanManageHospitalForms(roles);
  const existing = await prisma.hospitalForm.findFirst({
    where: { id, tenantId },
    select: { id: true, isPublished: true, draftSchema: true, archivedAt: true },
  });
  if (!existing) throw AppError.notFound('Form not found');
  if (existing.archivedAt) {
    throw AppError.badRequest('Cannot edit an archived form. Restore it first.');
  }
  if (!existing.isPublished) {
    throw AppError.badRequest('This form has never been published, so there is no published version to go back to.');
  }
  const form = await prisma.hospitalForm.update({
    where: { id },
    data: { draftSchema: Prisma.DbNull },
  });
  return presentHospitalForm(form, true);
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
  const form = await prisma.hospitalForm.create({
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
      publishedAt: new Date(),
      publishedById: userId,
    },
  });
  return presentHospitalForm(form, true);
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
  const form = await prisma.hospitalForm.update({
    where: { id },
    data: {
      archivedAt: new Date(),
      archivedById: userId,
      archiveReason: data.reason ?? null,
    },
  });
  return presentHospitalForm(form, true);
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
  const form = await prisma.hospitalForm.update({
    where: { id },
    data: { archivedAt: null, archivedById: null, archiveReason: null },
  });
  return presentHospitalForm(form, true);
}

// ─────────────────────────────────────────────────────────────
// Submissions
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the encounter a submission hangs off.
 *
 * When the caller names a visit / admission / appointment we delegate to the
 * shared resolver (which also tenant-checks and auto-opens the OPD visit).
 *
 * When it names none — a temporary / provisional patient the front desk has
 * not routed to OP or IP yet — we fall back to the patient's own most recent
 * encounter, and finally to no encounter at all. `visit_id` on the submission
 * is nullable, so a patient-scoped form entry is legitimate; refusing it was
 * what left temporary patients with no way to record a form.
 */
async function resolveSubmissionContext(
  tenantId: string,
  patientId: string,
  raw: { visitId?: string; admissionId?: string; appointmentId?: string },
): Promise<{ visitId?: string; admissionId?: string; appointmentId?: string }> {
  if (raw.visitId || raw.admissionId || raw.appointmentId) {
    return resolveVisitContext(tenantId, patientId, raw);
  }

  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  // Prefer a live admission (IP / emergency / day-care), then the newest visit.
  const admission = await prisma.admission.findFirst({
    where: { tenantId, patientId, status: ACTIVE_ADMISSION_STATUS },
    orderBy: { admissionDate: 'desc' },
    select: { id: true, visitId: true },
  });
  if (admission) return { visitId: admission.visitId, admissionId: admission.id };

  const visit = await prisma.visit.findFirst({
    where: { tenantId, patientId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, appointmentId: true },
  });
  if (visit) return { visitId: visit.id, appointmentId: visit.appointmentId ?? undefined };

  return {};
}

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

  const ctx = await resolveSubmissionContext(tenantId, body.patientId, {
    visitId: body.visitId,
    admissionId: body.admissionId,
    appointmentId: body.appointmentId,
  });

  const schema = asFormSchema(form.schema);
  const normalized = validateAndNormalizeSubmissionData(schema, body.data);

  // formSnapshot = deep copy of the PUBLISHED schema (`schema`; never the
  // unpublished `draftSchema`, which is not even selected above) and
  // formVersion = the published version it came from. Renderers use
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
      visitId: ctx.visitId ?? null,
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
