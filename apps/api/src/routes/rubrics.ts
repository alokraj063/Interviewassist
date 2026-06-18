// Rubrics — enterprise rebuild.
//
// The `call_rubrics` row is the mutable rubric HEAD (draft pointer + metadata).
// Publishing freezes the current criteria into an immutable `call_rubric_versions`
// snapshot that downstream scorers pin to. Every state change writes an
// append-only `rubric_audit_log` row (the DB enforces append-only via a
// trigger). Lists are keyset-paginated, filterable, searchable, server-sorted.
//
// Permissions: rubrics.read gates every GET; rubrics.write gates every mutation.
// Org-scoping: every query filters on req.authUser!.orgId.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, desc, eq, ilike, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  callQaReviews,
  callRubricScores,
  callRubricVersions,
  callRubrics,
  clients,
  coachingScenarios,
  db,
  rubricAuditLog,
  RUBRIC_APPLIES_TO,
  RUBRIC_CRITERION_KINDS,
  RUBRIC_PURPOSES,
  RUBRIC_STATUSES,
  type RubricAuditAction,
  type RubricCriterionV2,
  users,
  voiceAgents,
} from "@j2w/db";
import { env } from "../env.js";
import {
  lookupIdempotentRubric,
  readIdempotencyKey,
  recordIdempotentRubric,
} from "../lib/rubricIdempotency.js";

// ---------- Zod ----------

const bandAnchorSchema = z
  .object({
    fail: z.string().max(400),
    pass: z.string().max(400),
    excellent: z.string().max(400),
  })
  .partial();

const criterionSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  weight: z.number().min(0).max(100),
  kind: z.enum(RUBRIC_CRITERION_KINDS),
  bandThresholds: z
    .object({ fail: z.number(), pass: z.number(), excellent: z.number() })
    .refine(
      (b) => b.fail <= b.pass && b.pass <= b.excellent,
      "bands must be monotonic: fail <= pass <= excellent",
    ),
  anchors: bandAnchorSchema.optional(),
  minEvidenceQuotes: z.number().int().min(0).max(3).default(0),
  autoScoreEnabled: z.boolean().default(true),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  purpose: z.enum(RUBRIC_PURPOSES).default("general_screen"),
  description: z.string().max(2000).optional(),
  clientId: z.string().uuid().optional().nullable(),
  appliesTo: z.array(z.enum(RUBRIC_APPLIES_TO)).min(1).default(["call"]),
  isDefault: z.boolean().default(false),
  criteria: z.array(criterionSchema).default([]),
});

const updateSchema = createSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime().optional(),
});

const publishSchema = z.object({ changeNote: z.string().max(1000).optional() });

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(RUBRIC_STATUSES).optional(),
  purpose: z.enum(RUBRIC_PURPOSES).optional(),
  appliesTo: z.enum(RUBRIC_APPLIES_TO).optional(),
  isDefault: z.coerce.boolean().optional(),
  sort: z.enum(["updatedAt", "name", "timesUsed"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["archive", "set_default", "export", "set_applies_to"]),
  payload: z
    .object({ appliesTo: z.array(z.enum(RUBRIC_APPLIES_TO)).min(1).optional() })
    .optional(),
});

const importSchema = z.object({
  schemaVersion: z.number().optional(),
  name: z.string().min(1).max(200),
  purpose: z.enum(RUBRIC_PURPOSES).default("general_screen"),
  description: z.string().max(2000).optional(),
  appliesTo: z.array(z.enum(RUBRIC_APPLIES_TO)).min(1).default(["call"]),
  criteria: z.array(criterionSchema).min(1),
});

const aiSuggestSchema = z.object({
  purpose: z.enum(RUBRIC_PURPOSES).optional(),
  context: z.string().max(4000).optional(),
});

// ---------- helpers ----------

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_payload", issues: error.flatten() });
}

function normalizeCriteria(input: z.infer<typeof criterionSchema>[]): RubricCriterionV2[] {
  return input.map((c) => ({
    id: c.id || randomUUID(),
    name: c.name,
    description: c.description,
    weight: c.weight,
    kind: c.kind,
    bandThresholds: c.bandThresholds,
    anchors: c.anchors as RubricCriterionV2["anchors"],
    minEvidenceQuotes: c.minEvidenceQuotes ?? 0,
    autoScoreEnabled: c.autoScoreEnabled ?? true,
  }));
}

