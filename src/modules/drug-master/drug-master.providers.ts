import { logger } from '../../config/logger';
import { parseDrugCsv, buildParsedDrug, type ParsedDrug } from './drug-master.dataset';

// ============================================================
// Pluggable drug-data providers.
//
// Each provider knows how to FETCH drug rows from a source and NORMALISE them to
// ParsedDrug. The catalog refresh upserts whatever a provider yields into our
// own DrugMaster table — so we always STORE the data and never depend on a live
// API at request time. Add a new source by implementing DrugProvider and
// registering it below; the rest of the pipeline (upsert, search, UI) is
// unchanged.
// ============================================================

// Richer free dataset (adds salt_composition, description, side_effects,
// drug_interactions). Prices are ~2022 — replace with a paid provider for
// current MRP.
export const OPEN_DATASET_RICH_URL =
  'https://raw.githubusercontent.com/junioralive/Indian-Medicine-Dataset/main/DATA/updated_indian_medicine_data.csv';

export interface DrugProvider {
  name: string;
  label: string;
  description: string;
  /** Whether this provider can run in the current environment. */
  configured(): boolean;
  /** Fetch + normalise the full drug list to upsert. */
  fetchRows(): Promise<ParsedDrug[]>;
}

async function downloadCsv(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return res.text();
}

// ── Provider: open dataset (free, rich) ───────────────────────
const openDataset: DrugProvider = {
  name: 'open-dataset',
  label: 'Open Indian dataset (free · rich)',
  description:
    '~254K brands incl. composition, uses, side effects and interactions. Free; prices ~2022.',
  configured: () => true,
  fetchRows: async () => parseDrugCsv(await downloadCsv(OPEN_DATASET_RICH_URL)),
};

// ── Provider: commercial API (paid, latest) ───────────────────
// Generic adapter for a licensed Indian drug feed (DataRequisite / PharmaTrac /
// 1mg-style). Configure via env:
//   DRUG_API_URL   – base endpoint returning a JSON array (or {data:[...]})
//   DRUG_API_KEY   – bearer token / api key
// Map your provider's field names in `mapRow` below. Not active until both env
// vars are set, so the system is never *dependent* on it.
const commercialApi: DrugProvider = {
  name: 'commercial-api',
  label: 'Commercial drug API (paid · latest)',
  description:
    'Licensed feed with current MRP + details. Set DRUG_API_URL and DRUG_API_KEY to enable.',
  configured: () => !!process.env.DRUG_API_URL && !!process.env.DRUG_API_KEY,
  fetchRows: async () => fetchCommercialApi(),
};

function mapRow(row: Record<string, unknown>): ParsedDrug | null {
  // Tolerant field mapping — adjust the alternative names to your provider.
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  const name = pick('name', 'medicine_name', 'brand', 'product_name');
  if (!name) return null;
  const priceRaw = pick('mrp', 'price', 'price(₹)');
  const mrp = priceRaw && !Number.isNaN(Number(priceRaw.replace(/[^0-9.]/g, '')))
    ? Number(priceRaw.replace(/[^0-9.]/g, ''))
    : null;
  return buildParsedDrug({
    name,
    genericName: pick('composition', 'generic', 'salt', 'salt_composition'),
    manufacturer: pick('manufacturer', 'manufacturer_name', 'company'),
    type: pick('type', 'category'),
    packSizeLabel: pick('pack', 'pack_size_label', 'packaging'),
    mrp,
    isDiscontinued: String(pick('is_discontinued', 'discontinued') ?? '').toUpperCase() === 'TRUE',
    saltComposition: pick('salt_composition', 'salt', 'composition'),
    description: pick('description', 'uses', 'about', 'medicine_desc'),
    sideEffects: pick('side_effects', 'sideeffects'),
  });
}

async function fetchCommercialApi(): Promise<ParsedDrug[]> {
  const base = process.env.DRUG_API_URL;
  const key = process.env.DRUG_API_KEY;
  if (!base || !key) {
    throw new Error('commercial-api provider is not configured (set DRUG_API_URL + DRUG_API_KEY)');
  }
  const out: ParsedDrug[] = [];
  // Page until an empty page; cap to avoid runaway loops.
  for (let page = 1; page <= 5000; page++) {
    const url = `${base}${base.includes('?') ? '&' : '?'}page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Commercial API ${res.status} ${res.statusText}`);
    const body = (await res.json()) as unknown;
    const rows: Record<string, unknown>[] = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : (((body as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[]);
    if (!rows.length) break;
    for (const r of rows) {
      const mapped = mapRow(r);
      if (mapped) out.push(mapped);
    }
  }
  logger.info({ count: out.length }, 'commercial-api provider fetched rows');
  return out;
}

export const DRUG_PROVIDERS: Record<string, DrugProvider> = {
  [openDataset.name]: openDataset,
  [commercialApi.name]: commercialApi,
};

export function getProvider(name: string): DrugProvider | undefined {
  return DRUG_PROVIDERS[name];
}

export function listProviders() {
  return Object.values(DRUG_PROVIDERS).map((p) => ({
    name: p.name,
    label: p.label,
    description: p.description,
    configured: p.configured(),
  }));
}
