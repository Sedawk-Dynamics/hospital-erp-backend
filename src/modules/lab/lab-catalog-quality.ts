import { prisma } from '../../config/database';

// ============================================================
// Gap 369: catalogue review flags for the Lab Admin.
//
// QA found placeholder text in live catalogue rows (Haemoglobin's specimen
// read "specimen collections notes", its instructions "description patient
// instructions"), near-duplicate thyroid tests, and a single analyte priced
// above the panel that contains it (Haemoglobin ₹700 vs CBC ₹350). The seed
// files do not produce any of this — it was typed in. Prices and ranges are
// clinical/commercial data a lab owner must review, so this only FLAGS them;
// nothing is changed.
// ============================================================

export type CatalogIssueKind = 'placeholder_text' | 'duplicate_name' | 'price_above_panel';

export interface CatalogIssue {
  kind: CatalogIssueKind;
  testIds: string[];
  testNames: string[];
  field?: string;
  message: string;
}

interface CatalogRow {
  id: string;
  testName: string;
  description?: string | null;
  instructions?: string | null;
  specimen?: string | null;
  interpretation?: string | null;
  normalRange?: string | null;
  price?: unknown;
  parameters?: unknown;
}

// Words that only ever appear in form-field labels or filler. A value made up
// entirely of these is a label typed into its own box, not real content.
const PLACEHOLDER_WORDS = new Set([
  'specimen', 'specimens', 'collection', 'collections', 'note', 'notes', 'description', 'descriptions',
  'patient', 'patients', 'instruction', 'instructions', 'interpretation', 'normal', 'range', 'ranges',
  'test', 'tests', 'sample', 'text', 'placeholder', 'enter', 'here', 'lorem', 'ipsum', 'dummy',
  'tbd', 'todo', 'xxx', 'xx', 'asdf', 'abc', 'qwerty', 'demo', 'details', 'info',
]);

const TEXT_FIELDS = ['description', 'instructions', 'specimen', 'interpretation', 'normalRange'] as const;

export function isPlaceholderText(value: string | null | undefined): boolean {
  if (!value) return false;
  const words = value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => PLACEHOLDER_WORDS.has(w));
}

/** Name key that ignores case, punctuation and the bracketed analyte list. */
export function normaliseTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/haemo/g, 'hemo')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

function parameterNames(params: unknown): string[] {
  if (!Array.isArray(params)) return [];
  return params
    .map((p) => (p && typeof p === 'object' ? (p as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

export function findCatalogIssues(rows: CatalogRow[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  for (const r of rows) {
    for (const f of TEXT_FIELDS) {
      const v = r[f];
      if (isPlaceholderText(v)) {
        issues.push({
          kind: 'placeholder_text', testIds: [r.id], testNames: [r.testName], field: f,
          message: `${r.testName}: ${f} looks like placeholder text ("${v}")`,
        });
      }
    }
  }

  const byKey = new Map<string, CatalogRow[]>();
  for (const r of rows) {
    const key = normaliseTestName(r.testName);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    issues.push({
      kind: 'duplicate_name', testIds: group.map((g) => g.id), testNames: group.map((g) => g.testName),
      message: `Possible duplicates: ${group.map((g) => g.testName).join(' / ')}`,
    });
  }

  // A single-analyte test priced above a panel that reports the same analyte.
  for (const single of rows) {
    const price = num(single.price);
    if (price == null) continue;
    const key = normaliseTestName(single.testName);
    for (const panel of rows) {
      if (panel.id === single.id) continue;
      const panelPrice = num(panel.price);
      if (panelPrice == null || price <= panelPrice) continue;
      const names = parameterNames(panel.parameters);
      if (names.length < 2) continue;
      if (names.some((n) => normaliseTestName(n) === key)) {
        issues.push({
          kind: 'price_above_panel', testIds: [single.id, panel.id], testNames: [single.testName, panel.testName],
          message: `${single.testName} (₹${price}) costs more than ${panel.testName} (₹${panelPrice}), which includes it`,
        });
      }
    }
  }

  return issues;
}

export async function getCatalogQualityFlags(tenantId: string) {
  const rows = await prisma.labTestCatalog.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true, testName: true, description: true, instructions: true, specimen: true,
      interpretation: true, normalRange: true, price: true, parameters: true,
    },
  });
  return findCatalogIssues(rows);
}
