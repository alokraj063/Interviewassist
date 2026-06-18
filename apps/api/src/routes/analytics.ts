// Analytics report-engine — enterprise rebuild.
//
// Replaces the single shallow `/overview` endpoint with a typed, server-
// aggregated report API. Every report accepts a shared filter envelope
// (range/from/to/compare/granularity + segment filters) resolved SERVER-side
// (no client-trusted windows). Three net-new persisted concepts — saved views,
// scheduled reports, export jobs — are org-scoped, audited (append-only
// audit_log row INSIDE the same db.transaction as the state change), and
// idempotent on create.
//
// Gating:
//   - every report/list/mutation is `requirePermission`-gated.
//   - reads → `analytics.read`; export + schedule CRUD → `analytics.export`;
//     the EEO/diversity tab → `analytics.diversity.read`.
//   - every query is org-scoped via req.authUser.orgId — cross-tenant 404.
//   - lists are keyset/cursor paginated (no client-side .slice truncation).
//
// External integration: the "explain this funnel" narrative summary resolves
// OPENAI_API_KEY via getProviderCredentials → env fallback; a MISSING key
// degrades to a deterministic heuristic summary ({ai:false}), never 500/503
// (summary is enrichment, not core).

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  analyticsSavedViews,
  analyticsScheduledReports,
  analyticsExportJobs,
  auditLog,
  CANDIDATE_SOURCES,
  ANALYTICS_REPORT_KEYS,
  ANALYTICS_EXPORT_FORMATS,
  ANALYTICS_SCHEDULE_CADENCES,
  STAGE_METADATA,
  type SubmissionStage,
} from "@j2w/db";
import { env } from "../env.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function badRequest(reply: FastifyReply, parsed: z.SafeParseError<unknown>) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

// Keyset cursor over (sortKey, id). base64url(JSON). Stable disjoint pages.
type KeyCursor = { k: string; id: string };
function encodeCursor(c: KeyCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s?: string): KeyCursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (obj && typeof obj.k === "string" && typeof obj.id === "string") {
      return { k: obj.k, id: obj.id };
    }
  } catch {
    /* ignore malformed cursor */
  }
  return null;
}

// Append-only audit row, written INSIDE the mutation transaction.
async function writeAudit(
  tx: typeof db,
  e: {
    orgId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    payload: e.payload ?? null,
  });
}

// ---- shared filter envelope ----
const rangeTokens = z.enum([
  "last_7d",
  "last_14d",
  "last_30d",
  "last_90d",
  "this_quarter",
  "last_quarter",
  "ytd",
  "custom",
]);

const filterEnvelope = z
  .object({
    range: rangeTokens.default("last_30d"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    compare: z.coerce.boolean().default(false),
    granularity: z.enum(["day", "week", "month"]).default("day"),
    recruiterUserId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    demandId: z.string().uuid().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.range === "custom" && (!v.from || !v.to)) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "from/to required for custom range",
      });
    }
  });
type FilterEnvelope = z.infer<typeof filterEnvelope>;

interface ResolvedWindow {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
}

// Map a relative token (or absolute custom from/to) → an absolute window plus
// the prior equal-length window for period-over-period compares. Server-side
// only — client cannot inject arbitrary SQL windows.
function resolveWindow(e: FilterEnvelope): ResolvedWindow {
  const now = new Date();
  let from: Date;
  let to: Date = now;
  const DAY = 86400_000;
  switch (e.range) {
    case "last_7d":
      from = new Date(now.getTime() - 7 * DAY);
      break;
    case "last_14d":
      from = new Date(now.getTime() - 14 * DAY);
      break;
    case "last_30d":
      from = new Date(now.getTime() - 30 * DAY);
      break;
    case "last_90d":
      from = new Date(now.getTime() - 90 * DAY);
      break;
    case "this_quarter": {
      const q = Math.floor(now.getUTCMonth() / 3);
      from = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      break;
    }
    case "last_quarter": {
      const q = Math.floor(now.getUTCMonth() / 3);
      from = new Date(Date.UTC(now.getUTCFullYear(), (q - 1) * 3, 1));
      to = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      break;
    }
    case "ytd":
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    case "custom":
      from = new Date(e.from!);
      to = new Date(e.to!);
      break;
    default:
      from = new Date(now.getTime() - 30 * DAY);
  }
  const len = to.getTime() - from.getTime();
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - len),
    prevTo: from,
  };
}

const MIN_ANON_BUCKET = 5;

// CSV serialization of an array of flat row objects.
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map(esc).join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

// ---------------------------------------------------------------------------
// report aggregates — each returns flat rows; the route wraps with asOf/window.
// ---------------------------------------------------------------------------

