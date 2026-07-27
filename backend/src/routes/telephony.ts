// Native calling from the OfferLetter tool, via FreJun.
//
// Replaces the manual two-step the recruiter does today (dial in FreJun's own
// web app, then come here and press "Start live-assist call"). These routes
// create the interview document AND place the call in one action, stamping our
// interview id into FreJun's `transaction_id` so every later webhook maps back.
//
// IMPORTANT: nothing here touches the transcription pipeline. The documents we
// create carry exactly the same fields routes/calls.ts writes — including
// `transcriberProvider/Model/Language`, which /ws/ingest-call reads — so the
// existing Deepgram + OpenAI path works against these calls unchanged. FreJun's
// own transcript/AI-insight fields are deliberately never consumed.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { buildDemandSnapshot, loadOlJob } from "../lib/olJobs.js";
import { AgentNotMappedError, resolveFrejunAgentId } from "../telephony/agents.js";
import {
  callToVoip,
  findCallById,
  findCallByTransactionId,
  FrejunError,
  isFrejunConfigured,
} from "../telephony/frejun.js";
import { applyStatus, mapFrejunStatus, type CallDirection } from "../telephony/callState.js";

const transcriptionChoiceSchema = z.object({
  provider: z.enum(["deepgram", "sarvam", "shunya"]).default("deepgram"),
  model: z.string().default("nova-3"),
  language: z.enum(["multi", "en-US", "en-IN", "hi-IN"]).default("multi"),
});

// Mirrors routes/calls.ts so a telephony-created interview is indistinguishable
// from a manually-created one everywhere downstream.
const ephemeralCandidateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
    currentTitle: z.string().max(200).optional(),
    currentCompany: z.string().max(200).optional(),
    totalExperienceYears: z.number().min(0).max(80).optional(),
    currentLocation: z.string().max(120).optional(),
    resumeBlobKey: z.string().max(500).optional(),
    resumeFilename: z.string().max(500).optional(),
    resumeMime: z.string().max(120).optional(),
    parsedResume: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Normalise to E.164. FreJun currently accepts Indian destinations only, so a
 * bare 10-digit number is assumed to be +91. Anything already carrying a "+"
 * is passed through untouched — we must not silently rewrite a foreign number.
 */
export function normalizeIndianNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return null;
}

/**
 * How far back /calls/attach will look for an in-flight inbound call from the
 * same number when it has no `frejunCallId` to key on.
 *
 * Attach is only ever called while the phone is RINGING, so this needs to cover
 * one ring (plus a page reload mid-ring), not a whole conversation. Keeping it
 * short bounds the damage if a record is ever left stuck at "ringing" — e.g.
 * the browser was closed before the end could be reported.
 */
const RECENT_INBOUND_MS = 5 * 60 * 1000;

function wsUrls(callId: string, mode: string) {
  const base = env.API_PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "");
  return {
    wsIngestUrl: `${base}/ws/ingest-call?callId=${callId}&mode=${mode}`,
    wsSessionUrl: `${base}/ws/session?callId=${callId}`,
  };
}

interface InterviewTelephonyDoc {
  id: string;
  recruiterUserId: string;
  demandId: string | null;
  demandSnapshot: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  retryAttempt?: number;
  telephony?: {
    frejunCallId?: string | null;
    direction?: CallDirection;
    candidateNumber?: string | null;
    status?: string;
  };
}

