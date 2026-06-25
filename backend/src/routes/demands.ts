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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { collections } from "../mongo.js";
import { env } from "../env.js";
import { generateJdQuestionBank } from "./assist.js";

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
  interface BankVersion { version: number; addedJd: string; bank: unknown; generatedAt: string }
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

  // Return all stored question-bank versions for a demand.
  app.get<{ Params: { id: string } }>("/:id/question-bank", async (req, reply) => {
    const job = await loadOwnedJob(req, reply, req.params.id);
    if (!job) return;
    const doc = await collections.questionBanks().findOne<QuestionBankDoc>({ demandId: req.params.id });
    return { ok: true, versions: doc?.versions ?? [], assessmentNotes: doc?.assessmentNotes ?? "" };
  });

  // Generate a question-bank version.
  //  - `addedJd` text → a NEW version using the JD PLUS those extra points.
  //  - blank `addedJd` AND versions already exist → return the existing ones
  //    unchanged (load the old JD only — no regeneration).
  //  - blank and no bank yet → generate v1 from the JD.
  app.post<{ Params: { id: string }; Body: { addedJd?: string } }>("/:id/question-bank", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const job = await loadOwnedJob(req, reply, req.params.id);
    if (!job) return;
    const ctx = req.authUser!;
    const addedJd = (req.body?.addedJd ?? "").trim();

    const existing = await collections.questionBanks().findOne<QuestionBankDoc>({ demandId: req.params.id });
    const versions: BankVersion[] = existing?.versions ?? [];

    if (!addedJd && versions.length > 0) {
      return { ok: true, created: false, versions, assessmentNotes: existing?.assessmentNotes ?? "" };
    }

    const baseJd = await buildJdText(job);
    if (!baseJd) return reply.code(400).send({ ok: false, error: "demand_has_no_jd" });
    const effectiveJd = addedJd
      ? `${baseJd}\n\nADDITIONAL JD POINTS (added by the recruiter — weight these too):\n${addedJd}`
      : baseJd;

    const bank = await generateJdQuestionBank(effectiveJd, existing?.assessmentNotes ?? "", {
      orgId: ctx.uid,
      operation: "plan",
    });
    const generatedAt = new Date();
    const nextVersion = (versions[versions.length - 1]?.version ?? 0) + 1;
    const newVersions: BankVersion[] = [
      ...versions,
      { version: nextVersion, addedJd, bank, generatedAt: generatedAt.toISOString() },
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

  // The legacy multi-tenant impl exposed prospects / submissions / parse-jd /
  // create. Those are owned by the OfferLetter app — we no longer expose them
  // here. Any consumer that hit them needs to talk to OL directly.
}
