// AI draft for a manager → recruiter coaching nudge.
//
// Real path: calls OpenAI chat completions to draft a short, kind, actionable
// coaching message from the recruiter's KPI gap (e.g. "selects 2/6 of the
// quarterly goal"). Advisory only — the manager reviews + edits before sending;
// the nudge endpoint never sends an AI message without an explicit POST.
//
// Stub / unconfigured: the dedicated draft endpoint checks isNudgeDraftConfigured()
// first and answers 503 { error: "openai_key_missing" } so the FE shows a precise
// "AI drafting unavailable — add OPENAI_API_KEY" and the manager types it manually.
// draftNudgeMessage() itself never throws on a missing key (returns null) so an
// accidental call can't 500.
import OpenAI from "openai";
import { chatModel, env } from "../env.js";

export interface NudgeDraftInput {
  recruiterName: string;
  kind: string;
  metric?: string;
  actual?: number;
  target?: number;
  context?: string;
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

export function isNudgeDraftConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

const SYSTEM = `You are a delivery lead at a staffing firm writing a short, kind, and
actionable coaching nudge to a recruiter on your team. Use the recruiter's name,
acknowledge effort, name the specific gap, and suggest one concrete next step.
Keep it under 60 words, warm and respectful (never punitive). Return STRICT JSON
only: {"message": "<the nudge text>"}. No prose outside the JSON.`;

/**
 * Draft a coaching message. Returns null when no key is configured (callers that
 * want a 503 must check isNudgeDraftConfigured() first). On a provider error,
 * returns null so the FE falls back to manual typing rather than surfacing a 500.
 */
export async function draftNudgeMessage(input: NudgeDraftInput): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const res = await client().chat.completions.create({
      model: chatModel(),
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            RECRUITER: input.recruiterName,
            KIND: input.kind,
            METRIC: input.metric ?? null,
            ACTUAL: input.actual ?? null,
            TARGET: input.target ?? null,
            CONTEXT: input.context ?? null,
          }),
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message.slice(0, 2000) : null;
  } catch {
    return null;
  }
}
