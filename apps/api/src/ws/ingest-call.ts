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

import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { callSessions, db } from "@j2w/db";
import { getAcousticSentimentQueue } from "@j2w/ingest-shared";
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
import { WavDumper } from "./wav-dump.js";

const DUMP_WAVS = process.env.DUMP_WAVS !== "0"; // default ON for the wedge — needed for post_diarize.
const DUMP_DIR = path.resolve(process.env.DUMP_DIR ?? "./var/audio-dumps");

interface IngestState {
  callId: string;
  userEmail: string;
  bytesSent: number;
  startedAt: number;
}

export async function registerIngestCallWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/ingest-call", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");
    const token =
      url.searchParams.get("token") ??
      (req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null);
    const mode = url.searchParams.get("mode") ?? "browser_mixed";

    if (!callId) return socket.close(4400, "missing_callId");
    if (!token) return socket.close(4401, "missing_token");
    if (mode !== "browser_mixed" && mode !== "desktop_dual_channel") {
      return socket.close(4400, `unsupported_mode:${mode}`);
    }

    let user: { sub: string; email: string };
    try {
      user = app.jwt.verify(token) as { sub: string; email: string };
    } catch {
      return socket.close(4401, "invalid_token");
    }

    // Look up the call so we know which org + STT provider to use.
    const [row] = await db
      .select({
        id: callSessions.id,
        orgId: callSessions.orgId,
        recruiterUserId: callSessions.recruiterUserId,
        mode: callSessions.mode,
        transcriberProvider: callSessions.transcriberProvider,
        transcriberModel: callSessions.transcriberModel,
        transcriberLanguage: callSessions.transcriberLanguage,
      })
      .from(callSessions)
      .where(eq(callSessions.id, callId));
    if (!row || !row.orgId) return socket.close(4404, "call_not_found");
    // Permission: the recruiter who owns the call is the only one who can
    // pump audio into it. (Future: allow QA/lead listen-in via a different
    // path; not in this phase.)
    if (row.recruiterUserId && row.recruiterUserId !== user.sub) {
      return socket.close(4403, "not_your_call");
    }

    // The recruiter's STT selection is persisted on the call (POST /api/calls).
    // Deepgram runs as a native single-stream; Sarvam/Shunya run through the
    // same upstream bridges /ws/custom-transcriber uses, fed the browser mic.
    const provider = (row.transcriberProvider ?? "deepgram") as "deepgram" | "sarvam" | "shunya";
    const model = row.transcriberModel ?? undefined;
    const language = (row.transcriberLanguage ?? "multi") as TranscriptionLanguage;

    const creds = await getProviderCredentials(row.orgId, provider);
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
    };
    const dumper = DUMP_WAVS ? new WavDumper(callId, DUMP_DIR) : null;

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary || !(raw instanceof Buffer) || raw.byteLength === 0) return;
      state.bytesSent += raw.byteLength;
      if (provider === "deepgram") writeSingleFrame(callId, raw, app.log);
      else writeSingleBridgeFrame(callId, raw);
      // Dump as channel 0 (recruiter) — the post_diarize worker re-runs
      // Deepgram with diarize=true on this WAV and uses the resulting
      // diarization confidence to label retroactively.
      dumper?.writeFrame(0, raw);
    });

    socket.on("close", async () => {
      dumper?.close();
      if (provider === "deepgram") await closeSingleStream(callId);
      else await closeSingleBridge(callId);
      const durationMs = Date.now() - state.startedAt;
      app.log.info(
        { callId, durationMs, bytesSent: state.bytesSent, dumpDir: DUMP_WAVS ? DUMP_DIR : null },
        "ingest-call session closed",
      );

      // Persist recording_url + enqueue acoustic-sentiment job (single mixed
      // source — see notes in workers/jobs/acousticSentiment.ts). We store a
      // relative path under DUMP_DIR rather than a file:// URI so the auth
      // playback endpoint (GET /api/calls/:id/recording) resolves the same
      // value across api+worker containers regardless of where DUMP_DIR is
      // mounted in each.
      const recruiterRel = dumper?.relativePaths.recruiter ?? null;
      if (recruiterRel) {
        try {
          await db
            .update(callSessions)
            .set({
              recordingUrl: recruiterRel,
              recordingDurationMs: durationMs,
              recordingMime: "audio/wav",
            })
            .where(eq(callSessions.id, callId));
          await getAcousticSentimentQueue().add(
            `acoustic-${callId}`,
            { callId, recordingUrl: recruiterRel, recordingMime: "audio/wav" },
            { jobId: `acoustic-${callId}` },
          );
        } catch (err) {
          app.log.warn({ err, callId }, "post-call enqueue failed");
        }
      }
    });

    socket.on("error", (err) => {
      app.log.warn({ err, callId }, "ingest-call socket error");
    });
  });
}
