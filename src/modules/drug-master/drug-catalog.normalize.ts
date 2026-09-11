/**
 * Reading the vendor's drug catalogue.
 *
 * The bundled release (prisma/scripts/data/drug-catalog, built by
 * prisma/scripts/build-drug-catalog.py) carries the vendor's rows in the
 * vendor's own words. Everything that INTERPRETS them lives here — what
 * "Prescription Required" means, which DosageForm a "Tablet SR" is, how many
 * loose units a strip holds — so changing how a field is read never needs the
 * bundle rebuilt, and a vendor CSV uploaded through the Refresh dialog is read
 * exactly the way the bundled release is.
 *
 * Pure: no prisma, no io.
 */

import {
  buildDrugSearchTokens,
  inferDosageForm,
  parseCsv,
  parsePackSize,
  DEFAULT_SOLID_PACK_SIZE,
  type DosageForm,
} from './drug-master.dataset';

export type CatalogKind = 'drug' | 'otc';

// ─────────────────────────────────────────────────────────────
// Shared texts
// ─────────────────────────────────────────────────────────────

/**
 * Stands in for the product's own name inside a shared text. The vendor writes
 * one text per molecule and pastes each brand's name into it; taking the name
 * back out is what lets 399,090 drugs share ~37 MB of prose instead of 1.5 GB.
 */
export const TEMPLATE_PLACEHOLDER = '{{name}}';

// Mirrors build-drug-catalog.py. A name longer than the column is truncated on
// the way in, so a template of it would render wrong; a very short one would
// template every word it happens to begin ("Ace" inside "Aceclofenac").
const TEMPLATE_NAME_MIN = 3;
const TEMPLATE_NAME_MAX = 255;

/** Take the product's name out of a text, exactly as the bundle builder does. */
export function templateText(text: string, name: string): string {
  const n = name.trim();
  if (n.length < TEMPLATE_NAME_MIN || n.length > TEMPLATE_NAME_MAX) return text;
  return text.split(n).join(TEMPLATE_PLACEHOLDER);
}

/** Put the product's name back. `renderTemplate(templateText(t, n), n) === t`. */
export function renderTemplate(body: string, name: string): string {
  return body.split(TEMPLATE_PLACEHOLDER).join(name);
}

export interface MonographSection {
  key: string;
  /** The vendor's column, in the workbook and in an uploaded CSV. */
  column: string;
  title: string;
}

/** Display order. The keys are what DrugMaster.monograph stores. */
export const MONOGRAPH_SECTIONS: Record<CatalogKind, readonly MonographSection[]> = {
  drug: [
    { key: 'intro', column: 'Introduction', title: 'About' },
    { key: 'benefits', column: 'Benefits', title: 'Benefits' },
    { key: 'howToUse', column: 'how_to_use', title: 'How to use' },
    { key: 'howItWorks', column: 'How it works', title: 'How it works' },
    { key: 'safetyAdvice', column: 'safety_advise', title: 'Safety advice' },
    { key: 'missedDose', column: 'if_miss', title: 'If a dose is missed' },
    { key: 'interactions', column: 'drug-drug Interaction', title: 'Drug interactions' },
    { key: 'faq', column: 'Q_A', title: 'Questions and answers' },
    { key: 'marketer', column: 'Marketer details', title: 'Marketer' },
  ],
  otc: [
    { key: 'highlights', column: 'product_highlights', title: 'Highlights' },
    { key: 'information', column: 'Information', title: 'About' },
    { key: 'ingredients', column: 'Key Ingredients', title: 'Key ingredients' },
    { key: 'benefits', column: 'Key Benefits', title: 'Key benefits' },
    { key: 'directions', column: 'Directions for Use', title: 'Directions for use' },
    { key: 'safetyInfo', column: 'Safety Information', title: 'Safety information' },
    { key: 'marketer', column: 'Marketer details', title: 'Marketer' },
  ],
};

// ─────────────────────────────────────────────────────────────
// Field readers
// ─────────────────────────────────────────────────────────────

type VendorRecord = Record<string, string | null | undefined>;

