import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import { callGeminiVision } from '../../services/gemini-vision';

// ============================================================
// OCR invoice parsing for stock inward (spec G1 — "CSV / OCR / manual").
//
// A distributor supply invoice (photo or PDF) is read by Google Gemini's
// multimodal model and turned into structured inward lines, which then flow into
// the SAME Product Resolution Engine (/inward/match → /inward/commit) the CSV /
// manual paths use: perfect GTIN/learned matches auto-resolve, fuzzy names are
// surfaced for review, and unrecognised items fall through to manual create.
//
// Gated behind GEMINI_API_KEY (the same key the clinical AI suggestions use).
// When it is missing we throw a clear badRequest so the UI can fall back to the
// CSV / manual entry that already exists, rather than failing silently.
// ============================================================

/** One parsed invoice line — shaped to seed the inward grid (DraftLine). */
export interface OcrInvoiceLine {
  drugName: string;
  genericName?: string | null;
  manufacturer?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
  // Purchased package level (Box, Strip, Bottle, Vial, etc.).
  primaryUnit?: string | null;
  // Loose dispensing/base unit a pack is counted in (Tablet, Capsule, ml, Box…).
  unit?: string | null;
  gtin?: string | null;
  hsnCode?: string | null;
  packSize?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null; // ISO yyyy-mm-dd
  manufacturingDate?: string | null; // ISO yyyy-mm-dd
  quantityReceived?: number | null;
  freeQuantity?: number | null;
  mrp?: number | null;
  purchasePrice?: number | null;
  purchaseDiscountPercent?: number | null;
  gstPercent?: number | null;
  sellingPrice?: number | null;
}

export interface OcrInvoiceHeader {
  supplierName?: string | null;
  supplierGstin?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null; // ISO yyyy-mm-dd
}

export interface OcrInvoiceResult {
  model: string;
  header: OcrInvoiceHeader;
  lines: OcrInvoiceLine[];
  warnings: string[];
}

