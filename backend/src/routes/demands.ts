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

import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { collections } from "../mongo.js";

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

  // The legacy multi-tenant impl exposed prospects / submissions / parse-jd /
  // create. Those are owned by the OfferLetter app — we no longer expose them
  // here. Any consumer that hit them needs to talk to OL directly.
}
