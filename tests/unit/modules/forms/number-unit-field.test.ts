import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createSubmission } from '../../../../src/modules/forms/forms.service';
import { formFieldSchema, FORM_FIELD_TYPES } from '../../../../src/modules/forms/forms.validation';

// `number_unit` — a measurement. The report asked for four new field types and
// three of them (time, text_duration, number_date) became real types a form
// author can pick from the palette; the fourth was only ever an optional `unit`
// property hidden on `number`, so it looked absent. This is that fourth type.
//
// The value is stored as a bare number, exactly like `number`, so a
// measurement stays sortable and aggregatable. What makes it its own type is
// that the unit is REQUIRED: `number` is for counts and scores (pain score,
// GCS total) where a unit would be noise, `number_unit` is for readings that
// mean nothing without one.

const TENANT = 'tenant-1';
const USER = 'user-1';

const weightField = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  key: 'weight',
  label: 'Weight',
  type: 'number_unit',
  required: false,
  width: 'full',
  unit: 'kg',
  ...over,
});

describe('number_unit — the field definition', () => {
  it('is offered as a field type', () => {
    expect(FORM_FIELD_TYPES).toContain('number_unit');
  });

  it('accepts a measurement with a unit', () => {
    const parsed = formFieldSchema.parse(weightField());
    expect(parsed).toMatchObject({ type: 'number_unit', unit: 'kg' });
  });

  it('refuses a measurement with no unit — that is an authoring mistake', () => {
    expect(() => formFieldSchema.parse(weightField({ unit: undefined }))).toThrow();
    expect(() => formFieldSchema.parse(weightField({ unit: '' }))).toThrow();
    // Whitespace is not a unit either.
    expect(() => formFieldSchema.parse(weightField({ unit: '   ' }))).toThrow();
  });

  it('still lets a plain number be unitless, so counts and scores stay clean', () => {
    const parsed = formFieldSchema.parse({
      id: 'f2', key: 'pain_score', label: 'Pain score', type: 'number', required: false, width: 'full',
    });
    expect(parsed.type).toBe('number');
  });

  it('carries the same range controls a number does', () => {
    const parsed: any = formFieldSchema.parse(weightField({ min: 0, max: 400, step: 0.1 }));
    expect(parsed).toMatchObject({ min: 0, max: 400, step: 0.1 });
  });
});

describe('number_unit — what a submission stores', () => {
  const FORM = {
    id: 'form-1',
    tenantId: TENANT,
    schema: { fields: [weightField({ min: 0, max: 400 })] },
    version: 1,
    isPublished: true,
    archivedAt: null as Date | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.hospitalForm.findFirst).mockResolvedValue(FORM as never);
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as never);
    vi.mocked(prisma.hospitalFormSubmission.create).mockImplementation(
      (async (args: any) => ({ id: 'sub-1', ...args.data })) as never,
    );
  });

  const submit = (value: unknown) =>
    createSubmission(TENANT, USER, 'form-1', { patientId: 'pat-1', data: { weight: value } } as never);

  it('stores a bare number, not an object — the unit belongs to the field', async () => {
    const sub: any = await submit(72.5);
    // Deliberately NOT { value, unit } the way number_date stores { value, date }:
    // the unit is fixed by the form author, so repeating it on every answer
    // would be storage that can disagree with its own definition.
    expect(sub.data.weight).toBe(72.5);
  });

  it('coerces a numeric string the same way a number field does', async () => {
    const sub: any = await submit('68');
    expect(sub.data.weight).toBe(68);
  });

  it('enforces the range', async () => {
    await expect(submit(-1)).rejects.toThrow(/≥ 0/);
    await expect(submit(999)).rejects.toThrow(/≤ 400/);
  });

  it('rejects something that is not a number', async () => {
    await expect(submit('heavy')).rejects.toThrow(/must be a number/i);
  });
});
