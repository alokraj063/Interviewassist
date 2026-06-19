import type {
  LanguageDetection,
  TranslationProvider as TranslationProviderId,
} from "@j2w/shared-types";

// A single translation request. Callers supply the source & target locale
// codes verbatim (e.g. "es-ES" → "en-US"); adapters normalise internally if
// the vendor expects a different format.
export interface TranslateTextInput {
  text: string;
  sourceLang: string;
  targetLang: string;
  /** Optional glossary-shaped hints. Vendors that support native glossaries
   *  (Google, DeepL) use them; others splice the mappings in post-process. */
  glossary?: Array<{ source: string; target: string }>;
  /** "realtime" biases toward speed over fidelity; "accurate" the opposite. */
  latencyMode?: "realtime" | "balanced" | "accurate";
  /** Context window for the translator (prior turns). Helps with pronoun and
   *  tone consistency. Adapters that don't support context just ignore it. */
  context?: string[];
}

export interface TranslateTextOutput {
  text: string;
  confidence: number;
  latencyMs: number;
  provider: TranslationProviderId;
}

// Input to language detection. Adapters that need audio return a rejected
// promise until audio streaming lands in Phase 2.5 — for now we detect from
// the first transcript turn (text input) only.
export interface DetectLanguageInput {
  text?: string;
  // Reserved for audio-based detection (PCM16 20ms frames). Unused today.
  audio?: Uint8Array;
}

export interface TranslationProvider {
  readonly id: TranslationProviderId;
  translateText(input: TranslateTextInput): Promise<TranslateTextOutput>;
  detectLanguage(input: DetectLanguageInput): Promise<LanguageDetection>;
}

// Central place for the "this vendor isn't wired yet" error so the routes
// surface a consistent 501 instead of a random throw.
export class NotImplementedError extends Error {
  constructor(provider: TranslationProviderId, capability: string) {
    super(
      `Translation provider "${provider}" does not implement ${capability} yet. ` +
        `Switch to "mock" or "openai" in Settings → Translation.`,
    );
    this.name = "NotImplementedError";
  }
}
