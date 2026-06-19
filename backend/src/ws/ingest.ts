import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { AUDIO_CHANNEL_RECRUITER, AUDIO_CHANNEL_CANDIDATE, AUDIO_FRAME_BYTES } from "@j2w/shared-types";
import { callSessions, db } from "@j2w/db";
import { getAcousticSentimentQueue } from "@j2w/ingest-shared";
import { closeStreams, ensureStreams, writeFrame } from "../deepgram/stream.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { WavDumper } from "./wav-dump.js";

// Phase 4: accept audio frames over WS, write to WAV in dev mode so the
// operator can verify capture. Phase 5 wires each channel to its own
// Deepgram streaming session.

const DUMP_WAVS = process.env.DUMP_WAVS === "1";
const DUMP_DIR = path.resolve(process.env.DUMP_DIR ?? "./var/audio-dumps");

interface IngestState {
  callId: string;
  userEmail: string;
  recruiterBytes: number;
  candidateBytes: number;
  startedAt: number;
}

export async function registerIngestWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/ingest", { websocket: true }, (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");
    const token =
      url.searchParams.get("token") ??
      (req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null);

    if (!callId) return socket.close(4400, "missing_callId");
    if (!token) return socket.close(4401, "missing_token");

    let user: { email: string };
    try {
      user = app.jwt.verify(token) as { email: string };
    } catch {
      return socket.close(4401, "invalid_token");
    }

    const state: IngestState = {
      callId,
      userEmail: user.email,
      recruiterBytes: 0,
      candidateBytes: 0,
      startedAt: Date.now(),
    };
    const dumper = DUMP_WAVS ? new WavDumper(callId, DUMP_DIR) : null;

    // Pre-warm Deepgram sockets so the first utterance doesn't pay the
    // ~200 ms WebSocket handshake. Resolve the call's tenant Deepgram
    // credential first; silent no-op when none is configured.
    void (async () => {
      const [row] = await db
        .select({ orgId: callSessions.orgId })
        .from(callSessions)
        .where(eq(callSessions.id, callId));
      if (!row?.orgId) return;
      const creds = await getProviderCredentials(row.orgId, "deepgram");
      if (!creds) return;
      try {
        ensureStreams(callId, creds.apiKey, app.log);
      } catch (err) {
        app.log.warn({ err, callId }, "deepgram pre-warm failed");
      }
    })();

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary || !(raw instanceof Buffer)) return;
      if (raw.byteLength < 1 + 2) return;
      const channel = raw[0];
      const frame = raw.subarray(1);
      if (channel === AUDIO_CHANNEL_RECRUITER) {
        state.recruiterBytes += frame.byteLength;
        writeFrame(callId, "recruiter", frame, app.log);
      } else if (channel === AUDIO_CHANNEL_CANDIDATE) {
        state.candidateBytes += frame.byteLength;
        writeFrame(callId, "candidate", frame, app.log);
      }
      if (frame.byteLength > AUDIO_FRAME_BYTES * 4) {
        app.log.warn({ callId, size: frame.byteLength }, "oversized audio frame");
      }
      dumper?.writeFrame(channel, frame);
    });

    socket.on("close", async () => {
      dumper?.close();
      await closeStreams(callId);
      const durationMs = Date.now() - state.startedAt;
      app.log.info(
        {
          callId,
          durationMs,
          recruiterBytes: state.recruiterBytes,
          candidateBytes: state.candidateBytes,
          dumpDir: DUMP_WAVS ? DUMP_DIR : undefined,
        },
        "ingest session closed",
      );

      // If we dumped WAVs, persist the candidate channel path as
      // recording_url and enqueue the acoustic-sentiment worker job.
      // Silent no-op when DUMP_WAVS isn't set (prod path is S3, wired later).
      const candidatePath = dumper?.paths.candidate ?? null;
      if (candidatePath) {
        const recordingUrl = pathToFileURL(candidatePath).toString();
        try {
          await db
            .update(callSessions)
            .set({
              recordingUrl,
              recordingDurationMs: durationMs,
              recordingMime: "audio/wav",
            })
            .where(eq(callSessions.id, callId));
          await getAcousticSentimentQueue().add(
            `acoustic:${callId}`,
            { callId, recordingUrl, recordingMime: "audio/wav" },
            { jobId: `acoustic:${callId}` },
          );
        } catch (err) {
          app.log.warn({ err, callId }, "enqueue acoustic-sentiment failed");
        }
      }
    });
  });
}
