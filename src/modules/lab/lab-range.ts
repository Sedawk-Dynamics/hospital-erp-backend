// Gap 369: pure reference-range helpers. No database, no I/O — everything that
// decides what counts as "the live range" and what must wait for a pathologist
// lives here so it can be tested on its own.
import { createHash } from 'crypto';
import { AppError } from '../../shared/appError';

/** parameterKey of the flat `normalRange` / `unit` on the test row itself. */
export const TEST_LEVEL_KEY = '__test__';

/** LabResult.normalRange is VarChar(100): a longer text could never be reported. */
export const RANGE_TEXT_MAX = 100;

export interface RangeValues {
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
}

export interface LiveRange extends RangeValues {
  key: string;
  name: string;
  inputType: 'number' | 'text' | 'select';
  sampleType: string | null;
}

export interface RangeQualifier {
  sex?: 'male' | 'female' | 'any' | null;
  ageMinYears?: number | null;
  ageMaxYears?: number | null;
  low?: number | null;
  high?: number | null;
}

export interface TestRangeFields {
  testName: string;
  sampleType?: string | null;
  normalRange?: string | null;
  unit?: string | null;
  parameters?: unknown;
}

export type RawParam = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function rawParams(parameters: unknown): RawParam[] {
  return Array.isArray(parameters)
    ? (parameters.filter((p) => p && typeof p === 'object') as RawParam[])
    : [];
}

/**
 * Identity of an analyte name. Case, punctuation and haemo/hemo spelling do not
 * matter; every word does, brackets included: "Glucose (Fasting)" and
 * "Glucose (PP)" must never share a range.
 */
export function rangeNameKey(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/haemo/g, 'hemo')
    .replace(/[^a-z0-9%+]+/g, ' ')
    .trim();
}

/** Units equal apart from whitespace, the micro sign and the case of "litre". */
export function normaliseUnit(unit: unknown): string {
  return String(unit ?? '')
    .replace(/[µμ]/g, 'u')
    .replace(/×/g, 'x')
    .replace(/\s+/g, '')
    .replace(
      /(^|\/)([dmunfp]?)l(?![a-z])/g,
      (_m, sep: string, prefix: string) => `${sep}${prefix}L`,
    );
}

export function hasRange(r: Pick<RangeValues, 'refLow' | 'refHigh' | 'refText'>): boolean {
  return r.refLow != null || r.refHigh != null || r.refText != null;
}

export function paramRange(p: RawParam): RangeValues {
  return {
    unit: str(p.unit),
    refLow: num(p.refLow),
    refHigh: num(p.refHigh),
    // `normalRange` is the deprecated free-text spelling some rows still carry.
    refText: str(p.refRangeText) ?? str(p.normalRange),
  };
}

/** Same text the result-entry grid prints, so entry, report and catalogue agree. */
export function formatRange(r: Pick<RangeValues, 'refLow' | 'refHigh' | 'refText'>): string {
  if (r.refLow != null && r.refHigh != null) return `${r.refLow}–${r.refHigh}`;
  if (r.refLow != null) return `≥ ${r.refLow}`;
  if (r.refHigh != null) return `≤ ${r.refHigh}`;
  return r.refText ?? '';
}

/** Every range slot on a test: one per parameter, plus the flat one if used. */
export function liveRanges(test: TestRangeFields): LiveRange[] {
  const sampleType = str(test.sampleType);
  const out: LiveRange[] = [];
  const params = rawParams(test.parameters);
  for (const p of params) {
    const key = str(p.id);
    const name = str(p.name);
    if (!key || !name) continue;
    const inputType = p.inputType === 'text' || p.inputType === 'select' ? p.inputType : 'number';
    out.push({ key, name, inputType, sampleType, ...paramRange(p) });
  }
  const flat = str(test.normalRange);
  if (params.length === 0 || flat) {
    out.push({
      key: TEST_LEVEL_KEY,
      name: test.testName,
      inputType: 'number',
      sampleType,
      unit: str(test.unit),
      refLow: null,
      refHigh: null,
      refText: flat,
    });
  }
  return out;
}

export function liveRangeFor(test: TestRangeFields, key: string): LiveRange | null {
  return liveRanges(test).find((r) => r.key === key) ?? null;
}

/**
 * Fingerprint of a live range. It covers what the range MEANS (analyte, unit
 * and sample type as well as the numbers), so a sign-off stops counting as soon
 * as any of them changes by whatever route.
 */
export function rangeHash(r: LiveRange): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        rangeNameKey(r.name),
        normaliseUnit(r.unit),
        r.refLow,
        r.refHigh,
        r.refText,
        (r.sampleType ?? '').toLowerCase(),
      ]),
    )
    .digest('hex');
}

/** Plain object for the proposal's JSON snapshots. */
export function snapshotRange(r: LiveRange): Record<string, unknown> {
  return {
    name: r.name,
    unit: r.unit,
    refLow: r.refLow,
    refHigh: r.refHigh,
    refText: r.refText,
    sampleType: r.sampleType,
  };
}

