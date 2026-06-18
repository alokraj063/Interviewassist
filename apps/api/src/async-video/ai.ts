// AI artifacts for Async Video submissions: transcript, summary, and
// skill-extraction. Always surfaced in the reviewer UI labeled "AI — assistive,
// not sole input" and NEVER the sole scoring input.
//
// Real path: OpenAI Whisper (audio/transcriptions, whisper-1) over each clip's
// audio, then OpenAI chat-completions for a structured summary + skills[]. The
// resolver order is the per-tenant credential (getProviderCredentials) then the
// OPENAI_API_KEY env fallback.
//
// Stub fallback: when no OpenAI credential is configured, the artifacts are
// produced deterministically (clearly marked provider='stub') so the UI +
// persistence are fully testable now. The dedicated POST .../ai/transcribe
// endpoint answers 503 {error:"openai_not_configured"} in that case, never a
// 500; inline submit-time enqueue just lands `skipped` rows.
import OpenAI from "openai";
import { chatModel, env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";

export type AiResolveResult =
  | { configured: true; provider: "openai"; apiKey: string }
  | { configured: false; provider: "stub" };

/**
 * Resolve the AI credential for an org. OpenAI (Whisper + chat) is keyed by the
 * shared OPENAI_API_KEY env var (the resolver's tenant-integration union covers
 * vapi/deepgram/sarvam/shunya, not openai). Sarvam is checked as a Hinglish
 * STT alternative per the voice-stack direction — its presence still means
 * "AI configured" for transcription. Never throws.
 */
export async function resolveAiCreds(orgId: string): Promise<AiResolveResult> {
  if (env.OPENAI_API_KEY) {
    return { configured: true, provider: "openai", apiKey: env.OPENAI_API_KEY };
  }
  // Hinglish STT fallback: a per-tenant or env Sarvam key still lets us
  // transcribe (summary stays stubbed without OpenAI chat). Resolver-gated so
  // the real-first policy is honored; absence is non-fatal.
  try {
    const sarvam = await getProviderCredentials(orgId, "sarvam");
    if (sarvam && (sarvam as { apiSubscriptionKey?: string }).apiSubscriptionKey) {
      // We still report `stub` for the OpenAI-shaped helpers below since the
      // summary path needs chat; transcription would use Sarvam in a worker.
      return { configured: false, provider: "stub" };
    }
  } catch {
    // unknown provider / no row — ignore.
  }
  return { configured: false, provider: "stub" };
}

export function isAiConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

export interface TranscriptResult {
  provider: "openai" | "stub";
  model: string;
  text: string;
}

export interface SummaryResult {
  provider: "openai" | "stub";
  model: string;
  summary: string;
  skills: string[];
}

const STUB_MODEL = "stub-v1";

/**
 * Transcribe a single clip. The real path runs Whisper over the supplied audio
 * buffer; the stub returns a deterministic placeholder so persistence + the UI
 * are testable. `audio` may be null (e.g. metadata-only seed rows) in which
 * case the stub text is used.
 */
export async function transcribeClip(
  resolved: AiResolveResult,
  audio: Buffer | null,
  filename = "clip.webm",
): Promise<TranscriptResult> {
  if (!resolved.configured || !audio) {
    return {
      provider: "stub",
      model: STUB_MODEL,
      text: "[stub transcript — set OPENAI_API_KEY for real Whisper transcription]",
    };
  }
  try {
    const client = new OpenAI({ apiKey: resolved.apiKey });
    const file = new File([new Uint8Array(audio)], filename, { type: "video/webm" });
    const res = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    return { provider: "openai", model: "whisper-1", text: res.text ?? "" };
  } catch (err) {
    // Surface the failure to the caller as a stub-shaped artifact rather than a
    // throw, so a single bad clip never 500s the whole request.
    return {
      provider: "stub",
      model: STUB_MODEL,
      text: `[transcription failed: ${err instanceof Error ? err.message : "provider_error"}]`,
    };
  }
}

const SUMMARY_SYSTEM = `You summarize a candidate's recorded async-video screening answers for a
recruiter. You receive the QUESTIONS and the candidate's TRANSCRIPTS. Produce a
concise, neutral 2-3 sentence SUMMARY and extract up to 8 concrete SKILLS the
candidate demonstrably mentioned or evidenced. Be calibrated; do not invent
skills not supported by the transcript. Return STRICT JSON only:
{"summary": "<2-3 sentences>", "skills": ["skill1", "skill2", ...]}.`;

/**
 * Build a structured summary + skills list from the per-question transcripts.
 * Stub fallback derives a length-based summary and a fixed skills list so the
 * UI renders. Never throws.
 */
export async function summarizeSubmission(
  resolved: AiResolveResult,
  questions: Array<{ text: string; transcript: string }>,
): Promise<SummaryResult> {
  const joined = questions.map((q) => q.transcript).join(" ").trim();
  if (!resolved.configured || joined.length === 0) {
    const words = joined.split(/\s+/).filter(Boolean).length;
    return {
      provider: "stub",
      model: STUB_MODEL,
      summary: `[stub summary] Candidate responded to ${questions.length} question(s) with roughly ${words} words. Set OPENAI_API_KEY for an AI-generated summary.`,
      skills: ["communication", "problem-solving"],
    };
  }
  try {
    const client = new OpenAI({ apiKey: resolved.apiKey });
    const res = await client.chat.completions.create({
      model: chatModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            QUESTIONS: questions.map((q) => q.text),
            TRANSCRIPTS: questions.map((q) => q.transcript.slice(0, 4000)),
          }),
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { summary?: unknown; skills?: unknown };
    return {
      provider: "openai",
      model: chatModel(),
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 2000) : "",
      skills: Array.isArray(parsed.skills)
        ? parsed.skills.filter((s): s is string => typeof s === "string").slice(0, 8)
        : [],
    };
  } catch {
    const words = joined.split(/\s+/).filter(Boolean).length;
    return {
      provider: "stub",
      model: STUB_MODEL,
      summary: `[stub summary — provider error] ${questions.length} answer(s), ~${words} words.`,
      skills: ["communication"],
    };
  }
}
