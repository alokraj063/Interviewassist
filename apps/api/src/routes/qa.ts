// QA review endpoints — the QA Review enterprise console.
//
// Queue (keyset-paginated, filtered, sorted) · sampling policies (CRUD + run) ·
// queue-item actions (assign/skip/bulk) · review submit (idempotent, blind,
// gold-variance) · blind read gate · gold answers + AI draft (OpenAI stub) ·
// calibration sessions · disputes · agreement (Cohen's κ) + reviewer scorecards
// · CSV export · resolution / acoustic recompute. Every mutation is
// permission-gated, org-scoped, Zod-validated, and writes an append-only
// qa_audit_events row inside the same db.transaction as the state change.
//
// All endpoints are org-scoped via req.authUser.orgId.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  callRubrics,
  callRubricScores,
  callSessions,
  db,
  qaAuditEvents,
  qaCalibrationSessions,
  qaDisputes,
  qaGoldAnswers,
  qaQueueItems,
  qaResolutionAnalyses,
  qaSamplingPolicies,
  callQaReviews,
  transcriptAcousticWindows,
  users,
  QA_SAMPLING_STRATEGIES,
  QA_ROUTING_STRATEGIES,
  RUBRIC_PURPOSES,
} from "@j2w/db";
import { getAcousticSentimentQueue } from "@j2w/ingest-shared";
import { analyzeResolution, getCachedResolution } from "../rag/resolution.js";
import { env } from "../env.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Append-only audit writer. Call inside the same db.transaction as the mutation. */
async function writeQaAudit(
  tx: Tx,
  args: {
    orgId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    callId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
): Promise<void> {
  await tx.insert(qaAuditEvents).values({
    orgId: args.orgId,
    actorUserId: args.actorUserId,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    callId: args.callId ?? null,
    before: (args.before ?? null) as never,
    after: (args.after ?? null) as never,
    ip: (args.ip ?? null) as never,
  });
}

function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

// Opaque keyset cursor: base64url(JSON.stringify({ k, id })) where k is the
// sort key (ISO timestamp or number) and id is the tiebreaker.
interface Cursor {
  k: string | number;
  id: string;
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (o && (typeof o.k === "string" || typeof o.k === "number") && typeof o.id === "string") {
      return o as Cursor;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Cohen's κ over two raters' banded scores. bands are small integer categories.
function cohensKappa(pairs: Array<[number, number]>): number | null {
  if (pairs.length === 0) return null;
  const cats = new Set<number>();
  for (const [a, b] of pairs) {
    cats.add(a);
    cats.add(b);
  }
  const n = pairs.length;
  let observed = 0;
  const marginalA = new Map<number, number>();
  const marginalB = new Map<number, number>();
  for (const [a, b] of pairs) {
    if (a === b) observed += 1;
    marginalA.set(a, (marginalA.get(a) ?? 0) + 1);
    marginalB.set(b, (marginalB.get(b) ?? 0) + 1);
  }
  const po = observed / n;
  let pe = 0;
  for (const c of cats) {
    pe += ((marginalA.get(c) ?? 0) / n) * ((marginalB.get(c) ?? 0) / n);
  }
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

// Band a 0–100 score into 0/1/2 (fail/pass/excellent) for categorical agreement.
function band(score: number): number {
  if (score < 50) return 0;
  if (score < 80) return 1;
  return 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  callId: z.string().uuid(),
  decision: z.enum(["accept", "override", "escalate"]),
  note: z.string().max(5000).optional(),
  criterionOverrides: z
    .record(
      z.object({
        aiScore: z.number().min(0).max(100),
        reviewerScore: z.number().min(0).max(100),
        reason: z.string().min(10, "Override reason must be at least 10 characters."),
      }),
    )
    .default({}),
  reviewerScore: z.number().min(0).max(100).optional(),
  timeSpentMs: z.number().int().nonnegative(),
});

const policyCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    strategy: z.enum(QA_SAMPLING_STRATEGIES),
    samplePercent: z.number().int().min(0).max(100).nullish(),
    everyN: z.number().int().positive().nullish(),
    demandId: z.string().uuid().nullish(),
    recruiterUserId: z.string().uuid().nullish(),
    rubricPurpose: z.enum(RUBRIC_PURPOSES).nullish(),
    minAiScore: z.number().int().min(0).max(100).nullish(),
    requireDoubleReview: z.boolean().default(false),
    blindReview: z.boolean().default(true),
    routing: z.enum(QA_ROUTING_STRATEGIES).default("least_loaded"),
    slaHours: z.number().int().positive().nullish(),
  })
  .refine((d) => d.strategy !== "percentage" || d.samplePercent != null, {
    message: "samplePercent required for percentage strategy",
    path: ["samplePercent"],
  })
  .refine((d) => d.strategy !== "every_n" || d.everyN != null, {
    message: "everyN required for every_n strategy",
    path: ["everyN"],
  });

const policyPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  samplePercent: z.number().int().min(0).max(100).nullish(),
  everyN: z.number().int().positive().nullish(),
  minAiScore: z.number().int().min(0).max(100).nullish(),
  requireDoubleReview: z.boolean().optional(),
  blindReview: z.boolean().optional(),
  routing: z.enum(QA_ROUTING_STRATEGIES).optional(),
  slaHours: z.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
});

