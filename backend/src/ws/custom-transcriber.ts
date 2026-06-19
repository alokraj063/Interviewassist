// Vapi `custom-transcriber` bridge.
//
// When Live Assist is configured to use Sarvam or Shunya, the `transcriber`
// field returned from /api/live-assist/test-call points Vapi at this WebSocket.
// Vapi then:
//   1. Opens a WS to <publicUrl>/ws/custom-transcriber?provider=...&callId=...
//   2. Sends a JSON "start" frame (encoding, sampleRate, channels, etc.)
//   3. Streams binary PCM frames (mono or interleaved stereo, linear16)
//   4. Expects text frames in response with shape:
//        { "type": "transcriber-response", "transcription": "...", "channel": "customer" | "assistant" }
//
// We keep the contract simple: one upstream provider session per speaker
// channel (mirrors the Deepgram-per-speaker pattern already in place). We
// also fan finalized transcripts into broadcastToCall() so the Live Assist
// UI shows the same transcript that Vapi is receiving — unifying the UI
// experience across providers.
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { WebSocket as WsSocket } from "ws";
import type { Speaker, TranscriptTurn } from "@j2w/shared-types";
import { randomUUID } from "node:crypto";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { createSarvamBridge } from "../transcription/sarvam.js";
import { createShunyaBridge } from "../transcription/shunya.js";
import {
  type TranscriptionBridge,
  type TranscriptionLanguage,
} from "../transcription/provider.js";
import { broadcastToCall } from "./session.js";
import { maybeRubricTick } from "../rag/live-rubric.js";
import { rememberTurn, maybeSuggest } from "../rag/suggest.js";
import { scorePartial } from "../rag/sentiment.js";

type ProviderKey = "sarvam" | "shunya";

interface StartMsg {
  type?: string;
  encoding?: string;
  container?: string;
  sampleRate?: number;
  channels?: number;
  language?: string;
}

function createBridge(
  provider: ProviderKey,
  opts: {
    callId?: string;
    model?: string;
    language?: TranscriptionLanguage;
    sampleRate?: number;
    apiKey: string;
    log: FastifyBaseLogger;
  },
): TranscriptionBridge {
  if (provider === "sarvam") return createSarvamBridge(opts);
  return createShunyaBridge(opts);
}

/**
 * Resolve the per-tenant credential for a custom-transcriber session.
 * The WS handshake carries `callId` (set by the live-assist route); we look up
 * the call's org and fetch credentials via the resolver. Falls back to env
 * when no callId is present (rare — only happens if Vapi opens the WS before
 * we've persisted a call_session row).
 */
async function resolveProviderApiKey(
  provider: ProviderKey,
  callId: string | undefined,
): Promise<string | null> {
  let orgId: string | null = null;
  if (callId) {
    const row = await collections.callSessions().findOne<{ orgId: string }>({ id: callId });
    orgId = row?.orgId ?? null;
  }
  if (orgId) {
    const secret = await getProviderCredentials(orgId, provider);
    if (secret) {
      return provider === "sarvam"
        ? (secret as { apiSubscriptionKey: string }).apiSubscriptionKey
        : (secret as { apiKey: string }).apiKey;
    }
  }
  // Last-resort env fallback — preserves dev behavior when Vapi opens a WS
  // before a call_session exists.
  if (provider === "sarvam") return env.SARVAM_API_SUBSCRIPTION_KEY ?? null;
  return env.SHUNYA_API_KEY ?? null;
}

/**
 * De-interleave a stereo PCM16 buffer into two mono buffers.
 * Channel 0 = left, Channel 1 = right. Assumes little-endian int16 samples.
 */
function splitStereo(pcm: Buffer): { left: Buffer; right: Buffer } {
  const samples = Math.floor(pcm.byteLength / 4); // 2 channels × 2 bytes
  const left = Buffer.allocUnsafe(samples * 2);
  const right = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const src = i * 4;
    const dst = i * 2;
    left[dst] = pcm[src];
    left[dst + 1] = pcm[src + 1];
    right[dst] = pcm[src + 2];
    right[dst + 1] = pcm[src + 3];
  }
  return { left, right };
}

