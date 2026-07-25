// FreJun webhook receiver.
//
// Registered WITHOUT `app.authenticate` — FreJun calls this, not a logged-in
// recruiter. Authentication is by shared secret instead (see verifySignature).
//
// Design constraints that come from telephony, not from us:
//   • Deliveries RETRY. Every handler must be idempotent.
//   • Deliveries ARRIVE OUT OF ORDER. A late "ringing" must not clobber
//     "completed" — enforced by the rank guard in telephony/callState.ts.
//   • Slow responses trigger more retries, so we ACK immediately (200) and do
//     the real work afterwards.
//
// Scope: we consume `call.status` (lifecycle) and `call.recording` (audio).
// We deliberately IGNORE `call.insights` / `call.summary` transcript content —
// this service transcribes with Deepgram and evaluates with OpenAI, and the
// live account has those FreJun fields empty anyway.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { blobStore } from "@j2w/ingest-shared";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { fetchRecording } from "../telephony/frejun.js";
import { applyStatus, mapFrejunStatus } from "../telephony/callState.js";
import { broadcastToCall } from "../ws/session.js";

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/** Shape is defensive — FreJun's payload varies by event and isn't fully documented. */
interface FrejunWebhookBody {
  event?: string;
  call_id?: string;
  call_type?: string;
  call_status?: string;
  status?: string;
  start_time?: string;
  answer_time?: string;
  end_time?: string;
  /** Docs say milliseconds here, while the call-log API uses minutes. */
  duration?: number;
  candidate_number?: string;
  virtual_number?: string;
  call_creator?: string;
  recording_url?: string;
  summary_url?: string;
  metadata?: { reference_id?: string; job_id?: string; transaction_id?: string };
  transaction_id?: string;
  job_id?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * We do not yet know whether FreJun signs deliveries or simply echoes a custom
 * header, so both are accepted: a literal secret match, or an HMAC-SHA256 of
 * the raw body keyed by the secret. Once the real scheme is observed, drop the
 * branch that isn't used.
 */
function verifySignature(req: RawBodyRequest): boolean {
  const secret = env.FREJUN_WEBHOOK_SECRET;
  if (!secret) return true; // caller has already handled the unset case
  const header = req.headers[env.FREJUN_WEBHOOK_SECRET_HEADER.toLowerCase()];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  if (safeEqual(provided, secret)) return true;
  const hmac = createHmac("sha256", secret).update(req.rawBody ?? "").digest("hex");
  return safeEqual(provided.replace(/^sha256=/, ""), hmac);
}

/** Resolve the interview this delivery belongs to. */
async function resolveInterviewId(body: FrejunWebhookBody): Promise<string | null> {
  // Preferred: the id we stamped into transaction_id when placing the call.
  const stamped =
    body.transaction_id ?? body.metadata?.transaction_id ?? body.metadata?.reference_id ?? null;
  if (stamped) {
    const byStamp = await collections
      .interviews()
      .findOne<{ id: string }>({ id: stamped }, { projection: { _id: 0, id: 1 } });
    if (byStamp) return byStamp.id;
  }
  // Inbound calls carry no stamp — fall back to FreJun's own id, which the
  // /calls/attach route records when the recruiter accepts.
  if (body.call_id) {
    const byCall = await collections
      .interviews()
      .findOne<{ id: string }>(
        { "telephony.frejunCallId": body.call_id },
        { projection: { _id: 0, id: 1 } },
      );
    if (byCall) return byCall.id;
  }
  return null;
}

export async function frejunWebhookRoutes(app: FastifyInstance) {
  // Keep the raw body so an HMAC can be verified over the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, raw, done) => {
    (req as RawBodyRequest).rawBody = raw as string;
    try {
      done(null, raw ? JSON.parse(raw as string) : {});
    } catch (err) {
      // Without an explicit statusCode Fastify reports 500, and a 5xx tells
      // FreJun to retry — forever, for a body that will never parse. 400 makes
      // it a permanent failure and stops the retry storm.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.post("/frejun", async (req, reply) => {
    const r = req as RawBodyRequest;

    // Log the headers FreJun actually sends, so we can see whether the custom
    // signature header arrived and under what name. Temporary while wiring up.
    req.log.info(
      {
        headerKeys: Object.keys(req.headers),
        sigHeader: req.headers[env.FREJUN_WEBHOOK_SECRET_HEADER.toLowerCase()] ?? null,
        userAgent: req.headers["user-agent"],
      },
      "◇ frejun webhook headers",
    );

    // An unset secret is fine locally but must never ship — an open webhook
    // lets anyone forge call events against real interviews.
    if (!env.FREJUN_WEBHOOK_SECRET) {
      if (env.NODE_ENV === "production") {
        req.log.error("FREJUN_WEBHOOK_SECRET unset — refusing webhook in production");
        return reply.code(503).send({ error: "webhook_secret_not_configured" });
      }
      req.log.warn("FREJUN_WEBHOOK_SECRET unset — accepting UNVERIFIED webhook (dev only)");
    } else if (!verifySignature(r)) {
      // In production a bad signature is fatal. In dev we log and PROCEED so a
      // header mismatch doesn't hide the payload we're trying to inspect.
      if (env.NODE_ENV === "production") {
        req.log.warn("frejun webhook signature rejected");
        return reply.code(401).send({ error: "bad_signature" });
      }
      req.log.warn("frejun webhook signature MISMATCH — processing anyway (dev only)");
    }

    const body = (req.body ?? {}) as FrejunWebhookBody;

    // Loud on purpose while we finalise the flow: the ONLY way to build the
    // ringing/answered/not-answered machine on real data instead of guesses is
    // to see exactly what FreJun sends. Logs the whole raw payload per event.
    req.log.info(
      {
        event: body.event,
        call_id: body.call_id,
        call_status: body.call_status ?? body.status,
        call_type: body.call_type,
        transaction_id: body.transaction_id ?? body.metadata?.transaction_id,
        raw: r.rawBody?.slice(0, 1500),
      },
      "◆ FREJUN WEBHOOK RECEIVED",
    );

    // Idempotency: hash the exact delivery. A retry of the same payload is
    // dropped; a genuinely new state change hashes differently and proceeds
    // (where the rank guard then decides if it's stale).
    const dedupeKey = createHash("sha256")
      .update(r.rawBody ?? JSON.stringify(body))
      .digest("hex");
    try {
      await collections.frejunEvents().insertOne({
        dedupeKey,
        event: body.event ?? null,
        frejunCallId: body.call_id ?? null,
        payload: body,
        receivedAt: new Date(),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        req.log.debug({ dedupeKey }, "duplicate frejun webhook ignored");
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      throw err;
    }

    // ACK now; a slow handler only earns us more retries.
    void reply.code(200).send({ ok: true });
    void handleEvent(body, req).catch((err) => {
      req.log.error({ err, event: body.event }, "frejun webhook handler failed");
    });
  });
}

async function handleEvent(body: FrejunWebhookBody, req: FastifyRequest): Promise<void> {
  const callId = await resolveInterviewId(body);
  if (!callId) {
    // Expected for inbound calls the recruiter never accepted, and for calls
    // placed from FreJun's own app. Stored in ia_frejun_events regardless.
    req.log.info({ frejunCallId: body.call_id, event: body.event }, "webhook for unknown interview");
    return;
  }

  const event = (body.event ?? "").toLowerCase();

  if (event.includes("recording") || body.recording_url) {
    await handleRecording(callId, body, req);
    return;
  }
  // Explicitly out of scope — we transcribe ourselves. Retained in
  // ia_frejun_events for debugging, never merged into the interview.
  if (event.includes("insight") || event.includes("summary")) {
    req.log.debug({ callId, event }, "ignoring frejun AI payload by design");
    return;
  }

  const mapped = mapFrejunStatus(body.call_status ?? body.status);
  if (!mapped) {
    req.log.warn({ callId, raw: body.call_status ?? body.status }, "unmapped frejun status");
    return;
  }

  const patch: Record<string, unknown> = {};
  if (body.call_id) patch.frejunCallId = body.call_id;
  if (body.start_time) patch.startTime = new Date(body.start_time);
  if (body.answer_time) patch.answerTime = new Date(body.answer_time);
  if (body.end_time) patch.endTime = new Date(body.end_time);
  if (typeof body.duration === "number") patch.durationMs = body.duration;
  if (body.candidate_number) patch.candidateNumber = body.candidate_number;
  if (body.call_type) {
    patch.direction = body.call_type.toLowerCase().startsWith("in") ? "inbound" : "outbound";
  }

  const applied = await applyStatus({ callId, status: mapped, source: "webhook", patch, log: req.log });
  if (!applied) return;

  // A terminal status closes the interview. Evaluation stays where it already
  // lives (POST /api/calls/:id/end), so nothing about scoring changes here.
  if (mapped === "completed" || mapped === "busy" || mapped === "not-answered" || mapped === "failed") {
    await collections
      .interviews()
      .updateOne(
        { id: callId, status: { $ne: "ended" } },
        { $set: { status: "ended", endedAt: body.end_time ? new Date(body.end_time) : new Date() } },
      );
  }
}

/**
 * Copy the recording into our own blob store. FreJun's `recording_url` is
 * signature-signed and expires, so persisting the link would silently rot —
 * we keep the bytes and reuse the existing GET /api/calls/:id/recording player.
 */
async function handleRecording(
  callId: string,
  body: FrejunWebhookBody,
  req: FastifyRequest,
): Promise<void> {
  const url = body.recording_url;
  if (!url) return;

  await collections
    .interviews()
    .updateOne({ id: callId }, { $set: { "telephony.frejunRecordingUrl": url } });

  try {
    const buf = await fetchRecording(url);
    const { key } = await blobStore.put(buf);
    await collections.interviews().updateOne(
      { id: callId },
      {
        $set: {
          recordingUrl: key,
          recordingStore: "blob",
          recordingMime: "audio/mpeg",
          recordingDurationMs: typeof body.duration === "number" ? body.duration : null,
        },
      },
    );
    broadcastToCall(callId, { type: "recording.ready", callId, ts: Date.now() });
    req.log.info({ callId, key, bytes: buf.length }, "frejun recording stored");
  } catch (err) {
    // The signed URL may already have expired. The link is still on the doc,
    // and the reconcile sweep can retry later.
    req.log.warn({ err, callId }, "frejun recording copy failed");
  }
}
