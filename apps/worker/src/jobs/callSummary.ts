// call_summary worker.
//
// Post-call: read the persisted transcript, ask the LLM to produce a
// structured recruiter wrap-up, and persist it as JSON on
// `call_sessions.summary`. The Call Detail "Summary" tab reads that JSON
// directly — no other consumer.
//
// No-op gracefully when OPENAI_API_KEY isn't set or the call has zero
// transcript turns. Both are recoverable: if the key arrives later or
// transcripts land via post-diarize, the next enqueue produces a summary.
import { asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { Logger } from "pino";
import { callSessions, db, transcriptTurns } from "@j2w/db";
import {
  getProspectOutcomeExtractQueue,
  type CallSummaryJob,
} from "@j2w/ingest-shared";

interface SummaryResult {
  skipped: boolean;
  reason?: string;
  unaddressedCount?: number;
}

const SUMMARY_SYSTEM = `
You summarize a recruiter-candidate phone call into a brief wrap-up for the
recruiter's records and downstream stakeholders (delivery lead, account
manager, QA reviewer). Output ONLY the JSON per the schema. Be concise,
neutral, and faithful — never invent facts.

The conversation is typically Hinglish (Hindi + English code-mix). The
recruiter is screening the candidate for an open role (a "demand"). Capture:

- overview: 1–2 sentences on the candidate's profile and how the call went.
- discoveredFacts: structured discovery items the recruiter actually
  captured during the call. Leave fields null when not discussed.
  Fields: currentCompany, currentTitle, totalExperienceYears, currentCtcLakhs,
  expectedCtcLakhs, noticePeriodDays, noticePeriodNegotiable, currentLocation,
  willingToRelocate, reasonForChange.
- unaddressedItems: 0–4 items that should have been captured but weren't.
- nextStep: one concrete next action ("schedule L1 with client X",
  "drop — not a fit on CTC", "share JD then follow up Mon").
- recruiterNotes: 1–3 sentences of qualitative observations (red flags,
  cultural fit signals, technical depth indicators).
`.trim();

const SUMMARY_SCHEMA = {
  name: "call_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "overview",
      "discoveredFacts",
      "unaddressedItems",
      "nextStep",
      "recruiterNotes",
    ],
    properties: {
      overview: { type: "string" },
      discoveredFacts: {
        type: "object",
        additionalProperties: false,
        required: [
          "currentCompany",
          "currentTitle",
          "totalExperienceYears",
          "currentCtcLakhs",
          "expectedCtcLakhs",
          "noticePeriodDays",
          "noticePeriodNegotiable",
          "currentLocation",
          "willingToRelocate",
          "reasonForChange",
        ],
        properties: {
          currentCompany: { type: ["string", "null"] },
          currentTitle: { type: ["string", "null"] },
          totalExperienceYears: { type: ["number", "null"] },
          currentCtcLakhs: { type: ["number", "null"] },
          expectedCtcLakhs: { type: ["number", "null"] },
          noticePeriodDays: { type: ["number", "null"] },
          noticePeriodNegotiable: { type: ["boolean", "null"] },
          currentLocation: { type: ["string", "null"] },
          willingToRelocate: { type: ["boolean", "null"] },
          reasonForChange: { type: ["string", "null"] },
        },
      },
      unaddressedItems: { type: "array", items: { type: "string" } },
      nextStep: { type: "string" },
      recruiterNotes: { type: "string" },
    },
  },
} as const;

let _client: OpenAI | null = null;
function client(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  if (!_client) _client = new OpenAI({ apiKey: key });
  return _client;
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export async function processCallSummary(
  job: CallSummaryJob,
  log: Logger,
): Promise<SummaryResult> {
  const { callId } = job;

  const turns = await db
    .select({
      speaker: transcriptTurns.speaker,
      text: transcriptTurns.text,
    })
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(asc(transcriptTurns.tsStartMs));

  if (turns.length === 0) {
    log.info({ callId }, "call summary: no transcript turns — skipping");
    return { skipped: true, reason: "no_transcript" };
  }

  if (!process.env.OPENAI_API_KEY) {
    log.info({ callId }, "call summary: OPENAI_API_KEY not set — skipping");
    return { skipped: true, reason: "no_openai_key" };
  }

  const transcript = turns
    .map((t) => `${t.speaker.toUpperCase()}: ${t.text}`)
    .join("\n");
  // The OpenAI 4o context is fine for full transcripts, but cap at the
  // tail-12k path the in-process implementation used so behaviour matches
  // when this worker takes over from the inline call.
  const truncated =
    transcript.length > 12_000 ? transcript.slice(-12_000) : transcript;

  const res = await client().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content: `Transcript:\n${truncated}\n\nRespond with the JSON object per the schema.`,
      },
    ],
    response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA },
    temperature: 0.2,
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) {
    log.warn({ callId }, "call summary: empty response");
    return { skipped: true, reason: "empty_response" };
  }

  const parsed = JSON.parse(raw) as {
    overview: string;
    discoveredFacts: Record<string, unknown>;
    unaddressedItems: string[];
    nextStep: string;
    recruiterNotes: string;
  };

  await db
    .update(callSessions)
    .set({ summary: parsed })
    .where(eq(callSessions.id, callId));

  // Chain — prospect_outcome_extract maps the structured summary onto the
  // linked prospect row. No-op when the call has no prospectId.
  try {
    await getProspectOutcomeExtractQueue().add(
      `prospect-outcome-${callId}`,
      { callId },
      { jobId: `prospect-outcome-${callId}` },
    );
  } catch (err) {
    log.warn({ err, callId }, "prospect_outcome_extract enqueue failed");
  }

  log.info(
    { callId, unaddressedCount: parsed.unaddressedItems.length },
    "call summary written",
  );
  return { skipped: false, unaddressedCount: parsed.unaddressedItems.length };
}
