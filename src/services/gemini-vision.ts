import fs from 'fs';
import { AppError } from '../shared/appError';
import { logger } from '../config/logger';

// ============================================================
// Gemini multimodal OCR — the shared plumbing behind every "read this uploaded
// file" feature (pharmacy supplier invoices, lab report PDFs/scans).
//
// Only the prompt and the shape of the expected JSON differ per caller, so the
// transport, the file read, and — most importantly — the upstream error mapping
// live here once. That mapping is the fiddly part: a 429 means the AI provider's
// quota is gone and a 401/403 means the key is wrong, and both need to reach the
// operator as something actionable rather than a generic 500.
// ============================================================

// Fallback only when GEMINI_MODEL is unset. gemini-2.0-flash had its free-tier
// quota zeroed (429 "limit: 0"); 2.5-flash is multimodal and still works.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** MIME types Gemini can OCR inline. Mirrors the upload allowlist (images + PDF). */
export const OCR_SUPPORTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

export interface GeminiVisionFile {
  path: string;
  mimetype: string;
  originalname?: string;
}

export function isOcrConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Send a prompt plus an uploaded file to Gemini and return the raw model text.
 *
 * `feature` is the human name used in error copy ("Invoice OCR", "Lab report
 * reading") so the operator knows which capability is degraded.
 */
export async function callGeminiVision(params: {
  prompt: string;
  file: GeminiVisionFile;
  feature: string;
  /** What the user can still do when OCR is unavailable. */
  fallbackHint: string;
  maxOutputTokens?: number;
}): Promise<{ text: string; model: string }> {
  const { prompt, file, feature, fallbackHint } = params;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw AppError.badRequest(
      `${feature} is not configured on this server (set GEMINI_API_KEY). ${fallbackHint}`,
    );
  }
  if (!OCR_SUPPORTED_MIME.has(file.mimetype)) {
    throw AppError.badRequest(
      `Unsupported file type '${file.mimetype}'. Upload a photo (JPG/PNG/WEBP) or a PDF.`,
    );
  }

  let base64: string;
  try {
    base64 = await fs.promises.readFile(file.path, { encoding: 'base64' });
  } catch (err) {
    logger.error({ err, path: file.path }, 'Failed to read uploaded file for OCR');
    throw AppError.internal('Could not read the uploaded file');
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, { inlineData: { mimeType: file.mimetype, data: base64 } }],
          },
        ],
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens ?? 4096,
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });
  } catch (err) {
    logger.error({ err, feature }, 'Gemini OCR request failed');
    throw AppError.internal('OCR service unreachable');
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, feature, body: errText.slice(0, 500) }, 'Gemini OCR error');
    if (res.status === 429) {
      throw new AppError(
        `${feature} is temporarily unavailable — the AI provider quota/credits are exhausted. Top up billing on the Gemini API key (or set a new GEMINI_API_KEY). ${fallbackHint}`,
        503,
        'OCR_QUOTA_EXHAUSTED',
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        `${feature} is misconfigured — the AI API key was rejected. Check GEMINI_API_KEY on the server. ${fallbackHint}`,
        503,
        'OCR_AUTH_ERROR',
      );
    }
    throw new AppError(
      `The AI OCR service returned an error. Please try again in a moment. ${fallbackHint}`,
      502,
      'OCR_UPSTREAM_ERROR',
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) {
    logger.warn({ blockReason: data.promptFeedback.blockReason, feature }, 'Gemini blocked prompt');
    throw AppError.internal('OCR service blocked the request');
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return { text, model };
}

/**
 * Parse the model's reply as JSON. `responseMimeType: application/json` usually
 * yields clean JSON, but a fenced ```json block still turns up, so strip that
 * before parsing rather than failing the whole extraction on a wrapper.
 */
export function parseModelJson<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned) as T;
}