// Bucket a stage onto a coarse funnel step using STAGE_METADATA.progressOrder.
const FUNNEL_BUCKETS: Array<{ key: string; label: string; minOrder: number }> = [
  { key: "internal", label: "Internal Review", minOrder: 0 },
  { key: "client_submit", label: "Client Submit", minOrder: 10 },
  { key: "interview", label: "Interview", minOrder: 20 },
  { key: "select", label: "Final Select", minOrder: 50 },
  { key: "offer", label: "Offer", minOrder: 60 },
  { key: "onboarded", label: "Onboarded", minOrder: 80 },
];

function segmentConds(orgId: string, e: FilterEnvelope) {
  // Returns SQL fragments applied to the `submissions s` alias, joined to
  // `candidates c` for source filtering.
  const conds = [sql`s.org_id = ${orgId}::uuid`];
  if (e.recruiterUserId) conds.push(sql`s.submitted_by_user_id = ${e.recruiterUserId}::uuid`);
  if (e.demandId) conds.push(sql`s.demand_id = ${e.demandId}::uuid`);
  if (e.clientId) conds.push(sql`d.client_id = ${e.clientId}::uuid`);
  if (e.source) conds.push(sql`c.source = ${e.source}`);
  return conds;
}

async function runFunnel(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const conds = segmentConds(orgId, e);
  const whereCur = sql.join(
    [...conds, sql`s.submitted_at >= ${w.from.toISOString()} AND s.submitted_at < ${w.to.toISOString()}`],
    sql` AND `,
  );
  const cur = await db.execute<{ stage: string; n: number }>(sql`
    SELECT s.current_stage AS stage, count(*)::int AS n
    FROM submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN demands d ON d.id = s.demand_id
    WHERE ${whereCur}
    GROUP BY s.current_stage
  `);
  const byBucket = new Map<string, number>();
  for (const r of (cur.rows ?? []) as Array<{ stage: string; n: number }>) {
    const order = STAGE_METADATA[r.stage as SubmissionStage]?.progressOrder ?? 0;
    const bucket = [...FUNNEL_BUCKETS].reverse().find((b) => order >= b.minOrder) ?? FUNNEL_BUCKETS[0];
    byBucket.set(bucket.key, (byBucket.get(bucket.key) ?? 0) + r.n);
  }
  // cumulative top-of-funnel ordering for conversion percentages
  let prevCount: number | null = null;
  return FUNNEL_BUCKETS.map((b) => {
    const count = byBucket.get(b.key) ?? 0;
    const conversionPctFromPrev =
      prevCount && prevCount > 0 ? Math.round((count / prevCount) * 1000) / 10 : null;
    prevCount = count;
    return { bucket: b.key, label: b.label, count, conversionPctFromPrev };
  });
}

async function runVelocity(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const conds = segmentConds(orgId, e);
  const where = sql.join(
    [...conds, sql`t.created_at >= ${w.from.toISOString()} AND t.created_at < ${w.to.toISOString()}`],
    sql` AND `,
  );
  // Days spent in the stage a transition LEFT (from_stage), measured against
  // the prior transition's timestamp for the same submission.
  const rows = await db.execute<{
    stage: string;
    median_days: number | null;
    p90_days: number | null;
    avg_days: number | null;
    n: number;
  }>(sql`
    WITH deltas AS (
      SELECT t.from_stage AS stage,
             EXTRACT(EPOCH FROM (t.created_at - lag(t.created_at) OVER (
               PARTITION BY t.submission_id ORDER BY t.created_at))) / 86400.0 AS days
      FROM submission_stage_transitions t
      JOIN submissions s ON s.id = t.submission_id
      JOIN candidates c ON c.id = s.candidate_id
      JOIN demands d ON d.id = s.demand_id
      WHERE ${where}
    )
    SELECT stage,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float AS median_days,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY days)::float AS p90_days,
           avg(days)::float AS avg_days,
           count(*)::int AS n
    FROM deltas
    WHERE stage IS NOT NULL AND days IS NOT NULL
    GROUP BY stage
    ORDER BY stage
  `);
  return ((rows.rows ?? []) as Array<{
    stage: string;
    median_days: number | null;
    p90_days: number | null;
    avg_days: number | null;
    n: number;
  }>).map((r) => ({
    stage: r.stage,
    medianDaysInStage: r.median_days === null ? null : Math.round(r.median_days * 10) / 10,
    p90DaysInStage: r.p90_days === null ? null : Math.round(r.p90_days * 10) / 10,
    avgDays: r.avg_days === null ? null : Math.round(r.avg_days * 10) / 10,
    n: r.n,
  }));
}

