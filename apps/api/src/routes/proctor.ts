// Proctor cockpit — enterprise routes.
//
// Three coordinated surfaces over one data spine: a server-paginated/filtered
// live roster, a per-session live console (feeds, identity, incident timeline,
// interventions, chain-of-custody), and an SLA-tracked review queue, plus
// per-assessment proctoring policies.
//
// Invariants enforced everywhere:
//   - org-scoped to req.authUser.orgId (no DEFAULT_ORG hole);
//   - every read gated by proctoring.read; every mutation by a precise
//     proctoring.* permission;
//   - Zod validation on every body/query;
//   - keyset/cursor pagination on every list route;
//   - idempotency on create/assign/intervene/review (Idempotency-Key header);
//   - an append-only proctor_audit_events row inside every mutation
//     (chain-of-custody);
//   - external providers (face-match / live streams) resolve real-first and
//     return a precise 503 when unconfigured — never an uncaught 500.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assessmentTemplates,
  candidates,
  db,
  memberships,
  PROCTOR_AUDIT_ACTIONS,
  PROCTOR_EVENT_SEVERITIES,
  PROCTOR_INTERVENTION_KINDS,
  PROCTOR_LIVE_STATES,
  PROCTOR_REVIEWER_DECISIONS,
  PROCTOR_SESSION_STATUSES,
  PROCTOR_SIGNAL_SEVERITIES,
  proctorAuditEvents,
  proctorEvents,
  proctorIdentityChecks,
  proctorInterventions,
  proctorPolicies,
  proctorSessions,
  users,
  type ProctorAuditAction,
  type ProctorSignalConfig,
} from "@j2w/db";
import {
  lookupIdempotent,
  readIdempotencyKey,
  recordIdempotent,
} from "../assessments/idempotency.js";
import { computeRiskScore, riskLabel, type RiskEventLike } from "../proctor/risk.js";
import { FaceMatchProviderMissing, runFaceMatch } from "../proctor/faceMatch.js";
import { getStreamMode, mintViewerToken, StreamProviderMissing } from "../proctor/streams.js";

const DEFAULT_REVIEW_SLA_HOURS = 24;

// ---------- schemas ----------

