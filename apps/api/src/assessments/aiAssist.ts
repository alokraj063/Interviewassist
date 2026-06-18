// AI scoring assist for subjective assessment items (short_answer / long_answer).
//
// Real path: calls OpenAI chat completions to suggest a 0..max score + a short
// rationale, given the prompt, the candidate's response, and (optionally) the
// authoring sample answer. The suggestion is ADVISORY ONLY — it is surfaced in
// the reviewer UI labeled "AI suggestion (review required)" and is NEVER the
// sole grade; manual_score still requires a human PATCH.
//
// Stub fallback: when OPENAI_API_KEY is unset, suggestScore() resolves to
// { suggested: null, reason: "ai_scoring_unavailable" } so inline submit never
// 500s; the dedicated POST /attempts/:id/ai-assist endpoint answers 503.
import OpenAI from "openai";
import { chatModel, env } from "../env.js";

export interface AiSuggestInput {
  prompt: string;
  response: string;
  sampleAnswer?: string;
  maxPoints: number;
}

export interface AiSuggestResult {
  suggested: number | null;
  rationale: string | null;
  reason?: "ai_scoring_unavailable" | "provider_error" | "empty_response";
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

export function isAiAssistConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

const SYSTEM = `You are an expert technical interviewer grading a candidate's free-text
answer to a screening question. You will be given the QUESTION, an optional
reference SAMPLE ANSWER, the candidate's RESPONSE, and the MAX points available.
Score the response on correctness, completeness, and clarity. Be calibrated and
strict — a blank or off-topic answer scores 0. Return STRICT JSON only:
{"score": <integer 0..MAX>, "rationale": "<one or two sentences>"}.
Do not include any prose outside the JSON. The score must never exceed MAX.`;

/**
 * Suggest a score for a subjective response. Never throws on a missing key
 * (returns the stub shape); only throws when the caller explicitly wants the
 * error surfaced (the dedicated endpoint handles 503 itself by checking
 * isAiAssistConfigured() first).
 */
export async function suggestScore(input: AiSuggestInput): Promise<AiSuggestResult> {
  if (!env.OPENAI_API_KEY) {
    return { suggested: null, rationale: null, reason: "ai_scoring_unavailable" };
  }
  const trimmed = (input.response ?? "").trim();
  if (!trimmed) {
    return { suggested: 0, rationale: "Empty response.", reason: "empty_response" };
  }
  try {
    const res = await client().chat.completions.create({
      model: chatModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            QUESTION: input.prompt,
            SAMPLE_ANSWER: input.sampleAnswer ?? null,
            RESPONSE: trimmed.slice(0, 8000),
            MAX: input.maxPoints,
          }),
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { score?: unknown; rationale?: unknown };
    const score =
      typeof parsed.score === "number"
        ? Math.max(0, Math.min(input.maxPoints, Math.round(parsed.score)))
        : null;
    return {
      suggested: score,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 1000) : null,
    };
  } catch (err) {
    return {
      suggested: null,
      rationale: err instanceof Error ? err.message : "provider_error",
      reason: "provider_error",
    };
  }
}
