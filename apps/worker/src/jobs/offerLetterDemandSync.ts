// Demand-sync worker. Pulls demands assigned to recruiters in our local
// Postgres from the J2W Offer Letter MySQL and UPSERTs them into our
// `clients` / `demands` / `demand_assignments` tables, keyed on
// `external_offer_letter_*_id`.
//
// Per-org loop: for every active recruiter (role_id=3 in OL semantics, our
// "recruiter" role + active membership), we look up their OL user_id via
// email match, then call getDemandsForRecruiter(olUserId) for the full
// assignment list and getRecruiterActivityByDemand(olUserId) for the live
// pipeline signal. The activity counts (active_candidates_count +
// last_recruiter_activity_at) are written onto each demand_assignments
// row so the recruiter home view can sort by where they have actual work.
//
// See docs/demand-recruiter-attribution.md for the canonical filter
// strategy and why we don't apply a recency cap on the assignment list.
//
// Heartbeat is written on every run so the UI can detect stale data.
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  clients,
  db,
  demandAssignments,
  demandLocations,
  demandSkills,
  demands,
  locations,
  memberships,
  offerLetterSyncHeartbeats,
  organizations,
  skills,
  users,
} from "@j2w/db";
import {
  findRecruiterUserByEmail,
  getDemandsForRecruiter,
  getLocationsForDemands,
  getRecruiterActivityByDemand,
  getSkillsForDemands,
  isOfferLetterConfigured,
  type OlDemandLocationRow,
  type OlDemandRow,
  type OlDemandSkillRow,
} from "@j2w/offer-letter-db";
import {
  OFFER_LETTER_DEMAND_SYNC_QUEUE,
  type OfferLetterDemandSyncJob,
} from "@j2w/ingest-shared";

interface SyncResult {
  rowsUpserted: number;
  recruitersScanned: number;
  recruitersMatchedToOl: number;
  durationMs: number;
}

interface ActivitySignal {
  activeCandidatesCount: number;
  lastRecruiterActivityAt: Date | null;
}

// Map MySQL job_postings.status int to our DEMAND_STATUSES enum.
function mapDemandStatus(olStatus: number): "active" | "draft" | "closed" | "on_hold" {
  switch (olStatus) {
    case 1:
      return "active";
    case 2:
      return "closed";
    case 3:
      return "on_hold";
    default:
      return "draft";
  }
}

function parseNum(s: string | null): string | null {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

export async function processDemandSync(
  data: OfferLetterDemandSyncJob,
  log: Logger,
): Promise<SyncResult> {
  if (!isOfferLetterConfigured()) {
    throw new Error("offer_letter_not_configured");
  }
  const t0 = Date.now();
  const { orgId } = data;

  // 1) Find every active recruiter in this org.
  const localRecruiters = await db
    .select({
      userId: users.id,
      email: users.email,
    })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
    .where(and(eq(memberships.role, "recruiter"), eq(memberships.status, "active")));

  let rowsUpserted = 0;
  let matched = 0;
  const lookups = new LocalLookups();

  for (const rec of localRecruiters) {
    if (!rec.email) continue;
    const olUser = await findRecruiterUserByEmail(rec.email);
    if (!olUser) continue;
    matched += 1;

    let olDemands: OlDemandRow[];
    try {
      olDemands = await getDemandsForRecruiter(olUser.id);
    } catch (err) {
      log.warn({ recruiterEmail: rec.email, olUserId: olUser.id, err }, "demand fetch failed");
      continue;
    }

    // Pull the activity map for this recruiter once. Keyed by external
    // job_posting_id so we can match it to each demand row below. If the
    // call fails we still upsert demands — just with zero counts.
    const activityByDemand = new Map<number, ActivitySignal>();
    try {
      const activityRows = await getRecruiterActivityByDemand(olUser.id);
      for (const row of activityRows) {
        activityByDemand.set(row.job_posting_id, {
          activeCandidatesCount: Number(row.active_candidates ?? 0),
          lastRecruiterActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
        });
      }
    } catch (err) {
      log.warn(
        { recruiterEmail: rec.email, olUserId: olUser.id, err },
        "activity fetch failed; upserting with zero counts",
      );
    }

    // Batch-fetch skills and locations for this recruiter's whole demand
    // list. One round-trip each beats per-demand fan-out (~1.8 skills /
    // ~5 locations per posting, ~6400 postings worst case for a senior
    // recruiter).
    const externalIds = olDemands.map((d) => d.demand_id);
    const skillsByDemand = await fetchSkillsByDemand(externalIds, log);
    const locationsByDemand = await fetchLocationsByDemand(externalIds, log);

    for (const d of olDemands) {
      try {
        const localClientId = await upsertClient(orgId, d.client_id, d.customer);
        const olSkills = skillsByDemand.get(d.demand_id) ?? [];
        const olLocations = locationsByDemand.get(d.demand_id) ?? [];
        const { localDemandId } = await upsertDemand(
          orgId,
          localClientId,
          d,
          olSkills,
          olLocations,
          lookups,
        );
        const signal = activityByDemand.get(d.demand_id) ?? {
          activeCandidatesCount: 0,
          lastRecruiterActivityAt: null,
        };
        await upsertAssignment(localDemandId, rec.userId, signal);
        rowsUpserted += 1;
      } catch (err) {
        log.warn(
          { demandId: d.demand_id, clientId: d.client_id, err },
          "demand upsert failed; continuing",
        );
      }
    }
  }

  const durationMs = Date.now() - t0;
  await writeHeartbeat(orgId, OFFER_LETTER_DEMAND_SYNC_QUEUE, rowsUpserted, durationMs, null);

  return { rowsUpserted, recruitersScanned: localRecruiters.length, recruitersMatchedToOl: matched, durationMs };
}

async function upsertClient(
  orgId: string,
  externalClientId: number,
  customerName: string | null,
): Promise<string> {
  // Try to find by external id first.
  const existing = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.orgId, orgId), eq(clients.externalOfferLetterClientId, externalClientId)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(clients)
    .values({
      orgId,
      companyName: customerName ?? `OL Client #${externalClientId}`,
      externalOfferLetterClientId: externalClientId,
      status: "active",
    })
    .returning({ id: clients.id });
  return row.id;
}

