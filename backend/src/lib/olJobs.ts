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

/** The job posting, or null when it doesn't exist OR the caller isn't assigned. */
export async function loadOlJob(
  jobId: string,
  ctx: { mongoId: string; role: string },
): Promise<OlJobPosting | null> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(jobId);
  } catch {
    return null;
  }
  const assigneeIds = await resolveAssigneeIds(ctx);
  const mapping = await collections.olJobAssignMappings().findOne({
    userId: { $in: assigneeIds },
    jobPostingId: oid,
  });
  if (!mapping) return null;
  return (await collections.olJobPostings().findOne<OlJobPosting>({ _id: oid })) ?? null;
}

/** The inline `demandSnapshot` written onto an interview document. */
export async function buildDemandSnapshot(job: OlJobPosting): Promise<Record<string, unknown>> {
  let clientName: string | null = null;
  if (job.clientId) {
    const c = await collections.olClients().findOne<OlClient>({ _id: job.clientId });
    clientName = c?.companyName ?? null;
  }
  return {
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
