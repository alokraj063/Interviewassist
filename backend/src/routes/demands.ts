// Demands (JDs) for Interview Assist.
//
// IMPORTANT change from the old multi-tenant impl: we DO NOT keep our own
// `demands` collection any more. Jobs come live from the OfferLetter app's
// `jobPostings` collection, scoped to the recruiter that owns them via
// the `jobAssignMappings` collection (one mapping row per recruiter assigned
// to a job, with `status: "assigned"`).
//
// We also resolve the `clientId` → `companyName` on read so the picker can
// show a human-friendly client label, but neither collection is written to.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { generateJdQuestionBank } from "./assist.js";
import { buildQuestionBankReport, type QuestionBank } from "../reports/questionBankReport.js";

interface OlJobPosting {
  _id: ObjectId;
  uid: string;
  title?: string;
  designation?: string;
  status?: string;
  isActive?: boolean;
  primaryLocation?: string;
  location?: string;
  noOfOpening?: number;
  experienceFrom?: number;
  experienceTo?: number;
  salaryFrom?: number;
  salaryTo?: number;
  clientId?: ObjectId;
  rawJdText?: string;
  description?: string;
  responsibilities?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface OlClient {
  _id: ObjectId;
  companyName?: string;
}

// Latest human-refined requirement for a job — OL's `demand_calibration`
// collection (one doc per (jobPostingId, version), read-only from here).
interface OlDemandCalibration {
  uid: string;
  version: number;
  fields?: {
    designation?: string;
    experienceFrom?: number;
    experienceTo?: number;
    workMode?: string;
    location?: string;
    keyResponsibilities?: string[];
    mustHaves?: string[];
    goodToHave?: string[];
    caveats?: string[];
  };
}

// Map an OL JobPosting → the shape the Live Assist frontend expects from
// `GET /api/demands`. Field names follow the original Postgres schema so
// the React Query hook + zod types in the inter/frontend port still work.
function adaptDemand(jp: OlJobPosting, clientName: string | null) {
  return {
    id: jp._id.toHexString(),                  // we use the Mongo _id as the API id
    uid: jp.uid,                               // OL's business UID — handy for logging
    title: jp.title ?? null,
    designation: jp.designation ?? null,
    status: (jp.status || (jp.isActive === false ? "closed" : "active")).toLowerCase(),
    isVip: false,
    primaryLocation: jp.primaryLocation ?? jp.location ?? null,
    salaryFrom: jp.salaryFrom != null ? String(jp.salaryFrom) : null,
    salaryTo:   jp.salaryTo   != null ? String(jp.salaryTo)   : null,
    experienceMinYears: jp.experienceFrom != null ? String(jp.experienceFrom) : null,
    experienceMaxYears: jp.experienceTo   != null ? String(jp.experienceTo)   : null,
    numberOfOpenings: jp.noOfOpening ?? 1,
    maxSubmissions: null,
    expectedClosureDate: null,
    clientId: jp.clientId ? jp.clientId.toHexString() : null,
    clientName,
    createdAt: jp.createdAt ?? new Date(0),
    updatedAt: jp.updatedAt ?? new Date(0),
  };
}

// Match OL's `fetchAllJobs` visibility rule exactly so the picker shows the
// same jobs the recruiter sees on /job_postings:
//   • Recruiter / Account Manager / Lead → own assigned jobs (jobAssignMappings)
//   • Business Head                       → own + every AM reporting to them
async function resolveAssigneeIds(ctx: { mongoId: string; role: string }): Promise<ObjectId[]> {
  const selfId = new ObjectId(ctx.mongoId);
  if (ctx.role !== "UserBusinessHead") return [selfId];
  const ams = await collections.olUsers()
    .find<{ _id: ObjectId }>({ reportingTo: selfId, type: "UserAccountManager" })
    .project({ _id: 1 })
    .toArray();
  return [selfId, ...ams.map((a) => a._id)];
}

export async function demandsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // List demands assigned to the logged-in user. Same scope as the OL
  // /job_postings page. Response shape `{ demands: [...] }` matches the
  // existing frontend hook.
  app.get("/", async (req) => {
    const ctx = req.authUser!;

    // 1. Visibility scope: own (+ reporting AMs if BH).
    const assigneeIds = await resolveAssigneeIds(ctx);
    const jobIds = await collections.olJobAssignMappings()
      .distinct("jobPostingId", { userId: { $in: assigneeIds } });
    if (jobIds.length === 0) return { demands: [] };

    // 2. Load the job postings. No status filter — same as OL's listing.
    const jobs = await collections.olJobPostings()
      .find<OlJobPosting>({ _id: { $in: jobIds as ObjectId[] } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    // 3. Resolve client names in one query.
    const clientIds = [...new Set(jobs.map((j) => j.clientId).filter(Boolean) as ObjectId[])];
    const clients = clientIds.length
      ? await collections.olClients().find<OlClient>({ _id: { $in: clientIds } })
          .project({ _id: 1, companyName: 1 })
          .toArray()
      : [];
    const nameByClient = new Map(clients.map((c) => [c._id.toHexString(), c.companyName ?? null]));

    const demands = jobs.map((j) => adaptDemand(j, j.clientId ? nameByClient.get(j.clientId.toHexString()) ?? null : null));
    return { demands };
  });

  // Demand detail — same scoping (must be one of the recruiter's jobs).
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const ctx = req.authUser!;
    let jobOid: ObjectId;
    try { jobOid = new ObjectId(req.params.id); }
    catch { return reply.code(400).send({ error: "invalid_id" }); }

    // Ownership check — same scope as the listing.
    const assigneeIds = await resolveAssigneeIds(ctx);
    const mapping = await collections.olJobAssignMappings().findOne({
      userId: { $in: assigneeIds },
      jobPostingId: jobOid,
    });
    if (!mapping) return reply.code(404).send({ error: "demand_not_found_or_unassigned" });

    const job = await collections.olJobPostings().findOne<OlJobPosting>({ _id: jobOid });
    if (!job) return reply.code(404).send({ error: "demand_not_found" });

    let clientName: string | null = null;
    if (job.clientId) {
      const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
      clientName = c?.companyName ?? null;
    }

    return {
      demand: {
        ...adaptDemand(job, clientName),
        description: job.description ?? job.rawJdText ?? null,
        responsibilities: job.responsibilities ?? null,
      },
      clientName,
      skills: [],
      locations: [],
      assignments: [],
    };
  });