async function upsertDemand(
  orgId: string,
  localClientId: string,
  d: OlDemandRow,
  olSkills: OlDemandSkillRow[],
  olLocations: OlDemandLocationRow[],
  lookups: LocalLookups,
): Promise<{ localDemandId: string; changed: boolean }> {
  const status = mapDemandStatus(d.demand_status);
  const isVip = !!d.is_vip && /^(yes|true|1|y)$/i.test(d.is_vip.trim());

  const skillIds: string[] = [];
  for (const s of olSkills) {
    if (!s.skill_name) continue;
    const id = await lookups.skillId(s.skill_name);
    if (id) skillIds.push(id);
  }
  const locationIds: string[] = [];
  for (const l of olLocations) {
    const id = await lookups.locationId(l.city, l.state);
    if (id) locationIds.push(id);
  }

  const probingDetails = buildProbingDetails(d);
  const taxonomy = buildTaxonomy(d);

  const payload = {
    clientId: localClientId,
    title: d.title ?? "(untitled)",
    designation: d.designation ?? null,
    description: d.description ?? null,
    responsibilities: d.responsibilities ?? null,
    experienceMinYears: parseNum(d.min_exp),
    experienceMaxYears: parseNum(d.max_exp),
    salaryFrom: parseNum(d.salary_from),
    salaryTo: parseNum(d.salary_to),
    numberOfOpenings: d.no_of_opening ?? 1,
    maxSubmissions: d.submission_cap ?? null,
    primaryLocation: d.primary_location ?? null,
    status,
    isVip,
    clientInternalTicketId: d.client_internal_ticket ?? null,
    requestedBy: d.requested_by ?? null,
    requestedDate: d.requested_date ?? null,
    expectedClosureDate: d.expected_client_closure ?? null,
    groupName: d.group ?? null,
    subGroupName: d.sub_group ?? null,
    poOpportunityMrr: parseNum(d.po_opportunity_mrr),
    potentialGm: parseNum(d.potential_gm),
    probingDetails,
    taxonomy,
    skills: [...skillIds].sort(),
    locations: [...locationIds].sort(),
  };
  const hash = hashPayload(payload);

  const existing = await db
    .select({
      id: demands.id,
      externalDataHash: demands.externalDataHash,
      metadata: demands.metadata,
    })
    .from(demands)
    .where(and(eq(demands.orgId, orgId), eq(demands.externalOfferLetterDemandId, d.demand_id)))
    .limit(1);

  if (existing[0]) {
    if (existing[0].externalDataHash === hash) {
      return { localDemandId: existing[0].id, changed: false };
    }
    // Refresh bridges first; if it throws, leave the hash stale so the
    // next sync retries.
    await refreshDemandBridges(existing[0].id, skillIds, locationIds);
    const newMetadata = { ...(existing[0].metadata ?? {}), taxonomy };
    await db
      .update(demands)
      .set({
        clientId: payload.clientId,
        title: payload.title,
        designation: payload.designation,
        description: payload.description,
        responsibilities: payload.responsibilities,
        experienceMinYears: payload.experienceMinYears,
        experienceMaxYears: payload.experienceMaxYears,
        salaryFrom: payload.salaryFrom,
        salaryTo: payload.salaryTo,
        numberOfOpenings: payload.numberOfOpenings,
        maxSubmissions: payload.maxSubmissions,
        primaryLocation: payload.primaryLocation,
        status: payload.status,
        isVip: payload.isVip,
        clientInternalTicketId: payload.clientInternalTicketId,
        requestedBy: payload.requestedBy,
        requestedDate: payload.requestedDate,
        expectedClosureDate: payload.expectedClosureDate,
        groupName: payload.groupName,
        subGroupName: payload.subGroupName,
        poOpportunityMrr: payload.poOpportunityMrr,
        potentialGm: payload.potentialGm,
        probingDetails: probingDetails ?? undefined,
        metadata: newMetadata,
        externalDataHash: hash,
        updatedAt: sql`now()`,
      })
      .where(eq(demands.id, existing[0].id));
    return { localDemandId: existing[0].id, changed: true };
  }

  // INSERT path: anchor createdAt/updatedAt to the OL row's true creation
  // time so the list view's "Created N ago" reflects MySQL truth, not the
  // first time our worker observed the row.
  const olCreatedAt = parseOlTimestamp(d.created_at);
  const [row] = await db
    .insert(demands)
    .values({
      orgId,
      clientId: payload.clientId,
      title: payload.title,
      designation: payload.designation,
      description: payload.description,
      responsibilities: payload.responsibilities,
      experienceMinYears: payload.experienceMinYears,
      experienceMaxYears: payload.experienceMaxYears,
      salaryFrom: payload.salaryFrom,
      salaryTo: payload.salaryTo,
      numberOfOpenings: payload.numberOfOpenings,
      maxSubmissions: payload.maxSubmissions,
      primaryLocation: payload.primaryLocation,
      status: payload.status,
      isVip: payload.isVip,
      clientInternalTicketId: payload.clientInternalTicketId,
      requestedBy: payload.requestedBy,
      requestedDate: payload.requestedDate,
      expectedClosureDate: payload.expectedClosureDate,
      groupName: payload.groupName,
      subGroupName: payload.subGroupName,
      poOpportunityMrr: payload.poOpportunityMrr,
      potentialGm: payload.potentialGm,
      probingDetails: probingDetails ?? undefined,
      metadata: taxonomy ? { taxonomy } : {},
      externalOfferLetterDemandId: d.demand_id,
      externalDataHash: hash,
      ...(olCreatedAt ? { createdAt: olCreatedAt, updatedAt: olCreatedAt } : {}),
    })
    .returning({ id: demands.id });
  await refreshDemandBridges(row.id, skillIds, locationIds);
  return { localDemandId: row.id, changed: true };
}

