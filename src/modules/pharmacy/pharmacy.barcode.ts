// ============================================================
// Pharmacy barcode decoding + internal label minting (spec Section 2)
// ============================================================
// Pharma packs increasingly carry a GS1 DataMatrix (2D) that encodes the GTIN,
// batch/lot, expiry and manufacture date as concatenated Application Identifier
// (AI) elements. This module decodes that string into structured fields so a
// single counter scan resolves product + batch + expiry, and mints a stable
// internal Code-128 barcode for packs that carry no GS1 data at all.
//
// Intentionally dependency-free and pure (no DB) so it is trivially testable and
// shared by the scan-resolve service.

export interface ParsedGs1 {
  gtin?: string;
  batchNumber?: string;
  expiryDate?: string; // ISO yyyy-mm-dd
  manufactureDate?: string; // ISO yyyy-mm-dd
  serial?: string;
}

// FNC1 / Group Separator that delimits variable-length AI elements.
const GS = String.fromCharCode(29);

// Fixed-length AIs we decode → value length (digits after the AI).
const FIXED_LEN: Record<string, number> = {
  '01': 14, // GTIN-14
  '11': 6, // production date YYMMDD
  '15': 6, // best-before YYMMDD
  '17': 6, // expiry YYMMDD
};
// Variable-length AIs we decode (terminated by GS or end of string).
const VARIABLE = new Set(['10', '21', '240']);

/** Convert a GS1 YYMMDD to an ISO date. DD '00' (whole month) → last day. */
function yymmddToIso(s: string): string | undefined {
  if (!/^\d{6}$/.test(s)) return undefined;
  const yy = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  let dd = parseInt(s.slice(4, 6), 10);
  if (mm < 1 || mm > 12) return undefined;
  // GS1 pivot: 51–99 → 19xx, 00–50 → 20xx.
  const year = yy <= 50 ? 2000 + yy : 1900 + yy;
  if (dd === 0) {
    // last day of the month
    dd = new Date(year, mm, 0).getDate();
  }
  if (dd < 1 || dd > 31) return undefined;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Decode a GS1 Digital Link URI — the modern web-URL form of a 2D barcode, e.g.
 *   https://id.gs1.org/01/08901012000014/10/BATCH-A/21/SN123?17=271231
 * The identification key + qualifiers (GTIN 01, batch 10, serial 21) live in the
 * URL PATH as /AI/value pairs after the "/01/" primary key; data attributes
 * (expiry 17, mfg 11, best-before 15) may sit in the path or the QUERY STRING.
 * Returns null when the URL carries no GTIN (so callers fall back).
 */
function parseDigitalLink(raw: string): ParsedGs1 | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const out: ParsedGs1 = {};
  let matched = false;
  const assign = (ai: string, valueRaw: string) => {
    let value: string;
    try {
      value = decodeURIComponent(valueRaw);
    } catch {
      value = valueRaw;
    }
    if (!value) return;
    switch (ai) {
      case '01': out.gtin = value; matched = true; break;
      case '10': out.batchNumber = value; matched = true; break;
      case '21': out.serial = value; matched = true; break;
      case '17':
      case '15': out.expiryDate = yymmddToIso(value); matched = true; break;
      case '11': out.manufactureDate = yymmddToIso(value); matched = true; break;
      default: break;
    }
  };
  // Path pairs — parse from the "/01/" primary key so any brand-site prefix
  // (…/products/01/…) is ignored; stop at the first non-numeric segment.
  const segs = url.pathname.split('/').filter(Boolean);
  const start = segs.indexOf('01');
  if (start >= 0) {
    for (let i = start; i + 1 < segs.length; i += 2) {
      if (!/^\d{2,4}$/.test(segs[i])) break;
      assign(segs[i], segs[i + 1]);
    }
  }
  // Query attributes — ?17=YYMMDD&10=BATCH… in any order.
  url.searchParams.forEach((v, k) => {
    if (/^\d{2,4}$/.test(k)) assign(k, v);
  });
  return matched && out.gtin ? out : null;
}

