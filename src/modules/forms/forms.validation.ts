import { z } from 'zod';

// ─── Field-level schema (the JSON blueprint stored in `schema` JSON column) ───

const fieldOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

const fieldValidationSchema = z
  .object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    patternMessage: z.string().optional(),
  })
  .optional();

export const fieldTypeEnum = z.enum([
  'text',
  'textarea',
  'number',
  'email',
  'phone',
  'date',
  'time',
  'datetime',
  'select',
  'multi_select',
  'radio',
  'checkbox',
  'file',
  'signature',
  'section_header',
]);

export const formFieldSchema = z.object({
  id: z.string().min(1),
  type: fieldTypeEnum,
  label: z.string().min(1),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().default(false),
  defaultValue: z.any().optional(),
  options: z.array(fieldOptionSchema).optional(),
  validation: fieldValidationSchema,
  width: z.enum(['full', 'half', 'third']).default('full'),
});

export const formSchemaShape = z.object({
  version: z.number().int().min(1).default(1),
  fields: z.array(formFieldSchema).min(1, 'A form must have at least one field'),
});

export type FormFieldInput = z.infer<typeof formFieldSchema>;
export type FormSchemaInput = z.infer<typeof formSchemaShape>;

const categoryEnum = z.enum([
  'registration',
  'consent',
  'intake',
  'feedback',
  'checklist',
  'clinical',
  'discharge',
  'other',
]);

const triggerEnum = z.enum([
  // Patient lifecycle
  'appointment_booking',
  'patient_registration',
  'visit_check_in',
  'pre_consultation',
  'admission',
  'pre_op',
  'post_op',
  'discharge',
  'feedback',
  // Clinical workflow
  'vital_signs_entry',
  'prescription_created',
  'prescription_dispensed',
  'lab_order_created',
  'lab_sample_collected',
  'lab_report_finalized',
  'imaging_request_created',
  'imaging_result_finalized',
  'progress_note_added',
  'nursing_note_added',
  'medication_administered',
  'patient_transfer',
  // Staff & HR
  'staff_check_in',
  'staff_check_out',
  'shift_handover',
  'leave_request',
  'performance_review',
  'employee_onboarding',
  'exit_interview',
  'training_completion',
  // Pharmacy
  'drug_stock_received',
  'drug_returned',
  'pharmacy_expiry_audit',
  // Lab
  'specimen_received',
  'lab_qc_check',
  // Blood bank
  'blood_donation_collected',
  'transfusion_initiated',
  'transfusion_reaction_reported',
  // Insurance & billing
  'insurance_claim_submitted',
  'pre_authorization_request',
  'payment_received',
  'refund_requested',
  // Operations & compliance
  'daily_safety_check',
  'incident_reported',
  'equipment_check',
  'inventory_audit',
  'maintenance_request',
  'compliance_audit',
  // Periodic
  'daily_review',
  'weekly_review',
  'monthly_review',
  // Manual
  'manual',
]);

const submissionStatusEnum = z.enum(['draft', 'submitted', 'verified', 'rejected']);

const roleSettingEnum = z.enum(['required', 'optional', 'view_only', 'hidden']);

// ─── System Forms (super admin edits schema/toggle) ──────────

export const systemFormIdParamSchema = z.object({
  params: z.object({ id: z.string().min(1).max(100) }), // slug, not UUID
});

export const updateSystemFormSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(255).optional(),
    description: z.string().max(2000).optional(),
    schema: formSchemaShape.optional(),
    isActive: z.boolean().optional(),
    defaultRoleSettings: z.record(z.string(), roleSettingEnum).optional(),
  }),
  params: z.object({ id: z.string().min(1).max(100) }),
});

// ─── Hospital Form Config (hospital admin) ───────────────────

export const upsertHospitalFormConfigSchema = z.object({
  body: z.object({
    formId: z.string().min(1).max(100),
    isEnabled: z.boolean().optional(),
    schemaOverride: formSchemaShape.nullable().optional(),
    roleSettings: z.record(z.string(), roleSettingEnum).optional(),
  }),
});

export const updateHospitalFormConfigSchema = z.object({
  body: z.object({
    isEnabled: z.boolean().optional(),
    schemaOverride: formSchemaShape.nullable().optional(),
    roleSettings: z.record(z.string(), roleSettingEnum).optional(),
  }),
  params: z.object({ formId: z.string().min(1).max(100) }),
});

// ─── Form Submissions ────────────────────────────────────────

export const createFormSubmissionSchema = z.object({
  body: z.object({
    formId: z.string().min(1).max(100),
    trigger: triggerEnum.optional(),
    responses: z.record(z.string(), z.any()),
    tenantId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    appointmentId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    status: submissionStatusEnum.default('submitted'),
    notes: z.string().max(2000).optional(),
  }),
});

export const updateFormSubmissionSchema = z.object({
  body: z.object({
    status: submissionStatusEnum.optional(),
    rejectionReason: z.string().max(1000).optional(),
    notes: z.string().max(2000).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ─── Trigger param (for resolving forms by trigger) ──────────

export const triggerParamSchema = z.object({
  params: z.object({ trigger: triggerEnum }),
});

// ─── Exported types ──────────────────────────────────────────

export type UpdateSystemFormInput = z.infer<typeof updateSystemFormSchema>['body'];
export type UpsertHospitalFormConfigInput = z.infer<typeof upsertHospitalFormConfigSchema>['body'];
export type UpdateHospitalFormConfigInput = z.infer<typeof updateHospitalFormConfigSchema>['body'];
export type CreateFormSubmissionInput = z.infer<typeof createFormSubmissionSchema>['body'];
export type UpdateFormSubmissionInput = z.infer<typeof updateFormSubmissionSchema>['body'];
