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
 * Decode a GS1 element-string (DataMatrix payload). Returns null when the string
 * does not look like GS1 (no recognised AI was consumed), so callers can fall
 * back to plain GTIN / batch-number / internal-barcode lookups.
 */
export function parseGs1(raw: string): ParsedGs1 | null {
  if (!raw) return null;
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