/**
 * Decode a GS1 payload — either the modern Digital Link URI or the classic
 * element-string (DataMatrix / GS1-128) with concatenated Application
 * Identifiers. Returns null when the string is not GS1 at all, so callers can
 * fall back to plain GTIN / batch-number / internal-barcode lookups.
 */
export function parseGs1(raw: string): ParsedGs1 | null {
  if (!raw) return null;
  // A scanned GS1 QR is often a Digital Link URL — try that first.
  if (/^https?:\/\//i.test(raw.trim())) {
    const dl = parseDigitalLink(raw);
    if (dl) return dl;
  }
  // Strip a leading symbology identifier ( ]d2 DataMatrix / ]C1 / ]Q3 QR ) and a
  // leading FNC1 if the scanner emitted one.
  let s = raw.trim().replace(/^\](d2|C1|Q3|e0)/i, '');
  if (s.startsWith(GS)) s = s.slice(1);

  const out: ParsedGs1 = {};
  let i = 0;
  let matched = false;

  while (i < s.length) {
    // AIs are 2–4 chars; try the recognised ones at this position.
    let ai = '';
    for (const len of [2, 3]) {
      const cand = s.slice(i, i + len);
      if (FIXED_LEN[cand] || VARIABLE.has(cand)) {
        ai = cand;
        break;
      }
    }
    if (!ai) break; // unknown AI — stop (we've decoded what we understand)
    i += ai.length;

    let value: string;
    if (FIXED_LEN[ai]) {
      value = s.slice(i, i + FIXED_LEN[ai]);
      i += FIXED_LEN[ai];
    } else {
      const gsIdx = s.indexOf(GS, i);
      const end = gsIdx === -1 ? s.length : gsIdx;
      value = s.slice(i, end);
      i = gsIdx === -1 ? s.length : gsIdx + 1;
    }
    if (!value) continue;
    matched = true;

    switch (ai) {
      case '01':
        out.gtin = value;
        break;
      case '17':
      case '15':
        out.expiryDate = yymmddToIso(value);
        break;
      case '11':
        out.manufactureDate = yymmddToIso(value);
        break;
      case '10':
        out.batchNumber = value;
        break;
      case '21':
        out.serial = value;
        break;
      default:
        break;
    }
  }

  return matched ? out : null;
}

/**
 * Mint a stable, scannable internal barcode for a batch that carries no GS1 code.
 * Derived from the batch UUID so it is globally unique, prefixed and uppercased
 * for a clean Code-128 ("PHB" + 12 hex chars). Deterministic for a given id.
 */
export function makeInternalBarcode(batchId: string): string {
  const hex = batchId.replace(/-/g, '').slice(0, 12).toUpperCase();
  return `PHB${hex}`;
}

/** True when a scanned string is one of our minted internal barcodes. */
export function isInternalBarcode(code: string): boolean {
  return /^PHB[0-9A-F]{6,}$/.test(code.trim());
}

/**
 * Equivalent forms of a GTIN so a lookup matches regardless of how it was
 * stored. A GS1 DataMatrix / Digital Link always carries a 14-digit GTIN, while
 * a typed/EAN barcode is usually 13 digits — the same product, so both the
 * 13- and 14-digit forms are returned to OR against the stored value.
 */
export function gtinVariants(gtin: string | null | undefined): string[] {
  const g = (gtin ?? '').replace(/\D/g, '');
  if (g.length < 8) return g ? [g] : [];
  const set = new Set<string>([g, g.padStart(14, '0')]);
  if (g.length === 14 && g.startsWith('0')) set.add(g.slice(1)); // GTIN-14 → GTIN-13
  if (g.length === 13) set.add('0' + g); // GTIN-13 → GTIN-14
  return [...set];
}

/**
 * Validate a GTIN's GS1 mod-10 check digit (accepts GTIN-8/12/13/14). Useful to
 * reject a mis-scanned/typo'd barcode before trusting it.
 */
export function isValidGtin(gtin: string | null | undefined): boolean {
  const g = (gtin ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(g.length)) return false;
  let sum = 0;
  for (let j = 1; j < g.length; j++) {
    const d = g.charCodeAt(g.length - 1 - j) - 48;
    sum += j % 2 === 1 ? d * 3 : d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === g.charCodeAt(g.length - 1) - 48;
}