interface AuditFields {
  fromVersion?: number | null;
  toVersion?: number | null;
  metadata?: Record<string, unknown>;
  rubricName?: string | null;
}

// Append-only audit chokepoint. Optional tx for transactional callers.
async function audit(
  exec: typeof db,
  orgId: string,
  rubricId: string | null,
  actorUserId: string | null,
  action: RubricAuditAction,
  fields: AuditFields = {},
): Promise<void> {
  await exec.insert(rubricAuditLog).values({
    orgId,
    rubricId,
    rubricName: fields.rubricName ?? null,
    actorUserId,
    action,
    fromVersion: fields.fromVersion ?? null,
    toVersion: fields.toVersion ?? null,
    metadata: fields.metadata ?? {},
  });
}

// Opaque base64 keyset cursor over (sortValue, id).
function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify([String(sortValue), id])).toString("base64url");
}
function decodeCursor(cursor: string): { sortValue: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    return { sortValue: String(parsed[0]), id: String(parsed[1]) };
  } catch {
    return null;
  }
}

// timesUsed subquery: count of scores against ANY version of this rubric id.
const timesUsedSql = sql<number>`(
  SELECT count(*)::int FROM call_rubric_scores
   WHERE call_rubric_scores.rubric_id = call_rubrics.id
)`;

