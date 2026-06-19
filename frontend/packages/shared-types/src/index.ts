// Types shared between apps/web, apps/api, apps/worker, apps/desktop.
// Keep this file dependency-free — no imports from drizzle, zod, etc.

export * from "./triage.js";

export type KBSourceType = "URL" | "Upload" | "Confluence" | "SharePoint";
export type KBSourceStatus = "indexing" | "indexed" | "error";

export interface KBSource {
  id: string;
  name: string;
  type: KBSourceType;
  status: KBSourceStatus;
  createdAt: string;
  lastIndexedAt: string | null;
  documentCount: number;
  retrievals7d: number;
}

export interface KBDocument {
  id: string;
  sourceId: string;
  title: string | null;
  uri: string | null;
  mime: string | null;
  bytes: number | null;
  chunkCount: number;
  status: "pending" | "parsing" | "embedding" | "indexed" | "error";
  errorMessage?: string | null;
  createdAt: string;
}

export interface KBIngestEvent {
  sourceId: string;
  documentId?: string;
  kind: "document.started" | "document.progress" | "document.indexed" | "document.error" | "source.status";
  status?: KBSourceStatus;
  chunkCount?: number;
  totalChunks?: number;
  message?: string;
  at: string;
}

// Mixed-mono browser-mic captures land with speaker='unknown'; the post_diarize
// worker flips to recruiter/candidate where Deepgram diarization confidence is
// high. Two-channel desktop captures and Vapi calls write the speaker
// definitively. 'mixed' is reserved for overlapping turns we can't split.
export type Speaker = "recruiter" | "candidate" | "unknown" | "mixed";

export interface TranscriptTurn {
  id: number;
  callId: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  tsStartMs: number;
  tsEndMs: number;
  sentiment: number | null;
}

export interface Citation {
  chunkId: number;
  sourceId: string;
  sourceName?: string;
  documentId: string;
  documentTitle?: string | null;
  // Which corpus the chunk came from. Optional so older serialized payloads
  // remain compatible — the live retrieve() always populates it now.
  corpus?: "jd" | "company" | "question_bank";
  snippet: string;
  score: number;
}

export interface SuggestionPayload {
  suggestion: string;
  sentiment: number;
  topics: string[];
  complianceFlags: string[];
  citations: Citation[];
  confidence: number;
}

export interface CallSession {
  id: string;
  recruiterUserId: string | null;
  candidateRefOrPhone: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: null | {
    overview: string;
    resolution: string;
    nextSteps: string[];
  };
}

