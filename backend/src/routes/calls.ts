// Calls API for Interview Assist.
//
// Lifecycle:
//   POST  /api/calls               → create a call (returns WS URLs)
//   POST  /api/calls/:id/end       → mark ended
//   GET   /api/calls/:id           → call metadata + transcript + summary
//   GET   /api/calls/:id/context   → candidate + demand context card
//   GET   /api/calls               → list THIS recruiter's previous calls
//   PUT   /api/calls/:id/notes     → recruiter's free-text notes for the call
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
import { candidateIdentity } from "../lib/candidateIdentity.js";
import { blobStore } from "@j2w/ingest-shared";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { buildInterviewReport, type InterviewEval } from "../reports/interviewReport.js";
import { evaluateCallFromTranscript } from "./assist.js";

const transcriptionChoiceSchema = z.object({
  provider: z.enum(["deepgram", "sarvam", "shunya"]).default("deepgram"),
  model: z.string().default("nova-3"),
  language: z.enum(["multi", "en-US", "en-IN", "hi-IN"]).default("multi"),
});

/** `telephony.status` values that mean the call is over. Mirrors isTerminal() in telephony/callState.ts. */
const TERMINAL_TELEPHONY = new Set(["completed", "declined", "busy", "not-answered", "failed"]);

/**
 * What actually HAPPENED on a call, in the recruiter's terms.
 *
 * `telephony.status` alone can't answer this. "completed" only means the call
 * finished — FreJun labels every finished call that way whether or not anyone
 * picked up — and the same raw status means different things in each direction:
 * an unanswered inbound call is a MISSED CALL, an unanswered outbound one is
 * just "they didn't pick up".
 *
 * So the outcome is derived, and `answerTime` is the anchor: it is written only
 * when somebody genuinely answered, so unlike the racing status strings it
 * cannot lie. Derived server-side so the call log, and QA, have one answer.
 */
function callOutcome(
  direction: string,
  status: string | null | undefined,
  answered: boolean,
): { outcome: string; outcomeLabel: string } {
  const over = !!status && TERMINAL_TELEPHONY.has(status);
  const inbound = direction === "inbound";

  if (!over) {
    if (answered) return { outcome: "in_progress", outcomeLabel: "On call" };
    if (status === "ringing") return { outcome: "ringing", outcomeLabel: inbound ? "Ringing" : "Ringing…" };
    return { outcome: "in_progress", outcomeLabel: inbound ? "Incoming" : "Dialing…" };
  }
  // Answered wins over everything: the conversation happened.
  if (answered) return { outcome: "answered", outcomeLabel: "Answered" };
  if (status === "failed") return { outcome: "failed", outcomeLabel: "Failed" };

  if (inbound) {
    // Recruiter pressed Decline vs. the caller giving up — different actions
    // for the recruiter, so the log must not blur them.
    if (status === "declined") return { outcome: "declined", outcomeLabel: "Declined by you" };
    return { outcome: "missed", outcomeLabel: "Missed call" };
  }
  if (status === "declined") return { outcome: "declined", outcomeLabel: "Declined by candidate" };
  if (status === "busy") return { outcome: "busy", outcomeLabel: "Busy" };
  return { outcome: "not_answered", outcomeLabel: "Not answered" };
}