async function refreshDemandBridges(
  localDemandId: string,
  skillIds: string[],
  locationIds: string[],
): Promise<void> {
  // Replace only the rows tagged source='offer_letter'; manual entries
  // added by recruiters survive.
  await db
    .delete(demandSkills)
    .where(
      and(eq(demandSkills.demandId, localDemandId), eq(demandSkills.source, "offer_letter")),
    );
  if (skillIds.length > 0) {
    await db
      .insert(demandSkills)
      .values(
        skillIds.map((skillId) => ({
          demandId: localDemandId,
          skillId,
          source: "offer_letter",
        })),
      )
      .onConflictDoNothing();
  }
  await db
    .delete(demandLocations)
    .where(
      and(
        eq(demandLocations.demandId, localDemandId),
        eq(demandLocations.source, "offer_letter"),
      ),
    );
  if (locationIds.length > 0) {
    await db
      .insert(demandLocations)
      .values(
        locationIds.map((locationId) => ({
          demandId: localDemandId,
          locationId,
          source: "offer_letter",
        })),
      )
      .onConflictDoNothing();
  }
}

async function fetchSkillsByDemand(
  externalDemandIds: number[],
  log: Logger,
): Promise<Map<number, OlDemandSkillRow[]>> {
  const map = new Map<number, OlDemandSkillRow[]>();
  if (externalDemandIds.length === 0) return map;
  try {
    const rows = await getSkillsForDemands(externalDemandIds);
    for (const row of rows) {
      const list = map.get(row.job_posting_id);
      if (list) list.push(row);
      else map.set(row.job_posting_id, [row]);
    }
  } catch (err) {
    log.warn({ err, count: externalDemandIds.length }, "skill fetch failed; treating as empty");
  }
  return map;
}

