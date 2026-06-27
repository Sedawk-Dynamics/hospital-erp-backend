import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';

// ============================================================
// Smart clinical-decision suggestions via Google Gemini.
//
// Gated behind GEMINI_API_KEY. When the env var is missing we throw
// a badRequest instead of silently returning nothing — the UI needs a
// clear signal that the feature is not configured so it can hide the
// button or surface a toast.
// ============================================================

// Fallback only when GEMINI_MODEL is unset. 2.0-flash's free-tier quota is now 0.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface SmartSuggestionInput {
  chiefComplaints?: string;
  presentIllness?: string;
  vitalsSummary?: string;
  physicalObservations?: Array<{ value: string; system?: string }>;
  investigations?: string;
  diagnosis?: string;
  certainty?: 'provisional' | 'confirmed';
  medications?: string;
  advice?: string;
  // Optional patient context — keep PHI minimal; only age/sex/allergies.
  patientAge?: number | null;
  patientSex?: string | null;
  knownAllergies?: string[];
}

export interface SmartSuggestionResult {
  suggestions: string[];
  model: string;
}

function buildPrompt(input: SmartSuggestionInput): string {
  // Keep the payload compact — only fields the clinician has filled in.
  const cleaned = Object.fromEntries(
    Object.entries(input).filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (typeof v === 'string' && v.trim() === '') return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    }),
  );

  return [
    'You are a clinical decision-support assistant helping a doctor decide the next steps for a patient based on the current progress note.',
    '',
    'Rules:',
    '- Return exactly 3 suggestions, each actionable and specific.',
    '- Suggestions should cover a mix of: further investigations to order, treatment adjustments, monitoring, or follow-up.',
    '- Keep each suggestion under 15 words.',
    '- Do not add caveats or disclaimers in the suggestion text itself.',
    '- If the note is too sparse to reason about, still return 3 reasonable general-workup suggestions.',
    '',
    'Current progress note:',
    JSON.stringify(cleaned, null, 2),
    '',
    'Return ONLY a JSON object with this exact shape:',
    '{"suggestions": ["…", "…", "…"]}',
  ].join('\n');
}

function parseSuggestions(text: string): string[] {
  // With responseMimeType=application/json Gemini returns a bare JSON
  // object, but we still defensively strip code fences or surrounding
  // prose in case the config is ignored by a model.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in AI response');
  const parsed = JSON.parse(match[0]) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { suggestions?: unknown }).suggestions)
  ) {
    throw new Error('Response did not include a suggestions array');
  }
  const raw = (parsed as { suggestions: unknown[] }).suggestions;
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5);
}

export async function getSmartSuggestions(
  input: SmartSuggestionInput,
): Promise<SmartSuggestionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw AppError.badRequest(
      'AI suggestions are not configured on this server (set GEMINI_API_KEY).',
    );
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const prompt = buildPrompt(input);
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API key as header avoids exposing it in the URL / server logs.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 400,
          temperature: 0.4,
          // Force JSON output when the model supports it (Gemini 1.5+, 2.x).
          responseMimeType: 'application/json',
        },
      }),
    });
  } catch (err) {
    logger.error({ err }, 'Gemini API request failed');
    throw AppError.internal('AI suggestion service unreachable');
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, body: errText.slice(0, 500) }, 'Gemini API error');
    throw AppError.internal('AI suggestion service returned an error');
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    logger.warn({ blockReason: data.promptFeedback.blockReason }, 'Gemini blocked prompt');
    throw AppError.internal('AI suggestion service blocked the request');
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

  let suggestions: string[];
  try {
    suggestions = parseSuggestions(text);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, preview: text.slice(0, 200) },
      'Failed to parse AI suggestions',
    );
    throw AppError.internal('AI returned an unexpected format');
  }

  if (suggestions.length === 0) {
    throw AppError.internal('AI returned no usable suggestions');
  }

  return { suggestions, model };
}
