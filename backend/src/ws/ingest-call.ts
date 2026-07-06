// Browser-mic mixed-mono ingest WebSocket — the recruiter live-assist wedge.
//
// Distinct from /ws/ingest (which is the legacy two-channel desktop path
// using a per-channel byte-tagged frame format) and from /ws/custom-transcriber
// (which is Vapi-facing).
//
// Frame format:
//   - Binary frames: raw PCM16 little-endian @ 16kHz mono, 20ms = 640 bytes each
//   - No channel-tag prefix (single mixed source)
//   - Browser is expected to use AudioWorklet → linear16 16kHz mono via downsample
//
// On open:
//   - Validate JWT, look up the call_session row, confirm caller owns it
//     (recruiterUserId === jwt.sub or the caller has calls.assign)
//   - Resolve the org's Deepgram credential, open a single Deepgram stream
//   - Optionally start dumping the mixed audio to a WAV for post_diarize
//
// On close:
//   - Persist final recording_url, durationMs
//   - Close the Deepgram session

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { collections } from "../mongo.js";
import {
  closeSingleStream,
  ensureSingleStream,
  writeSingleFrame,
} from "../deepgram/single-stream.js";
import {
  closeSingleBridge,
  ensureSingleBridge,
  writeSingleBridgeFrame,
} from "../transcription/single-bridge.js";
import type { TranscriptionLanguage } from "../transcription/provider.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { recordAudioUsage } from "../usage/tracker.js";
import { blobStore } from "@j2w/ingest-shared";
import { authenticateOl } from "../auth/olAuth.js";

// Wrap accumulated linear16 16kHz mono PCM in a WAV container for storage.
function pcmToWav(pcm: Buffer): Buffer {
  const SAMPLE_RATE = 16000, BITS = 16, CH = 1;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(CH, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE((SAMPLE_RATE * CH * BITS) / 8, 28); h.writeUInt16LE((CH * BITS) / 8, 32); h.writeUInt16LE(BITS, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

interface IngestState {
  callId: string;
  userEmail: string;
  bytesSent: number;
  startedAt: number;
  chunks: Buffer[];   // raw PCM frames — concatenated + uploaded to S3 on close
}

export async function registerIngestCallWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/ingest-call", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");
    const mode = url.searchParams.get("mode") ?? "browser_mixed";

    if (!callId) return socket.close(4400, "missing_callId");
    if (mode !== "browser_mixed" && mode !== "desktop_dual_channel") {
      return socket.close(4400, `unsupported_mode:${mode}`);
    }

    // OL SSO — the browser's WebSocket handshake carries the `authToken`
    // cookie automatically, same as a regular fetch. We use the same
    // verifier the HTTP routes use.
    const user = await authenticateOl(req as FastifyRequest);
    if (!user) return socket.close(4401, "missing_or_invalid_token");

    // Look up the call. Ownership is by recruiterUserId === user.uid.
    const row = await collections.interviews().findOne<{
      id: string; recruiterUserId: string | null; mode: string;
      transcriberProvider: string | null; transcriberModel: string | null; transcriberLanguage: string | null;
    }>({ id: callId });
    if (!row) return socket.close(4404, "call_not_found");
    if (row.recruiterUserId && row.recruiterUserId !== user.uid) {
      return socket.close(4403, "not_your_call");
    }

    // The recruiter's STT selection is persisted on the call (POST /api/calls).
    const provider = (row.transcriberProvider ?? "deepgram") as "deepgram" | "sarvam" | "shunya";
    const model = row.transcriberModel ?? undefined;
    const language = (row.transcriberLanguage ?? "multi") as TranscriptionLanguage;

    // Multi-tenant integration creds are gone — resolver now reads env only.
    const creds = await getProviderCredentials(user.uid, provider);
    if (!creds) return socket.close(4503, `${provider}_credentials_missing`);
    const apiKey =
      provider === "sarvam"
        ? (creds as { apiSubscriptionKey: string }).apiSubscriptionKey
        : (creds as { apiKey: string }).apiKey;

    try {
      if (provider === "deepgram") {
        ensureSingleStream(callId, apiKey, { model, language }, app.log);
      } else {
        ensureSingleBridge(callId, provider, apiKey, { model, language }, app.log);
      }
    } catch (err) {
      app.log.warn({ err, callId, provider }, "transcription stream open failed");
      return socket.close(4500, "transcription_open_failed");
    }

    const state: IngestState = {
      callId,
      userEmail: user.email,
      bytesSent: 0,
      startedAt: Date.now(),
      chunks: [],
    };
    app.log.info({ callId, recruiter: user.uid, provider, model }, "ingest-call session open");

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary || !(raw instanceof Buffer) || raw.byteLength === 0) return;
      state.bytesSent += raw.byteLength;
      if (provider === "deepgram") writeSingleFrame(callId, raw, app.log);
      else writeSingleBridgeFrame(callId, raw);
      // Keep the raw PCM so we can store the full recording to S3 on close.
      state.chunks.push(Buffer.from(raw));
    });

    socket.on("close", async () => {
      if (provider === "deepgram") await closeSingleStream(callId);
      else await closeSingleBridge(callId);
      const durationMs = Date.now() - state.startedAt;
      app.log.info({ callId, durationMs, bytesSent: state.bytesSent }, "ingest-call session closed");

      // Usage tracker is a no-op now; left for parity with the old call site.
      const audioSeconds = state.bytesSent / 32000;
      if (audioSeconds > 0) {
        void recordAudioUsage(
          { orgId: user.uid, callId, operation: provider, model: model ?? "nova-3", seconds: audioSeconds },
          app.log,
        );
      }

      // Store the full call recording to S3 (via the blob store). We keep the
      // returned content-addressed key on the call doc; the auth playback
      // endpoint (GET /api/calls/:id/recording) fetches it back from the blob
      // store, and the report merges nothing from it (audio only).
      const pcm = Buffer.concat(state.chunks);
      state.chunks = [];
      if (pcm.length > 0) {
        try {
          const wav = pcmToWav(pcm);
          const { key } = await blobStore.put(wav);
          await collections.interviews().updateOne(
            { id: callId },
            { $set: { recordingUrl: key, recordingStore: "blob", recordingDurationMs: durationMs, recordingMime: "audio/wav" } },
          );
          app.log.info({ callId, key, bytes: wav.length }, "recording stored to S3 (blob)");
        } catch (err) {
          app.log.warn({ err, callId }, "post-call recording S3 upload failed");
        }
      }
    });

    socket.on("error", (err) => {
      app.log.warn({ err, callId }, "ingest-call socket error");
    });
  });
}