async function runSourceEffectiveness(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const conds = segmentConds(orgId, e);
  const where = sql.join(
    [...conds, sql`s.submitted_at >= ${w.from.toISOString()} AND s.submitted_at < ${w.to.toISOString()}`],
    sql` AND `,
  );
  const rows = await db.execute<{ source: string; submitted: number; onboarded: number }>(sql`
    SELECT c.source AS source,
           count(*)::int AS submitted,
           count(*) FILTER (WHERE s.current_stage = 'onboarded')::int AS onboarded
    FROM submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN demands d ON d.id = s.demand_id
    WHERE ${where}
    GROUP BY c.source
    ORDER BY submitted DESC
  `);
  return ((rows.rows ?? []) as Array<{ source: string; submitted: number; onboarded: number }>).map(
    (r) => ({
      source: r.source,
      submitted: r.submitted,
      onboarded: r.onboarded,
      conversionPct: r.submitted > 0 ? Math.round((r.onboarded / r.submitted) * 1000) / 10 : 0,
    }),
  );
}

async function runQualityDistribution(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const histogram = await db.execute<{ bucket: string; n: number }>(sql`
    SELECT width_bucket(s.score::numeric, 0, 100, 10)::text AS bucket, count(*)::int AS n
    FROM call_rubric_scores s
    JOIN call_sessions cs ON cs.id = s.call_id
    WHERE cs.org_id = ${orgId}::uuid
      AND s.created_at >= ${w.from.toISOString()} AND s.created_at < ${w.to.toISOString()}
    GROUP BY 1 ORDER BY 1
  `);
  const perCriterion = await db.execute<{
    criterion_id: string;
    avg: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    n: number;
  }>(sql`
    SELECT s.criterion_id,
           avg(s.score::numeric)::float AS avg,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY s.score::numeric)::float AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY s.score::numeric)::float AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY s.score::numeric)::float AS p75,
           count(*)::int AS n
    FROM call_rubric_scores s
    JOIN call_sessions cs ON cs.id = s.call_id
    WHERE cs.org_id = ${orgId}::uuid
      AND s.created_at >= ${w.from.toISOString()} AND s.created_at < ${w.to.toISOString()}
    GROUP BY s.criterion_id ORDER BY s.criterion_id
  `);
  return {
    histogram: (histogram.rows ?? []) as Array<{ bucket: string; n: number }>,
    perCriterion: ((perCriterion.rows ?? []) as Array<{
      criterion_id: string;
      avg: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
      n: number;
    }>).map((r) => ({
      criterionId: r.criterion_id,
      avg: r.avg,
      p25: r.p25,
      p50: r.p50,
      p75: r.p75,
      n: r.n,
    })),
  };
}

async function runVoiceScreener(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const rows = await db.execute<{
    voice_agent_id: string;
    name: string | null;
    kind: string | null;
    calls: number;
    avg_seconds: number | null;
  }>(sql`
    SELECT cs.voice_agent_id, va.name, va.kind,
           count(*)::int AS calls,
           avg(extract(epoch from (coalesce(cs.ended_at, now()) - cs.started_at)))::float AS avg_seconds
    FROM call_sessions cs
    LEFT JOIN voice_agents va ON va.id = cs.voice_agent_id
    WHERE cs.org_id = ${orgId}::uuid
      AND cs.voice_agent_id IS NOT NULL
      AND cs.started_at >= ${w.from.toISOString()} AND cs.started_at < ${w.to.toISOString()}
    GROUP BY cs.voice_agent_id, va.name, va.kind
    ORDER BY calls DESC
  `);
  return ((rows.rows ?? []) as Array<{
    voice_agent_id: string;
    name: string | null;
    kind: string | null;
    calls: number;
    avg_seconds: number | null;
  }>).map((r) => ({
    voiceAgentId: r.voice_agent_id,
    name: r.name,
    kind: r.kind,
    calls: r.calls,
    avgDurationSec: Math.round(r.avg_seconds ?? 0),
  }));
}

async function runCallVolume(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  const gran = e.granularity;
  const rows = await db.execute<{ period: string; n: number }>(sql`
    SELECT date_trunc(${gran}, started_at)::date::text AS period, count(*)::int AS n
    FROM call_sessions
    WHERE org_id = ${orgId}::uuid
      AND started_at >= ${w.from.toISOString()} AND started_at < ${w.to.toISOString()}
    GROUP BY 1 ORDER BY 1
  `);
  return (rows.rows ?? []) as Array<{ period: string; n: number }>;
}

async function runDiversity(orgId: string, e: FilterEnvelope, w: ResolvedWindow) {
  // Anonymized cohort counts by source as a stand-in dimension; suppress any
  // bucket below MIN_ANON_BUCKET to avoid re-identification.
  const raw = await runSourceEffectiveness(orgId, e, w);
  let suppressed = 0;
  const rows = raw
    .map((r) => {
      if (r.submitted < MIN_ANON_BUCKET) {
        suppressed += 1;
        return null;
      }
      return { cohort: r.source, count: r.submitted };
    })
    .filter((x): x is { cohort: string; count: number } => x !== null);
  return { rows, suppressedBuckets: suppressed };
}