/** Why a set of values cannot be a reference range, or null when it can. */
export function rangeProblem(v: RangeValues): string | null {
  for (const n of [v.refLow, v.refHigh]) {
    if (n != null && (!Number.isFinite(n) || Math.abs(n) > 1e9)) {
      return 'The range limits must be ordinary numbers';
    }
  }
  if (v.refLow != null && v.refHigh != null && v.refLow >= v.refHigh) {
    return `The low limit (${v.refLow}) must be below the high limit (${v.refHigh})`;
  }
  if (v.refText != null && v.refText.length > RANGE_TEXT_MAX) {
    return `The range text must be ${RANGE_TEXT_MAX} characters or fewer so it fits on the report`;
  }
  return null;
}

export function qualifierProblem(groups: RangeQualifier[]): string | null {
  for (const g of groups) {
    if (g.low == null && g.high == null) return 'Every sex/age group needs a low or a high limit';
    const bad = rangeProblem({ unit: null, refLow: g.low ?? null, refHigh: g.high ?? null, refText: null });
    if (bad) return bad;
    for (const a of [g.ageMinYears, g.ageMaxYears]) {
      if (a != null && (!Number.isFinite(a) || a < 0 || a > 130)) {
        return 'Ages must be between 0 and 130 years';
      }
    }
    if (g.ageMinYears != null && g.ageMaxYears != null && g.ageMinYears >= g.ageMaxYears) {
      return 'The lower age must be below the upper age';
    }
  }
  return null;
}

/** Sex/age groups as the one printable line the live format can hold. */
export function qualifiersToText(groups: RangeQualifier[]): string {
  return groups
    .map((g) => {
      const sex = g.sex === 'male' ? 'Male' : g.sex === 'female' ? 'Female' : '';
      let age = '';
      if (g.ageMinYears != null && g.ageMaxYears != null) age = `${g.ageMinYears}-${g.ageMaxYears} y`;
      else if (g.ageMinYears != null) age = `from ${g.ageMinYears} y`;
      else if (g.ageMaxYears != null) age = `under ${g.ageMaxYears} y`;
      const label = [sex, age].filter(Boolean).join(' ') || 'All';
      return `${label}: ${formatRange({ refLow: g.low ?? null, refHigh: g.high ?? null, refText: null })}`;
    })
    .join('; ');
}

export function sameValues(a: RangeValues, b: RangeValues): boolean {
  return (
    normaliseUnit(a.unit) === normaliseUnit(b.unit) &&
    a.refLow === b.refLow &&
    a.refHigh === b.refHigh &&
    a.refText === b.refText
  );
}

// -------------------------------------------------------------
// Splitting an edit into "live now" and "needs a pathologist"
// -------------------------------------------------------------

export interface ProposalDraft {
  key: string;
  name: string;
  values: RangeValues;
}

export interface SplitResult {
  /** undefined = leave the column as it is. */
  live: { parameters?: RawParam[] | null; normalRange?: string | null; unit?: string | null };
  drafts: ProposalDraft[];
}

export interface SplitInput {
  existing: TestRangeFields | null;
  next: {
    testName?: string | null;
    parameters?: unknown[] | null;
    normalRange?: string | null;
    unit?: string | null;
  };
  /**
   * What to do when a parameter (or a flat test) that HAS a live range is
   * renamed to something else. 'refuse' raises RANGE_RENAME so the editor can
   * decide; 'reset' takes the range out of use and re-proposes it under the new
   * name. Carrying a range over to a different analyte is never an option.
   */
  onRename: 'refuse' | 'reset';
}

function blankRange(p: RawParam): RawParam {
  const rest = { ...p };
  delete rest.normalRange;
  return { ...rest, refLow: null, refHigh: null, refRangeText: null };
}

function withRange(p: RawParam, from: RawParam): RawParam {
  const rest = { ...p };
  delete rest.normalRange;
  const out: RawParam = {
    ...rest,
    refLow: from.refLow ?? null,
    refHigh: from.refHigh ?? null,
    refRangeText: from.refRangeText ?? null,
  };
  if (from.normalRange !== undefined) out.normalRange = from.normalRange;
  return out;
}

/**
 * Separate a catalogue save into the part that may go live at once and the
 * reference-range changes that must wait for a pathologist.
 *
 * The live result never contains a range the existing row did not already have
 * for that same analyte and unit.
 */