export async function rubricsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const canRead = app.requirePermission("rubrics.read");
  const canWrite = app.requirePermission("rubrics.write");

  // ---------- LIST ----------
  app.get("/", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const conds = [eq(callRubrics.orgId, ctx.orgId)];
    if (qy.q) conds.push(ilike(callRubrics.name, `%${qy.q}%`));
    if (qy.status) conds.push(eq(callRubrics.status, qy.status));
    if (qy.purpose) conds.push(eq(callRubrics.purpose, qy.purpose));
    if (qy.appliesTo) conds.push(sql`${qy.appliesTo} = ANY(${callRubrics.appliesTo})`);
    if (qy.isDefault !== undefined) conds.push(eq(callRubrics.isDefault, qy.isDefault));

    // total (same WHERE, no keyset)
    const [{ n: total }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(callRubrics)
      .where(and(...conds));

    // sort column + keyset
    const dirAsc = qy.dir === "asc";
    let orderCol;
    if (qy.sort === "name") orderCol = callRubrics.name;
    else if (qy.sort === "timesUsed") orderCol = timesUsedSql;
    else orderCol = callRubrics.updatedAt;

    const keysetConds = [...conds];
    if (qy.cursor) {
      const cur = decodeCursor(qy.cursor);
      if (!cur) return reply.code(400).send({ error: "invalid_cursor" });
      // Keyset on (sortValue, id) built as a raw SQL fragment so the typed
      // Date/number coercion is handled by Postgres, not Drizzle's overloads.
      const sortExpr =
        qy.sort === "name"
          ? sql`${callRubrics.name}`
          : qy.sort === "timesUsed"
            ? timesUsedSql
            : sql`${callRubrics.updatedAt}`;
      const sortParam =
        qy.sort === "name"
          ? sql`${cur.sortValue}`
          : qy.sort === "timesUsed"
            ? sql`${Number(cur.sortValue)}::int`
            : sql`${new Date(cur.sortValue).toISOString()}::timestamptz`;
      const op = dirAsc ? sql`>` : sql`<`;
      keysetConds.push(
        sql`(${sortExpr} ${op} ${sortParam} OR (${sortExpr} = ${sortParam} AND ${callRubrics.id} > ${cur.id}))`,
      );
    }

    const rows = await db
      .select({
        id: callRubrics.id,
        name: callRubrics.name,
        version: callRubrics.version,
        publishedVersion: callRubrics.publishedVersion,
        purpose: callRubrics.purpose,
        status: callRubrics.status,
        appliesTo: callRubrics.appliesTo,
        clientId: callRubrics.clientId,
        description: callRubrics.description,
        criteria: callRubrics.criteria,
        isDefault: callRubrics.isDefault,
        createdAt: callRubrics.createdAt,
        updatedAt: callRubrics.updatedAt,
        archivedAt: callRubrics.archivedAt,
        timesUsed: timesUsedSql,
      })
      .from(callRubrics)
      .where(and(...keysetConds))
      .orderBy(dirAsc ? asc(orderCol) : desc(orderCol), asc(callRubrics.id))
      .limit(qy.limit + 1);

    let nextCursor: string | null = null;
    if (rows.length > qy.limit) {
      const last = rows[qy.limit - 1];
      const sortVal =
        qy.sort === "name"
          ? last.name
          : qy.sort === "timesUsed"
            ? last.timesUsed
            : (last.updatedAt as Date).toISOString();
      nextCursor = encodeCursor(sortVal, last.id);
      rows.length = qy.limit;
    }

    // Aggregate metrics that don't depend on the page slice.
    const [agg] = await db
      .select({
        published: sql<number>`count(*) FILTER (WHERE ${callRubrics.status} = 'published')::int`,
        defaults: sql<number>`count(*) FILTER (WHERE ${callRubrics.isDefault} = true)::int`,
        timesScored: sql<number>`(SELECT count(*)::int FROM call_rubric_scores s
          WHERE s.rubric_id IN (SELECT id FROM call_rubrics WHERE org_id = ${ctx.orgId}))`,
      })
      .from(callRubrics)
      .where(eq(callRubrics.orgId, ctx.orgId));

    return { rubrics: rows, nextCursor, total, metrics: agg };
  });

  // ---------- DETAIL ----------
  app.get("/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "rubric_not_found" });

    const usage = await computeUsage(ctx.orgId, id, row.purpose, row.isDefault);

    const recentAudit = await db
      .select({
        id: rubricAuditLog.id,
        action: rubricAuditLog.action,
        fromVersion: rubricAuditLog.fromVersion,
        toVersion: rubricAuditLog.toVersion,
        metadata: rubricAuditLog.metadata,
        createdAt: rubricAuditLog.createdAt,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(rubricAuditLog)
      .leftJoin(users, eq(rubricAuditLog.actorUserId, users.id))
      .where(and(eq(rubricAuditLog.rubricId, id), eq(rubricAuditLog.orgId, ctx.orgId)))
      .orderBy(desc(rubricAuditLog.createdAt))
      .limit(5);

    return { rubric: row, usage, recentAudit };
  });

  // ---------- VERSIONS ----------
  app.get("/:id/versions", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [head] = await db
      .select({ id: callRubrics.id })
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });
    const versions = await db
      .select({
        id: callRubricVersions.id,
        version: callRubricVersions.version,
        name: callRubricVersions.name,
        purpose: callRubricVersions.purpose,
        criteria: callRubricVersions.criteria,
        changeNote: callRubricVersions.changeNote,
        publishedAt: callRubricVersions.publishedAt,
        publishedByName: users.name,
      })
      .from(callRubricVersions)
      .leftJoin(users, eq(callRubricVersions.publishedByUserId, users.id))
      .where(and(eq(callRubricVersions.rubricId, id), eq(callRubricVersions.orgId, ctx.orgId)))
      .orderBy(desc(callRubricVersions.version));
    return { versions };
  });

  app.get("/:id/versions/:version", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id, version } = req.params as { id: string; version: string };
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) return reply.code(400).send({ error: "invalid_version" });
    const [row] = await db
      .select()
      .from(callRubricVersions)
      .where(
        and(
          eq(callRubricVersions.rubricId, id),
          eq(callRubricVersions.orgId, ctx.orgId),
          eq(callRubricVersions.version, v),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "version_not_found" });
    return { version: row };
  });

  // ---------- AUDIT (keyset) ----------
  app.get("/:id/audit", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);

    const conds = [eq(rubricAuditLog.rubricId, id), eq(rubricAuditLog.orgId, ctx.orgId)];
    if (q.data.cursor) {
      const beforeId = Number(q.data.cursor);
      if (!Number.isInteger(beforeId)) return reply.code(400).send({ error: "invalid_cursor" });
      conds.push(lt(rubricAuditLog.id, beforeId));
    }
    const rows = await db
      .select({
        id: rubricAuditLog.id,
        action: rubricAuditLog.action,
        fromVersion: rubricAuditLog.fromVersion,
        toVersion: rubricAuditLog.toVersion,
        metadata: rubricAuditLog.metadata,
        createdAt: rubricAuditLog.createdAt,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(rubricAuditLog)
      .leftJoin(users, eq(rubricAuditLog.actorUserId, users.id))
      .where(and(...conds))
      .orderBy(desc(rubricAuditLog.id))
      .limit(q.data.limit + 1);
    let nextCursor: string | null = null;
    if (rows.length > q.data.limit) {
      nextCursor = String(rows[q.data.limit - 1].id);
      rows.length = q.data.limit;
    }
    return { entries: rows, nextCursor };
  });

  // ---------- CALIBRATION ----------
  app.get("/:id/calibration", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [rubric] = await db
      .select({ criteria: callRubrics.criteria })
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!rubric) return reply.code(404).send({ error: "rubric_not_found" });

    // Pull QA reviews whose call was scored by this rubric, with per-criterion
    // overrides. Aggregate AI vs reviewer per criterion -> agreement.
    const reviews = await db
      .select({ criterionOverrides: callQaReviews.criterionOverrides })
      .from(callQaReviews)
      .innerJoin(callRubricScores, eq(callRubricScores.callId, callQaReviews.callId))
      .where(and(eq(callQaReviews.orgId, ctx.orgId), eq(callRubricScores.rubricId, id)))
      .groupBy(callQaReviews.id, callQaReviews.criterionOverrides);

    type Agg = { aiSum: number; revSum: number; overrides: number; n: number; agree: number };
    const byCriterion = new Map<string, Agg>();
    for (const r of reviews) {
      const overrides = r.criterionOverrides ?? {};
      for (const [cid, ov] of Object.entries(overrides)) {
        const cur = byCriterion.get(cid) ?? { aiSum: 0, revSum: 0, overrides: 0, n: 0, agree: 0 };
        cur.aiSum += ov.aiScore;
        cur.revSum += ov.reviewerScore;
        cur.overrides += 1;
        cur.n += 1;
        // "agreement" = |ai - reviewer| <= 5 points.
        if (Math.abs(ov.aiScore - ov.reviewerScore) <= 5) cur.agree += 1;
        byCriterion.set(cid, cur);
      }
    }

    const criteria = (rubric.criteria as RubricCriterionV2[]).map((c) => {
      const a = byCriterion.get(c.id);
      const n = a?.n ?? 0;
      return {
        id: c.id,
        name: c.name,
        aiAvg: n ? +(a!.aiSum / n).toFixed(1) : null,
        reviewerAvg: n ? +(a!.revSum / n).toFixed(1) : null,
        overrideRate: reviews.length ? +(((a?.overrides ?? 0) / reviews.length) * 100).toFixed(1) : 0,
        agreementPct: n ? +((a!.agree / n) * 100).toFixed(1) : null,
        n,
      };
    });
    return { criteria, reviewCount: reviews.length };
  });

  // ---------- CREATE ----------
  app.post("/", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const existingId = await lookupIdempotentRubric(ctx.orgId, idemKey);
      if (existingId) {
        const [row] = await db.select().from(callRubrics).where(eq(callRubrics.id, existingId)).limit(1);
        if (row) return reply.code(200).send({ rubric: row, idempotent: true });
      }
    }

    if (parsed.data.clientId) {
      const ok = await clientBelongsToOrg(ctx.orgId, parsed.data.clientId);
      if (!ok) return reply.code(400).send({ error: "client_not_found" });
    }

    const criteria = normalizeCriteria(parsed.data.criteria);
    const row = await db.transaction(async (tx) => {
      if (parsed.data.isDefault) {
        await tx
          .update(callRubrics)
          .set({ isDefault: false })
          .where(and(eq(callRubrics.orgId, ctx.orgId), eq(callRubrics.purpose, parsed.data.purpose)));
      }
      const [inserted] = await tx
        .insert(callRubrics)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          purpose: parsed.data.purpose,
          description: parsed.data.description,
          clientId: parsed.data.clientId ?? null,
          appliesTo: parsed.data.appliesTo,
          isDefault: parsed.data.isDefault,
          status: "draft",
          criteria,
          createdByUserId: ctx.id,
          updatedByUserId: ctx.id,
        })
        .returning();
      await audit(tx as typeof db, ctx.orgId, inserted.id, ctx.id, "created", {
        metadata: { name: inserted.name, purpose: inserted.purpose },
      });
      return inserted;
    });

    if (idemKey) await recordIdempotentRubric(ctx.orgId, idemKey, row.id);
    return reply.code(201).send({ rubric: row });
  });

  // ---------- UPDATE (optimistic concurrency) ----------
  app.patch("/:id", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [existing] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "rubric_not_found" });

    if (
      parsed.data.expectedUpdatedAt &&
      new Date(parsed.data.expectedUpdatedAt).getTime() !== existing.updatedAt.getTime()
    ) {
      return reply.code(409).send({ error: "conflict", current: existing });
    }

    if (parsed.data.clientId) {
      const ok = await clientBelongsToOrg(ctx.orgId, parsed.data.clientId);
      if (!ok) return reply.code(400).send({ error: "client_not_found" });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date(), updatedByUserId: ctx.id };
    const changed: string[] = [];
    if (parsed.data.name !== undefined) { updates.name = parsed.data.name; changed.push("name"); }
    if (parsed.data.purpose !== undefined) { updates.purpose = parsed.data.purpose; changed.push("purpose"); }
    if (parsed.data.description !== undefined) { updates.description = parsed.data.description; changed.push("description"); }
    if (parsed.data.clientId !== undefined) { updates.clientId = parsed.data.clientId; changed.push("clientId"); }
    if (parsed.data.appliesTo !== undefined) { updates.appliesTo = parsed.data.appliesTo; changed.push("appliesTo"); }
    if (parsed.data.criteria !== undefined) {
      updates.criteria = normalizeCriteria(parsed.data.criteria);
      changed.push("criteria");
    }
    // Note: isDefault is NOT settable here — use POST /:id/set-default.

    const [row] = await db
      .update(callRubrics)
      .set(updates)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .returning();
    await audit(db, ctx.orgId, id, ctx.id, "updated", { metadata: { changed } });
    return { rubric: row };
  });

  // ---------- PUBLISH ----------
  app.post("/:id/publish", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = publishSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const existingId = await lookupIdempotentRubric(ctx.orgId, idemKey);
      if (existingId === id) {
        const [row] = await db.select().from(callRubrics).where(eq(callRubrics.id, id)).limit(1);
        if (row) return reply.code(200).send({ rubric: row, idempotent: true });
      }
    }

    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });

    const criteria = head.criteria as RubricCriterionV2[];
    if (!criteria.length) return reply.code(422).send({ error: "no_criteria" });
    const totalWeight = criteria.reduce((s, c) => s + (c.weight ?? 0), 0);
    if (totalWeight <= 0) return reply.code(422).send({ error: "weights_all_zero" });

    const result = await db.transaction(async (tx) => {
      const [{ maxV }] = await tx
        .select({ maxV: sql<number>`coalesce(max(${callRubricVersions.version}), 0)::int` })
        .from(callRubricVersions)
        .where(eq(callRubricVersions.rubricId, id));
      const newVersion = maxV + 1;
      await tx.insert(callRubricVersions).values({
        orgId: ctx.orgId,
        rubricId: id,
        version: newVersion,
        criteria,
        purpose: head.purpose,
        name: head.name,
        publishedByUserId: ctx.id,
        changeNote: parsed.data.changeNote,
      });
      const [row] = await tx
        .update(callRubrics)
        .set({ status: "published", publishedVersion: newVersion, version: newVersion, updatedAt: new Date(), updatedByUserId: ctx.id })
        .where(eq(callRubrics.id, id))
        .returning();
      await audit(tx as typeof db, ctx.orgId, id, ctx.id, "published", {
        fromVersion: head.publishedVersion ?? null,
        toVersion: newVersion,
        metadata: { changeNote: parsed.data.changeNote ?? null },
      });
      return row;
    });

    if (idemKey) await recordIdempotentRubric(ctx.orgId, idemKey, id);
    return reply.code(200).send({ rubric: result });
  });

  // ---------- ARCHIVE / RESTORE ----------
  app.post("/:id/archive", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const force = (req.query as { force?: string }).force === "true";
    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });

    if (!force) {
      const usage = await computeUsage(ctx.orgId, id, head.purpose, head.isDefault);
      const inUse = usage.voiceAgents > 0 || usage.coachingScenarios > 0;
      if (inUse && head.isDefault) {
        return reply.code(409).send({ error: "in_use", refs: usage });
      }
    }
    const [row] = await db
      .update(callRubrics)
      .set({ status: "archived", archivedAt: new Date(), isDefault: false, updatedAt: new Date(), updatedByUserId: ctx.id })
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .returning();
    await audit(db, ctx.orgId, id, ctx.id, "archived", { rubricName: head.name });
    return { rubric: row };
  });

  app.post("/:id/restore", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });
    const nextStatus = head.publishedVersion ? "published" : "draft";
    const [row] = await db
      .update(callRubrics)
      .set({ status: nextStatus, archivedAt: null, updatedAt: new Date(), updatedByUserId: ctx.id })
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .returning();
    await audit(db, ctx.orgId, id, ctx.id, "restored", { metadata: { status: nextStatus } });
    return { rubric: row };
  });

  // ---------- SET DEFAULT ----------
  app.post("/:id/set-default", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });
    if (head.status !== "published") return reply.code(422).send({ error: "must_be_published" });

    const row = await db.transaction(async (tx) => {
      // Clear + audit any currently-default rubric for this purpose.
      const displaced = await tx
        .select({ id: callRubrics.id, name: callRubrics.name })
        .from(callRubrics)
        .where(
          and(
            eq(callRubrics.orgId, ctx.orgId),
            eq(callRubrics.purpose, head.purpose),
            eq(callRubrics.isDefault, true),
            ne(callRubrics.id, id),
          ),
        );
      if (displaced.length) {
        await tx
          .update(callRubrics)
          .set({ isDefault: false })
          .where(and(eq(callRubrics.orgId, ctx.orgId), eq(callRubrics.purpose, head.purpose), ne(callRubrics.id, id)));
        for (const d of displaced) {
          await audit(tx as typeof db, ctx.orgId, d.id, ctx.id, "cleared_default", { rubricName: d.name });
        }
      }
      const [updated] = await tx
        .update(callRubrics)
        .set({ isDefault: true, updatedAt: new Date(), updatedByUserId: ctx.id })
        .where(eq(callRubrics.id, id))
        .returning();
      await audit(tx as typeof db, ctx.orgId, id, ctx.id, "set_default", { metadata: { purpose: head.purpose } });
      return updated;
    });
    return { rubric: row };
  });

  // ---------- DUPLICATE ----------
  app.post("/:id/duplicate", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const existingId = await lookupIdempotentRubric(ctx.orgId, idemKey);
      if (existingId) {
        const [row] = await db.select().from(callRubrics).where(eq(callRubrics.id, existingId)).limit(1);
        if (row) return reply.code(200).send({ rubric: row, idempotent: true });
      }
    }
    const [src] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!src) return reply.code(404).send({ error: "rubric_not_found" });
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(callRubrics)
        .values({
          orgId: ctx.orgId,
          name: `${src.name} (copy)`,
          purpose: src.purpose,
          description: src.description,
          clientId: src.clientId,
          appliesTo: src.appliesTo,
          isDefault: false,
          status: "draft",
          criteria: src.criteria,
          createdByUserId: ctx.id,
          updatedByUserId: ctx.id,
        })
        .returning();
      await audit(tx as typeof db, ctx.orgId, inserted.id, ctx.id, "duplicated", { metadata: { sourceId: id } });
      return inserted;
    });
    if (idemKey) await recordIdempotentRubric(ctx.orgId, idemKey, row.id);
    return reply.code(201).send({ rubric: row });
  });

  // ---------- DELETE (hard, only when unused) ----------
  app.delete("/:id", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });
    const usage = await computeUsage(ctx.orgId, id, head.purpose, head.isDefault);
    if (usage.timesScored > 0 || usage.voiceAgents > 0 || usage.coachingScenarios > 0) {
      return reply.code(409).send({ error: "in_use", refs: usage });
    }
    // Write the deletion trace FIRST (rubric_id ON DELETE SET NULL preserves it).
    await audit(db, ctx.orgId, id, ctx.id, "deleted", { rubricName: head.name });
    await db.delete(callRubrics).where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)));
    return { deleted: id };
  });

  // ---------- EXPORT ----------
  app.get("/:id/export", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "rubric_not_found" });
    const doc = {
      schemaVersion: 1,
      name: row.name,
      purpose: row.purpose,
      appliesTo: row.appliesTo,
      description: row.description,
      criteria: row.criteria,
    };
    reply.header("Content-Disposition", `attachment; filename="rubric-${id}.json"`);
    reply.header("Content-Type", "application/json");
    return doc;
  });

  // ---------- IMPORT ----------
  app.post("/import", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const existingId = await lookupIdempotentRubric(ctx.orgId, idemKey);
      if (existingId) {
        const [row] = await db.select().from(callRubrics).where(eq(callRubrics.id, existingId)).limit(1);
        if (row) return reply.code(200).send({ rubric: row, idempotent: true });
      }
    }
    const criteria = normalizeCriteria(parsed.data.criteria);
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(callRubrics)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          purpose: parsed.data.purpose,
          description: parsed.data.description,
          appliesTo: parsed.data.appliesTo,
          isDefault: false,
          status: "draft",
          criteria,
          createdByUserId: ctx.id,
          updatedByUserId: ctx.id,
        })
        .returning();
      await audit(tx as typeof db, ctx.orgId, inserted.id, ctx.id, "imported", {
        metadata: { criteriaCount: criteria.length },
      });
      return inserted;
    });
    if (idemKey) await recordIdempotentRubric(ctx.orgId, idemKey, row.id);
    return reply.code(201).send({ rubric: row });
  });

  // ---------- BULK ----------
  app.post("/bulk", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { ids, action, payload } = parsed.data;

    // Org-scope: only operate on rows that belong to the caller's org.
    const owned = await db
      .select({ id: callRubrics.id, name: callRubrics.name, purpose: callRubrics.purpose, status: callRubrics.status, appliesTo: callRubrics.appliesTo, criteria: callRubrics.criteria, isDefault: callRubrics.isDefault })
      .from(callRubrics)
      .where(and(eq(callRubrics.orgId, ctx.orgId), inArray(callRubrics.id, ids)));
    const ownedById = new Map(owned.map((r) => [r.id, r]));

    const ok: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const exported: unknown[] = [];

    for (const id of ids) {
      const row = ownedById.get(id);
      if (!row) {
        failed.push({ id, reason: "not_found" });
        continue;
      }
      try {
        if (action === "archive") {
          await db
            .update(callRubrics)
            .set({ status: "archived", archivedAt: new Date(), isDefault: false, updatedAt: new Date(), updatedByUserId: ctx.id })
            .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)));
          await audit(db, ctx.orgId, id, ctx.id, "archived", { rubricName: row.name, metadata: { bulk: true } });
          ok.push(id);
        } else if (action === "set_default") {
          if (row.status !== "published") {
            failed.push({ id, reason: "must_be_published" });
            continue;
          }
          await db.transaction(async (tx) => {
            await tx
              .update(callRubrics)
              .set({ isDefault: false })
              .where(and(eq(callRubrics.orgId, ctx.orgId), eq(callRubrics.purpose, row.purpose), ne(callRubrics.id, id)));
            await tx.update(callRubrics).set({ isDefault: true, updatedAt: new Date(), updatedByUserId: ctx.id }).where(eq(callRubrics.id, id));
            await audit(tx as typeof db, ctx.orgId, id, ctx.id, "set_default", { metadata: { bulk: true } });
          });
          ok.push(id);
        } else if (action === "set_applies_to") {
          if (!payload?.appliesTo) {
            failed.push({ id, reason: "missing_applies_to" });
            continue;
          }
          await db
            .update(callRubrics)
            .set({ appliesTo: payload.appliesTo, updatedAt: new Date(), updatedByUserId: ctx.id })
            .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)));
          await audit(db, ctx.orgId, id, ctx.id, "updated", { metadata: { changed: ["appliesTo"], bulk: true } });
          ok.push(id);
        } else if (action === "export") {
          exported.push({ schemaVersion: 1, name: row.name, purpose: row.purpose, appliesTo: row.appliesTo, criteria: row.criteria });
          ok.push(id);
        }
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : "error" });
      }
    }
    return { ok, failed, ...(action === "export" ? { exported } : {}) };
  });

  // ---------- AI SUGGEST (real-first w/ 503 gate) ----------
  app.post("/:id/ai-suggest", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = aiSuggestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [head] = await db
      .select()
      .from(callRubrics)
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, ctx.orgId)))
      .limit(1);
    if (!head) return reply.code(404).send({ error: "rubric_not_found" });

    // External-key gate: precise 503, never an uncaught 500.
    if (!env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "openai_api_key_missing" });
    }
    try {
      const suggestions = await suggestCriteria(parsed.data.purpose ?? head.purpose, parsed.data.context);
      return { suggestions };
    } catch (err) {
      req.log.error({ err }, "ai-suggest failed");
      return reply.code(502).send({ error: "ai_suggest_failed" });
    }
  });
}