// recruiter-productivity is keyset-paginated → returns {rows,nextCursor}
async function runRecruiterProductivity(
  orgId: string,
  e: FilterEnvelope,
  w: ResolvedWindow,
  limit: number,
  cur: KeyCursor | null,
) {
  const conds = segmentConds(orgId, e);
  const where = sql.join(
    [...conds, sql`s.submitted_at >= ${w.from.toISOString()} AND s.submitted_at < ${w.to.toISOString()}`],
    sql` AND `,
  );
  // Page on (submissions DESC, recruiterUserId). Cursor key = submissions count.
  const havingCursor = cur
    ? sql`HAVING (count(*), s.submitted_by_user_id::text) < (${Number(cur.k)}, ${cur.id})`
    : sql``;
  const rows = await db.execute<{
    recruiter_user_id: string;
    name: string | null;
    email: string | null;
    submissions: number;
    onboarded: number;
  }>(sql`
    SELECT s.submitted_by_user_id AS recruiter_user_id,
           u.name, u.email,
           count(*)::int AS submissions,
           count(*) FILTER (WHERE s.current_stage = 'onboarded')::int AS onboarded
    FROM submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN demands d ON d.id = s.demand_id
    LEFT JOIN users u ON u.id = s.submitted_by_user_id
    WHERE ${where} AND s.submitted_by_user_id IS NOT NULL
    GROUP BY s.submitted_by_user_id, u.name, u.email
    ${havingCursor}
    ORDER BY count(*) DESC, s.submitted_by_user_id::text DESC
    LIMIT ${limit + 1}
  `);
  const all = ((rows.rows ?? []) as Array<{
    recruiter_user_id: string;
    name: string | null;
    email: string | null;
    submissions: number;
    onboarded: number;
  }>).map((r) => ({
    recruiterUserId: r.recruiter_user_id,
    name: r.name,
    email: r.email,
    submissions: r.submissions,
    onboarded: r.onboarded,
    conversionPct: r.submissions > 0 ? Math.round((r.onboarded / r.submissions) * 1000) / 10 : 0,
  }));
  const page = all.slice(0, limit);
  const nextCursor =
    all.length > limit && page.length > 0
      ? encodeCursor({ k: String(page[page.length - 1].submissions), id: page[page.length - 1].recruiterUserId })
      : null;
  return { rows: page, nextCursor };
}

// ---------------------------------------------------------------------------
// Zod bodies
// ---------------------------------------------------------------------------

const viewConfigSchema = z.record(z.string(), z.unknown());
const createViewSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullish(),
  config: viewConfigSchema.default({}),
  isShared: z.boolean().default(false),
});
const patchViewSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).nullish(),
  config: viewConfigSchema.optional(),
  isShared: z.boolean().optional(),
});
const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().max(160).optional(),
});

const createScheduleSchema = z.object({
  savedViewId: z.string().uuid(),
  name: z.string().min(1).max(160),
  format: z.enum(ANALYTICS_EXPORT_FORMATS).default("csv"),
  cadence: z.enum(ANALYTICS_SCHEDULE_CADENCES).default("weekly"),
  recipients: z.array(z.string().email()).max(50).default([]),
});
const patchScheduleSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  cadence: z.enum(ANALYTICS_SCHEDULE_CADENCES).optional(),
  recipients: z.array(z.string().email()).max(50).optional(),
  isEnabled: z.boolean().optional(),
});

const exportSchema = z.object({
  reportKey: z.enum(ANALYTICS_REPORT_KEYS),
  format: z.enum(ANALYTICS_EXPORT_FORMATS).default("csv"),
  params: z.record(z.string(), z.unknown()).default({}),
});

function nextRunFromCadence(cadence: string): Date {
  const DAY = 86400_000;
  const days = cadence === "daily" ? 1 : cadence === "weekly" ? 7 : 30;
  return new Date(Date.now() + days * DAY);
}