export function splitRangeEdits(input: SplitInput): SplitResult {
  const { existing, next, onRename } = input;
  const live: SplitResult['live'] = {};
  const drafts: ProposalDraft[] = [];
  const renamed: string[] = [];

  if (next.parameters === null) {
    live.parameters = null;
  } else if (next.parameters !== undefined) {
    const prev = rawParams(existing?.parameters);
    const incoming = rawParams(next.parameters);

    const ids = incoming.map((p) => str(p.id));
    if (new Set(ids).size !== ids.length) {
      throw AppError.badRequest(
        'Two parameters share the same id. Remove one and add it again.',
        'DUPLICATE_PARAMETER',
      );
    }

    const match = new Map<RawParam, RawParam>();
    const used = new Set<RawParam>();
    const sameId = (a: RawParam, b: RawParam) => str(a.id) != null && str(a.id) === str(b.id);
    const sameName = (a: RawParam, b: RawParam) =>
      rangeNameKey(a.name) !== '' && rangeNameKey(a.name) === rangeNameKey(b.name);
    const pair = (test: (a: RawParam, b: RawParam) => boolean) => {
      for (const p of incoming) {
        if (match.has(p)) continue;
        const hit = prev.find((q) => !used.has(q) && test(p, q));
        if (hit) {
          match.set(p, hit);
          used.add(hit);
        }
      }
    };
    pair((a, b) => sameId(a, b) && sameName(a, b));
    pair(sameName);
    pair(sameId);

    live.parameters = incoming.map((p) => {
      const q = match.get(p);
      const want = paramRange(p);
      const name = str(p.name) ?? '';

      if (q && sameName(p, q)) {
        // Keep the id the history and sign-off are filed under.
        const key = str(q.id) ?? str(p.id) ?? '';
        const now = paramRange(q);
        const base: RawParam = { ...p, id: key };
        if (!hasRange(now) && !hasRange(want)) return blankRange(base);
        if (sameValues(now, want)) return withRange(base, q);
        drafts.push({ key, name, values: want });
        const kept = withRange(base, q);
        // A unit is part of what a range means, so it moves with it, unless
        // there is no live range yet for the unit to change the meaning of.
        return hasRange(now) ? { ...kept, unit: q.unit ?? null } : kept;
      }

      if (q && hasRange(paramRange(q))) renamed.push(`${str(q.name)} to ${name}`);
      if (hasRange(want)) drafts.push({ key: str(p.id) ?? '', name, values: want });
      return blankRange(p);
    });
  }

  if (next.normalRange !== undefined || next.unit !== undefined || next.testName !== undefined) {
    const nowRange = str(existing?.normalRange);
    const nowUnit = str(existing?.unit);
    const wantRange = next.normalRange === undefined ? nowRange : str(next.normalRange);
    const wantUnit = next.unit === undefined ? nowUnit : str(next.unit);
    const name = str(next.testName) ?? existing?.testName ?? '';
    const draft = (): ProposalDraft => ({
      key: TEST_LEVEL_KEY,
      name,
      values: { unit: wantUnit, refLow: null, refHigh: null, refText: wantRange },
    });

    if (existing && nowRange != null && rangeNameKey(name) !== rangeNameKey(existing.testName)) {
      renamed.push(`${existing.testName} to ${name}`);
      live.normalRange = null;
      if (wantUnit !== nowUnit) live.unit = wantUnit;
      if (wantRange != null) drafts.push(draft());
    } else if (nowRange == null) {
      if (next.unit !== undefined && wantUnit !== nowUnit) live.unit = wantUnit;
      if (wantRange != null) drafts.push(draft());
    } else if (wantRange !== nowRange || normaliseUnit(nowUnit) !== normaliseUnit(wantUnit)) {
      drafts.push(draft());
    }
  }

  if (renamed.length > 0 && onRename === 'refuse') {
    throw AppError.conflict(
      `Renaming would attach an existing reference range to a different name (${renamed.join('; ')}). ` +
        'Confirm to take the range out of use until a pathologist approves it under the new name.',
      'RANGE_RENAME',
      { renamed },
    );
  }

  return { live, drafts };
}

/** Catalogue columns to write when a pathologist approves values for one slot. */
export function applyRangeToTest(
  test: TestRangeFields,
  key: string,
  values: RangeValues,
): { parameters?: RawParam[]; normalRange?: string | null; unit?: string | null } {
  if (key === TEST_LEVEL_KEY) {
    return { normalRange: formatRange(values) || null, unit: values.unit };
  }
  return {
    parameters: rawParams(test.parameters).map((p) => {
      if (str(p.id) !== key) return p;
      const rest = { ...p };
      delete rest.normalRange;
      return {
        ...rest,
        unit: values.unit,
        refLow: values.refLow,
        refHigh: values.refHigh,
        refRangeText: values.refText,
      };
    }),
  };
}

/**
 * The range the CATALOGUE says applies to a result row, for the server-side
 * snapshot at result entry. `known: false` means the catalogue does not define
 * this row (a free-form line) and the typed range stands.
 */
export function catalogueRangeForResult(
  test: TestRangeFields | null | undefined,
  parameterName: string,
): { known: boolean; range: string | null; unit: string | null } {
  const none = { known: false, range: null, unit: null };
  if (!test) return none;
  const wanted = parameterName.trim().toLowerCase();
  const params = rawParams(test.parameters);
  if (params.length > 0) {
    const p = params.find((x) => str(x.name)?.toLowerCase() === wanted);
    if (!p) return none;
    const r = paramRange(p);
    return { known: true, range: formatRange(r) || null, unit: r.unit };
  }
  const flat = str(test.normalRange);
  if (flat && rangeNameKey(test.testName) === rangeNameKey(parameterName)) {
    return { known: true, range: flat, unit: str(test.unit) };
  }
  return none;
}