function text(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

function clamp(v: string | null, max: number): string | null {
  if (v == null) return null;
  return v.length > max ? v.slice(0, max).trimEnd() : v;
}

/** "Vomiting | Nausea|Headache" → "Vomiting; Nausea; Headache". */
export function listText(v: string | null | undefined): string | null {
  const items = (v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items.join('; ') : null;
}

/** "Prefilled syringe" / "Prefilled Syringe" → one spelling. */
export function titleCaseWords(v: string | null | undefined): string | null {
  const t = text(v);
  if (!t) return null;
  return t.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/**
 * MRP per pack. The vendor writes a bare number; zero means it has none, and a
 * value the Decimal(10,2) column cannot hold is a data error, not a price.
 */
export function parseMrp(v: string | null | undefined): number | null {
  const t = text(v);
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 1e8) return null;
  return Math.round(n * 100) / 100;
}

/**
 * A handful of rows carry an address fragment ("</strong> 5th Floor Tower…")
 * where the country belongs. A country is a short name with no markup.
 */
export function cleanCountry(v: string | null | undefined): string | null {
  const t = text(v);
  if (!t || /[<>]/.test(t) || t.length > 60 || /\d/.test(t)) return null;
  return t;
}

/** "Home > Baby Care > Diapers > <the product's own name>" → "Baby Care > Diapers". */
export function categoryTrail(v: string | null | undefined, name: string): string | null {
  const parts = (v ?? '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts[0]?.toLowerCase() === 'home') parts.shift();
  if (parts.length && parts[parts.length - 1].toLowerCase() === name.trim().toLowerCase()) parts.pop();
  return parts.length ? parts.join(' > ') : null;
}

export interface FactBox {
  therapeuticClass: string | null;
  chemicalClass: string | null;
  actionClass: string | null;
  habitForming: boolean | null;
}

/**
 * "Chemical Class :: Dichlorobenzenes|Habit Forming :: No|Therapeutic Class ::
 * PAIN ANALGESICS|Action Class :: NSAID's- Non-Selective COX 1&2 Inhibitors"
 */
export function parseFactBox(v: string | null | undefined): FactBox {
  const out: FactBox = { therapeuticClass: null, chemicalClass: null, actionClass: null, habitForming: null };
  for (const part of (v ?? '').split('|')) {
    const i = part.indexOf('::');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 2).trim();
    if (!value) continue;
    if (key === 'therapeutic class') out.therapeuticClass = value;
    else if (key === 'chemical class') out.chemicalClass = value;
    else if (key === 'action class') out.actionClass = value;
    else if (key === 'habit forming') {
      if (/^yes\b/i.test(value)) out.habitForming = true;
      else if (/^no\b/i.test(value)) out.habitForming = false;
    }
  }
  return out;
}

export type SafetyTopic = 'alcohol' | 'pregnancy' | 'lactation' | 'driving' | 'kidney' | 'liver';
export type SafetyVerdict =
  | 'safe'
  | 'safe_if_prescribed'
  | 'caution'
  | 'unsafe'
  | 'consult_doctor'
  | 'not_relevant';

const SAFETY_COLUMNS: Record<SafetyTopic, string> = {
  alcohol: 'alcoholInteraction',
  pregnancy: 'pregnancyInteraction',
  lactation: 'lactationInteraction',
  driving: 'drivingInteraction',
  kidney: 'kidneyInteraction',
  liver: 'liverInteraction',
};

const VERDICTS: Record<string, SafetyVerdict> = {
  'SAFE': 'safe',
  'SAFE IF PRESCRIBED': 'safe_if_prescribed',
  'CAUTION': 'caution',
  'UNSAFE': 'unsafe',
  'CONSULT YOUR DOCTOR': 'consult_doctor',
  'NOT RELEVANT': 'not_relevant',
};

/** The six one-word verdicts. An unrecognised word is dropped, never guessed. */
export function parseSafetyAdvice(rec: VendorRecord): Partial<Record<SafetyTopic, SafetyVerdict>> | null {
  const out: Partial<Record<SafetyTopic, SafetyVerdict>> = {};
  for (const [topic, column] of Object.entries(SAFETY_COLUMNS) as [SafetyTopic, string][]) {
    const verdict = VERDICTS[(rec[column] ?? '').trim().toUpperCase()];
    if (verdict) out[topic] = verdict;
  }
  return Object.keys(out).length ? out : null;
}

export interface DrugInteraction {
  drug: string;
  route: string | null;
  severity: string | null;
  advice: string;
}

// "-Tacrolimus (Oral Route): Severe <p> advice <p>" — molecule against molecule.
const ENTRY_MOLECULE = /^-\s*([^:]+?)\s*(?:\(([^()]*)\))?\s*:\s*([^<]*?)\s*<p>([\s\S]*?)(?:<p>)?\s*$/;
// "2-Pnol Tablet 20 & Regubeat 100mg Tablet : <p> advice" — brand against brand.
const ENTRY_BRAND = /^(.+?)\s+&\s+(.+?)\s*:\s*<p>([\s\S]*?)(?:<p>)?\s*$/;
const ENTRY_START = /^(?:-\s*[^:|]+:\s*[^<|]*<p>|[^|:]+?\s&\s[^|:]+?:\s*<p>)/;

/**
 * The vendor's interaction list, in either of its two layouts:
 *
 *   "-Tacrolimus (Oral Route): Severe <p> advice <p> | -Methotrexate (…): …"
 *   "Acenac Tablet & Regubeat 100mg Tablet : <p> advice | …"
 *
 * Entries are separated by "|", which is split on only where the next piece
 * really starts an entry, so a "|" inside the advice cannot cut one in two. A
 * bracket is the route only when it says so — "Cholera Vaccine (Inactivated)
 * (Oral Route)" keeps "(Inactivated)" in the name. In the brand layout the
 * product itself is one side of the "&"; the other side is the interaction.
 */
export function parseInteractions(v: string | null | undefined, productName?: string): DrugInteraction[] {
  const entries: string[] = [];
  for (const piece of (v ?? '').split(/\s*\|\s*/)) {
    if (!piece) continue;
    if (!entries.length || ENTRY_START.test(piece)) entries.push(piece);
    else entries[entries.length - 1] += ` | ${piece}`;
  }

  const self = (s: string) =>
    s.includes(TEMPLATE_PLACEHOLDER) || (!!productName && s.toLowerCase() === productName.trim().toLowerCase());

  const out: DrugInteraction[] = [];
  for (const entry of entries) {
    const m = ENTRY_MOLECULE.exec(entry);
    if (m) {
      let drug = m[1].trim();
      let route: string | null = m[2]?.trim() || null;
      if (route && /^none$/i.test(route)) route = null;
      else if (route && !/route/i.test(route)) {
        drug = `${drug} (${route})`;
        route = null;
      }
      if (drug) out.push({ drug, route, severity: m[3].trim() || null, advice: m[4].trim() });
      continue;
    }
    const b = ENTRY_BRAND.exec(entry);
    if (b) {
      const [left, right] = [b[1].trim(), b[2].trim()];
      const drug = self(right) && !self(left) ? left : right;
      if (drug) out.push({ drug, route: null, severity: null, advice: b[3].trim() });
    }
  }
  return out;
}

/**
 * The list the catalogue row keeps for itself — the drug and how bad, in the
 * { drug[], effect[] } shape the column has always had. The advice itself is
 * in the monograph.
 */
export function interactionSummary(
  list: DrugInteraction[],
): { drug: string[]; effect: string[] } | null {
  const seen = new Set<string>();
  const drug: string[] = [];
  const effect: string[] = [];
  for (const i of list) {
    const key = i.drug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    drug.push(i.drug);
    effect.push(i.severity ?? '');
  }
  return drug.length ? { drug, effect } : null;
}

// ─────────────────────────────────────────────────────────────
// Displaying a monograph
// ─────────────────────────────────────────────────────────────

/**
 * A section as data, so no screen ever renders the vendor's markup as HTML.
 * The texts separate paragraphs with "<p>", list items with "|", and a question
 * from its answer with ":::".
 */
export type SectionBlock =
  | { type: 'paragraphs'; paragraphs: string[] }
  | { type: 'list'; items: string[] }
  | { type: 'faq'; items: Array<{ question: string; answer: string }> }
  | { type: 'verdicts'; items: Array<{ topic: string; verdict: string | null; text: string }> }
  | { type: 'interactions'; items: DrugInteraction[] };

const TAGS = /<\/?(?:p|br|strong|b|i|em|u|span|div|ul|ol|li|h[1-6]|sup|sub|a)\b[^>]*>/gi;

/** Plain text: the vendor's few tags and entities removed, spacing tidied. */
export function plainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(TAGS, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphs(body: string): string[] {
  return body.split(/<p>|\n+/i).map(plainText).filter(Boolean);
}

function items(body: string): string[] {
  return body.split('|').map(plainText).filter(Boolean);
}

/** One rendered section (the product's name already put back) as blocks. */
export function structureSection(key: string, body: string): SectionBlock {
  if (key === 'faq') {
    const qa = body
      .split(/\s*\|\s*(?=[^|]*:::)/)
      .map((entry) => {
        const i = entry.indexOf(':::');
        return i < 0
          ? { question: '', answer: plainText(entry) }
          : { question: plainText(entry.slice(0, i)), answer: plainText(entry.slice(i + 3)) };
      })
      .filter((e) => e.question || e.answer);
    return { type: 'faq', items: qa };
  }
  if (key === 'safetyAdvice') {
    const verdicts = body
      .split(/\s*\|\s*(?=-\s*[A-Za-z][^:|]*:)/)
      .map((entry) => {
        const m = /^\s*-\s*([^:]+?)\s*:\s*([A-Z][A-Z ]*?)\s*<p>([\s\S]*)$/.exec(entry);
        return m
          ? { topic: plainText(m[1]), verdict: m[2].trim(), text: plainText(m[3]) }
          : { topic: '', verdict: null, text: plainText(entry) };
      })
      .filter((e) => e.topic || e.text);
    return { type: 'verdicts', items: verdicts };
  }
  if (key === 'interactions') {
    return {
      type: 'interactions',
      items: parseInteractions(body).map((i) => ({ ...i, advice: plainText(i.advice) })),
    };
  }
  if (key === 'highlights' || key === 'marketer' || (key === 'benefits' && body.includes('|'))) {
    return { type: 'list', items: items(body) };
  }
  return { type: 'paragraphs', paragraphs: paragraphs(body) };
}

// ─────────────────────────────────────────────────────────────
// Dosage form and pack
// ─────────────────────────────────────────────────────────────

const INHALED = /inhal|rotacap|respule|\bmdi\b|\bdpi\b|nebul|transcap|octacap|redicap/;
const INJECTED = /injection|infusion|\bvial\b|ampoule|prefilled|pre-filled|\bpen\b|penfill|flexpen|cartridge/;
const TABLET = /tablet|\btab\b|caplet/;
const CAPSULE = /capsule|softgel|soft gel|vegicap|\bcap\b/;
const TOPICAL = /cream|ointment|\bgel\b|emulgel|lotion|balm|liniment|salve/;
const DROPS = /drop|\beye\b|\bear\b|nasal/;
const LIQUID = /syrup|suspension|solution|elixir|linctus|emulsion|liquid|sachet|granule/;
const OTC_LIQUID = /^(syrup|dry syrup|suspension|oral suspension)$/;

/**
 * The vendor's form, reduced to the DosageForm enum.
 *
 * A drug's form is read in full — it is the vendor stating what the product is,
 * and it agrees with what the old name-and-pack guess produced. An OTC form is
 * read narrowly on purpose: "Cream", "Liquid" and "Powder" are the words for a
 * face cream, a hand wash and a protein shake as much as for a medicine, and a
 * DosageForm is what the GST backfill reads to call something a medicament. So
 * an OTC product is a tablet, capsule, syrup or drop only when it plainly is
 * one, and `other` otherwise.
 */
export function mapVendorForm(
  kind: CatalogKind,
  form: string | null | undefined,
  name: string,
  packLabel: string | null,
): DosageForm | null {
  const f = (form ?? '').toLowerCase().trim();
  if (!f) return kind === 'drug' ? inferDosageForm(name, packLabel ?? '') : 'other';
  if (kind === 'otc') {
    if (TABLET.test(f)) return 'tablet';
    if (CAPSULE.test(f)) return 'capsule';
    if (OTC_LIQUID.test(f)) return 'syrup';
    if (/^(oral drop|drop|drops)$/.test(f)) return 'drops';
    return 'other';
  }
  if (INHALED.test(f)) return 'inhaler';
  if (INJECTED.test(f)) return 'injection';
  if (TABLET.test(f)) return 'tablet';
  if (CAPSULE.test(f)) return 'capsule';
  if (TOPICAL.test(f)) return 'cream';
  if (DROPS.test(f)) return 'drops';
  if (LIQUID.test(f)) return 'syrup';
  return 'other';
}

/**
 * Loose units per pack. The label is read first, exactly as before
 * ("strip of 10 tablets" → 10). Where a strip of tablets or capsules has a label
 * the parser cannot read ("strip of 15 soft gelatin capsules"), the vendor's
 * own count wins over the typical-strip guess of 10. Everything else — bottles,
 * vials, tubes — stays an indivisible container.
 */
export function resolveCatalogPackSize(
  dosageForm: DosageForm | null,
  packLabel: string | null,
  qty: string | null,
): number | null {
  const parsed = parsePackSize(packLabel);
  if (parsed != null) return parsed;
  if (dosageForm !== 'tablet' && dosageForm !== 'capsule') return null;
  const m = /^\s*(\d+)(?:\.0+)?\s*$/.exec(qty ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 1 ? n : DEFAULT_SOLID_PACK_SIZE;
}

// ─────────────────────────────────────────────────────────────
// A whole row
// ─────────────────────────────────────────────────────────────

export interface CatalogProduct {
  kind: CatalogKind;
  sourceId: string | null;
  name: string;
  genericName: string | null;
  saltComposition: string | null;
  manufacturer: string | null;
  type: CatalogKind;
  dosageForm: DosageForm | null;
  packSizeLabel: string | null;
  packSize: number | null;
  mrp: number | null;
  packageType: string | null;
  packQuantity: string | null;
  productForm: string | null;
  rxRequired: boolean;
  habitForming: boolean | null;
  therapeuticClass: string | null;
  chemicalClass: string | null;
  actionClass: string | null;
  productCategory: string | null;
  categoryPath: string | null;
  storage: string | null;
  countryOfOrigin: string | null;
  safetyAdvice: Partial<Record<SafetyTopic, SafetyVerdict>> | null;
  description: string | null;
  sideEffects: string | null;
  searchTokens: string;
}

/**
 * One vendor row → the catalogue row's own fields. The monograph is separate
 * (see `monographTexts`), because the bundle hands over its texts by reference
 * and an upload hands them over whole.
 *
 * Returns null for a row with no name — the drop has a few blank lines.
 */
export function normalizeVendorRow(kind: CatalogKind, rec: VendorRecord): CatalogProduct | null {
  const name = clamp(text(rec[kind === 'drug' ? 'Product Name' : 'name']), 255);
  if (!name) return null;

  // An OTC product's "Key Ingredients" is marketing copy ("Ashwagandha, Shudh
  // Shilajit, …"), not a salt composition. Put there it would reach the salt
  // master as one enormous molecule per product, so it stays in the monograph.
  const composition = kind === 'drug' ? text(rec['Composition']) : null;
  const manufacturer = clamp(text(rec[kind === 'drug' ? 'Marketer' : 'Marketing Company']), 255);
  const packSizeLabel = clamp(text(rec[kind === 'drug' ? 'Packaging Detail' : 'Packaging']), 255);
  const productForm = clamp(text(rec['Product Form']), 60);
  const packQuantity = clamp(text(rec['Qty']), 40);
  const dosageForm = mapVendorForm(kind, productForm, name, packSizeLabel);
  const fact = kind === 'drug' ? parseFactBox(rec['Fact_Box']) : parseFactBox(null);

  return {
    kind,
    sourceId: clamp(text(rec['Product ID']), 40),
    name,
    genericName: clamp(composition, 500),
    saltComposition: composition,
    manufacturer,
    type: kind,
    dosageForm,
    packSizeLabel,
    packSize: resolveCatalogPackSize(dosageForm, packSizeLabel, packQuantity),
    mrp: parseMrp(rec['MRP']),
    packageType: clamp(titleCaseWords(rec['Package']), 40),
    packQuantity,
    productForm,
    // The label's statement. The schedule is still the classifier's decision.
    rxRequired: kind === 'drug' && /prescription/i.test(rec['prescription_required'] ?? ''),
    habitForming: fact.habitForming,
    therapeuticClass: clamp(fact.therapeuticClass, 120),
    chemicalClass: clamp(fact.chemicalClass, 255),
    actionClass: clamp(fact.actionClass, 255),
    productCategory: kind === 'otc' ? clamp(text(rec['type']), 120) : null,
    categoryPath: kind === 'otc' ? clamp(categoryTrail(rec['Category'], name), 400) : null,
    storage: clamp(text(rec['storage']), 120),
    countryOfOrigin: clamp(cleanCountry(rec['country_of_origin']), 80),
    safetyAdvice: kind === 'drug' ? parseSafetyAdvice(rec) : null,
    description: kind === 'drug' ? listText(rec['primary_use']) : null,
    sideEffects: kind === 'drug' ? listText(rec['side_effect']) : null,
    searchTokens: buildDrugSearchTokens({ name, genericName: composition, manufacturer }),
  };
}

/** The row's monograph as plain text, keyed by section — for an upload. */
export function monographTexts(kind: CatalogKind, rec: VendorRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of MONOGRAPH_SECTIONS[kind]) {
    const t = text(rec[s.column]);
    if (t) out[s.key] = t;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Uploaded CSV in the vendor's layout
// ─────────────────────────────────────────────────────────────

const DRUG_MARKERS = ['product name', 'composition', 'fact_box', 'packaging detail'];
const OTC_MARKERS = ['marketing company', 'key ingredients', 'product_highlights'];

/** Which of the vendor's two layouts a header row is, if either. */
export function detectKind(headers: string[]): CatalogKind | null {
  const h = new Set(headers.map((x) => x.trim().toLowerCase()));
  if (!h.has('product id')) return null;
  if (DRUG_MARKERS.some((m) => h.has(m))) return 'drug';
  if (OTC_MARKERS.some((m) => h.has(m)) || h.has('name')) return 'otc';
  return null;
}

export interface VendorCsvRow {
  product: CatalogProduct;
  texts: Record<string, string>;
}

/**
 * A CSV exported from the vendor's workbook. Header names are matched without
 * regard to case, so "product name" and "Product Name" are the same column.
 * Null when the file is not in the vendor's layout at all.
 */
export function parseVendorCsv(csv: string): VendorCsvRow[] | null {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const header = rows.shift() ?? [];
  const kind = detectKind(header);
  if (!kind) return null;

  const known = new Map<string, string>();
  const columns = [
    'Product ID', 'Product Name', 'name', 'Marketer', 'Marketing Company', 'Composition',
    'Packaging Detail', 'Packaging', 'Package', 'Qty', 'Product Form', 'MRP',
    'prescription_required', 'Fact_Box', 'primary_use', 'storage', 'side_effect',
    'country_of_origin', 'Category', 'type', ...Object.values(SAFETY_COLUMNS),
    ...MONOGRAPH_SECTIONS[kind].map((s) => s.column),
  ];
  for (const c of columns) known.set(c.toLowerCase(), c);
  const canonical = header.map((h) => known.get(h.trim().toLowerCase()) ?? h.trim());

  const out: VendorCsvRow[] = [];
  for (const r of rows) {
    const rec: VendorRecord = {};
    canonical.forEach((c, i) => {
      rec[c] = r[i];
    });
    const product = normalizeVendorRow(kind, rec);
    if (product) out.push({ product, texts: monographTexts(kind, rec) });
  }
  return out;
}
