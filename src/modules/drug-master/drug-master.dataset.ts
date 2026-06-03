// Pure helpers for parsing + normalising the Indian medicine dataset
// (CSV columns: id,name,price(₹),Is_discontinued,manufacturer_name,type,
// pack_size_label,short_composition1,short_composition2). Shared by the
// catalog refresh service. NO prisma/io imports so it stays trivially testable.

export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'injection'
  | 'cream'
  | 'drops'
  | 'inhaler'
  | 'other';

/**
 * Denormalised lowercase token blob powering catalog search (brand + generic
 * + manufacturer + aliases/tags). Single source of truth for both the
 * create/update service path and the refresh path.
 */
export function buildDrugSearchTokens(input: {
  name?: string | null;
  genericName?: string | null;
  manufacturer?: string | null;
  aliases?: string[] | null;
  tags?: string[] | null;
}): string {
  const tokens: string[] = [];
  const push = (s?: string | null) => {
    if (!s) return;
    tokens.push(String(s).toLowerCase().trim());
  };
  push(input.name);
  push(input.genericName);
  push(input.manufacturer);
  (input.aliases ?? []).forEach(push);
  (input.tags ?? []).forEach(push);
  return Array.from(new Set(tokens.filter(Boolean))).join(' | ');
}

/**
 * Stable identity for a drug across dataset snapshots. The dataset's numeric
 * `id` is just a row number and isn't stable between versions, so we key on
 * the normalised brand + manufacturer + pack instead. Computed identically for
 * existing DB rows (from their live fields) and incoming CSV rows, so a refresh
 * matches and UPDATES rather than duplicating.
 */
export function computeSourceKey(
  name?: string | null,
  manufacturer?: string | null,
  packSizeLabel?: string | null,
): string {
  const norm = (s?: string | null) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  return [norm(name), norm(manufacturer), norm(packSizeLabel)].join('|');
}

export function inferDosageForm(name: string, pack: string): DosageForm | null {
  const hay = `${name} ${pack}`.toLowerCase();
  if (/\btablet|\btab\b|\bdt\b/.test(hay)) return 'tablet';
  if (/\bcapsule|\bcap\b/.test(hay)) return 'capsule';
  if (/\bsyrup|suspension|\bsolution\b|\belixir\b|\bsachet\b/.test(hay)) return 'syrup';
  if (/\binjection|\binj\b|\bvial\b|\bampoule\b/.test(hay)) return 'injection';
  if (/\bcream|\bointment|\bgel\b|\blotion\b/.test(hay)) return 'cream';
  if (/\bdrops?\b|eye drop|ear drop|nasal/.test(hay)) return 'drops';
  if (/\binhaler|\brotacap|\brespule|\brotahaler/.test(hay)) return 'inhaler';
  return 'other';
}

export function cleanComposition(a: string, b: string): string | null {
  const join = [a, b]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' + ');
  return join || null;
}

/** Minimal RFC-4180 CSV parser (quoted fields + embedded commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore; \n handles the break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// NPPA matching helpers (salt + strength identity)
// ─────────────────────────────────────────────────────────────

export function normSalt(s?: string | null): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normStrength(s?: string | null): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

/** Stable key joining a normalised salt + strength, e.g. "azithromycin|500mg". */
export function nppaMatchKey(salt?: string | null, strength?: string | null): string {
  return `${normSalt(salt)}|${normStrength(strength)}`;
}

interface SaltStrength {
  salt: string;
  strength: string;
}

// Build an order-independent identity key from one or more salt+strength pairs,
// e.g. "amoxicillin|500mg + clavulanic acid|125mg". Used for BOTH single-salt
// and combination drugs so a combo ceiling matches a combo brand.
function identityFromPairs(pairs: SaltStrength[]): string | null {
  const norm = pairs
    .map((p) => `${normSalt(p.salt)}|${normStrength(p.strength)}`)
    .filter((s) => s !== '|' && !s.startsWith('|'));
  if (norm.length === 0) return null;
  return Array.from(new Set(norm)).sort().join(' + ');
}

/**
 * Identity key for a DrugMaster genericName — single OR combination. e.g.
 * "Amoxycillin (500mg) + Clavulanic Acid (125mg)" →
 * "amoxycillin|500mg + clavulanic acid|125mg". Returns null if no
 * parenthesised strengths can be parsed.
 */
export function drugIdentityKey(generic?: string | null): string | null {
  if (!generic) return null;
  const pairs: SaltStrength[] = [];
  for (const part of generic.split('+')) {
    const m = part.match(/^(.*?)\(([^)]*)\)/);
    if (!m) continue;
    const salt = (m[1] ?? '').trim();
    const strength = (m[2] ?? '').trim();
    if (salt && strength) pairs.push({ salt, strength });
  }
  return identityFromPairs(pairs);
}

/**
 * Identity key for an NPPA formulation + strength — single OR combination.
 * Handles "Amoxicillin + Clavulanic Acid" / "500mg + 125mg" by zipping the two
 * lists. Falls back gracefully when strength is a single value or counts differ.
 */