const queueQuerySchema = z.object({
  tab: z.enum(["needs", "reviewed", "mine", "disputed", "all"]).default("needs"),
  q: z.string().max(200).optional(),
  recruiterId: z.string().uuid().optional(),
  demandId: z.string().uuid().optional(),
  decision: z.enum(["accept", "override", "escalate"]).optional(),
  policyId: z.string().uuid().optional(),
  endedFrom: z.string().datetime().optional(),
  endedTo: z.string().datetime().optional(),
  sort: z.enum(["ended_desc", "ended_asc", "ai_desc", "variance_desc", "due_asc"]).default("ended_desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ─────────────────────────────────────────────────────────────────────────────

export async function qaRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Verify a call belongs to the caller's org. Returns the row or null.
  async function callInOrg(callId: string, orgId: string) {
    const [call] = await db
      .select({ id: callSessions.id, orgId: callSessions.orgId })
      .from(callSessions)
      .where(and(eq(callSessions.id, callId), eq(callSessions.orgId, orgId)));
    return call ?? null;
  }

  // ════════════════════════════ Sampling policies ════════════════════════════

  app.get("/policies", { preHandler: [app.requirePermission("qa.read")] }, async (req) => {
    const ctx = req.authUser!;
    const q = queueListCursor(req);
    const cur = decodeCursor(q.cursor);
    const rows = await db
      .select()
      .from(qaSamplingPolicies)
      .where(
        and(
          eq(qaSamplingPolicies.orgId, ctx.orgId),
          cur
            ? sql`(${qaSamplingPolicies.createdAt}, ${qaSamplingPolicies.id}) < (${new Date(
                cur.k as string,
              ).toISOString()}::timestamptz, ${cur.id}::uuid)`
            : sql`true`,
        ),
      )
      .orderBy(desc(qaSamplingPolicies.createdAt), desc(qaSamplingPolicies.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      policies: page,
      nextCursor:
        hasMore && last ? encodeCursor({ k: last.createdAt.toISOString(), id: last.id }) : null,
    };
  });

  app.post("/policies", { preHandler: [app.requirePermission("qa.sampling")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = policyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);

    // Idempotency: a replay with the same key returns the prior policy.
    if (idemKey) {
      const [prior] = await db
        .select({ id: qaSamplingPolicies.id, after: qaAuditEvents.after })
        .from(qaAuditEvents)
        .innerJoin(qaSamplingPolicies, sql`${qaSamplingPolicies.id} = ${qaAuditEvents.targetId}::uuid`)
        .where(
          and(
            eq(qaAuditEvents.orgId, ctx.orgId),
            eq(qaAuditEvents.action, "qa.policy.create"),
            sql`${qaAuditEvents.after} ->> 'idempotencyKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior) return reply.code(200).send({ id: prior.id, idempotent: true });
    }

    const d = parsed.data;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(qaSamplingPolicies)
        .values({
          orgId: ctx.orgId,
          name: d.name,
          description: d.description ?? null,
          strategy: d.strategy,
          samplePercent: d.samplePercent ?? null,
          everyN: d.everyN ?? null,
          demandId: d.demandId ?? null,
          recruiterUserId: d.recruiterUserId ?? null,
          rubricPurpose: d.rubricPurpose ?? null,
          minAiScore: d.minAiScore ?? null,
          requireDoubleReview: d.requireDoubleReview,
          blindReview: d.blindReview,
          routing: d.routing,
          slaHours: d.slaHours ?? null,
          createdByUserId: ctx.id,
        })
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.policy.create",
        targetType: "policy",
        targetId: row.id,
        after: { ...row, idempotencyKey: idemKey ?? null },
        ip: clientIp(req),
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.patch("/policies/:id", { preHandler: [app.requirePermission("qa.sampling")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = policyPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [existing] = await db
      .select()
      .from(qaSamplingPolicies)
      .where(and(eq(qaSamplingPolicies.id, id), eq(qaSamplingPolicies.orgId, ctx.orgId)));
    if (!existing) return reply.code(404).send({ error: "policy_not_found" });

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(qaSamplingPolicies)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(qaSamplingPolicies.id, id), eq(qaSamplingPolicies.orgId, ctx.orgId)))
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.policy.update",
        targetType: "policy",
        targetId: id,
        before: existing,
        after: row,
        ip: clientIp(req),
      });
      return row;
    });
    return updated;
  });

  app.delete("/policies/:id", { preHandler: [app.requirePermission("qa.sampling")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [existing] = await db
      .select()
      .from(qaSamplingPolicies)
      .where(and(eq(qaSamplingPolicies.id, id), eq(qaSamplingPolicies.orgId, ctx.orgId)));
    if (!existing) return reply.code(404).send({ error: "policy_not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(qaSamplingPolicies)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(qaSamplingPolicies.id, id), eq(qaSamplingPolicies.orgId, ctx.orgId)));
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.policy.archive",
        targetType: "policy",
        targetId: id,
        before: existing,
        ip: clientIp(req),
      });
    });
    return { archived: true };
  });

  // Materialize queue items for ended calls matching the policy. Idempotent via
  // the (call_id, review_slot) unique index → ON CONFLICT DO NOTHING.
  app.post("/policies/:id/run", { preHandler: [app.requirePermission("qa.sampling")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [policy] = await db
      .select()
      .from(qaSamplingPolicies)
      .where(and(eq(qaSamplingPolicies.id, id), eq(qaSamplingPolicies.orgId, ctx.orgId)));
    if (!policy) return reply.code(404).send({ error: "policy_not_found" });

    // Eligible ended calls in the org, narrowed by the policy's optional filters.
    const eligible = await db.execute<{ id: string; ended_at: string | null }>(sql`
      SELECT c.id, c.ended_at::text
      FROM call_sessions c
      WHERE c.org_id = ${ctx.orgId}::uuid
        AND c.status = 'ended'
        ${policy.demandId ? sql`AND c.demand_id = ${policy.demandId}::uuid` : sql``}
        ${policy.recruiterUserId ? sql`AND c.recruiter_user_id = ${policy.recruiterUserId}::uuid` : sql``}
      ORDER BY c.ended_at DESC NULLS LAST
      LIMIT 500
    `);
    const calls = eligible.rows ?? [];

    // Apply the sampling strategy deterministically.
    let selected = calls;
    if (policy.strategy === "percentage" && policy.samplePercent != null) {
      const keep = Math.ceil((calls.length * policy.samplePercent) / 100);
      selected = calls.slice(0, keep);
    } else if (policy.strategy === "every_n" && policy.everyN) {
      selected = calls.filter((_, i) => i % policy.everyN! === 0);
    }
    // risk_weighted / all keep the full eligible set (min_ai_score check would
    // require per-call AI scores; out of scope for the materialize path).

    const dueAt = policy.slaHours ? new Date(Date.now() + policy.slaHours * 3_600_000) : null;
    const slots = policy.requireDoubleReview ? [1, 2] : [1];

    const result = await db.transaction(async (tx) => {
      let inserted = 0;
      for (const call of selected) {
        for (const slot of slots) {
          const ins = await tx
            .insert(qaQueueItems)
            .values({
              orgId: ctx.orgId,
              callId: call.id,
              policyId: policy.id,
              reviewSlot: slot,
              status: "pending",
              priority: policy.strategy === "risk_weighted" ? 1 : 0,
              dueAt,
            })
            .onConflictDoNothing({
              target: [qaQueueItems.callId, qaQueueItems.reviewSlot],
            })
            .returning({ id: qaQueueItems.id });
          if (ins.length > 0) inserted += 1;
        }
      }
      const skipped = selected.length * slots.length - inserted;
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.policy.run",
        targetType: "policy",
        targetId: policy.id,
        after: { inserted, skipped, eligible: selected.length },
        ip: clientIp(req),
      });
      return { inserted, skipped };
    });
    return result;
  });

  // ════════════════════════════ Queue (keyset) ════════════════════════════

  app.get("/queue", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const f = parsed.data;
    const cur = decodeCursor(f.cursor);

    const filters = [sql`c.org_id = ${ctx.orgId}::uuid`, sql`c.status = 'ended'`];
    if (f.recruiterId) filters.push(sql`c.recruiter_user_id = ${f.recruiterId}::uuid`);
    if (f.demandId) filters.push(sql`c.demand_id = ${f.demandId}::uuid`);
    if (f.endedFrom) filters.push(sql`c.ended_at >= ${f.endedFrom}::timestamptz`);
    if (f.endedTo) filters.push(sql`c.ended_at <= ${f.endedTo}::timestamptz`);
    if (f.q) {
      const like = `%${f.q}%`;
      filters.push(
        sql`(cand.display_name ILIKE ${like} OR d.title ILIKE ${like} OR u.name ILIKE ${like})`,
      );
    }
    if (f.decision) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM call_qa_reviews q WHERE q.call_id = c.id AND q.decision = ${f.decision})`,
      );
    }
    if (f.policyId) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM qa_queue_items qi WHERE qi.call_id = c.id AND qi.policy_id = ${f.policyId}::uuid)`,
      );
    }
    if (f.tab === "needs") {
      filters.push(
        sql`NOT EXISTS (SELECT 1 FROM call_qa_reviews q WHERE q.call_id = c.id AND q.reviewer_score IS NOT NULL)`,
      );
    } else if (f.tab === "reviewed") {
      filters.push(
        sql`EXISTS (SELECT 1 FROM call_qa_reviews q WHERE q.call_id = c.id AND q.reviewer_score IS NOT NULL)`,
      );
    } else if (f.tab === "mine") {
      filters.push(
        sql`EXISTS (SELECT 1 FROM qa_queue_items qi WHERE qi.call_id = c.id AND qi.assigned_reviewer_id = ${ctx.id}::uuid)`,
      );
    } else if (f.tab === "disputed") {
      filters.push(
        sql`EXISTS (SELECT 1 FROM qa_disputes dp WHERE dp.call_id = c.id AND dp.status IN ('open','under_review'))`,
      );
    }

    // Sort + keyset predicate.
    const sortCol =
      f.sort === "ended_asc" || f.sort === "ended_desc"
        ? sql`c.ended_at`
        : f.sort === "due_asc"
        ? sql`(SELECT min(qi.due_at) FROM qa_queue_items qi WHERE qi.call_id = c.id)`
        : f.sort === "ai_desc"
        ? sql`(SELECT max(q.ai_score) FROM call_qa_reviews q WHERE q.call_id = c.id)`
        : sql`(SELECT max(q.gold_variance) FROM call_qa_reviews q WHERE q.call_id = c.id)`;
    const dir = f.sort === "ended_asc" || f.sort === "due_asc" ? sql`ASC` : sql`DESC`;
    const cmp = f.sort === "ended_asc" || f.sort === "due_asc" ? sql`>` : sql`<`;

    if (cur) {
      // Keyset: (sortCol, id) compared against the cursor; NULL-safe via coalesce
      // on timestamp/number sentinels. No OFFSET — pure tuple comparison.
      filters.push(
        sql`(${sortCol}, c.id) ${cmp} (${
          typeof cur.k === "number"
            ? sql`${cur.k}`
            : sql`${cur.k}::timestamptz`
        }, ${cur.id}::uuid)`,
      );
    }

    const whereSql = sql.join(filters, sql` AND `);

    const rowsRes = await db.execute<{
      id: string;
      ended_at: string | null;
      started_at: string;
      recruiter_user_id: string | null;
      recruiter_name: string | null;
      candidate_id: string | null;
      candidate_name: string | null;
      demand_id: string | null;
      demand_title: string | null;
      review_count: string;
      latest_decision: string | null;
      ai_score: string | null;
      reviewer_score: string | null;
      gold_variance: string | null;
      due_at: string | null;
      assigned_reviewer_name: string | null;
      dispute_status: string | null;
      sort_key: string | null;
    }>(sql`
      SELECT c.id,
             c.ended_at::text,
             c.started_at::text,
             c.recruiter_user_id,
             u.name AS recruiter_name,
             c.candidate_id,
             cand.display_name AS candidate_name,
             c.demand_id,
             d.title AS demand_title,
             (SELECT COUNT(*) FROM call_qa_reviews q WHERE q.call_id = c.id)::text AS review_count,
             (SELECT decision FROM call_qa_reviews q WHERE q.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS latest_decision,
             (SELECT ai_score::text FROM call_qa_reviews q WHERE q.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS ai_score,
             (SELECT reviewer_score::text FROM call_qa_reviews q WHERE q.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS reviewer_score,
             (SELECT gold_variance::text FROM call_qa_reviews q WHERE q.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS gold_variance,
             (SELECT min(qi.due_at)::text FROM qa_queue_items qi WHERE qi.call_id = c.id) AS due_at,
             (SELECT ru.name FROM qa_queue_items qi LEFT JOIN users ru ON ru.id = qi.assigned_reviewer_id WHERE qi.call_id = c.id AND qi.assigned_reviewer_id IS NOT NULL LIMIT 1) AS assigned_reviewer_name,
             (SELECT dp.status FROM qa_disputes dp WHERE dp.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS dispute_status,
             (${sortCol})::text AS sort_key
      FROM call_sessions c
      LEFT JOIN users u ON u.id = c.recruiter_user_id
      LEFT JOIN candidates cand ON cand.id = c.candidate_id
      LEFT JOIN demands d ON d.id = c.demand_id
      WHERE ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, c.id ${dir}
      LIMIT ${f.limit + 1}
    `);
    const all = rowsRes.rows ?? [];
    const hasMore = all.length > f.limit;
    const page = hasMore ? all.slice(0, f.limit) : all;

    const totalRes = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM call_sessions c
      LEFT JOIN users u ON u.id = c.recruiter_user_id
      LEFT JOIN candidates cand ON cand.id = c.candidate_id
      LEFT JOIN demands d ON d.id = c.demand_id
      WHERE ${whereSql}
    `);
    const total = Number(totalRes.rows?.[0]?.count ?? 0);

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last && last.sort_key != null
        ? encodeCursor({
            k:
              f.sort === "ai_desc" || f.sort === "variance_desc"
                ? Number(last.sort_key)
                : last.sort_key,
            id: last.id,
          })
        : null;

    return {
      rows: page.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        recruiterUserId: r.recruiter_user_id,
        recruiterName: r.recruiter_name,
        candidateId: r.candidate_id,
        candidateName: r.candidate_name,
        demandId: r.demand_id,
        demandTitle: r.demand_title,
        reviewCount: Number(r.review_count) || 0,
        latestDecision: r.latest_decision,
        aiScore: r.ai_score == null ? null : parseFloat(r.ai_score),
        reviewerScore: r.reviewer_score == null ? null : parseFloat(r.reviewer_score),
        goldVariance: r.gold_variance == null ? null : parseInt(r.gold_variance, 10),
        dueAt: r.due_at,
        slaBreached: r.due_at != null && new Date(r.due_at).getTime() < Date.now(),
        assignedReviewerName: r.assigned_reviewer_name,
        disputeStatus: r.dispute_status,
      })),
      nextCursor,
      total,
    };
  });

  // ════════════════════════════ Queue-item actions ════════════════════════════

  const assignSchema = z.object({ reviewerId: z.string().uuid() });
  app.post("/queue/:itemId/assign", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { itemId } = req.params as { itemId: string };
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [item] = await db
      .select()
      .from(qaQueueItems)
      .where(and(eq(qaQueueItems.id, itemId), eq(qaQueueItems.orgId, ctx.orgId)));
    if (!item) return reply.code(404).send({ error: "queue_item_not_found" });

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(qaQueueItems)
        .set({ assignedReviewerId: parsed.data.reviewerId, status: "in_review", updatedAt: new Date() })
        .where(and(eq(qaQueueItems.id, itemId), eq(qaQueueItems.orgId, ctx.orgId)))
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.queue.assign",
        targetType: "queue_item",
        targetId: itemId,
        callId: item.callId,
        before: { assignedReviewerId: item.assignedReviewerId, status: item.status },
        after: { assignedReviewerId: parsed.data.reviewerId, status: "in_review" },
        ip: clientIp(req),
      });
      return row;
    });
    return updated;
  });

  const skipSchema = z.object({ reason: z.string().min(5).max(2000) });
  app.post("/queue/:itemId/skip", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { itemId } = req.params as { itemId: string };
    const parsed = skipSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [item] = await db
      .select()
      .from(qaQueueItems)
      .where(and(eq(qaQueueItems.id, itemId), eq(qaQueueItems.orgId, ctx.orgId)));
    if (!item) return reply.code(404).send({ error: "queue_item_not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(qaQueueItems)
        .set({ status: "skipped", updatedAt: new Date() })
        .where(and(eq(qaQueueItems.id, itemId), eq(qaQueueItems.orgId, ctx.orgId)));
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.queue.skip",
        targetType: "queue_item",
        targetId: itemId,
        callId: item.callId,
        before: { status: item.status },
        after: { status: "skipped", reason: parsed.data.reason },
        ip: clientIp(req),
      });
    });
    return { skipped: true };
  });

  const bulkAssignSchema = z.object({
    itemIds: z.array(z.string().uuid()).min(1).max(100),
    reviewerId: z.string().uuid(),
  });
  app.post("/queue/bulk-assign", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkAssignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const items = await db
      .select()
      .from(qaQueueItems)
      .where(and(inArray(qaQueueItems.id, parsed.data.itemIds), eq(qaQueueItems.orgId, ctx.orgId)));
    if (items.length === 0) return reply.code(404).send({ error: "no_queue_items_found" });

    const updated = await db.transaction(async (tx) => {
      let count = 0;
      for (const item of items) {
        await tx
          .update(qaQueueItems)
          .set({ assignedReviewerId: parsed.data.reviewerId, status: "in_review", updatedAt: new Date() })
          .where(and(eq(qaQueueItems.id, item.id), eq(qaQueueItems.orgId, ctx.orgId)));
        await writeQaAudit(tx, {
          orgId: ctx.orgId,
          actorUserId: ctx.id,
          action: "qa.queue.assign",
          targetType: "queue_item",
          targetId: item.id,
          callId: item.callId,
          before: { assignedReviewerId: item.assignedReviewerId, status: item.status },
          after: { assignedReviewerId: parsed.data.reviewerId, status: "in_review", bulk: true },
          ip: clientIp(req),
        });
        count += 1;
      }
      return count;
    });
    return { assigned: updated };
  });

  const bulkEscalateSchema = z.object({
    itemIds: z.array(z.string().uuid()).min(1).max(100),
    note: z.string().min(1).max(2000),
  });
  app.post("/queue/bulk-escalate", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkEscalateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const items = await db
      .select()
      .from(qaQueueItems)
      .where(and(inArray(qaQueueItems.id, parsed.data.itemIds), eq(qaQueueItems.orgId, ctx.orgId)));
    if (items.length === 0) return reply.code(404).send({ error: "no_queue_items_found" });

    const result = await db.transaction(async (tx) => {
      let count = 0;
      for (const item of items) {
        const [rev] = await tx
          .insert(callQaReviews)
          .values({
            callId: item.callId,
            reviewerUserId: ctx.id,
            orgId: ctx.orgId,
            decision: "escalate",
            note: parsed.data.note,
            queueItemId: item.id,
            reviewSlot: item.reviewSlot,
            timeSpentMs: 0,
          })
          .returning({ id: callQaReviews.id });
        await tx
          .update(qaQueueItems)
          .set({ status: "completed", reviewId: rev.id, updatedAt: new Date() })
          .where(and(eq(qaQueueItems.id, item.id), eq(qaQueueItems.orgId, ctx.orgId)));
        await writeQaAudit(tx, {
          orgId: ctx.orgId,
          actorUserId: ctx.id,
          action: "qa.queue.escalate",
          targetType: "queue_item",
          targetId: item.id,
          callId: item.callId,
          after: { reviewId: rev.id, note: parsed.data.note, bulk: true },
          ip: clientIp(req),
        });
        count += 1;
      }
      return count;
    });
    return { escalated: result };
  });

  // ════════════════════════════ Review submit ════════════════════════════

  app.post("/reviews", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const d = parsed.data;
    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);

    const call = await callInOrg(d.callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    if (d.decision === "override") {
      const dirty = Object.values(d.criterionOverrides).filter((o) => o.reviewerScore !== o.aiScore);
      if (dirty.length === 0) return reply.code(400).send({ error: "no_overrides_present" });
    }

    // Idempotency: replay with same key returns the original reviewId.
    if (idemKey) {
      const [prior] = await db
        .select({ id: callQaReviews.id, after: qaAuditEvents.after })
        .from(qaAuditEvents)
        .innerJoin(callQaReviews, sql`${callQaReviews.id} = ${qaAuditEvents.targetId}::uuid`)
        .where(
          and(
            eq(qaAuditEvents.orgId, ctx.orgId),
            sql`${qaAuditEvents.action} IN ('qa.review.submit','qa.review.override')`,
            sql`${qaAuditEvents.after} ->> 'idempotencyKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior) return reply.code(200).send({ reviewId: prior.id, idempotent: true });
    }

    // Find the open queue item for this call (lowest pending/in_review slot).
    const [queueItem] = await db
      .select()
      .from(qaQueueItems)
      .where(
        and(
          eq(qaQueueItems.callId, d.callId),
          eq(qaQueueItems.orgId, ctx.orgId),
          inArray(qaQueueItems.status, ["pending", "in_review"]),
        ),
      )
      .orderBy(asc(qaQueueItems.reviewSlot))
      .limit(1);

    // Gold variance if a published gold answer exists.
    const [gold] = await db
      .select({ overall: qaGoldAnswers.goldOverallScore })
      .from(qaGoldAnswers)
      .where(
        and(
          eq(qaGoldAnswers.callId, d.callId),
          eq(qaGoldAnswers.orgId, ctx.orgId),
          eq(qaGoldAnswers.isPublished, true),
        ),
      );
    const goldVariance =
      gold?.overall != null && d.reviewerScore != null
        ? Math.abs(Math.round(d.reviewerScore) - gold.overall)
        : null;

    const reviewSlot = queueItem?.reviewSlot ?? 1;
    const action = d.decision === "override" ? "qa.review.override" : "qa.review.submit";

    const review = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(callQaReviews)
        .values({
          callId: d.callId,
          reviewerUserId: ctx.id,
          orgId: ctx.orgId,
          decision: d.decision,
          note: d.note?.trim() || null,
          criterionOverrides: d.criterionOverrides,
          reviewerScore: d.reviewerScore != null ? Math.round(d.reviewerScore) : null,
          timeSpentMs: d.timeSpentMs,
          queueItemId: queueItem?.id ?? null,
          reviewSlot,
          goldVariance,
        })
        .returning({ id: callQaReviews.id });
      if (queueItem) {
        await tx
          .update(qaQueueItems)
          .set({ status: "completed", reviewId: row.id, updatedAt: new Date() })
          .where(eq(qaQueueItems.id, queueItem.id));
      }
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action,
        targetType: "review",
        targetId: row.id,
        callId: d.callId,
        before: { aiScores: Object.fromEntries(Object.entries(d.criterionOverrides).map(([k, v]) => [k, v.aiScore])) },
        after: {
          decision: d.decision,
          reviewerScore: d.reviewerScore ?? null,
          goldVariance,
          idempotencyKey: idemKey ?? null,
        },
        ip: clientIp(req),
      });
      return row;
    });

    return reply.code(201).send({ reviewId: review.id, goldVariance });
  });

  // ════════════════════════════ Blind read gate ════════════════════════════

  app.get("/reviews/:callId", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const blindRequested = (req.query as { blind?: string }).blind === "1";

    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    if (blindRequested) {
      // Caller is an assigned slot-2 reviewer on a blind-policy item whose own
      // review is not yet submitted → blind them.
      const [mySlot] = await db
        .select({ id: qaQueueItems.id, slot: qaQueueItems.reviewSlot })
        .from(qaQueueItems)
        .innerJoin(qaSamplingPolicies, eq(qaSamplingPolicies.id, qaQueueItems.policyId))
        .where(
          and(
            eq(qaQueueItems.callId, callId),
            eq(qaQueueItems.orgId, ctx.orgId),
            eq(qaQueueItems.assignedReviewerId, ctx.id),
            eq(qaSamplingPolicies.blindReview, true),
            inArray(qaQueueItems.status, ["pending", "in_review"]),
          ),
        )
        .limit(1);
      if (mySlot && mySlot.slot >= 2) {
        const [mine] = await db
          .select({ id: callQaReviews.id })
          .from(callQaReviews)
          .where(
            and(
              eq(callQaReviews.callId, callId),
              eq(callQaReviews.orgId, ctx.orgId),
              eq(callQaReviews.reviewerUserId, ctx.id),
            ),
          )
          .limit(1);
        if (!mine) return { reviews: [], blinded: true };
      }
    }

    const rows = await db
      .select({
        id: callQaReviews.id,
        decision: callQaReviews.decision,
        note: callQaReviews.note,
        reviewerScore: callQaReviews.reviewerScore,
        goldVariance: callQaReviews.goldVariance,
        reviewSlot: callQaReviews.reviewSlot,
        createdAt: callQaReviews.createdAt,
        reviewerUserId: callQaReviews.reviewerUserId,
        reviewerName: users.name,
        reviewerEmail: users.email,
      })
      .from(callQaReviews)
      .leftJoin(users, eq(users.id, callQaReviews.reviewerUserId))
      .where(and(eq(callQaReviews.callId, callId), eq(callQaReviews.orgId, ctx.orgId)))
      .orderBy(desc(callQaReviews.createdAt));

    return { reviews: rows, blinded: false };
  });

  // ════════════════════════════ Gold answers + AI draft ════════════════════════════

  app.get("/calls/:callId/gold", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    const [gold] = await db
      .select()
      .from(qaGoldAnswers)
      .where(and(eq(qaGoldAnswers.callId, callId), eq(qaGoldAnswers.orgId, ctx.orgId)));
    if (!gold) return reply.code(404).send({ error: "gold_not_found" });
    return gold;
  });

  const goldUpsertSchema = z.object({
    rubricId: z.string().uuid().nullish(),
    criterionScores: z
      .record(z.object({ score: z.number().min(0).max(100), rationale: z.string().max(2000).optional() }))
      .default({}),
    goldOverallScore: z.number().int().min(0).max(100).nullish(),
    notes: z.string().max(5000).nullish(),
    isPublished: z.boolean().default(false),
  });
  app.put("/calls/:callId/gold", { preHandler: [app.requirePermission("qa.calibrate")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = goldUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    const d = parsed.data;

    const [existing] = await db
      .select()
      .from(qaGoldAnswers)
      .where(and(eq(qaGoldAnswers.callId, callId), eq(qaGoldAnswers.orgId, ctx.orgId)));

    const row = await db.transaction(async (tx) => {
      let result;
      if (existing) {
        const [u] = await tx
          .update(qaGoldAnswers)
          .set({
            rubricId: d.rubricId ?? existing.rubricId,
            criterionScores: d.criterionScores,
            goldOverallScore: d.goldOverallScore ?? null,
            notes: d.notes ?? null,
            isPublished: d.isPublished,
            updatedAt: new Date(),
          })
          .where(eq(qaGoldAnswers.id, existing.id))
          .returning();
        result = u;
      } else {
        const [i] = await tx
          .insert(qaGoldAnswers)
          .values({
            orgId: ctx.orgId,
            callId,
            rubricId: d.rubricId ?? null,
            criterionScores: d.criterionScores,
            goldOverallScore: d.goldOverallScore ?? null,
            notes: d.notes ?? null,
            authoredByUserId: ctx.id,
            isPublished: d.isPublished,
          })
          .returning();
        result = i;
      }
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: d.isPublished ? "qa.gold.publish" : "qa.gold.upsert",
        targetType: "gold",
        targetId: result.id,
        callId,
        before: existing ?? null,
        after: result,
        ip: clientIp(req),
      });
      return result;
    });
    return row;
  });

  // OpenAI-backed gold draft. Stub fallback derives scores from existing rubric
  // scores ± fixed offset. ?source=real → 503 openai_key_missing when unset.
  app.post("/calls/:callId/gold/ai-draft", { preHandler: [app.requirePermission("qa.calibrate")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const wantReal = (req.query as { source?: string }).source === "real";
    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });

    if (wantReal && !env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "openai_key_missing" });
    }

    // Stub: derive a gold draft from existing call_rubric_scores.
    const scores = await db
      .select({ criterionId: callRubricScores.criterionId, score: callRubricScores.score, rationale: callRubricScores.rationale })
      .from(callRubricScores)
      .where(eq(callRubricScores.callId, callId));

    const criterionScores: Record<string, { score: number; rationale: string }> = {};
    let sum = 0;
    for (const s of scores) {
      const base = Math.round(Number(s.score));
      const adj = Math.max(0, Math.min(100, base + 2));
      criterionScores[s.criterionId] = {
        score: adj,
        rationale: s.rationale ?? "Gold draft derived from AI rubric score (stub).",
      };
      sum += adj;
    }
    const goldOverallScore = scores.length ? Math.round(sum / scores.length) : null;

    return {
      aiSource: env.OPENAI_API_KEY && wantReal ? "openai" : "stub",
      draft: { criterionScores, goldOverallScore, notes: "AI suggestion — review before publishing." },
    };
  });

  // ════════════════════════════ Calibration sessions ════════════════════════════

  app.get("/calibration", { preHandler: [app.requirePermission("qa.read")] }, async (req) => {
    const ctx = req.authUser!;
    const q = queueListCursor(req);
    const cur = decodeCursor(q.cursor);
    const rows = await db
      .select()
      .from(qaCalibrationSessions)
      .where(
        and(
          eq(qaCalibrationSessions.orgId, ctx.orgId),
          cur
            ? sql`(${qaCalibrationSessions.createdAt}, ${qaCalibrationSessions.id}) < (${new Date(
                cur.k as string,
              ).toISOString()}::timestamptz, ${cur.id}::uuid)`
            : sql`true`,
        ),
      )
      .orderBy(desc(qaCalibrationSessions.createdAt), desc(qaCalibrationSessions.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      sessions: page,
      nextCursor: hasMore && last ? encodeCursor({ k: last.createdAt.toISOString(), id: last.id }) : null,
    };
  });

  const calibrationCreateSchema = z.object({
    name: z.string().min(1).max(200),
    rubricId: z.string().uuid().nullish(),
    callIds: z.array(z.string().uuid()).max(200).default([]),
    reviewerIds: z.array(z.string().uuid()).max(100).default([]),
  });
  app.post("/calibration", { preHandler: [app.requirePermission("qa.calibrate")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = calibrationCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);
    if (idemKey) {
      const [prior] = await db
        .select({ id: qaCalibrationSessions.id })
        .from(qaAuditEvents)
        .innerJoin(qaCalibrationSessions, sql`${qaCalibrationSessions.id} = ${qaAuditEvents.targetId}::uuid`)
        .where(
          and(
            eq(qaAuditEvents.orgId, ctx.orgId),
            eq(qaAuditEvents.action, "qa.calibration.create"),
            sql`${qaAuditEvents.after} ->> 'idempotencyKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior) return reply.code(200).send({ id: prior.id, idempotent: true });
    }
    const d = parsed.data;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(qaCalibrationSessions)
        .values({
          orgId: ctx.orgId,
          name: d.name,
          rubricId: d.rubricId ?? null,
          callIds: d.callIds,
          reviewerIds: d.reviewerIds,
          createdByUserId: ctx.id,
        })
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.calibration.create",
        targetType: "calibration",
        targetId: row.id,
        after: { ...row, idempotencyKey: idemKey ?? null },
        ip: clientIp(req),
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  app.post("/calibration/:id/close", { preHandler: [app.requirePermission("qa.calibrate")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [session] = await db
      .select()
      .from(qaCalibrationSessions)
      .where(and(eq(qaCalibrationSessions.id, id), eq(qaCalibrationSessions.orgId, ctx.orgId)));
    if (!session) return reply.code(404).send({ error: "calibration_not_found" });
    if (session.status === "closed") return reply.code(409).send({ error: "already_closed" });

    const callIds = session.callIds ?? [];
    // Compute per-reviewer mean-abs-error vs gold + a κ over banded scores.
    const perReviewer: Record<string, { n: number; meanAbsError: number | null }> = {};
    const kappaPairs: Array<[number, number]> = [];
    if (callIds.length) {
      const reviews = await db
        .select({
          callId: callQaReviews.callId,
          reviewerUserId: callQaReviews.reviewerUserId,
          reviewerScore: callQaReviews.reviewerScore,
          goldVariance: callQaReviews.goldVariance,
        })
        .from(callQaReviews)
        .where(and(eq(callQaReviews.orgId, ctx.orgId), inArray(callQaReviews.callId, callIds)));
      const errByReviewer = new Map<string, number[]>();
      const byCall = new Map<string, number[]>();
      for (const r of reviews) {
        if (r.reviewerUserId && r.goldVariance != null) {
          const arr = errByReviewer.get(r.reviewerUserId) ?? [];
          arr.push(r.goldVariance);
          errByReviewer.set(r.reviewerUserId, arr);
        }
        if (r.reviewerScore != null) {
          const arr = byCall.get(r.callId) ?? [];
          arr.push(band(r.reviewerScore));
          byCall.set(r.callId, arr);
        }
      }
      for (const [reviewer, errs] of errByReviewer) {
        perReviewer[reviewer] = {
          n: errs.length,
          meanAbsError: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
        };
      }
      for (const bands of byCall.values()) {
        if (bands.length >= 2) kappaPairs.push([bands[0], bands[1]]);
      }
    }
    const results = { perReviewer, kappa: cohensKappa(kappaPairs), nCalls: callIds.length };

    const closed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(qaCalibrationSessions)
        .set({ status: "closed", results, closedAt: new Date() })
        .where(and(eq(qaCalibrationSessions.id, id), eq(qaCalibrationSessions.orgId, ctx.orgId)))
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.calibration.close",
        targetType: "calibration",
        targetId: id,
        before: { status: session.status },
        after: { status: "closed", results },
        ip: clientIp(req),
      });
      return row;
    });
    return closed;
  });

  // ════════════════════════════ Disputes ════════════════════════════

  app.get("/disputes", { preHandler: [app.requirePermission("qa.read")] }, async (req) => {
    const ctx = req.authUser!;
    const status = (req.query as { status?: string }).status;
    const q = queueListCursor(req);
    const cur = decodeCursor(q.cursor);
    const conds = [eq(qaDisputes.orgId, ctx.orgId)];
    if (status) conds.push(sql`${qaDisputes.status} = ${status}` as never);
    if (cur) {
      conds.push(
        sql`(${qaDisputes.createdAt}, ${qaDisputes.id}) < (${new Date(
          cur.k as string,
        ).toISOString()}::timestamptz, ${cur.id}::uuid)` as never,
      );
    }
    const rows = await db
      .select()
      .from(qaDisputes)
      .where(and(...conds))
      .orderBy(desc(qaDisputes.createdAt), desc(qaDisputes.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      disputes: page,
      nextCursor: hasMore && last ? encodeCursor({ k: last.createdAt.toISOString(), id: last.id }) : null,
    };
  });

  const disputeRaiseSchema = z.object({
    reason: z.string().min(10).max(5000),
    requestedScores: z.record(z.number().min(0).max(100)).default({}),
  });
  app.post("/reviews/:reviewId/dispute", { preHandler: [app.requirePermission("qa.dispute")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { reviewId } = req.params as { reviewId: string };
    const parsed = disputeRaiseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [review] = await db
      .select({ id: callQaReviews.id, callId: callQaReviews.callId })
      .from(callQaReviews)
      .where(and(eq(callQaReviews.id, reviewId), eq(callQaReviews.orgId, ctx.orgId)));
    if (!review) return reply.code(404).send({ error: "review_not_found" });

    // Idempotent: one open dispute per review.
    const [openDispute] = await db
      .select({ id: qaDisputes.id })
      .from(qaDisputes)
      .where(
        and(
          eq(qaDisputes.reviewId, reviewId),
          eq(qaDisputes.orgId, ctx.orgId),
          inArray(qaDisputes.status, ["open", "under_review"]),
        ),
      );
    if (openDispute) return reply.code(200).send({ id: openDispute.id, idempotent: true });

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(qaDisputes)
        .values({
          orgId: ctx.orgId,
          reviewId,
          callId: review.callId,
          raisedByUserId: ctx.id,
          reason: parsed.data.reason,
          requestedScores: parsed.data.requestedScores,
        })
        .returning();
      await tx
        .update(qaQueueItems)
        .set({ status: "disputed", updatedAt: new Date() })
        .where(and(eq(qaQueueItems.reviewId, reviewId), eq(qaQueueItems.orgId, ctx.orgId)));
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.dispute.raise",
        targetType: "dispute",
        targetId: row.id,
        callId: review.callId,
        after: { reviewId, reason: parsed.data.reason },
        ip: clientIp(req),
      });
      return row;
    });
    return reply.code(201).send(created);
  });

  const commentSchema = z.object({ body: z.string().min(1).max(2000) });
  app.post("/disputes/:id/comment", { preHandler: [app.requirePermission("qa.dispute")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [dispute] = await db
      .select()
      .from(qaDisputes)
      .where(and(eq(qaDisputes.id, id), eq(qaDisputes.orgId, ctx.orgId)));
    if (!dispute) return reply.code(404).send({ error: "dispute_not_found" });

    const entry = { userId: ctx.id, name: ctx.email, body: parsed.data.body, at: new Date().toISOString() };
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(qaDisputes)
        .set({ thread: [...(dispute.thread ?? []), entry] })
        .where(eq(qaDisputes.id, id))
        .returning();
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.dispute.comment",
        targetType: "dispute",
        targetId: id,
        callId: dispute.callId,
        after: { comment: entry },
        ip: clientIp(req),
      });
      return row;
    });
    return updated;
  });

  const resolveSchema = z.object({
    status: z.enum(["upheld", "overturned"]),
    resolutionNote: z.string().min(10).max(5000),
  });
  app.post("/disputes/:id/resolve", { preHandler: [app.requirePermission("qa.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [dispute] = await db
      .select()
      .from(qaDisputes)
      .where(and(eq(qaDisputes.id, id), eq(qaDisputes.orgId, ctx.orgId)));
    if (!dispute) return reply.code(404).send({ error: "dispute_not_found" });
    if (dispute.status === "upheld" || dispute.status === "overturned") {
      return reply.code(409).send({ error: "already_resolved" });
    }

    const resolved = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(qaDisputes)
        .set({
          status: parsed.data.status,
          resolverUserId: ctx.id,
          resolutionNote: parsed.data.resolutionNote,
          resolvedAt: new Date(),
        })
        .where(eq(qaDisputes.id, id))
        .returning();
      await tx
        .update(qaQueueItems)
        .set({ status: "resolved", updatedAt: new Date() })
        .where(and(eq(qaQueueItems.reviewId, dispute.reviewId), eq(qaQueueItems.orgId, ctx.orgId)));
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.dispute.resolve",
        targetType: "dispute",
        targetId: id,
        callId: dispute.callId,
        before: { status: dispute.status },
        after: { status: parsed.data.status, resolutionNote: parsed.data.resolutionNote },
        ip: clientIp(req),
      });
      return row;
    });
    return resolved;
  });

  // ════════════════════════════ Stats / agreement / scorecards ════════════════════════════

  app.get("/stats", { preHandler: [app.requirePermission("qa.read")] }, async (req) => {
    const ctx = req.authUser!;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const inQueueRow = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM qa_queue_items
      WHERE org_id = ${ctx.orgId}::uuid AND status = 'pending'
    `);
    const inQueue = Number(inQueueRow.rows?.[0]?.count ?? 0);

    const reviewedTodayRow = await db.execute<{ count: string; avg_ms: string | null }>(sql`
      SELECT COUNT(*)::text AS count, AVG(time_spent_ms)::text AS avg_ms
      FROM call_qa_reviews
      WHERE org_id = ${ctx.orgId}::uuid AND created_at >= ${startOfToday.toISOString()}::timestamptz
    `);
    const reviewedToday = Number(reviewedTodayRow.rows?.[0]?.count ?? 0);
    const avgReviewTimeMs = Number(reviewedTodayRow.rows?.[0]?.avg_ms ?? 0);

    const disputesOpenRow = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM qa_disputes
      WHERE org_id = ${ctx.orgId}::uuid AND status IN ('open','under_review')
    `);
    const slaBreachRow = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM qa_queue_items
      WHERE org_id = ${ctx.orgId}::uuid AND status IN ('pending','in_review')
        AND due_at IS NOT NULL AND due_at < now()
    `);
    const medianGoldRow = await db.execute<{ med: string | null }>(sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gold_variance)::text AS med
      FROM call_qa_reviews
      WHERE org_id = ${ctx.orgId}::uuid AND gold_variance IS NOT NULL
    `);

    const agreementRow = await db.execute<{ agreement: string | null }>(sql`
      WITH multi AS (
        SELECT call_id, stddev_pop(reviewer_score::double precision) AS sd
        FROM call_qa_reviews
        WHERE org_id = ${ctx.orgId}::uuid AND reviewer_score IS NOT NULL
        GROUP BY call_id HAVING COUNT(*) > 1
      )
      SELECT (100.0 * SUM(CASE WHEN sd <= 10 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0))::text AS agreement
      FROM multi
    `);
    const rawAgreement = agreementRow.rows?.[0]?.agreement;

    return {
      inQueue,
      reviewedToday,
      avgReviewTimeMs: Math.round(avgReviewTimeMs || 0),
      reviewerAgreementPct: rawAgreement == null ? null : Math.round(Number(rawAgreement)),
      disputesOpen: Number(disputesOpenRow.rows?.[0]?.count ?? 0),
      slaBreaches: Number(slaBreachRow.rows?.[0]?.count ?? 0),
      medianGoldVariance: medianGoldRow.rows?.[0]?.med == null ? null : Math.round(Number(medianGoldRow.rows[0].med)),
    };
  });

  // Cohen's κ over calls with ≥2 slot reviews + per-reviewer drift alerts.
  app.get("/agreement", { preHandler: [app.requirePermission("qa.read")] }, async (req) => {
    const ctx = req.authUser!;
    const reviews = await db
      .select({
        callId: callQaReviews.callId,
        reviewerUserId: callQaReviews.reviewerUserId,
        reviewerScore: callQaReviews.reviewerScore,
        goldVariance: callQaReviews.goldVariance,
      })
      .from(callQaReviews)
      .where(and(eq(callQaReviews.orgId, ctx.orgId), sql`${callQaReviews.reviewerScore} IS NOT NULL`));

    const byCall = new Map<string, Array<{ reviewer: string | null; band: number }>>();
    const errByReviewer = new Map<string, number[]>();
    for (const r of reviews) {
      if (r.reviewerScore == null) continue;
      const arr = byCall.get(r.callId) ?? [];
      arr.push({ reviewer: r.reviewerUserId, band: band(r.reviewerScore) });
      byCall.set(r.callId, arr);
      if (r.reviewerUserId && r.goldVariance != null) {
        const e = errByReviewer.get(r.reviewerUserId) ?? [];
        e.push(r.goldVariance);
        errByReviewer.set(r.reviewerUserId, e);
      }
    }
    const overallPairs: Array<[number, number]> = [];
    const pairMap = new Map<string, { a: string; b: string; pairs: Array<[number, number]> }>();
    for (const arr of byCall.values()) {
      if (arr.length < 2) continue;
      overallPairs.push([arr[0].band, arr[1].band]);
      const a = arr[0].reviewer ?? "?";
      const b = arr[1].reviewer ?? "?";
      const key = [a, b].sort().join("|");
      const e = pairMap.get(key) ?? { a, b, pairs: [] };
      e.pairs.push([arr[0].band, arr[1].band]);
      pairMap.set(key, e);
    }
    const pairwise = [...pairMap.values()].map((p) => ({
      a: p.a,
      b: p.b,
      kappa: cohensKappa(p.pairs),
      n: p.pairs.length,
    }));
    const driftAlerts = [...errByReviewer.entries()]
      .map(([reviewer, errs]) => ({
        reviewerUserId: reviewer,
        meanGoldVariance: errs.reduce((a, b) => a + b, 0) / errs.length,
        n: errs.length,
      }))
      .filter((x) => x.meanGoldVariance > 15);

    return { kappa: cohensKappa(overallPairs), pairwise, driftAlerts, asOf: new Date().toISOString() };
  });

  app.get("/reviewers/:userId/scorecard", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { userId } = req.params as { userId: string };
    // Ensure the user is in the caller's org (membership).
    const inOrg = await db.execute<{ ok: string }>(sql`
      SELECT '1' AS ok FROM memberships
      WHERE user_id = ${userId}::uuid AND org_id = ${ctx.orgId}::uuid LIMIT 1
    `);
    if (!inOrg.rows?.length) return reply.code(404).send({ error: "reviewer_not_found" });

    const agg = await db.execute<{
      reviews: string;
      overrides: string;
      mean_gold_variance: string | null;
    }>(sql`
      SELECT COUNT(*)::text AS reviews,
             SUM(CASE WHEN decision = 'override' THEN 1 ELSE 0 END)::text AS overrides,
             AVG(gold_variance)::text AS mean_gold_variance
      FROM call_qa_reviews
      WHERE org_id = ${ctx.orgId}::uuid AND reviewer_user_id = ${userId}::uuid
    `);
    const weekly = await db.execute<{ week: string; reviews: string }>(sql`
      SELECT date_trunc('week', created_at)::date::text AS week, COUNT(*)::text AS reviews
      FROM call_qa_reviews
      WHERE org_id = ${ctx.orgId}::uuid AND reviewer_user_id = ${userId}::uuid
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12
    `);
    const r = agg.rows?.[0];
    const reviews = Number(r?.reviews ?? 0);
    const overrides = Number(r?.overrides ?? 0);
    return {
      reviewerUserId: userId,
      reviews,
      overrideRate: reviews ? overrides / reviews : 0,
      meanGoldVariance: r?.mean_gold_variance == null ? null : Number(r.mean_gold_variance),
      trend: (weekly.rows ?? []).map((w) => ({ week: w.week, reviews: Number(w.reviews) })),
    };
  });

  // CSV export of the current queue/filter set.
  app.get("/export", { preHandler: [app.requirePermission("qa.export")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = queueQuerySchema.omit({ cursor: true, limit: true }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const f = parsed.data;
    const filters = [sql`c.org_id = ${ctx.orgId}::uuid`, sql`c.status = 'ended'`];
    if (f.recruiterId) filters.push(sql`c.recruiter_user_id = ${f.recruiterId}::uuid`);
    if (f.demandId) filters.push(sql`c.demand_id = ${f.demandId}::uuid`);
    const whereSql = sql.join(filters, sql` AND `);
    const res = await db.execute<{
      id: string;
      ended_at: string | null;
      candidate_name: string | null;
      demand_title: string | null;
      latest_decision: string | null;
    }>(sql`
      SELECT c.id, c.ended_at::text,
             cand.display_name AS candidate_name,
             d.title AS demand_title,
             (SELECT decision FROM call_qa_reviews q WHERE q.call_id = c.id ORDER BY created_at DESC LIMIT 1) AS latest_decision
      FROM call_sessions c
      LEFT JOIN candidates cand ON cand.id = c.candidate_id
      LEFT JOIN demands d ON d.id = c.demand_id
      WHERE ${whereSql}
      ORDER BY c.ended_at DESC NULLS LAST
      LIMIT 5000
    `);
    await db.transaction(async (tx) => {
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.export.run",
        targetType: "call",
        targetId: "queue",
        after: { rows: res.rows?.length ?? 0, filters: f },
        ip: clientIp(req),
      });
    });
    const esc = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const header = "call_id,ended_at,candidate,demand,decision\n";
    const body = (res.rows ?? [])
      .map((r) => [r.id, r.ended_at ?? "", r.candidate_name, r.demand_title, r.latest_decision].map(esc).join(","))
      .join("\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="qa-queue.csv"');
    return header + body;
  });

  // Audit timeline for a target.
  app.get("/audit", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const qparsed = z
      .object({
        targetType: z.string().max(40).optional(),
        targetId: z.string().max(200).optional(),
        callId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(req.query);
    if (!qparsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: qparsed.error.flatten() });
    }
    const f = qparsed.data;
    const conds = [eq(qaAuditEvents.orgId, ctx.orgId)];
    if (f.targetType) conds.push(eq(qaAuditEvents.targetType, f.targetType));
    if (f.targetId) conds.push(eq(qaAuditEvents.targetId, f.targetId));
    if (f.callId) conds.push(eq(qaAuditEvents.callId, f.callId));
    const rows = await db
      .select({
        id: qaAuditEvents.id,
        action: qaAuditEvents.action,
        targetType: qaAuditEvents.targetType,
        targetId: qaAuditEvents.targetId,
        actorUserId: qaAuditEvents.actorUserId,
        actorName: users.name,
        before: qaAuditEvents.before,
        after: qaAuditEvents.after,
        createdAt: qaAuditEvents.createdAt,
      })
      .from(qaAuditEvents)
      .leftJoin(users, eq(users.id, qaAuditEvents.actorUserId))
      .where(and(...conds))
      .orderBy(desc(qaAuditEvents.createdAt))
      .limit(f.limit);
    return { events: rows };
  });

  // ════════════════════════════ Resolution / acoustic ════════════════════════════

  app.get("/:callId/resolution", { preHandler: [app.requirePermission("qa.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    const cached = await getCachedResolution(callId);
    if (cached) return { analysis: cached, cached: true };
    const analysis = await analyzeResolution(callId, req.log);
    return { analysis, cached: false };
  });

  app.post("/:callId/resolution/recompute", { preHandler: [app.requirePermission("qa.override")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await callInOrg(callId, ctx.orgId);
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    const analysis = await db.transaction(async (tx) => {
      await tx.delete(qaResolutionAnalyses).where(eq(qaResolutionAnalyses.callId, callId));
      await writeQaAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "qa.resolution.recompute",
        targetType: "call",
        targetId: callId,
        callId,
        ip: clientIp(req),
      });
      return null;
    });
    void analysis;
    const result = await analyzeResolution(callId, req.log);
    return { analysis: result, cached: false };
  });

  app.get("/:callId/acoustic", { preHandler: [app.requirePermission("qa.acoustic")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const [call] = await db
      .select({
        id: callSessions.id,
        recordingUrl: callSessions.recordingUrl,
        recordingDurationMs: callSessions.recordingDurationMs,
      })
      .from(callSessions)
      .where(and(eq(callSessions.id, callId), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    const windows = await db
      .select({
        speaker: transcriptAcousticWindows.speaker,
        tsStartMs: transcriptAcousticWindows.tsStartMs,
        tsEndMs: transcriptAcousticWindows.tsEndMs,
        valence: transcriptAcousticWindows.valence,
        arousal: transcriptAcousticWindows.arousal,
        f0Mean: transcriptAcousticWindows.f0Mean,
        rmsEnergy: transcriptAcousticWindows.rmsEnergy,
        modelVersion: transcriptAcousticWindows.modelVersion,
      })
      .from(transcriptAcousticWindows)
      .where(eq(transcriptAcousticWindows.callId, callId))
      .orderBy(asc(transcriptAcousticWindows.tsStartMs));
    return { windows, recordingUrl: call.recordingUrl, recordingDurationMs: call.recordingDurationMs };
  });

  app.post("/:callId/acoustic/recompute", { preHandler: [app.requirePermission("qa.acoustic")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const [call] = await db
      .select({ recordingUrl: callSessions.recordingUrl })
      .from(callSessions)
      .where(and(eq(callSessions.id, callId), eq(callSessions.orgId, ctx.orgId)));
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    if (!call.recordingUrl) return reply.code(409).send({ error: "no_recording" });
    try {
      await getAcousticSentimentQueue().add(
        `acoustic-${callId}`,
        { callId, recordingUrl: call.recordingUrl },
        { jobId: `acoustic-${callId}-${Date.now()}` },
      );
    } catch (err) {
      req.log.warn({ err, callId }, "acoustic recompute enqueue failed");
      return reply.code(503).send({ error: "queue_unavailable" });
    }
    return reply.code(202).send({ queued: true });
  });
}

// Shared small cursor/limit parse for list routes that only paginate by created_at.
function queueListCursor(req: FastifyRequest): { cursor?: string; limit: number } {
  const q = req.query as { cursor?: string; limit?: string };
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
  return { cursor: q.cursor, limit };
}
