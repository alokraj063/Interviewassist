// Calls API for Interview Assist.
//
// Lifecycle:
//   POST  /api/calls               → create a call (returns WS URLs)
//   POST  /api/calls/:id/end       → mark ended
//   GET   /api/calls/:id           → call metadata + transcript + summary
//   GET   /api/calls/:id/context   → candidate + demand context card
//   GET   /api/calls               → list THIS recruiter's previous calls
//   GET   /api/calls/:id/transcripts → transcript array
//   GET   /api/calls/:id/recording → WAV stream (if recording exists)
//
// EVERYTHING lives inline on the single `ia_interviews` document:
//   recruiter*, candidate, demandSnapshot, transcript[], summary, status,
//   timestamps. There are no side tables — no transcriptTurns, no
//   suggestions, no evaluations, no aiUsageEvents.

import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";

const transcriptionChoiceSchema = z.object({
  provider: z.enum(["deepgram", "sarvam", "shunya"]).default("deepgram"),
  model: z.string().default("nova-3"),
  language: z.enum(["multi", "en-US", "en-IN", "hi-IN"]).default("multi"),
});

// Ephemeral candidate payload — every field optional so the picker can hand
// us as little as "name + phone" if the resume parser didn't fire.
const ephemeralCandidateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  currentTitle: z.string().max(200).optional(),
  currentCompany: z.string().max(200).optional(),
  totalExperienceYears: z.number().min(0).max(80).optional(),
  currentLocation: z.string().max(120).optional(),
  // Anything the résumé parser produced. Stored verbatim on the call doc.
  resumeBlobKey: z.string().max(500).optional(),
  resumeFilename: z.string().max(500).optional(),
  resumeMime: z.string().max(120).optional(),
  parsedResume: z.record(z.unknown()).optional(),
}).strict();

const createSchema = z.object({
  // `demandId` is OL's `jobPostings._id` (hex string) — the recruiter must
  // be assigned to it via jobAssignMappings.
  demandId: z.string().optional(),
  // Old multi-tenant fields kept tolerant so a still-warm client doesn't
  // 400 — they're ignored.
  prospectId: z.string().optional(),
  origin: z.enum(["web", "telephony", "desktop", "bridge"]).optional(),
  mode: z.enum(["browser_mixed", "desktop_dual_channel"]).optional(),
  transcription: transcriptionChoiceSchema.optional(),
  // Ephemeral candidate identity for this call.
  candidate: ephemeralCandidateSchema.optional(),
}).strict();

function wsUrls(callId: string, mode: string) {
  const base = env.API_PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "");
  const ingestPath = `/ws/ingest-call?callId=${callId}&mode=${mode}`;
  return { wsIngestUrl: `${base}${ingestPath}`, wsSessionUrl: `${base}/ws/session?callId=${callId}` };
}

interface OlJobPosting {
  _id: ObjectId;
  uid: string;
  title?: string;
  designation?: string;
  primaryLocation?: string;
  location?: string;
  experienceFrom?: number;
  experienceTo?: number;
  salaryFrom?: number;
  salaryTo?: number;
  clientId?: ObjectId;
}
interface OlClient { companyName?: string }
// Same visibility scope OL uses on /job_postings:
//   • Recruiter / AM / Lead → own assigned jobs.
//   • BH                    → own + every AM reporting to them.
async function resolveAssigneeIds(ctx: { mongoId: string; role: string }): Promise<ObjectId[]> {
  const selfId = new ObjectId(ctx.mongoId);
  if (ctx.role !== "UserBusinessHead") return [selfId];
  const ams = await collections.olUsers()
    .find<{ _id: ObjectId }>({ reportingTo: selfId, type: "UserAccountManager" })
    .project({ _id: 1 })
    .toArray();
  return [selfId, ...ams.map((a) => a._id)];
}

async function loadOlJob(jobId: string, ctx: { mongoId: string; role: string }) {
  let oid: ObjectId;
  try { oid = new ObjectId(jobId); }
  catch { return null; }
  const assigneeIds = await resolveAssigneeIds(ctx);
  const mapping = await collections.olJobAssignMappings().findOne({
    userId: { $in: assigneeIds },
    jobPostingId: oid,
  });
  if (!mapping) return null;
  const job = await collections.olJobPostings().findOne<OlJobPosting>({ _id: oid });
  return job ?? null;
}

