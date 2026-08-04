import { z } from 'zod';
import { paginationSchema, booleanQueryParam } from '../../shared/pagination';

// ─────────────────────────────────────────────────────────────
// Form schema (the JSON document stored on FormTemplate.schema /
// HospitalForm.schema and snapshot on every submission). Discriminated
// union per field type so the Zod parse rejects nonsense like a
// "select" with no options.
// ─────────────────────────────────────────────────────────────

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multiselect',
  'radio',
  'checkbox',
  'section',
  'divider',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

const widthSchema = z.enum(['full', 'half', 'third']).default('full');

const baseField = z.object({
  id: z.string().min(1),
  // Field key is what the submission JSON keys against. Snake-case so it's
  // safe for downstream report exports / spreadsheet headers.
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be snake_case starting with a letter'),
  label: z.string().min(1).max(200),
  helpText: z.string().max(500).optional().nullable(),
  required: z.boolean().default(false),
  width: widthSchema,
});

const optionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(150),
});

const textField = baseField.extend({
  type: z.literal('text'),
  placeholder: z.string().max(150).optional().nullable(),
  defaultValue: z.string().optional().nullable(),
  maxLength: z.number().int().positive().max(2000).optional().nullable(),
});

const textareaField = baseField.extend({
  type: z.literal('textarea'),
  placeholder: z.string().max(150).optional().nullable(),
  defaultValue: z.string().optional().nullable(),
  rows: z.number().int().min(2).max(20).default(3),
  maxLength: z.number().int().positive().max(10000).optional().nullable(),
});

const numberField = baseField.extend({
  type: z.literal('number'),
  placeholder: z.string().max(150).optional().nullable(),
  defaultValue: z.number().optional().nullable(),
  min: z.number().optional().nullable(),
  max: z.number().optional().nullable(),
  step: z.number().positive().optional().nullable(),
  unit: z.string().max(20).optional().nullable(),
});

const dateField = baseField.extend({
  type: z.literal('date'),
  defaultValue: z.string().optional().nullable(),
});

const datetimeField = baseField.extend({
  type: z.literal('datetime'),
  defaultValue: z.string().optional().nullable(),
});

const selectField = baseField.extend({
  type: z.literal('select'),
  options: z.array(optionSchema).min(1),
  defaultValue: z.string().optional().nullable(),
  placeholder: z.string().max(150).optional().nullable(),
});

const multiselectField = baseField.extend({
  type: z.literal('multiselect'),
  options: z.array(optionSchema).min(1),
  defaultValue: z.array(z.string()).optional().nullable(),
  placeholder: z.string().max(150).optional().nullable(),
});

const radioField = baseField.extend({
  type: z.literal('radio'),
  options: z.array(optionSchema).min(1),
  defaultValue: z.string().optional().nullable(),
});

const checkboxField = baseField.extend({
  type: z.literal('checkbox'),
  defaultValue: z.boolean().optional().nullable(),
});

// Section + divider are layout-only; nothing in the submission data refers
// to them, but the renderer needs them in order so we keep them in the
// `fields` array. Required is forced to false.
const sectionField = baseField.extend({
  type: z.literal('section'),
  required: z.literal(false).default(false),
});
const dividerField = baseField.extend({
  type: z.literal('divider'),
  required: z.literal(false).default(false),
});

export const formFieldSchema = z.discriminatedUnion('type', [
  textField,
  textareaField,
  numberField,
  dateField,
  datetimeField,
  selectField,
  multiselectField,
  radioField,
  checkboxField,
  sectionField,
  dividerField,
]);

export type FormField = z.infer<typeof formFieldSchema>;

export const formSchemaShape = z.object({
  fields: z.array(formFieldSchema).max(200),
  version: z.number().int().positive().default(1),
});

export type FormSchemaJson = z.infer<typeof formSchemaShape>;

// Reject duplicate field keys — we'd otherwise overwrite values silently.
function assertUniqueKeys(schema: FormSchemaJson) {
  const keys = schema.fields
    .filter((f) => f.type !== 'section' && f.type !== 'divider')
    .map((f) => f.key);
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) {
      throw new Error(`Duplicate field key: ${k}`);
    }
    seen.add(k);
  }
}

const formCategoryEnum = z.enum([
  'assessment',
  'screening',
  'intake',
  'vitals',
  'daily_note',
  'procedure',
  'discharge',
  'other',
]);

// ─────────────────────────────────────────────────────────────
// Templates (super-admin)
// ─────────────────────────────────────────────────────────────

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(150),
    description: z.string().max(2000).optional().nullable(),
    category: formCategoryEnum.default('other'),
    schema: formSchemaShape.refine(
      (s) => {
        try {
          assertUniqueKeys(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Field keys must be unique within a form' },
    ),
    isPublished: z.boolean().default(false),
  }),
});

export const updateTemplateSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: createTemplateSchema.shape.body.partial(),
});

export const templateIdParam = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const listTemplatesQuerySchema = z.object({
  query: paginationSchema.extend({
    category: formCategoryEnum.optional(),
    isPublished: booleanQueryParam.optional(),
  }),
});

// ─────────────────────────────────────────────────────────────
// Hospital forms (admin)
// ─────────────────────────────────────────────────────────────

export const createHospitalFormSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(150),
    description: z.string().max(2000).optional().nullable(),
    category: formCategoryEnum.default('other'),
    schema: formSchemaShape,
    isPublished: z.boolean().default(true),
  }),
});

export const updateHospitalFormSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: createHospitalFormSchema.shape.body.partial(),
});

export const hospitalFormIdParam = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const listHospitalFormsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['active', 'archived', 'all']).default('active'),
    category: formCategoryEnum.optional(),
    isPublished: booleanQueryParam.optional(),
  }),
});

export const cloneTemplateSchema = z.object({
  params: z.object({ templateId: z.string().uuid() }),
  body: z
    .object({
      name: z.string().min(1).max(150).optional(),
    })
    .default({}),
});

export const archiveFormSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      reason: z.string().max(255).optional(),
    })
    .default({}),
});

// ─────────────────────────────────────────────────────────────
// Submissions
// ─────────────────────────────────────────────────────────────

export const createSubmissionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    patientId: z.string().uuid(),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
    appointmentId: z.string().uuid().optional(),
    // The renderer is responsible for type-coercing inputs before send;
    // the service then revalidates against the form's published schema
    // (required fields, option whitelist, type cast).
    data: z.record(z.string(), z.unknown()),
  }),
});

export const listSubmissionsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    formId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional(),
  }),
});

export const submissionIdParam = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>['body'];
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>['body'];
export type CreateHospitalFormInput = z.infer<typeof createHospitalFormSchema>['body'];
export type UpdateHospitalFormInput = z.infer<typeof updateHospitalFormSchema>['body'];
export type CloneTemplateInput = z.infer<typeof cloneTemplateSchema>['body'];
export type ArchiveFormInput = z.infer<typeof archiveFormSchema>['body'];
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>['body'];
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>['query'];
export type ListHospitalFormsQuery = z.infer<typeof listHospitalFormsQuerySchema>['query'];
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>['query'];
