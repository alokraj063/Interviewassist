// Calls API (MongoDB) — the recruiter wedge call lifecycle: create → run →
// end, plus the live context card and recording playback.
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";

const transcriptionChoiceSchema = z.object({
  provider: z.enum(["deepgram", "sarvam", "shunya"]).default("deepgram"),
  model: z.string().default("nova-3"),
  language: z.enum(["multi", "en-US", "en-IN", "hi-IN"]).default("multi"),
});

const createSchema = z.object({
  candidateRefOrPhone: z.string().optional(),
  recruiterUserId: z.string().uuid().optional(),
  origin: z.enum(["web", "telephony", "desktop", "bridge"]).optional(),
  demandId: z.string().uuid().optional(),
  prospectId: z.string().uuid().optional(),
  candidateId: z.string().uuid().optional(),
  mode: z.enum(["browser_mixed", "desktop_dual_channel"]).optional(),
  transcription: transcriptionChoiceSchema.optional(),
});

function wsUrls(callId: string, mode: string) {
  const base = env.API_PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "");
  const ingestPath = `/ws/ingest-call?callId=${callId}&mode=${mode}`;
  return { wsIngestUrl: `${base}${ingestPath}`, wsSessionUrl: `${base}/ws/session?callId=${callId}` };
}

export async function callsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Create a call.
  app.post("/", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    const d = parsed.data;

    const transcription = d.transcription ?? { provider: "deepgram" as const, model: "nova-3", language: "multi" as const };
    const creds = await getProviderCredentials(ctx.orgId, transcription.provider);
    if (!creds) return reply.code(503).send({ error: `${transcription.provider}_api_key_missing` });

    const id = randomUUID();
    const now = new Date();
    const mode = d.mode ?? "browser_mixed";
    const recruiterUserId = d.recruiterUserId ?? ctx.id;
    await collections.callSessions().insertOne({
      id, orgId: ctx.orgId, recruiterUserId,
      candidateRefOrPhone: d.candidateRefOrPhone ?? null,
      status: "assigned", origin: d.origin ?? "web", mode,
      demandId: d.demandId ?? null, prospectId: d.prospectId ?? null, candidateId: d.candidateId ?? null,
      transcriberProvider: transcription.provider, transcriberModel: transcription.model,
      transcriberLanguage: transcription.language,
      createdByUserId: ctx.id, startedAt: now, endedAt: null,
      recordingUrl: null, recordingDurationMs: null, recordingMime: null, summary: null, createdAt: now,
    });
    return { callId: id, status: "assigned", startedAt: now.toISOString(), mode, transcription, ...wsUrls(id, mode) };
  });

  // End a call.
  app.post<{ Params: { id: string } }>("/:id/end", async (req, reply) => {
    const call = await collections.callSessions().findOne<{ orgId: string }>({ id: req.params.id });
    if (!call || call.orgId !== req.authUser!.orgId) return reply.code(404).send({ error: "not_found" });
    await collections.callSessions().updateOne({ id: req.params.id }, { $set: { status: "ended", endedAt: new Date() } });
    return { ok: true };
  });

  // Candidate + demand context card for the live call.
  app.get<{ Params: { id: string } }>("/:id/context", async (req, reply) => {
    const call = await collections.callSessions().findOne({ id: req.params.id });
    if (!call || call.orgId !== req.authUser!.orgId) return reply.code(404).send({ error: "call_not_found" });

    let demand = null;
    if (call.demandId) {
      const dRow = await collections.demands().findOne({ id: call.demandId });
      if (dRow) {
        let client: string | null = null;
        if (dRow.clientId) client = (await collections.clients().findOne<{ companyName: string }>({ id: dRow.clientId }))?.companyName ?? null;
        demand = {
          id: dRow.id, title: dRow.title ?? null, designation: dRow.designation ?? null,
          client, primaryLocation: dRow.primaryLocation ?? null, isVip: !!dRow.isVip,
          salaryFrom: dRow.salaryFrom ?? null, salaryTo: dRow.salaryTo ?? null,
          experienceMinYears: dRow.experienceMinYears ?? null, experienceMaxYears: dRow.experienceMaxYears ?? null,
        };
      }
    }
    let candidate = null;
    if (call.candidateId) {
      const k = await collections.candidates().findOne({ id: call.candidateId });
      if (k) candidate = {
        id: k.id, displayName: k.displayName ?? null, email: k.email ?? null, phone: k.phone ?? null,
        currentTitle: k.currentTitle ?? null, currentCompany: k.currentCompany ?? null,
        totalExperienceYears: k.totalExperienceYears ?? null, currentLocation: k.currentLocation ?? null,
        currentCtcLakhs: k.currentCtcLakhs ?? null, expectedCtcLakhs: k.expectedCtcLakhs ?? null,
        noticePeriodDays: k.noticePeriodDays ?? null,
      };
    }
    return { call: { id: call.id, status: call.status, mode: call.mode }, demand, candidate };
  });

  // Auth WAV stream for post-call playback.
  app.get<{ Params: { id: string } }>("/:id/recording", async (req, reply) => {
    const call = await collections.callSessions().findOne<{ orgId: string; recordingUrl: string | null }>({ id: req.params.id });
    if (!call || call.orgId !== req.authUser!.orgId) return reply.code(404).send({ error: "not_found" });
    if (!call.recordingUrl) return reply.code(404).send({ error: "no_recording" });
    const dumpDir = path.resolve(env.DUMP_DIR);
    const full = path.resolve(dumpDir, call.recordingUrl);
    if (!full.startsWith(dumpDir)) return reply.code(403).send({ error: "forbidden" });
    let size: number;
    try { size = statSync(full).size; } catch { return reply.code(404).send({ error: "file_missing" }); }
    void reply.header("Content-Type", "audio/wav").header("Accept-Ranges", "bytes").header("Content-Length", size);
    return reply.send(createReadStream(full));
  });

  // Detail + list.
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const call = await collections.callSessions().findOne({ id: req.params.id }, { projection: { _id: 0 } });
    if (!call || call.orgId !== req.authUser!.orgId) return reply.code(404).send({ error: "not_found" });
    return call;
  });

  app.get("/", async (req) => {
    const rows = await collections.callSessions()
      .find({ orgId: req.authUser!.orgId }, { projection: { _id: 0 } })
      .sort({ startedAt: -1 }).limit(100).toArray();
    return { calls: rows };
  });
}
