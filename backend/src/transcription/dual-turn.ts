// Fan-out for a TRUE dual-channel transcript turn (FreJun softphone path).
//
// Deliberately a sibling of transcription/mixed-turn.ts rather than a refactor
// of it: the mixed-mono mic path is in production and must not change. The two
// differ in one decisive way —
//
//   mixed-mono : speaker is a diarization GUESS, later corrected by an LLM pass
//   dual       : speaker is KNOWN from the audio channel; nothing may override it
//
// Channel contract (set by ws/ingest-dual.ts):
//   channel 0 → recruiter (laptop mic)
//   channel 1 → candidate (WebRTC remote stream from the softphone)
import type { FastifyBaseLogger } from "fastify";
import type { Speaker, TranscriptTurn } from "@j2w/shared-types";
import { collections } from "../mongo.js";
import { scorePartial } from "../rag/sentiment.js";
import { maybeSuggest, rememberTurn } from "../rag/suggest.js";
import { broadcastToCall } from "../ws/session.js";

let _turnSeq = Date.now();
function nextTurnId(): number {
  return ++_turnSeq;
}

export function speakerForChannel(channelIndex: number): Speaker {
  return channelIndex === 1 ? "candidate" : "recruiter";
}

// ─── Speaker-bleed suppression ───────────────────────────────────────────────
//
// The recruiter may run on laptop SPEAKERS rather than a headset. The
// candidate's voice then leaves the speaker, re-enters the mic, and lands on
// channel 0 as a ghost copy of something already transcribed on channel 1 —
// duplicate lines attributed to the wrong person.
//
// Browser-side AEC removes most of it (which is why echoCancellation must be
// ON for this path — the inverse of the old mic wedge, where it had to be OFF).
// This is the second line of defence for what leaks through.

interface RecentUtterance {
  text: string;
  at: number;
}
const recentByCall = new Map<string, { ch0: RecentUtterance[]; ch1: RecentUtterance[] }>();

/** How long a ghost can plausibly trail the real utterance. */
const BLEED_WINDOW_MS = 4000;
/** Token-overlap ratio above which two utterances are "the same thing". */
const BLEED_SIMILARITY = 0.72;
/** Very short texts ("haan", "ok") collide by chance — never treat them as bleed. */
const BLEED_MIN_CHARS = 12;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard overlap of the two token sets. */
function similarity(a: string, b: string): number {
  const A = new Set(normalize(a));
  const B = new Set(normalize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * True when this turn looks like the OTHER channel's audio bleeding in.
 * Only ever suppresses the recruiter channel: the candidate leg is clean
 * WebRTC, so a candidate-side match means the recruiter's own voice returned
 * over the phone line — real conversational audio we must keep.
 */
function isBleed(callId: string, channelIndex: number, text: string, now: number): boolean {
  if (channelIndex !== 0) return false;
  if (text.trim().length < BLEED_MIN_CHARS) return false;
  const buf = recentByCall.get(callId);
  if (!buf) return false;
  return buf.ch1.some((u) => now - u.at <= BLEED_WINDOW_MS && similarity(u.text, text) >= BLEED_SIMILARITY);
}

function remember(callId: string, channelIndex: number, text: string, now: number): void {
  let buf = recentByCall.get(callId);
  if (!buf) {
    buf = { ch0: [], ch1: [] };
    recentByCall.set(callId, buf);
  }
  const list = channelIndex === 1 ? buf.ch1 : buf.ch0;
  list.push({ text, at: now });
  // Bounded: only the last few seconds can ever match.
  const cutoff = now - BLEED_WINDOW_MS;
  while (list.length && list[0].at < cutoff) list.shift();
}

export function clearDualTurnState(callId: string): void {
  recentByCall.delete(callId);
}

// ─── Turn handling ───────────────────────────────────────────────────────────

/**
 * Persist a final dual-channel turn and fan it out exactly like the mixed path
 * does — transcript broadcast, sentiment, suggestion engine — but with an
 * authoritative speaker and no relabel pass.
 */
export async function handleDualFinal(
  callId: string,
  channelIndex: number,
  text: string,
  tsStartMs: number,
  tsEndMs: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const clean = text.trim();
  if (!clean) return;

  const now = Date.now();
  if (isBleed(callId, channelIndex, clean, now)) {
    log.debug({ callId, text: clean.slice(0, 60) }, "dropped speaker-bleed on recruiter channel");
    return;
  }
  remember(callId, channelIndex, clean, now);

  const turn: TranscriptTurn = {
    id: nextTurnId(),
    callId,
    speaker: speakerForChannel(channelIndex),
    text: clean,
    isFinal: true,
    tsStartMs,
    tsEndMs,
    sentiment: null,
  };

  try {
    await collections.interviews().updateOne(
      { id: callId },
      {
        $push: {
          transcript: {
            id: turn.id,
            speaker: turn.speaker,
            text: turn.text,
            tsStartMs: turn.tsStartMs,
            tsEndMs: turn.tsEndMs,
            isFinal: true,
            // Recorded so a later audit can tell a known speaker from a guessed
            // one without having to know which pipeline produced the row.
            channelIndex,
            speakerSource: "channel",
            createdAt: new Date(),
          },
        },
      } as never,
    );
  } catch (err) {
    log.error({ err, callId }, "failed to persist dual-channel transcript turn");
  }

  rememberTurn(callId, turn);
  broadcastToCall(callId, { type: "transcript.final", turn });
  scorePartial(callId, turn.text, log);
  void maybeSuggest(callId, turn.id, log);
}

/** Broadcast an interim dual-channel turn (not persisted, not bleed-checked). */
export function handleDualPartial(
  callId: string,
  channelIndex: number,
  text: string,
  tsStartMs: number,
  tsEndMs: number,
): void {
  const clean = text.trim();
  if (!clean) return;
  broadcastToCall(callId, {
    type: "transcript.partial",
    turn: {
      id: -1,
      callId,
      speaker: speakerForChannel(channelIndex),
      text: clean,
      isFinal: false,
      tsStartMs,
      tsEndMs,
      sentiment: null,
    },
  });
}
