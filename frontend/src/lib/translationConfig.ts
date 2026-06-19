import type {
  TranscriptTurn,
  TranslationProvider as ServerTranslationProvider,
} from "@j2w/shared-types";

export type SupportedLanguage =
  | "en-US"
  | "en-GB"
  | "en-IN"
  | "es-ES"
  | "es-MX"
  | "fr-FR"
  | "de-DE"
  | "it-IT"
  | "pt-BR"
  | "pt-PT"
  | "nl-NL"
  | "zh-CN"
  | "ja-JP"
  | "ko-KR"
  | "ar-SA"
  | "hi-IN"
  | "mr-IN"
  | "ta-IN"
  | "te-IN"
  | "bn-IN"
  | "multi";

export interface LanguageEntry {
  code: SupportedLanguage;
  label: string;
  nativeLabel: string;
  flag: string;
  shortCode: string;
}

export const LANGUAGE_CATALOG: LanguageEntry[] = [
  { code: "en-US", label: "English (US)", nativeLabel: "English", flag: "🇺🇸", shortCode: "EN" },
  { code: "en-GB", label: "English (UK)", nativeLabel: "English", flag: "🇬🇧", shortCode: "EN" },
  { code: "en-IN", label: "English (India)", nativeLabel: "English", flag: "🇮🇳", shortCode: "EN" },
  { code: "es-ES", label: "Spanish (Spain)", nativeLabel: "Español", flag: "🇪🇸", shortCode: "ES" },
  { code: "es-MX", label: "Spanish (Mexico)", nativeLabel: "Español", flag: "🇲🇽", shortCode: "ES" },
  { code: "fr-FR", label: "French", nativeLabel: "Français", flag: "🇫🇷", shortCode: "FR" },
  { code: "de-DE", label: "German", nativeLabel: "Deutsch", flag: "🇩🇪", shortCode: "DE" },
  { code: "it-IT", label: "Italian", nativeLabel: "Italiano", flag: "🇮🇹", shortCode: "IT" },
  { code: "pt-BR", label: "Portuguese (Brazil)", nativeLabel: "Português", flag: "🇧🇷", shortCode: "PT" },
  { code: "pt-PT", label: "Portuguese (Portugal)", nativeLabel: "Português", flag: "🇵🇹", shortCode: "PT" },
  { code: "nl-NL", label: "Dutch", nativeLabel: "Nederlands", flag: "🇳🇱", shortCode: "NL" },
  { code: "zh-CN", label: "Chinese (Mandarin)", nativeLabel: "中文", flag: "🇨🇳", shortCode: "ZH" },
  { code: "ja-JP", label: "Japanese", nativeLabel: "日本語", flag: "🇯🇵", shortCode: "JA" },
  { code: "ko-KR", label: "Korean", nativeLabel: "한국어", flag: "🇰🇷", shortCode: "KO" },
  { code: "ar-SA", label: "Arabic", nativeLabel: "العربية", flag: "🇸🇦", shortCode: "AR" },
  { code: "hi-IN", label: "Hindi", nativeLabel: "हिन्दी", flag: "🇮🇳", shortCode: "HI" },
  { code: "mr-IN", label: "Marathi", nativeLabel: "मराठी", flag: "🇮🇳", shortCode: "MR" },
  { code: "ta-IN", label: "Tamil", nativeLabel: "தமிழ்", flag: "🇮🇳", shortCode: "TA" },
  { code: "te-IN", label: "Telugu", nativeLabel: "తెలుగు", flag: "🇮🇳", shortCode: "TE" },
  { code: "bn-IN", label: "Bengali", nativeLabel: "বাংলা", flag: "🇮🇳", shortCode: "BN" },
  { code: "multi", label: "Hinglish (Hindi + English)", nativeLabel: "Hinglish", flag: "🇮🇳", shortCode: "MX" },
];

export function getLanguage(code: SupportedLanguage): LanguageEntry {
  return LANGUAGE_CATALOG.find((l) => l.code === code) ?? LANGUAGE_CATALOG[0];
}

export type TranslationMode = "off" | "inbound" | "bidirectional";

export type TranslationDisplayMode = "dual" | "translated-only" | "original-only";

export type TranslationLatencyMode = "realtime" | "balanced" | "accurate";

// Re-exported so the shared-types union is the single source of truth —
// "mock" and "openai" are the Phase 2 adapters that actually run, the rest
// are stubs. Keep this alias so existing call sites that pattern-match on
// the narrow union above keep compiling.
export type TranslationProvider = ServerTranslationProvider;

export type LowConfidenceAction = "show-warning" | "insert-original" | "drop";

export interface TranslationSettings {
  provider: TranslationProvider;
  model: string;
  defaultSourceLang: SupportedLanguage | "auto";
  defaultTargetLang: SupportedLanguage;
  autoDetect: boolean;
  latencyMode: TranslationLatencyMode;
  preserveTone: boolean;
  voiceCloning: boolean;
  confidenceThreshold: number;
  lowConfidenceAction: LowConfidenceAction;
  glossaryId: string | null;
  redactPII: boolean;
  customPhrases: string;
  profanityFilter: boolean;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  provider: "mock",
  model: "mock-v1",
  defaultSourceLang: "auto",
  defaultTargetLang: "en-US",
  autoDetect: true,
  latencyMode: "balanced",
  preserveTone: true,
  voiceCloning: false,
  confidenceThreshold: 0.6,
  lowConfidenceAction: "show-warning",
  glossaryId: null,
  redactPII: false,
  customPhrases: "",
  profanityFilter: false,
};

export interface TurnTranslation {
  sourceLang: SupportedLanguage;
  targetLang: SupportedLanguage;
  text: string;
  isFinal: boolean;
  confidence: number;
  latencyMs?: number;
}

export type TranslatedTurn = TranscriptTurn & {
  translation?: TurnTranslation;
};

export const TRANSLATION_STORAGE_KEY = "liveAssist.translation.v1";
export const TRANSLATION_SETTINGS_KEY = "liveAssist.translationSettings.v1";

export const PROVIDER_LABELS: Record<TranslationProvider, string> = {
  mock: "Mock (offline dev)",
  openai: "OpenAI (GPT-4o)",
  google: "Google Cloud Translation",
  deepl: "DeepL Pro",
  azure: "Azure AI Translator",
  sarvam: "Sarvam AI (Indic)",
};

// Which providers are actually wired in the backend right now. Stubs still
// appear in the selector but we mark them so users know what to expect.
export const PROVIDER_STATUS: Record<TranslationProvider, "live" | "stub"> = {
  mock: "live",
  openai: "live",
  google: "stub",
  deepl: "stub",
  azure: "stub",
  sarvam: "stub",
};

export const MOCK_GLOSSARIES = [
  { id: "hp-products", label: "HP Products & Model Names" },
  { id: "billing-terms", label: "Billing & Invoice Terms" },
  { id: "medical-basics", label: "Medical Support Basics" },
  { id: "legal-compliance", label: "Legal & Compliance" },
];
