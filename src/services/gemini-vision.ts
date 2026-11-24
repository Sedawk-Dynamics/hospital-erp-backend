import fs from 'fs';
import { AppError } from '../shared/appError';
import { logger } from '../config/logger';


const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MEDGEMMA_MODEL = process.env.MEDGEMMA_MODEL || '';
const MEDGEMMA_API_BASE = process.env.MEDGEMMA_API_BASE || '';



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


export async function callGeminiVision(params: {
  prompt: string;
  file: GeminiVisionFile;
  feature: string;
  /** What the user can still do when OCR is unavailable. */
  fallbackHint: string;
  maxOutputTokens?: number;
  model?:string
}): Promise<{ text: string; model: string }> {
  const { prompt, file, feature, fallbackHint } = params;
  if (params.model==="medgemma" && MEDGEMMA_MODEL && MEDGEMMA_API_BASE) return callOpenAIVision(params);

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


export function parseModelJson<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned) as T;
}


export async function callGeminiVisionImages(params: {
  prompt: string;
  images: { data: Buffer; mimetype: string }[];
  feature: string;
  fallbackHint: string;
  maxOutputTokens?: number;
  model?:string
}): Promise<{ text: string; model: string }> {
  const { prompt, images, feature, fallbackHint } = params;
  if (params.model==="medgemma" && MEDGEMMA_MODEL && MEDGEMMA_API_BASE) return callOpenAIVisionImages(params);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw AppError.badRequest(
      `${feature} is not configured on this server (set GEMINI_API_KEY). ${fallbackHint}`,
    );
  }
  if (!images.length) {
    throw AppError.badRequest(`${feature}: no images to analyse.`);
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimetype, data: img.data.toString('base64') },
    })),
  ];

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens ?? 2048,
          temperature: 0.2,
          // No responseMimeType → plain text/markdown, not JSON.
        },
      }),
    });
  } catch (err) {
    logger.error({ err, feature }, 'Gemini vision request failed');
    throw AppError.internal('AI vision service unreachable');
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, feature, body: errText.slice(0, 500) }, 'Gemini vision error');
    if (res.status === 429) {
      throw new AppError(
        `${feature} is temporarily unavailable — the AI provider quota/credits are exhausted. ${fallbackHint}`,
        503,
        'AI_QUOTA_EXHAUSTED',
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        `${feature} is misconfigured — the AI API key was rejected. Check GEMINI_API_KEY. ${fallbackHint}`,
        503,
        'AI_AUTH_ERROR',
      );
    }
    throw new AppError(
      `The AI vision service returned an error. Please try again. ${fallbackHint}`,
      502,
      'AI_UPSTREAM_ERROR',
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) {
    logger.warn({ blockReason: data.promptFeedback.blockReason, feature }, 'Gemini blocked prompt');
    throw AppError.internal('AI vision service blocked the request');
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return { text, model };
}











export const callOpenAIVision = async (params: {
  prompt: string;
  file: GeminiVisionFile;
  feature: string;
  fallbackHint: string;
  maxOutputTokens?: number;
}): Promise<{ text: string; model: string }> => {
  const { prompt, file, feature, fallbackHint } = params;
  const apiKey = process.env.OPENAI_API_KEY || 'ollama';
  if (!process.env.MEDGEMMA_API_BASE) {
    throw AppError.badRequest(
      `${feature} is not configured on this server (set MEDGEMMA_API_BASE). ${fallbackHint}`,
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

  const model = process.env.MEDGEMMA_MODEL || DEFAULT_MODEL;
  const url = `${process.env.MEDGEMMA_API_BASE}/chat/completions`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${base64}` } },
          ],
        }],
        max_tokens: params.maxOutputTokens ?? 4096,
        temperature: 0.1,
      })
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
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, model };
};










export async function callOpenAIVisionImages(params: {
  prompt: string;
  images: { data: Buffer; mimetype: string }[];
  feature: string;
  fallbackHint: string;
  maxOutputTokens?: number;
}): Promise<{ text: string; model: string }> {
  const { prompt, images, feature, fallbackHint } = params;

  const apiKey = process.env.OPENAI_API_KEY || 'ollama';
  if (!process.env.MEDGEMMA_API_BASE) {
    throw AppError.badRequest(
      `${feature} is not configured on this server (set MEDGEMMA_API_BASE). ${fallbackHint}`,
    );
  }
  if (!images.length) {
    throw AppError.badRequest(`${feature}: no images to analyse.`);
  }

  const model = process.env.MEDGEMMA_MODEL || DEFAULT_MODEL;
  const url = `${process.env.MEDGEMMA_API_BASE}/chat/completions`;

  // OpenAI/Ollama format: one user message whose content is the prompt text
  // followed by each image as a base64 data URL.
  const content = [
    { type: 'text', text: prompt },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimetype};base64,${img.data.toString('base64')}` },
    })),
  ];

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: params.maxOutputTokens ?? 2048,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    logger.error({ err, feature }, 'MedGemma vision request failed');
    throw AppError.internal('AI vision service unreachable');
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, feature, body: errText.slice(0, 500) }, 'MedGemma vision error');
    if (res.status === 429) {
      throw new AppError(
        `${feature} is temporarily unavailable — the AI provider is overloaded. ${fallbackHint}`,
        503,
        'AI_QUOTA_EXHAUSTED',
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        `${feature} is misconfigured — the AI API key was rejected. ${fallbackHint}`,
        503,
        'AI_AUTH_ERROR',
      );
    }
    throw new AppError(
      `The AI vision service returned an error. Please try again. ${fallbackHint}`,
      502,
      'AI_UPSTREAM_ERROR',
    );
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, model };
}