export async function registerCustomTranscriberWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/custom-transcriber", { websocket: true }, (socket: WsSocket, req) => {
    const url = new URL(req.url, "http://local");
    const providerParam = url.searchParams.get("provider");
    const model = url.searchParams.get("model") ?? undefined;
    const language = (url.searchParams.get("language") ?? "multi") as TranscriptionLanguage;
    const callId = url.searchParams.get("callId") ?? undefined;
    const secret = url.searchParams.get("secret") ?? req.headers["x-vapi-secret"];

    if (providerParam !== "sarvam" && providerParam !== "shunya") {
      return socket.close(4400, "unsupported_provider");
    }
    const provider: ProviderKey = providerParam;

    if (env.CUSTOM_TRANSCRIBER_SECRET && secret !== env.CUSTOM_TRANSCRIBER_SECRET) {
      return socket.close(4401, "invalid_secret");
    }

    app.log.info({ provider, callId, model, language }, "custom-transcriber session opened");

    // Lazily allocate per-speaker upstream bridges; in the common case the
    // initial "start" frame declares channels=1 and we only need one.
    const bridges: Partial<Record<Speaker, TranscriptionBridge>> = {};
    let channels = 1;
    let sampleRate = 16000;
    let closed = false;
    // Resolved on first audio frame and cached for the session's lifetime.
    let apiKeyPromise: Promise<string | null> | null = null;
    function getApiKey(): Promise<string | null> {
      if (!apiKeyPromise) apiKeyPromise = resolveProviderApiKey(provider, callId);
      return apiKeyPromise;
    }

    function sendToVapi(transcription: string, speaker: Speaker): void {
      if (closed) return;
      try {
        socket.send(
          JSON.stringify({
            type: "transcriber-response",
            transcription,
            // Vapi speaker tags: "assistant" = Vapi's persona (the AI screener,
            // which we tag as 'recruiter' in our schema) and "customer" = the
            // candidate on the other end of the call.
            channel: speaker === "recruiter" ? "assistant" : "customer",
          }),
        );
      } catch (err) {
        app.log.warn({ err, callId }, "custom-transcriber send to vapi failed");
      }
    }

    async function onFinal(turn: TranscriptTurn): Promise<void> {
      if (!callId) return;
      try {
        turn.id = Date.now();
        await collections.transcriptTurns().insertOne({
          docId: randomUUID(), id: turn.id, callId, speaker: turn.speaker, text: turn.text,
          isFinal: true, tsStartMs: turn.tsStartMs, tsEndMs: turn.tsEndMs, sentiment: null, createdAt: new Date(),
        });
      } catch (err) {
        app.log.error({ err, callId }, "failed to persist custom-transcriber turn");
      }
      rememberTurn(callId, turn);
      broadcastToCall(callId, { type: "transcript.final", turn });
      if (turn.speaker === "candidate") {
        void maybeSuggest(callId, null, app.log);
      }
      maybeRubricTick(callId, app.log);
    }

    // Audio frames that arrived before the apiKey resolved. Replayed once the
    // bridge is created. Per-speaker so stereo splits don't get reordered.
    const pendingFrames: Partial<Record<Speaker, Buffer[]>> = {};
    const bridgeStarting: Partial<Record<Speaker, boolean>> = {};

    function startBridge(speaker: Speaker): void {
      if (bridges[speaker] || bridgeStarting[speaker]) return;
      bridgeStarting[speaker] = true;
      void getApiKey().then((apiKey) => {
        if (closed) return;
        if (!apiKey) {
          app.log.warn({ provider, callId, speaker }, "custom-transcriber credentials missing");
          try {
            socket.close(4503, "credentials_missing");
          } catch {
            // ignore
          }
          return;
        }
        const bridge = createBridge(provider, {
          callId,
          model,
          language,
          sampleRate,
          apiKey,
          log: app.log,
        });
        bridges[speaker] = bridge;
        wireBridgeListeners(speaker, bridge);
        // Flush any frames buffered while we were resolving credentials.
        const queued = pendingFrames[speaker];
        if (queued) {
          for (const f of queued) bridge.writeAudio(f);
          delete pendingFrames[speaker];
        }
      });
    }

    function ensureBridge(speaker: Speaker): TranscriptionBridge | null {
      const existing = bridges[speaker];
      if (existing) return existing;
      startBridge(speaker);
      return null;
    }

    function wireBridgeListeners(speaker: Speaker, bridge: TranscriptionBridge): void {
      const startedAt = Date.now();
      bridge.onTranscript((evt) => {
        sendToVapi(evt.text, speaker);
        if (!callId) return;
        const now = Date.now() - startedAt;
        const turn: TranscriptTurn = {
          id: -1,
          callId,
          speaker,
          text: evt.text,
          isFinal: evt.isFinal,
          tsStartMs: Math.max(0, now - 1000),
          tsEndMs: now,
          sentiment: null,
        };
        if (evt.isFinal) {
          void onFinal(turn);
        } else {
          broadcastToCall(callId, { type: "transcript.partial", turn });
        }
        if (speaker === "candidate" && !evt.isFinal) {
          scorePartial(callId, evt.text, app.log);
        }
      });
      bridge.onError((err) => {
        app.log.warn({ err, provider, callId, speaker }, "bridge error");
      });
      bridge.onClose(() => {
        app.log.debug({ provider, callId, speaker }, "bridge closed");
      });
    }

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (closed) return;
      if (!isBinary) {
        // Control frame — Vapi start/stop JSON.
        try {
          const msg = JSON.parse(raw.toString("utf8")) as StartMsg;
          if (typeof msg.channels === "number" && msg.channels > 0) channels = msg.channels;
          if (typeof msg.sampleRate === "number" && msg.sampleRate > 0) sampleRate = msg.sampleRate;
          app.log.debug({ msg, provider, callId }, "custom-transcriber start frame");
        } catch {
          // ignore unparsable control frames
        }
        return;
      }
      if (!(raw instanceof Buffer) || raw.byteLength === 0) return;

      function dispatch(speaker: Speaker, frame: Buffer): void {
        const ready = ensureBridge(speaker);
        if (ready) {
          ready.writeAudio(frame);
        } else {
          (pendingFrames[speaker] ??= []).push(frame);
        }
      }

      if (channels === 2) {
        const { left, right } = splitStereo(raw);
        // Vapi convention: channel 0 = assistant (the AI screener voice =
        // 'recruiter' in our schema), channel 1 = user/caller (= candidate).
        dispatch("recruiter", left);
        dispatch("candidate", right);
      } else {
        // Mono stream — treat as the AI screener (assistant) voice.
        dispatch("recruiter", raw);
      }
    });

    socket.on("close", async () => {
      closed = true;
      for (const speaker of ["recruiter", "candidate"] as Speaker[]) {
        await bridges[speaker]?.close();
      }
      app.log.info({ provider, callId }, "custom-transcriber session closed");
    });

    socket.on("error", (err) => {
      app.log.warn({ err, provider, callId }, "custom-transcriber socket error");
    });
  });
}
