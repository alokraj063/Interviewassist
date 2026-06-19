// Single-bridge client for the mixed-mono browser-mic wedge when the recruiter
// selects Sarvam or Shunya instead of Deepgram.
//
// This is the non-Deepgram analogue of deepgram/single-stream.ts: one upstream
// STT session per call, fed the same mixed-mono PCM16 16kHz frames the browser
// sends over /ws/ingest-call. We reuse the existing TranscriptionBridge
// implementations (createSarvamBridge / createShunyaBridge) — the same ones the
// Vapi-facing /ws/custom-transcriber uses — but here the audio source is the
// recruiter's laptop mic, not Vapi.
//
// Because the source is mixed-mono, turns are persisted as speaker='unknown'
// and every final fans out through the shared handleMixedFinal() helper, so the
// live-assist experience (transcript, sentiment, suggestions, live rubric) is
// identical to the Deepgram path.
import type { FastifyBaseLogger } from "fastify";
import type { TranscriptTurn } from "@j2w/shared-types";
import { clearRubricTickState } from "../rag/live-rubric.js";
import { forgetSentiment } from "../rag/sentiment.js";
import { dropCall } from "../rag/suggest.js";
import { createSarvamBridge } from "./sarvam.js";
import { createShunyaBridge } from "./shunya.js";
import type { TranscriptionBridge, TranscriptionLanguage } from "./provider.js";
import { handleMixedFinal, handleMixedPartial } from "./mixed-turn.js";

export type SingleBridgeProvider = "sarvam" | "shunya";

interface SingleBridge {
  callId: string;
  bridge: TranscriptionBridge;
  closed: boolean;
  startedAt: number;
}

const active = new Map<string, SingleBridge>();

export function ensureSingleBridge(
  callId: string,
  provider: SingleBridgeProvider,
  apiKey: string,
  opts: { model?: string; language?: TranscriptionLanguage },
  log: FastifyBaseLogger,
): SingleBridge {
  const existing = active.get(callId);
  if (existing) return existing;

  const factory = provider === "sarvam" ? createSarvamBridge : createShunyaBridge;
  const bridge = factory({
    callId,
    model: opts.model,
    language: opts.language,
    sampleRate: 16000,
    apiKey,
    log,
  });

  const state: SingleBridge = { callId, bridge, closed: false, startedAt: Date.now() };

  bridge.onTranscript((evt) => {
    if (state.closed) return;
    const text = evt.text.trim();
    if (!text) return;
    // Bridges don't carry reliable upstream timing for the browser-mic case, so
    // derive timestamps from a wall-clock offset since the session opened — same
    // approach the custom-transcriber bridge uses.
    const now = Date.now() - state.startedAt;
    const turn: TranscriptTurn = {
      id: -1,
      callId,
      speaker: "unknown",
      text,
      isFinal: evt.isFinal,
      tsStartMs: Math.max(0, now - 1000),
      tsEndMs: now,
      sentiment: null,
    };
    if (evt.isFinal) void handleMixedFinal(turn, log);
    else handleMixedPartial(turn);
  });

  bridge.onError((err) => {
    log.warn({ err, callId, provider }, "single-bridge upstream error");
  });
  bridge.onClose(() => {
    state.closed = true;
  });

  active.set(callId, state);
  return state;
}

export function writeSingleBridgeFrame(callId: string, pcm: Buffer): void {
  const stream = active.get(callId);
  if (!stream || stream.closed) return;
  stream.bridge.writeAudio(pcm);
}

export async function closeSingleBridge(callId: string): Promise<void> {
  const stream = active.get(callId);
  if (!stream) return;
  active.delete(callId);
  dropCall(callId);
  forgetSentiment(callId);
  clearRubricTickState(callId);
  stream.closed = true;
  try {
    stream.bridge.flush();
  } catch {
    // ignore
  }
  try {
    await stream.bridge.close();
  } catch {
    // ignore
  }
}

export function isSingleBridgeOpen(callId: string): boolean {
  return active.has(callId);
}