// Ephemeral candidate payload — every field optional so the picker can hand
// us as little as "name + phone" if the resume parser didn't fire.
const ephemeralCandidateSchema = z.object({
  // OfferLetter candidate `uid` when the recruiter picked this person out of
  // the database. It's what makes a call — and therefore its notes — joinable
  // back to one candidate. See lib/candidateIdentity.ts.
  uid: z.string().max(64).optional(),
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
  // `demandId` is OL's `jobPostings.uid` (16-char nanoid) — the recruiter must
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
  createdById?: ObjectId;
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

// `jobUid` is OL's business uid (16-char nanoid), NOT the Mongo _id. Resolve
// the posting by uid, then verify assignment via its real _id.
async function loadOlJob(jobUid: string, ctx: { mongoId: string; role: string }) {
  const job = await collections.olJobPostings().findOne<OlJobPosting>({ uid: jobUid });
  if (!job) return null;
  // Same ownership scope as OL's /matching/jobs: created by me OR assigned to me.
  const selfId = new ObjectId(ctx.mongoId);
  if (job.createdById && job.createdById.equals(selfId)) return job;
  const assigneeIds = await resolveAssigneeIds(ctx);
  const mapping = await collections.olJobAssignMappings().findOne({
    userId: { $in: assigneeIds },
    jobPostingId: job._id,
  });
  return mapping ? job : null;
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
        id: job.uid,        // uid is the canonical demand identifier everywhere
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
      // Flat, indexable identity so every call — and every note on it — can be
      // pulled up per candidate later. See lib/candidateIdentity.ts.
      ...candidateIdentity(d.candidate, d.candidate?.phone),
      demandId: d.demandId ?? null,
      demandSnapshot,
      status: "assigned", mode, origin: d.origin ?? "web",
      // This route is only ever entered from the Interview Assist session, so
      // the purpose is fixed. See the `purpose` note in routes/telephony.ts —
      // it's what tells an interview's notes apart from a plain call's.
      purpose: "interview_assist",
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
  // Marks the call ended, then evaluates it straight from the transcript and
  // caches the evaluation as `summary`. Returns the evaluation so the UI can
  // show the report immediately (there is no live scoring loop any more).
  app.post<{ Params: { id: string } }>("/:id/end", async (req, reply) => {
    const call = await collections.interviews().findOne<{ recruiterUserId: string }>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    await collections.interviews().updateOne(
      { id: req.params.id },
      { $set: { status: "ended", endedAt: new Date() } },
    );

    let evaluation = null;
    try {
      evaluation = await evaluateCallFromTranscript(req.params.id, req.authUser!.uid);
      if (evaluation) {
        await collections.interviews().updateOne({ id: req.params.id }, { $set: { summary: evaluation } });
      }
    } catch (err) {
      req.log.warn({ err, callId: req.params.id }, "post-call evaluation failed");
    }
    return { ok: true, evaluation };
  });

  // ── Recruiter's own notes on the call ────────────────────────────────
  // Written DURING the call (and for a while after — recruiters type up the
  // gist once they've hung up), read back from the call log. Free text on
  // purpose: this is the recruiter's scratchpad, not a structured field, and
  // it is deliberately separate from the AI `summary` so a re-evaluation can
  // never overwrite what a human wrote.
  //
  // PUT, not PATCH: the client owns the whole string and autosaves the full
  // value, so this is a replace. An empty string clears the note.
  app.put<{ Params: { id: string } }>("/:id/notes", async (req, reply) => {
    const parsed = z
      .object({
        // 20k is far beyond any real note but bounds a pathological paste.
        notes: z.string().max(20_000),
        // WHICH SURFACE the note was typed on. The call's own `purpose` already
        // says whether it was an interview or a plain dial, but stamping the
        // note too means a row is self-describing: you can query notes alone
        // and still know which product wrote each one.
        source: z.enum(["interview_assist", "dialer"]).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await collections
      .interviews()
      .findOne<{ recruiterUserId: string; purpose?: string; demandId?: string | null }>(
        { id: req.params.id },
        { projection: { _id: 0, recruiterUserId: 1, purpose: 1, demandId: 1 } },
      );
    if (!call || call.recruiterUserId !== req.authUser!.uid) {
      return reply.code(404).send({ error: "not_found" });
    }

    const notes = parsed.data.notes.trim();
    const now = new Date();
    // Fall back to the call's own purpose so the stamp is never empty, even
    // from a client that doesn't send one.
    const source =
      parsed.data.source ??
      (call.purpose === "interview_assist" || call.demandId ? "interview_assist" : "dialer");
    await collections.interviews().updateOne(
      { id: req.params.id },
      {
        $set: {
          notes: notes || null,
          notesUpdatedAt: notes ? now : null,
          notesUpdatedBy: notes ? req.authUser!.name ?? req.authUser!.email ?? null : null,
          notesSource: notes ? source : null,
        },
      },
    );
    return { ok: true, notes: notes || null, notesUpdatedAt: notes ? now : null, notesSource: notes ? source : null };
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
    const q = req.query as {
      limit?: string; withEvaluation?: string;
      candidateUid?: string; candidateKey?: string; purpose?: string; withNotes?: string;
    };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const onlyEval = q.withEvaluation === "true";

    // Per-candidate / per-surface filters. These are what make "show me every
    // note we've written about this person" a single query rather than a
    // client-side scan — see lib/candidateIdentity.ts.
    const filter: Record<string, unknown> = { recruiterUserId: req.authUser!.uid };
    if (q.candidateUid) filter.candidateUid = q.candidateUid;
    if (q.candidateKey) filter.candidateKey = q.candidateKey;
    if (q.purpose) filter.purpose = q.purpose;
    if (q.withNotes === "true") filter.notes = { $nin: [null, ""] };

    const rows = await collections.interviews()
      .find(filter, { projection: { _id: 0 } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();

    // Surface a compact eval read (verdict + overall + summary) + a candidate/JD
    // label on each row for the Past Calls list.
    const calls = rows
      .map((r) => {
        const summary = r.summary as { kind?: string; verdict?: string; score?: { overall?: number }; summary?: string; candidateName?: string } | null;
        const ev = summary && summary.kind === "interview_eval" ? summary : null;
        const cand = r.candidate as { name?: string; email?: string; phone?: string } | null;
        const candName = cand?.name ?? null;
        const demandTitle = (r.demandSnapshot as { title?: string } | null)?.title ?? null;
        // Direction lives on the `telephony` sub-document (routes/telephony.ts
        // and the webhook both write it there) — the top-level `r.direction`
        // this used to read has never existed, so EVERY call reported
        // "outbound" and the UI's Incoming tab was permanently empty.
        // The top-level read is kept as a fallback for any legacy row.
        const tel = r.telephony as {
          direction?: string; status?: string; candidateNumber?: string; answerTime?: Date | null;
        } | null;
        const direction = tel?.direction ?? (r.direction as string) ?? "outbound";
        // MISSED is derived from `answerTime`, never from the status string.
        // Terminal statuses race (FreJun calls every finished call "completed",
        // whether or not anyone picked up), but the answer timestamp is only
        // ever written when someone actually answered — so it cannot lie.
        const answered = !!tel?.answerTime;
        // An interview that was force-ended still counts as over even if a
        // terminal telephony status never landed.
        const telStatus = tel?.status ?? (r.status === "ended" ? "completed" : null);
        const { outcome, outcomeLabel } = callOutcome(direction, telStatus, answered);
        return {
          id: r.id,
          status: r.status,
          mode: r.mode,
          direction,
          /** FreJun lifecycle state (ringing / answered / declined / …). */
          telephonyStatus: tel?.status ?? null,
          answeredAt: tel?.answerTime ?? null,
          /**
           * What happened, in recruiter terms — "Answered" / "Missed call" /
           * "Declined by candidate" / "Not answered" / "Busy" / "Failed".
           * Render this; don't re-derive it in the UI.
           */
          outcome,
          outcomeLabel,
          /** Inbound call that ended without ever being answered. */
          missed: outcome === "missed",
          /**
           * Which surface created the call — the thing that tells an Interview
           * Assist call apart from a plain Dialer one. Older rows predate the
           * field, so fall back to "had a demand ⇒ it was an interview".
           */
          purpose: (r.purpose as string) ?? (direction === "inbound" ? "inbound" : (r.demandId ? "interview_assist" : "dialer")),
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          candidateRefOrPhone: r.candidateRefOrPhone ?? null,
          recruiterName: r.recruiterName ?? null,
          recruiterEmail: r.recruiterEmail ?? null,
          demandTitle,
          candidateName: candName,
          candidateEmail: cand?.email ?? null,
          // An INBOUND call has no candidate record — the only number we know is
          // the caller's. Falling back to it keeps the log row dialable
          // ("Call Now") instead of rendering a phone-less orphan.
          candidatePhone: cand?.phone ?? tel?.candidateNumber ?? r.candidateRefOrPhone ?? null,
          hasEvaluation: !!ev,
          verdict: ev?.verdict ?? null,
          overallScore: ev?.score?.overall ?? null,
          summaryText: ev?.summary ?? null,
          // The recruiter's own note, so the call log can show it without a
          // per-row fetch. Distinct from `summaryText`, which is the AI's.
          notes: (r.notes as string | null) ?? null,
          notesUpdatedAt: (r.notesUpdatedAt as Date | null) ?? null,
          notesSource: (r.notesSource as string | null) ?? null,
          // Identity of the person on the other end — what makes notes and
          // history groupable per candidate. See lib/candidateIdentity.ts.
          candidateUid: (r.candidateUid as string | null) ?? null,
          candidateKey: (r.candidateKey as string | null) ?? null,
          // FreJun records server-side and posts the audio back on a webhook,
          // so this flips true a little AFTER the call ends.
          hasRecording: !!r.recordingUrl,
          label: candName || ev?.candidateName || r.candidateRefOrPhone || "Untitled call",
        };
      })
      .filter((r) => (onlyEval ? r.hasEvaluation : true));

    return { calls };
  });

  // ── Download the interview REPORT (PDF): evaluation page(s) + résumé ──────
  // Generates the evaluation from the transcript on the fly when none was saved
  // so a report is always available for a completed call, and caches it.
  app.get<{ Params: { id: string } }>("/:id/report", async (req, reply) => {
    const call = await collections.interviews().findOne<{
      recruiterUserId: string;
      summary?: unknown;
      candidate?: { resumeBlobKey?: string; resumeMime?: string; resumeFilename?: string } | null;
    }>({ id: req.params.id }, { projection: { _id: 0, recruiterUserId: 1, summary: 1, candidate: 1 } });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });

    let ev =
      call.summary && typeof call.summary === "object" && (call.summary as { kind?: string }).kind === "interview_eval"
        ? (call.summary as InterviewEval)
        : null;

    if (!ev) {
      try {
        const generated = await evaluateCallFromTranscript(req.params.id, req.authUser!.uid);
        if (generated) {
          ev = generated as InterviewEval;
          try {
            await collections.interviews().updateOne({ id: req.params.id }, { $set: { summary: generated } });
          } catch (err) {
            req.log.warn({ err, callId: req.params.id }, "failed to cache generated evaluation");
          }
        }
      } catch (err) {
        req.log.warn({ err, callId: req.params.id }, "transcript evaluation failed");
      }
    }

    if (!ev) {
      ev = {
        verdict: "Not scored",
        score: {},
        summary: "Not enough conversation was captured on this call to generate a score.",
        strengths: [],
        concerns: [],
        questions: [],
      } as InterviewEval;
    }

    // Résumé (stored as a blob at call-start) — appended after the eval pages.
    let resume: { buf: Buffer; mime?: string | null; filename?: string | null } | null = null;
    const rk = call.candidate?.resumeBlobKey;
    if (rk) {
      try {
        resume = { buf: await blobStore.get(rk), mime: call.candidate?.resumeMime ?? null, filename: call.candidate?.resumeFilename ?? null };
      } catch {
        resume = null;
      }
    }

    const pdf = await buildInterviewReport(ev, resume);
    const slug = (ev.candidateName || "candidate").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="interview-report-${slug || "candidate"}.pdf"`)
      .send(Buffer.from(pdf));
  });

  // ── Recording playback (auth WAV stream) ────────────────────────────
  app.get<{ Params: { id: string } }>("/:id/recording", async (req, reply) => {
    const call = await collections.interviews().findOne<{
      recruiterUserId: string; recordingUrl: string | null;
      recordingStore?: string | null; recordingMime?: string | null;
    }>({ id: req.params.id });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    if (!call.recordingUrl) return reply.code(404).send({ error: "no_recording" });
    // Serve the mime we actually stored. This used to be hard-coded to
    // audio/wav, which mislabelled every FreJun recording — those arrive over
    // the webhook as audio/mpeg (see handleRecording in routes/frejunWebhook.ts).
    const mime = call.recordingMime || "audio/wav";
    // S3 / blob-stored recording (new default) — fetch the audio back from the blob store.
    if (call.recordingStore === "blob") {
      try {
        const buf = await blobStore.get(call.recordingUrl);
        return reply.header("Content-Type", mime).header("Content-Length", buf.length).send(buf);
      } catch {
        return reply.code(404).send({ error: "file_missing" });
      }
    }
    // Legacy filesystem recordings.
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
