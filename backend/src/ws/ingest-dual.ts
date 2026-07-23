// Dual-channel audio ingest for the FreJun softphone path.
//
// A SEPARATE endpoint from /ws/ingest-call rather than a new mode on it: the
// mixed-mono mic wedge is in production and stays byte-for-byte unchanged, so
// the two paths can run side by side (and be A/B'd) without risk.
//
// How this differs from /ws/ingest-call:
//
//   /ws/ingest-call (mic wedge)          /ws/ingest-dual (softphone)
//   ────────────────────────────────     ──────────────────────────────────
//   mono PCM16, 640 B / 20 ms            interleaved stereo, 1280 B / 20 ms
//   one mixed source                     L = recruiter mic, R = candidate leg
//   speaker guessed, LLM re-labels       speaker known from the channel
//   buffers every frame in RAM,          NO buffering — FreJun records the
//     uploads a WAV on close               call and delivers it by webhook
//
// Dropping the in-RAM recording buffer is deliberate: the old path holds the
// entire call in memory (~115 MB per hour, per concurrent call) purely to
// re-upload audio we now get from FreJun anyway.
//
// Frame format — interleaved stereo PCM16 LE @ 16 kHz:
//   [L0][R0][L1][R1]…  320 sample-pairs per 20 ms frame = 1280 bytes
// Forwarded to Deepgram untouched; it de-interleaves via multichannel=true.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { collections } from "../mongo.js";
import { authenticateOl } from "../auth/olAuth.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { closeDualStream, ensureDualStream, writeDualFrame } from "../deepgram/dual-stream.js";
import { markAuthoritativeSpeakers } from "../rag/suggest.js";

/** 320 sample-pairs × 2 channels × 2 bytes. */
const EXPECTED_FRAME_BYTES = 1280;

export async function registerIngestDualWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/ingest-dual", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");
    if (!callId) return socket.close(4400, "missing_callId");

    const user = await authenticateOl(req as FastifyRequest);
    if (!user) return socket.close(4401, "missing_or_invalid_token");

    const row = await collections.interviews().findOne<{
      id: string;
      recruiterUserId: string | null;
      transcriberProvider: string | null;
      transcriberModel: string | null;
      transcriberLanguage: string | null;
    }>({ id: callId });
    if (!row) return socket.close(4404, "call_not_found");
    if (row.recruiterUserId && row.recruiterUserId !== user.uid) {
      return socket.close(4403, "not_your_call");
    }

    // Only Deepgram can transcribe two channels in one session. Sarvam/Shunya
    // are single-stream bridges, so a call configured for them must fall back
    // to the mixed-mono endpoint rather than silently lose a speaker.
    const provider = row.transcriberProvider ?? "deepgram";
    if (provider !== "deepgram") return socket.close(4503, `dual_requires_deepgram:${provider}`);

    const creds = await getProviderCredentials(user.uid, "deepgram");
    if (!creds) return socket.close(4503, "deepgram_credentials_missing");

    try {
      ensureDualStream(
        callId,
        (creds as { apiKey: string }).apiKey,
        { model: row.transcriberModel ?? undefined, language: row.transcriberLanguage ?? "multi" },
        app.log,
      );
    } catch (err) {
      app.log.warn({ err, callId }, "dual transcription stream open failed");
      return socket.close(4500, "transcription_open_failed");
    }

    // Tell the suggestion engine not to second-guess these speaker labels.
    markAuthoritativeSpeakers(callId);

    let bytesSent = 0;
    let oddFrames = 0;
    const startedAt = Date.now();
    app.log.info({ callId, recruiter: user.uid }, "ingest-dual session open");

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary || !(raw instanceof Buffer) || raw.byteLength === 0) return;
      // A frame that isn't a whole number of stereo sample-pairs would shift
      // every following sample into the wrong channel — swapping the speakers
      // for the rest of the call. Drop it and warn once.
      if (raw.byteLength % 4 !== 0) {
        if (oddFrames++ === 0) {
          app.log.warn({ callId, bytes: raw.byteLength }, "misaligned stereo frame dropped");
        }
        return;
      }
      if (bytesSent === 0 && raw.byteLength !== EXPECTED_FRAME_BYTES) {
        app.log.info(
          { callId, got: raw.byteLength, expected: EXPECTED_FRAME_BYTES },
          "unexpected dual frame size (aligned, so forwarding anyway)",
        );
      }
      bytesSent += raw.byteLength;
      writeDualFrame(callId, raw, app.log);
    });

    socket.on("close", async () => {
      await closeDualStream(callId);
      app.log.info(
        {
          callId,
          durationMs: Date.now() - startedAt,
          bytesSent,
          // /4 not /2: stereo carries two samples per instant of audio.
          audioSeconds: Math.round(bytesSent / 4 / 16000),
          oddFrames,
        },
        "ingest-dual session closed",
      );
    });

    socket.on("error", (err) => {
      app.log.warn({ err, callId }, "ingest-dual socket error");
    });
  });
}