// WebSocket message envelope sent from backend to the browser /session WS.
export type SessionServerMessage =
  | { type: "hello"; callId: string; ts: number }
  | { type: "transcript.partial"; turn: TranscriptTurn }
  | { type: "transcript.final"; turn: TranscriptTurn }
  // Authoritative speaker correction for an already-broadcast final turn.
  // Emitted by the suggestion engine's logical LLM pass when it determines
  // (from content: who is asking vs answering) that the live diarization
  // mislabeled who was speaking. The UI updates that turn's speaker in place.
  | { type: "transcript.relabel"; turnId: number; speaker: Speaker }
  | { type: "suggestion.begin"; requestId: string; triggerTurnId: number }
  | { type: "suggestion.delta"; requestId: string; text: string }
  | { type: "suggestion.end"; requestId: string; payload: SuggestionPayload; latencyMs: number }
  | { type: "sentiment.update"; value: number; ts: number }
  | { type: "topics.update"; topics: Array<{ name: string; confidence: number }> }
  | { type: "compliance.update"; items: Array<{ id: string; label: string; ok: boolean; ts?: number }> }
  | { type: "translation.config"; config: TranslationConfig | null }
  | {
      type: "translation.partial";
      turnId: number;
      speaker: Speaker;
      sourceLang: string;
      targetLang: string;
      text: string;
    }
  | {
      type: "translation.final";
      turnId: number;
      speaker: Speaker;
      sourceLang: string;
      targetLang: string;
      text: string;
      confidence: number;
      latencyMs: number;
      provider: TranslationProvider;
    }
  | {
      type: "language.detected";
      callId: string;
      code: string;
      confidence: number;
      alternates?: Array<{ code: string; confidence: number }>;
    }
  | { type: "call.ended"; callId: string; ts: number }
  // Triage warm-handoff lifecycle. Server picks an idle user in the target
  // team, seeds the triage transcript on that callId, and broadcasts
  // `handoff.incoming` to every socket on that callId — the assigned user's
  // browser (already on /live-assist) toasts an Accept prompt. Once accepted
  // the server pushes `handoff.accepted` so other listeners (supervisor)
  // know the call is no longer pending pickup.
  | {
      type: "handoff.incoming";
      callId: string;
      classification: import("./triage.js").Classification;
      transcriptTurns: TranscriptTurn[];
      triageAgentId: string;
      triageFlowName: string;
      handoffMode: import("./triage.js").TriageHandoffMode;
      summary: string;
      expiresAt: string;
    }
  | { type: "handoff.accepted"; callId: string; ts: number; acceptedByUserId: string }
  | { type: "handoff.failed"; callId: string; ts: number; reason: string }
  // Live (provisional) rubric scoring. Emitted every few seconds during a
  // live call once the post-call rubric_finalize worker has run, the
  // CallDetail Rubric tab replays the persisted ticks; the LiveAssist
  // "Rubric live" panel just consumes the most recent broadcast.
  | {
      type: "rubric.tick";
      callId: string;
      ts: number;
      rubricId: string;
      rubricName: string;
      scores: Array<{
        criterionId: string;
        score: number;
        band: "fail" | "pass" | "excellent";
        rationale: string;
      }>;
    }
  | { type: "error"; message: string };

export type SessionClientMessage =
  | { type: "dismiss"; suggestionId: number | string }
  | { type: "request_rephrase"; suggestionId: number | string }
  // Triage handoff Accept/Decline from the assigned user's browser. Server
  // forwards to the originating Vapi call (warm-transfer-completed or
  // declined) and emits `handoff.accepted` / `handoff.failed` on success.
  | { type: "handoff.accept"; callId: string }
  | { type: "handoff.decline"; callId: string; reason?: string }
  | { type: "ping" };

// ---------- Voice agents (Vapi-backed) ----------

export type VoiceAgentStatus = "draft" | "active" | "paused" | "archived";

// 'specialist' = autonomous voice agent that handles whole calls; 'triage' =
// front-door classifier that routes via the routeCall tool.
export type VoiceAgentKind = "specialist" | "triage";

export interface VoiceAgentRouting {
  intentVocabulary?: string[];
  defaultDestinationRef?: string;
  confidenceThreshold?: number;
}

// "multi" = Hinglish-ready (Deepgram multilingual mode). Add more as needed.
export type VoiceAgentLanguage = "multi" | "hi-IN" | "en-IN" | "en-US" | "en-GB" | "mr-IN" | "ta-IN" | "te-IN";

export interface VoiceAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  fulfillmentUrl?: string;
}

export interface VoiceAgentPersonality {
  warmth?: number;
  conciseness?: number;
  formality?: number;
  patience?: number;
  proactiveness?: number;
}

export interface VoiceAgentCompliance {
  disclosures?: string[];
  prohibited?: string[];
  piiRedaction?: boolean;
}

export interface VoiceAgentEscalation {
  handoffPhone?: string;
  rules?: string[];
}

// Provider-specific voice tuning. ElevenLabs uses model/speed/stability/
// similarityBoost; fallbackPlan hands control to another voice if the primary
// fails.
export interface VoiceAgentVoiceFallback {
  provider: string;
  voiceId: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
}

export interface VoiceAgentVoiceConfig {
  model?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  fallbackPlan?: { voices: VoiceAgentVoiceFallback[] };
}

