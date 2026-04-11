import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getPaginationParams, PaginationQuery } from '../../shared/pagination';
import type {
  UpdateSystemFormInput,
  UpsertHospitalFormConfigInput,
  UpdateHospitalFormConfigInput,
  CreateFormSubmissionInput,
  UpdateFormSubmissionInput,
  FormSchemaInput,
} from './forms.validation';

// ─── Types ───────────────────────────────────────────────────

type RoleSetting = 'required' | 'optional' | 'view_only' | 'hidden';
type RoleSettingsMap = Record<string, RoleSetting>;

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Validate that submitted responses match the field definitions in a schema.
 */
function validateResponses(schema: FormSchemaInput, responses: Record<string, unknown>) {
  const errors: string[] = [];
  for (const field of schema.fields) {
    if (field.type === 'section_header') continue;
    const value = responses[field.id];
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (field.required && isEmpty) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (isEmpty) continue;

    const v = field.validation;
    if (v) {
      if (typeof value === 'string') {
        if (v.minLength && value.length < v.minLength) errors.push(`${field.label} too short`);
        if (v.maxLength && value.length > v.maxLength) errors.push(`${field.label} too long`);
        if (v.pattern) {
          try {
            const re = new RegExp(v.pattern);
            if (!re.test(value)) errors.push(v.patternMessage || `${field.label} invalid format`);
          } catch {
            // ignore bad regex from blueprint
          }
        }
      }
      if (field.type === 'number' || field.type === 'select' || field.type === 'radio') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          if (v.min !== undefined && num < v.min) errors.push(`${field.label} below minimum`);
          if (v.max !== undefined && num > v.max) errors.push(`${field.label} above maximum`);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw AppError.badRequest(`Validation failed: ${errors.join('; ')}`);
  }
}

/**
 * Merge role settings: hospital config overrides system defaults.
 * Roles not listed in either = hidden.
 */
function mergeRoleSettings(defaults: RoleSettingsMap, overrides: RoleSettingsMap): RoleSettingsMap {
  return { ...defaults, ...overrides };
}

/**
 * Get effective schema: hospital override or system default.
 */
function getEffectiveSchema(systemSchema: unknown, configSchemaOverride: unknown | null): unknown {
  return configSchemaOverride ?? systemSchema;
}

/**
 * Fetch the set of enabled feature keys for a tenant from FeatureToggle.
 * Every form requires its feature to be enabled — no freebies.
 */
async function getEnabledModules(tenantId: string): Promise<Set<string>> {
  const toggles = await prisma.featureToggle.findMany({
    where: { tenantId, isEnabled: true },
    select: { featureKey: true },
  });
  return new Set(toggles.map((t) => t.featureKey));
}

// ════════════════════════════════════════════════════════════════
//   SYSTEM FORMS SERVICE
// ════════════════════════════════════════════════════════════════

export const systemFormsService = {
  /**
   * List all system forms. Optionally overlay hospital config for a tenant.
   */
  async list(query: PaginationQuery & { category?: string; trigger?: string; tenantId?: string }) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const where: Record<string, unknown> = {};
    if (query.category) where.category = query.category;
    if (query.trigger) where.trigger = query.trigger;

    const [forms, total] = await Promise.all([
      prisma.systemForm.findMany({
        where,
        skip,
        take,
        orderBy: [{ trigger: 'asc' }, { sortOrder: 'asc' }],
        include: query.tenantId
          ? { hospitalConfigs: { where: { tenantId: query.tenantId } } }
          : undefined,
      }),
      prisma.systemForm.count({ where }),
    ]);

    return { forms, total, page, limit };
  },

  /**
   * Get single system form by slug id.
   */
  async getById(id: string, tenantId?: string) {
    const form = await prisma.systemForm.findUnique({
      where: { id },
      include: tenantId
        ? { hospitalConfigs: { where: { tenantId } } }
        : undefined,
    });
    if (!form) throw AppError.notFound('System form not found');
    return form;
  },

  /**
   * Super admin: update schema, name, description, toggle.
   * Trigger is NEVER updated — it's fixed.
   */
  async update(id: string, data: UpdateSystemFormInput) {
    const form = await prisma.systemForm.findUnique({ where: { id } });
    if (!form) throw AppError.notFound('System form not found');

    return prisma.systemForm.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.schema !== undefined && { schema: data.schema as object }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.defaultRoleSettings !== undefined && { defaultRoleSettings: data.defaultRoleSettings as object }),
      },
    });
  },

  /**
   * Core resolution: get forms for a given trigger, filtered by hospital config and user role.
   * Returns forms the user can either fill or view, with computed properties.
   */
  async getForTrigger(trigger: string, tenantId: string | undefined, userRole: string | undefined) {
    const where: Record<string, unknown> = { trigger, isActive: true };

    const forms = await prisma.systemForm.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      include: tenantId
        ? { hospitalConfigs: { where: { tenantId } } }
        : undefined,
    });

    // Check which modules this tenant has enabled
    const enabledModules = tenantId ? await getEnabledModules(tenantId) : new Set(['core']);

    const results = [];
    for (const form of forms) {
      // Skip forms whose module is not in the tenant's subscription
      if (!enabledModules.has(form.module)) continue;

      const config = (form as any).hospitalConfigs?.[0] ?? null;

      // If hospital has disabled this form, skip
      if (config && !config.isEnabled) continue;

      const defaults = (form.defaultRoleSettings ?? {}) as RoleSettingsMap;
      const overrides = (config?.roleSettings ?? {}) as RoleSettingsMap;
      const merged = mergeRoleSettings(defaults, overrides);

      const roleSetting = userRole ? (merged[userRole] ?? 'hidden') : 'hidden';

      // Skip if this role can't see the form at all
      if (roleSetting === 'hidden') continue;

      const effectiveSchema = getEffectiveSchema(form.schema, config?.schemaOverride);

      results.push({
        form: {
          id: form.id,
          name: form.name,
          description: form.description,
          category: form.category,
          trigger: form.trigger,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
          applicableRoles: form.applicableRoles,
          defaultRoleSettings: form.defaultRoleSettings,
          createdAt: form.createdAt,
          updatedAt: form.updatedAt,
        },
        config: config
          ? {
              id: config.id,
              tenantId: config.tenantId,
              formId: config.formId,
              isEnabled: config.isEnabled,
              schemaOverride: config.schemaOverride,
              roleSettings: config.roleSettings,
            }
          : null,
        effectiveSchema,
        roleSetting,
        isRequired: roleSetting === 'required',
        canFill: roleSetting === 'required' || roleSetting === 'optional',
        canView: roleSetting === 'view_only' || roleSetting === 'required' || roleSetting === 'optional',
      });
    }

    return results;
  },

  /**
   * Get pending (unfilled required) forms for a context (e.g., specific appointment).
   */
  async getPendingForContext(params: {
    trigger: string;
    tenantId: string | undefined;
    userRole: string | undefined;
    appointmentId?: string;
    admissionId?: string;
    visitId?: string;
    patientId?: string;
  }) {
    // 1. Resolve all forms for this trigger + tenant + role
    const resolved = await this.getForTrigger(params.trigger, params.tenantId, params.userRole);

    // 2. Filter to only required forms where the user can fill
    const required = resolved.filter((r) => r.isRequired && r.canFill);
    if (required.length === 0) return [];

    // 3. Check which of these have already been submitted for this context
    const contextWhere: Record<string, unknown> = {};
    if (params.appointmentId) contextWhere.appointmentId = params.appointmentId;
    if (params.admissionId) contextWhere.admissionId = params.admissionId;
    if (params.visitId) contextWhere.visitId = params.visitId;
    if (params.patientId) contextWhere.patientId = params.patientId;

    const existing = await prisma.formSubmission.findMany({
      where: {
        formId: { in: required.map((r) => r.form.id) },
        trigger: params.trigger as any,
        ...contextWhere,
      },
      select: { formId: true },
    });
    const submittedFormIds = new Set(existing.map((s) => s.formId));

    // 4. Return only forms not yet submitted
    return required.filter((r) => !submittedFormIds.has(r.form.id));
  },

  /**
   * Returns ALL forms available for a user to fill at any trigger (Staff Forms Inbox).
   */
  async listAvailableForUser(tenantId: string, userRole: string) {
    const forms = await prisma.systemForm.findMany({
      where: { isActive: true },
      orderBy: [{ trigger: 'asc' }, { sortOrder: 'asc' }],
      include: { hospitalConfigs: { where: { tenantId } } },
    });

    const enabledModules = await getEnabledModules(tenantId);

    const results = [];
    for (const form of forms) {
      if (!enabledModules.has(form.module)) continue;

      const config = (form as any).hospitalConfigs?.[0] ?? null;
      if (config && !config.isEnabled) continue;

      const defaults = (form.defaultRoleSettings ?? {}) as RoleSettingsMap;
      const overrides = (config?.roleSettings ?? {}) as RoleSettingsMap;
      const merged = mergeRoleSettings(defaults, overrides);
      const roleSetting = merged[userRole] ?? 'hidden';

      if (roleSetting === 'required' || roleSetting === 'optional') {
        results.push({
          form: {
            id: form.id,
            name: form.name,
            description: form.description,
            category: form.category,
            trigger: form.trigger,
            sortOrder: form.sortOrder,
          },
          isRequired: roleSetting === 'required',
          effectiveSchema: getEffectiveSchema(form.schema, config?.schemaOverride),
        });
      }
    }
    return results;
  },
};

