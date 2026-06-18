// Recruiters — enterprise manager surface.
//
// A delivery lead / account manager / business head opens /recruiters to rank
// recruiters by the KPI that matters this week (throughput, conversion, SLA
// breach, goal attainment, capacity load), spot over-allocated / under-performing
// recruiters, set quarterly goals, cap capacity, rebalance load by reassigning a
// demand, nudge a recruiter, save configurable+fairness-guarded leaderboards, and
// export the leaderboard. Every read is org-scoped; every mutation is
// requirePermission-gated, Zod-validated, idempotent where it creates/sends, and
// writes an append-only recruiter_admin_events row in the SAME transaction.
//
// All KPIs are LIVE aggregates off submissions / call_sessions / demand_assignments
// — never denormalized. The new tables here hold only manager-authored config +
// the audit trail.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import {
  callSessions,
  candidates,
  db,
  demandAssignments,
  demands,
  memberships,
  prospects,
  recruiterAdminEvents,
  recruiterCapacity,
  recruiterGoals,
  recruiterLeaderboards,
  recruiterNudges,
  STAGE_METADATA,
  submissions,
  type SubmissionStage,
  users,
  type RecruiterAdminAction,
} from "@j2w/db";
import { draftNudgeMessage, isNudgeDraftConfigured } from "../recruiters/nudgeDraft.js";

const MANAGER_ROLES = [
  "recruiter",
  "delivery_lead",
  "account_manager",
  "business_head",
] as const;

// Open demand statuses count toward capacity load. draft+active per the
// project's "recruiters source on drafts too" rule.
const OPEN_DEMAND_STATUSES: Array<"draft" | "active" | "on_hold"> = ["draft", "active", "on_hold"];

type ManagerRole = "recruiter" | "delivery_lead" | "account_manager" | "business_head";
const ALL_MANAGER_ROLES: ManagerRole[] = [
  "recruiter",
  "delivery_lead",
  "account_manager",
  "business_head",
];

// SLA threshold (days) in current stage per stage bucket: a submission whose
// time-in-current-stage exceeds the bucket threshold (and isn't terminal) is an
// SLA breach. Demands carry no sla_days column, so we use these per-bucket
// defaults — mirrored in the slaCase SQL in loadKpis().
//   pre_submit 3 · client_pipeline 5 · interview 7 · offer 4 · post_offer 14

// ----- stage bucket sets (computed once in TS, passed as inArray) -----
const STAGES = Object.keys(STAGE_METADATA) as SubmissionStage[];
const stagesInBucket = (bucket: string): SubmissionStage[] =>
  STAGES.filter((s) => STAGE_METADATA[s].bucket === bucket);

// client_submit = reached client pipeline OR interview/offer/post-offer (i.e.
// progressOrder >= client_submit's order, excluding terminal-rejects which have
// higher orders but bucket 'terminal').
const CLIENT_SUBMIT_STAGES = STAGES.filter(
  (s) =>
    STAGE_METADATA[s].progressOrder >= STAGE_METADATA.client_submit.progressOrder &&
    STAGE_METADATA[s].bucket !== "terminal" &&
    STAGE_METADATA[s].bucket !== "pre_submit",
);
const SELECT_STAGES: SubmissionStage[] = [
  "l1_select",
  "l2_select",
  "l3_select",
  "final_select",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "onboarded",
];
const OFFER_STAGES: SubmissionStage[] = [
  "offer_released",
  "offer_accepted",
  "onboarded",
];
const JOIN_STAGES: SubmissionStage[] = ["onboarded"];
const NON_TERMINAL_STAGES = STAGES.filter((s) => !STAGE_METADATA[s].isTerminal);

function windowStart(window: "7d" | "30d" | "90d" | "qtd"): Date {
  const now = new Date();
  if (window === "qtd") {
    const q = Math.floor(now.getUTCMonth() / 3);
    return new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  }
  const days = window === "7d" ? 7 : window === "90d" ? 90 : 30;
  return new Date(now.getTime() - days * 86400_000);
}

// ----- keyset cursor (base64 of { v: sortVal, id }) -----
interface Cursor {
  v: number | string;
  id: string;
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s: string): Cursor | null {
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (obj && (typeof obj.v === "number" || typeof obj.v === "string") && typeof obj.id === "string") {
      return obj as Cursor;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ----- audit helper: append-only event INSIDE the mutation transaction -----
async function writeRecruiterAdminEvent(
  tx: typeof db,
  e: {
    orgId: string;
    recruiterUserId: string | null;
    actorUserId: string | null;
    action: RecruiterAdminAction;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(recruiterAdminEvents).values({
    orgId: e.orgId,
    recruiterUserId: e.recruiterUserId,
    actorUserId: e.actorUserId,
    action: e.action,
    before: e.before ?? null,
    after: e.after ?? null,
  });
}

// Resolve a recruiter that belongs to caller's org. Returns null (→ 404) if the
// id isn't a member of this org. Closes the cross-tenant hole.
async function resolveRecruiter(orgId: string, id: string) {
  const [m] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: memberships.role,
      status: memberships.status,
      joinedAt: memberships.joinedAt,
      lastActiveAt: users.lastActiveAt,
      reportingToUserId: memberships.reportingToUserId,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.id, id), eq(memberships.orgId, orgId)))
    .limit(1);
  return m ?? null;
}