// Mirrors Vapi's compliancePlan — distinct from the prompt-level `compliance`
// which holds disclosure/prohibited text that we inject into the system prompt.
export interface VoiceAgentCompliancePlan {
  hipaaEnabled?: boolean;
  pciEnabled?: boolean;
}

export interface VoiceAgent {
  id: string;
  orgId: string;
  name: string;
  kind: VoiceAgentKind;
  status: VoiceAgentStatus;
  purpose: string;

  systemPrompt: string;
  firstMessage: string;

  language: VoiceAgentLanguage;

  transcriberProvider: string;
  transcriberModel: string;
  transcriberLanguage: string;

  llmProvider: string;
  llmModel: string;
  llmTemperature: number;

  voiceProvider: string;
  voiceId: string;
  voiceConfig: VoiceAgentVoiceConfig | null;

  // Deepgram VAD endpointing (ms of silence ending an utterance).
  transcriberEndpointing: number | null;

  // Voicemail greeting + end-of-call line + hangup phrases.
  voicemailMessage: string | null;
  endCallMessage: string | null;
  endCallPhrases: string[];

  // Vapi event subscriptions (empty = Vapi defaults).
  clientMessages: string[];
  serverMessages: string[];

  // Vapi-native plans; passed through verbatim on deploy.
  artifactPlan: Record<string, unknown> | null;
  startSpeakingPlan: Record<string, unknown> | null;
  stopSpeakingPlan: Record<string, unknown> | null;
  compliancePlan: VoiceAgentCompliancePlan | null;

  tone: string;
  personality: VoiceAgentPersonality | null;
  tools: VoiceAgentTool[];
  knowledgeSourceIds: string[];
  compliance: VoiceAgentCompliance | null;
  escalation: VoiceAgentEscalation | null;

  maxDurationSec: number;

  vapiAssistantId: string | null;
  vapiPhoneId: string | null;
  vapiKbToolId: string | null;
  vapiSquadId: string | null;
  phoneNumber: string | null;
  lastDeployedAt: string | null;

  routing: VoiceAgentRouting | null;

  createdAt: string;
  updatedAt: string;
}

// Shape accepted by POST /api/voice-agents — thin wrapper so we can evolve independently.
export interface CreateVoiceAgentInput {
  name: string;
  kind?: VoiceAgentKind;
  purpose?: string;
  language?: VoiceAgentLanguage;
  systemPrompt?: string;
  firstMessage?: string;
  template?: "billing" | "scheduler" | "support" | "blank" | "triage";
}

// Partial update shape for PATCH /api/voice-agents/:id.
export type UpdateVoiceAgentInput = Partial<
  Omit<
    VoiceAgent,
    | "id"
    | "orgId"
    | "vapiAssistantId"
    | "vapiPhoneId"
    | "vapiKbToolId"
    | "phoneNumber"
    | "lastDeployedAt"
    | "createdAt"
    | "updatedAt"
  >
>;

export interface VoiceAgentDeployment {
  id: string;
  agentId: string;
  deployedAt: string;
  status: "success" | "failed";
  errorMessage: string | null;
}

export interface VapiVoiceOption {
  provider: string;
  voiceId: string;
  name: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  previewUrl?: string;
  accent?: string;
}

// Vapi → our server webhook events we care about. Keep a structural subset;
// unknown fields pass through via Record to avoid over-coupling to Vapi's schema.
export type VapiWebhookEvent =
  | {
      type: "call-started";
      call: { id: string; assistantId: string; startedAt?: string };
      [k: string]: unknown;
    }
  | {
      type: "call-ended";
      call: { id: string; assistantId: string; endedAt?: string; endedReason?: string };
      summary?: string;
      recordingUrl?: string;
      [k: string]: unknown;
    }
  | {
      type: "transcript";
      call: { id: string };
      role: "assistant" | "user";
      transcript: string;
      transcriptType?: "partial" | "final";
      [k: string]: unknown;
    }
  | {
      type: "function-call";
      call: { id: string; assistantId: string };
      functionCall: { name: string; parameters: Record<string, unknown> };
      [k: string]: unknown;
    }
  | {
      type: "status-update";
      call: { id: string };
      status: string;
      [k: string]: unknown;
    };

