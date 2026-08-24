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
  // A measurement: a number that is meaningless without its unit — 72 bpm,
  // 36.8 °C, 120 mmHg. Distinct from `number`, which is for counts and scores
  // (pain score, GCS total, units of blood arranged) where a unit would be
  // noise. The value is stored as a plain number exactly like `number`, so it
  // stays sortable and aggregatable; the unit belongs to the field, not to the
  // answer, which is what stops one nurse recording kg and the next lb.
  'number_unit',
  'date',
  'datetime',
  // Clock time with no date attached — "pain started at 04:30". `datetime`
  // forces a date the nurse often does not know and should not have to guess.
  'time',
  'select',
  'multiselect',
  'radio',
  'checkbox',
  // A real Yes/No with a third, untouched state. `checkbox` cannot express
  // "not answered" — an unticked box and an explicit No look identical, which
  // is not a distinction a clinical record can afford to lose.
  'yesno',
  // Composite fields. Each stores an OBJECT rather than a scalar, because the
  // two halves are only meaningful together: a symptom and how long it has
  // been going on, a reading and the moment it was taken.
  'text_duration',
  'number_date',
  'section',
  'divider',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

const widthSchema = z.enum(['full', 'half', 'third']).default('full');

/**
 * Patient attributes a field can be prefilled from when the form is launched
 * under a patient. Whitelisted rather than free-form so a form can never be
 * authored to pull an arbitrary column off the patient record.
 */
export const PATIENT_AUTOFILL_KEYS = [
  'patient_name',
  'mrn',
  'age',
  'gender',
  'date_of_birth',
  'blood_group',
  'phone',
  'ward',
  'bed',
  'admission_date',
  'consultant',
] as const;

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
  // Prefill this field from the patient the form is opened under. The value is
  // still stored on the submission like any other answer — autofill saves
  // typing, it does not create a live reference.
  autofill: z.enum(PATIENT_AUTOFILL_KEYS).optional().nullable(),
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

// Same value as `number`; the unit is REQUIRED, which is the whole point of
// having a separate type. A measurement field with no unit is an authoring
// mistake, and the builder should not let it be saved.
const numberUnitField = baseField.extend({
  type: z.literal('number_unit'),
  placeholder: z.string().max(150).optional().nullable(),
  defaultValue: z.number().optional().nullable(),
  min: z.number().optional().nullable(),
  max: z.number().optional().nullable(),
  step: z.number().positive().optional().nullable(),
  unit: z.string().trim().min(1, 'Pick or type a unit for this measurement').max(20),
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

// Clock time only, stored as "HH:mm" (24h). Deliberately not a Date — the
// value has no day, and turning it into one invents information.
const timeField = baseField.extend({
  type: z.literal('time'),
  defaultValue: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm')
    .optional()
    .nullable(),
});

// Tri-state Yes / No. `defaultValue` null means "leave unanswered".
const yesnoField = baseField.extend({
  type: z.literal('yesno'),
  defaultValue: z.boolean().optional().nullable(),
  yesLabel: z.string().max(30).default('Yes'),
  noLabel: z.string().max(30).default('No'),
});

// The units a duration may be expressed in. Kept as one list so the builder,
// the renderer and the coercion layer cannot drift apart.
export const DURATION_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const;
const durationUnitEnum = z.enum(DURATION_UNITS);

// Free text plus "for how long" — "burning micturition, 3 days". Stored as
// { text, duration, unit }.
const textDurationField = baseField.extend({
  type: z.literal('text_duration'),
  placeholder: z.string().max(150).optional().nullable(),
  // Which units this particular field offers. Empty/absent = all of them.
  durationUnits: z.array(durationUnitEnum).optional().nullable(),
  defaultDurationUnit: durationUnitEnum.default('days'),
  maxLength: z.number().int().positive().max(2000).optional().nullable(),
});

// A measurement plus the date it was taken — "Hb 9.4 on 2026-08-12". Stored as
// { value, date }.
const numberDateField = baseField.extend({
  type: z.literal('number_date'),
  placeholder: z.string().max(150).optional().nullable(),
  min: z.number().optional().nullable(),
  max: z.number().optional().nullable(),
  step: z.number().positive().optional().nullable(),
  unit: z.string().max(20).optional().nullable(),
  // Label for the date half, e.g. "Taken on", "Last dose".
  dateLabel: z.string().max(60).optional().nullable(),
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
  numberUnitField,
  dateField,
  datetimeField,
  selectField,
  multiselectField,
  radioField,
  checkboxField,
  timeField,
  yesnoField,
  textDurationField,
  numberDateField,
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
