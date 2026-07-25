// Shared OfferLetter job-posting access helpers.
//
// `resolveAssigneeIds` + `loadOlJob` already exist, duplicated verbatim, in
// routes/calls.ts and routes/demands.ts. Rather than refactor two working
// files, this module is a third home that ONLY the new telephony routes use —
// so nothing that currently works changes behaviour. When someone is next in
// calls.ts / demands.ts anyway, point them here and delete the copies.
import { ObjectId } from "mongodb";
import { collections } from "../mongo.js";

export interface OlJobPosting {
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

interface OlClient {
  companyName?: string;
}

/**
 * Visibility scope, matching OL's own /job_postings rule:
 *   • Recruiter / Account Manager / Lead → their own assigned jobs
 *   • Business Head                      → own + every AM reporting to them
 */
export async function resolveAssigneeIds(ctx: { mongoId: string; role: string }): Promise<ObjectId[]> {
  const selfId = new ObjectId(ctx.mongoId);
  if (ctx.role !== "UserBusinessHead") return [selfId];
  const ams = await collections
    .olUsers()
    .find<{ _id: ObjectId }>({ reportingTo: selfId, type: "UserAccountManager" })
    .project({ _id: 1 })
    .toArray();
  return [selfId, ...ams.map((a) => a._id)];
}

/**
 * The job posting, or null when it doesn't exist OR the caller isn't assigned.
 *
 * `jobUid` is OL's business **uid** (a 16-char nanoid), NOT the Mongo `_id`.
 * We resolve the posting by uid, then verify assignment via the mapping using
 * the posting's real `_id` (jobAssignMappings.jobPostingId is still an ObjectId).
 */
export async function loadOlJob(
  jobUid: string,
  ctx: { mongoId: string; role: string },
): Promise<OlJobPosting | null> {
  const job = await collections.olJobPostings().findOne<OlJobPosting>({ uid: jobUid });
  if (!job) return null;
  // Ownership scope must match OL's /matching/jobs (the list the demand came
  // from): the recruiter CREATED it OR is assigned to it. Assignment-only would
  // reject a demand the recruiter created but never self-assigned.
  const selfId = new ObjectId(ctx.mongoId);
  if (job.createdById && job.createdById.equals(selfId)) return job;
  const assigneeIds = await resolveAssigneeIds(ctx);
  const mapping = await collections.olJobAssignMappings().findOne({
    userId: { $in: assigneeIds },
    jobPostingId: job._id,
  });
  return mapping ? job : null;
}

/** The inline `demandSnapshot` written onto an interview document. */
export async function buildDemandSnapshot(job: OlJobPosting): Promise<Record<string, unknown>> {
  let clientName: string | null = null;
  if (job.clientId) {
    const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
    clientName = c?.companyName ?? null;
  }
  return {
    id: job.uid,          // uid is the canonical demand identifier everywhere
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