// WebSocket frame layout for /ws/ingest audio stream (legacy two-channel
// desktop path) and /ws/ingest-call (browser-mic mixed mono):
//   byte 0: channel tag (0 = recruiter, 1 = candidate). Browser-mic mode
//           sends only channel 0 frames; the speaker label is stored as
//           'unknown' until post-call diarization labels retroactively.
//   bytes 1..N: PCM linear16 little-endian, 16 kHz mono, 20ms = 640 bytes
export const AUDIO_FRAME_SAMPLE_RATE = 16000;
export const AUDIO_FRAME_DURATION_MS = 20;
export const AUDIO_FRAME_BYTES = 640;
export const AUDIO_CHANNEL_RECRUITER = 0;
export const AUDIO_CHANNEL_CANDIDATE = 1;

// ---------- Live translation ----------

// Providers the backend translation factory can resolve. "mock" is the default
// dev adapter (deterministic, no external calls); "openai" reuses the existing
// OPENAI_API_KEY to drive real translations for scenarios that don't fit the
// canned fixtures. The remaining vendors are stubbed for Phase 2 and throw
// NotImplemented until their adapters land.
export type TranslationProvider =
  | "mock"
  | "openai"
  | "google"
  | "deepl"
  | "azure"
  | "sarvam";

export type TranslationMode = "off" | "inbound" | "bidirectional";

export type TranslationLatencyMode = "realtime" | "balanced" | "accurate";

export type LowConfidenceAction = "show-warning" | "insert-original" | "drop";

// Runtime configuration for a translated call. Stored per-call in memory and
// echoed back to browsers on WS connect via translation.config so they can
// render the UI in the right mode without reloading.
export interface TranslationConfig {
  callId: string;
  mode: TranslationMode;
  provider: TranslationProvider;
  model: string;
  // "auto" defers to language detection on the first caller utterance.
  sourceLang: string | "auto";
  targetLang: string;
  latencyMode: TranslationLatencyMode;
  preserveTone: boolean;
  redactPII: boolean;
  glossaryId: string | null;
  confidenceThreshold: number;
  lowConfidenceAction: LowConfidenceAction;
  // When sourceLang === "auto", this is filled in once detection settles.
  detectedSourceLang?: { code: string; confidence: number };
}

// Shape persisted in `call_translations` (one row per translated turn).
export interface CallTranslationRecord {
  id: number;
  callId: string;
  turnId: number;
  speaker: Speaker;
  sourceLang: string;
  sourceText: string;
  targetLang: string;
  targetText: string;
  confidence: number;
  latencyMs: number;
  provider: TranslationProvider;
  createdAt: string;
}

// Workspace-level defaults — what Settings → Translation saves.
export interface WorkspaceTranslationSettings {
  orgId: string;
  provider: TranslationProvider;
  model: string;
  defaultSourceLang: string | "auto";
  defaultTargetLang: string;
  latencyMode: TranslationLatencyMode;
  preserveTone: boolean;
  voiceCloning: boolean;
  confidenceThreshold: number;
  lowConfidenceAction: LowConfidenceAction;
  glossaryId: string | null;
  redactPII: boolean;
  profanityFilter: boolean;
  customPhrases: string;
  updatedAt: string;
}

export interface TranslationGlossary {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  entries: TranslationGlossaryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface TranslationGlossaryEntry {
  id: string;
  glossaryId: string;
  sourceText: string;
  targetText: string;
  // Optional scope ("es-ES" → "en-US"). When unset, applies to any direction.
  sourceLang: string | null;
  targetLang: string | null;
}

export interface LanguageDetection {
  code: string;
  confidence: number;
  alternates?: Array<{ code: string; confidence: number }>;
}