// ----- grouped KPI loader (no N+1): one query per metric keyed by recruiter -----
async function loadKpis(orgId: string, ids: string[], window: "7d" | "30d" | "90d" | "qtd") {
  if (ids.length === 0) return new Map<string, RowKpis>();
  const since = windowStart(window);

  // Submission funnel counts, windowed by created_at.
  const subRows = await db
    .select({
      userId: submissions.submittedByUserId,
      submissions: sql<number>`count(*)::int`,
      clientSubmits: sql<number>`sum(case when ${inArray(submissions.currentStage, CLIENT_SUBMIT_STAGES)} then 1 else 0 end)::int`,
      selects: sql<number>`sum(case when ${inArray(submissions.currentStage, SELECT_STAGES)} then 1 else 0 end)::int`,
      offers: sql<number>`sum(case when ${inArray(submissions.currentStage, OFFER_STAGES)} then 1 else 0 end)::int`,
      joins: sql<number>`sum(case when ${inArray(submissions.currentStage, JOIN_STAGES)} then 1 else 0 end)::int`,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        inArray(submissions.submittedByUserId, ids),
        gte(submissions.createdAt, since),
      ),
    )
    .groupBy(submissions.submittedByUserId);
  const subBy = new Map(subRows.map((r) => [r.userId!, r]));

  // Calls windowed.
  const callRows = await db
    .select({
      userId: callSessions.recruiterUserId,
      calls: sql<number>`count(*)::int`,
    })
    .from(callSessions)
    .where(
      and(
        eq(callSessions.orgId, orgId),
        inArray(callSessions.recruiterUserId, ids),
        gte(callSessions.startedAt, since),
      ),
    )
    .groupBy(callSessions.recruiterUserId);
  const callBy = new Map(callRows.map((r) => [r.userId!, r]));

  // SLA breaches: non-terminal submissions whose time-in-current-stage (latest
  // transition created_at, falling back to submitted_at) exceeds the stage SLA.
  const slaCase = sql`
    case
      when ${submissions.currentStage} in (${sql.join(
        stagesInBucket("pre_submit").map((s) => sql`${s}`),
        sql`, `,
      )}) then 3
      when ${submissions.currentStage} in (${sql.join(
        stagesInBucket("client_pipeline").map((s) => sql`${s}`),
        sql`, `,
      )}) then 5
      when ${submissions.currentStage} in (${sql.join(
        stagesInBucket("interview").map((s) => sql`${s}`),
        sql`, `,
      )}) then 7
      when ${submissions.currentStage} in (${sql.join(
        stagesInBucket("offer").map((s) => sql`${s}`),
        sql`, `,
      )}) then 4
      else 14
    end`;
  const slaRows = await db
    .select({
      userId: submissions.submittedByUserId,
      slaBreaches: sql<number>`count(*)::int`,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        inArray(submissions.submittedByUserId, ids),
        inArray(submissions.currentStage, NON_TERMINAL_STAGES),
        sql`coalesce(${submissions.updatedAt}, ${submissions.submittedAt}) < now() - (${slaCase} || ' days')::interval`,
      ),
    )
    .groupBy(submissions.submittedByUserId);
  const slaBy = new Map(slaRows.map((r) => [r.userId!, r]));

  // Active demand load (open demands assigned + active assignment).
  const loadRows = await db
    .select({
      userId: demandAssignments.recruiterId,
      activeDemands: sql<number>`count(*)::int`,
    })
    .from(demandAssignments)
    .innerJoin(demands, eq(demands.id, demandAssignments.demandId))
    .where(
      and(
        eq(demands.orgId, orgId),
        inArray(demandAssignments.recruiterId, ids),
        eq(demandAssignments.status, "active"),
        inArray(demands.status, OPEN_DEMAND_STATUSES),
      ),
    )
    .groupBy(demandAssignments.recruiterId);
  const loadBy = new Map(loadRows.map((r) => [r.userId!, r]));

  // Capacity caps.
  const capRows = await db
    .select({
      userId: recruiterCapacity.recruiterUserId,
      maxActiveDemands: recruiterCapacity.maxActiveDemands,
    })
    .from(recruiterCapacity)
    .where(and(eq(recruiterCapacity.orgId, orgId), inArray(recruiterCapacity.recruiterUserId, ids)));
  const capBy = new Map(capRows.map((r) => [r.userId!, r]));

  // Live goal attainment for this window's matching period (best-effort: pick the
  // live goal whose period window contains "now" for the 'submissions' metric or
  // any live goal). We surface goalAttainment for the submissions metric to keep
  // the list cheap; the detail page shows all goals.
  const goalRows = await db
    .select({
      userId: recruiterGoals.recruiterUserId,
      metric: recruiterGoals.metric,
      targetValue: recruiterGoals.targetValue,
    })
    .from(recruiterGoals)
    .where(
      and(
        eq(recruiterGoals.orgId, orgId),
        inArray(recruiterGoals.recruiterUserId, ids),
        sql`${recruiterGoals.archivedAt} is null`,
        sql`${recruiterGoals.periodStart} <= now()`,
        sql`${recruiterGoals.periodEnd} > now()`,
        eq(recruiterGoals.metric, "submissions"),
      ),
    );
  const goalBy = new Map(goalRows.map((r) => [r.userId!, r]));

  // 8-week submission sparkline.
  const sparkRows = await db
    .select({
      userId: submissions.submittedByUserId,
      week: sql<string>`to_char(date_trunc('week', ${submissions.createdAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)::int`,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        inArray(submissions.submittedByUserId, ids),
        gte(submissions.createdAt, new Date(Date.now() - 8 * 7 * 86400_000)),
      ),
    )
    .groupBy(submissions.submittedByUserId, sql`date_trunc('week', ${submissions.createdAt})`);
  const sparkBy = new Map<string, number[]>();
  for (const r of sparkRows) {
    if (!r.userId) continue;
    const arr = sparkBy.get(r.userId) ?? [];
    arr.push(r.n);
    sparkBy.set(r.userId, arr);
  }

  const out = new Map<string, RowKpis>();
  for (const id of ids) {
    const s = subBy.get(id);
    const submissionsN = s?.submissions ?? 0;
    const selectsN = s?.selects ?? 0;
    const activeDemands = loadBy.get(id)?.activeDemands ?? 0;
    const maxActiveDemands = capBy.get(id)?.maxActiveDemands ?? 8;
    const goalTarget = goalBy.get(id)?.targetValue ?? null;
    out.set(id, {
      submissions: submissionsN,
      clientSubmits: s?.clientSubmits ?? 0,
      selects: selectsN,
      offers: s?.offers ?? 0,
      joins: s?.joins ?? 0,
      calls: callBy.get(id)?.calls ?? 0,
      slaBreaches: slaBy.get(id)?.slaBreaches ?? 0,
      // conversion in basis points (selects / submissions).
      conversion: submissionsN > 0 ? Math.round((selectsN / submissionsN) * 10000) : 0,
      activeDemands,
      maxActiveDemands,
      loadPct: maxActiveDemands > 0 ? Math.round((activeDemands / maxActiveDemands) * 100) : 0,
      overAllocated: activeDemands > maxActiveDemands,
      goalAttainmentPct:
        goalTarget && goalTarget > 0 ? Math.round((submissionsN / goalTarget) * 100) : null,
      trendSpark: sparkBy.get(id) ?? [],
    });
  }
  return out;
}