// ---------- usage + clients ----------

async function clientBelongsToOrg(orgId: string, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)))
    .limit(1);
  return !!row;
}

async function computeUsage(
  orgId: string,
  rubricId: string,
  purpose: string,
  isDefault: boolean,
): Promise<{
  timesScored: number;
  scoredCalls: number;
  voiceAgents: number;
  coachingScenarios: number;
  defaultForPurpose: boolean;
}> {
  const [scored] = await db
    .select({
      timesScored: sql<number>`count(*)::int`,
      scoredCalls: sql<number>`count(distinct ${callRubricScores.callId})::int`,
    })
    .from(callRubricScores)
    .where(eq(callRubricScores.rubricId, rubricId));
  const [va] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceAgents)
    .where(and(eq(voiceAgents.orgId, orgId), eq(voiceAgents.linkedRubricId, rubricId)));
  const [cs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(coachingScenarios)
    .where(and(eq(coachingScenarios.orgId, orgId), eq(coachingScenarios.targetRubricId, rubricId)));
  return {
    timesScored: scored?.timesScored ?? 0,
    scoredCalls: scored?.scoredCalls ?? 0,
    voiceAgents: va?.n ?? 0,
    coachingScenarios: cs?.n ?? 0,
    defaultForPurpose: isDefault,
  };
}

