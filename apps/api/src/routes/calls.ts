import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  callQaReviews,
  callRubricScores,
  callRubrics,
  callSessions,
  callTechnicalQa,
  callTranslations,
  CALL_MODES,
  jdMatchRuns,
  candidates,
  candidateResumes,
  clients,
  db,
  demands,
  memberships,
  transcriptTurns,
  transcriptSpeakerBrackets,
  users,
} from "@j2w/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { TranscriptTurn, TranslationConfig } from "@j2w/shared-types";
import {
  blobStore,
  getCallSummaryQueue,
  getPostDiarizeQueue,
  getTechnicalQaExtractQueue,
} from "@j2w/ingest-shared";
import { buildInterviewReport, type InterviewEval } from "../reports/interviewReport.js";
import { z } from "zod";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { clearRubricTickState, maybeRubricTick } from "../rag/live-rubric.js";
import { rescoreTurnsMultilingual, scorePartial } from "../rag/sentiment.js";
import { maybeSuggest, rememberTurn } from "../rag/suggest.js";
import { broadcastToCall } from "../ws/session.js";
import { clearCallContext, translateTurnIfEnabled } from "../translation/pipeline.js";
import {
  clearCallConfig,
  getCallConfig,
  getWorkspaceSettings,
  patchCallConfig,
  setCallConfig,
} from "../translation/state.js";

// STT selection for the live recruiter call (the wedge). Mirrors the enums in
// routes/live-assist.ts and the client catalog in transcriptionConfig.ts.
const transcriptionChoiceSchema = z.object({
  provider: z.enum(["deepgram", "sarvam", "shunya"]).default("deepgram"),
  model: z.string().default("nova-3"),
  language: z.enum(["multi", "en-US", "en-IN", "hi-IN"]).default("multi"),
});

const createSchema = z.object({
  candidateRefOrPhone: z.string().optional(),
  recruiterUserId: z.string().uuid().optional(),
  origin: z.enum(["web", "telephony", "desktop", "bridge"]).optional(),
  // Wedge fields (optional so existing callers keep working).
  demandId: z.string().uuid().optional(),
  prospectId: z.string().uuid().optional(),
  candidateId: z.string().uuid().optional(),
  mode: z.enum(CALL_MODES).optional(),
  // Optional: which STT provider this call should use. Defaults to Deepgram so
  // existing callers (and the legacy desktop path) keep working unchanged.
  transcription: transcriptionChoiceSchema.optional(),
});

function wsBaseFromApiPublicUrl(): string {
  const base = env.API_PUBLIC_URL.replace(/^http/, "ws");
  return base.replace(/\/$/, "");
}

function buildWsUrls(callId: string, mode: string): { wsIngestUrl: string; wsSessionUrl: string } {
  const base = wsBaseFromApiPublicUrl();
  // The recruiter wedge mixed-mono path uses /ws/ingest-call. Two-channel
  // desktop uses the same WS but with mode=desktop_dual_channel.
  const ingestPath = mode === "browser_mixed" || mode === "desktop_dual_channel"
    ? `/ws/ingest-call?callId=${callId}&mode=${mode}`
    : `/ws/ingest?callId=${callId}`;
  return {
    wsIngestUrl: `${base}${ingestPath}`,
    wsSessionUrl: `${base}/ws/session?callId=${callId}`,
  };
}

async function serializeCall(id: string) {
  const [row] = await db.select().from(callSessions).where(eq(callSessions.id, id));
  return row ?? null;
}

function publishAssigned(call: NonNullable<Awaited<ReturnType<typeof serializeCall>>>): void {
  if (!call.recruiterUserId || !call.orgId) return;
  bus.publish({
    type: "call_assigned",
    callId: call.id,
    recruiterUserId: call.recruiterUserId,
    orgId: call.orgId,
    candidateRefOrPhone: call.candidateRefOrPhone ?? null,
    origin: (call.origin as "web" | "telephony" | "desktop" | "vapi" | "bridge" | null) ?? "web",
    assignedAt: (call.assignedAt ?? new Date()).toISOString(),
  });
}

