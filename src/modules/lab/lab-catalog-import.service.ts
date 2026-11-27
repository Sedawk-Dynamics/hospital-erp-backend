// Gap 369: bulk maintenance of the lab catalogue by the Hospital Admin.
//
// One file row per parameter. Rows with the same code (or, without a code, the
// same name) are one test. Preview changes nothing; commit re-reads the file
// from scratch and saves only the tests that were ticked, through the same
// createTest / updateTest as the screen, so reference ranges become pending
// proposals and the price guard applies exactly as they do there.
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { normaliseTestName, isPlaceholderText } from './lab-catalog-quality';
import { describeConflict, newPriceConflicts, type PriceConflict } from './lab-price-guard';
import { formatRange, normaliseUnit, paramRange, rangeNameKey, rangeProblem, rawParams, type RawParam } from './lab-range';
import { createTest, updateTest } from './lab.service';
import type { CreateTestInput, UpdateTestInput } from './lab.validation';

export interface ImportRow {
  rowNumber: number;
  testCode?: string | number | null;
  testName?: string | number | null;
  sampleType?: string | number | null;
  specimen?: string | number | null;
  instructions?: string | number | null;
  description?: string | number | null;
  turnaroundHours?: string | number | null;
  price?: string | number | null;
  aliases?: string | number | null;
  parameterName?: string | number | null;
  parameterUnit?: string | number | null;
  refLow?: string | number | null;
  refHigh?: string | number | null;
  refText?: string | number | null;
  group?: string | number | null;
}

export interface ImportPlan {
  key: string;
  rowNumbers: number[];
  action: 'create' | 'update';
  testId: string | null;
  /** rangeVersion + price seen at preview; commit refuses if the test moved. */
  stamp: string | null;
  testName: string;
  testCode: string | null;
  changes: string[];
  rangeChanges: string[];
  priceConflicts: Array<PriceConflict & { message: string }>;
  errors: string[];
  warnings: string[];
}

const EDITORS = new Set(['admin', 'super_admin']);

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

function numeric(v: unknown): number | null | 'bad' {
  const s = text(v);
  if (s === null) return null;
  const cleaned = s.replace(/^(?:₹|rs\.?)\s*/i, '').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : 'bad';
}

const TEXT_FIELDS = [
  ['testCode', 'Code', 50],
  ['sampleType', 'Sample type', 50],
  ['specimen', 'Specimen', 255],
  ['instructions', 'Instructions', 5000],
  ['description', 'Description', 5000],
] as const;

type Existing = {
  id: string;
  testName: string;
  testCode: string | null;
  sampleType: string | null;
  specimen: string | null;
  instructions: string | null;
  description: string | null;
  turnaroundHours: number | null;
  price: unknown;
  aliases: string[];
  parameters: unknown;
  normalRange: string | null;
  unit: string | null;
  isActive: boolean;
  rangeVersion: number;
};

type Built = ImportPlan & { payload: Partial<CreateTestInput> & { testName: string } };

const stampOf = (t: Existing) => `${t.rangeVersion}:${t.price == null ? '' : Number(t.price)}`;

async function loadCatalogue(tenantId: string): Promise<Existing[]> {
  return prisma.labTestCatalog.findMany({
    where: { tenantId },
    select: {
      id: true, testName: true, testCode: true, sampleType: true, specimen: true, instructions: true,
      description: true, turnaroundHours: true, price: true, aliases: true, parameters: true,
      normalRange: true, unit: true, isActive: true, rangeVersion: true,
    },
  });
}