// ---------- AI suggestion (OpenAI, structured output) ----------

async function suggestCriteria(
  purpose: string,
  context?: string,
): Promise<RubricCriterionV2[]> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const sys =
    "You design scoring rubrics for recruiter-candidate screening calls. " +
    "Produce 4-6 weighted criteria with behavioral anchors per band. " +
    "Weights are raw integers; they are normalized downstream.";
  const user = `Purpose: ${purpose}\n${context ? `Context: ${context}\n` : ""}Return JSON.`;
  const res = await openai.chat.completions.create({
    model: env.OPENAI_MODEL || env.OPENAI_MODEL_FALLBACK,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "rubric_criteria",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["criteria"],
          properties: {
            criteria: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "description", "weight", "kind", "anchors"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  weight: { type: "number" },
                  kind: { type: "string", enum: [...RUBRIC_CRITERION_KINDS] },
                  anchors: {
                    type: "object",
                    additionalProperties: false,
                    required: ["fail", "pass", "excellent"],
                    properties: {
                      fail: { type: "string" },
                      pass: { type: "string" },
                      excellent: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    temperature: 0.3,
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("empty ai response");
  const parsed = JSON.parse(raw) as {
    criteria: Array<{ name: string; description: string; weight: number; kind: RubricCriterionV2["kind"]; anchors: { fail: string; pass: string; excellent: string } }>;
  };
  return parsed.criteria.map((c) => ({
    id: randomUUID(),
    name: c.name,
    description: c.description,
    weight: c.weight,
    kind: c.kind,
    bandThresholds: { fail: 40, pass: 65, excellent: 85 },
    anchors: c.anchors,
    minEvidenceQuotes: 1,
    autoScoreEnabled: true,
  }));
}
