import { logger } from '../../config/logger';
import { normalizeVendorRow, type VendorCsvRow } from './drug-catalog.normalize';
import { readManifest } from './drug-catalog.release';

// ============================================================
// Where a catalogue refresh can come from.
//
// The catalogue is the vendor's, shipped with each build as a release (see
// drug-catalog.release.ts) and applied on boot. A super admin can also refresh
// it by hand: re-apply the bundled release, upload a CSV exported from the
// vendor's workbook, or pull from a licensed API. Every source ends as vendor
// rows keyed on a Product ID, so a refresh never duplicates a product and
// never breaks a hospital's link to one.
// ============================================================

export interface DrugProvider {
  name: string;
  label: string;
  description: string;
  /** Whether this provider can run in the current environment. */
  configured(): boolean;
  /**
   * 'release' re-applies the bundled release as a whole (it may discontinue
   * products it no longer lists); 'rows' upserts what it returns and nothing
   * else.
   */
  mode: 'release' | 'rows';
  fetchRows?(): Promise<VendorCsvRow[]>;
}

function bundledRelease(): string | null {
  try {
    return readManifest()?.release ?? null;
  } catch {
    return null;
  }
}

// ── Provider: the release bundled with this build ─────────────
const bundled: DrugProvider = {
  name: 'bundled',
  get label() {
    const r = bundledRelease();
    return r ? `Vendor release ${r} (bundled)` : 'Vendor release (bundled)';
  },
  description:
    'The vendor catalogue shipped with this build — drugs and OTC products with composition, pack, MRP, ' +
    'label and monographs. Re-applying updates changed products, adds new ones and marks the ones it no ' +
    'longer lists discontinued. Hospital formularies and prices are never touched.',
  configured: () => bundledRelease() !== null,
  mode: 'release',
};

// ── Provider: commercial API (paid, latest) ───────────────────
// Generic adapter for a licensed feed. Configure via env:
//   DRUG_API_URL   – endpoint returning a JSON array (or {data:[...]})
//   DRUG_API_KEY   – bearer token / api key
// Map the provider's field names in `mapRow`. A row without a product id is
// skipped: the id is what lets a later refresh update it instead of adding a
// second copy.
const commercialApi: DrugProvider = {
  name: 'commercial-api',
  label: 'Commercial drug API (paid · latest)',
  description:
    'Licensed feed with current MRP + details. Set DRUG_API_URL and DRUG_API_KEY to enable.',
  configured: () => !!process.env.DRUG_API_URL && !!process.env.DRUG_API_KEY,
  mode: 'rows',
  fetchRows: async () => fetchCommercialApi(),
};

function mapRow(row: Record<string, unknown>): VendorCsvRow | null {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  const product = normalizeVendorRow('drug', {
    'Product ID': pick('product_id', 'id', 'sku'),
    'Product Name': pick('name', 'product_name', 'medicine_name', 'brand'),
    Marketer: pick('manufacturer', 'marketer', 'manufacturer_name', 'company'),
    Composition: pick('composition', 'salt_composition', 'generic', 'salt'),
    'Packaging Detail': pick('pack', 'pack_size_label', 'packaging'),
    'Product Form': pick('form', 'dosage_form'),
    MRP: pick('mrp', 'price'),
    prescription_required: pick('prescription_required', 'rx'),
    side_effect: pick('side_effects', 'sideeffects'),
    primary_use: pick('uses', 'primary_use'),
  });
  if (!product?.sourceId) return null;
  const about = pick('description', 'about');
  return { product, texts: about ? { intro: about } : {} };
}

async function fetchCommercialApi(): Promise<VendorCsvRow[]> {
  const base = process.env.DRUG_API_URL;
  const key = process.env.DRUG_API_KEY;
  if (!base || !key) {
    throw new Error('commercial-api provider is not configured (set DRUG_API_URL + DRUG_API_KEY)');
  }
  const out: VendorCsvRow[] = [];
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
  [bundled.name]: bundled,
  [commercialApi.name]: commercialApi,
};

export const DEFAULT_PROVIDER = bundled.name;

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
