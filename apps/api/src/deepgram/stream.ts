import { createClient, LiveTranscriptionEvents, type LiveClient } from "@deepgram/sdk";
import { db, transcriptTurns } from "@j2w/db";
import type { Speaker, TranscriptTurn } from "@j2w/shared-types";
import type { FastifyBaseLogger } from "fastify";
import { forgetSentiment, scorePartial } from "../rag/sentiment.js";
import { dropCall, maybeSuggest, rememberTurn } from "../rag/suggest.js";
import { maybeRubricTick } from "../rag/live-rubric.js";
import { broadcastToCall } from "../ws/session.js";
import { translateTurnIfEnabled } from "../translation/pipeline.js";

// One streaming session per channel per call. We keep the two sessions
// separate (rather than using diarization) for the desktop_dual_channel
// path because the Electron companion already hands us channel-separated
// audio — diarization would add latency and recall isn't needed when the
// channels are clean. Browser-mic mixed-mono (the wedge default) opens a
// separate code path in ws/ingest-call that uses a single Deepgram session
// without channel splitting.

interface ChannelStream {
  live: LiveClient;
  closed: boolean;
  keepAlive: NodeJS.Timeout;
}

interface CallStreams {
  callId: string;
  apiKey: string;
  recruiter: ChannelStream;
  candidate: ChannelStream;
  startedAt: number;
}

const active = new Map<string, CallStreams>();

const COMMON_OPTS = {
  model: "nova-3",
  language: "multi",
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
} as const;

function openChannel(
  callId: string,
  speaker: "recruiter" | "candidate",
  apiKey: string,
  log: FastifyBaseLogger,
): ChannelStream {
  const live = createClient(apiKey).listen.live(COMMON_OPTS);
  const state: ChannelStream = {
    live,
    closed: false,
    // Deepgram closes idle sockets after ~10s. KeepAlive every 5s keeps them
    // warm during silence so partials don't pay a reconnect on speech resume.
    keepAlive: setInterval(() => {
      if (!state.closed) live.keepAlive();
    }, 5_000),
  };

  live.on(LiveTranscriptionEvents.Open, () => {
    log.debug({ callId, speaker }, "deepgram opened");
  });

  live.on(LiveTranscriptionEvents.Transcript, async (evt) => {
    const alt = evt?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;
    const text: string = alt.transcript.trim();
    if (!text) return;
    const isFinal = evt.is_final === true;
    const start = (evt.start ?? 0) * 1000;
    const duration = (evt.duration ?? 0) * 1000;

    const turn: TranscriptTurn = {
      id: -1, // filled by DB insert for finals; partials are ephemeral
      callId,
      speaker,
      text,
      isFinal,
      tsStartMs: Math.round(start),
      tsEndMs: Math.round(start + duration),
      sentiment: null,
    };

    if (isFinal) {
      try {
        const [row] = await db
          .insert(transcriptTurns)
          .values({
            callId,
            speaker,
            text,
            isFinal: true,
            tsStartMs: turn.tsStartMs,
            tsEndMs: turn.tsEndMs,
          })
          .returning();
        turn.id = row.id;
      } catch (err) {
        log.error({ err, callId }, "failed to persist transcript turn");
      }
      rememberTurn(callId, turn);
      broadcastToCall(callId, { type: "transcript.final", turn });
      // Run translation in parallel — no-op when translation is off for
      // this call. Deepgram-produced turns share the same pipeline as
      // Vapi-forwarded ones from routes/calls.ts.
      void translateTurnIfEnabled({ callId, turn, log });
    } else {
      broadcastToCall(callId, { type: "transcript.partial", turn });
    }
    // Always run cheap local sentiment on candidate utterances so the chart
    // stays alive between the LLM's periodic corrections.
    if (speaker === "candidate") scorePartial(callId, text, log);
  });

  live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Candidate-channel utterance end triggers the suggestion loop and a live
    // rubric tick. Recruiter-channel utterance ends refresh context only.
    if (speaker !== "candidate") return;
    void maybeSuggest(callId, null, log);
    maybeRubricTick(callId, log);
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    log.error({ callId, speaker, err }, "deepgram error");
  });
  live.on(LiveTranscriptionEvents.Close, () => {
    state.closed = true;
    clearInterval(state.keepAlive);
  });

  return state;
}

export function ensureStreams(
  callId: string,
  apiKey: string,
  log: FastifyBaseLogger,
): CallStreams {
  const existing = active.get(callId);
  if (existing) return existing;
  const streams: CallStreams = {
    callId,
    apiKey,
    recruiter: openChannel(callId, "recruiter", apiKey, log),
    candidate: openChannel(callId, "candidate", apiKey, log),
    startedAt: Date.now(),
  };
  active.set(callId, streams);
  return streams;
}

export function writeFrame(callId: string, channel: Speaker, pcm: Buffer, log: FastifyBaseLogger): void {
  // Streams must already exist — they're opened in /ws/ingest after we've
  // resolved the tenant's Deepgram credential. If the key is missing the
  // ingest endpoint never calls ensureStreams and this becomes a no-op.
  const streams = active.get(callId);
  if (!streams) return;
  // 'unknown' / 'mixed' shouldn't reach this dual-channel path; they belong
  // to the browser_mixed code path which uses a single session. Treat them
  // as recruiter so audio still gets transcribed.
  const target = channel === "candidate" ? streams.candidate : streams.recruiter;
  if (target.closed) return;
  try {
    // Deepgram expects ArrayBuffer | Blob — convert Buffer to a fresh ArrayBuffer
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    target.live.send(ab);
  } catch (err) {
    log.warn({ err, callId, channel }, "deepgram send failed");
  }
}

export async function closeStreams(callId: string): Promise<void> {
  const streams = active.get(callId);
  if (!streams) return;
  active.delete(callId);
  dropCall(callId);
  forgetSentiment(callId);
  for (const ch of [streams.recruiter, streams.candidate]) {
    ch.closed = true;
    clearInterval(ch.keepAlive);
    try {
      ch.live.requestClose();
    } catch {
      // ignore
    }
  }
}

export function streamsOpen(callId: string): boolean {
  return active.has(callId);
}