export async function callsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ── Create ─────────────────────────────────────────────────────────────
  app.post("/", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const d = parsed.data;

    const transcription = d.transcription ?? {
      provider: "deepgram" as const, model: "nova-3", language: "multi" as const,
    };
    // Per-tenant credentials are gone — resolve from env only. The function
    // already supports that path (passes the request through to env vars).
    const creds = await getProviderCredentials(/* legacy orgId */ ctx.uid, transcription.provider);
    if (!creds) return reply.code(503).send({ error: `${transcription.provider}_api_key_missing` });

    // Optional demand validation. If supplied, the recruiter MUST own it.
    let demandSnapshot: Record<string, unknown> | null = null;
    if (d.demandId) {
      const job = await loadOlJob(d.demandId, ctx);
      if (!job) return reply.code(403).send({ error: "demand_not_assigned" });
      let clientName: string | null = null;
      if (job.clientId) {
        const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
        clientName = c?.companyName ?? null;
      }
      demandSnapshot = {
        id: job._id.toHexString(),
        uid: job.uid,
        title: job.title ?? null,
        designation: job.designation ?? null,
        client: clientName,
        primaryLocation: job.primaryLocation ?? job.location ?? null,
        experienceFrom: job.experienceFrom ?? null,
        experienceTo: job.experienceTo ?? null,
        salaryFrom: job.salaryFrom ?? null,
        salaryTo: job.salaryTo ?? null,
      };
    }

    const id = randomUUID();
    const now = new Date();
    const mode = d.mode ?? "browser_mixed";
    // ONE document, everything inline:
    //   recruiter (who ran the call), candidate (whom they spoke to),
    //   demandSnapshot (the JD), transcript[] (filled live), summary (the
    //   final AI verdict).
    await collections.interviews().insertOne({
      id,
      recruiterUserId: ctx.uid,
      recruiterMongoId: ctx.mongoId,
      recruiterEmail: ctx.email,
      recruiterName: ctx.name,
      candidate: d.candidate ?? null,
      candidateRefOrPhone: d.candidate?.phone ?? d.candidate?.email ?? null,
      demandId: d.demandId ?? null,
      demandSnapshot,
      status: "assigned", mode, origin: d.origin ?? "web",
      transcriberProvider: transcription.provider,
      transcriberModel: transcription.model,
      transcriberLanguage: transcription.language,
      transcript: [],                                  // pushed to live
      summary: null,                                   // set by /assist/final
      recordingUrl: null, recordingDurationMs: null, recordingMime: null,
      startedAt: now, endedAt: null, createdAt: now,
    });
    return {
      callId: id,
      status: "assigned",
      startedAt: now.toISOString(),
      mode,
      transcription,
      demand: demandSnapshot,
      candidate: d.candidate ?? null,
      ...wsUrls(id, mode),
    };
  });

  // ── End ─────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/:id/end", async (req, reply) => {
    const call = await collections.interviews().findOne<{ recruiterUserId: string }>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    await collections.interviews().updateOne(
      { id: req.params.id },
      { $set: { status: "ended", endedAt: new Date() } },
    );
    return { ok: true };
  });

  // ── Context card (candidate + demand) used by the live call ──────────
  app.get<{ Params: { id: string } }>("/:id/context", async (req, reply) => {
    const call = await collections.interviews().findOne({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "call_not_found" });
    return {
      call: { id: call.id, status: call.status, mode: call.mode },
      demand: call.demandSnapshot ?? null,
      candidate: call.candidate ?? null,
    };
  });

  // ── Detail + list — strict recruiter ownership ───────────────────────
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const call = await collections.interviews().findOne(
      { id: req.params.id },
      { projection: { _id: 0 } },
    );
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    return call;
  });

  app.get("/", async (req) => {
    const rows = await collections.interviews()
      .find({ recruiterUserId: req.authUser!.uid }, { projection: { _id: 0 } })
      .sort({ startedAt: -1 })
      .limit(100)
      .toArray();
    return { calls: rows };
  });

  // ── Recording playback (auth WAV stream) ────────────────────────────
  app.get<{ Params: { id: string } }>("/:id/recording", async (req, reply) => {
    const call = await collections.interviews().findOne<{ recruiterUserId: string; recordingUrl: string | null }>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    if (!call.recordingUrl) return reply.code(404).send({ error: "no_recording" });
    const dumpDir = path.resolve(env.DUMP_DIR);
    const full = path.resolve(dumpDir, call.recordingUrl);
    if (!full.startsWith(dumpDir)) return reply.code(403).send({ error: "forbidden" });
    let size: number;
    try { size = statSync(full).size; }
    catch { return reply.code(404).send({ error: "file_missing" }); }
    void reply.header("Content-Type", "audio/wav").header("Accept-Ranges", "bytes").header("Content-Length", size);
    return reply.send(createReadStream(full));
  });

  // ── Transcript history ─────────────────────────────────────────────────
  // The session WS pushes into `transcript[]` live; this endpoint just hands
  // back the inline array for the post-call review screen.
  app.get<{ Params: { id: string } }>("/:id/transcripts", async (req, reply) => {
    const call = await collections.interviews().findOne<{
      recruiterUserId: string;
      transcript?: Array<Record<string, unknown>>;
    }>({ id: req.params.id }, { projection: { _id: 0, recruiterUserId: 1, transcript: 1 } });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    return { turns: call.transcript ?? [] };
  });
}
