import Sentiment from "sentiment";
import OpenAI from "openai";
import { asc, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, transcriptTurns } from "@j2w/db";
import { env } from "../env.js";
import { broadcastToCall } from "../ws/session.js";

// AFINN-based local sentiment — fires on every transcript partial (<1ms) so
// the SentimentCard chart updates continuously during speech. The LLM call
// in suggest.ts provides higher-quality periodic corrections via its own
// sentiment.update messages.

const analyzer = new Sentiment();

// Moving average per call so one noisy utterance doesn't swing the chart.
interface Trail {
  scores: number[];
  lastBroadcast: number;
}

const trails = new Map<string, Trail>();
const WINDOW = 6;
const MIN_BROADCAST_INTERVAL_MS = 300;

export function scorePartial(callId: string, text: string, log: FastifyBaseLogger): void {
  const trimmed = text.trim();
  if (trimmed.length < 6) return;

  const { comparative } = analyzer.analyze(trimmed);
  // Clamp to [-1, 1]. AFINN comparative scores usually sit in [-5, 5].
  const clamped = Math.max(-1, Math.min(1, comparative));

  let trail = trails.get(callId);
  if (!trail) {
    trail = { scores: [], lastBroadcast: 0 };
    trails.set(callId, trail);
  }
  trail.scores.push(clamped);
  if (trail.scores.length > WINDOW) trail.scores.splice(0, trail.scores.length - WINDOW);

  const now = Date.now();
  if (now - trail.lastBroadcast < MIN_BROADCAST_INTERVAL_MS) return;
  trail.lastBroadcast = now;

  const avg = trail.scores.reduce((s, v) => s + v, 0) / trail.scores.length;
  try {
    broadcastToCall(callId, { type: "sentiment.update", value: avg, ts: now });
  } catch (err) {
    log.warn({ err, callId }, "sentiment broadcast failed");
  }
}

export function forgetSentiment(callId: string): void {
  trails.delete(callId);
}

// ---------- Post-call multilingual rescore ----------
//
// AFINN is English-only. Hinglish turns score ~0 regardless of real emotion.
// After a call ends, rescore every customer turn with GPT-4o using a
// multilingual sentiment prompt and overwrite transcript_turns.sentiment.
// Runs in a single batched call so we pay ~one LLM request per ended call,
// not one per turn.

const RESCORE_SYSTEM = `
You score the sentiment of customer utterances from a contact-center call.
Utterances may be in English, Hindi, or Hinglish (code-mixed Hindi and
English). Return a number in [-1, 1] per utterance:

  -1.0 = very upset / angry / distressed
   0.0 = neutral / transactional
  +1.0 = positive / grateful / happy

Calibrate on customer intent, not surface politeness. Mild frustration that
stays professional is still negative. A sincere thanks at end-of-call is
clearly positive. Return ONLY the JSON object per the schema.
`.trim();

const RESCORE_SCHEMA = {
  name: "multilingual_sentiment_rescore",
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
          required: ["turnId", "score"],
          properties: {
            turnId: { type: "number" },
            score: { type: "number" },
          },
        },
      },
    },
  },
} as const;

let _rescoreClient: OpenAI | null = null;
function rescoreClient(): OpenAI {
  if (!_rescoreClient) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _rescoreClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _rescoreClient;
}

export async function rescoreTurnsMultilingual(
  callId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!env.OPENAI_API_KEY) {
    log.info({ callId }, "OPENAI_API_KEY not set — skipping multilingual sentiment rescore");
    return;
  }

  const turns = await db
    .select({
      id: transcriptTurns.id,
      speaker: transcriptTurns.speaker,
      text: transcriptTurns.text,
    })
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(asc(transcriptTurns.tsStartMs));

  // Score the candidate side. 'unknown' (mixed-mono browser-mic) gets
  // included too — sentiment on a mixed stream is approximate but more
  // useful than dropping it.
  const candidateTurns = turns.filter(
    (t) => (t.speaker === "candidate" || t.speaker === "unknown") && t.text.trim().length >= 3,
  );
  if (candidateTurns.length === 0) {
    log.info({ callId }, "no candidate turns to rescore");
    return;
  }

  const modelVersion = `${env.OPENAI_MODEL}/multilingual-v1`;
  const payload = candidateTurns.map((t) => ({ turnId: Number(t.id), text: t.text }));

  try {
    const res = await rescoreClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: RESCORE_SYSTEM },
        {
          role: "user",
          content:
            "Score each utterance. Input is a JSON array of {turnId, text}:\n" +
            JSON.stringify(payload),
        },
      ],
      response_format: { type: "json_schema", json_schema: RESCORE_SCHEMA },
      temperature: 0.1,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) {
      log.warn({ callId }, "multilingual rescore returned empty response");
      return;
    }
    const parsed = JSON.parse(raw) as { scores: Array<{ turnId: number; score: number }> };

    // Serial updates — N is small and transaction setup isn't worth it.
    let updated = 0;
    for (const s of parsed.scores) {
      const clamped = Math.max(-1, Math.min(1, Number(s.score) || 0));
      await db
        .update(transcriptTurns)
        .set({ sentiment: clamped, sentimentModel: modelVersion })
        .where(eq(transcriptTurns.id, s.turnId));
      updated += 1;
    }
    log.info({ callId, updated, modelVersion }, "multilingual sentiment rescore complete");
  } catch (err) {
    log.warn({ err, callId }, "multilingual sentiment rescore failed");
  }
}
