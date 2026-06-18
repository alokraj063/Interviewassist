// Transcription provider selection for Live Assist test calls.
//
// Deepgram is wired natively through Vapi's `transcriber: { provider: "deepgram" }`.
// Sarvam and Shunya are routed via Vapi's `custom-transcriber` provider, which
// opens a WebSocket to our backend bridge that relays audio to the chosen
// upstream and returns transcripts in Vapi's expected shape. Switching here
// only changes the ticket the backend hands back when starting a test call —
// no other page state is affected.

export type TranscriptionProvider = "deepgram" | "sarvam" | "shunya";

export interface TranscriptionModel {
  id: string;
  label: string;
  /** Short hint shown alongside the model name in the selector. */
  hint?: string;
}

export const TRANSCRIPTION_PROVIDER_LABELS: Record<TranscriptionProvider, string> = {
  deepgram: "Deepgram (Nova-3)",
  sarvam: "Sarvam AI",
  shunya: "Shunya Labs",
};

export const TRANSCRIPTION_PROVIDER_SHORT: Record<TranscriptionProvider, string> = {
  deepgram: "Deepgram",
  sarvam: "Sarvam",
  shunya: "Shunya",
};

export const TRANSCRIPTION_PROVIDER_DESCRIPTIONS: Record<TranscriptionProvider, string> = {
  deepgram:
    "Nova-3 multilingual. Strong Hinglish code-mix support. Native Vapi integration.",
  sarvam:
    "Indic-native models (saaras:v3). Designed for Indian languages incl. Hindi code-mix. Routed through our backend bridge.",
  shunya:
    "Low-latency PCM streaming (wss://asr.shunyalabs.ai/ws). Routed through our backend bridge.",
};

export const TRANSCRIPTION_MODELS: Record<TranscriptionProvider, TranscriptionModel[]> = {
  deepgram: [
    { id: "nova-3", label: "Nova-3", hint: "recommended for Hinglish multi" },
    { id: "nova-2", label: "Nova-2" },
    { id: "nova", label: "Nova" },
  ],
  sarvam: [
    { id: "saaras:v3", label: "Saaras v3", hint: "recommended" },
    { id: "saaras:v2.5", label: "Saaras v2.5" },
    { id: "saaras:v2", label: "Saaras v2" },
  ],
  shunya: [
    { id: "shunya-streaming-v1", label: "Shunya Streaming v1" },
  ],
};

/** Language token passed to the provider. "multi" = let the provider auto-detect Hindi/English code-mix. */
export type TranscriptionLanguage = "multi" | "en-US" | "en-IN" | "hi-IN";

export const TRANSCRIPTION_LANGUAGES: Array<{ code: TranscriptionLanguage; label: string }> = [
  { code: "multi", label: "Hinglish (multi)" },
  { code: "hi-IN", label: "Hindi (hi-IN)" },
  { code: "en-IN", label: "English-India (en-IN)" },
  { code: "en-US", label: "English-US (en-US)" },
];

export interface TranscriptionSettings {
  provider: TranscriptionProvider;
  model: string;
  language: TranscriptionLanguage;
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  provider: "deepgram",
  model: "nova-3",
  language: "multi",
};

export const TRANSCRIPTION_SETTINGS_KEY = "liveAssist.transcriptionSettings.v1";

/** Pick the first model id for a provider; used when switching providers. */
export function firstModelFor(provider: TranscriptionProvider): string {
  return TRANSCRIPTION_MODELS[provider][0]?.id ?? "";
}
