import type { FastifyInstance } from "fastify";
import { and, arrayOverlaps, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  callRubrics,
  callSessions,
  coachingAssignments,
  coachingAuditEvents,
  coachingCurricula,
  coachingRunScores,
  coachingRuns,
  coachingScenarios,
  COACHING_DIFFICULTIES,
  COACHING_RUN_STATUSES,
  db,
  users,
} from "@j2w/db";
import { getProviderCredentials } from "../integrations/resolver.js";
import { env } from "../env.js";
import { decodeCursor, encodeCursor } from "../lib/keyset.js";
import { scoreRun } from "../coaching/score.js";
import { buildPersonaSystemPrompt } from "../coaching/persona-prompt.js";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const personaSchema = z
  .object({
    candidateName: z.string().optional(),
    candidateRole: z.string().optional(),
    yearsExperience: z.number().optional(),
    currentCompany: z.string().optional(),
    currentCtcLakhs: z.number().optional(),
    expectedCtcLakhs: z.number().optional(),
    noticePeriodDays: z.number().optional(),
    location: z.string().optional(),
    speakingStyle: z.enum(["concise", "verbose", "evasive", "warm"]).optional(),
    mood: z.string().optional(),
    resistance: z.enum(["low", "medium", "high"]).optional(),
    hiddenContext: z.string().optional(),
    redFlags: z.array(z.string()).optional(),
    openingLine: z.string().optional(),
  })
  .partial()
  .passthrough();

const successCriterionSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  weight: z.number().min(0).max(100),
});

const createScenarioSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  difficulty: z.enum(COACHING_DIFFICULTIES).default("medium"),
  language: z.enum(["hinglish", "en-IN", "hi-IN"]).default("hinglish"),
  openingLine: z.string().max(500).optional(),
  candidatePersona: personaSchema.default({}),
  objections: z.array(z.string().min(1).max(400)).max(20).default([]),
  successCriteria: z.array(successCriterionSchema).max(20).default([]),
  targetRubricId: z.string().uuid().optional().nullable(),
  estimatedMinutes: z.number().int().min(1).max(120).default(8),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
  isPublished: z.boolean().default(false),
});

const updateScenarioSchema = createScenarioSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime().optional(),
});