export async function telephonyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Fail fast and uniformly when the integration isn't configured, matching
  // the {error:"x_not_configured"} convention used by the other providers.
  app.addHook("preHandler", async (_req, reply) => {
    if (!isFrejunConfigured()) return reply.code(503).send({ error: "frejun_not_configured" });
  });

  // ── Place an outbound call ─────────────────────────────────────────────
  app.post("/calls", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = z
      .object({
        demandId: z.string().optional(),
        candidate: ephemeralCandidateSchema.optional(),
        // Explicit number wins; otherwise we dial the candidate's phone.
        dstnNumber: z.string().max(40).optional(),
        virtualNumber: z.string().max(40).optional(),
        transcription: transcriptionChoiceSchema.optional(),
        // "sdk"    — the BROWSER dials via softphone.makeCall(); we only
        //            prepare the interview record and hand back its id, which
        //            the browser passes as FreJun `metadata.transactionId`.
        //            This also sidesteps `agent_id`, whose format FreJun does
        //            not document and exposes no endpoint to discover.
        // "server" — we dial through /integrations/call-to-voip/, which needs
        //            a resolvable agent_id.
        dialMode: z.enum(["sdk", "server"]).default("sdk"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const d = parsed.data;

    const rawNumber = d.dstnNumber ?? d.candidate?.phone ?? "";
    const dstnNumber = normalizeIndianNumber(rawNumber);
    if (!dstnNumber) return reply.code(400).send({ error: "invalid_destination_number" });

    const transcription = d.transcription ?? {
      provider: "deepgram" as const,
      model: "nova-3",
      language: "multi" as const,
    };
    // Refuse before dialling if we couldn't transcribe the call anyway.
    const creds = await getProviderCredentials(ctx.uid, transcription.provider);
    if (!creds) return reply.code(503).send({ error: `${transcription.provider}_api_key_missing` });

    // Only the server-dial path needs an agent_id; in "sdk" mode the
    // recruiter's own authenticated softphone IS the agent.
    let agentId: string | null = null;
    if (d.dialMode === "server") {
      try {
        agentId = await resolveFrejunAgentId(ctx);
      } catch (err) {
        if (err instanceof AgentNotMappedError) {
          return reply.code(409).send({ error: "frejun_agent_not_mapped", olUid: ctx.uid });
        }
        throw err;
      }
    }

    let demandSnapshot: Record<string, unknown> | null = null;
    if (d.demandId) {
      const job = await loadOlJob(d.demandId, ctx);
      if (!job) return reply.code(403).send({ error: "demand_not_assigned" });
      demandSnapshot = await buildDemandSnapshot(job);
    }

    const id = randomUUID();
    const now = new Date();
    const mode = "browser_mixed";
    await collections.interviews().insertOne({
      id,
      recruiterUserId: ctx.uid,
      recruiterMongoId: ctx.mongoId,
      recruiterEmail: ctx.email,
      recruiterName: ctx.name,
      candidate: d.candidate ?? null,
      candidateRefOrPhone: dstnNumber,
      demandId: d.demandId ?? null,
      demandSnapshot,
      status: "assigned",
      mode,
      origin: "telephony",
      transcriberProvider: transcription.provider,
      transcriberModel: transcription.model,
      transcriberLanguage: transcription.language,
      transcript: [],
      summary: null,
      recordingUrl: null,
      recordingDurationMs: null,
      recordingMime: null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      retryAttempt: 1,
      retryOfCallId: null,
      telephony: {
        provider: "frejun",
        frejunCallId: null,
        direction: "outbound" as CallDirection,
        candidateNumber: dstnNumber,
        virtualNumber: d.virtualNumber ?? env.FREJUN_VIRTUAL_NUMBER ?? null,
        agentId,
        status: "created",
        startTime: null,
        answerTime: null,
        endTime: null,
        durationMs: null,
        frejunRecordingUrl: null,
        statusHistory: [{ status: "created", at: now, source: "api" }],
      },
    });

    // SDK mode: the record is all the browser needs to dial. The call's real
    // lifecycle (ringing → answered → completed/not-answered) now comes from
    // FreJun WEBHOOKS (routes/frejunWebhook.ts), which push straight to
    // /ws/session. The old per-call polling watcher is gone — webhooks are the
    // authority. `GET /calls/:id?refresh=true` remains as a manual backfill for
    // the rare missed delivery.
    if (d.dialMode === "sdk") {
      return {
        callId: id,
        frejunCallId: null,
        dialMode: "sdk",
        direction: "outbound",
        candidateNumber: dstnNumber,
        status: "created",
        demand: demandSnapshot,
        candidate: d.candidate ?? null,
        transcription,
        ...wsUrls(id, mode),
      };
    }

    try {
      const { callId: frejunCallId } = await callToVoip({
        agentId: agentId as string,
        dstnNumber,
        candidateName: (d.candidate?.name as string | undefined) ?? undefined,
        virtualNumber: d.virtualNumber,
        transactionId: id,
        jobId: d.demandId,
      });
      await collections
        .interviews()
        .updateOne({ id }, { $set: { "telephony.frejunCallId": frejunCallId } });
      await applyStatus({ callId: id, status: "dialing", source: "api", log: req.log });

      return {
        callId: id,
        frejunCallId,
        direction: "outbound",
        candidateNumber: dstnNumber,
        status: "dialing",
        demand: demandSnapshot,
        candidate: d.candidate ?? null,
        transcription,
        ...wsUrls(id, mode),
      };
    } catch (err) {
      await applyStatus({
        callId: id,
        status: "failed",
        source: "api",
        patch: { failureReason: err instanceof Error ? err.message : String(err) },
        log: req.log,
      });
      if (err instanceof FrejunError) {
        req.log.warn({ status: err.status, body: err.body, callId: id }, "frejun call-to-voip failed");
        return reply.code(502).send({ error: "frejun_call_failed", detail: err.message, callId: id });
      }
      throw err;
    }
  });

  // ── Attach an INBOUND call to an interview ─────────────────────────────
  // Inbound calls originate at FreJun, so they carry no transaction_id and no
  // interview exists yet. The browser calls this the moment the phone RINGS —
  // not on accept — so a declined or missed call still lands in the call log,
  // which is what a call log is for. It also yields the callId needed for
  // /ws/session and /ws/ingest-call once the recruiter picks up.
  //
  // `frejunCallId` is OPTIONAL because the softphone SDK never exposes it: its
  // `onInvite` handler surfaces only the caller's display name (see
  // UserAgent.js#onInvite), so the browser genuinely cannot know FreJun's id.
  // The webhook backfills it later by matching on the caller's number.
  //
  // Idempotency therefore has two keys: frejunCallId when we have one, and
  // otherwise "this recruiter's live inbound call from this number", so a
  // remount or a double-fire during one ring reuses the same record.
  app.post("/calls/attach", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = z
      .object({
        frejunCallId: z.string().min(1).max(64).optional(),
        candidateNumber: z.string().max(40).optional(),
        /** Caller name, when the browser matched the number to a known candidate. */
        candidateName: z.string().max(200).optional(),
        demandId: z.string().optional(),
        candidate: ephemeralCandidateSchema.optional(),
        transcription: transcriptionChoiceSchema.optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const d = parsed.data;
    const number = d.candidateNumber ? normalizeIndianNumber(d.candidateNumber) : null;

    const existing = d.frejunCallId
      ? await collections.interviews().findOne<InterviewTelephonyDoc>({
          "telephony.frejunCallId": d.frejunCallId,
        })
      : // No id to key on: reuse an inbound call from the same number that this
        // recruiter is still on. Bounded by RECENT_INBOUND_MS so yesterday's
        // call from the same candidate is never resurrected.
        await collections.interviews().findOne<InterviewTelephonyDoc>(
          {
            recruiterUserId: ctx.uid,
            "telephony.direction": "inbound",
            "telephony.candidateNumber": number,
            "telephony.status": { $in: ["ringing", "answered"] },
            createdAt: { $gte: new Date(Date.now() - RECENT_INBOUND_MS) },
          },
          { sort: { createdAt: -1 } },
        );
    if (existing) {
      if (existing.recruiterUserId !== ctx.uid) return reply.code(403).send({ error: "not_your_call" });
      // A later delivery may know the FreJun id the first one didn't.
      if (d.frejunCallId && !existing.telephony?.frejunCallId) {
        await collections
          .interviews()
          .updateOne({ id: existing.id }, { $set: { "telephony.frejunCallId": d.frejunCallId } });
      }
      return { callId: existing.id, attached: false, ...wsUrls(existing.id, "browser_mixed") };
    }

    const transcription = d.transcription ?? {
      provider: "deepgram" as const,
      model: "nova-3",
      language: "multi" as const,
    };
    const creds = await getProviderCredentials(ctx.uid, transcription.provider);
    if (!creds) return reply.code(503).send({ error: `${transcription.provider}_api_key_missing` });

    let demandSnapshot: Record<string, unknown> | null = null;
    if (d.demandId) {
      const job = await loadOlJob(d.demandId, ctx);
      if (!job) return reply.code(403).send({ error: "demand_not_assigned" });
      demandSnapshot = await buildDemandSnapshot(job);
    }

    const id = randomUUID();
    const now = new Date();
    // The Call Logs list groups by candidate and renders a "Call Now" button
    // from `candidate.phone`, so an inbound call with a null candidate would
    // show up as an undialable "Unknown candidate". Synthesize the minimum
    // record from what the ring gave us.
    const candidate =
      d.candidate ??
      (number || d.candidateName
        ? { ...(d.candidateName ? { name: d.candidateName } : {}), ...(number ? { phone: number } : {}) }
        : null);
    await collections.interviews().insertOne({
      id,
      recruiterUserId: ctx.uid,
      recruiterMongoId: ctx.mongoId,
      recruiterEmail: ctx.email,
      recruiterName: ctx.name,
      candidate,
      candidateRefOrPhone: number,
      demandId: d.demandId ?? null,
      demandSnapshot,
      status: "assigned",
      mode: "browser_mixed",
      origin: "telephony",
      transcriberProvider: transcription.provider,
      transcriberModel: transcription.model,
      transcriberLanguage: transcription.language,
      transcript: [],
      summary: null,
      recordingUrl: null,
      recordingDurationMs: null,
      recordingMime: null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      retryAttempt: 1,
      retryOfCallId: null,
      telephony: {
        provider: "frejun",
        frejunCallId: d.frejunCallId ?? null,
        direction: "inbound" as CallDirection,
        candidateNumber: number,
        virtualNumber: null,
        agentId: null,
        status: "ringing",
        startTime: now,
        answerTime: null,
        endTime: null,
        durationMs: null,
        frejunRecordingUrl: null,
        statusHistory: [{ status: "ringing", at: now, source: "api" }],
      },
    });

    return { callId: id, attached: true, ...wsUrls(id, "browser_mixed") };
  });

  // ── Report a lifecycle change observed by the BROWSER ──────────────────
  // Outbound calls get their truth from FreJun webhooks. INBOUND calls don't:
  // FreJun has no "the recruiter pressed Accept" event, and a call the
  // recruiter declines may never produce a webhook we can map back at all. The
  // softphone SDK is the only witness, so it reports here.
  //
  // Everything still goes through applyStatus, so the rank guard keeps a late
  // browser report from clobbering a webhook that already moved the call on.
  const SDK_REPORTABLE = ["answered", "completed", "not-answered", "failed"] as const;
  app.post<{ Params: { id: string } }>("/calls/:id/status", async (req, reply) => {
    const parsed = z
      .object({ status: z.enum(SDK_REPORTABLE) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await collections.interviews().findOne<InterviewTelephonyDoc>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const status = parsed.data.status;
    const applied = await applyStatus({
      callId: req.params.id,
      status,
      source: "sdk",
      patch: status === "answered" ? { answerTime: now } : { endTime: now },
      log: req.log,
    });
    // Close the interview on a terminal report so the Call Logs row shows a
    // duration instead of hanging "in progress" forever.
    if (applied && status !== "answered") {
      await collections
        .interviews()
        .updateOne({ id: req.params.id, status: { $ne: "ended" } }, { $set: { status: "ended", endedAt: now } });
    }
    return { ok: true, applied };
  });

  // ── Retry ──────────────────────────────────────────────────────────────
  // Clones the demand + candidate + number into a fresh interview and dials
  // again. The chain is walkable via retryOfCallId so history can group them.
  app.post<{ Params: { id: string } }>("/calls/:id/retry", async (req, reply) => {
    const ctx = req.authUser!;
    const prev = await collections.interviews().findOne<InterviewTelephonyDoc>({ id: req.params.id });
    if (!prev || prev.recruiterUserId !== ctx.uid) return reply.code(404).send({ error: "not_found" });

    const number = prev.telephony?.candidateNumber;
    if (!number) return reply.code(400).send({ error: "no_number_to_retry" });

    // Re-enter the create path so validation, ownership and status handling
    // stay in exactly one place.
    const res = await app.inject({
      method: "POST",
      url: "/api/telephony/calls",
      headers: { authorization: req.headers.authorization ?? "", cookie: req.headers.cookie ?? "" },
      payload: {
        demandId: prev.demandId ?? undefined,
        candidate: prev.candidate ?? undefined,
        dstnNumber: number,
      },
    });
    const body = res.json<{ callId?: string }>();
    if (res.statusCode >= 400 || !body.callId) return reply.code(res.statusCode).send(body);

    await collections.interviews().updateOne(
      { id: body.callId },
      { $set: { retryOfCallId: prev.id, retryAttempt: (prev.retryAttempt ?? 1) + 1 } },
    );
    return { ...body, retryOfCallId: prev.id, retryAttempt: (prev.retryAttempt ?? 1) + 1 };
  });

  // ── Hang up ────────────────────────────────────────────────────────────
  // FreJun exposes no documented server-side hangup — the browser softphone
  // session ends the call. This records the recruiter's intent and lets the
  // UI settle immediately; the authoritative end still arrives by webhook.
  app.post<{ Params: { id: string } }>("/calls/:id/hangup", async (req, reply) => {
    const call = await collections.interviews().findOne<InterviewTelephonyDoc>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) {
      return reply.code(404).send({ error: "not_found" });
    }
    await applyStatus({
      callId: req.params.id,
      status: "completed",
      source: "sdk",
      patch: { endTime: new Date() },
      log: req.log,
    });
    await collections
      .interviews()
      .updateOne({ id: req.params.id }, { $set: { status: "ended", endedAt: new Date() } });
    return { ok: true };
  });

  // ── Status, with optional live reconcile ───────────────────────────────
  // `?refresh=true` pulls the truth straight from FreJun's call log instead of
  // waiting for a webhook. This is what makes the whole flow testable BEFORE a
  // public webhook URL exists — and it doubles as the missed-webhook repair.
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/calls/:id",
    async (req, reply) => {
      const call = await collections.interviews().findOne<
        InterviewTelephonyDoc & { telephony?: Record<string, unknown> }
      >({ id: req.params.id }, { projection: { _id: 0 } });
      if (!call || call.recruiterUserId !== req.authUser!.uid) {
        return reply.code(404).send({ error: "not_found" });
      }

      if (req.query.refresh === "true") {
        try {
          const remote =
            (await findCallByTransactionId(req.params.id)) ??
            (call.telephony?.frejunCallId
              ? await findCallById(String(call.telephony.frejunCallId))
              : null);
          if (remote) {
            const mapped = mapFrejunStatus(remote.status, Boolean(remote.call_start_time));
            // The reconcile (a webhook-MISS backfill, but polled by the client) must
            // NEVER drive the "answered" transition. On an OUTBOUND call FreJun's
            // call-log flips to "ongoing" + sets `call_start_time` the moment the
            // RECRUITER's own browser leg joins the FreJun bridge — while the
            // candidate's phone is still RINGING. Trusting that lit up "On call" +
            // the timer + the live transcript before anyone picked up. Only the
            // webhook's `answer_time` marks the CANDIDATE actually answering, so the
            // reconcile backfills every state EXCEPT "answered" (and "ringing", which
            // it should never regress the webhook's progress with).
            if (mapped && mapped !== "answered" && mapped !== "ringing") {
              await applyStatus({
                callId: req.params.id,
                status: mapped,
                source: "reconcile",
                patch: {
                  frejunCallId: remote.call_id,
                  startTime: remote.call_start_time ? new Date(remote.call_start_time) : null,
                  endTime: remote.call_end_time ? new Date(remote.call_end_time) : null,
                  // FreJun reports minutes; we store milliseconds everywhere.
                  durationMs:
                    remote.call_duration != null ? Math.round(remote.call_duration * 60_000) : null,
                  frejunRecordingUrl: remote.recording_url ?? null,
                },
                log: req.log,
              });
            } else {
              req.log.warn({ status: remote.status }, "unmapped frejun status");
            }
          }
        } catch (err) {
          req.log.warn({ err, callId: req.params.id }, "frejun reconcile failed");
        }
        const fresh = await collections
          .interviews()
          .findOne({ id: req.params.id }, { projection: { _id: 0, telephony: 1, id: 1, status: 1 } });
        return { call: fresh };
      }

      return {
        call: {
          id: call.id,
          status: (call as { status?: string }).status ?? null,
          telephony: call.telephony ?? null,
          retryOfCallId: (call as { retryOfCallId?: string | null }).retryOfCallId ?? null,
        },
      };
    },
  );
}