export async function callsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Create a call. If agentUserId is supplied (by a dispatcher or the agent
  // themselves), the call is immediately `assigned`; otherwise `queued` for a
  // supervisor to route. Compatible with the old POST /start call from the
  // desktop app (empty body → self-create for the authenticated user with
  // origin=desktop).
  app.post("/", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

    const recruiterUserId = parsed.data.recruiterUserId ?? null;
    const origin = parsed.data.origin ?? "web";

    if (recruiterUserId) {
      // Must be a member of the caller's org.
      const [m] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, recruiterUserId), eq(memberships.orgId, ctx.orgId)));
      if (!m) return reply.code(400).send({ error: "recruiter_not_in_org" });
      if (!ctx.permissions.includes("calls.assign") && recruiterUserId !== ctx.id) {
        return reply.code(403).send({ error: "forbidden", permission: "calls.assign" });
      }
    }

    const id = randomUUID();
    const now = new Date();
    const mode = parsed.data.mode ?? "browser_mixed";

    // Resolve the STT selection. Validate the provider's credentials eagerly so
    // the recruiter gets a clear error here — before the mic opens and the WS
    // would otherwise close with a 4503 mid-handshake.
    const transcription = parsed.data.transcription ?? {
      provider: "deepgram" as const,
      model: "nova-3",
      language: "multi" as const,
    };
    const creds = await getProviderCredentials(ctx.orgId, transcription.provider);
    if (!creds) {
      return reply.code(503).send({ error: `${transcription.provider}_api_key_missing` });
    }

    await db.insert(callSessions).values({
      id,
      orgId: ctx.orgId,
      recruiterUserId,
      candidateRefOrPhone: parsed.data.candidateRefOrPhone ?? null,
      status: recruiterUserId ? "assigned" : "queued",
      origin,
      mode,
      demandId: parsed.data.demandId ?? null,
      prospectId: parsed.data.prospectId ?? null,
      candidateId: parsed.data.candidateId ?? null,
      transcriberProvider: transcription.provider,
      transcriberModel: transcription.model,
      transcriberLanguage: transcription.language,
      createdByUserId: ctx.id,
      assignedAt: recruiterUserId ? now : null,
    });
    const call = await serializeCall(id);
    if (call && call.recruiterUserId) publishAssigned(call);

    const urls = buildWsUrls(id, mode);
    return {
      callId: id,
      status: call?.status,
      startedAt: call?.startedAt,
      mode,
      transcription,
      ...urls,
    };
  });

  // ---------- MANUAL SPEAKER BRACKET ----------
  // Browser-mic mixed-mono calls land with speaker='unknown'. The recruiter
  // can optionally tap "I'm speaking" / "Candidate speaking" buttons that
  // POST a marker; the post_diarize worker uses these as ground truth before
  // falling back to Deepgram's diarization confidence.
  const bracketSchema = z.object({
    speaker: z.enum(["recruiter", "candidate"]),
    tsMs: z.number().int().nonnegative(),
  });
  app.post("/:id/manual-speaker-bracket", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = bracketSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const [call] = await db
      .select({ id: callSessions.id, recruiterUserId: callSessions.recruiterUserId })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    if (call.recruiterUserId !== ctx.id && !ctx.permissions.includes("calls.assign")) {
      return reply.code(403).send({ error: "not_your_call" });
    }

    await db.insert(transcriptSpeakerBrackets).values({
      callId: id,
      speaker: parsed.data.speaker,
      tsMs: parsed.data.tsMs,
      source: "manual",
    });

    return { ok: true };
  });

  // Legacy alias — desktop app used to POST /start with no body. Now just
  // delegates to POST / with origin=desktop + recruiter=self.
  app.post("/start", async (req) => {
    const ctx = req.authUser!;
    const id = randomUUID();
    const now = new Date();
    await db.insert(callSessions).values({
      id,
      orgId: ctx.orgId,
      recruiterUserId: ctx.id,
      candidateRefOrPhone:
        ((req.body as { candidateRefOrPhone?: string } | undefined)?.candidateRefOrPhone) ?? null,
      status: "active",
      origin: "desktop",
      createdByUserId: ctx.id,
      assignedAt: now,
      acceptedAt: now,
    });
    const call = await serializeCall(id);
    if (call) publishAssigned(call);
    return { callId: id, startedAt: call?.startedAt ?? now.toISOString() };
  });

  // Assign an existing queued call to a recruiter.
  const assignSchema = z.object({ recruiterUserId: z.string().uuid() });
  app.post(
    "/:id/assign",
    { preHandler: [app.requirePermission("calls.assign")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

      const [m] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, parsed.data.recruiterUserId), eq(memberships.orgId, ctx.orgId)));
      if (!m) return reply.code(400).send({ error: "recruiter_not_in_org" });

      const result = await db
        .update(callSessions)
        .set({
          recruiterUserId: parsed.data.recruiterUserId,
          status: "assigned",
          assignedAt: new Date(),
        })
        .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)))
        .returning({ id: callSessions.id });
      if (result.length === 0) return reply.code(404).send({ error: "call_not_found" });

      const call = await serializeCall(id);
      if (call) publishAssigned(call);
      return { ok: true };
    },
  );

  // Recruiter confirms they're picking up the call.
  app.post("/:id/accept", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select()
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    if (call.recruiterUserId !== ctx.id) return reply.code(403).send({ error: "not_assigned_to_you" });
    if (call.status === "ended") return reply.code(409).send({ error: "call_ended" });
    await db
      .update(callSessions)
      .set({ status: "active", acceptedAt: call.acceptedAt ?? new Date() })
      .where(eq(callSessions.id, id));
    return { ok: true };
  });

  // Recruiter's currently-active call (assigned or active). Desktop app's
  // fallback poll path for clients that can't keep a WS open.
  app.get("/me/active", async (req) => {
    const ctx = req.authUser!;
    const [call] = await db
      .select()
      .from(callSessions)
      .where(
        and(
          eq(callSessions.recruiterUserId, ctx.id),
          inArray(callSessions.status, ["assigned", "active"]),
        ),
      )
      .limit(1);
    return { call: call ?? null };
  });

  app.post("/:id/end", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const updated = await db
      .update(callSessions)
      .set({ endedAt: new Date(), status: "ended" })
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)))
      .returning();
    if (updated.length === 0) return reply.code(404).send({ error: "call_not_found" });
    bus.publish({ type: "call_ended", callId: id, recruiterUserId: updated[0].recruiterUserId ?? null });
    // call_summary, post_diarize, and rescoreTurnsMultilingual run independently.
    // Summary used to run in-process; it's now a queued worker so retries and
    // backoff are handled and the API request returns fast.
    void getCallSummaryQueue()
      .add(`call-summary-${id}`, { callId: id }, { jobId: `call-summary-${id}` })
      .catch((err) => req.log.warn({ err, callId: id }, "call-summary enqueue failed"));
    void rescoreTurnsMultilingual(id, req.log);
    // Post-call worker chain. Acoustic-sentiment was already enqueued from
    // the WS ingest close; post-diarize -> rubric-finalize runs on the
    // recording. If there's no recording_url yet (Vapi-only calls)
    // post-diarize will skip gracefully.
    void getPostDiarizeQueue()
      .add(`post-diarize-${id}`, { callId: id }, { jobId: `post-diarize-${id}` })
      .catch((err) => req.log.warn({ err, callId: id }, "post-diarize enqueue failed"));
    // Technical Q&A extraction — runs independently so a slow LLM call
    // doesn't delay other post-call work. Surfaces on Call Detail "Q&A"
    // tab and the QA reviewer drawer.
    void getTechnicalQaExtractQueue()
      .add(`technical-qa-${id}`, { callId: id }, { jobId: `technical-qa-${id}` })
      .catch((err) => req.log.warn({ err, callId: id }, "technical-qa enqueue failed"));
    // Release the per-call translation config + rolling context so memory
    // doesn't leak when a call ends.
    clearCallConfig(id);
    clearCallContext(id);
    clearRubricTickState(id);
    return { callId: id, endedAt: updated[0].endedAt };
  });

  // ---------- Live translation lifecycle ----------
  // Enabling/disabling/adjusting translation mid-call. The actual translation
  // work happens in apps/api/src/translation/pipeline.ts; these endpoints only
  // mutate the in-memory TranslationConfig that the pipeline reads on every
  // transcript.final.
  const enableSchema = z.object({
    mode: z.enum(["inbound", "bidirectional"]).default("bidirectional"),
    sourceLang: z.string().min(2).max(16).default("auto"),
    targetLang: z.string().min(2).max(16),
    // Provider/model/latency fall back to workspace defaults when omitted so
    // the UI can pass just the language selection on the hot path.
    provider: z.enum(["mock", "openai", "google", "deepl", "azure", "sarvam"]).optional(),
    model: z.string().optional(),
    latencyMode: z.enum(["realtime", "balanced", "accurate"]).optional(),
    preserveTone: z.boolean().optional(),
    redactPII: z.boolean().optional(),
    glossaryId: z.string().uuid().nullable().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    lowConfidenceAction: z.enum(["show-warning", "insert-original", "drop"]).optional(),
  });

  app.post("/:id/translation/enable", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = enableSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.format() });
    }
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const defaults = await getWorkspaceSettings(ctx.orgId);
    const config: TranslationConfig = {
      callId: id,
      mode: parsed.data.mode,
      provider: parsed.data.provider ?? defaults.provider,
      model: parsed.data.model ?? defaults.model,
      sourceLang: parsed.data.sourceLang as TranslationConfig["sourceLang"],
      targetLang: parsed.data.targetLang,
      latencyMode: parsed.data.latencyMode ?? defaults.latencyMode,
      preserveTone: parsed.data.preserveTone ?? defaults.preserveTone,
      redactPII: parsed.data.redactPII ?? defaults.redactPII,
      glossaryId:
        parsed.data.glossaryId !== undefined ? parsed.data.glossaryId : defaults.glossaryId,
      confidenceThreshold: parsed.data.confidenceThreshold ?? defaults.confidenceThreshold,
      lowConfidenceAction: parsed.data.lowConfidenceAction ?? defaults.lowConfidenceAction,
    };
    setCallConfig(config);
    broadcastToCall(id, { type: "translation.config", config });
    return { config };
  });

  app.post("/:id/translation/disable", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    clearCallConfig(id);
    clearCallContext(id);
    broadcastToCall(id, { type: "translation.config", config: null });
    return { ok: true };
  });

  const patchTranslationSchema = enableSchema
    .partial()
    .extend({ mode: z.enum(["off", "inbound", "bidirectional"]).optional() });
  app.patch("/:id/translation", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = patchTranslationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const existing = getCallConfig(id);
    if (!existing) return reply.code(409).send({ error: "translation_not_enabled" });

    if (parsed.data.mode === "off") {
      clearCallConfig(id);
      clearCallContext(id);
      broadcastToCall(id, { type: "translation.config", config: null });
      return { config: null };
    }

    const next = patchCallConfig(id, {
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.sourceLang !== undefined
        ? {
            sourceLang: parsed.data.sourceLang as TranslationConfig["sourceLang"],
            // Clear any prior auto-detection so the provider re-detects.
            detectedSourceLang: undefined,
          }
        : {}),
      ...(parsed.data.targetLang ? { targetLang: parsed.data.targetLang } : {}),
      ...(parsed.data.latencyMode ? { latencyMode: parsed.data.latencyMode } : {}),
      ...(parsed.data.preserveTone !== undefined
        ? { preserveTone: parsed.data.preserveTone }
        : {}),
      ...(parsed.data.redactPII !== undefined ? { redactPII: parsed.data.redactPII } : {}),
      ...(parsed.data.glossaryId !== undefined ? { glossaryId: parsed.data.glossaryId } : {}),
      ...(parsed.data.confidenceThreshold !== undefined
        ? { confidenceThreshold: parsed.data.confidenceThreshold }
        : {}),
      ...(parsed.data.lowConfidenceAction
        ? { lowConfidenceAction: parsed.data.lowConfidenceAction }
        : {}),
    });
    if (!next) return reply.code(409).send({ error: "translation_not_enabled" });
    broadcastToCall(id, { type: "translation.config", config: next });
    return { config: next };
  });

  app.get("/:id/translation", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    return { config: getCallConfig(id) };
  });

  // Post-call list of translated turns, used by the Conversation Detail page
  // toggle ("show translated" vs "show original") in Phase 3.
  app.get("/:id/translations", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const rows = await db
      .select()
      .from(callTranslations)
      .where(eq(callTranslations.callId, id))
      .orderBy(asc(callTranslations.createdAt));
    return {
      translations: rows.map((r) => ({
        id: r.id,
        callId: r.callId,
        turnId: r.turnId,
        speaker: r.speaker,
        sourceLang: r.sourceLang,
        sourceText: r.sourceText,
        targetLang: r.targetLang,
        targetText: r.targetText,
        confidence: r.confidence,
        latencyMs: r.latencyMs,
        provider: r.provider,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // Ingest a single finalised transcript turn produced outside the Deepgram
  // stream (e.g. the Vapi-backed Live Assist test call). Behaves like the
  // final-transcript branch of apps/api/src/deepgram/stream.ts — persist,
  // broadcast, and drive the sentiment/suggestion/topics/compliance pipeline.
  const transcriptSchema = z.object({
    speaker: z.enum(["recruiter", "candidate", "unknown", "mixed"]),
    text: z.string().min(1).max(10_000),
    tsStartMs: z.number().int().nonnegative(),
    tsEndMs: z.number().int().nonnegative(),
  });
  app.post("/:id/transcripts", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const parsed = transcriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const body = parsed.data;
    const text = body.text.trim();
    if (!text) return reply.code(400).send({ error: "empty_text" });

    let turnId = -1;
    try {
      const [row] = await db
        .insert(transcriptTurns)
        .values({
          callId: id,
          speaker: body.speaker,
          text,
          isFinal: true,
          tsStartMs: body.tsStartMs,
          tsEndMs: body.tsEndMs,
        })
        .returning();
      turnId = row.id;
    } catch (err) {
      req.log.error({ err, callId: id }, "failed to persist ingested transcript turn");
    }

    const turn: TranscriptTurn = {
      id: turnId,
      callId: id,
      speaker: body.speaker,
      text,
      isFinal: true,
      tsStartMs: body.tsStartMs,
      tsEndMs: body.tsEndMs,
      sentiment: null,
    };

    rememberTurn(id, turn);
    broadcastToCall(id, { type: "transcript.final", turn });

    if (body.speaker === "candidate" || body.speaker === "unknown") {
      scorePartial(id, text, req.log);
      void maybeSuggest(id, turnId >= 0 ? turnId : null, req.log);
    }
    // Live rubric tick — debounced, runs on any final turn from either
    // speaker since rubrics often score recruiter behaviour.
    maybeRubricTick(id, req.log);

    // Fire the translation pipeline in parallel with the sentiment/suggest
    // pipelines. No-op when translation is disabled for this call.
    void translateTurnIfEnabled({ callId: id, turn, log: req.log });

    return { turnId };
  });

  // Rubric scores for the Call Detail rubric tab. Joins criterion definitions
  // (live in call_rubrics.criteria JSONB) with per-criterion scores from
  // call_rubric_scores so the UI can render labels, weights, and band
  // thresholds alongside the AI verdict and evidence quotes.
  app.get("/:id/rubric", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [call] = await db
      .select({ id: callSessions.id, orgId: callSessions.orgId, recruiterUserId: callSessions.recruiterUserId })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const scores = await db
      .select()
      .from(callRubricScores)
      .where(eq(callRubricScores.callId, id));

    if (scores.length === 0) {
      return { rubric: null, scores: [], qaReview: null };
    }

    // All scores for a single call share a rubricId.
    const rubricId = scores[0].rubricId;
    const [rubric] = await db
      .select({
        id: callRubrics.id,
        name: callRubrics.name,
        purpose: callRubrics.purpose,
        criteria: callRubrics.criteria,
      })
      .from(callRubrics)
      .where(eq(callRubrics.id, rubricId));

    const [qaReview] = await db
      .select()
      .from(callQaReviews)
      .where(eq(callQaReviews.callId, id))
      .limit(1);

    // Editable when the caller has qa.write AND a pending review row exists.
    const editable =
      ctx.permissions.includes("qa.write") &&
      !!qaReview &&
      qaReview.reviewerScore === null;

    return {
      rubric: rubric ?? null,
      scores,
      qaReview: qaReview ?? null,
      editable,
    };
  });

  // Latest JD-match for this call's (demand, candidate) pair. The call
  // must have both demandId and candidateId set; otherwise returns
  // status: "no_pair". Trigger a fresh run via POST /api/candidates/:id/jd-matches/run.
  app.get("/:id/jd-match", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select({
        id: callSessions.id,
        demandId: callSessions.demandId,
        candidateId: callSessions.candidateId,
      })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    if (!call.demandId || !call.candidateId) {
      return { match: null, status: "no_pair" };
    }
    const [run] = await db
      .select()
      .from(jdMatchRuns)
      .where(
        and(
          eq(jdMatchRuns.demandId, call.demandId),
          eq(jdMatchRuns.candidateId, call.candidateId),
        ),
      )
      .orderBy(desc(jdMatchRuns.createdAt))
      .limit(1);
    if (!run) return { match: null, status: "not_yet_run" };
    return { match: run, status: "ok" };
  });

  // Technical Q&A spans for the call (produced by the technical_qa_extract
  // worker). Surfaces in the QA reviewer drawer and the Call Detail Q&A
  // tab. Returns [] when the worker hasn't run yet or extracted nothing.
  app.get("/:id/technical-qa", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const items = await db
      .select()
      .from(callTechnicalQa)
      .where(eq(callTechnicalQa.callId, id))
      .orderBy(asc(callTechnicalQa.questionIndex));
    return { items };
  });

  // Auth playback for a call recording. Streams the WAV from the volume-
  // mounted DUMP_DIR with Content-Range support so the audio player can
  // seek. Path traversal is blocked: we resolve the row's recording_url
  // (relative path) against DUMP_DIR and verify the result still lives
  // under DUMP_DIR before opening the file.
  app.get("/:id/recording", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [call] = await db
      .select({
        id: callSessions.id,
        orgId: callSessions.orgId,
        recruiterUserId: callSessions.recruiterUserId,
        recordingUrl: callSessions.recordingUrl,
        recordingMime: callSessions.recordingMime,
      })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    // Permission: recruiter owns the call, OR caller has calls.read (DLs/
    // managers/QA reviewers/admins). The fallback covers QA review queues.
    const canPlay =
      call.recruiterUserId === ctx.id || ctx.permissions.includes("calls.read");
    if (!canPlay) return reply.code(403).send({ error: "forbidden" });

    if (!call.recordingUrl) return reply.code(404).send({ error: "no_recording" });

    // Reject non-local schemes for now (gs://, s3://, http(s)://). Future
    // work: redirect to a signed URL when those land.
    if (
      call.recordingUrl.startsWith("gs://") ||
      call.recordingUrl.startsWith("s3://") ||
      call.recordingUrl.startsWith("http://") ||
      call.recordingUrl.startsWith("https://")
    ) {
      return reply.code(501).send({ error: "remote_storage_not_implemented" });
    }

    // file:// is legacy from pre-0011; relative path is the new convention.
    let absPath: string;
    const dumpDir = path.resolve(env.DUMP_DIR);
    if (call.recordingUrl.startsWith("file://")) {
      absPath = call.recordingUrl.replace(/^file:\/\//, "");
    } else {
      absPath = path.resolve(dumpDir, call.recordingUrl);
    }
    // Path traversal guard: resolved path must live under dumpDir.
    if (!absPath.startsWith(dumpDir + path.sep) && absPath !== dumpDir) {
      return reply.code(403).send({ error: "path_outside_dump_dir" });
    }

    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return reply.code(404).send({ error: "recording_file_missing" });
    }
    if (!stats.isFile()) return reply.code(404).send({ error: "not_a_file" });

    const total = stats.size;
    const mime = call.recordingMime ?? "audio/wav";
    const range = req.headers.range;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", mime);

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).send({ error: "bad_range" });
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.code(416).send({ error: "range_not_satisfiable" });
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(absPath, { start, end }));
    }

    reply.header("Content-Length", String(total));
    return reply.send(createReadStream(absPath));
  });

  // Live Call context: candidate + demand details for the side panel on the
  // recruiter Live Call page. Lightweight; only the fields the panel needs.
  // Returns null fields when the call isn't linked to a candidate/demand
  // (e.g. legacy contact-center calls that just have candidateRefOrPhone).
  app.get("/:id/context", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [call] = await db
      .select()
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    let demand:
      | {
          id: string;
          title: string | null;
          designation: string | null;
          salaryFrom: string | null;
          salaryTo: string | null;
          experienceMinYears: string | null;
          experienceMaxYears: string | null;
          primaryLocation: string | null;
          isVip: boolean;
          workMode: string | null;
          customer: string | null;
          status: string;
        }
      | null = null;
    if (call.demandId) {
      const [d] = await db
        .select()
        .from(demands)
        .where(eq(demands.id, call.demandId));
      if (d) {
        let customerName: string | null = null;
        const [c] = await db
          .select({ name: clients.companyName })
          .from(clients)
          .where(eq(clients.id, d.clientId));
        customerName = c?.name ?? null;
        demand = {
          id: d.id,
          title: d.title ?? null,
          designation: d.designation,
          salaryFrom: d.salaryFrom,
          salaryTo: d.salaryTo,
          experienceMinYears: d.experienceMinYears,
          experienceMaxYears: d.experienceMaxYears,
          primaryLocation: d.primaryLocation,
          isVip: d.isVip,
          workMode: (d.probingDetails as { workMode?: string } | null)?.workMode ?? null,
          customer: customerName,
          status: d.status,
        };
      }
    }

    let candidate:
      | {
          id: string;
          displayName: string | null;
          email: string | null;
          phone: string | null;
          currentTitle: string | null;
          currentCompany: string | null;
          totalExperienceYears: string | null;
          currentCtcLakhs: string | null;
          expectedCtcLakhs: string | null;
          noticePeriodDays: number | null;
          noticePeriodNegotiable: boolean | null;
          currentLocation: string | null;
          linkedinUrl: string | null;
        }
      | null = null;
    if (call.candidateId) {
      const [k] = await db
        .select({
          id: candidates.id,
          displayName: candidates.displayName,
          email: candidates.email,
          phone: candidates.phone,
          currentTitle: candidates.currentTitle,
          currentCompany: candidates.currentCompany,
          totalExperienceYears: candidates.totalExperienceYears,
          currentCtcLakhs: candidates.currentCtcLakhs,
          expectedCtcLakhs: candidates.expectedCtcLakhs,
          noticePeriodDays: candidates.noticePeriodDays,
          noticePeriodNegotiable: candidates.noticePeriodNegotiable,
          currentLocation: candidates.currentLocation,
          linkedinUrl: candidates.linkedinUrl,
        })
        .from(candidates)
        .where(eq(candidates.id, call.candidateId));
      if (k) candidate = k;
    }

    return {
      callId: id,
      candidate,
      demand,
      candidateRefOrPhone: call.candidateRefOrPhone ?? null,
    };
  });

  app.get("/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!row) return reply.code(404).send({ error: "call_not_found" });

    const turns = await db
      .select()
      .from(transcriptTurns)
      .where(eq(transcriptTurns.callId, id))
      .orderBy(asc(transcriptTurns.tsStartMs));

    const [recruiter] = row.recruiterUserId
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, row.recruiterUserId))
      : [];

    return {
      call: row,
      recruiter: recruiter ?? null,
      transcript: turns,
    };
  });

  // Download the interview REPORT (PDF): the evaluation page(s) followed by the
  // candidate's résumé (the résumé PDF merged in, or its text rendered).
  app.get<{ Params: { id: string } }>("/:id/report", { preHandler: [app.requirePermission("calls.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params;
    const [call] = await db
      .select({ summary: callSessions.summary, candidateId: callSessions.candidateId })
      .from(callSessions)
      .where(and(eq(callSessions.id, id), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    const ev =
      call.summary && typeof call.summary === "object" && (call.summary as { kind?: string }).kind === "interview_eval"
        ? (call.summary as InterviewEval)
        : null;
    if (!ev) return reply.code(409).send({ error: "no_evaluation", message: "This call has no saved evaluation yet." });

    // Latest résumé for the call's candidate, if any.
    let resume: { buf: Buffer; mime?: string | null; filename?: string | null } | null = null;
    if (call.candidateId) {
      const [r] = await db
        .select({ blobKey: candidateResumes.blobKey, mime: candidateResumes.mime, filename: candidateResumes.originalFilename })
        .from(candidateResumes)
        .where(eq(candidateResumes.candidateId, call.candidateId))
        .orderBy(desc(candidateResumes.createdAt))
        .limit(1);
      if (r?.blobKey) {
        try {
          resume = { buf: await blobStore.get(r.blobKey), mime: r.mime, filename: r.filename };
        } catch {
          resume = null; // résumé blob missing — still produce the eval-only report
        }
      }
    }

    const pdf = await buildInterviewReport(ev, resume);
    const slug = (ev.candidateName || "candidate").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="interview-report-${slug || "candidate"}.pdf"`)
      .send(Buffer.from(pdf));
  });

  // Used by the web supervisor view — list the org's queued + active calls
  // with the assigned recruiter joined in.
  app.get("/", { preHandler: [app.requirePermission("calls.read")] }, async (req) => {
    const orgId = req.authUser!.orgId;
    const q = req.query as { limit?: string; withEvaluation?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const onlyEval = q.withEvaluation === "true";

    const rows = await db
      .select({
        id: callSessions.id,
        candidateRefOrPhone: callSessions.candidateRefOrPhone,
        status: callSessions.status,
        origin: callSessions.origin,
        mode: callSessions.mode,
        assignedAt: callSessions.assignedAt,
        startedAt: callSessions.startedAt,
        endedAt: callSessions.endedAt,
        recruiterUserId: callSessions.recruiterUserId,
        recruiterName: users.name,
        recruiterEmail: users.email,
        demandTitle: demands.title,
        candidateName: candidates.displayName,
        // The stored end-of-call evaluation (verdict + score + summary), if any.
        summary: callSessions.summary,
      })
      .from(callSessions)
      .leftJoin(users, eq(users.id, callSessions.recruiterUserId))
      .leftJoin(demands, eq(demands.id, callSessions.demandId))
      .leftJoin(candidates, eq(candidates.id, callSessions.candidateId))
      .where(eq(callSessions.orgId, orgId))
      .orderBy(desc(callSessions.startedAt))
      .limit(limit);

    // Surface a compact eval read on each row; keep the full summary too.
    const calls = rows
      .map((r) => {
        const ev =
          r.summary && typeof r.summary === "object" && (r.summary as { kind?: string }).kind === "interview_eval"
            ? (r.summary as { verdict?: string; score?: { overall?: number }; summary?: string; candidateName?: string })
            : null;
        return {
          ...r,
          hasEvaluation: !!ev,
          verdict: ev?.verdict ?? null,
          overallScore: ev?.score?.overall ?? null,
          summaryText: ev?.summary ?? null,
          label: r.candidateName || ev?.candidateName || r.candidateRefOrPhone || "Untitled call",
        };
      })
      .filter((r) => (onlyEval ? r.hasEvaluation : true));

    return { calls };
  });
}