const listScenariosQuery = z.object({
  q: z.string().max(200).optional(),
  difficulty: z.enum(COACHING_DIFFICULTIES).optional(),
  published: z.coerce.boolean().optional(),
  tag: z.union([z.string(), z.array(z.string())]).optional(),
  archived: z.coerce.boolean().default(false),
  sort: z.enum(["created_at", "updated_at", "title"]).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const listRunsQuery = z.object({
  scope: z.enum(["mine", "team", "all"]).default("mine"),
  scenarioId: z.string().uuid().optional(),
  status: z.enum(COACHING_RUN_STATUSES).optional(),
  recruiterUserId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const startRunSchema = z.object({
  scenarioId: z.string().uuid(),
  mode: z.enum(["ai_roleplay", "self_recorded", "live_call"]).default("ai_roleplay"),
  assignmentId: z.string().uuid().optional(),
});

const patchRunSchema = z.object({
  status: z.enum(COACHING_RUN_STATUSES).optional(),
  callId: z.string().uuid().optional(),
});

const overrideScoreSchema = z.object({
  score: z.number().min(0).max(100),
  band: z.enum(["fail", "pass", "excellent"]).optional(),
  evidence: z.string().max(2000).optional(),
  justification: z.string().min(1).max(2000),
});

const createCurriculumSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  scenarioIds: z.array(z.string().uuid()).max(50).default([]),
  isPublished: z.boolean().default(false),
});

const createAssignmentSchema = z
  .object({
    scenarioId: z.string().uuid().optional(),
    curriculumId: z.string().uuid().optional(),
    assigneeUserIds: z.array(z.string().uuid()).min(1).max(200),
    dueAt: z.string().datetime().optional(),
    minPassScore: z.number().min(0).max(100).optional(),
  })
  .refine((d) => (d.scenarioId ? !d.curriculumId : !!d.curriculumId), {
    message: "exactly one of scenarioId / curriculumId is required",
  });

const patchAssignmentSchema = z.object({
  dueAt: z.string().datetime().optional(),
  status: z.enum(["assigned", "in_progress", "completed", "overdue", "waived"]).optional(),
});

const listAssignmentsQuery = z.object({
  scope: z.enum(["mine", "team", "all"]).default("mine"),
  status: z.enum(["assigned", "in_progress", "completed", "overdue", "waived"]).optional(),
  assigneeUserId: z.string().uuid().optional(),
  dueBefore: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const progressQuery = z.object({
  userId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  groupBy: z.enum(["week", "month"]).default("week"),
});

// ---------------------------------------------------------------------------

function badRequest(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, parsed: { error: z.ZodError }) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

export async function coachingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Write an audit row inside the caller's transaction (same atomic unit as the
  // state change). Append-only — no UPDATE/DELETE path exists.
  type AuditTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  async function writeAudit(
    tx: AuditTx,
    e: {
      orgId: string;
      action: (typeof coachingAuditEvents.$inferInsert)["action"];
      actorUserId?: string | null;
      scenarioId?: string | null;
      runId?: string | null;
      curriculumId?: string | null;
      assignmentId?: string | null;
      detail?: Record<string, unknown>;
    },
  ) {
    await tx.insert(coachingAuditEvents).values({
      orgId: e.orgId,
      action: e.action,
      actorUserId: e.actorUserId ?? null,
      scenarioId: e.scenarioId ?? null,
      runId: e.runId ?? null,
      curriculumId: e.curriculumId ?? null,
      assignmentId: e.assignmentId ?? null,
      detail: e.detail ?? {},
    });
  }

  // =========================================================================
  // SCENARIOS
  // =========================================================================

  app.get("/scenarios", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listScenariosQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { q, difficulty, published, tag, archived, sort, dir, cursor, limit } = parsed.data;

    const conds = [eq(coachingScenarios.orgId, ctx.orgId)];
    conds.push(archived ? sql`${coachingScenarios.archivedAt} is not null` : sql`${coachingScenarios.archivedAt} is null`);
    if (difficulty) conds.push(eq(coachingScenarios.difficulty, difficulty));
    if (published !== undefined) conds.push(eq(coachingScenarios.isPublished, published));
    if (q) conds.push(or(ilike(coachingScenarios.title, `%${q}%`), ilike(coachingScenarios.description, `%${q}%`))!);
    if (tag) {
      const tags = Array.isArray(tag) ? tag : [tag];
      conds.push(arrayOverlaps(coachingScenarios.tags, tags));
    }

    const sortCol =
      sort === "title" ? coachingScenarios.title : sort === "updated_at" ? coachingScenarios.updatedAt : coachingScenarios.createdAt;
    const tieCol = coachingScenarios.id;
    // Keyset only over timestamp sorts (title is not unique-ish enough for a
    // stable seek; fall back to offset-free but cursor-disabled on title).
    const cur = decodeCursor(cursor);
    if (cur && sort !== "title") {
      const op = dir === "asc" ? sql`>` : sql`<`;
      conds.push(sql`(${sortCol}, ${tieCol}) ${op} (${cur.ts}::timestamptz, ${cur.id}::uuid)`);
    }

    const orderBy =
      dir === "asc" ? [asc(sortCol), asc(tieCol)] : [desc(sortCol), desc(tieCol)];

    const rows = await db
      .select({
        id: coachingScenarios.id,
        title: coachingScenarios.title,
        description: coachingScenarios.description,
        difficulty: coachingScenarios.difficulty,
        targetRubricId: coachingScenarios.targetRubricId,
        targetRubricName: callRubrics.name,
        tags: coachingScenarios.tags,
        language: coachingScenarios.language,
        estimatedMinutes: coachingScenarios.estimatedMinutes,
        isPublished: coachingScenarios.isPublished,
        version: coachingScenarios.version,
        publishedVersion: coachingScenarios.publishedVersion,
        archivedAt: coachingScenarios.archivedAt,
        createdAt: coachingScenarios.createdAt,
        updatedAt: coachingScenarios.updatedAt,
      })
      .from(coachingScenarios)
      .leftJoin(callRubrics, eq(callRubrics.id, coachingScenarios.targetRubricId))
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);

    // run counts + avg score per scenario (single grouped query, no N+1)
    let rcMap = new Map<string, number>();
    let avgMap = new Map<string, number | null>();
    if (ids.length > 0) {
      const agg = await db
        .select({
          scenarioId: coachingRuns.scenarioId,
          runCount: sql<number>`count(*)::int`,
          avgScore: sql<number | null>`avg(${coachingRuns.cachedOverallScore})::float`,
        })
        .from(coachingRuns)
        .where(and(eq(coachingRuns.orgId, ctx.orgId), inArray(coachingRuns.scenarioId, ids)))
        .groupBy(coachingRuns.scenarioId);
      rcMap = new Map(agg.map((a) => [a.scenarioId, a.runCount]));
      avgMap = new Map(agg.map((a) => [a.scenarioId, a.avgScore]));
    }

    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last && sort !== "title"
        ? encodeCursor({
            ts: (sort === "updated_at" ? last.updatedAt : last.createdAt).toISOString(),
            id: last.id,
          })
        : null;

    // total via count on the same WHERE (first page only — keeps it cheap)
    let total: number | undefined;
    if (!cursor) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(coachingScenarios)
        .where(and(...conds.filter((_, i) => !(cur && sort !== "title" && i === conds.length - 1))));
      total = n;
    }

    return {
      scenarios: page.map((r) => ({
        ...r,
        runCount: rcMap.get(r.id) ?? 0,
        avgScore: avgMap.get(r.id) ?? null,
      })),
      nextCursor,
      total,
    };
  });

  app.get("/scenarios/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(coachingScenarios)
      .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "scenario_not_found" });

    const recentRuns = await db
      .select({
        id: coachingRuns.id,
        recruiterUserId: coachingRuns.recruiterUserId,
        recruiterEmail: users.email,
        recruiterName: users.name,
        callId: coachingRuns.callId,
        status: coachingRuns.status,
        scoringStatus: coachingRuns.scoringStatus,
        startedAt: coachingRuns.startedAt,
        completedAt: coachingRuns.completedAt,
        cachedOverallScore: coachingRuns.cachedOverallScore,
      })
      .from(coachingRuns)
      .leftJoin(users, eq(users.id, coachingRuns.recruiterUserId))
      .where(and(eq(coachingRuns.scenarioId, id), eq(coachingRuns.orgId, ctx.orgId)))
      .orderBy(desc(coachingRuns.startedAt))
      .limit(20);

    const auditEvents = await db
      .select()
      .from(coachingAuditEvents)
      .where(and(eq(coachingAuditEvents.scenarioId, id), eq(coachingAuditEvents.orgId, ctx.orgId)))
      .orderBy(desc(coachingAuditEvents.createdAt))
      .limit(20);

    return { scenario: row, recentRuns, auditEvents };
  });

  app.post(
    "/scenarios",
    { preHandler: [app.requirePermission("coaching.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = createScenarioSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;

      // Validate the rubric (if any) is in the caller's org.
      if (d.targetRubricId) {
        const [rb] = await db
          .select({ id: callRubrics.id })
          .from(callRubrics)
          .where(and(eq(callRubrics.id, d.targetRubricId), eq(callRubrics.orgId, ctx.orgId)))
          .limit(1);
        if (!rb) return reply.code(400).send({ error: "rubric_not_found" });
      }

      // Idempotency: an Idempotency-Key header short-circuits a duplicate
      // create within the org by the same author with the same title.
      const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim();
      if (idemKey) {
        const [existing] = await db
          .select()
          .from(coachingScenarios)
          .where(
            and(
              eq(coachingScenarios.orgId, ctx.orgId),
              eq(coachingScenarios.createdByUserId, ctx.id),
              eq(coachingScenarios.title, d.title),
            ),
          )
          .orderBy(desc(coachingScenarios.createdAt))
          .limit(1);
        if (existing && Date.now() - existing.createdAt.getTime() < 60_000) {
          return reply.code(200).send({ scenario: existing, idempotent: true });
        }
      }

      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(coachingScenarios)
          .values({
            orgId: ctx.orgId,
            title: d.title,
            description: d.description ?? null,
            difficulty: d.difficulty,
            language: d.language,
            openingLine: d.openingLine ?? null,
            candidatePersona: d.candidatePersona ?? {},
            objections: d.objections ?? [],
            successCriteria: d.successCriteria ?? [],
            targetRubricId: d.targetRubricId ?? null,
            estimatedMinutes: d.estimatedMinutes,
            tags: d.tags ?? [],
            isPublished: d.isPublished,
            publishedVersion: d.isPublished ? 1 : null,
            publishedAt: d.isPublished ? new Date() : null,
            createdByUserId: ctx.id,
          })
          .returning();
        await writeAudit(tx, {
          orgId: ctx.orgId,
          action: "scenario.created",
          actorUserId: ctx.id,
          scenarioId: created.id,
          detail: { title: created.title, published: created.isPublished },
        });
        if (d.isPublished) {
          await writeAudit(tx, {
            orgId: ctx.orgId,
            action: "scenario.published",
            actorUserId: ctx.id,
            scenarioId: created.id,
            detail: { version: 1 },
          });
        }
        return created;
      });
      return reply.code(201).send({ scenario: row });
    },
  );

  app.patch(
    "/scenarios/:id",
    { preHandler: [app.requirePermission("coaching.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = updateScenarioSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;

      const [current] = await db
        .select()
        .from(coachingScenarios)
        .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
        .limit(1);
      if (!current) return reply.code(404).send({ error: "scenario_not_found" });

      if (d.expectedUpdatedAt && new Date(d.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) {
        return reply.code(409).send({ error: "stale_write", currentUpdatedAt: current.updatedAt.toISOString() });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ["title", "description", "difficulty", "language", "openingLine", "candidatePersona", "objections", "successCriteria", "targetRubricId", "estimatedMinutes", "tags"] as const) {
        if (d[k] !== undefined) updates[k] = d[k];
      }

      let action: (typeof coachingAuditEvents.$inferInsert)["action"] = "scenario.updated";
      // Any content edit bumps the working version.
      if (Object.keys(updates).length > 1) updates.version = current.version + 1;
      if (d.isPublished !== undefined && d.isPublished !== current.isPublished) {
        updates.isPublished = d.isPublished;
        if (d.isPublished) {
          updates.publishedVersion = (updates.version as number | undefined) ?? current.version;
          updates.publishedAt = new Date();
          action = "scenario.published";
        } else {
          action = "scenario.unpublished";
        }
      }

      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingScenarios)
          .set(updates)
          .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
          .returning();
        await writeAudit(tx, {
          orgId: ctx.orgId,
          action,
          actorUserId: ctx.id,
          scenarioId: id,
          detail: { fields: Object.keys(updates) },
        });
        return updated;
      });
      return { scenario: row };
    },
  );

  app.post(
    "/scenarios/:id/duplicate",
    { preHandler: [app.requirePermission("coaching.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const [src] = await db
        .select()
        .from(coachingScenarios)
        .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
        .limit(1);
      if (!src) return reply.code(404).send({ error: "scenario_not_found" });

      const row = await db.transaction(async (tx) => {
        const [copy] = await tx
          .insert(coachingScenarios)
          .values({
            orgId: ctx.orgId,
            title: `${src.title} (copy)`,
            description: src.description,
            difficulty: src.difficulty,
            language: src.language,
            openingLine: src.openingLine,
            candidatePersona: src.candidatePersona,
            objections: src.objections,
            successCriteria: src.successCriteria,
            targetRubricId: src.targetRubricId,
            estimatedMinutes: src.estimatedMinutes,
            tags: src.tags,
            isPublished: false,
            createdByUserId: ctx.id,
          })
          .returning();
        await writeAudit(tx, {
          orgId: ctx.orgId,
          action: "scenario.duplicated",
          actorUserId: ctx.id,
          scenarioId: copy.id,
          detail: { from: src.id },
        });
        return copy;
      });
      return reply.code(201).send({ scenario: row });
    },
  );

  for (const verb of ["archive", "unarchive"] as const) {
    app.post(
      `/scenarios/:id/${verb}`,
      { preHandler: [app.requirePermission("coaching.write")] },
      async (req, reply) => {
        const ctx = req.authUser!;
        const { id } = req.params as { id: string };
        const row = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(coachingScenarios)
            .set({ archivedAt: verb === "archive" ? new Date() : null, updatedAt: new Date() })
            .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
            .returning();
          if (!updated) return null;
          await writeAudit(tx, {
            orgId: ctx.orgId,
            action: verb === "archive" ? "scenario.archived" : "scenario.updated",
            actorUserId: ctx.id,
            scenarioId: id,
            detail: { verb },
          });
          return updated;
        });
        if (!row) return reply.code(404).send({ error: "scenario_not_found" });
        return { scenario: row };
      },
    );
  }

  app.delete(
    "/scenarios/:id",
    { preHandler: [app.requirePermission("coaching.manage")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const [scenario] = await db
        .select({ id: coachingScenarios.id, archivedAt: coachingScenarios.archivedAt })
        .from(coachingScenarios)
        .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
        .limit(1);
      if (!scenario) return reply.code(404).send({ error: "scenario_not_found" });
      if (!scenario.archivedAt) return reply.code(409).send({ error: "archive_before_delete" });
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(coachingRuns)
        .where(eq(coachingRuns.scenarioId, id));
      if (n > 0) return reply.code(409).send({ error: "scenario_has_runs" });
      await db.delete(coachingScenarios).where(eq(coachingScenarios.id, id));
      return { deleted: id };
    },
  );

  app.post("/scenarios/:id/preview", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [s] = await db
      .select()
      .from(coachingScenarios)
      .where(and(eq(coachingScenarios.id, id), eq(coachingScenarios.orgId, ctx.orgId)))
      .limit(1);
    if (!s) return reply.code(404).send({ error: "scenario_not_found" });
    const { systemPrompt, firstMessage } = buildPersonaSystemPrompt(s);
    return { systemPrompt, firstMessage };
  });

  // =========================================================================
  // RUNS
  // =========================================================================

  app.get("/runs", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listRunsQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { scope, scenarioId, status, recruiterUserId, from, to, cursor, limit } = parsed.data;
    const canAll = ctx.permissions.includes("coaching.read.all");

    const conds = [eq(coachingRuns.orgId, ctx.orgId)];
    if (scope === "mine" || !canAll) conds.push(eq(coachingRuns.recruiterUserId, ctx.id));
    if (scenarioId) conds.push(eq(coachingRuns.scenarioId, scenarioId));
    if (status) conds.push(eq(coachingRuns.status, status));
    if (recruiterUserId && canAll) conds.push(eq(coachingRuns.recruiterUserId, recruiterUserId));
    if (from) conds.push(gte(coachingRuns.startedAt, new Date(from)));
    if (to) conds.push(lte(coachingRuns.startedAt, new Date(to)));
    const cur = decodeCursor(cursor);
    if (cur) {
      conds.push(sql`(${coachingRuns.startedAt}, ${coachingRuns.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`);
    }

    const rows = await db
      .select({
        id: coachingRuns.id,
        scenarioId: coachingRuns.scenarioId,
        scenarioTitle: coachingScenarios.title,
        recruiterUserId: coachingRuns.recruiterUserId,
        recruiterEmail: users.email,
        recruiterName: users.name,
        callId: coachingRuns.callId,
        status: coachingRuns.status,
        mode: coachingRuns.mode,
        scoringStatus: coachingRuns.scoringStatus,
        startedAt: coachingRuns.startedAt,
        completedAt: coachingRuns.completedAt,
        cachedOverallScore: coachingRuns.cachedOverallScore,
      })
      .from(coachingRuns)
      .leftJoin(coachingScenarios, eq(coachingScenarios.id, coachingRuns.scenarioId))
      .leftJoin(users, eq(users.id, coachingRuns.recruiterUserId))
      .where(and(...conds))
      .orderBy(desc(coachingRuns.startedAt), desc(coachingRuns.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ ts: last.startedAt.toISOString(), id: last.id }) : null;

    let total: number | undefined;
    if (!cursor) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(coachingRuns)
        .where(and(...conds.filter((_, i) => !(cur && i === conds.length - 1))));
      total = n;
    }
    return { runs: page, nextCursor, total };
  });

  app.get("/runs/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [run] = await db
      .select()
      .from(coachingRuns)
      .where(and(eq(coachingRuns.id, id), eq(coachingRuns.orgId, ctx.orgId)))
      .limit(1);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.recruiterUserId !== ctx.id && !ctx.permissions.includes("coaching.read.all")) {
      return reply.code(403).send({ error: "not_your_run" });
    }
    const [scenario] = await db
      .select()
      .from(coachingScenarios)
      .where(eq(coachingScenarios.id, run.scenarioId))
      .limit(1);
    const scores = await db
      .select()
      .from(coachingRunScores)
      .where(eq(coachingRunScores.runId, id))
      .orderBy(asc(coachingRunScores.criterionName));
    const auditEvents = await db
      .select()
      .from(coachingAuditEvents)
      .where(and(eq(coachingAuditEvents.runId, id), eq(coachingAuditEvents.orgId, ctx.orgId)))
      .orderBy(desc(coachingAuditEvents.createdAt))
      .limit(20);
    let call: typeof callSessions.$inferSelect | null = null;
    if (run.callId) {
      const [c] = await db.select().from(callSessions).where(eq(callSessions.id, run.callId)).limit(1);
      call = c ?? null;
    }
    return { run, scenario: scenario ?? null, scores, call, auditEvents };
  });

  app.post(
    "/runs",
    { preHandler: [app.requirePermission("coaching.run")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = startRunSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;
      const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim() || null;

      const [scenario] = await db
        .select({ id: coachingScenarios.id, version: coachingScenarios.version, publishedVersion: coachingScenarios.publishedVersion })
        .from(coachingScenarios)
        .where(and(eq(coachingScenarios.id, d.scenarioId), eq(coachingScenarios.orgId, ctx.orgId)))
        .limit(1);
      if (!scenario) return reply.code(404).send({ error: "scenario_not_found" });

      // Idempotency: dedupe by the partial-unique (org, recruiter, idem_key).
      if (idemKey) {
        const [existing] = await db
          .select()
          .from(coachingRuns)
          .where(
            and(
              eq(coachingRuns.orgId, ctx.orgId),
              eq(coachingRuns.recruiterUserId, ctx.id),
              eq(coachingRuns.idempotencyKey, idemKey),
            ),
          )
          .limit(1);
        if (existing) return reply.code(200).send({ run: existing, idempotent: true });
      }

      try {
        const row = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(coachingRuns)
            .values({
              orgId: ctx.orgId,
              scenarioId: d.scenarioId,
              recruiterUserId: ctx.id,
              status: "started",
              mode: d.mode,
              assignmentId: d.assignmentId ?? null,
              scenarioVersion: scenario.publishedVersion ?? scenario.version,
              idempotencyKey: idemKey,
            })
            .returning();
          await writeAudit(tx, {
            orgId: ctx.orgId,
            action: "run.started",
            actorUserId: ctx.id,
            scenarioId: d.scenarioId,
            runId: created.id,
            assignmentId: d.assignmentId ?? null,
            detail: { mode: d.mode },
          });
          return created;
        });
        return reply.code(201).send({ run: row });
      } catch (err: unknown) {
        // Unique-violation on the idem index → re-select the winner.
        if (idemKey && err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
          const [existing] = await db
            .select()
            .from(coachingRuns)
            .where(
              and(
                eq(coachingRuns.orgId, ctx.orgId),
                eq(coachingRuns.recruiterUserId, ctx.id),
                eq(coachingRuns.idempotencyKey, idemKey),
              ),
            )
            .limit(1);
          if (existing) return reply.code(200).send({ run: existing, idempotent: true });
        }
        throw err;
      }
    },
  );

  app.patch(
    "/runs/:id",
    { preHandler: [app.requirePermission("coaching.run")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = patchRunSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;

      const [run] = await db
        .select()
        .from(coachingRuns)
        .where(and(eq(coachingRuns.id, id), eq(coachingRuns.orgId, ctx.orgId)))
        .limit(1);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      if (run.recruiterUserId !== ctx.id && !ctx.permissions.includes("coaching.read.all")) {
        return reply.code(403).send({ error: "not_your_run" });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.callId) updates.callId = d.callId;
      if (d.status) {
        updates.status = d.status;
        if (d.status === "completed" || d.status === "abandoned") updates.completedAt = new Date();
        if (d.status === "completed") updates.scoringStatus = "pending";
      }

      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingRuns)
          .set(updates)
          .where(eq(coachingRuns.id, id))
          .returning();
        if (d.callId) {
          await writeAudit(tx, { orgId: ctx.orgId, action: "run.linked_call", actorUserId: ctx.id, runId: id, scenarioId: run.scenarioId, detail: { callId: d.callId } });
        }
        if (d.status === "completed") {
          await writeAudit(tx, { orgId: ctx.orgId, action: "run.completed", actorUserId: ctx.id, runId: id, scenarioId: run.scenarioId });
        } else if (d.status === "abandoned") {
          await writeAudit(tx, { orgId: ctx.orgId, action: "run.abandoned", actorUserId: ctx.id, runId: id, scenarioId: run.scenarioId });
        }
        return updated;
      });

      // Fire scoring in-process on completion (mirrors rag/summary.ts). The UI
      // polls GET /runs/:id for scoringStatus. Awaited so the test path is
      // deterministic; the stub is sub-millisecond.
      if (d.status === "completed") {
        await scoreRun(id, { actorUserId: ctx.id }).catch(() => {});
        await maybeCompleteAssignment(id, ctx.id, writeAudit);
      }

      return { run: row };
    },
  );

  app.post(
    "/runs/:id/score",
    { preHandler: [app.requirePermission("coaching.run")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const force = (req.query as { force?: string }).force === "true";
      const [run] = await db
        .select({ id: coachingRuns.id, recruiterUserId: coachingRuns.recruiterUserId })
        .from(coachingRuns)
        .where(and(eq(coachingRuns.id, id), eq(coachingRuns.orgId, ctx.orgId)))
        .limit(1);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      if (run.recruiterUserId !== ctx.id && !ctx.permissions.includes("coaching.read.all")) {
        return reply.code(403).send({ error: "not_your_run" });
      }
      if (force && !ctx.permissions.includes("coaching.manage")) {
        return reply.code(403).send({ error: "force_requires_manage" });
      }
      const result = await scoreRun(id, { force, actorUserId: ctx.id });
      await maybeCompleteAssignment(id, ctx.id, writeAudit);
      return { scoringStatus: result.status, overall: result.overall, generatedBy: result.generatedBy };
    },
  );

  app.patch(
    "/runs/:id/scores/:criterionId",
    { preHandler: [app.requirePermission("coaching.manage")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id, criterionId } = req.params as { id: string; criterionId: string };
      const parsed = overrideScoreSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;

      const [run] = await db
        .select({ id: coachingRuns.id })
        .from(coachingRuns)
        .where(and(eq(coachingRuns.id, id), eq(coachingRuns.orgId, ctx.orgId)))
        .limit(1);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      const [existing] = await db
        .select()
        .from(coachingRunScores)
        .where(and(eq(coachingRunScores.runId, id), eq(coachingRunScores.criterionId, criterionId)))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "criterion_not_found" });

      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingRunScores)
          .set({
            score: String(d.score),
            band: d.band ?? existing.band,
            evidence: d.evidence ?? existing.evidence,
            source: "manual",
          })
          .where(and(eq(coachingRunScores.runId, id), eq(coachingRunScores.criterionId, criterionId)))
          .returning();
        // Recompute weighted overall from current rows.
        const all = await tx.select().from(coachingRunScores).where(eq(coachingRunScores.runId, id));
        const totalW = all.reduce((a, r) => a + Number(r.weight || 1), 0) || 1;
        const overall = Math.round(all.reduce((a, r) => a + Number(r.score) * Number(r.weight || 1), 0) / totalW);
        await tx
          .update(coachingRuns)
          .set({ cachedOverallScore: String(overall), scoreSource: "ai_overridden", updatedAt: new Date() })
          .where(eq(coachingRuns.id, id));
        await writeAudit(tx, {
          orgId: ctx.orgId,
          action: "run.score_overridden",
          actorUserId: ctx.id,
          runId: id,
          detail: { criterionId, before: Number(existing.score), after: d.score, justification: d.justification, overall },
        });
        return { updated, overall };
      });
      return { score: result.updated, overall: result.overall };
    },
  );

  // =========================================================================
  // CURRICULA
  // =========================================================================

  app.get("/curricula", async (req, reply) => {
    const ctx = req.authUser!;
    const q = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
      .safeParse(req.query);
    if (!q.success) return badRequest(reply, q);
    const cur = decodeCursor(q.data.cursor);
    const conds = [eq(coachingCurricula.orgId, ctx.orgId), sql`${coachingCurricula.archivedAt} is null`];
    if (cur) conds.push(sql`(${coachingCurricula.createdAt}, ${coachingCurricula.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`);
    const rows = await db
      .select()
      .from(coachingCurricula)
      .where(and(...conds))
      .orderBy(desc(coachingCurricula.createdAt), desc(coachingCurricula.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.data.limit && last ? encodeCursor({ ts: last.createdAt.toISOString(), id: last.id }) : null;
    return { curricula: page, nextCursor };
  });

  app.post(
    "/curricula",
    { preHandler: [app.requirePermission("coaching.manage")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = createCurriculumSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;
      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(coachingCurricula)
          .values({
            orgId: ctx.orgId,
            name: d.name,
            description: d.description ?? null,
            scenarioIds: d.scenarioIds,
            isPublished: d.isPublished,
            createdByUserId: ctx.id,
          })
          .returning();
        await writeAudit(tx, { orgId: ctx.orgId, action: "curriculum.created", actorUserId: ctx.id, curriculumId: created.id, detail: { name: d.name } });
        return created;
      });
      return reply.code(201).send({ curriculum: row });
    },
  );

  app.patch(
    "/curricula/:id",
    { preHandler: [app.requirePermission("coaching.manage")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = createCurriculumSchema.partial().safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const updates: Record<string, unknown> = { updatedAt: new Date(), ...parsed.data };
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingCurricula)
          .set(updates)
          .where(and(eq(coachingCurricula.id, id), eq(coachingCurricula.orgId, ctx.orgId)))
          .returning();
        if (!updated) return null;
        await writeAudit(tx, { orgId: ctx.orgId, action: "curriculum.updated", actorUserId: ctx.id, curriculumId: id });
        return updated;
      });
      if (!row) return reply.code(404).send({ error: "curriculum_not_found" });
      return { curriculum: row };
    },
  );

  app.post(
    "/curricula/:id/archive",
    { preHandler: [app.requirePermission("coaching.manage")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingCurricula)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(coachingCurricula.id, id), eq(coachingCurricula.orgId, ctx.orgId)))
          .returning();
        if (!updated) return null;
        await writeAudit(tx, { orgId: ctx.orgId, action: "curriculum.archived", actorUserId: ctx.id, curriculumId: id });
        return updated;
      });
      if (!row) return reply.code(404).send({ error: "curriculum_not_found" });
      return { curriculum: row };
    },
  );

  // =========================================================================
  // ASSIGNMENTS
  // =========================================================================

  app.get("/assignments", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listAssignmentsQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { scope, status, assigneeUserId, dueBefore, cursor, limit } = parsed.data;
    const canAll = ctx.permissions.includes("coaching.read.all");

    const conds = [eq(coachingAssignments.orgId, ctx.orgId)];
    if (scope === "mine" || !canAll) conds.push(eq(coachingAssignments.assigneeUserId, ctx.id));
    else if (assigneeUserId) conds.push(eq(coachingAssignments.assigneeUserId, assigneeUserId));
    if (status) conds.push(eq(coachingAssignments.status, status));
    if (dueBefore) conds.push(lte(coachingAssignments.dueAt, new Date(dueBefore)));
    const cur = decodeCursor(cursor);
    if (cur) conds.push(sql`(${coachingAssignments.createdAt}, ${coachingAssignments.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`);

    const rows = await db
      .select({
        id: coachingAssignments.id,
        scenarioId: coachingAssignments.scenarioId,
        scenarioTitle: coachingScenarios.title,
        curriculumId: coachingAssignments.curriculumId,
        assigneeUserId: coachingAssignments.assigneeUserId,
        assigneeEmail: users.email,
        assigneeName: users.name,
        status: coachingAssignments.status,
        dueAt: coachingAssignments.dueAt,
        completedAt: coachingAssignments.completedAt,
        minPassScore: coachingAssignments.minPassScore,
        createdAt: coachingAssignments.createdAt,
      })
      .from(coachingAssignments)
      .leftJoin(coachingScenarios, eq(coachingScenarios.id, coachingAssignments.scenarioId))
      .leftJoin(users, eq(users.id, coachingAssignments.assigneeUserId))
      .where(and(...conds))
      .orderBy(desc(coachingAssignments.createdAt), desc(coachingAssignments.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ ts: last.createdAt.toISOString(), id: last.id }) : null;
    return { assignments: page, nextCursor };
  });

  app.post(
    "/assignments",
    { preHandler: [app.requirePermission("coaching.assign")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = createAssignmentSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;
      const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim() || null;

      // Validate target belongs to the org.
      if (d.scenarioId) {
        const [s] = await db.select({ id: coachingScenarios.id }).from(coachingScenarios).where(and(eq(coachingScenarios.id, d.scenarioId), eq(coachingScenarios.orgId, ctx.orgId))).limit(1);
        if (!s) return reply.code(404).send({ error: "scenario_not_found" });
      }
      if (d.curriculumId) {
        const [c] = await db.select({ id: coachingCurricula.id }).from(coachingCurricula).where(and(eq(coachingCurricula.id, d.curriculumId), eq(coachingCurricula.orgId, ctx.orgId))).limit(1);
        if (!c) return reply.code(404).send({ error: "curriculum_not_found" });
      }

      // Validate assignees are members of the org.
      const validUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, d.assigneeUserIds)));
      const validIds = new Set(validUsers.map((u) => u.id));
      const missing = d.assigneeUserIds.filter((u) => !validIds.has(u));
      if (missing.length > 0) return reply.code(400).send({ error: "invalid_assignees", missing });

      // Idempotency: if the same idem key already produced assignments, return them.
      if (idemKey) {
        const existing = await db
          .select()
          .from(coachingAssignments)
          .where(and(eq(coachingAssignments.orgId, ctx.orgId), eq(coachingAssignments.assignedByUserId, ctx.id), eq(coachingAssignments.idempotencyKey, idemKey)));
        if (existing.length > 0) return reply.code(200).send({ assignments: existing, idempotent: true });
      }

      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(coachingAssignments)
          .values(
            d.assigneeUserIds.map((uid) => ({
              orgId: ctx.orgId,
              scenarioId: d.scenarioId ?? null,
              curriculumId: d.curriculumId ?? null,
              assigneeUserId: uid,
              assignedByUserId: ctx.id,
              dueAt: d.dueAt ? new Date(d.dueAt) : null,
              minPassScore: d.minPassScore != null ? String(d.minPassScore) : null,
              idempotencyKey: idemKey,
            })),
          )
          .returning();
        for (const a of inserted) {
          await writeAudit(tx, { orgId: ctx.orgId, action: "assignment.created", actorUserId: ctx.id, assignmentId: a.id, scenarioId: a.scenarioId, curriculumId: a.curriculumId, detail: { assignee: a.assigneeUserId } });
        }
        return inserted;
      });
      return reply.code(201).send({ assignments: created });
    },
  );

  app.patch(
    "/assignments/:id",
    { preHandler: [app.requirePermission("coaching.assign")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = patchAssignmentSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const d = parsed.data;
      if (d.status === "waived" && !ctx.permissions.includes("coaching.manage")) {
        return reply.code(403).send({ error: "waive_requires_manage" });
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.dueAt) updates.dueAt = new Date(d.dueAt);
      if (d.status) updates.status = d.status;
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(coachingAssignments)
          .set(updates)
          .where(and(eq(coachingAssignments.id, id), eq(coachingAssignments.orgId, ctx.orgId)))
          .returning();
        if (!updated) return null;
        if (d.status === "waived") {
          await writeAudit(tx, { orgId: ctx.orgId, action: "assignment.waived", actorUserId: ctx.id, assignmentId: id });
        } else if (d.dueAt) {
          await writeAudit(tx, { orgId: ctx.orgId, action: "assignment.due_changed", actorUserId: ctx.id, assignmentId: id, detail: { dueAt: d.dueAt } });
        }
        return updated;
      });
      if (!row) return reply.code(404).send({ error: "assignment_not_found" });
      return { assignment: row };
    },
  );

  // =========================================================================
  // PROGRESS / ANALYTICS
  // =========================================================================

  app.get("/progress", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = progressQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { userId, from, to, groupBy } = parsed.data;
    const targetUser = userId ?? ctx.id;
    if (targetUser !== ctx.id && !ctx.permissions.includes("coaching.read.all")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    // groupBy is a validated enum → safe to inline as a literal (avoids an
    // unknown-typed bound param in date_trunc's first argument).
    const truncLit = groupBy === "month" ? sql`'month'` : sql`'week'`;
    const period = sql<string>`date_trunc(${truncLit}, ${coachingRuns.startedAt})`;
    const conds = [
      eq(coachingRuns.orgId, ctx.orgId),
      eq(coachingRuns.recruiterUserId, targetUser),
      eq(coachingRuns.scoringStatus, "scored"),
    ];
    if (from) conds.push(gte(coachingRuns.startedAt, new Date(from)));
    if (to) conds.push(lte(coachingRuns.startedAt, new Date(to)));

    const points = await db
      .select({
        period,
        avgScore: sql<number | null>`avg(${coachingRuns.cachedOverallScore})::float`,
        runCount: sql<number>`count(*)::int`,
      })
      .from(coachingRuns)
      .where(and(...conds))
      .groupBy(period)
      .orderBy(period);

    const bySkill = await db
      .select({
        criterion: coachingRunScores.criterionName,
        avgScore: sql<number | null>`avg(${coachingRunScores.score})::float`,
        runCount: sql<number>`count(*)::int`,
      })
      .from(coachingRunScores)
      .innerJoin(coachingRuns, eq(coachingRuns.id, coachingRunScores.runId))
      .where(and(eq(coachingRuns.orgId, ctx.orgId), eq(coachingRuns.recruiterUserId, targetUser)))
      .groupBy(coachingRunScores.criterionName)
      .orderBy(coachingRunScores.criterionName);

    return { userId: targetUser, points, bySkill };
  });

  app.get(
    "/team-summary",
    { preHandler: [app.requirePermission("coaching.read.all")] },
    async (req) => {
      const ctx = req.authUser!;
      const assignAgg = await db
        .select({
          userId: coachingAssignments.assigneeUserId,
          assigned: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) filter (where ${coachingAssignments.status} = 'completed')::int`,
          overdue: sql<number>`count(*) filter (where ${coachingAssignments.status} = 'overdue')::int`,
        })
        .from(coachingAssignments)
        .where(eq(coachingAssignments.orgId, ctx.orgId))
        .groupBy(coachingAssignments.assigneeUserId);

      const runAgg = await db
        .select({
          userId: coachingRuns.recruiterUserId,
          email: users.email,
          name: users.name,
          avgScore: sql<number | null>`avg(${coachingRuns.cachedOverallScore})::float`,
          runCount: sql<number>`count(*)::int`,
          lastActivity: sql<string | null>`max(${coachingRuns.startedAt})`,
        })
        .from(coachingRuns)
        .leftJoin(users, eq(users.id, coachingRuns.recruiterUserId))
        .where(eq(coachingRuns.orgId, ctx.orgId))
        .groupBy(coachingRuns.recruiterUserId, users.email, users.name);

      const assignMap = new Map(assignAgg.map((a) => [a.userId, a]));
      const rollup = runAgg.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: r.name,
        avgScore: r.avgScore,
        runCount: r.runCount,
        lastActivity: r.lastActivity,
        assigned: assignMap.get(r.userId)?.assigned ?? 0,
        completed: assignMap.get(r.userId)?.completed ?? 0,
        overdue: assignMap.get(r.userId)?.overdue ?? 0,
      }));
      return { team: rollup };
    },
  );

  // =========================================================================
  // AUDIT (read-only timeline)
  // =========================================================================

  for (const kind of ["scenarios", "runs"] as const) {
    app.get(`/${kind}/:id/audit`, async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const col = kind === "scenarios" ? coachingAuditEvents.scenarioId : coachingAuditEvents.runId;
      const rows = await db
        .select({
          id: coachingAuditEvents.id,
          action: coachingAuditEvents.action,
          actorUserId: coachingAuditEvents.actorUserId,
          actorEmail: users.email,
          actorName: users.name,
          detail: coachingAuditEvents.detail,
          createdAt: coachingAuditEvents.createdAt,
        })
        .from(coachingAuditEvents)
        .leftJoin(users, eq(users.id, coachingAuditEvents.actorUserId))
        .where(and(eq(col, id), eq(coachingAuditEvents.orgId, ctx.orgId)))
        .orderBy(desc(coachingAuditEvents.createdAt))
        .limit(50);
      void reply;
      return { events: rows };
    });
  }

  // =========================================================================
  // AI-ROLEPLAY runtime ticket (real integration behind getProviderCredentials)
  // =========================================================================

  app.post(
    "/runs/:id/ai-call",
    { preHandler: [app.requirePermission("coaching.run")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const [run] = await db
        .select({ id: coachingRuns.id, scenarioId: coachingRuns.scenarioId, recruiterUserId: coachingRuns.recruiterUserId, callId: coachingRuns.callId })
        .from(coachingRuns)
        .where(and(eq(coachingRuns.id, id), eq(coachingRuns.orgId, ctx.orgId)))
        .limit(1);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      if (run.recruiterUserId !== ctx.id) return reply.code(403).send({ error: "not_your_run" });

      const vapiCreds = await getProviderCredentials(ctx.orgId, "vapi");
      const publicKey = vapiCreds?.publicKey ?? env.VAPI_PUBLIC_KEY;
      if (!publicKey) {
        // 503 (not 500) so the page can offer the self_recorded fallback.
        return reply.code(503).send({ error: "vapi_public_key_missing" });
      }

      const [scenario] = await db
        .select()
        .from(coachingScenarios)
        .where(eq(coachingScenarios.id, run.scenarioId))
        .limit(1);
      if (!scenario) return reply.code(404).send({ error: "scenario_not_found" });
      const { systemPrompt, firstMessage } = buildPersonaSystemPrompt(scenario);

      await db.transaction(async (tx) => {
        await tx.update(coachingRuns).set({ mode: "ai_roleplay", status: "live", updatedAt: new Date() }).where(eq(coachingRuns.id, id));
        await writeAudit(tx, { orgId: ctx.orgId, action: "run.started", actorUserId: ctx.id, runId: id, scenarioId: run.scenarioId, detail: { mode: "ai_roleplay", aiCall: true } });
      });

      const assistant = {
        name: `Candidate – ${scenario.candidatePersona?.candidateName ?? "Practice"} (coaching)`,
        firstMessage,
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          temperature: 0.75,
          messages: [{ role: "system", content: systemPrompt }],
        },
        voice: { provider: "vapi", voiceId: "Rohan" },
        maxDurationSeconds: Math.min(600, (scenario.estimatedMinutes ?? 8) * 90),
        endCallPhrases: ["bye bye", "goodbye", "alvida", "dhanyavaad", "thank you bye"],
        metadata: { j2wScenario: "coaching-ai-roleplay", j2wCoachingRunId: id },
      };

      return { mode: "inline" as const, publicKey, assistant };
    },
  );
}

// When a run linked to an assignment finishes scoring (and meets minPassScore
// if set), flip the assignment to completed. Append-only audit row written too.
async function maybeCompleteAssignment(
  runId: string,
  actorUserId: string,
  writeAudit: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], e: { orgId: string; action: (typeof coachingAuditEvents.$inferInsert)["action"]; actorUserId?: string | null; assignmentId?: string | null; runId?: string | null; detail?: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const [run] = await db
    .select({ id: coachingRuns.id, orgId: coachingRuns.orgId, assignmentId: coachingRuns.assignmentId, overall: coachingRuns.cachedOverallScore, scoringStatus: coachingRuns.scoringStatus })
    .from(coachingRuns)
    .where(eq(coachingRuns.id, runId))
    .limit(1);
  if (!run?.assignmentId || run.scoringStatus !== "scored") return;
  const [assignment] = await db
    .select()
    .from(coachingAssignments)
    .where(eq(coachingAssignments.id, run.assignmentId))
    .limit(1);
  if (!assignment || assignment.status === "completed" || assignment.status === "waived") return;
  const overall = run.overall != null ? Number(run.overall) : null;
  const min = assignment.minPassScore != null ? Number(assignment.minPassScore) : null;
  if (min != null && (overall == null || overall < min)) return;
  await db.transaction(async (tx) => {
    await tx
      .update(coachingAssignments)
      .set({ status: "completed", completedRunId: runId, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(coachingAssignments.id, assignment.id));
    await writeAudit(tx, { orgId: run.orgId, action: "assignment.completed", actorUserId, assignmentId: assignment.id, runId, detail: { overall } });
  });
}