  // ---------- JD QUESTION BANK (cached + versioned, skill-wise) ----------
  // Demands are read-only OL jobPostings, so the bank lives in our own
  // `ia_question_banks` collection, keyed by demandId (the jobPosting _id hex).
  // v1 = base JD; each later version layers extra JD points the recruiter typed.
  interface BankVersion {
    version: number;
    addedJd: string;
    bank: unknown;
    generatedAt: string;
    jdFingerprint?: string;            // sha256 of baseJd + calibration block (absent on legacy versions)
    calibrationUid?: string | null;    // traceability only — staleness uses the fingerprint
    calibrationVersion?: number | null;
  }
  interface QuestionBankDoc { demandId: string; recruiterUid: string; assessmentNotes: string; versions: BankVersion[]; updatedAt: Date }

  // Resolve a jobPosting the caller is allowed to see, or send the error reply.
  async function loadOwnedJob(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<OlJobPosting | null> {
    const ctx = req.authUser!;
    let jobOid: ObjectId;
    try { jobOid = new ObjectId(id); } catch { reply.code(400).send({ error: "invalid_id" }); return null; }
    const assigneeIds = await resolveAssigneeIds(ctx);
    const mapping = await collections.olJobAssignMappings().findOne({ userId: { $in: assigneeIds }, jobPostingId: jobOid });
    if (!mapping) { reply.code(404).send({ error: "demand_not_found_or_unassigned" }); return null; }
    const job = await collections.olJobPostings().findOne<OlJobPosting>({ _id: jobOid });
    if (!job) { reply.code(404).send({ error: "demand_not_found" }); return null; }
    return job;
  }

  async function buildJdText(job: OlJobPosting): Promise<string> {
    let clientName: string | null = null;
    if (job.clientId) {
      const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
      clientName = c?.companyName ?? null;
    }
    const exp = [job.experienceFrom, job.experienceTo].filter((v) => v != null).join("–");
    return [
      `ROLE: ${job.title ?? "(untitled)"}${job.designation ? ` (${job.designation})` : ""}`,
      clientName ? `CLIENT: ${clientName}` : "",
      exp ? `EXPERIENCE REQUIRED: ${exp} years` : "",
      (job.primaryLocation ?? job.location) ? `LOCATION: ${job.primaryLocation ?? job.location}` : "",
      (job.description ?? job.rawJdText) ? `\nJOB DESCRIPTION:\n${job.description ?? job.rawJdText}` : "",
      job.responsibilities ? `\nRESPONSIBILITIES:\n${job.responsibilities}` : "",
    ].filter(Boolean).join("\n").trim();
  }

  // Latest calibration for a job (highest version wins). Absent doc = the
  // AM/BH never ran a calibration for this demand.
  async function loadLatestCalibration(jobOid: ObjectId): Promise<OlDemandCalibration | null> {
    return collections
      .olDemandCalibrations()
      .find<OlDemandCalibration>({ jobPostingId: jobOid })
      .sort({ version: -1 })
      .limit(1)
      .next();
  }

  // Render the calibration into the same block format the OL matching prompt
  // uses (backend/services/ai/prompts/matchScorePrompt.js) — the BANK_SYSTEM
  // prompt references this exact header. Empty string when there's nothing
  // meaningful to say.
  function buildCalibrationBlock(cal: OlDemandCalibration | null): string {
    const f = cal?.fields;
    if (!f) return "";
    const list = (items?: string[]) => (items ?? []).filter(Boolean).map((x) => `  • ${x}`).join("\n");
    const hasContent =
      (f.mustHaves ?? []).length || (f.goodToHave ?? []).length ||
      (f.caveats ?? []).length || (f.keyResponsibilities ?? []).length ||
      f.designation || f.experienceFrom || f.experienceTo || f.workMode || f.location;
    if (!hasContent) return "";
    return "\n\n=== CALIBRATION (refined requirement — overrides JD on conflict) ===\n" + [
      f.designation ? `Refined designation: ${f.designation}` : "",
      (f.experienceFrom || f.experienceTo)
        ? `Refined experience range: ${f.experienceFrom ?? 0}-${f.experienceTo ?? 0} years` : "",
      f.workMode ? `Refined work mode: ${f.workMode}` : "",
      f.location ? `Refined location: ${f.location}` : "",
      (f.mustHaves ?? []).length ? `MUST-HAVES (hard requirements):\n${list(f.mustHaves)}` : "",
      (f.caveats ?? []).length ? `CAVEATS (disqualifiers / watch-outs):\n${list(f.caveats)}` : "",
      (f.goodToHave ?? []).length ? `GOOD-TO-HAVE (bonus):\n${list(f.goodToHave)}` : "",
      (f.keyResponsibilities ?? []).length ? `KEY RESPONSIBILITIES:\n${list(f.keyResponsibilities)}` : "",
    ].filter(Boolean).join("\n");
  }

  // Fingerprint of the upstream inputs (JD + rendered calibration). Hashes the
  // rendered block rather than calibration uid:version because OL edits the
  // latest calibration version IN PLACE. `addedJd` is deliberately excluded.
  const fingerprintOf = (baseJd: string, calBlock: string) =>
    createHash("sha256").update(baseJd + "\u0000" + calBlock).digest("hex");

  // Return all stored question-bank versions for a demand.
  app.get<{ Params: { id: string } }>("/:id/question-bank", async (req, reply) => {
    const job = await loadOwnedJob(req, reply, req.params.id);
    if (!job) return;
    const doc = await collections.questionBanks().findOne<QuestionBankDoc>({ demandId: req.params.id });
    return { ok: true, versions: doc?.versions ?? [], assessmentNotes: doc?.assessmentNotes ?? "" };
  });

  // Generate a question-bank version.
  //  - `addedJd` text → a NEW version using the JD PLUS those extra points.
  //  - blank `addedJd` AND versions exist AND the JD + calibration are
  //    unchanged since the last version → return the existing ones (cached).
  //  - blank but the JD or calibration CHANGED (fingerprint mismatch) →
  //    regenerate a fresh version from the latest inputs.
  //  - blank and no bank yet → generate v1 from the JD (+ calibration).
  app.post<{ Params: { id: string }; Body: { addedJd?: string } }>("/:id/question-bank", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const job = await loadOwnedJob(req, reply, req.params.id);
    if (!job) return;
    const ctx = req.authUser!;
    const addedJd = (req.body?.addedJd ?? "").trim();

    const existing = await collections.questionBanks().findOne<QuestionBankDoc>({ demandId: req.params.id });
    const versions: BankVersion[] = existing?.versions ?? [];

    const baseJd = await buildJdText(job);
    if (!baseJd) return reply.code(400).send({ ok: false, error: "demand_has_no_jd" });
    const calibration = await loadLatestCalibration(job._id);
    const calBlock = buildCalibrationBlock(calibration);
    const fingerprint = fingerprintOf(baseJd, calBlock);

    if (!addedJd && versions.length > 0) {
      // Legacy versions have no fingerprint → treated as stale (regenerate
      // once, which stamps it), so pre-existing banks pick up JD changes too.
      const last = versions[versions.length - 1];
      if (last.jdFingerprint === fingerprint) {
        return { ok: true, created: false, versions, assessmentNotes: existing?.assessmentNotes ?? "" };
      }
    }

    const effectiveJd = addedJd
      ? `${baseJd}${calBlock}\n\nADDITIONAL JD POINTS (added by the recruiter — weight these too):\n${addedJd}`
      : `${baseJd}${calBlock}`;

    const bank = await generateJdQuestionBank(effectiveJd, existing?.assessmentNotes ?? "", {
      orgId: ctx.uid,
      operation: "plan",
    });
    const generatedAt = new Date();
    const nextVersion = (versions[versions.length - 1]?.version ?? 0) + 1;
    const newVersions: BankVersion[] = [
      ...versions,
      {
        version: nextVersion,
        addedJd,
        bank,
        generatedAt: generatedAt.toISOString(),
        jdFingerprint: fingerprint,
        calibrationUid: calibration?.uid ?? null,
        calibrationVersion: calibration?.version ?? null,
      },
    ];
    await collections.questionBanks().updateOne(
      { demandId: req.params.id },
      {
        $set: { versions: newVersions, recruiterUid: ctx.uid, updatedAt: generatedAt },
        $setOnInsert: { demandId: req.params.id, assessmentNotes: "" },
      },
      { upsert: true },
    );

    return { ok: true, created: true, version: nextVersion, versions: newVersions, assessmentNotes: existing?.assessmentNotes ?? "" };
  });

  // Download a question-bank version as a polished PDF (?version=N, default latest).
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>("/:id/question-bank/download", async (req, reply) => {
    const job = await loadOwnedJob(req, reply, req.params.id);
    if (!job) return;
    const doc = await collections.questionBanks().findOne<QuestionBankDoc>({ demandId: req.params.id });
    const versions = doc?.versions ?? [];
    if (versions.length === 0) return reply.code(409).send({ error: "no_question_bank" });
    const wanted = Number(req.query.version);
    const chosen = versions.find((v) => v.version === wanted) ?? versions[versions.length - 1];

    let client: string | null = null;
    if (job.clientId) {
      const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
      client = c?.companyName ?? null;
    }

    const pdf = await buildQuestionBankReport(chosen.bank as QuestionBank, {
      title: job.title ?? null,
      client,
      version: chosen.version,
      addedJd: chosen.addedJd,
    });
    const slug = (job.title || "question-bank").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="question-bank-${slug || "jd"}-v${chosen.version}.pdf"`)
      .send(Buffer.from(pdf));
  });

  // The legacy multi-tenant impl exposed prospects / submissions / parse-jd /
  // create. Those are owned by the OfferLetter app — we no longer expose them
  // here. Any consumer that hit them needs to talk to OL directly.
}
