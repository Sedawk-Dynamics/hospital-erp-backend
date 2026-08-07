import { logger } from '../../config/logger';
import {
  callGeminiVision,
  parseModelJson,
  isOcrConfigured,
  OCR_SUPPORTED_MIME,
  type GeminiVisionFile,
} from '../../services/gemini-vision';

// ============================================================
// Reading an uploaded lab report into structured values.
//
// The lab's day-to-day flow is to upload the analyser's PDF (or a photo of the
// printout) and mark the test done — nobody retypes the numbers into the entry
// grid. That leaves the order with attachments but ZERO LabResult rows, and
// every downstream reader works off LabResult: the doctor's investigation
// panel, the discharge summary, CDSS, and the AI assistant. So the doctor asks
// the AI about a report that is sitting right there and is told there is
// nothing to analyse.
//
// This turns the uploaded file into the same LabResult rows a technician would
// have typed, flagged `source = 'ocr'` so the lab can see they were machine-read
// and verify them. They stay invisible to clinicians until the supervisor
// publishes the report (see isLabReportReleased), so a misread number cannot
// reach a doctor unchecked.
// ============================================================

export interface OcrLabParameter {
  /** The panel/test this parameter belongs to, if the report groups them. */
  testName: string | null;
  parameterName: string;
  value: string | null;
  unit: string | null;
  normalRange: string | null;
}

export interface OcrLabReportResult {
  model: string;
  parameters: OcrLabParameter[];
  warnings: string[];
}

function buildPrompt(): string {
  return [
    'You are a data-entry assistant for a hospital laboratory in India. You are given a LABORATORY REPORT as an image or PDF — typically an analyser printout or a scanned report with columns like Test / Investigation, Result / Value, Unit, and Reference Range (Bio. Ref. Interval / Normal Range).',
    'Read it carefully and extract EVERY reported parameter.',
    '',
    'Rules:',
    '- Extract ONLY what is printed. Never infer, compute or invent a value. If a field is absent or unreadable, use null.',
    '- parameterName: the analyte exactly as printed, e.g. "Haemoglobin", "Total Leucocyte Count", "Platelet Count", "Serum Creatinine", "HbA1c".',
    '- testName: the panel heading the parameter sits under if the report groups them (e.g. "Complete Blood Count", "Liver Function Test"). Null when the report is a single test with no grouping.',
    '- value: the measured result EXACTLY as printed, as a string — keep decimals, and keep comparison markers like "<0.01" or ">200" verbatim. Do not round.',
    '- unit: the unit as printed, e.g. "g/dL", "mg/dL", "10^3/uL", "%", "IU/L". Null if none.',
    '- normalRange: the reference interval as printed, e.g. "13.0 - 17.0", "< 200", "0.6-1.2". Keep it as one string. Null if none.',
    '- Skip page headers, patient demographics, doctor names, addresses, barcodes, method/technology notes, interpretation paragraphs and footers — parameters only.',
    '- A parameter with no result value is still worth returning with value null, so the lab can see it was on the report.',
    '',
    'Return ONLY a JSON object with this exact shape (no prose, no markdown):',
    '{ "parameters": [ { "testName": string|null, "parameterName": string, "value": string|null, "unit": string|null, "normalRange": string|null } ] }',
    'If the file is not a laboratory report, return {"parameters":[]}.',
  ].join('\n');
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function coerceParameter(raw: unknown): OcrLabParameter | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const parameterName = str(r.parameterName);
  // A row with no analyte name cannot be stored against anything.
  if (!parameterName) return null;
  return {
    testName: str(r.testName),
    parameterName,
    value: str(r.value),
    unit: str(r.unit),
    normalRange: str(r.normalRange),
  };
}

export function canOcrLabFile(mimeType: string): boolean {
  return isOcrConfigured() && OCR_SUPPORTED_MIME.has(mimeType);
}

/**
 * Read an uploaded lab report file into structured parameters. Throws a mapped
 * AppError when OCR is unconfigured, the file type is unsupported, or the AI
 * provider fails — callers that run this in the background should swallow it,
 * since the upload itself must never fail because OCR did.
 */
export async function parseLabReportFile(file: GeminiVisionFile): Promise<OcrLabReportResult> {
  const { text, model } = await callGeminiVision({
    prompt: buildPrompt(),
    file,
    feature: 'Lab report reading',
    fallbackHint: 'You can still type the values into the result grid.',
    maxOutputTokens: 8192,
  });

  const warnings: string[] = [];
  let parsed: { parameters?: unknown };
  try {
    parsed = parseModelJson<{ parameters?: unknown }>(text);
  } catch (err) {
    logger.error({ err, snippet: text.slice(0, 300) }, 'Lab OCR returned unparseable JSON');
    return { model, parameters: [], warnings: ['Could not read this report automatically.'] };
  }

  const raw = Array.isArray(parsed.parameters) ? parsed.parameters : [];
  const parameters = raw
    .map(coerceParameter)
    .filter((p): p is OcrLabParameter => p !== null);

  // Same analyte twice means the model read a repeated header or a second page
  // — keep the first and say so rather than silently writing both.
  const seen = new Set<string>();
  const deduped: OcrLabParameter[] = [];
  for (const p of parameters) {
    const key = p.parameterName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  if (deduped.length !== parameters.length) {
    warnings.push(`${parameters.length - deduped.length} duplicate parameter(s) ignored.`);
  }
  if (deduped.length === 0) {
    warnings.push('No lab parameters were found in this file.');
  }

  return { model, parameters: deduped, warnings };
}