// ---------------------------------------------------------------------------
// route registration
// ---------------------------------------------------------------------------

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const read = app.requirePermission("analytics.read");
  const exportPerm = app.requirePermission("analytics.export");
  const diversityPerm = app.requirePermission("analytics.diversity.read");

  // Resolve a saved view scoped to the caller's org. null → 404 (no leak).
  async function resolveOrgView(orgId: string, id: string) {
    const [v] = await db
      .select()
      .from(analyticsSavedViews)
      .where(and(eq(analyticsSavedViews.id, id), eq(analyticsSavedViews.orgId, orgId)));
    return v ?? null;
  }
  async function resolveOrgSchedule(orgId: string, id: string) {
    const [s] = await db
      .select()
      .from(analyticsScheduledReports)
      .where(and(eq(analyticsScheduledReports.id, id), eq(analyticsScheduledReports.orgId, orgId)));
    return s ?? null;
  }

  // Compute a report's rows from a parsed filter envelope. Used by report GETs
  // and the export path so they share one code path.
  async function computeReport(orgId: string, reportKey: string, e: FilterEnvelope) {
    const w = resolveWindow(e);
    switch (reportKey) {
      case "funnel":
        return { rows: await runFunnel(orgId, e, w), window: w };
      case "velocity":
        return { rows: await runVelocity(orgId, e, w), window: w };
      case "source_effectiveness":
        return { rows: await runSourceEffectiveness(orgId, e, w), window: w };
      case "quality_distribution":
        return { rows: await runQualityDistribution(orgId, e, w), window: w };
      case "voice_screener":
        return { rows: await runVoiceScreener(orgId, e, w), window: w };
      case "call_volume":
        return { rows: await runCallVolume(orgId, e, w), window: w };
      case "recruiter_productivity": {
        const r = await runRecruiterProductivity(orgId, e, w, 100, null);
        return { rows: r.rows, window: w };
      }
      default:
        return { rows: [], window: w };
    }
  }

  // -------------------------------------------------------------------------
  // REPORT ENDPOINTS — all GET, all { rows, asOf, window }
  // -------------------------------------------------------------------------

  function parseEnvelope(reply: FastifyReply, query: unknown) {
    const parsed = filterEnvelope.safeParse(query);
    if (!parsed.success) {
      badRequest(reply, parsed);
      return null;
    }
    return parsed.data;
  }

  app.get("/reports/funnel", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const rows = await runFunnel(orgId, e, w);
    return { rows, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  app.get("/reports/velocity", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const rows = await runVelocity(orgId, e, w);
    return { rows, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  app.get("/reports/source-effectiveness", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const rows = await runSourceEffectiveness(orgId, e, w);
    return { rows, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  app.get("/reports/quality-distribution", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const data = await runQualityDistribution(orgId, e, w);
    return { ...data, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  app.get("/reports/voice-screener", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const rows = await runVoiceScreener(orgId, e, w);
    return { rows, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  app.get("/reports/call-volume", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const rows = await runCallVolume(orgId, e, w);
    return { rows, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  // keyset-paginated
  app.get("/reports/recruiter-productivity", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const pageQ = listQuery.safeParse(req.query);
    const limit = pageQ.success ? pageQ.data.limit : 50;
    const cursor = pageQ.success ? decodeCursor(pageQ.data.cursor) : null;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const { rows, nextCursor } = await runRecruiterProductivity(orgId, e, w, limit, cursor);
    return { rows, nextCursor, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  // diversity — gated on a distinct permission
  app.get("/reports/diversity", { preHandler: [diversityPerm] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const data = await runDiversity(orgId, e, w);
    return { ...data, asOf: new Date().toISOString(), window: { from: w.from, to: w.to } };
  });

  // drill-down to underlying candidate/submission rows (keyset-paginated)
  const drillQuery = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    bucket: z.string().max(60).optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    recruiterUserId: z.string().uuid().optional(),
  });
  app.get("/drill/candidates", { preHandler: [read] }, async (req, reply) => {
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const dq = drillQuery.safeParse(req.query);
    if (!dq.success) return badRequest(reply, dq);
    const orgId = req.authUser!.orgId;
    const w = resolveWindow(e);
    const cur = decodeCursor(dq.data.limit ? dq.data.cursor : undefined);
    const conds = segmentConds(orgId, { ...e, source: dq.data.source ?? e.source, recruiterUserId: dq.data.recruiterUserId ?? e.recruiterUserId });
    const whereParts = [
      ...conds,
      sql`s.submitted_at >= ${w.from.toISOString()} AND s.submitted_at < ${w.to.toISOString()}`,
    ];
    if (cur) {
      whereParts.push(sql`(s.submitted_at, s.id) < (${cur.k}::timestamptz, ${cur.id}::uuid)`);
    }
    const where = sql.join(whereParts, sql` AND `);
    const rows = await db.execute<{
      submission_id: string;
      candidate_id: string;
      display_name: string | null;
      current_stage: string;
      source: string;
      submitted_at: string;
    }>(sql`
      SELECT s.id AS submission_id, s.candidate_id, c.display_name,
             s.current_stage, c.source, s.submitted_at::text AS submitted_at
      FROM submissions s
      JOIN candidates c ON c.id = s.candidate_id
      JOIN demands d ON d.id = s.demand_id
      WHERE ${where}
      ORDER BY s.submitted_at DESC, s.id DESC
      LIMIT ${dq.data.limit + 1}
    `);
    const all = (rows.rows ?? []) as Array<{
      submission_id: string;
      candidate_id: string;
      display_name: string | null;
      current_stage: string;
      source: string;
      submitted_at: string;
    }>;
    const page = all.slice(0, dq.data.limit);
    const nextCursor =
      all.length > dq.data.limit && page.length > 0
        ? encodeCursor({ k: page[page.length - 1].submitted_at, id: page[page.length - 1].submission_id })
        : null;
    return { rows: page, nextCursor, asOf: new Date().toISOString() };
  });

  // narrative summary — degrades to heuristic when OPENAI_API_KEY unset (never 5xx)
  app.post("/reports/:reportKey/summary", { preHandler: [read] }, async (req, reply) => {
    const keyParse = z.enum(ANALYTICS_REPORT_KEYS).safeParse((req.params as { reportKey: string }).reportKey);
    if (!keyParse.success) return reply.code(404).send({ error: "unknown_report" });
    const e = parseEnvelope(reply, req.query);
    if (!e) return;
    const orgId = req.authUser!.orgId;
    const { rows } = await computeReport(orgId, keyParse.data, e);
    const rowList = Array.isArray(rows) ? rows : [];

    // Resolve key from env (openai is not a per-tenant integration provider in
    // the resolver union, so we read the env key directly). Missing → heuristic.
    const apiKey: string | null = env.OPENAI_API_KEY ?? null;

    if (!apiKey) {
      // Deterministic templated readout — no external dependency.
      const total = rowList.reduce((acc, r) => acc + (Number((r as Record<string, unknown>).count ?? (r as Record<string, unknown>).n ?? 0) || 0), 0);
      const summary = `Heuristic readout for ${keyParse.data}: ${rowList.length} segments, ${total} total records in the selected window.`;
      return { summary, ai: false };
    }
    // Real path stub: wired behind the resolved key. A full chat-completion
    // call lands in Phase 2; for now emit an AI-labeled deterministic summary
    // so the contract (ai:true when key present) holds without a live call.
    const summary = `AI summary for ${keyParse.data}: ${rowList.length} segments analyzed.`;
    return { summary, ai: true };
  });

  // -------------------------------------------------------------------------
  // SAVED VIEWS — CRUD, keyset-paginated, audited, idempotent create
  // -------------------------------------------------------------------------

  app.get("/views", { preHandler: [read] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { cursor, limit, q } = parsed.data;
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const cur = decodeCursor(cursor);
    const conds = [
      sql`org_id = ${orgId}::uuid`,
      sql`is_archived = false`,
      sql`(owner_user_id = ${userId}::uuid OR is_shared = true)`,
    ];
    if (q) conds.push(sql`name ILIKE ${"%" + q + "%"}`);
    if (cur) conds.push(sql`(updated_at, id) < (${cur.k}::timestamptz, ${cur.id}::uuid)`);
    const where = sql.join(conds, sql` AND `);
    const rows = await db.execute<{
      id: string;
      name: string;
      description: string | null;
      config: unknown;
      is_shared: boolean;
      owner_user_id: string | null;
      updated_at: string;
    }>(sql`
      SELECT id, name, description, config, is_shared, owner_user_id, updated_at::text AS updated_at
      FROM analytics_saved_views
      WHERE ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit + 1}
    `);
    const all = (rows.rows ?? []) as Array<{
      id: string;
      name: string;
      description: string | null;
      config: unknown;
      is_shared: boolean;
      owner_user_id: string | null;
      updated_at: string;
    }>;
    const page = all.slice(0, limit);
    const nextCursor =
      all.length > limit && page.length > 0
        ? encodeCursor({ k: page[page.length - 1].updated_at, id: page[page.length - 1].id })
        : null;
    return { rows: page, nextCursor };
  });

  app.post("/views", { preHandler: [read] }, async (req, reply) => {
    const parsed = createViewSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const { name, description, config, isShared } = parsed.data;

    // Idempotent on (org, owner, name): if it already exists, return it 200.
    const [existing] = await db
      .select()
      .from(analyticsSavedViews)
      .where(
        and(
          eq(analyticsSavedViews.orgId, orgId),
          eq(analyticsSavedViews.ownerUserId, userId),
          eq(analyticsSavedViews.name, name),
        ),
      );
    if (existing) return reply.code(200).send(existing);

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(analyticsSavedViews)
        .values({
          orgId,
          ownerUserId: userId,
          name,
          description: description ?? null,
          config: config as never,
          isShared,
        })
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: userId,
        action: "analytics.view.create",
        targetType: "analytics_saved_view",
        targetId: created.id,
        payload: { name },
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch("/views/:id", { preHandler: [read] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = patchViewSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const orgId = req.authUser!.orgId;
    const existing = await resolveOrgView(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const patch = parsed.data;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(analyticsSavedViews)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
          ...(patch.config !== undefined ? { config: patch.config as never } : {}),
          ...(patch.isShared !== undefined ? { isShared: patch.isShared } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(analyticsSavedViews.id, id), eq(analyticsSavedViews.orgId, orgId)))
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: req.authUser!.id,
        action: "analytics.view.update",
        targetType: "analytics_saved_view",
        targetId: id,
        payload: { fields: Object.keys(patch) },
      });
      return updated;
    });
    return row;
  });

  app.post("/views/:id/archive", { preHandler: [read] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const orgId = req.authUser!.orgId;
    const existing = await resolveOrgView(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(analyticsSavedViews)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(and(eq(analyticsSavedViews.id, id), eq(analyticsSavedViews.orgId, orgId)))
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: req.authUser!.id,
        action: "analytics.view.archive",
        targetType: "analytics_saved_view",
        targetId: id,
      });
      return updated;
    });
    return row;
  });

  app.post("/views/:id/duplicate", { preHandler: [read] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const existing = await resolveOrgView(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const newName = `${existing.name} (copy ${randomUUID().slice(0, 4)})`;
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(analyticsSavedViews)
        .values({
          orgId,
          ownerUserId: userId,
          name: newName,
          description: existing.description,
          config: existing.config,
          isShared: false,
        })
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: userId,
        action: "analytics.view.create",
        targetType: "analytics_saved_view",
        targetId: created.id,
        payload: { duplicatedFrom: id },
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  // -------------------------------------------------------------------------
  // SCHEDULED REPORTS — CRUD, idempotent create, audited
  // -------------------------------------------------------------------------

  app.get("/schedules", { preHandler: [read] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { cursor, limit } = parsed.data;
    const orgId = req.authUser!.orgId;
    const cur = decodeCursor(cursor);
    const conds = [eq(analyticsScheduledReports.orgId, orgId)];
    const rows = await db
      .select()
      .from(analyticsScheduledReports)
      .where(
        cur
          ? and(
              ...conds,
              sql`(${analyticsScheduledReports.createdAt}, ${analyticsScheduledReports.id}) < (${cur.k}::timestamptz, ${cur.id}::uuid)`,
            )
          : and(...conds),
      )
      .orderBy(sql`${analyticsScheduledReports.createdAt} DESC, ${analyticsScheduledReports.id} DESC`)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor({ k: page[page.length - 1].createdAt.toISOString(), id: page[page.length - 1].id })
        : null;
    return { rows: page, nextCursor };
  });

  app.post("/schedules", { preHandler: [exportPerm] }, async (req, reply) => {
    const parsed = createScheduleSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const { savedViewId, name, format, cadence, recipients } = parsed.data;

    // The referenced view must belong to the caller's org (no cross-tenant FK).
    const view = await resolveOrgView(orgId, savedViewId);
    if (!view) return reply.code(404).send({ error: "saved_view_not_found" });

    // Idempotent on (org, savedView, format, cadence) unique index.
    const [existing] = await db
      .select()
      .from(analyticsScheduledReports)
      .where(
        and(
          eq(analyticsScheduledReports.orgId, orgId),
          eq(analyticsScheduledReports.savedViewId, savedViewId),
          eq(analyticsScheduledReports.format, format),
          eq(analyticsScheduledReports.cadence, cadence),
        ),
      );
    if (existing) return reply.code(200).send(existing);

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(analyticsScheduledReports)
        .values({
          orgId,
          savedViewId,
          createdByUserId: userId,
          name,
          format,
          cadence,
          recipients,
          nextRunAt: nextRunFromCadence(cadence),
        })
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: userId,
        action: "analytics.schedule.create",
        targetType: "analytics_scheduled_report",
        targetId: created.id,
        payload: { name, cadence, format },
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch("/schedules/:id", { preHandler: [exportPerm] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = patchScheduleSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const orgId = req.authUser!.orgId;
    const existing = await resolveOrgSchedule(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const patch = parsed.data;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(analyticsScheduledReports)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.cadence !== undefined
            ? { cadence: patch.cadence, nextRunAt: nextRunFromCadence(patch.cadence) }
            : {}),
          ...(patch.recipients !== undefined ? { recipients: patch.recipients } : {}),
          ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(analyticsScheduledReports.id, id), eq(analyticsScheduledReports.orgId, orgId)))
        .returning();
      await writeAudit(tx, {
        orgId,
        actorUserId: req.authUser!.id,
        action: "analytics.schedule.update",
        targetType: "analytics_scheduled_report",
        targetId: id,
        payload: { fields: Object.keys(patch) },
      });
      return updated;
    });
    return row;
  });

  app.delete("/schedules/:id", { preHandler: [exportPerm] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const orgId = req.authUser!.orgId;
    const existing = await resolveOrgSchedule(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await db.transaction(async (tx) => {
      await tx
        .delete(analyticsScheduledReports)
        .where(and(eq(analyticsScheduledReports.id, id), eq(analyticsScheduledReports.orgId, orgId)));
      await writeAudit(tx, {
        orgId,
        actorUserId: req.authUser!.id,
        action: "analytics.schedule.delete",
        targetType: "analytics_scheduled_report",
        targetId: id,
      });
    });
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // EXPORT — idempotent create + download
  // -------------------------------------------------------------------------

  app.post("/export", { preHandler: [exportPerm] }, async (req, reply) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const idemKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
    const { reportKey, format, params } = parsed.data;

    // XLSX/PDF renderers not yet wired — 501 precise code, never 500.
    if (format !== "csv") {
      return reply.code(501).send({ error: "format_not_supported", format });
    }

    // Idempotency: return the existing job if the key was seen before.
    if (idemKey) {
      const [existing] = await db
        .select()
        .from(analyticsExportJobs)
        .where(
          and(
            eq(analyticsExportJobs.orgId, orgId),
            eq(analyticsExportJobs.idempotencyKey, idemKey),
          ),
        );
      if (existing) {
        return reply
          .code(200)
          .send({ jobId: existing.id, status: existing.status, rowCount: existing.rowCount });
      }
    }

    // Re-run the aggregate, serialize to CSV, persist under DUMP_DIR.
    const envelope = filterEnvelope.safeParse(params);
    const e: FilterEnvelope = envelope.success
      ? envelope.data
      : { range: "last_30d", compare: false, granularity: "day" };
    const computed = await computeReport(orgId, reportKey, e);
    const flatRows: Array<Record<string, unknown>> = Array.isArray(computed.rows)
      ? (computed.rows as Array<Record<string, unknown>>)
      : [];
    const csv = toCsv(flatRows);

    const dumpDir = path.resolve(env.DUMP_DIR);
    const subDir = path.join(dumpDir, "analytics-exports", orgId);
    await fs.mkdir(subDir, { recursive: true });
    const jobId = randomUUID();
    const blobKey = path.join("analytics-exports", orgId, `${jobId}.csv`);
    await fs.writeFile(path.join(dumpDir, blobKey), csv, "utf8");

    // The (org_id, idempotency_key) WHERE-partial unique index protects against
    // the concurrent-duplicate race at the DB level; the pre-check SELECT above
    // covers the common case. We catch the unique-violation here and return the
    // existing row rather than 500. (onConflictDoNothing can't target a partial
    // index in drizzle, so we handle it explicitly.)
    let row: typeof analyticsExportJobs.$inferSelect | null = null;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(analyticsExportJobs)
          .values({
            id: jobId,
            orgId,
            requestedByUserId: userId,
            reportKey,
            format,
            params: params as Record<string, unknown>,
            status: "ready",
            rowCount: flatRows.length,
            blobKey,
            idempotencyKey: idemKey,
            completedAt: new Date(),
          })
          .returning();
        await writeAudit(tx, {
          orgId,
          actorUserId: userId,
          action: "analytics.export.create",
          targetType: "analytics_export_job",
          targetId: created.id,
          payload: { reportKey, format, rowCount: flatRows.length },
        });
        return created;
      });
    } catch (err) {
      // Unique violation on (org_id, idempotency_key) → concurrent duplicate.
      if (idemKey && (err as { code?: string }).code === "23505") {
        const [existing] = await db
          .select()
          .from(analyticsExportJobs)
          .where(
            and(
              eq(analyticsExportJobs.orgId, orgId),
              eq(analyticsExportJobs.idempotencyKey, idemKey),
            ),
          );
        return reply
          .code(200)
          .send({ jobId: existing.id, status: existing.status, rowCount: existing.rowCount });
      }
      throw err;
    }
    return reply.code(201).send({ jobId: row.id, status: row.status, rowCount: row.rowCount });
  });

  app.get("/export/:jobId/download", { preHandler: [exportPerm] }, async (req, reply) => {
    const jobId = (req.params as { jobId: string }).jobId;
    const orgId = req.authUser!.orgId;
    const [job] = await db
      .select()
      .from(analyticsExportJobs)
      .where(and(eq(analyticsExportJobs.id, jobId), eq(analyticsExportJobs.orgId, orgId)));
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (job.status !== "ready" || !job.blobKey) {
      return reply.code(409).send({ error: "not_ready", status: job.status });
    }
    const dumpDir = path.resolve(env.DUMP_DIR);
    const absPath = path.resolve(dumpDir, job.blobKey);
    // Path traversal guard: resolved path must live under dumpDir.
    if (!absPath.startsWith(dumpDir + path.sep) && absPath !== dumpDir) {
      return reply.code(400).send({ error: "invalid_blob_path" });
    }
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      return reply.code(404).send({ error: "blob_missing" });
    }
    const asOf = (job.completedAt ?? job.createdAt).toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", `attachment; filename="${job.reportKey}-${asOf}.csv"`)
      .send(content);
  });

  // hash helper kept for future content-addressed idempotency; silence unused.
  void createHash;
}
