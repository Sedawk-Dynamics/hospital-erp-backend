// Shared types for the platform AI/LLM layer. Kept provider-agnostic so the
// active provider (Gemini, OpenAI, …) can be swapped from the super-admin
// AiConfig without any call site changing.

export type AiProvider = 'gemini' | 'openai' | 'disabled';

export type AiRole = 'user' | 'assistant';

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiGenerateOptions {
  /** System / behaviour instruction prepended to the conversation. */
  system?: string;
  /** Conversation turns (most recent last). A single prompt = one user turn. */
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the model for strict JSON output (Gemini responseMimeType / OpenAI response_format). */
  json?: boolean;
}

export interface AiGenerateResult {
  text: string;
  provider: AiProvider;
  model: string;
}

/** A provider knows how to turn a normalized request into raw text. */
export interface AiProviderClient {
  readonly provider: AiProvider;
  generate(opts: AiGenerateOptions, model: string, apiKey: string): Promise<string>;
}

/** Resolved, ready-to-use AI configuration (DB row merged with env fallbacks). */
export interface ResolvedAiConfig {
  provider: AiProvider;
  textModel: string;
  /** Ordered same-provider fallback models tried when the primary fails. */
  fallbackModels: string[];
  temperature: number;
  maxOutputTokens: number;
  apiKey: string;
  /** True when a usable provider + key is present. */
  ready: boolean;
  /** True when this resolved from the platform default (no hospital override). */
  inherited: boolean;
  features: {
    patientChat: boolean;
    platformChat: boolean;
    dischargeAi: boolean;
    radiologyAi: boolean;
  };
}