async function fetchLocationsByDemand(
  externalDemandIds: number[],
  log: Logger,
): Promise<Map<number, OlDemandLocationRow[]>> {
  const map = new Map<number, OlDemandLocationRow[]>();
  if (externalDemandIds.length === 0) return map;
  try {
    const rows = await getLocationsForDemands(externalDemandIds);
    for (const row of rows) {
      const list = map.get(row.job_posting_id);
      if (list) list.push(row);
      else map.set(row.job_posting_id, [row]);
    }
  } catch (err) {
    log.warn({ err, count: externalDemandIds.length }, "location fetch failed; treating as empty");
  }
  return map;
}

function buildProbingDetails(d: OlDemandRow): Record<string, string> | null {
  const obj: Record<string, string> = {};
  if (d.work_mode) obj.workMode = d.work_mode;
  if (d.candidate_role) obj.candidateRole = d.candidate_role;
  if (d.interview_type) obj.interviewType = d.interview_type;
  if (d.notice_period) obj.noticePeriod = d.notice_period;
  if (d.feedback_eta) obj.feedbackEta = d.feedback_eta;
  if (d.urgency_eta) obj.urgency = d.urgency_eta;
  if (d.reporting_manager_location) obj.reportingManagerLocation = d.reporting_manager_location;
  return Object.keys(obj).length > 0 ? obj : null;
}

function buildTaxonomy(d: OlDemandRow): Record<string, string> | null {
  const obj: Record<string, string> = {};
  if (d.industry) obj.industry = d.industry;
  if (d.functional_area) obj.functionalArea = d.functional_area;
  if (d.role_category) obj.roleCategory = d.role_category;
  if (d.job_role) obj.jobRole = d.job_role;
  return Object.keys(obj).length > 0 ? obj : null;
}

// mysql2 returns DATETIME as a tz-naive string (pool config sets
// dateStrings:true, timezone:+05:30). new Date("2024-08-12 14:32:11") is
// host-tz-dependent — explicitly anchor to IST so the worker behaves the
// same on a UTC container and on a developer's local box.
function parseOlTimestamp(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.replace(" ", "T") + "+05:30";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Stable canonical JSON: keys sorted at every level so identical content
// always hashes the same regardless of property insertion order.
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function hashPayload(payload: unknown): string {
  return createHash("sha1").update(canonicalJson(payload)).digest("hex");
}

// In-memory find-or-insert cache for skills + locations, scoped to a
// single sync run. Avoids re-querying for the ~5K unique skill names that
// repeat across thousands of demands.
class LocalLookups {
  private skillIdByLowerName = new Map<string, string>();
  private locationIdByKey = new Map<string, string>();

  async skillId(rawName: string): Promise<string | null> {
    const norm = rawName.trim();
    if (!norm) return null;
    const cacheKey = norm.toLowerCase();
    const cached = this.skillIdByLowerName.get(cacheKey);
    if (cached) return cached;

    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.name, norm))
      .limit(1);
    if (existing[0]) {
      this.skillIdByLowerName.set(cacheKey, existing[0].id);
      return existing[0].id;
    }
    const inserted = await db
      .insert(skills)
      .values({ name: norm })
      .onConflictDoNothing()
      .returning({ id: skills.id });
    if (inserted[0]) {
      this.skillIdByLowerName.set(cacheKey, inserted[0].id);
      return inserted[0].id;
    }
    // Conflict: another transaction inserted the same name. Re-read.
    const reread = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.name, norm))
      .limit(1);
    if (!reread[0]) return null;
    this.skillIdByLowerName.set(cacheKey, reread[0].id);
    return reread[0].id;
  }

  async locationId(rawCity: string | null, rawState: string | null): Promise<string | null> {
    if (!rawCity) return null;
    const city = rawCity.trim();
    if (!city) return null;
    const state = (rawState ?? "").trim() || null;
    const cacheKey = `${city.toLowerCase()}|${(state ?? "").toLowerCase()}`;
    const cached = this.locationIdByKey.get(cacheKey);
    if (cached) return cached;

    const where = state
      ? and(
          eq(locations.city, city),
          eq(locations.state, state),
          eq(locations.country, "India"),
        )
      : and(
          eq(locations.city, city),
          isNull(locations.state),
          eq(locations.country, "India"),
        );
    const existing = await db
      .select({ id: locations.id })
      .from(locations)
      .where(where!)
      .limit(1);
    if (existing[0]) {
      this.locationIdByKey.set(cacheKey, existing[0].id);
      return existing[0].id;
    }
    const inserted = await db
      .insert(locations)
      .values({ city, state, country: "India" })
      .onConflictDoNothing()
      .returning({ id: locations.id });
    if (inserted[0]) {
      this.locationIdByKey.set(cacheKey, inserted[0].id);
      return inserted[0].id;
    }
    const reread = await db
      .select({ id: locations.id })
      .from(locations)
      .where(where!)
      .limit(1);
    if (!reread[0]) return null;
    this.locationIdByKey.set(cacheKey, reread[0].id);
    return reread[0].id;
  }
}

