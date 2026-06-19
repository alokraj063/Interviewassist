// Live rubric tick.
//
// During a live call we score the call's rubric every ~8 seconds against
// the most recent transcript activity. The result is broadcast over
// /ws/session as `rubric.tick` so the LiveAssist "Rubric live" panel can
// render bars in real time. The post-call rubric_finalize worker is
// authoritative — these live ticks are provisional (no QA review row,
// no permanent persistence).
//
// Debounced via a per-call timestamp map so a flurry of transcripts only
// triggers one LLM call.
//
// No-ops gracefully when:
//   - OPENAI_API_KEY is missing
//   - the call has no recent (last 60s) transcript turns
//   - the call's org has no default rubric configured
import { and, asc, desc, eq, gte } from "drizzle-orm";
import OpenAI from "openai";
import type { FastifyBaseLogger } from "fastify";
import {
  callRubrics,
  callSessions,
  db,
  transcriptTurns,
  type RubricCriterion,
} from "@j2w/db";
import { chatModel, env } from "../env.js";
import { broadcastToCall } from "../ws/session.js";

const TICK_DEBOUNCE_MS = 8_000;
const TRANSCRIPT_WINDOW_MS = 60_000;

const lastTickAt = new Map<string, number>();

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

const SYSTEM = `
You score a recruiter-candidate phone call against a structured rubric in
flight. The recruiter is using this score as a coaching nudge — your output
must be fast, partial, and faithful to ONLY what's in the supplied
transcript window. Don't infer about earlier in the call. For each
criterion output a numeric score in [0,100], a band based on the
criterion's bandThresholds, and a 1-sentence rationale.

This is a LIVE tick — uncertainty is expected. Score conservatively.
If a criterion has no relevant evidence in the window, score it 50 with
band "pass" and rationale "no recent evidence".
`.trim();

function buildSchema(criteria: RubricCriterion[]) {
  return {
    name: "live_rubric_tick",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores"],
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionId", "score", "band", "rationale"],
            properties: {
              criterionId: {
                type: "string",
                enum: criteria.map((c) => c.id),
              },
              score: { type: "number", minimum: 0, maximum: 100 },
              band: { type: "string", enum: ["fail", "pass", "excellent"] },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  } as const;
}

/**
 * Best-effort hook called from transcript.final paths. Returns immediately
 * after scheduling a tick (or skipping due to debounce).
 */
export function maybeRubricTick(
  callId: string,
  log: FastifyBaseLogger,
): void {
  const now = Date.now();
  const last = lastTickAt.get(callId) ?? 0;
  if (now - last < TICK_DEBOUNCE_MS) return;
  lastTickAt.set(callId, now);
  void runRubricTick(callId, log).catch((err) => {
    log.warn({ err, callId }, "live rubric tick failed");
  });
}

export async function runRubricTick(
  callId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!env.OPENAI_API_KEY) return;

  const [call] = await db
    .select({ id: callSessions.id, orgId: callSessions.orgId })
    .from(callSessions)
    .where(eq(callSessions.id, callId))
    .limit(1);
  if (!call?.orgId) return;

  const [rubric] = await db
    .select({
      id: callRubrics.id,
      name: callRubrics.name,
      criteria: callRubrics.criteria,
    })
    .from(callRubrics)
    .where(and(eq(callRubrics.orgId, call.orgId), eq(callRubrics.isDefault, true)))
    .limit(1);
  if (!rubric || rubric.criteria.length === 0) return;

  // Last-60s window of finalized turns. Fall back to "last 30 turns" when
  // there's no temporal info (call still warming up).
  const cutoffMs = Math.max(
    0,
    (await firstTranscriptOffsetMs(callId)) - 0,
  );
  const turns = await db
    .select({
      speaker: transcriptTurns.speaker,
      text: transcriptTurns.text,
      tsStartMs: transcriptTurns.tsStartMs,
      tsEndMs: transcriptTurns.tsEndMs,
    })
    .from(transcriptTurns)
    .where(
      and(
        eq(transcriptTurns.callId, callId),
        eq(transcriptTurns.isFinal, true),
        gte(transcriptTurns.tsStartMs, cutoffMs - TRANSCRIPT_WINDOW_MS),
      ),
    )
    .orderBy(asc(transcriptTurns.tsStartMs))
    .limit(30);
  if (turns.length === 0) return;

  const transcriptText = turns
    .map((t) => `[${t.tsStartMs}ms ${t.speaker}] ${t.text.replace(/\s+/g, " ")}`)
    .join("\n");
  const truncated =
    transcriptText.length > 6_000
      ? transcriptText.slice(-6_000)
      : transcriptText;

  const criteriaBlock = rubric.criteria
    .map(
      (c) =>
        `- id="${c.id}" name="${c.name}" weight=${c.weight} kind=${c.kind} ` +
        `bands(fail<${c.bandThresholds.fail}, pass>=${c.bandThresholds.pass}, ` +
        `excellent>=${c.bandThresholds.excellent})${c.description ? ` desc:${c.description}` : ""}`,
    )
    .join("\n");

  const userMessage = `Rubric: ${rubric.name}\nCriteria:\n${criteriaBlock}\n\nRecent transcript window:\n${truncated}\n\nRespond with the JSON object per the schema.`;

  let parsed: {
    scores: Array<{
      criterionId: string;
      score: number;
      band: "fail" | "pass" | "excellent";
      rationale: string;
    }>;
  };
  try {
    const res = await client().chat.completions.create({
      model: chatModel(),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMessage },
      ],
      response_format: {
        type: "json_schema",
        json_schema: buildSchema(rubric.criteria),
      },
      temperature: 0.2,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn({ err, callId, rubricId: rubric.id }, "live rubric LLM call failed");
    return;
  }

  broadcastToCall(callId, {
    type: "rubric.tick",
    callId,
    ts: Date.now(),
    rubricId: rubric.id,
    rubricName: rubric.name,
    scores: parsed.scores,
  });
}

// Helper: how far we are into the call (in transcript timestamp space).
// Returns the most recent turn's tsEndMs or 0.
async function firstTranscriptOffsetMs(callId: string): Promise<number> {
  const [latest] = await db
    .select({ tsEndMs: transcriptTurns.tsEndMs })
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(desc(transcriptTurns.tsEndMs))
    .limit(1);
  return latest?.tsEndMs ?? 0;
}

// Test/debug hook: clear state for a callId. Used when a call ends so we
// don't carry stale debounce timers across reruns.
export function clearRubricTickState(callId: string): void {
  lastTickAt.delete(callId);
}
