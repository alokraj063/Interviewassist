// Single-session Deepgram client for the mixed-mono browser-mic ingest path.
//
// The recruiter holds a personal cell phone in speakerphone mode with the
// candidate audible through the speaker; the laptop mic captures both
// voices as one stream. We do not get clean speaker channels, so this
// helper opens a single Deepgram session per call (no diarization — live
// diarization on a single mixed source is unreliable). All persisted
// turns get speaker='unknown'; the post_diarize worker re-runs Deepgram
// on the saved WAV with diarize=true and updates retroactively where
// confidence is high.
//
// This is parallel to apps/api/src/deepgram/stream.ts (which opens TWO
// streams for clean two-channel desktop captures). They don't share state.

import { createClient, LiveTranscriptionEvents, type LiveClient } from "@deepgram/sdk";
import type { TranscriptTurn } from "@j2w/shared-types";
import type { FastifyBaseLogger } from "fastify";
import { clearRubricTickState } from "../rag/live-rubric.js";
import { forgetSentiment } from "../rag/sentiment.js";
import { dropCall } from "../rag/suggest.js";
import { handleMixedFinal, handleMixedPartial } from "../transcription/mixed-turn.js";
import { clearSpeakers } from "../transcription/speaker-map.js";

interface SingleStream {
  callId: string;
  live: LiveClient;
  closed: boolean;
  keepAlive: NodeJS.Timeout;
  startedAt: number;
}

const active = new Map<string, SingleStream>();

const SINGLE_OPTS = {
  encoding: "linear16",
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  smart_format: true,
  punctuate: true,
  vad_events: true,
  utterance_end_ms: 1000,
  endpointing: 300,
  no_delay: true,
  // diarize=true: Deepgram tags each word with a speaker index even on a mixed
  // mono source. We use it for a fast PROVISIONAL recruiter/candidate label
  // (speaker-map.ts); the suggestion engine's LLM pass then authoritatively
  // relabels each final turn (rag/suggest.ts → transcript.relabel).
  diarize: true,
} as const;

/** Dominant Deepgram speaker index across the words in a transcript event. */
function dominantSpeaker(words: Array<{ speaker?: number }> | undefined): number {
  if (!words || words.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const w of words) {
    const s = w.speaker ?? 0;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [s, n] of counts) {
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return best;
}

export function ensureSingleStream(
  callId: string,
  apiKey: string,
  opts: { model?: string; language?: string },
  log: FastifyBaseLogger,
): SingleStream {
  const existing = active.get(callId);
  if (existing) return existing;

  // model/language come from the call's persisted transcriber selection so the
  // recruiter's choice in the Live Assist switcher is honored (defaults Nova-3 /
  // multi for Hinglish).
  const live = createClient(apiKey).listen.live({
    ...SINGLE_OPTS,
    model: opts.model || "nova-3",
    language: opts.language || "multi",
  });
  const state: SingleStream = {
    callId,
    live,
    closed: false,
    keepAlive: setInterval(() => {
      if (!state.closed) live.keepAlive();
    }, 5_000),
    startedAt: Date.now(),
  };

  live.on(LiveTranscriptionEvents.Open, () => {
    log.debug({ callId }, "deepgram (mixed-mono) opened");
  });

  live.on(LiveTranscriptionEvents.Transcript, async (evt) => {
    const alt = evt?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;
    const text: string = alt.transcript.trim();
    if (!text) return;
    const isFinal = evt.is_final === true;
    const start = (evt.start ?? 0) * 1000;
    const duration = (evt.duration ?? 0) * 1000;
    const dgSpeaker = dominantSpeaker(alt.words);

    const turn: TranscriptTurn = {
      id: -1,
      callId,
      // Provisional role from live diarization; the suggestion LLM relabels it
      // authoritatively on the next final (handleMixedFinal sets this).
      speaker: "unknown",
      text,
      isFinal,
      tsStartMs: Math.round(start),
      tsEndMs: Math.round(start + duration),
      sentiment: null,
    };

    // Shared with the Sarvam/Shunya single-bridge path so the live-assist
    // pipeline (persist → broadcast → sentiment → suggestion → rubric) behaves
    // identically across providers.
    if (isFinal) await handleMixedFinal(turn, log, dgSpeaker);
    else handleMixedPartial(turn, dgSpeaker);
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    log.error({ callId, err }, "deepgram (mixed-mono) error");
  });
  live.on(LiveTranscriptionEvents.Close, () => {
    state.closed = true;
    clearInterval(state.keepAlive);
  });

  active.set(callId, state);
  return state;
}

export function writeSingleFrame(callId: string, pcm: Buffer, log: FastifyBaseLogger): void {
  const stream = active.get(callId);
  if (!stream || stream.closed) return;
  try {
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    stream.live.send(ab);
  } catch (err) {
    log.warn({ err, callId }, "deepgram (mixed-mono) send failed");
  }
}

export async function closeSingleStream(callId: string): Promise<void> {
  const stream = active.get(callId);
  if (!stream) return;
  active.delete(callId);
  dropCall(callId);
  forgetSentiment(callId);
  clearRubricTickState(callId);
  clearSpeakers(callId);
  stream.closed = true;
  clearInterval(stream.keepAlive);
  try {
    stream.live.requestClose();
  } catch {
    // ignore
  }
}

export function isSingleStreamOpen(callId: string): boolean {
  return active.has(callId);
}