interface RowKpis {
  submissions: number;
  clientSubmits: number;
  selects: number;
  offers: number;
  joins: number;
  calls: number;
  slaBreaches: number;
  conversion: number;
  activeDemands: number;
  maxActiveDemands: number;
  loadPct: number;
  overAllocated: boolean;
  goalAttainmentPct: number | null;
  trendSpark: number[];
}

// Map sort key → the numeric KPI value used for keyset ordering.
function sortValue(kpis: RowKpis, sort: string, name: string | null): number | string {
  switch (sort) {
    case "name":
      return (name ?? "").toLowerCase();
    case "submissions":
      return kpis.submissions;
    case "client_submits":
      return kpis.clientSubmits;
    case "selects":
      return kpis.selects;
    case "offers":
      return kpis.offers;
    case "joins":
      return kpis.joins;
    case "conversion":
      return kpis.conversion;
    case "calls":
      return kpis.calls;
    case "sla_breaches":
      return kpis.slaBreaches;
    case "goal_attainment":
      return kpis.goalAttainmentPct ?? -1;
    case "load":
      return kpis.loadPct;
    default:
      return kpis.submissions;
  }
}

// ----- Zod schemas -----
const RECRUITER_GOAL_METRICS = [
  "submissions",
  "client_submits",
  "selects",
  "offers",
  "joins",
  "calls",
  "conversion_rate",
] as const;
const RECRUITER_GOAL_PERIODS = ["weekly", "monthly", "quarterly"] as const;
const RECRUITER_NUDGE_KINDS = ["coaching", "sla_breach", "capacity", "goal", "kudos"] as const;

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(MANAGER_ROLES).optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
  reportingTo: z.string().uuid().optional(),
  window: z.enum(["7d", "30d", "90d", "qtd"]).default("30d"),
  sort: z
    .enum([
      "name",
      "submissions",
      "client_submits",
      "selects",
      "offers",
      "joins",
      "conversion",
      "calls",
      "sla_breaches",
      "goal_attainment",
      "load",
    ])
    .default("submissions"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const createGoal = z
  .object({
    metric: z.enum(RECRUITER_GOAL_METRICS),
    period: z.enum(RECRUITER_GOAL_PERIODS),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    targetValue: z.number().int().min(0).max(1_000_000),
    note: z.string().max(500).optional(),
  })
  .refine((d) => d.periodEnd > d.periodStart, {
    message: "periodEnd must be after periodStart",
    path: ["periodEnd"],
  });

const patchGoal = z.object({
  targetValue: z.number().int().min(0).max(1_000_000).optional(),
  note: z.string().max(500).nullable().optional(),
});

const capacityBody = z.object({
  maxActiveDemands: z.number().int().min(0).max(1000),
  maxActiveProspects: z.number().int().min(0).max(10000),
  weeklyCallTarget: z.number().int().min(0).max(10000),
  notes: z.string().max(1000).nullable().optional(),
});

const nudgeBody = z.object({
  kind: z.enum(RECRUITER_NUDGE_KINDS),
  message: z.string().trim().min(1).max(2000).optional(),
  draftWithAI: z.boolean().optional(),
  context: z.string().max(2000).optional(),
});

const reassignBody = z.object({
  demandId: z.string().uuid(),
  toRecruiterId: z.string().uuid(),
});

const leaderboardConfig = z
  .object({
    window: z.enum(["7d", "30d", "90d", "qtd"]),
    weights: z
      .array(
        z.object({
          metric: z.enum([
            "submissions",
            "client_submits",
            "selects",
            "offers",
            "joins",
            "conversion",
            "calls",
          ]),
          weight: z.number().min(0).max(1),
        }),
      )
      .min(1)
      .max(7),
    minTenureDays: z.number().int().min(0).max(3650).default(0),
    normalizeByCapacity: z.boolean().default(true),
    excludeOnLeave: z.boolean().default(true),
  })
  .refine((c) => Math.abs(c.weights.reduce((s, w) => s + w.weight, 0) - 1) < 0.001, {
    message: "weights must sum to 1.0",
    path: ["weights"],
  });

const createLeaderboard = z.object({
  name: z.string().trim().min(1).max(120),
  config: leaderboardConfig,
  isShared: z.boolean().default(false),
});

const patchLeaderboard = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: leaderboardConfig.optional(),
  isShared: z.boolean().optional(),
});