export function nppaIdentityKey(
  formulation?: string | null,
  strength?: string | null,
): string | null {
  const salts = String(formulation ?? '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (salts.length === 0) return null;
  const strengths = String(strength ?? '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);

  let pairs: SaltStrength[];
  if (salts.length === strengths.length) {
    pairs = salts.map((s, i) => ({ salt: s, strength: strengths[i] }));
  } else if (salts.length === 1) {
    pairs = [{ salt: salts[0], strength: strength ?? '' }];
  } else {
    // Combo with mismatched strength count — pair salts to whatever strengths
    // exist positionally; missing strengths become empty.
    pairs = salts.map((s, i) => ({ salt: s, strength: strengths[i] ?? '' }));
  }
  return identityFromPairs(pairs);
}

export interface ParsedDrug {
  name: string;
  genericName: string | null;
  manufacturer: string | null;
  type: string | null;
  dosageForm: DosageForm | null;
  packSizeLabel: string | null;
  mrp: number | null;
  isDiscontinued: boolean;
  // Rich clinical detail (present in the richer dataset / provider feeds).
  saltComposition: string | null;
  description: string | null;
  sideEffects: string | null;
  drugInteractions: unknown | null;
  searchTokens: string;
  sourceKey: string;
}

/**
 * Build a normalised ParsedDrug from arbitrary field inputs — used by non-CSV
 * providers (e.g. a commercial API adapter) so every source produces the same
 * shape (with computed searchTokens + identity sourceKey).
 */
export function buildParsedDrug(input: {
  name: string;
  genericName?: string | null;
  manufacturer?: string | null;
  type?: string | null;
  dosageForm?: DosageForm | null;
  packSizeLabel?: string | null;
  mrp?: number | null;
  isDiscontinued?: boolean;
  saltComposition?: string | null;
  description?: string | null;
  sideEffects?: string | null;
  drugInteractions?: unknown | null;
}): ParsedDrug {
  const name = input.name.trim();
  const genericName = input.genericName ?? null;
  const manufacturer = input.manufacturer ?? null;
  const pack = input.packSizeLabel ?? null;
  return {
    name,
    genericName,
    manufacturer,
    type: input.type ?? null,
    dosageForm: input.dosageForm ?? inferDosageForm(name, pack ?? ''),
    packSizeLabel: pack,
    mrp: input.mrp ?? null,
    isDiscontinued: input.isDiscontinued ?? false,
    saltComposition: input.saltComposition ?? genericName,
    description: input.description ?? null,
    sideEffects: input.sideEffects ?? null,
    drugInteractions: input.drugInteractions ?? null,
    searchTokens: buildDrugSearchTokens({ name, genericName, manufacturer }),
    sourceKey: computeSourceKey(name, manufacturer, pack),
  };
}

/** Parse the full dataset CSV into normalised drug rows (header-mapped). */
export function parseDrugCsv(text: string): ParsedDrug[] {
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  const idx = (...names: string[]) =>
    header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const cName = idx('name');
  const cPriceMatch = idx('price(₹)', 'price', 'mrp');
  const cPrice = cPriceMatch >= 0 ? cPriceMatch : 2;
  const cDisc = idx('is_discontinued');
  const cMfr = idx('manufacturer_name', 'manufacturer');
  const cType = idx('type');
  const cPack = idx('pack_size_label');
  const cComp1 = idx('short_composition1');
  const cComp2 = idx('short_composition2');
  // Richer columns (optional — absent in the basic CSV).
  const cSalt = idx('salt_composition', 'salt');
  const cDesc = idx('medicine_desc', 'description', 'about');
  const cSide = idx('side_effects', 'sideeffects');
  const cInter = idx('drug_interactions', 'interactions');

  const val = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

  const out: ParsedDrug[] = [];
  for (const r of rows) {
    const name = (r[cName] ?? '').trim();
    if (!name) continue;
    const manufacturer = val(r, cMfr) || null;
    const genericName = cleanComposition(r[cComp1] ?? '', r[cComp2] ?? '');
    const pack = (r[cPack] ?? '').trim() || null;
    const priceRaw = (r[cPrice] ?? '').trim();
    const mrp = priceRaw && !Number.isNaN(Number(priceRaw)) ? Number(priceRaw) : null;
    const isDiscontinued = (r[cDisc] ?? '').trim().toUpperCase() === 'TRUE';
    const type = val(r, cType) || null;

    // drug_interactions is a JSON string in the dataset — parse defensively.
    let drugInteractions: unknown | null = null;
    const interRaw = val(r, cInter);
    if (interRaw) {
      try {
        drugInteractions = JSON.parse(interRaw);
      } catch {
        drugInteractions = null;
      }
    }

    out.push({
      name,
      genericName,
      manufacturer,
      type,
      dosageForm: inferDosageForm(name, pack ?? ''),
      packSizeLabel: pack,
      mrp,
      isDiscontinued,
      saltComposition: val(r, cSalt) || genericName,
      description: val(r, cDesc) || null,
      sideEffects: val(r, cSide) || null,
      drugInteractions,
      searchTokens: buildDrugSearchTokens({ name, genericName, manufacturer }),
      sourceKey: computeSourceKey(name, manufacturer, pack),
    });
  }
  return out;
}