async function upsertAssignment(
  localDemandId: string,
  recruiterId: string,
  signal: ActivitySignal,
): Promise<void> {
  // demand_assignments PK is (demandId, recruiterId, assignedAt). At most
  // one active row per (demand, recruiter) — if it exists, refresh the
  // activity columns; if not, insert. Activity counts go stale fast (a
  // recruiter who stops sourcing should drop to 0), so we always UPDATE
  // when the row exists rather than skipping.
  const existing = await db
    .select({ assignedAt: demandAssignments.assignedAt })
    .from(demandAssignments)
    .where(
      and(
        eq(demandAssignments.demandId, localDemandId),
        eq(demandAssignments.recruiterId, recruiterId),
        eq(demandAssignments.status, "active"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(demandAssignments)
      .set({
        activeCandidatesCount: signal.activeCandidatesCount,
        lastRecruiterActivityAt: signal.lastRecruiterActivityAt,
      })
      .where(
        and(
          eq(demandAssignments.demandId, localDemandId),
          eq(demandAssignments.recruiterId, recruiterId),
          eq(demandAssignments.assignedAt, existing[0].assignedAt),
        ),
      );
    return;
  }

  await db.insert(demandAssignments).values({
    demandId: localDemandId,
    recruiterId,
    status: "active",
    activeCandidatesCount: signal.activeCandidatesCount,
    lastRecruiterActivityAt: signal.lastRecruiterActivityAt,
  });
}

export async function writeHeartbeat(
  orgId: string,
  queueName: string,
  rowsUpserted: number,
  durationMs: number,
  errMessage: string | null,
): Promise<void> {
  const existing = await db
    .select({ id: offerLetterSyncHeartbeats.id })
    .from(offerLetterSyncHeartbeats)
    .where(
      and(
        eq(offerLetterSyncHeartbeats.orgId, orgId),
        eq(offerLetterSyncHeartbeats.queueName, queueName),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(offerLetterSyncHeartbeats)
      .set({
        lastRunAt: sql`now()`,
        rowsUpserted,
        durationMs,
        lastError: errMessage,
      })
      .where(eq(offerLetterSyncHeartbeats.id, existing[0].id));
  } else {
    await db
      .insert(offerLetterSyncHeartbeats)
      .values({ orgId, queueName, rowsUpserted, durationMs, lastError: errMessage });
  }
}

// Bootstrap helper for the worker: enqueue a sync job for every org that
// has any active recruiter membership. Called by the scheduler.
export async function listOrgsWithRecruiters(): Promise<string[]> {
  const rows = await db
    .select({ orgId: organizations.id })
    .from(organizations)
    .innerJoin(memberships, eq(memberships.orgId, organizations.id))
    .where(and(eq(memberships.role, "recruiter"), eq(memberships.status, "active")))
    .groupBy(organizations.id);
  return rows.map((r) => r.orgId);
}