function badRequest(reply: FastifyReply, parsed: z.SafeParseError<unknown>) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

export async function recruitersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const read = app.requirePermission("recruiters.read");
  const manage = app.requirePermission("recruiters.manage");

  // ---------- LIST: server-side filter/sort/keyset + live KPIs ----------
  app.get("/", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;

    // Filtered membership set (the universe we sort + paginate over).
    const conds: SQL[] = [
      eq(memberships.orgId, ctx.orgId),
      inArray(memberships.role, qp.role ? [qp.role] : ALL_MANAGER_ROLES),
    ];
    if (qp.status) conds.push(eq(memberships.status, qp.status));
    if (qp.reportingTo) conds.push(eq(memberships.reportingToUserId, qp.reportingTo));
    if (qp.q) {
      const needle = `%${qp.q.toLowerCase()}%`;
      conds.push(sql`(lower(${users.name}) like ${needle} or lower(${users.email}) like ${needle})`);
    }
    const whereAll = and(...conds);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(whereAll);

    const base = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        status: memberships.status,
        joinedAt: memberships.joinedAt,
        lastActiveAt: users.lastActiveAt,
        reportingToUserId: memberships.reportingToUserId,
        createdAt: users.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(whereAll);

    const kpiBy = await loadKpis(ctx.orgId, base.map((r) => r.id), qp.window);

    // Build sortable rows, sort in-app (KPIs are computed, not columns), then
    // keyset-slice. Stable tiebreak on id.
    const enriched = base.map((r) => ({
      row: { ...r, ...(kpiBy.get(r.id) as RowKpis) },
      sv: sortValue(kpiBy.get(r.id) as RowKpis, qp.sort, r.name),
    }));

    const cmp = (a: (typeof enriched)[number], b: (typeof enriched)[number]) => {
      let c: number;
      if (typeof a.sv === "string" || typeof b.sv === "string") {
        c = String(a.sv).localeCompare(String(b.sv));
      } else {
        c = a.sv - b.sv;
      }
      if (c === 0) c = a.row.id.localeCompare(b.row.id);
      return qp.dir === "asc" ? c : -c;
    };
    enriched.sort(cmp);

    // Keyset slice: the full set is sorted deterministically (stable tiebreak on
    // id), so resume right after the cursor row. Locate it by id; if it's gone
    // (rare), fall back to the value-comparison boundary so we never re-emit.
    let start = 0;
    if (qp.cursor) {
      const cur = decodeCursor(qp.cursor);
      if (cur) {
        const byId = enriched.findIndex((e) => e.row.id === cur.id);
        if (byId !== -1) {
          start = byId + 1;
        } else {
          const probe = { row: { id: cur.id }, sv: cur.v } as (typeof enriched)[number];
          const idx = enriched.findIndex((e) => cmp(probe, e) < 0);
          start = idx === -1 ? enriched.length : idx;
        }
      }
    }

    const page = enriched.slice(start, start + qp.limit);
    const last = page[page.length - 1];
    const nextCursor =
      start + qp.limit < enriched.length && last
        ? encodeCursor({ v: last.sv, id: last.row.id })
        : null;

    return {
      rows: page.map((e) => e.row),
      nextCursor,
      total,
      window: qp.window,
      asOf: new Date().toISOString(),
    };
  });

  // ---------- EXPORT CSV (current filter/sort, no pagination) ----------
  app.get("/export", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuery.omit({ cursor: true, limit: true }).safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;

    const conds: SQL[] = [
      eq(memberships.orgId, ctx.orgId),
      inArray(memberships.role, qp.role ? [qp.role] : ALL_MANAGER_ROLES),
    ];
    if (qp.status) conds.push(eq(memberships.status, qp.status));
    if (qp.reportingTo) conds.push(eq(memberships.reportingToUserId, qp.reportingTo));
    if (qp.q) {
      const needle = `%${qp.q.toLowerCase()}%`;
      conds.push(sql`(lower(${users.name}) like ${needle} or lower(${users.email}) like ${needle})`);
    }

    const base = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...conds));

    const kpiBy = await loadKpis(ctx.orgId, base.map((r) => r.id), qp.window);
    const rows = base
      .map((r) => ({ ...r, k: kpiBy.get(r.id) as RowKpis, sv: sortValue(kpiBy.get(r.id) as RowKpis, qp.sort, r.name) }))
      .sort((a, b) => {
        let c: number;
        if (typeof a.sv === "string" || typeof b.sv === "string") c = String(a.sv).localeCompare(String(b.sv));
        else c = (a.sv as number) - (b.sv as number);
        if (c === 0) c = a.id.localeCompare(b.id);
        return qp.dir === "asc" ? c : -c;
      });

    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "name",
      "email",
      "role",
      "submissions",
      "client_submits",
      "selects",
      "offers",
      "joins",
      "calls",
      "conversion_bps",
      "sla_breaches",
      "active_demands",
      "max_active_demands",
      "load_pct",
      "over_allocated",
      "goal_attainment_pct",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.email,
          r.role,
          r.k.submissions,
          r.k.clientSubmits,
          r.k.selects,
          r.k.offers,
          r.k.joins,
          r.k.calls,
          r.k.conversion,
          r.k.slaBreaches,
          r.k.activeDemands,
          r.k.maxActiveDemands,
          r.k.loadPct,
          r.k.overAllocated,
          r.k.goalAttainmentPct ?? "",
        ]
          .map(esc)
          .join(","),
      );
    }
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="recruiters-${qp.window}.csv"`);
    return lines.join("\n");
  });

  // ---------- LEADERBOARDS (list shared + own) ----------
  app.get("/leaderboards", { preHandler: [read] }, async (req) => {
    const ctx = req.authUser!;
    const rows = await db
      .select()
      .from(recruiterLeaderboards)
      .where(
        and(
          eq(recruiterLeaderboards.orgId, ctx.orgId),
          sql`${recruiterLeaderboards.archivedAt} is null`,
          sql`(${recruiterLeaderboards.isShared} = true or ${recruiterLeaderboards.createdByUserId} = ${ctx.id})`,
        ),
      )
      .orderBy(desc(recruiterLeaderboards.updatedAt))
      .limit(100);
    return { leaderboards: rows };
  });

  app.post("/leaderboards", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createLeaderboard.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim() || null;

    if (idemKey) {
      const [existing] = await db
        .select()
        .from(recruiterLeaderboards)
        .where(
          and(
            eq(recruiterLeaderboards.orgId, ctx.orgId),
            sql`${recruiterLeaderboards.config}->>'_idem' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (existing) return reply.code(200).send({ leaderboard: existing, replayed: true });
    }

    const configWithIdem = idemKey
      ? { ...parsed.data.config, _idem: idemKey }
      : parsed.data.config;
    const created = await db.transaction(async (tx) => {
      const [lb] = await tx
        .insert(recruiterLeaderboards)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          config: configWithIdem,
          isShared: parsed.data.isShared,
          createdByUserId: ctx.id,
        })
        .returning();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: null,
        actorUserId: ctx.id,
        action: "leaderboard.save",
        after: { id: lb.id, name: lb.name, isShared: lb.isShared },
      });
      return lb;
    });
    return reply.code(201).send({ leaderboard: created });
  });

  app.patch("/leaderboards/:lbId", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { lbId } = req.params as { lbId: string };
    const parsed = patchLeaderboard.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const [before] = await db
      .select()
      .from(recruiterLeaderboards)
      .where(and(eq(recruiterLeaderboards.id, lbId), eq(recruiterLeaderboards.orgId, ctx.orgId)))
      .limit(1);
    if (!before) return reply.code(404).send({ error: "leaderboard_not_found" });

    const updated = await db.transaction(async (tx) => {
      const [lb] = await tx
        .update(recruiterLeaderboards)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.config !== undefined ? { config: parsed.data.config } : {}),
          ...(parsed.data.isShared !== undefined ? { isShared: parsed.data.isShared } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(recruiterLeaderboards.id, lbId), eq(recruiterLeaderboards.orgId, ctx.orgId)))
        .returning();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: null,
        actorUserId: ctx.id,
        action: "leaderboard.update",
        before: { name: before.name, isShared: before.isShared },
        after: { name: lb.name, isShared: lb.isShared },
      });
      return lb;
    });
    return { leaderboard: updated };
  });

  app.delete("/leaderboards/:lbId", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { lbId } = req.params as { lbId: string };
    const [before] = await db
      .select()
      .from(recruiterLeaderboards)
      .where(and(eq(recruiterLeaderboards.id, lbId), eq(recruiterLeaderboards.orgId, ctx.orgId)))
      .limit(1);
    if (!before) return reply.code(404).send({ error: "leaderboard_not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(recruiterLeaderboards)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(recruiterLeaderboards.id, lbId), eq(recruiterLeaderboards.orgId, ctx.orgId)));
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: null,
        actorUserId: ctx.id,
        action: "leaderboard.archive",
        before: { id: before.id, name: before.name },
      });
    });
    return { ok: true };
  });

  // ---------- GOALS: edit / archive (by goalId; not nested under recruiter) ----------
  app.patch("/goals/:goalId", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { goalId } = req.params as { goalId: string };
    const parsed = patchGoal.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const [before] = await db
      .select()
      .from(recruiterGoals)
      .where(and(eq(recruiterGoals.id, goalId), eq(recruiterGoals.orgId, ctx.orgId)))
      .limit(1);
    if (!before) return reply.code(404).send({ error: "goal_not_found" });

    const updated = await db.transaction(async (tx) => {
      const [g] = await tx
        .update(recruiterGoals)
        .set({
          ...(parsed.data.targetValue !== undefined ? { targetValue: parsed.data.targetValue } : {}),
          ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(recruiterGoals.id, goalId), eq(recruiterGoals.orgId, ctx.orgId)))
        .returning();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: before.recruiterUserId,
        actorUserId: ctx.id,
        action: "goal.update",
        before: { targetValue: before.targetValue, note: before.note },
        after: { targetValue: g.targetValue, note: g.note },
      });
      return g;
    });
    return { goal: updated };
  });

  app.delete("/goals/:goalId", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { goalId } = req.params as { goalId: string };
    const [before] = await db
      .select()
      .from(recruiterGoals)
      .where(and(eq(recruiterGoals.id, goalId), eq(recruiterGoals.orgId, ctx.orgId)))
      .limit(1);
    if (!before) return reply.code(404).send({ error: "goal_not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(recruiterGoals)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(recruiterGoals.id, goalId), eq(recruiterGoals.orgId, ctx.orgId)));
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: before.recruiterUserId,
        actorUserId: ctx.id,
        action: "goal.archive",
        before: { id: before.id, metric: before.metric, targetValue: before.targetValue },
      });
    });
    return { ok: true };
  });

  // ---------- DETAIL ----------
  app.get("/:id", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    const kpiBy = await loadKpis(ctx.orgId, [id], "30d");
    const kpis = kpiBy.get(id) as RowKpis;

    const stages = await db
      .select({ stage: submissions.currentStage, n: sql<number>`count(*)::int` })
      .from(submissions)
      .where(and(eq(submissions.orgId, ctx.orgId), eq(submissions.submittedByUserId, id)))
      .groupBy(submissions.currentStage);

    const goals = await db
      .select()
      .from(recruiterGoals)
      .where(and(eq(recruiterGoals.orgId, ctx.orgId), eq(recruiterGoals.recruiterUserId, id)))
      .orderBy(desc(recruiterGoals.periodStart))
      .limit(50);

    const [cap] = await db
      .select()
      .from(recruiterCapacity)
      .where(
        and(eq(recruiterCapacity.orgId, ctx.orgId), eq(recruiterCapacity.recruiterUserId, id)),
      )
      .limit(1);

    const recentCalls = await db
      .select({
        id: callSessions.id,
        startedAt: callSessions.startedAt,
        endedAt: callSessions.endedAt,
        candidateId: callSessions.candidateId,
        candidateName: candidates.displayName,
        demandId: callSessions.demandId,
        demandTitle: demands.title,
      })
      .from(callSessions)
      .leftJoin(candidates, eq(candidates.id, callSessions.candidateId))
      .leftJoin(demands, eq(demands.id, callSessions.demandId))
      .where(and(eq(callSessions.orgId, ctx.orgId), eq(callSessions.recruiterUserId, id)))
      .orderBy(desc(callSessions.startedAt))
      .limit(15);

    const activeProspects = await db
      .select({
        id: prospects.id,
        candidateId: prospects.candidateId,
        candidateName: candidates.displayName,
        demandId: prospects.demandId,
        demandTitle: demands.title,
        status: prospects.status,
        interestLevel: prospects.interestLevel,
        lastContactedAt: prospects.lastContactedAt,
      })
      .from(prospects)
      .leftJoin(candidates, eq(candidates.id, prospects.candidateId))
      .leftJoin(demands, eq(demands.id, prospects.demandId))
      .where(and(eq(prospects.orgId, ctx.orgId), eq(prospects.recruiterId, id)))
      .orderBy(desc(prospects.updatedAt))
      .limit(20);

    const recentNudges = await db
      .select()
      .from(recruiterNudges)
      .where(and(eq(recruiterNudges.orgId, ctx.orgId), eq(recruiterNudges.recruiterUserId, id)))
      .orderBy(desc(recruiterNudges.createdAt))
      .limit(20);

    const timeline = await db
      .select({
        id: recruiterAdminEvents.id,
        action: recruiterAdminEvents.action,
        actorUserId: recruiterAdminEvents.actorUserId,
        actorName: users.name,
        before: recruiterAdminEvents.before,
        after: recruiterAdminEvents.after,
        createdAt: recruiterAdminEvents.createdAt,
      })
      .from(recruiterAdminEvents)
      .leftJoin(users, eq(users.id, recruiterAdminEvents.actorUserId))
      .where(
        and(
          eq(recruiterAdminEvents.orgId, ctx.orgId),
          eq(recruiterAdminEvents.recruiterUserId, id),
        ),
      )
      .orderBy(desc(recruiterAdminEvents.createdAt))
      .limit(50);

    return {
      recruiter: m,
      kpis,
      stageBreakdown: stages,
      goals,
      capacity: cap ?? null,
      recentCalls,
      activeProspects,
      recentNudges,
      timeline,
    };
  });

  // ---------- TREND series ----------
  app.get("/:id/trend", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const tq = z
      .object({
        metric: z.enum(["submissions", "selects", "offers", "joins", "calls"]).default("submissions"),
        granularity: z.enum(["week", "month"]).default("week"),
        weeks: z.coerce.number().int().min(1).max(52).default(12),
      })
      .safeParse(req.query);
    if (!tq.success) return badRequest(reply, tq);
    const { metric, granularity, weeks } = tq.data;

    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    const since = new Date(Date.now() - weeks * 7 * 86400_000);
    // Inline the date_trunc unit as literal SQL (not a bound parameter). When it
    // is bound (`date_trunc(${truncUnit}, col)`), Postgres treats the SELECT and
    // GROUP BY placeholders as distinct expressions and raises 42803
    // ("must appear in the GROUP BY clause"). The value is a fixed enum, not
    // user-supplied text, so raw interpolation is safe.
    const truncUnit = sql.raw(`'${granularity === "month" ? "month" : "week"}'`);

    let series: Array<{ bucket: string; value: number }>;
    if (metric === "calls") {
      series = await db
        .select({
          bucket: sql<string>`to_char(date_trunc(${truncUnit}, ${callSessions.startedAt}), 'YYYY-MM-DD')`,
          value: sql<number>`count(*)::int`,
        })
        .from(callSessions)
        .where(
          and(
            eq(callSessions.orgId, ctx.orgId),
            eq(callSessions.recruiterUserId, id),
            gte(callSessions.startedAt, since),
          ),
        )
        .groupBy(sql`date_trunc(${truncUnit}, ${callSessions.startedAt})`)
        .orderBy(sql`date_trunc(${truncUnit}, ${callSessions.startedAt})`);
    } else {
      const stageFilter =
        metric === "selects"
          ? inArray(submissions.currentStage, SELECT_STAGES)
          : metric === "offers"
            ? inArray(submissions.currentStage, OFFER_STAGES)
            : metric === "joins"
              ? inArray(submissions.currentStage, JOIN_STAGES)
              : undefined;
      series = await db
        .select({
          bucket: sql<string>`to_char(date_trunc(${truncUnit}, ${submissions.createdAt}), 'YYYY-MM-DD')`,
          value: sql<number>`count(*)::int`,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.orgId, ctx.orgId),
            eq(submissions.submittedByUserId, id),
            gte(submissions.createdAt, since),
            ...(stageFilter ? [stageFilter] : []),
          ),
        )
        .groupBy(sql`date_trunc(${truncUnit}, ${submissions.createdAt})`)
        .orderBy(sql`date_trunc(${truncUnit}, ${submissions.createdAt})`);
    }

    return { metric, granularity, series, asOf: new Date().toISOString() };
  });

  // ---------- CREATE GOAL ----------
  app.post("/:id/goals", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = createGoal.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    try {
      const created = await db.transaction(async (tx) => {
        const [g] = await tx
          .insert(recruiterGoals)
          .values({
            orgId: ctx.orgId,
            recruiterUserId: id,
            metric: parsed.data.metric,
            period: parsed.data.period,
            periodStart: parsed.data.periodStart,
            periodEnd: parsed.data.periodEnd,
            targetValue: parsed.data.targetValue,
            note: parsed.data.note ?? null,
            createdByUserId: ctx.id,
          })
          .returning();
        await writeRecruiterAdminEvent(tx, {
          orgId: ctx.orgId,
          recruiterUserId: id,
          actorUserId: ctx.id,
          action: "goal.set",
          after: { id: g.id, metric: g.metric, period: g.period, targetValue: g.targetValue },
        });
        return g;
      });
      return reply.code(201).send({ goal: created });
    } catch (err) {
      if (err instanceof Error && /recruiter_goals_uniq_live|duplicate key/i.test(err.message)) {
        return reply.code(409).send({ error: "goal_exists" });
      }
      throw err;
    }
  });

  // ---------- UPSERT CAPACITY ----------
  app.put("/:id/capacity", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = capacityBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    const updated = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(recruiterCapacity)
        .where(
          and(eq(recruiterCapacity.orgId, ctx.orgId), eq(recruiterCapacity.recruiterUserId, id)),
        )
        .limit(1);
      const [cap] = await tx
        .insert(recruiterCapacity)
        .values({
          orgId: ctx.orgId,
          recruiterUserId: id,
          maxActiveDemands: parsed.data.maxActiveDemands,
          maxActiveProspects: parsed.data.maxActiveProspects,
          weeklyCallTarget: parsed.data.weeklyCallTarget,
          notes: parsed.data.notes ?? null,
          updatedByUserId: ctx.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [recruiterCapacity.orgId, recruiterCapacity.recruiterUserId],
          set: {
            maxActiveDemands: parsed.data.maxActiveDemands,
            maxActiveProspects: parsed.data.maxActiveProspects,
            weeklyCallTarget: parsed.data.weeklyCallTarget,
            notes: parsed.data.notes ?? null,
            updatedByUserId: ctx.id,
            updatedAt: new Date(),
          },
        })
        .returning();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: id,
        actorUserId: ctx.id,
        action: "capacity.set",
        before: before
          ? { maxActiveDemands: before.maxActiveDemands, maxActiveProspects: before.maxActiveProspects }
          : null,
        after: { maxActiveDemands: cap.maxActiveDemands, maxActiveProspects: cap.maxActiveProspects },
      });
      return cap;
    });
    return { capacity: updated };
  });

  // ---------- AI DRAFT for a nudge (503 when no key) ----------
  app.post("/:id/nudge/draft", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    if (!isNudgeDraftConfigured()) {
      return reply.code(503).send({ error: "openai_key_missing" });
    }
    const dq = z
      .object({ kind: z.enum(RECRUITER_NUDGE_KINDS).default("coaching"), context: z.string().max(2000).optional() })
      .safeParse(req.body ?? {});
    if (!dq.success) return badRequest(reply, dq);

    const kpiBy = await loadKpis(ctx.orgId, [id], "30d");
    const k = kpiBy.get(id);
    const message = await draftNudgeMessage({
      recruiterName: m.name ?? m.email,
      kind: dq.data.kind,
      metric: "selects",
      actual: k?.selects,
      target: undefined,
      context: dq.data.context,
    });
    if (message == null) return reply.code(503).send({ error: "openai_key_missing" });
    return { message };
  });

  // ---------- SEND NUDGE (idempotent on Idempotency-Key) ----------
  app.post("/:id/nudge", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = nudgeBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const m = await resolveRecruiter(ctx.orgId, id);
    if (!m) return reply.code(404).send({ error: "recruiter_not_found" });

    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim() || null;
    if (idemKey) {
      const [existing] = await db
        .select()
        .from(recruiterNudges)
        .where(and(eq(recruiterNudges.orgId, ctx.orgId), eq(recruiterNudges.idempotencyKey, idemKey)))
        .limit(1);
      if (existing) {
        return reply.code(200).send({ nudge: existing, delivery: existing.delivery, replayed: true });
      }
    }

    // Resolve the message. draftWithAI without an explicit message asks for a
    // server-side AI draft; if AI is unconfigured → 503 (precise code).
    let message = parsed.data.message?.trim();
    if (!message && parsed.data.draftWithAI) {
      if (!isNudgeDraftConfigured()) return reply.code(503).send({ error: "openai_key_missing" });
      const kpiBy = await loadKpis(ctx.orgId, [id], "30d");
      const drafted = await draftNudgeMessage({
        recruiterName: m.name ?? m.email,
        kind: parsed.data.kind,
        metric: "selects",
        actual: kpiBy.get(id)?.selects,
        context: parsed.data.context,
      });
      if (drafted == null) return reply.code(503).send({ error: "openai_key_missing" });
      message = drafted;
    }
    if (!message) {
      return reply.code(400).send({ error: "invalid_payload", issues: { message: ["message required"] } });
    }

    // Delivery: email when an email transport is configured (best-effort); else
    // in_app_only. No 500 either way.
    const delivery = "in_app_only" as const;

    const created = await db.transaction(async (tx) => {
      const [n] = await tx
        .insert(recruiterNudges)
        .values({
          orgId: ctx.orgId,
          recruiterUserId: id,
          kind: parsed.data.kind,
          message: message!,
          delivery,
          sentByUserId: ctx.id,
          idempotencyKey: idemKey,
        })
        .returning();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: id,
        actorUserId: ctx.id,
        action: "nudge.send",
        after: { id: n.id, kind: n.kind, delivery },
      });
      return n;
    });
    return reply.code(201).send({ nudge: created, delivery });
  });

  // ---------- REASSIGN A DEMAND (rebalance load) ----------
  app.post("/:id/reassign-demand", { preHandler: [manage] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    if (!ctx.permissions.includes("demands.assign")) {
      return reply.code(403).send({ error: "forbidden", permission: "demands.assign" });
    }
    const parsed = reassignBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    const from = await resolveRecruiter(ctx.orgId, id);
    if (!from) return reply.code(404).send({ error: "recruiter_not_found" });
    const to = await resolveRecruiter(ctx.orgId, parsed.data.toRecruiterId);
    if (!to) return reply.code(404).send({ error: "target_recruiter_not_found" });

    // Demand must be in caller's org.
    const [d] = await db
      .select({ id: demands.id, title: demands.title })
      .from(demands)
      .where(and(eq(demands.id, parsed.data.demandId), eq(demands.orgId, ctx.orgId)))
      .limit(1);
    if (!d) return reply.code(404).send({ error: "demand_not_found" });

    // Source must currently hold an active assignment on this demand.
    const [assignment] = await db
      .select()
      .from(demandAssignments)
      .where(
        and(
          eq(demandAssignments.demandId, d.id),
          eq(demandAssignments.recruiterId, id),
          eq(demandAssignments.status, "active"),
        ),
      )
      .limit(1);
    if (!assignment) return reply.code(409).send({ error: "assignment_not_found" });

    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(demandAssignments)
        .set({ status: "released", releasedAt: now })
        .where(
          and(
            eq(demandAssignments.demandId, d.id),
            eq(demandAssignments.recruiterId, id),
            eq(demandAssignments.status, "active"),
          ),
        );
      await tx
        .insert(demandAssignments)
        .values({
          demandId: d.id,
          recruiterId: parsed.data.toRecruiterId,
          assignedAt: now,
          assignedByUserId: ctx.id,
          status: "active",
        })
        .onConflictDoNothing();
      await writeRecruiterAdminEvent(tx, {
        orgId: ctx.orgId,
        recruiterUserId: id,
        actorUserId: ctx.id,
        action: "demand.reassign",
        before: { demandId: d.id, fromRecruiterId: id },
        after: { demandId: d.id, demandTitle: d.title, toRecruiterId: parsed.data.toRecruiterId },
      });
    });
    return { ok: true };
  });
}