const listQuery = z.object({
  status: z.enum(PROCTOR_SESSION_STATUSES).optional(),
  liveState: z.enum(PROCTOR_LIVE_STATES).optional(),
  decision: z.enum(PROCTOR_REVIEWER_DECISIONS).optional(),
  minRisk: z.coerce.number().int().min(0).max(100).optional(),
  assignedToMe: z.coerce.boolean().optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(["risk", "recent", "sla"]).default("recent"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const eventsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const reviewQueueQuery = z.object({
  assignedToMe: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const startSessionSchema = z
  .object({
    assessmentAttemptId: z.string().uuid().optional(),
    asyncVideoSubmissionId: z.string().uuid().optional(),
    candidateId: z.string().uuid().optional(),
    assessmentTemplateId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      (v.assessmentAttemptId && !v.asyncVideoSubmissionId) ||
      (!v.assessmentAttemptId && v.asyncVideoSubmissionId),
    "exactly one of assessmentAttemptId / asyncVideoSubmissionId is required",
  );

const eventSchema = z.object({
  kind: z.string().min(1).max(40),
  severity: z.enum(PROCTOR_EVENT_SEVERITIES).default("low"),
  payload: z.record(z.unknown()).optional(),
  flagged: z.boolean().default(true),
  offsetMs: z.number().int().min(0).optional(),
  evidenceBlobKey: z.string().max(500).optional(),
});

const assignSchema = z.object({
  reviewerUserId: z.string().uuid().nullable(),
});

const interveneSchema = z
  .object({
    kind: z.enum(PROCTOR_INTERVENTION_KINDS),
    message: z.string().max(2000).optional(),
    extendSeconds: z.number().int().min(30).max(3600).optional(),
  })
  .refine(
    (v) => v.kind !== "terminate" || (v.message != null && v.message.trim().length >= 10),
    { message: "terminate requires a justification (min 10 chars)", path: ["message"] },
  )
  .refine((v) => v.kind !== "extend" || typeof v.extendSeconds === "number", {
    message: "extend requires extendSeconds",
    path: ["extendSeconds"],
  });

const identityVerifySchema = z.object({
  status: z.enum(["verified", "mismatch", "skipped"]),
  notes: z.string().max(2000).optional(),
});

const reviewSchema = z
  .object({
    decision: z.enum(PROCTOR_REVIEWER_DECISIONS),
    justification: z.string().max(4000).optional(),
    force: z.boolean().optional(),
  })
  .refine(
    (v) => v.decision === "clean" || (v.justification != null && v.justification.trim().length >= 10),
    { message: "flagged/invalidated decisions require a justification (min 10 chars)", path: ["justification"] },
  );

const signalConfigSchema = z.record(
  z.object({
    armed: z.boolean(),
    severity: z.enum(PROCTOR_SIGNAL_SEVERITIES),
    weight: z.number().int().min(0).max(50),
  }),
);

const policySchema = z
  .object({
    name: z.string().min(1).max(120),
    assessmentTemplateId: z.string().uuid().nullish(),
    isDefault: z.boolean().default(false),
    signalConfig: signalConfigSchema.default({}),
    requireIdentity: z.boolean().default(true),
    requireWebcam: z.boolean().default(true),
    requireScreen: z.boolean().default(false),
    lockdownBrowser: z.boolean().default(false),
    autoFlagRiskScore: z.number().int().min(0).max(100).default(40),
    autoTerminateRiskScore: z.number().int().min(0).max(100).nullable().default(null),
  })
  .refine(
    (v) => v.autoTerminateRiskScore == null || v.autoTerminateRiskScore >= v.autoFlagRiskScore,
    { message: "autoTerminateRiskScore must be ≥ autoFlagRiskScore", path: ["autoTerminateRiskScore"] },
  );

const policyPatchSchema = policySchema.innerType().partial();

// ---------- cursor helpers ----------

interface Cursor {
  k: string | number;
  id: string;
}
function encodeCursor(k: string | number, id: string): string {
  return Buffer.from(JSON.stringify({ k, id })).toString("base64url");
}
function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (parsed && (typeof parsed.k === "string" || typeof parsed.k === "number") && typeof parsed.id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- audit ----------

// Append-only chain-of-custody write. Accepts the active transaction (or a
// PgTransaction cast to `typeof db`) so the audit row commits atomically with
// the state change it records — a committed mutation must never be missing its
// audit row, and vice versa.
async function writeAudit(
  exec: typeof db,
  args: {
    orgId: string;
    sessionId: string | null;
    actorUserId: string | null;
    action: ProctorAuditAction;
    fromValue?: string | null;
    toValue?: string | null;
    payload?: Record<string, unknown> | null;
    ip?: string | null;
  },
): Promise<void> {
  await exec.insert(proctorAuditEvents).values({
    orgId: args.orgId,
    sessionId: args.sessionId,
    actorUserId: args.actorUserId,
    action: args.action,
    fromValue: args.fromValue ?? null,
    toValue: args.toValue ?? null,
    payload: args.payload ?? null,
    ip: args.ip ?? null,
  });
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_payload", issues: error.flatten() });
}

function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

// Resolve the applicable policy for a new session: explicit template policy →
// org-default policy → null. Returns the row so the session can snapshot it.
async function resolvePolicy(
  orgId: string,
  assessmentTemplateId: string | null,
): Promise<typeof proctorPolicies.$inferSelect | null> {
  if (assessmentTemplateId) {
    const [tpl] = await db
      .select()
      .from(proctorPolicies)
      .where(
        and(
          eq(proctorPolicies.orgId, orgId),
          eq(proctorPolicies.assessmentTemplateId, assessmentTemplateId),
        ),
      )
      .limit(1);
    if (tpl) return tpl;
  }
  const [def] = await db
    .select()
    .from(proctorPolicies)
    .where(and(eq(proctorPolicies.orgId, orgId), eq(proctorPolicies.isDefault, true)))
    .limit(1);
  return def ?? null;
}

function policySnapshotOf(p: typeof proctorPolicies.$inferSelect | null): Record<string, unknown> | null {
  if (!p) return null;
  return {
    policyId: p.id,
    name: p.name,
    signalConfig: p.signalConfig,
    requireIdentity: p.requireIdentity,
    requireWebcam: p.requireWebcam,
    requireScreen: p.requireScreen,
    lockdownBrowser: p.lockdownBrowser,
    autoFlagRiskScore: p.autoFlagRiskScore,
    autoTerminateRiskScore: p.autoTerminateRiskScore,
  };
}

function snapshotSignalConfig(snapshot: Record<string, unknown> | null): ProctorSignalConfig | null {
  if (!snapshot) return null;
  const sc = snapshot.signalConfig;
  return sc && typeof sc === "object" ? (sc as ProctorSignalConfig) : null;
}

export async function proctorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const canRead = app.requirePermission("proctoring.read");
  const canReview = app.requirePermission("proctoring.review");
  const canIntervene = app.requirePermission("proctoring.intervene");
  const canPolicy = app.requirePermission("proctoring.policy.write");
  const canExport = app.requirePermission("proctoring.export");

  // -------------------- SUMMARY (server aggregates) --------------------
  app.get("/summary", { preHandler: [canRead] }, async (req) => {
    const orgId = req.authUser!.orgId;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [row] = await db
      .select({
        live: sql<number>`count(*) FILTER (WHERE ${proctorSessions.status} = 'live' AND ${proctorSessions.liveState} = 'active')::int`,
        paused: sql<number>`count(*) FILTER (WHERE ${proctorSessions.liveState} = 'paused')::int`,
        pendingReview: sql<number>`count(*) FILTER (WHERE ${proctorSessions.status} = 'completed' AND ${proctorSessions.reviewerDecision} IS NULL)::int`,
        slaBreached: sql<number>`count(*) FILTER (WHERE ${proctorSessions.reviewerDecision} IS NULL AND ${proctorSessions.status} = 'completed' AND ${proctorSessions.reviewSlaDueAt} IS NOT NULL AND ${proctorSessions.reviewSlaDueAt} < now())::int`,
        flaggedToday: sql<number>`count(*) FILTER (WHERE ${proctorSessions.flagCount} > 0 AND ${proctorSessions.startedAt} >= ${startOfToday.toISOString()})::int`,
        invalidated: sql<number>`count(*) FILTER (WHERE ${proctorSessions.reviewerDecision} = 'invalidated')::int`,
        avgRisk: sql<number>`coalesce(round(avg(${proctorSessions.riskScore}) FILTER (WHERE ${proctorSessions.status} != 'abandoned'))::int, 0)`,
        total: sql<number>`count(*)::int`,
      })
      .from(proctorSessions)
      .where(eq(proctorSessions.orgId, orgId));
    return {
      live: row?.live ?? 0,
      paused: row?.paused ?? 0,
      pendingReview: row?.pendingReview ?? 0,
      slaBreached: row?.slaBreached ?? 0,
      flaggedToday: row?.flaggedToday ?? 0,
      invalidated: row?.invalidated ?? 0,
      avgRisk: row?.avgRisk ?? 0,
      total: row?.total ?? 0,
    };
  });

  // -------------------- ROSTER (keyset) --------------------
  app.get("/sessions", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const conds = [eq(proctorSessions.orgId, ctx.orgId)];
    if (qy.status) conds.push(eq(proctorSessions.status, qy.status));
    if (qy.liveState) conds.push(eq(proctorSessions.liveState, qy.liveState));
    if (qy.decision) conds.push(eq(proctorSessions.reviewerDecision, qy.decision));
    if (typeof qy.minRisk === "number") conds.push(gte(proctorSessions.riskScore, qy.minRisk));
    if (qy.assignedToMe) conds.push(eq(proctorSessions.assignedReviewerUserId, ctx.id));
    if (qy.q) conds.push(ilike(candidates.displayName, `%${qy.q}%`));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(proctorSessions)
      .leftJoin(candidates, eq(candidates.id, proctorSessions.candidateId))
      .where(and(...conds));

    const keysetConds = [...conds];
    const cur = qy.cursor ? decodeCursor(qy.cursor) : null;
    if (qy.cursor && !cur) return reply.code(400).send({ error: "invalid_cursor" });

    // sort → (sortCol, id). risk/recent DESC, sla ASC.
    if (qy.sort === "risk") {
      if (cur) {
        keysetConds.push(
          sql`(${proctorSessions.riskScore} < ${Number(cur.k)} OR (${proctorSessions.riskScore} = ${Number(cur.k)} AND ${proctorSessions.id} < ${cur.id}))`,
        );
      }
    } else if (qy.sort === "sla") {
      if (cur) {
        keysetConds.push(
          sql`(${proctorSessions.reviewSlaDueAt} > ${String(cur.k)}::timestamptz OR (${proctorSessions.reviewSlaDueAt} = ${String(cur.k)}::timestamptz AND ${proctorSessions.id} > ${cur.id}))`,
        );
      }
    } else {
      if (cur) {
        keysetConds.push(
          sql`(${proctorSessions.startedAt} < ${String(cur.k)}::timestamptz OR (${proctorSessions.startedAt} = ${String(cur.k)}::timestamptz AND ${proctorSessions.id} < ${cur.id}))`,
        );
      }
    }

    const orderBy =
      qy.sort === "risk"
        ? [desc(proctorSessions.riskScore), desc(proctorSessions.id)]
        : qy.sort === "sla"
          ? [asc(proctorSessions.reviewSlaDueAt), asc(proctorSessions.id)]
          : [desc(proctorSessions.startedAt), desc(proctorSessions.id)];

    const rows = await db
      .select({
        id: proctorSessions.id,
        candidateId: proctorSessions.candidateId,
        candidateName: candidates.displayName,
        status: proctorSessions.status,
        liveState: proctorSessions.liveState,
        riskScore: proctorSessions.riskScore,
        flagCount: proctorSessions.flagCount,
        startedAt: proctorSessions.startedAt,
        endedAt: proctorSessions.endedAt,
        reviewerDecision: proctorSessions.reviewerDecision,
        assignedReviewerUserId: proctorSessions.assignedReviewerUserId,
        assignedReviewerName: users.name,
        reviewSlaDueAt: proctorSessions.reviewSlaDueAt,
        assessmentAttemptId: proctorSessions.assessmentAttemptId,
        asyncVideoSubmissionId: proctorSessions.asyncVideoSubmissionId,
      })
      .from(proctorSessions)
      .leftJoin(candidates, eq(candidates.id, proctorSessions.candidateId))
      .leftJoin(users, eq(users.id, proctorSessions.assignedReviewerUserId))
      .where(and(...keysetConds))
      .orderBy(...orderBy)
      .limit(qy.limit);

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === qy.limit && last
        ? qy.sort === "risk"
          ? encodeCursor(last.riskScore, last.id)
          : qy.sort === "sla"
            ? encodeCursor(last.reviewSlaDueAt ? last.reviewSlaDueAt.toISOString() : "", last.id)
            : encodeCursor(last.startedAt.toISOString(), last.id)
        : null;

    return {
      sessions: rows.map((r) => ({ ...r, riskLabel: riskLabel(r.riskScore) })),
      nextCursor,
      total,
    };
  });

  // -------------------- REVIEWERS (eligible assignees) --------------------
  // Org members in reviewer-capable roles — used by the assign-reviewer picker.
  app.get("/reviewers", { preHandler: [canRead] }, async (req) => {
    const ctx = req.authUser!;
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.orgId, ctx.orgId),
          eq(memberships.status, "active"),
          inArray(memberships.role, ["qa_reviewer", "proctor", "admin", "business_head"]),
        ),
      )
      .orderBy(asc(users.name))
      .limit(200);
    return { reviewers: rows };
  });

  // -------------------- REVIEW QUEUE (keyset, SLA-ordered) --------------------
  app.get("/review-queue", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = reviewQueueQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const conds = [
      eq(proctorSessions.orgId, ctx.orgId),
      eq(proctorSessions.status, "completed"),
      sql`${proctorSessions.reviewerDecision} IS NULL`,
    ];
    if (qy.assignedToMe) conds.push(eq(proctorSessions.assignedReviewerUserId, ctx.id));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(proctorSessions)
      .where(and(...conds));

    const keysetConds = [...conds];
    const cur = qy.cursor ? decodeCursor(qy.cursor) : null;
    if (qy.cursor && !cur) return reply.code(400).send({ error: "invalid_cursor" });
    if (cur) {
      keysetConds.push(
        sql`(${proctorSessions.reviewSlaDueAt} > ${String(cur.k)}::timestamptz OR (${proctorSessions.reviewSlaDueAt} = ${String(cur.k)}::timestamptz AND ${proctorSessions.id} > ${cur.id}))`,
      );
    }

    const rows = await db
      .select({
        id: proctorSessions.id,
        candidateId: proctorSessions.candidateId,
        candidateName: candidates.displayName,
        riskScore: proctorSessions.riskScore,
        flagCount: proctorSessions.flagCount,
        reviewSlaDueAt: proctorSessions.reviewSlaDueAt,
        assignedReviewerUserId: proctorSessions.assignedReviewerUserId,
        assignedReviewerName: users.name,
        startedAt: proctorSessions.startedAt,
        endedAt: proctorSessions.endedAt,
      })
      .from(proctorSessions)
      .leftJoin(candidates, eq(candidates.id, proctorSessions.candidateId))
      .leftJoin(users, eq(users.id, proctorSessions.assignedReviewerUserId))
      .where(and(...keysetConds))
      .orderBy(asc(proctorSessions.reviewSlaDueAt), asc(proctorSessions.id))
      .limit(qy.limit);

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === qy.limit && last
        ? encodeCursor(last.reviewSlaDueAt ? last.reviewSlaDueAt.toISOString() : "", last.id)
        : null;

    return {
      queue: rows.map((r) => ({ ...r, riskLabel: riskLabel(r.riskScore) })),
      nextCursor,
      total,
    };
  });

  // -------------------- SESSION DETAIL (writes session.view audit) --------------------
  app.get("/sessions/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [session] = await db
      .select()
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const [candidate] = session.candidateId
      ? await db
          .select({ id: candidates.id, displayName: candidates.displayName })
          .from(candidates)
          .where(eq(candidates.id, session.candidateId))
          .limit(1)
      : [undefined];

    const [identity] = await db
      .select()
      .from(proctorIdentityChecks)
      .where(eq(proctorIdentityChecks.sessionId, id))
      .limit(1);

    const interventions = await db
      .select({
        id: proctorInterventions.id,
        kind: proctorInterventions.kind,
        message: proctorInterventions.message,
        extendSeconds: proctorInterventions.extendSeconds,
        actorUserId: proctorInterventions.actorUserId,
        actorName: users.name,
        createdAt: proctorInterventions.createdAt,
      })
      .from(proctorInterventions)
      .leftJoin(users, eq(users.id, proctorInterventions.actorUserId))
      .where(eq(proctorInterventions.sessionId, id))
      .orderBy(desc(proctorInterventions.createdAt))
      .limit(100);

    const events = await db
      .select()
      .from(proctorEvents)
      .where(eq(proctorEvents.sessionId, id))
      .orderBy(asc(proctorEvents.offsetMs), asc(proctorEvents.createdAt))
      .limit(100);

    const [assignedReviewer] = session.assignedReviewerUserId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, session.assignedReviewerUserId))
          .limit(1)
      : [undefined];

    // Chain-of-custody: record that this user viewed the session's evidence.
    // A single audit insert with no accompanying state change is atomic on its
    // own — no transaction needed.
    await writeAudit(db, {
      orgId: ctx.orgId,
      sessionId: id,
      actorUserId: ctx.id,
      action: "session.view",
      ip: clientIp(req),
    });

    return {
      session: { ...session, riskLabel: riskLabel(session.riskScore) },
      candidate: candidate ?? null,
      identity: identity ?? null,
      interventions,
      events,
      assignedReviewer: assignedReviewer ?? null,
      streamMode: getStreamMode(),
    };
  });

  // -------------------- SESSION EVENTS (cursor, scrubber order) --------------------
  app.get("/sessions/:id/events", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = eventsQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const [session] = await db
      .select({ id: proctorSessions.id })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const conds = [eq(proctorEvents.sessionId, id)];
    const cur = qy.cursor ? decodeCursor(qy.cursor) : null;
    if (qy.cursor && !cur) return reply.code(400).send({ error: "invalid_cursor" });
    if (cur) conds.push(sql`${proctorEvents.id} > ${Number(cur.k)}`);

    const rows = await db
      .select()
      .from(proctorEvents)
      .where(and(...conds))
      .orderBy(asc(proctorEvents.id))
      .limit(qy.limit);

    const last = rows[rows.length - 1];
    const nextCursor = rows.length === qy.limit && last ? encodeCursor(last.id, String(last.id)) : null;
    return { events: rows, nextCursor };
  });

  // -------------------- CREATE SESSION (candidate runtime; idempotent) --------------------
  app.post("/sessions", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = startSessionSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "proctor.session.create", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const policy = await resolvePolicy(ctx.orgId, parsed.data.assessmentTemplateId ?? null);
    const snapshot = policySnapshotOf(policy);
    const slaDue = new Date(Date.now() + DEFAULT_REVIEW_SLA_HOURS * 3600_000);

    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(proctorSessions)
        .values({
          orgId: ctx.orgId,
          assessmentAttemptId: parsed.data.assessmentAttemptId ?? null,
          asyncVideoSubmissionId: parsed.data.asyncVideoSubmissionId ?? null,
          candidateId: parsed.data.candidateId ?? null,
          status: "live",
          liveState: "active",
          riskScore: 0,
          policyId: policy?.id ?? null,
          policySnapshot: snapshot,
          reviewSlaDueAt: slaDue,
        })
        .returning();

      // Seed a pending identity-check row when the policy requires identity.
      if (!policy || policy.requireIdentity) {
        await tx
          .insert(proctorIdentityChecks)
          .values({ orgId: ctx.orgId, sessionId: inserted.id, status: "pending" })
          .onConflictDoNothing();
      }

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: inserted.id,
        actorUserId: ctx.id,
        action: "session.view",
        toValue: "created",
        ip: clientIp(req),
      });
      return inserted;
    });

    const response = { session: row };
    if (idemKey) await recordIdempotent(ctx.orgId, "proctor.session.create", idemKey, response);
    return reply.code(201).send(response);
  });

  // -------------------- INGEST EVENT (recompute risk + auto-flag/terminate) --------------------
  app.post("/sessions/:id/events", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [session] = await db
      .select()
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    if (session.status !== "live") return reply.code(409).send({ error: "session_not_live" });

    const offsetMs =
      parsed.data.offsetMs ?? Math.max(0, Date.now() - new Date(session.startedAt).getTime());

    const snap = (session.policySnapshot ?? {}) as Record<string, unknown>;
    const autoFlagAt = typeof snap.autoFlagRiskScore === "number" ? snap.autoFlagRiskScore : 40;
    const autoTerminateAt = typeof snap.autoTerminateRiskScore === "number" ? snap.autoTerminateRiskScore : null;
    const signalConfig = snapshotSignalConfig(session.policySnapshot);

    const result = await db.transaction(async (tx) => {
      await tx.insert(proctorEvents).values({
        sessionId: id,
        kind: parsed.data.kind,
        severity: parsed.data.severity,
        payload: parsed.data.payload ?? null,
        flagged: parsed.data.flagged,
        offsetMs,
        evidenceBlobKey: parsed.data.evidenceBlobKey ?? null,
      });

      // Recompute risk score from ALL flagged events under the policy snapshot.
      const allEvents = await tx
        .select({ kind: proctorEvents.kind, severity: proctorEvents.severity, flagged: proctorEvents.flagged })
        .from(proctorEvents)
        .where(eq(proctorEvents.sessionId, id));
      const riskScore = computeRiskScore(allEvents as RiskEventLike[], signalConfig);
      const flagCount = allEvents.filter((e) => e.flagged).length;

      let liveState: (typeof PROCTOR_LIVE_STATES)[number] = session.liveState;
      let status: (typeof PROCTOR_SESSION_STATUSES)[number] = session.status;
      let endedAt: Date | null = session.endedAt;

      // Auto-terminate crosses first (more severe), else auto-flag warns.
      if (autoTerminateAt != null && riskScore >= autoTerminateAt && session.liveState !== "ended") {
        liveState = "ended";
        status = "completed";
        endedAt = new Date();
        await tx.insert(proctorInterventions).values({
          orgId: ctx.orgId,
          sessionId: id,
          kind: "terminate",
          actorUserId: null,
          message: `Auto-terminated: risk score ${riskScore} ≥ threshold ${autoTerminateAt}`,
        });
        await writeAudit(tx as typeof db, {
          orgId: ctx.orgId,
          sessionId: id,
          actorUserId: null,
          action: "session.terminate",
          fromValue: String(session.riskScore),
          toValue: String(riskScore),
          payload: { auto: true, threshold: autoTerminateAt },
          ip: clientIp(req),
        });
      } else if (riskScore >= autoFlagAt && session.riskScore < autoFlagAt) {
        await tx.insert(proctorInterventions).values({
          orgId: ctx.orgId,
          sessionId: id,
          kind: "warn",
          actorUserId: null,
          message: `Auto-flagged: risk score ${riskScore} ≥ threshold ${autoFlagAt}`,
        });
        await writeAudit(tx as typeof db, {
          orgId: ctx.orgId,
          sessionId: id,
          actorUserId: null,
          action: "intervention.send",
          toValue: "warn",
          payload: { auto: true, riskScore },
          ip: clientIp(req),
        });
      }

      await tx
        .update(proctorSessions)
        .set({ riskScore, flagCount, liveState, status, endedAt, updatedAt: new Date() })
        .where(eq(proctorSessions.id, id));

      return { riskScore, liveState };
    });

    return reply.code(201).send({ ok: true, riskScore: result.riskScore, liveState: result.liveState });
  });

  // -------------------- END SESSION --------------------
  // Reviewer-driven graceful end. Permission-gated like every other state
  // change, and writes a session.terminate audit row inside the same
  // transaction (chain-of-custody — the file invariant on every mutation).
  app.post("/sessions/:id/end", { preHandler: [canIntervene] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [existing] = await db
      .select({ liveState: proctorSessions.liveState, status: proctorSessions.status })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "session_not_found" });

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(proctorSessions)
        .set({ status: "completed", liveState: "ended", endedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
        .returning();
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "session.terminate",
        fromValue: existing.liveState,
        toValue: "ended",
        payload: { via: "end" },
        ip: clientIp(req),
      });
      return updated;
    });

    return { session: row };
  });

  // -------------------- ASSIGN REVIEWER --------------------
  app.post("/sessions/:id/assign", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `proctor.assign.${id}`, idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const [existing] = await db
      .select({ assignedReviewerUserId: proctorSessions.assignedReviewerUserId })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "session_not_found" });

    // Validate the reviewer belongs to the org (when non-null).
    if (parsed.data.reviewerUserId) {
      const [reviewer] = await db
        .select({ id: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, parsed.data.reviewerUserId),
            eq(memberships.orgId, ctx.orgId),
            eq(memberships.status, "active"),
          ),
        )
        .limit(1);
      if (!reviewer) return reply.code(400).send({ error: "reviewer_not_in_org" });
    }

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(proctorSessions)
        .set({ assignedReviewerUserId: parsed.data.reviewerUserId, updatedAt: new Date() })
        .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
        .returning();
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "session.assign",
        fromValue: existing.assignedReviewerUserId ?? null,
        toValue: parsed.data.reviewerUserId ?? null,
        ip: clientIp(req),
      });
      return updated;
    });

    const response = { session: row };
    if (idemKey) await recordIdempotent(ctx.orgId, `proctor.assign.${id}`, idemKey, response);
    return response;
  });

  // -------------------- INTERVENE --------------------
  app.post("/sessions/:id/intervene", { preHandler: [canIntervene] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = interveneSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { kind, message, extendSeconds } = parsed.data;

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `proctor.intervene.${id}`, idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const [session] = await db
      .select()
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const patch: Partial<typeof proctorSessions.$inferInsert> = { updatedAt: new Date() };
    let fromValue: string | null = session.liveState;
    let toValue: string | null = session.liveState;
    let specificAction: ProctorAuditAction | null = null;

    if (kind === "pause") {
      patch.liveState = "paused";
      toValue = "paused";
      specificAction = "session.pause";
    } else if (kind === "resume") {
      patch.liveState = "active";
      toValue = "active";
      specificAction = "session.resume";
    } else if (kind === "terminate") {
      patch.liveState = "ended";
      patch.status = "completed";
      patch.endedAt = new Date();
      toValue = "ended";
      specificAction = "session.terminate";
    } else if (kind === "extend") {
      const base = session.reviewSlaDueAt ?? new Date();
      patch.reviewSlaDueAt = new Date(base.getTime() + (extendSeconds ?? 0) * 1000);
      fromValue = session.reviewSlaDueAt ? session.reviewSlaDueAt.toISOString() : null;
      toValue = patch.reviewSlaDueAt.toISOString();
      specificAction = "session.extend";
    }

    const intervention = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(proctorInterventions)
        .values({ orgId: ctx.orgId, sessionId: id, kind, actorUserId: ctx.id, message: message ?? null, extendSeconds: extendSeconds ?? null })
        .returning();

      if (Object.keys(patch).length > 1) {
        await tx.update(proctorSessions).set(patch).where(eq(proctorSessions.id, id));
      }

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "intervention.send",
        toValue: kind,
        payload: { interventionId: inserted.id, message: message ?? null },
        ip: clientIp(req),
      });
      if (specificAction) {
        await writeAudit(tx as typeof db, {
          orgId: ctx.orgId,
          sessionId: id,
          actorUserId: ctx.id,
          action: specificAction,
          fromValue,
          toValue,
          ip: clientIp(req),
        });
      }
      return inserted;
    });

    const response = { intervention, liveState: patch.liveState ?? session.liveState };
    if (idemKey) await recordIdempotent(ctx.orgId, `proctor.intervene.${id}`, idemKey, response as Record<string, unknown>);
    return reply.code(201).send(response);
  });

  // -------------------- IDENTITY VERIFY --------------------
  app.post("/sessions/:id/identity/verify", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = identityVerifySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [session] = await db
      .select({ id: proctorSessions.id })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const [existing] = await db
      .select()
      .from(proctorIdentityChecks)
      .where(eq(proctorIdentityChecks.sessionId, id))
      .limit(1);

    const row = await db.transaction(async (tx) => {
      let updated;
      if (existing) {
        [updated] = await tx
          .update(proctorIdentityChecks)
          .set({
            status: parsed.data.status,
            notes: parsed.data.notes ?? existing.notes,
            verifiedByUserId: ctx.id,
            verifiedAt: new Date(),
          })
          .where(eq(proctorIdentityChecks.id, existing.id))
          .returning();
      } else {
        [updated] = await tx
          .insert(proctorIdentityChecks)
          .values({
            orgId: ctx.orgId,
            sessionId: id,
            status: parsed.data.status,
            notes: parsed.data.notes ?? null,
            verifiedByUserId: ctx.id,
            verifiedAt: new Date(),
          })
          .returning();
      }

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "identity.verify",
        fromValue: existing?.status ?? null,
        toValue: parsed.data.status,
        ip: clientIp(req),
      });
      return updated;
    });

    return { identity: row };
  });

  // -------------------- IDENTITY MATCH (real-first + stub, precise 503) --------------------
  app.post("/sessions/:id/identity/match", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const real = (req.query as { real?: string } | undefined)?.real === "true";

    const [session] = await db
      .select({ id: proctorSessions.id })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const [identity] = await db
      .select()
      .from(proctorIdentityChecks)
      .where(eq(proctorIdentityChecks.sessionId, id))
      .limit(1);

    let result;
    try {
      // External provider call — kept outside the DB transaction so we never
      // hold a transaction open across a network round-trip.
      result = await runFaceMatch({
        orgId: ctx.orgId,
        idPhotoBlobKey: identity?.idPhotoBlobKey ?? null,
        selfieBlobKey: identity?.selfieBlobKey ?? null,
        real,
      });
    } catch (err) {
      if (err instanceof FaceMatchProviderMissing) {
        return reply.code(503).send({ error: "face_match_provider_missing" });
      }
      throw err;
    }

    // Persist the score and its chain-of-custody audit atomically.
    await db.transaction(async (tx) => {
      if (identity) {
        await tx
          .update(proctorIdentityChecks)
          .set({ matchScore: result.matchScore, matchProvider: result.provider })
          .where(eq(proctorIdentityChecks.id, identity.id));
      } else {
        await tx.insert(proctorIdentityChecks).values({
          orgId: ctx.orgId,
          sessionId: id,
          status: "pending",
          matchScore: result.matchScore,
          matchProvider: result.provider,
        });
      }

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "identity.verify",
        toValue: `match:${result.matchScore}`,
        payload: { provider: result.provider },
        ip: clientIp(req),
      });
    });

    return { matchScore: result.matchScore, provider: result.provider };
  });

  // -------------------- LIVE STREAM TOKEN (real-first + snapshot fallback) --------------------
  app.get("/sessions/:id/stream-token", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [session] = await db
      .select({ id: proctorSessions.id })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    if (getStreamMode() === "snapshot") {
      return { mode: "snapshot" as const };
    }
    try {
      const token = mintViewerToken(id, ctx.id);
      return { mode: "live" as const, ...token };
    } catch (err) {
      if (err instanceof StreamProviderMissing) {
        return reply.code(503).send({ error: "stream_provider_missing" });
      }
      throw err;
    }
  });

  // -------------------- REVIEW (justification required for flag/invalidate) --------------------
  app.post("/sessions/:id/review", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [session] = await db
      .select({ id: proctorSessions.id, reviewerDecision: proctorSessions.reviewerDecision })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    if (session.reviewerDecision && !parsed.data.force) {
      return reply.code(409).send({ error: "already_reviewed", decision: session.reviewerDecision });
    }

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(proctorSessions)
        .set({
          reviewerUserId: ctx.id,
          reviewerDecision: parsed.data.decision,
          reviewerNotes: parsed.data.justification ?? null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
        .returning();

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: id,
        actorUserId: ctx.id,
        action: "session.review",
        fromValue: session.reviewerDecision ?? null,
        toValue: parsed.data.decision,
        payload: parsed.data.justification ? { justification: parsed.data.justification } : null,
        ip: clientIp(req),
      });
      return updated;
    });

    return { session: row };
  });

  // -------------------- EVENT ACK (org check via JOIN) --------------------
  app.post("/events/:eventId/ack", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { eventId } = req.params as { eventId: string };
    const eventIdNum = Number.parseInt(eventId, 10);
    if (!Number.isFinite(eventIdNum)) return reply.code(400).send({ error: "invalid_event_id" });

    const [event] = await db
      .select({ id: proctorEvents.id, sessionId: proctorEvents.sessionId })
      .from(proctorEvents)
      .innerJoin(proctorSessions, eq(proctorSessions.id, proctorEvents.sessionId))
      .where(and(eq(proctorEvents.id, eventIdNum), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!event) return reply.code(404).send({ error: "event_not_found" });

    await db.transaction(async (tx) => {
      await tx.update(proctorEvents).set({ reviewerAcked: true }).where(eq(proctorEvents.id, eventIdNum));
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: event.sessionId,
        actorUserId: ctx.id,
        action: "event.ack",
        toValue: String(eventIdNum),
        ip: clientIp(req),
      });
    });

    return { ok: true };
  });

  // -------------------- AUDIT (chain-of-custody) --------------------
  app.get("/sessions/:id/audit", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [session] = await db
      .select({ id: proctorSessions.id })
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const entries = await db
      .select({
        id: proctorAuditEvents.id,
        action: proctorAuditEvents.action,
        actorUserId: proctorAuditEvents.actorUserId,
        actorName: users.name,
        fromValue: proctorAuditEvents.fromValue,
        toValue: proctorAuditEvents.toValue,
        payload: proctorAuditEvents.payload,
        createdAt: proctorAuditEvents.createdAt,
      })
      .from(proctorAuditEvents)
      .leftJoin(users, eq(users.id, proctorAuditEvents.actorUserId))
      .where(and(eq(proctorAuditEvents.orgId, ctx.orgId), eq(proctorAuditEvents.sessionId, id)))
      .orderBy(desc(proctorAuditEvents.createdAt))
      .limit(200);
    return { entries };
  });

  // -------------------- EVIDENCE EXPORT (writes evidence.export audit) --------------------
  app.get("/sessions/:id/export", { preHandler: [canExport] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const format = (req.query as { format?: string } | undefined)?.format === "csv" ? "csv" : "json";

    const [session] = await db
      .select()
      .from(proctorSessions)
      .where(and(eq(proctorSessions.id, id), eq(proctorSessions.orgId, ctx.orgId)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const events = await db
      .select()
      .from(proctorEvents)
      .where(eq(proctorEvents.sessionId, id))
      .orderBy(asc(proctorEvents.offsetMs));
    const interventions = await db
      .select()
      .from(proctorInterventions)
      .where(eq(proctorInterventions.sessionId, id))
      .orderBy(asc(proctorInterventions.createdAt));
    const [identity] = await db
      .select()
      .from(proctorIdentityChecks)
      .where(eq(proctorIdentityChecks.sessionId, id))
      .limit(1);
    const audit = await db
      .select()
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.orgId, ctx.orgId), eq(proctorAuditEvents.sessionId, id)))
      .orderBy(asc(proctorAuditEvents.createdAt));

    // Single chain-of-custody insert for a read/export — atomic on its own.
    await writeAudit(db, {
      orgId: ctx.orgId,
      sessionId: id,
      actorUserId: ctx.id,
      action: "evidence.export",
      toValue: format,
      ip: clientIp(req),
    });

    if (format === "csv") {
      const lines = ["row_type,kind_or_action,severity_or_actor,detail,at"];
      for (const e of events) {
        lines.push(
          ["event", e.kind, e.severity, JSON.stringify(e.payload ?? {}).replace(/[\n,"]/g, " "), e.createdAt.toISOString()].join(","),
        );
      }
      for (const iv of interventions) {
        lines.push(["intervention", iv.kind, iv.actorUserId ?? "system", (iv.message ?? "").replace(/[\n,"]/g, " "), iv.createdAt.toISOString()].join(","));
      }
      for (const a of audit) {
        lines.push(["audit", a.action, a.actorUserId ?? "system", `${a.fromValue ?? ""}->${a.toValue ?? ""}`, a.createdAt.toISOString()].join(","));
      }
      reply.header("content-type", "text/csv");
      reply.header("content-disposition", `attachment; filename="proctor-${id}.csv"`);
      return lines.join("\n");
    }

    return {
      session,
      events,
      interventions,
      identity: identity ?? null,
      audit,
      exportedAt: new Date().toISOString(),
      exportedByUserId: ctx.id,
    };
  });

  // -------------------- POLICIES --------------------
  app.get("/policies", { preHandler: [canRead] }, async (req) => {
    const ctx = req.authUser!;
    const rows = await db
      .select({
        id: proctorPolicies.id,
        name: proctorPolicies.name,
        assessmentTemplateId: proctorPolicies.assessmentTemplateId,
        assessmentTemplateTitle: assessmentTemplates.title,
        isDefault: proctorPolicies.isDefault,
        signalConfig: proctorPolicies.signalConfig,
        requireIdentity: proctorPolicies.requireIdentity,
        requireWebcam: proctorPolicies.requireWebcam,
        requireScreen: proctorPolicies.requireScreen,
        lockdownBrowser: proctorPolicies.lockdownBrowser,
        autoFlagRiskScore: proctorPolicies.autoFlagRiskScore,
        autoTerminateRiskScore: proctorPolicies.autoTerminateRiskScore,
        updatedAt: proctorPolicies.updatedAt,
      })
      .from(proctorPolicies)
      .leftJoin(assessmentTemplates, eq(assessmentTemplates.id, proctorPolicies.assessmentTemplateId))
      .where(eq(proctorPolicies.orgId, ctx.orgId))
      .orderBy(desc(proctorPolicies.isDefault), desc(proctorPolicies.updatedAt));
    return { policies: rows };
  });

  app.post("/policies", { preHandler: [canPolicy] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "proctor.policy.create", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    // Validate the template belongs to the org (when provided).
    if (parsed.data.assessmentTemplateId) {
      const [tpl] = await db
        .select({ id: assessmentTemplates.id })
        .from(assessmentTemplates)
        .where(
          and(
            eq(assessmentTemplates.id, parsed.data.assessmentTemplateId),
            eq(assessmentTemplates.orgId, ctx.orgId),
          ),
        )
        .limit(1);
      if (!tpl) return reply.code(400).send({ error: "template_not_in_org" });
    }

    try {
      const row = await db.transaction(async (tx) => {
        // If marking default, clear any existing default first (single-default).
        if (parsed.data.isDefault) {
          await tx
            .update(proctorPolicies)
            .set({ isDefault: false })
            .where(and(eq(proctorPolicies.orgId, ctx.orgId), eq(proctorPolicies.isDefault, true)));
        }
        const [inserted] = await tx
          .insert(proctorPolicies)
          .values({
            orgId: ctx.orgId,
            name: parsed.data.name,
            assessmentTemplateId: parsed.data.assessmentTemplateId ?? null,
            isDefault: parsed.data.isDefault,
            signalConfig: parsed.data.signalConfig as ProctorSignalConfig,
            requireIdentity: parsed.data.requireIdentity,
            requireWebcam: parsed.data.requireWebcam,
            requireScreen: parsed.data.requireScreen,
            lockdownBrowser: parsed.data.lockdownBrowser,
            autoFlagRiskScore: parsed.data.autoFlagRiskScore,
            autoTerminateRiskScore: parsed.data.autoTerminateRiskScore,
            createdByUserId: ctx.id,
          })
          .returning();

        await writeAudit(tx as typeof db, {
          orgId: ctx.orgId,
          sessionId: null,
          actorUserId: ctx.id,
          action: "policy.update",
          toValue: inserted.id,
          payload: { name: inserted.name, created: true },
          ip: clientIp(req),
        });
        return inserted;
      });

      const response = { policy: row };
      if (idemKey) await recordIdempotent(ctx.orgId, "proctor.policy.create", idemKey, response);
      return reply.code(201).send(response);
    } catch (err) {
      // Unique-violation on the per-template / single-default partial indexes.
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "policy_conflict" });
      }
      throw err;
    }
  });

  app.patch("/policies/:id", { preHandler: [canPolicy] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = policyPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [existing] = await db
      .select()
      .from(proctorPolicies)
      .where(and(eq(proctorPolicies.id, id), eq(proctorPolicies.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "policy_not_found" });

    const d = parsed.data;
    // Enforce auto-terminate ≥ auto-flag on the merged values.
    const mergedFlag = d.autoFlagRiskScore ?? existing.autoFlagRiskScore;
    const mergedTerminate = d.autoTerminateRiskScore !== undefined ? d.autoTerminateRiskScore : existing.autoTerminateRiskScore;
    if (mergedTerminate != null && mergedTerminate < mergedFlag) {
      return reply.code(400).send({ error: "invalid_payload", issues: { fieldErrors: { autoTerminateRiskScore: ["must be ≥ autoFlagRiskScore"] } } });
    }

    const row = await db.transaction(async (tx) => {
      if (d.isDefault === true && !existing.isDefault) {
        await tx
          .update(proctorPolicies)
          .set({ isDefault: false })
          .where(and(eq(proctorPolicies.orgId, ctx.orgId), eq(proctorPolicies.isDefault, true)));
      }

      const [updated] = await tx
        .update(proctorPolicies)
        .set({
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.isDefault !== undefined ? { isDefault: d.isDefault } : {}),
          ...(d.signalConfig !== undefined ? { signalConfig: d.signalConfig as ProctorSignalConfig } : {}),
          ...(d.requireIdentity !== undefined ? { requireIdentity: d.requireIdentity } : {}),
          ...(d.requireWebcam !== undefined ? { requireWebcam: d.requireWebcam } : {}),
          ...(d.requireScreen !== undefined ? { requireScreen: d.requireScreen } : {}),
          ...(d.lockdownBrowser !== undefined ? { lockdownBrowser: d.lockdownBrowser } : {}),
          ...(d.autoFlagRiskScore !== undefined ? { autoFlagRiskScore: d.autoFlagRiskScore } : {}),
          ...(d.autoTerminateRiskScore !== undefined ? { autoTerminateRiskScore: d.autoTerminateRiskScore } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(proctorPolicies.id, id), eq(proctorPolicies.orgId, ctx.orgId)))
        .returning();

      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        sessionId: null,
        actorUserId: ctx.id,
        action: "policy.update",
        toValue: id,
        payload: { fields: Object.keys(d) },
        ip: clientIp(req),
      });
      return updated;
    });

    return { policy: row };
  });
}

// Re-export so any straggler imports of the legacy constant keep building.
export { PROCTOR_AUDIT_ACTIONS };