async function buildPlans(tenantId: string, rows: ImportRow[]): Promise<Built[]> {
  const catalogue = await loadCatalogue(tenantId);
  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const code = text(r.testCode)?.toLowerCase();
    const name = text(r.testName);
    const key = code ? `code:${code}` : name ? `name:${rangeNameKey(name)}` : `row:${r.rowNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const plans: Built[] = [];
  for (const [key, list] of groups) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const changes: string[] = [];
    const rangeChanges: string[] = [];

    /** A test-level value may be repeated on every row or given once, never two ways. */
    const one = (field: keyof ImportRow, label: string): string | null => {
      const seen = [...new Set(list.map((r) => text(r[field])).filter((v): v is string => v !== null))];
      if (seen.length > 1) errors.push(`${label} differs between rows of the same test: ${seen.join(' / ')}`);
      return seen[0] ?? null;
    };

    for (const r of list) if (!text(r.testName)) errors.push(`Row ${r.rowNumber}: test name is required`);
    const testName = one('testName', 'Test name') ?? '';
    const fields: Record<string, string | null> = {};
    for (const [field, label, max] of TEXT_FIELDS) {
      const v = one(field, label);
      if (v && v.length > max) errors.push(`${label} is longer than ${max} characters`);
      if (field !== 'testCode' && field !== 'sampleType' && isPlaceholderText(v)) {
        errors.push(`${label} looks like placeholder text ("${v}")`);
      }
      fields[field] = v;
    }
    if (testName.length > 255) errors.push('Test name is longer than 255 characters');

    const price = numeric(one('price', 'Price'));
    if (price === 'bad' || (typeof price === 'number' && (price <= 0 || price > 10_000_000))) {
      errors.push('Price must be a number above zero');
    }
    const tat = numeric(one('turnaroundHours', 'Turnaround'));
    if (tat === 'bad' || (typeof tat === 'number' && (!Number.isInteger(tat) || tat <= 0))) {
      errors.push('Turnaround must be a whole number of hours');
    }
    const aliasText = one('aliases', 'Other names');
    const aliases = aliasText ? aliasText.split(/[;|]/).map((a) => a.trim()).filter(Boolean) : null;
    if (aliases && (aliases.length > 25 || aliases.some((a) => a.length > 120))) {
      errors.push('At most 25 other names, each 120 characters or fewer');
    }

    // --- which test is it? ---
    const code = fields.testCode?.toLowerCase();
    const byCode = code ? catalogue.find((t) => t.testCode?.toLowerCase() === code) : undefined;
    const byName = testName ? catalogue.find((t) => rangeNameKey(t.testName) === rangeNameKey(testName)) : undefined;
    if (byCode && byName && byCode.id !== byName.id) {
      errors.push(`Code ${fields.testCode} belongs to ${byCode.testName}, but the name matches ${byName.testName}`);
    }
    const existing = byCode ?? byName;
    if (!existing && testName) {
      const near = catalogue.find((t) => t.isActive && normaliseTestName(t.testName) === normaliseTestName(testName));
      if (near) {
        errors.push(`${near.testName} already exists under a near-identical name. Use its code to update it.`);
      }
    }
    if (existing && !existing.isActive) errors.push(`${existing.testName} is inactive. Put it back in use first.`);
    if (existing && byCode && testName && rangeNameKey(existing.testName) !== rangeNameKey(testName)) {
      // Renaming has its own safeguards on the edit screen; a file must not do it by accident.
      errors.push(`Code ${fields.testCode} is ${existing.testName}. Rename it on the test screen, not by import.`);
    }

    // --- parameters ---
    const prev = rawParams(existing?.parameters);
    const withParam = list.filter((r) => text(r.parameterName));
    const without = list.filter((r) => !text(r.parameterName));
    const parameters: RawParam[] = prev.map((p) => ({ ...p }));
    let touched = false;
    const seenParam = new Set<string>();

    const readRange = (r: ImportRow, label: string) => {
      const low = numeric(r.refLow);
      const high = numeric(r.refHigh);
      if (low === 'bad' || high === 'bad') {
        errors.push(`Row ${r.rowNumber}: range limits for ${label} must be numbers`);
        return null;
      }
      const values = { unit: text(r.parameterUnit), refLow: low, refHigh: high, refText: text(r.refText) };
      const bad = rangeProblem(values);
      if (bad) {
        errors.push(`Row ${r.rowNumber}: ${label}: ${bad}`);
        return null;
      }
      return values;
    };

    for (const r of withParam) {
      const name = text(r.parameterName)!;
      const pk = rangeNameKey(name);
      if (name.length > 150 || !pk) {
        errors.push(`Row ${r.rowNumber}: parameter name is not valid`);
        continue;
      }
      if (seenParam.has(pk)) {
        errors.push(`Row ${r.rowNumber}: ${name} is listed twice for this test`);
        continue;
      }
      seenParam.add(pk);
      const v = readRange(r, name);
      if (!v) continue;
      if (v.unit && v.unit.length > 50) errors.push(`Row ${r.rowNumber}: unit is longer than 50 characters`);
      const groupName = text(r.group)?.slice(0, 100) ?? null;
      const given = v.refLow != null || v.refHigh != null || v.refText != null;

      const at = parameters.findIndex((p) => rangeNameKey(p.name) === pk);
      if (at >= 0) {
        const p = parameters[at];
        const now = paramRange(p);
        const next: RawParam = { ...p };
        // Blank cells leave what is there. A range given in the file replaces
        // the whole range, so a stale second limit cannot survive beside it.
        if (v.unit) next.unit = v.unit;
        if (given) {
          next.refLow = v.refLow;
          next.refHigh = v.refHigh;
          next.refRangeText = v.refText;
        }
        if (groupName) next.group = groupName;
        const after = paramRange(next);
        const moved = formatRange(now) !== formatRange(after) || normaliseUnit(now.unit) !== normaliseUnit(after.unit);
        if (moved) {
          rangeChanges.push(
            `${name}: ${formatRange(now) || 'no range'} ${now.unit ?? ''} to ${formatRange(after) || 'no range'} ${after.unit ?? ''}`.replace(/\s+/g, ' ').trim(),
          );
        }
        if (moved || (groupName && groupName !== p.group)) touched = true;
        parameters[at] = next;
      } else {
        parameters.push({
          id: `imp_${pk.replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${parameters.length + 1}`,
          name,
          unit: v.unit,
          refLow: v.refLow,
          refHigh: v.refHigh,
          refRangeText: v.refText,
          group: groupName,
          inputType: v.refText && v.refLow == null && v.refHigh == null ? 'text' : 'number',
        });
        touched = true;
        changes.push(`Adds parameter ${name}`);
        if (given) rangeChanges.push(`${name}: ${formatRange(v)} ${v.unit ?? ''}`.trim());
      }
    }
    if (parameters.length > 100) errors.push('A test cannot have more than 100 parameters');
    const ids = parameters.map((p) => p.id);
    if (new Set(ids).size !== ids.length) errors.push('Two parameters would share an id. Add the new one on the test screen.');

    // --- a test without parameters ---
    let flat: { normalRange?: string; unit?: string } = {};
    const flatRows = without.filter((r) => text(r.refLow) || text(r.refHigh) || text(r.refText) || text(r.parameterUnit));
    if (flatRows.length > 0) {
      if (parameters.length > 0) {
        errors.push(`Row ${flatRows[0].rowNumber}: name the parameter this range belongs to`);
      } else if (flatRows.length > 1) {
        errors.push('More than one row gives a range for a test without parameters');
      } else {
        const v = readRange(flatRows[0], testName);
        if (v) {
          const range = formatRange(v);
          flat = { ...(range ? { normalRange: range } : {}), ...(v.unit ? { unit: v.unit } : {}) };
          if (range && range !== existing?.normalRange) rangeChanges.push(`${range} ${v.unit ?? ''}`.trim());
        }
      }
    }

    // --- what is written ---
    const payload: Built['payload'] = { testName: existing ? existing.testName : testName, ...flat };
    for (const [field, label] of TEXT_FIELDS) {
      const v = fields[field];
      if (!v) continue;
      if (field === 'testCode' && existing?.testCode) continue;
      payload[field] = v;
      if (existing && (existing[field] ?? '') !== v) changes.push(`${label}: ${existing[field] || 'blank'} to ${v}`);
    }
    if (typeof price === 'number') {
      payload.price = price;
      const was = existing?.price == null ? null : Number(existing.price);
      if (existing && was !== price) changes.push(`Price: ${was ?? 'blank'} to ${price}`);
    } else if (!existing) {
      warnings.push('No price: an unpriced test is not billed');
    }
    if (typeof tat === 'number') {
      payload.turnaroundHours = tat;
      if (existing && existing.turnaroundHours !== tat) changes.push(`Turnaround: ${existing.turnaroundHours ?? 'blank'} to ${tat} h`);
    }
    if (aliases) {
      payload.aliases = existing ? [...new Set([...existing.aliases, ...aliases])].slice(0, 25) : aliases;
      if (existing && payload.aliases.length !== existing.aliases.length) changes.push('Adds other names');
    }
    if (touched) payload.parameters = parameters as unknown as CreateTestInput['parameters'];
    if (existing && changes.length === 0 && rangeChanges.length === 0 && !touched) warnings.push('Nothing to change');

    const conflicts =
      errors.length > 0
        ? []
        : await newPriceConflicts(
            tenantId,
            existing
              ? { id: existing.id, testName: existing.testName, price: existing.price, parameters: existing.parameters, isActive: existing.isActive }
              : null,
            {
              id: existing?.id ?? '',
              testName: payload.testName,
              price: payload.price ?? existing?.price,
              parameters,
              isActive: true,
            },
          );

    plans.push({
      key,
      rowNumbers: list.map((r) => r.rowNumber),
      action: existing ? 'update' : 'create',
      testId: existing?.id ?? null,
      stamp: existing ? stampOf(existing) : null,
      testName: payload.testName || '(no name)',
      testCode: fields.testCode ?? existing?.testCode ?? null,
      changes,
      rangeChanges,
      priceConflicts: conflicts.map((c) => ({ ...c, message: describeConflict(c) })),
      errors,
      warnings,
      payload,
    });
  }

  // The same test must not be reachable twice: once by code, once by name.
  for (const p of plans) {
    const clash = plans.find(
      (o) =>
        o !== p &&
        ((p.testId !== null && o.testId === p.testId) ||
          (p.testId === null && o.testId === null && normaliseTestName(o.testName) === normaliseTestName(p.testName))),
    );
    if (clash) p.errors.push(`Rows ${clash.rowNumbers.join(', ')} are the same or a near-identical test`);
  }
  return plans;
}

function assertEditor(roles: string[]) {
  if (!roles.some((r) => EDITORS.has(r))) {
    throw AppError.forbidden('Only a hospital admin can import the lab catalogue');
  }
}

export async function previewImport(tenantId: string, roles: string[], rows: ImportRow[]) {
  assertEditor(roles);
  const plans = (await buildPlans(tenantId, rows)).map(({ payload: _p, ...plan }) => plan);
  return {
    tests: plans,
    summary: {
      rows: rows.length,
      create: plans.filter((p) => p.action === 'create' && p.errors.length === 0).length,
      update: plans.filter((p) => p.action === 'update' && p.errors.length === 0).length,
      errors: plans.filter((p) => p.errors.length > 0).length,
      needPriceReason: plans.filter((p) => p.errors.length === 0 && p.priceConflicts.length > 0).length,
    },
  };
}

export interface ImportConfirm {
  key: string;
  action: 'create' | 'update';
  testId?: string | null;
  stamp?: string | null;
  priceReason?: string | null;
}

export async function commitImport(
  tenantId: string,
  userId: string,
  roles: string[],
  rows: ImportRow[],
  confirmed: ImportConfirm[],
) {
  assertEditor(roles);
  const plans = new Map((await buildPlans(tenantId, rows)).map((p) => [p.key, p]));
  const results: Array<{ key: string; testName: string; status: 'saved' | 'failed'; message: string; rangeProposals?: number }> = [];

  for (const c of confirmed) {
    const plan = plans.get(c.key);
    const fail = (message: string) =>
      results.push({ key: c.key, testName: plan?.testName ?? c.key, status: 'failed', message });
    if (!plan) {
      fail('Not in the file');
      continue;
    }
    if (plan.errors.length > 0) {
      fail(plan.errors.join('; '));
      continue;
    }
    if (plan.action !== c.action || plan.testId !== (c.testId ?? null) || plan.stamp !== (c.stamp ?? null)) {
      fail('This test changed since the preview. Preview the file again.');
      continue;
    }
    const reason = c.priceReason?.trim();
    const priceConfirmation = reason ? { confirmed: true as const, reason } : undefined;
    try {
      const saved =
        plan.action === 'create'
          ? await createTest(
              tenantId,
              roles,
              { ...plan.payload, isCustom: true, isActive: true, priceConfirmation } as CreateTestInput,
              { userId, origin: 'import' },
            )
          : await updateTest(
              tenantId,
              roles,
              plan.testId!,
              {
                ...(plan.payload as UpdateTestInput),
                priceConfirmation,
                expectedRangeVersion: Number(plan.stamp!.split(':')[0]),
              },
              { userId, origin: 'import' },
            );
      results.push({
        key: c.key,
        testName: plan.testName,
        status: 'saved',
        message: plan.action === 'create' ? 'Added' : 'Updated',
        rangeProposals: saved.rangeProposals,
      });
    } catch (err) {
      // One bad test never undoes or blocks the others; each is its own save.
      if (!(err instanceof AppError)) throw err;
      fail(err.message);
    }
  }

  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_test_catalog',
    entityId: tenantId,
    description: `Lab catalogue import: ${results.filter((r) => r.status === 'saved').length} saved, ${results.filter((r) => r.status === 'failed').length} failed`,
  });
  return {
    results,
    saved: results.filter((r) => r.status === 'saved').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}
