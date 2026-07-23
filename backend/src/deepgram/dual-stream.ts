// Two-channel Deepgram client for the FreJun softphone path.
//
// Sibling of deepgram/single-stream.ts — that one stays exactly as it is,
// serving the mixed-mono browser-mic wedge. The difference is the audio:
//
//   single-stream : one mixed mono source, diarize=true, speaker is a GUESS
//   dual-stream   : interleaved stereo, multichannel=true, speaker is KNOWN
//                   L (channel 0) = recruiter mic
//                   R (channel 1) = candidate, from the softphone's WebRTC leg
//
// Because the browser already interleaves the two sources, the PCM buffer is
// forwarded to Deepgram untouched — Deepgram splits the channels itself and
// tags each result with `channel_index: [n, total]`. No server-side demux.
//
// diarize is OFF: real channels beat inferred speakers, and enabling both
// invites Deepgram's diarizer to contradict ground truth.
import { createClient, LiveTranscriptionEvents, type LiveClient } from "@deepgram/sdk";
import type { FastifyBaseLogger } from "fastify";
import { forgetSentiment } from "../rag/sentiment.js";
import { dropCall } from "../rag/suggest.js";
import { clearAuthoritativeSpeakers } from "../rag/suggest.js";
import { clearDualTurnState, handleDualFinal, handleDualPartial } from "../transcription/dual-turn.js";

interface DualStream {
  callId: string;
  live: LiveClient;
  closed: boolean;
  keepAlive: NodeJS.Timeout;
  startedAt: number;
}

const active = new Map<string, DualStream>();

const DUAL_OPTS = {
  encoding: "linear16",
  sample_rate: 16000,
  channels: 2,
  multichannel: true,
  interim_results: true,
  smart_format: true,
  punctuate: true,
  vad_events: true,
  utterance_end_ms: 1000,
  endpointing: 300,
  no_delay: true,
  diarize: false,
} as const;

export function ensureDualStream(
  callId: string,
  apiKey: string,
  opts: { model?: string; language?: string },
  log: FastifyBaseLogger,
): DualStream {
  const existing = active.get(callId);
  if (existing) return existing;

  const live = createClient(apiKey).listen.live({
    ...DUAL_OPTS,
    model: opts.model || "nova-3",
    language: opts.language || "multi",
  });

  const state: DualStream = {
    callId,
    live,
    closed: false,
    keepAlive: setInterval(() => {
      if (!state.closed) live.keepAlive();
    }, 5_000),
    startedAt: Date.now(),
  };

  live.on(LiveTranscriptionEvents.Open, () => {
    log.debug({ callId }, "deepgram (dual-channel) opened");
  });

  live.on(LiveTranscriptionEvents.Transcript, async (evt) => {
    const alt = evt?.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    const text: string = alt.transcript.trim();
    if (!text) return;

    // `channel_index` is [thisChannel, totalChannels]. Defensive default keeps
    // a malformed frame on the recruiter side rather than dropping it.
    const channelIndex: number = Array.isArray(evt.channel_index) ? (evt.channel_index[0] ?? 0) : 0;
    const start = (evt.start ?? 0) * 1000;
    const duration = (evt.duration ?? 0) * 1000;
    const tsStartMs = Math.round(start);
    const tsEndMs = Math.round(start + duration);

    if (evt.is_final === true) {
      await handleDualFinal(callId, channelIndex, text, tsStartMs, tsEndMs, log);
    } else {
      handleDualPartial(callId, channelIndex, text, tsStartMs, tsEndMs);
    }
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    log.error({ callId, err }, "deepgram (dual-channel) error");
  });
  live.on(LiveTranscriptionEvents.Close, () => {
    state.closed = true;
    clearInterval(state.keepAlive);
  });

  active.set(callId, state);
  return state;
}

/** Forward one interleaved stereo PCM16 frame. Deepgram does the de-interleave. */
export function writeDualFrame(callId: string, pcm: Buffer, log: FastifyBaseLogger): void {
  const stream = active.get(callId);
  if (!stream || stream.closed) return;
  try {
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    stream.live.send(ab);
  } catch (err) {
    log.warn({ err, callId }, "deepgram (dual-channel) send failed");
  }
}

export async function closeDualStream(callId: string): Promise<void> {
  const stream = active.get(callId);
  if (!stream) return;
  active.delete(callId);
  dropCall(callId);
  forgetSentiment(callId);
  clearDualTurnState(callId);
  clearAuthoritativeSpeakers(callId);
  stream.closed = true;
  clearInterval(stream.keepAlive);
  try {
    stream.live.requestClose();
  } catch {
    // ignore
  }
}

export function isDualStreamOpen(callId: string): boolean {
  return active.has(callId);
}