// ════════════════════════════════════════════════════════════════
//   HOSPITAL FORM CONFIG SERVICE
// ════════════════════════════════════════════════════════════════

export const hospitalFormConfigService = {
  /**
   * List all system forms with this tenant's config overlay.
   */
  async getAll(tenantId: string) {
    const [forms, configs, enabledModules] = await Promise.all([
      prisma.systemForm.findMany({ orderBy: [{ trigger: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.hospitalFormConfig.findMany({ where: { tenantId } }),
      getEnabledModules(tenantId),
    ]);

    const configMap = new Map(configs.map((c) => [c.formId, c]));
    // Only return forms whose module is in the hospital's subscription
    return forms
      .filter((form) => enabledModules.has(form.module))
      .map((form) => ({
        ...form,
        config: configMap.get(form.id) ?? null,
      }));
  },

  /**
   * Upsert hospital config for a specific form.
   */
  async upsert(tenantId: string, data: UpsertHospitalFormConfigInput) {
    // Verify the system form exists
    const form = await prisma.systemForm.findUnique({ where: { id: data.formId } });
    if (!form) throw AppError.notFound('System form not found');

    const createData: any = {
      tenantId,
      formId: data.formId,
      isEnabled: data.isEnabled ?? true,
      roleSettings: (data.roleSettings ?? {}) as object,
    };
    if (data.schemaOverride !== undefined) {
      createData.schemaOverride = data.schemaOverride as object | null;
    }

    const updateData: any = {};
    if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
    if (data.schemaOverride !== undefined) updateData.schemaOverride = data.schemaOverride as object | null;
    if (data.roleSettings !== undefined) updateData.roleSettings = data.roleSettings as object;

    return prisma.hospitalFormConfig.upsert({
      where: { tenantId_formId: { tenantId, formId: data.formId } },
      create: createData,
      update: updateData,
    });
  },

  /**
   * Update hospital config by formId.
   */
  async update(tenantId: string, formId: string, data: UpdateHospitalFormConfigInput) {
    const existing = await prisma.hospitalFormConfig.findUnique({
      where: { tenantId_formId: { tenantId, formId } },
    });
    if (!existing) throw AppError.notFound('Hospital form config not found. Create it first.');

    const updateData: any = {};
    if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
    if (data.schemaOverride !== undefined) updateData.schemaOverride = data.schemaOverride as object | null;
    if (data.roleSettings !== undefined) updateData.roleSettings = data.roleSettings as object;

    return prisma.hospitalFormConfig.update({
      where: { id: existing.id },
      data: updateData,
    });
  },

  /**
   * Get config for a single form.
   */
  async getConfig(tenantId: string, formId: string) {
    return prisma.hospitalFormConfig.findUnique({
      where: { tenantId_formId: { tenantId, formId } },
    });
  },
};

// ════════════════════════════════════════════════════════════════
//   FORM SUBMISSIONS SERVICE
// ════════════════════════════════════════════════════════════════

export const formSubmissionsService = {
  /**
   * List submissions with filtering. Respects viewer role via SystemForm + HospitalFormConfig.
   */
  async list(
    tenantId: string,
    query: PaginationQuery & {
      formId?: string;
      patientId?: string;
      appointmentId?: string;
      status?: string;
      trigger?: string;
      viewerRole?: string;
    },
  ) {
    const { skip, take, page, limit } = getPaginationParams(query);
    const where: Record<string, unknown> = { tenantId, formId: { not: null } };
    if (query.formId) where.formId = query.formId;
    if (query.patientId) where.patientId = query.patientId;
    if (query.appointmentId) where.appointmentId = query.appointmentId;
    if (query.status) where.status = query.status;
    if (query.trigger) where.trigger = query.trigger;

    // Filter by viewer role: only show submissions for forms where this role has view access
    if (query.viewerRole) {
      const systemForms = await prisma.systemForm.findMany({
        where: { isActive: true },
        select: { id: true, defaultRoleSettings: true },
      });

      const configs = await prisma.hospitalFormConfig.findMany({
        where: { tenantId },
        select: { formId: true, roleSettings: true, isEnabled: true },
      });
      const configMap = new Map(configs.map((c) => [c.formId, c]));

      const visibleFormIds = systemForms
        .filter((form) => {
          const config = configMap.get(form.id);
          if (config && !config.isEnabled) return false;
          const defaults = (form.defaultRoleSettings ?? {}) as RoleSettingsMap;
          const overrides = (config?.roleSettings ?? {}) as RoleSettingsMap;
          const merged = mergeRoleSettings(defaults, overrides);
          const setting = merged[query.viewerRole!] ?? 'hidden';
          // Can view if required, optional, or view_only — NOT hidden
          return setting !== 'hidden';
        })
        .map((f) => f.id);

      if (visibleFormIds.length === 0) {
        return { submissions: [], total: 0, page, limit };
      }
      where.formId = { in: visibleFormIds };
    }

    const [submissions, total] = await Promise.all([
      prisma.formSubmission.findMany({
        where,
        skip,
        take,
        orderBy: { submittedAt: 'desc' },
        include: {
          systemForm: { select: { id: true, name: true, category: true } },
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
          appointment: {
            select: {
              id: true,
              appointmentDate: true,
              startTime: true,
              status: true,
              reason: true,
              doctor: {
                select: {
                  id: true,
                  user: { select: { firstName: true, lastName: true } },
                  specialization: true,
                },
              },
            },
          },
          visit: {
            select: { id: true, visitType: true, chiefComplaint: true, visitDate: true },
          },
          admission: {
            select: { id: true, admissionDate: true, dischargeDate: true, status: true },
          },
          submitter: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      prisma.formSubmission.count({ where }),
    ]);
    return { submissions, total, page, limit };
  },

  async getById(tenantId: string, id: string) {
    const submission = await prisma.formSubmission.findFirst({
      where: { id, tenantId },
      include: {
        systemForm: true,
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        appointment: {
          select: {
            id: true,
            appointmentDate: true,
            startTime: true,
            status: true,
            reason: true,
            doctor: {
              select: {
                id: true,
                user: { select: { firstName: true, lastName: true } },
                specialization: true,
              },
            },
          },
        },
        visit: {
          select: { id: true, visitType: true, chiefComplaint: true, visitDate: true },
        },
        admission: {
          select: { id: true, admissionDate: true, dischargeDate: true, status: true },
        },
        submitter: { select: { id: true, firstName: true, lastName: true } },
        verifier: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!submission) throw AppError.notFound('Submission not found');
    return submission;
  },

  /**
   * Create a new form submission.
   * Resolves tenant from linked appointment/patient (same cross-tenant logic as before).
   */
  async create(
    fallbackTenantId: string | undefined,
    data: CreateFormSubmissionInput,
    submittedBy?: string,
  ) {
    let resolvedTenantId: string | undefined;
    let resolvedPatientId = data.patientId;

    // Resolve tenant from appointment
    if (data.appointmentId) {
      const apt = await prisma.appointment.findUnique({
        where: { id: data.appointmentId },
        select: { tenantId: true, patientId: true },
      });
      if (apt) {
        resolvedTenantId = apt.tenantId;
        if (!resolvedPatientId) resolvedPatientId = apt.patientId;
      }
    }

    // Resolve tenant from patient
    if (!resolvedTenantId && data.patientId) {
      const patient = await prisma.patient.findUnique({
        where: { id: data.patientId },
        select: { tenantId: true },
      });
      if (patient) resolvedTenantId = patient.tenantId;
    }

    // Explicit body tenant
    if (!resolvedTenantId && data.tenantId) resolvedTenantId = data.tenantId;

    // Fallback (req.user.tenantId)
    if (!resolvedTenantId) resolvedTenantId = fallbackTenantId;

    if (!resolvedTenantId) {
      throw AppError.badRequest('Cannot determine tenant. Provide tenantId, appointmentId, or patientId.');
    }

    // Verify the system form exists and is active
    const systemForm = await prisma.systemForm.findUnique({ where: { id: data.formId } });
    if (!systemForm) throw AppError.notFound('System form not found');
    if (!systemForm.isActive) throw AppError.badRequest('This form is not currently active.');

    // Get effective schema for validation
    const config = await prisma.hospitalFormConfig.findUnique({
      where: { tenantId_formId: { tenantId: resolvedTenantId, formId: data.formId } },
    });
    const effectiveSchema = (config?.schemaOverride ?? systemForm.schema) as FormSchemaInput;

    // Validate responses against schema
    validateResponses(effectiveSchema, data.responses as Record<string, unknown>);

    return prisma.formSubmission.create({
      data: {
        tenantId: resolvedTenantId,
        formId: data.formId,
        trigger: data.trigger as any,
        responses: data.responses as object,
        status: data.status,
        patientId: resolvedPatientId,
        appointmentId: data.appointmentId,
        visitId: data.visitId,
        admissionId: data.admissionId,
        submittedBy,
        notes: data.notes,
      },
    });
  },

  /**
   * Update submission (verify / reject).
   */
  async update(tenantId: string, id: string, data: UpdateFormSubmissionInput, userId?: string) {
    const existing = await prisma.formSubmission.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw AppError.notFound('Submission not found');

    const updateData: Record<string, unknown> = {};
    if (data.status) updateData.status = data.status;
    if (data.rejectionReason !== undefined) updateData.rejectionReason = data.rejectionReason;
    if (data.notes !== undefined) updateData.notes = data.notes;

    if (data.status === 'verified' && userId) {
      updateData.verifiedBy = userId;
      updateData.verifiedAt = new Date();
    }

    return prisma.formSubmission.update({
      where: { id },
      data: updateData,
    });
  },

  async delete(tenantId: string, id: string) {
    const existing = await prisma.formSubmission.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw AppError.notFound('Submission not found');

    await prisma.formSubmission.delete({ where: { id } });
  },
};