function buildPrompt(): string {
  return [
    'You are a data-entry assistant for a hospital pharmacy in India. You are given a SUPPLIER / DISTRIBUTOR purchase invoice (a "bill") for medicines, as an image or PDF.',
    'Read it carefully and extract the invoice header and every product line item. The invoice may be a tax invoice from a pharmaceutical distributor with columns like Product/Description, Pack, Mfr/Company, Batch (B.No), Expiry (Exp), HSN, Qty, Free/Scheme, MRP, Rate/PTR/PTS, Disc%, GST%.',
    '',
    'Rules:',
    '- Extract ONLY what is printed. Do not invent values. If a field is not present or unreadable, use null.',
    '- drugName: the brand/product name exactly as printed (without the pack suffix).',
    '- dosageForm: the medicine form as EXACTLY one of (lowercase): tablet, capsule, syrup, injection, cream, drops, inhaler, other. Map e.g. TAB→tablet, CAP→capsule, INJ/vial/amp→injection, SYP/suspension/solution→syrup, ointment/gel→cream; use "other" if none fit, null if unknown.',
    '- primaryUnit: the purchased package level as one of Box, Strip, Tablet, Capsule, Bottle, Vial, Ampoule, Tube, Sachet, ml, gm, Piece. Infer it from the printed Pack column; null if unclear.',
    '- unit: the single loose dispensing unit a pack is broken into and counted in — e.g. "Tablet", "Capsule", "ml", "Box", "Strip", "Vial", "Sachet". For tablets/capsules use "Tablet"/"Capsule"; for liquids use "ml". Null if unclear.',
    '- strength: the dose if part of the name (e.g. "650mg", "40mg"), else null.',
    '- manufacturer: the marketing company / manufacturer column if present (expand obvious abbreviations only when certain), else null.',
    '- packSize: the number of base units in a pack as an integer when the pack is like "10\'S", "1x10", "10 TAB" → 10. If it is a bottle/vial/single unit, use null.',
    '- batchNumber: the batch / lot number string.',
    '- expiryDate and manufacturingDate: output as ISO "YYYY-MM-DD". Pharma invoices usually print expiry as MM/YY or MM/YYYY — convert to the LAST day of that month (e.g. "08/26" → "2026-08-31"). invoiceDate is usually a full date.',
    '- quantityReceived: the billed/paid quantity (Qty column) as a number of the SAME units packSize counts. freeQuantity: any free/scheme units, else 0.',
    '- mrp: printed M.R.P. purchasePrice: the purchase Rate / PTR / PTS before discount. purchaseDiscountPercent: the line discount %. gstPercent: the GST/tax % (if shown as CGST+SGST, sum them).',
    '- MRP, purchasePrice and sellingPrice are the values for one primaryUnit. The receiving system derives the smallest-unit prices using packSize.',
    '- All money/number fields: plain numbers, no currency symbols or commas.',
    '- gtin: a GS1 GTIN/barcode number if printed on the line, else null. hsnCode: the HSN code if shown.',
    '- supplierGstin: the SELLER\'s GSTIN (15 chars), not the buyer\'s.',
    '',
    'Return ONLY a JSON object with this exact shape (no prose, no markdown):',
    '{',
    '  "header": { "supplierName": string|null, "supplierGstin": string|null, "invoiceNumber": string|null, "invoiceDate": string|null },',
    '  "lines": [ { "drugName": string, "genericName": string|null, "manufacturer": string|null, "strength": string|null, "dosageForm": string|null, "primaryUnit": string|null, "unit": string|null, "gtin": string|null, "hsnCode": string|null, "packSize": number|null, "batchNumber": string|null, "expiryDate": string|null, "manufacturingDate": string|null, "quantityReceived": number|null, "freeQuantity": number|null, "mrp": number|null, "purchasePrice": number|null, "purchaseDiscountPercent": number|null, "gstPercent": number|null, "sellingPrice": number|null } ]',
    '}',
    'If the image is not a medicine purchase invoice, return {"header":{},"lines":[]}.',
  ].join('\n');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Last day of a month, as an ISO date, for MM/YY expiry strings. */
function endOfMonthIso(year: number, month1: number): string | undefined {
  if (month1 < 1 || month1 > 12) return undefined;
  const dd = new Date(year, month1, 0).getDate();
  return `${year}-${String(month1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Normalise the many date shapes that turn up on Indian pharma invoices to an
 * ISO yyyy-mm-dd. Handles ISO, MM/YY, MM/YYYY, MM-YY, and dd/MM/yyyy. For a
 * bare month/year (typical for expiry) the last day of the month is used.
 */
export function normalizeInvoiceDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (ISO_DATE.test(s)) return s;

  // MM/YY or MM/YYYY (or with '-' / '.').
  const my = s.match(/^(\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (my) {
    const mm = parseInt(my[1], 10);
    let yy = parseInt(my[2], 10);
    if (my[2].length === 2) yy = yy <= 70 ? 2000 + yy : 1900 + yy;
    return endOfMonthIso(yy, mm);
  }

  // dd/MM/yyyy or dd-MM-yyyy.
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (dmy) {
    const dd = parseInt(dmy[1], 10);
    const mm = parseInt(dmy[2], 10);
    let yy = parseInt(dmy[3], 10);
    if (dmy[3].length === 2) yy = yy <= 70 ? 2000 + yy : 1900 + yy;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return undefined;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,₹\s]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length ? t : null;
  }
  return null;
}

function coerceLine(raw: unknown): OcrInvoiceLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const drugName = str(r.drugName);
  if (!drugName) return null; // a line with no product name is useless
  const packSizeNum = num(r.packSize);
  return {
    drugName,
    genericName: str(r.genericName),
    manufacturer: str(r.manufacturer),
    strength: str(r.strength),
    dosageForm: str(r.dosageForm),
    primaryUnit: str(r.primaryUnit),
    unit: str(r.unit),
    gtin: str(r.gtin),
    hsnCode: str(r.hsnCode),
    packSize: packSizeNum != null && packSizeNum > 0 ? Math.round(packSizeNum) : null,
    batchNumber: str(r.batchNumber),
    expiryDate: normalizeInvoiceDate(r.expiryDate) ?? null,
    manufacturingDate: normalizeInvoiceDate(r.manufacturingDate) ?? null,
    quantityReceived: num(r.quantityReceived),
    freeQuantity: num(r.freeQuantity),
    mrp: num(r.mrp),
    purchasePrice: num(r.purchasePrice),
    purchaseDiscountPercent: num(r.purchaseDiscountPercent),
    gstPercent: num(r.gstPercent),
    sellingPrice: num(r.sellingPrice),
  };
}

function parseInvoiceJson(text: string): { header: OcrInvoiceHeader; lines: OcrInvoiceLine[] } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in OCR response');
  const parsed = JSON.parse(match[0]) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('OCR response was not an object');
  const obj = parsed as Record<string, unknown>;
  const h = (obj.header && typeof obj.header === 'object' ? obj.header : {}) as Record<string, unknown>;
  const header: OcrInvoiceHeader = {
    supplierName: str(h.supplierName),
    supplierGstin: str(h.supplierGstin),
    invoiceNumber: str(h.invoiceNumber),
    invoiceDate: normalizeInvoiceDate(h.invoiceDate) ?? null,
  };
  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines = rawLines.map(coerceLine).filter((l): l is OcrInvoiceLine => l !== null);
  return { header, lines };
}

/**
 * Run OCR + structured extraction on an uploaded invoice file (on disk). Returns
 * a header + line items ready to seed the inward review grid. Throws a clear
 * badRequest when the AI key is not configured or the file type is unsupported.
 */
export async function parseInvoiceFile(file: {
  path: string;
  mimetype: string;
  originalname?: string;
}): Promise<OcrInvoiceResult> {
  // Transport, file read and upstream error mapping are shared with the lab
  // report reader — see services/gemini-vision.ts.
  const { text, model } = await callGeminiVision({
    prompt: buildPrompt(),
    file,
    feature: 'Invoice OCR',
    fallbackHint: 'You can still add stock manually or via CSV.',
  });


  let parsed: { header: OcrInvoiceHeader; lines: OcrInvoiceLine[] };
  try {
    parsed = parseInvoiceJson(text);
  } catch (err) {
    logger.warn({ err: (err as Error).message, preview: text.slice(0, 200) }, 'Failed to parse OCR result');
    throw AppError.internal('OCR returned an unexpected format');
  }

  const warnings: string[] = [];
  if (parsed.lines.length === 0) {
    warnings.push('No product lines could be read from this image. Try a clearer photo or enter the items manually.');
  }
  for (const l of parsed.lines) {
    if (!l.batchNumber) warnings.push(`"${l.drugName}": batch number not read — please fill it in.`);
    if (!l.expiryDate) warnings.push(`"${l.drugName}": expiry not read — please fill it in.`);
  }

  return { model, header: parsed.header, lines: parsed.lines, warnings };
}
