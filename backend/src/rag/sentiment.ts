import Sentiment from "sentiment";
import type { FastifyBaseLogger } from "fastify";
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

// Post-call multilingual rescore removed in the Mongo migration — live
// sentiment (scorePartial) + the suggestion engine's per-turn sentiment cover
// the SentimentCard. Kept as a no-op so existing callers don't break.
export async function rescoreTurnsMultilingual(_callId: string, _log: FastifyBaseLogger): Promise<void> {
  return;
}
