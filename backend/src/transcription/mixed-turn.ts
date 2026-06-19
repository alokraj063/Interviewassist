// Shared handling for a mixed-mono browser-mic transcript turn.
//
// The recruiter wedge captures one mixed audio stream, so we can't label
// speakers live — every turn is persisted as 'unknown' and every final fans
// out to the same live-assist pipeline (transcript broadcast, sentiment,
// suggestion engine, live rubric). This helper is shared by the Deepgram
// single-stream path (deepgram/single-stream.ts) and the Sarvam/Shunya
// single-bridge path (transcription/single-bridge.ts) so the two behave
// identically regardless of which STT provider the recruiter picked.
import { randomUUID } from "node:crypto";
import { collections } from "../mongo.js";
import type { TranscriptTurn } from "@j2w/shared-types";
import type { FastifyBaseLogger } from "fastify";
import { maybeRubricTick } from "../rag/live-rubric.js";
import { scorePartial } from "../rag/sentiment.js";
import { maybeSuggest, rememberTurn } from "../rag/suggest.js";
import { broadcastToCall } from "../ws/session.js";
import { provisionalRole } from "./speaker-map.js";

let _turnSeq = Date.now();
function nextTurnId(): number {
  return ++_turnSeq;
}

/**
 * Persist a final mixed-mono turn and fan it out: remember for RAG context,
 * broadcast to /ws/session, score sentiment, trigger a suggestion pass (every
 * final), and a rubric tick. Mutates `turn.id` with the persisted row id.
 *
 * `dgSpeaker` is the Deepgram diarization speaker index (0 when the provider
 * has no diarization, e.g. the Sarvam/Shunya bridge). It yields a PROVISIONAL
 * recruiter/candidate label shown immediately; the suggestion engine's LLM
 * pass relabels the turn authoritatively right after (transcript.relabel).
 */
export async function handleMixedFinal(
  turn: TranscriptTurn,
  log: FastifyBaseLogger,
  dgSpeaker = 0,
): Promise<void> {
  const role = provisionalRole(turn.callId, dgSpeaker);
  turn.speaker = role;
  // TranscriptTurn.id is a number (used as a UI key + for relabel matching);
  // keep a monotonic counter and store it on the Mongo doc.
  turn.id = nextTurnId();
  try {
    // Push the turn onto the interview's inline `transcript[]`. One doc per
    // call holds everything we need for post-call review.
    void randomUUID;
    const turnDoc = {
      id: turn.id,
      speaker: role,
      text: turn.text,
      tsStartMs: turn.tsStartMs,
      tsEndMs: turn.tsEndMs,
      isFinal: true,
      createdAt: new Date(),
    };
    // The Mongo driver's $push typings don't know about the inline
    // `transcript[]` field on our interview doc — runtime is fine.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collections.interviews().updateOne({ id: turn.callId }, { $push: { transcript: turnDoc } } as any);
  } catch (err) {
    log.error({ err, callId: turn.callId }, "failed to persist mixed-mono transcript turn");
  }
  rememberTurn(turn.callId, turn);
  broadcastToCall(turn.callId, { type: "transcript.final", turn });
  scorePartial(turn.callId, turn.text, log);
  void maybeSuggest(turn.callId, turn.id >= 0 ? turn.id : null, log);
  maybeRubricTick(turn.callId, log);
}

/** Broadcast an interim mixed-mono turn to the live UI (not persisted). */
export function handleMixedPartial(turn: TranscriptTurn, dgSpeaker = 0): void {
  turn.speaker = provisionalRole(turn.callId, dgSpeaker);
  broadcastToCall(turn.callId, { type: "transcript.partial", turn });
}
