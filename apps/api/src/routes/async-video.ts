// Async-video screening routes — enterprise rebuild.
//
// Recruiters author multi-question video screens (script builder), invite
// candidates (idempotent), and review submissions in a reviewer cockpit:
// per-question structured scorecards (multi-reviewer + inter-rater agreement),
// threaded comments, AI transcript/summary/skills (labeled AI, never sole
// input), expiring shareable external-review links, and a per-submission
// activity timeline from an append-only audit log.
//
// Every mutation is permission-gated (async_video.read/write/invite/review/
// share — granted in migration 0029), org-scoped to req.authUser.orgId, Zod
// validated, idempotent where it creates/invites/shares, and writes an audit
// row. List routes are keyset-paginated with a server-side total — never an
// unbounded .limit().
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ASYNC_VIDEO_QUESTION_KINDS,
  ASYNC_VIDEO_RECOMMENDATIONS,
  asyncVideoAiArtifacts,
  asyncVideoAuditLog,
  asyncVideoCampaigns,
  asyncVideoComments,
  asyncVideoQuestions,
  asyncVideoScorecards,
  asyncVideoShareLinks,
  asyncVideoSubmissions,
  candidates,
  db,
  demands,
  messagingEvents,
  proctorSessions,
  users,
} from "@j2w/db";
import { env } from "../env.js";
import { recordAudit } from "../async-video/audit.js";
import { computeAgreement, computeOverallScore } from "../async-video/agreement.js";
import {
  isAiConfigured,
  resolveAiCreds,
  summarizeSubmission,
  transcribeClip,
} from "../async-video/ai.js";
import {
  lookupIdempotent,
  readIdempotencyKey,
  recordIdempotent,
} from "../assessments/idempotency.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const questionInputSchema = z.object({
  kind: z.enum(ASYNC_VIDEO_QUESTION_KINDS).default("video"),
  text: z.string().min(1).max(2000),
  stimulusText: z.string().max(2000).optional().nullable(),
  stimulusBlobKey: z.string().max(2000).optional().nullable(),
  prepSeconds: z.number().int().min(0).max(600).default(30),
  maxSeconds: z.number().int().min(15).max(600).default(120),
  maxRetakes: z.number().int().min(0).max(5).default(0),
  competencyKey: z.string().max(120).optional().nullable(),
});

const createCampaignSchema = z.object({
  title: z.string().min(1).max(200),
  introText: z.string().max(2000).optional().nullable(),
  outroText: z.string().max(2000).optional().nullable(),
  demandId: z.string().uuid().optional().nullable(),
  blindReview: z.boolean().optional(),
  requireDeviceCheck: z.boolean().optional(),
  questions: z.array(questionInputSchema).max(20).default([]),
});

const updateCampaignSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  introText: z.string().max(2000).optional().nullable(),
  outroText: z.string().max(2000).optional().nullable(),
  demandId: z.string().uuid().optional().nullable(),
  blindReview: z.boolean().optional(),
  requireDeviceCheck: z.boolean().optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

const inviteSchema = z.object({
  campaignId: z.string().uuid(),
  candidateId: z.string().uuid().optional().nullable(),
  expiresInHours: z.number().int().min(1).max(2160).default(168),
});

const bulkInviteSchema = z.object({
  campaignId: z.string().uuid(),
  candidateIds: z.array(z.string().uuid()).min(1).max(200),
  expiresInHours: z.number().int().min(1).max(2160).default(168),
});

const questionScoreSchema = z.object({
  questionId: z.string().uuid(),
  score: z.number().min(0).max(5),
  note: z.string().max(2000).optional(),
});

const scorecardSchema = z.object({
  questionScores: z.array(questionScoreSchema).max(50).default([]),
  recommendation: z.enum(ASYNC_VIDEO_RECOMMENDATIONS).optional().nullable(),
  summaryNote: z.string().max(4000).optional().nullable(),
  submitted: z.boolean().default(false),
});

const commentSchema = z.object({
  body: z.string().min(1).max(4000),
  questionId: z.string().uuid().optional().nullable(),
  timestampSec: z.number().int().min(0).max(36000).optional().nullable(),
});

const shareLinkSchema = z.object({
  label: z.string().max(120).optional().nullable(),
  expiresInHours: z.number().int().min(1).max(720).default(72),
  canScore: z.boolean().default(true),
});

const submitSchema = z.object({
  videos: z
    .array(
      z.object({
        promptIndex: z.number().int().min(0).max(50),
        blobKey: z.string().min(1).max(2000),
        durationSec: z.number().int().min(1).max(3600),
        recordedAt: z.string().datetime(),
      }),
    )
    .min(1)
    .max(50),
});

const deviceCheckSchema = z.object({
  camera: z.boolean(),
  mic: z.boolean(),
  bandwidthKbps: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

// Opaque keyset cursor over (createdAt iso, id).
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    return { createdAt: String(parsed[0]), id: String(parsed[1]) };
  } catch {
    return null;
  }
}

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  demandId: z.string().uuid().optional(),
  sort: z.enum(["updated", "created", "title"]).default("updated"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const queueQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["invited", "started", "submitted", "reviewed", "expired"]).optional(),
  campaignId: z.string().uuid().optional(),
  decision: z.enum(["forward", "hold", "reject"]).optional(),
  shortlisted: z.enum(["true", "false"]).optional(),
  reviewerUserId: z.string().uuid().optional(),
  sort: z.enum(["created", "submitted"]).default("created"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

// Resolve a blob key to its absolute path under BLOB_ROOT, guarding traversal.
// Mirrors the blobStore layout: BLOB_ROOT/<2-char-prefix>/<key>.
function resolveBlobPath(key: string): string | null {
  const raw = process.env.BLOB_ROOT ?? env.BLOB_ROOT ?? "./var/blobs";
  // blob.ts resolves a relative root against the monorepo root, not cwd.
  const root = path.isAbsolute(raw)
    ? raw
    : path.resolve(process.cwd(), "../..", raw);
  const abs = path.resolve(root, key);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

export async function asyncVideoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const canRead = app.requirePermission("async_video.read");
  const canWrite = app.requirePermission("async_video.write");
  const canInvite = app.requirePermission("async_video.invite");
  const canReview = app.requirePermission("async_video.review");
  const canShare = app.requirePermission("async_video.share");

  // ---------- CAMPAIGNS: list (keyset) ----------
  app.get("/campaigns", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const qy = parsed.data;
    const conds = [eq(asyncVideoCampaigns.orgId, ctx.orgId)];
    if (qy.status) conds.push(eq(asyncVideoCampaigns.status, qy.status));
    if (qy.demandId) conds.push(eq(asyncVideoCampaigns.demandId, qy.demandId));
    if (qy.q) conds.push(ilike(asyncVideoCampaigns.title, `%${qy.q}%`));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(asyncVideoCampaigns)
      .where(and(...conds));

    const keysetConds = [...conds];
    // Title sort is stable-by-title then id; updated/created keyset on created_at.
    const sortCol =
      qy.sort === "title"
        ? asyncVideoCampaigns.title
        : qy.sort === "created"
          ? asyncVideoCampaigns.createdAt
          : asyncVideoCampaigns.updatedAt;
    if (qy.cursor) {
      const cur = decodeCursor(qy.cursor);
      if (!cur) return reply.code(400).send({ error: "invalid_cursor" });
      keysetConds.push(
        or(
          lt(asyncVideoCampaigns.createdAt, new Date(cur.createdAt)),
          and(eq(asyncVideoCampaigns.createdAt, new Date(cur.createdAt)), lt(asyncVideoCampaigns.id, cur.id)),
        )!,
      );
    }

    const rows = await db
      .select({
        id: asyncVideoCampaigns.id,
        title: asyncVideoCampaigns.title,
        introText: asyncVideoCampaigns.introText,
        demandId: asyncVideoCampaigns.demandId,
        demandTitle: demands.title,
        status: asyncVideoCampaigns.status,
        blindReview: asyncVideoCampaigns.blindReview,
        requireDeviceCheck: asyncVideoCampaigns.requireDeviceCheck,
        version: asyncVideoCampaigns.version,
        createdAt: asyncVideoCampaigns.createdAt,
        updatedAt: asyncVideoCampaigns.updatedAt,
        questionCount: sql<number>`(
          select count(*)::int from async_video_questions q where q.campaign_id = ${asyncVideoCampaigns.id}
        )`,
        submissionCount: sql<number>`(
          select count(*)::int from async_video_submissions s where s.campaign_id = ${asyncVideoCampaigns.id}
        )`,
        submittedCount: sql<number>`(
          select count(*)::int from async_video_submissions s
          where s.campaign_id = ${asyncVideoCampaigns.id} and s.status in ('submitted','reviewed')
        )`,
        reviewedCount: sql<number>`(
          select count(*)::int from async_video_submissions s
          where s.campaign_id = ${asyncVideoCampaigns.id} and s.status = 'reviewed'
        )`,
      })
      .from(asyncVideoCampaigns)
      .leftJoin(demands, eq(demands.id, asyncVideoCampaigns.demandId))
      .where(and(...keysetConds))
      .orderBy(
        qy.sort === "title" ? asc(sortCol) : desc(asyncVideoCampaigns.createdAt),
        desc(asyncVideoCampaigns.id),
      )
      .limit(qy.limit);

    const nextCursor =
      rows.length === qy.limit
        ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].id)
        : null;
    return { campaigns: rows, nextCursor, total };
  });

  // ---------- CAMPAIGNS: detail ----------
  app.get("/campaigns/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [c] = await db
      .select()
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });

    const questions = await db
      .select()
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id))
      .orderBy(asc(asyncVideoQuestions.position));

    const submissions = await db
      .select({
        id: asyncVideoSubmissions.id,
        candidateId: asyncVideoSubmissions.candidateId,
        candidateName: candidates.displayName,
        status: asyncVideoSubmissions.status,
        shortlisted: asyncVideoSubmissions.shortlisted,
        reviewerDecision: asyncVideoSubmissions.reviewerDecision,
        reviewerScore: asyncVideoSubmissions.reviewerScore,
        inviteToken: asyncVideoSubmissions.inviteToken,
        expiresAt: asyncVideoSubmissions.expiresAt,
        reminderCount: asyncVideoSubmissions.reminderCount,
        startedAt: asyncVideoSubmissions.startedAt,
        submittedAt: asyncVideoSubmissions.submittedAt,
        reviewedAt: asyncVideoSubmissions.reviewedAt,
        createdAt: asyncVideoSubmissions.createdAt,
      })
      .from(asyncVideoSubmissions)
      .leftJoin(candidates, eq(candidates.id, asyncVideoSubmissions.candidateId))
      .where(eq(asyncVideoSubmissions.campaignId, id))
      .orderBy(desc(asyncVideoSubmissions.createdAt));

    const counts = {
      total: submissions.length,
      submitted: submissions.filter((s) => s.status === "submitted" || s.status === "reviewed").length,
      reviewed: submissions.filter((s) => s.status === "reviewed").length,
      shortlisted: submissions.filter((s) => s.shortlisted).length,
    };
    return { campaign: c, questions, submissions, counts };
  });

  // ---------- CAMPAIGNS: create (idempotent) ----------
  app.post("/campaigns", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "async_video.campaign.create", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    if (parsed.data.demandId) {
      const [d] = await db
        .select({ id: demands.id })
        .from(demands)
        .where(and(eq(demands.id, parsed.data.demandId), eq(demands.orgId, ctx.orgId)))
        .limit(1);
      if (!d) return reply.code(400).send({ error: "demand_not_found" });
    }

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(asyncVideoCampaigns)
        .values({
          orgId: ctx.orgId,
          demandId: parsed.data.demandId ?? null,
          title: parsed.data.title,
          introText: parsed.data.introText ?? null,
          outroText: parsed.data.outroText ?? null,
          // keep legacy prompts jsonb mirrored for any old consumer
          prompts: parsed.data.questions.map((q, i) => ({ id: `q${i}`, text: q.text })),
          maxSecondsPerPrompt: parsed.data.questions[0]?.maxSeconds ?? 120,
          maxRetakes: parsed.data.questions[0]?.maxRetakes ?? 0,
          status: "draft",
          isPublished: false,
          blindReview: parsed.data.blindReview ?? false,
          requireDeviceCheck: parsed.data.requireDeviceCheck ?? true,
          createdByUserId: ctx.id,
        })
        .returning();
      if (parsed.data.questions.length) {
        await tx.insert(asyncVideoQuestions).values(
          parsed.data.questions.map((q, i) => ({
            orgId: ctx.orgId,
            campaignId: row.id,
            position: i,
            kind: q.kind,
            text: q.text,
            stimulusText: q.stimulusText ?? null,
            stimulusBlobKey: q.stimulusBlobKey ?? null,
            prepSeconds: q.prepSeconds,
            maxSeconds: q.maxSeconds,
            maxRetakes: q.maxRetakes,
            competencyKey: q.competencyKey ?? null,
          })),
        );
      }
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "campaign.create",
        targetType: "campaign",
        targetId: row.id,
        actorUserId: ctx.id,
        payload: { title: row.title, questionCount: parsed.data.questions.length },
      });
      return row;
    });

    const body = { campaign: result };
    if (idemKey) await recordIdempotent(ctx.orgId, "async_video.campaign.create", idemKey, body);
    return reply.code(201).send(body);
  });

  // ---------- CAMPAIGNS: update (optimistic concurrency) ----------
  app.patch("/campaigns/:id", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = updateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [existing] = await db
      .select()
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "campaign_not_found" });
    if (
      parsed.data.expectedVersion !== undefined &&
      parsed.data.expectedVersion !== existing.version
    ) {
      return reply.code(409).send({ error: "version_conflict", currentVersion: existing.version });
    }
    if (parsed.data.demandId) {
      const [d] = await db
        .select({ id: demands.id })
        .from(demands)
        .where(and(eq(demands.id, parsed.data.demandId), eq(demands.orgId, ctx.orgId)))
        .limit(1);
      if (!d) return reply.code(400).send({ error: "demand_not_found" });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date(), version: existing.version + 1 };
    for (const k of ["title", "introText", "outroText", "demandId", "blindReview", "requireDeviceCheck"] as const) {
      if (parsed.data[k] !== undefined) updates[k] = parsed.data[k];
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoCampaigns)
        .set(updates)
        .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
        .returning();
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "campaign.update",
        targetType: "campaign",
        targetId: id,
        actorUserId: ctx.id,
        payload: { fields: Object.keys(updates).filter((k) => k !== "updatedAt" && k !== "version") },
      });
      return r;
    });
    return { campaign: row };
  });

  // ---------- QUESTIONS: add / update / delete / reorder ----------
  app.post("/campaigns/:id/questions", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = questionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [c] = await db
      .select({ id: asyncVideoCampaigns.id })
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    const [{ nextPos }] = await db
      .select({ nextPos: sql<number>`coalesce(max(position) + 1, 0)::int` })
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id));
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(asyncVideoQuestions)
        .values({
          orgId: ctx.orgId,
          campaignId: id,
          position: nextPos,
          kind: parsed.data.kind,
          text: parsed.data.text,
          stimulusText: parsed.data.stimulusText ?? null,
          stimulusBlobKey: parsed.data.stimulusBlobKey ?? null,
          prepSeconds: parsed.data.prepSeconds,
          maxSeconds: parsed.data.maxSeconds,
          maxRetakes: parsed.data.maxRetakes,
          competencyKey: parsed.data.competencyKey ?? null,
        })
        .returning();
      await tx
        .update(asyncVideoCampaigns)
        .set({ updatedAt: new Date() })
        .where(eq(asyncVideoCampaigns.id, id));
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "question.create",
        targetType: "campaign",
        targetId: id,
        actorUserId: ctx.id,
        payload: { questionId: r.id, position: nextPos },
      });
      return r;
    });
    return reply.code(201).send({ question: row });
  });

  app.patch("/questions/:qid", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { qid } = req.params as { qid: string };
    const parsed = questionInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [q] = await db
      .select()
      .from(asyncVideoQuestions)
      .where(and(eq(asyncVideoQuestions.id, qid), eq(asyncVideoQuestions.orgId, ctx.orgId)))
      .limit(1);
    if (!q) return reply.code(404).send({ error: "question_not_found" });
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["kind", "text", "stimulusText", "stimulusBlobKey", "prepSeconds", "maxSeconds", "maxRetakes", "competencyKey"] as const) {
      if (parsed.data[k] !== undefined) updates[k] = parsed.data[k];
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoQuestions)
        .set(updates)
        .where(eq(asyncVideoQuestions.id, qid))
        .returning();
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "question.update",
        targetType: "campaign",
        targetId: q.campaignId,
        actorUserId: ctx.id,
        payload: { questionId: qid },
      });
      return r;
    });
    return { question: row };
  });

  app.delete("/questions/:qid", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { qid } = req.params as { qid: string };
    const [q] = await db
      .select()
      .from(asyncVideoQuestions)
      .where(and(eq(asyncVideoQuestions.id, qid), eq(asyncVideoQuestions.orgId, ctx.orgId)))
      .limit(1);
    if (!q) return reply.code(404).send({ error: "question_not_found" });
    await db.transaction(async (tx) => {
      await tx.delete(asyncVideoQuestions).where(eq(asyncVideoQuestions.id, qid));
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "question.delete",
        targetType: "campaign",
        targetId: q.campaignId,
        actorUserId: ctx.id,
        payload: { questionId: qid },
      });
    });
    return { deleted: qid };
  });

  app.post("/campaigns/:id/questions/reorder", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const body = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(20) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: body.error.flatten() });
    }
    const [c] = await db
      .select({ id: asyncVideoCampaigns.id })
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    await db.transaction(async (tx) => {
      // Two-phase: bump to a high offset to dodge the unique(campaign,position)
      // constraint, then write the final positions.
      for (let i = 0; i < body.data.orderedIds.length; i += 1) {
        await tx
          .update(asyncVideoQuestions)
          .set({ position: 1000 + i })
          .where(and(eq(asyncVideoQuestions.id, body.data.orderedIds[i]), eq(asyncVideoQuestions.campaignId, id)));
      }
      for (let i = 0; i < body.data.orderedIds.length; i += 1) {
        await tx
          .update(asyncVideoQuestions)
          .set({ position: i, updatedAt: new Date() })
          .where(and(eq(asyncVideoQuestions.id, body.data.orderedIds[i]), eq(asyncVideoQuestions.campaignId, id)));
      }
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "question.reorder",
        targetType: "campaign",
        targetId: id,
        actorUserId: ctx.id,
        payload: { count: body.data.orderedIds.length },
      });
    });
    return { reordered: body.data.orderedIds.length };
  });

  // ---------- CAMPAIGNS: publish / archive / duplicate ----------
  app.post("/campaigns/:id/publish", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [c] = await db
      .select()
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    const [{ qcount }] = await db
      .select({ qcount: sql<number>`count(*)::int` })
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id));
    if (qcount === 0) return reply.code(422).send({ error: "no_questions" });
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoCampaigns)
        .set({ status: "published", isPublished: true, archivedAt: null, updatedAt: new Date(), version: c.version + 1 })
        .where(eq(asyncVideoCampaigns.id, id))
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "campaign.publish", targetType: "campaign", targetId: id, actorUserId: ctx.id, payload: { questionCount: qcount } });
      return r;
    });
    return { campaign: row };
  });

  app.post("/campaigns/:id/unpublish", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoCampaigns)
        .set({ status: "draft", isPublished: false, updatedAt: new Date(), version: sql`${asyncVideoCampaigns.version} + 1` })
        .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
        .returning();
      if (!r) return null;
      await recordAudit(tx, { orgId: ctx.orgId, action: "campaign.unpublish", targetType: "campaign", targetId: id, actorUserId: ctx.id, payload: null });
      return r;
    });
    if (!row) return reply.code(404).send({ error: "campaign_not_found" });
    return { campaign: row };
  });

  app.post("/campaigns/:id/archive", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoCampaigns)
        .set({ status: "archived", isPublished: false, archivedAt: new Date(), updatedAt: new Date(), version: sql`${asyncVideoCampaigns.version} + 1` })
        .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
        .returning();
      if (!r) return null;
      await recordAudit(tx, { orgId: ctx.orgId, action: "campaign.archive", targetType: "campaign", targetId: id, actorUserId: ctx.id, payload: null });
      return r;
    });
    if (!row) return reply.code(404).send({ error: "campaign_not_found" });
    return { campaign: row };
  });

  app.post("/campaigns/:id/duplicate", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [c] = await db
      .select()
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    const qs = await db
      .select()
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id))
      .orderBy(asc(asyncVideoQuestions.position));
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(asyncVideoCampaigns)
        .values({
          orgId: ctx.orgId,
          demandId: c.demandId,
          title: `${c.title} (copy)`,
          introText: c.introText,
          outroText: c.outroText,
          prompts: c.prompts,
          maxSecondsPerPrompt: c.maxSecondsPerPrompt,
          maxRetakes: c.maxRetakes,
          status: "draft",
          isPublished: false,
          blindReview: c.blindReview,
          requireDeviceCheck: c.requireDeviceCheck,
          createdByUserId: ctx.id,
        })
        .returning();
      if (qs.length) {
        await tx.insert(asyncVideoQuestions).values(
          qs.map((q) => ({
            orgId: ctx.orgId,
            campaignId: row.id,
            position: q.position,
            kind: q.kind,
            text: q.text,
            stimulusText: q.stimulusText,
            stimulusBlobKey: q.stimulusBlobKey,
            prepSeconds: q.prepSeconds,
            maxSeconds: q.maxSeconds,
            maxRetakes: q.maxRetakes,
            competencyKey: q.competencyKey,
          })),
        );
      }
      await recordAudit(tx, { orgId: ctx.orgId, action: "campaign.duplicate", targetType: "campaign", targetId: row.id, actorUserId: ctx.id, payload: { from: id } });
      return row;
    });
    return reply.code(201).send({ campaign: result });
  });

  // ---------- INVITES ----------
  app.post("/invites", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "async_video.invite", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }
    const [c] = await db
      .select({ id: asyncVideoCampaigns.id })
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, parsed.data.campaignId), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    if (parsed.data.candidateId) {
      const [cand] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(and(eq(candidates.id, parsed.data.candidateId), eq(candidates.orgId, ctx.orgId)))
        .limit(1);
      if (!cand) return reply.code(400).send({ error: "candidate_not_found" });
    }
    const token = newToken();
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(asyncVideoSubmissions)
        .values({
          orgId: ctx.orgId,
          campaignId: parsed.data.campaignId,
          candidateId: parsed.data.candidateId ?? null,
          inviteToken: token,
          invitedByUserId: ctx.id,
          status: "invited",
          expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 3_600_000),
        })
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.create", targetType: "invite", targetId: r.id, actorUserId: ctx.id, payload: { candidateId: r.candidateId } });
      return r;
    });
    const link = `${env.APP_BASE_URL}/async-video/submit/${token}`;
    const body = { submission: row, inviteToken: token, inviteLink: link };
    if (idemKey) await recordIdempotent(ctx.orgId, "async_video.invite", idemKey, body);
    return reply.code(201).send(body);
  });

  app.post("/invites/bulk", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [c] = await db
      .select({ id: asyncVideoCampaigns.id })
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, parsed.data.campaignId), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });

    // Dedup already-invited candidates on this campaign (non-terminal states).
    const existing = await db
      .select({ candidateId: asyncVideoSubmissions.candidateId })
      .from(asyncVideoSubmissions)
      .where(
        and(
          eq(asyncVideoSubmissions.campaignId, parsed.data.campaignId),
          inArray(asyncVideoSubmissions.candidateId, parsed.data.candidateIds),
        ),
      );
    const alreadyInvited = new Set(existing.map((e) => e.candidateId));
    const toInvite = parsed.data.candidateIds.filter((cid) => !alreadyInvited.has(cid));

    const created = await db.transaction(async (tx) => {
      const rows = [] as Array<{ id: string; candidateId: string | null; inviteToken: string }>;
      for (const cid of toInvite) {
        const token = newToken();
        const [r] = await tx
          .insert(asyncVideoSubmissions)
          .values({
            orgId: ctx.orgId,
            campaignId: parsed.data.campaignId,
            candidateId: cid,
            inviteToken: token,
            invitedByUserId: ctx.id,
            status: "invited",
            expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 3_600_000),
          })
          .returning({ id: asyncVideoSubmissions.id, candidateId: asyncVideoSubmissions.candidateId, inviteToken: asyncVideoSubmissions.inviteToken });
        rows.push(r);
        await recordAudit(tx, { orgId: ctx.orgId, action: "invite.create", targetType: "invite", targetId: r.id, actorUserId: ctx.id, payload: { candidateId: cid, bulk: true } });
      }
      return rows;
    });
    return reply.code(201).send({ created: created.length, skipped: alreadyInvited.size, submissions: created });
  });

  app.post("/submissions/:id/remind", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select()
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    if (sub.status === "submitted" || sub.status === "reviewed") {
      return reply.code(409).send({ error: "already_submitted" });
    }
    if (sub.lastReminderAt && Date.now() - sub.lastReminderAt.getTime() < 24 * 3_600_000) {
      return reply.code(429).send({ error: "reminder_too_soon", retryAfterHours: 24 });
    }
    const link = `${env.APP_BASE_URL}/async-video/submit/${sub.inviteToken}`;
    // Reminder dispatch through the messaging stub (real provider plugs in there).
    let to = "candidate";
    if (sub.candidateId) {
      const [cand] = await db.select({ email: candidates.email, phone: candidates.phone }).from(candidates).where(eq(candidates.id, sub.candidateId)).limit(1);
      to = cand?.email ?? cand?.phone ?? "candidate";
    }
    const row = await db.transaction(async (tx) => {
      await tx.insert(messagingEvents).values({
        orgId: ctx.orgId,
        candidateId: sub.candidateId ?? null,
        recruiterUserId: ctx.id,
        channel: "email",
        provider: "mock",
        direction: "outbound",
        toAddress: to,
        body: `Reminder: please complete your video screening. ${link}`,
        status: "delivered",
        remoteId: `mock-${randomUUID().slice(0, 8)}`,
        deliveredAt: new Date(),
      });
      const [r] = await tx
        .update(asyncVideoSubmissions)
        .set({ lastReminderAt: new Date(), reminderCount: sub.reminderCount + 1, updatedAt: new Date() })
        .where(eq(asyncVideoSubmissions.id, id))
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.remind", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { reminderCount: r.reminderCount } });
      return r;
    });
    return { submission: row };
  });

  app.post("/submissions/:id/revoke", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoSubmissions)
        .set({ status: "expired", expiresAt: new Date(), updatedAt: new Date() })
        .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
        .returning();
      if (!r) return null;
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.revoke", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: null });
      return r;
    });
    if (!row) return reply.code(404).send({ error: "submission_not_found" });
    return { submission: row };
  });

  // ---------- REVIEW QUEUE (keyset) ----------
  app.get("/queue", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const qy = parsed.data;
    const conds = [eq(asyncVideoSubmissions.orgId, ctx.orgId)];
    if (qy.status) conds.push(eq(asyncVideoSubmissions.status, qy.status));
    if (qy.campaignId) conds.push(eq(asyncVideoSubmissions.campaignId, qy.campaignId));
    if (qy.decision) conds.push(eq(asyncVideoSubmissions.reviewerDecision, qy.decision));
    if (qy.shortlisted) conds.push(eq(asyncVideoSubmissions.shortlisted, qy.shortlisted === "true"));
    if (qy.reviewerUserId) conds.push(eq(asyncVideoSubmissions.reviewerUserId, qy.reviewerUserId));
    if (qy.q) conds.push(ilike(candidates.displayName, `%${qy.q}%`));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(asyncVideoSubmissions)
      .leftJoin(candidates, eq(candidates.id, asyncVideoSubmissions.candidateId))
      .where(and(...conds));

    const keysetConds = [...conds];
    if (qy.cursor) {
      const cur = decodeCursor(qy.cursor);
      if (!cur) return reply.code(400).send({ error: "invalid_cursor" });
      keysetConds.push(
        or(
          lt(asyncVideoSubmissions.createdAt, new Date(cur.createdAt)),
          and(eq(asyncVideoSubmissions.createdAt, new Date(cur.createdAt)), lt(asyncVideoSubmissions.id, cur.id)),
        )!,
      );
    }
    const rows = await db
      .select({
        id: asyncVideoSubmissions.id,
        campaignId: asyncVideoSubmissions.campaignId,
        campaignTitle: asyncVideoCampaigns.title,
        candidateId: asyncVideoSubmissions.candidateId,
        candidateName: candidates.displayName,
        status: asyncVideoSubmissions.status,
        shortlisted: asyncVideoSubmissions.shortlisted,
        reviewerDecision: asyncVideoSubmissions.reviewerDecision,
        reviewerScore: asyncVideoSubmissions.reviewerScore,
        dropOffPromptIndex: asyncVideoSubmissions.dropOffPromptIndex,
        submittedAt: asyncVideoSubmissions.submittedAt,
        reviewedAt: asyncVideoSubmissions.reviewedAt,
        createdAt: asyncVideoSubmissions.createdAt,
        scorecardCount: sql<number>`(
          select count(*)::int from async_video_scorecards sc where sc.submission_id = ${asyncVideoSubmissions.id} and sc.submitted = true
        )`,
        aiSummaryStatus: sql<string | null>`(
          select status from async_video_ai_artifacts a where a.submission_id = ${asyncVideoSubmissions.id} and a.kind = 'summary' limit 1
        )`,
      })
      .from(asyncVideoSubmissions)
      .leftJoin(asyncVideoCampaigns, eq(asyncVideoCampaigns.id, asyncVideoSubmissions.campaignId))
      .leftJoin(candidates, eq(candidates.id, asyncVideoSubmissions.candidateId))
      .where(and(...keysetConds))
      .orderBy(desc(asyncVideoSubmissions.createdAt), desc(asyncVideoSubmissions.id))
      .limit(qy.limit);

    const nextCursor =
      rows.length === qy.limit
        ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].id)
        : null;
    return { submissions: rows, nextCursor, total };
  });

  // ---------- SUBMISSION detail ----------
  app.get("/submissions/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const detail = await loadSubmissionDetail(ctx.orgId, id);
    if (!detail) return reply.code(404).send({ error: "submission_not_found" });
    return detail;
  });

  // ---------- VIDEO playback (closes the "can't watch the video" hard-fail) ----------
  app.get("/submissions/:id/video/:promptIndex", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id, promptIndex } = req.params as { id: string; promptIndex: string };
    const idx = Number(promptIndex);
    if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: "bad_prompt_index" });
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id, videos: asyncVideoSubmissions.videos })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const clip = (sub.videos ?? []).find((v) => v.promptIndex === idx);
    if (!clip) return reply.code(404).send({ error: "clip_not_found" });

    const absPath = resolveBlobPath(clip.blobKey);
    if (!absPath) return reply.code(403).send({ error: "path_outside_blob_root" });
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return reply.code(404).send({ error: "clip_file_missing" });
    }
    if (!stats.isFile()) return reply.code(404).send({ error: "not_a_file" });

    // Chain-of-custody: who viewed which clip when.
    await recordAudit(db, { orgId: ctx.orgId, action: "submission.view", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { promptIndex: idx } });

    const total = stats.size;
    const mime = "video/webm";
    const range = req.headers.range;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", mime);
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).send({ error: "bad_range" });
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.code(416).send({ error: "range_not_satisfiable" });
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(absPath, { start, end }));
    }
    reply.header("Content-Length", String(total));
    return reply.send(createReadStream(absPath));
  });

  // ---------- SHORTLIST ----------
  app.post("/submissions/:id/shortlist", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const body = z.object({ shortlisted: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload", issues: body.error.flatten() });
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoSubmissions)
        .set({ shortlisted: body.data.shortlisted, updatedAt: new Date() })
        .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
        .returning();
      if (!r) return null;
      await recordAudit(tx, { orgId: ctx.orgId, action: "submission.shortlist", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { shortlisted: body.data.shortlisted } });
      return r;
    });
    if (!row) return reply.code(404).send({ error: "submission_not_found" });
    return { submission: row };
  });

  // ---------- COMPARE ----------
  app.get("/campaigns/:id/compare", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const idsRaw = (req.query as { ids?: string }).ids ?? "";
    const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length < 2) return reply.code(400).send({ error: "need_at_least_two" });
    const [c] = await db
      .select({ id: asyncVideoCampaigns.id })
      .from(asyncVideoCampaigns)
      .where(and(eq(asyncVideoCampaigns.id, id), eq(asyncVideoCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });
    const questions = await db
      .select({ id: asyncVideoQuestions.id, position: asyncVideoQuestions.position, text: asyncVideoQuestions.text })
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id))
      .orderBy(asc(asyncVideoQuestions.position));
    const subs = await db
      .select({
        id: asyncVideoSubmissions.id,
        candidateId: asyncVideoSubmissions.candidateId,
        candidateName: candidates.displayName,
        status: asyncVideoSubmissions.status,
        shortlisted: asyncVideoSubmissions.shortlisted,
      })
      .from(asyncVideoSubmissions)
      .leftJoin(candidates, eq(candidates.id, asyncVideoSubmissions.candidateId))
      .where(and(eq(asyncVideoSubmissions.campaignId, id), eq(asyncVideoSubmissions.orgId, ctx.orgId), inArray(asyncVideoSubmissions.id, ids)));
    const cards = await db
      .select()
      .from(asyncVideoScorecards)
      .where(and(eq(asyncVideoScorecards.orgId, ctx.orgId), inArray(asyncVideoScorecards.submissionId, ids), eq(asyncVideoScorecards.submitted, true)));
    const summaries = await db
      .select({ submissionId: asyncVideoAiArtifacts.submissionId, content: asyncVideoAiArtifacts.content })
      .from(asyncVideoAiArtifacts)
      .where(and(eq(asyncVideoAiArtifacts.orgId, ctx.orgId), inArray(asyncVideoAiArtifacts.submissionId, ids), eq(asyncVideoAiArtifacts.kind, "summary")));
    return {
      questions,
      submissions: subs.map((s) => {
        const myCards = cards.filter((c2) => c2.submissionId === s.id);
        const overall =
          myCards.length > 0
            ? myCards.reduce((a, b) => a + (b.overallScore ?? 0), 0) / myCards.length
            : null;
        return {
          ...s,
          scorecardCount: myCards.length,
          avgOverall: overall == null ? null : Math.round(overall * 10) / 10,
          aiSummary: (summaries.find((x) => x.submissionId === s.id)?.content as { summary?: string } | undefined)?.summary ?? null,
        };
      }),
    };
  });

  // ---------- SCORECARD upsert (own only) ----------
  app.put("/submissions/:id/scorecard", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = scorecardSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id, campaignId: asyncVideoSubmissions.campaignId })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });

    const overallScore = computeOverallScore(parsed.data.questionScores);

    // Atomic (A7): scorecard upsert + submission status update + audit all in
    // one txn so a partial failure can't diverge state from the audit log.
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: asyncVideoScorecards.id })
        .from(asyncVideoScorecards)
        .where(and(eq(asyncVideoScorecards.submissionId, id), eq(asyncVideoScorecards.reviewerUserId, ctx.id)))
        .limit(1);

      let card;
      if (existing) {
        [card] = await tx
          .update(asyncVideoScorecards)
          .set({
            questionScores: parsed.data.questionScores,
            overallScore,
            recommendation: parsed.data.recommendation ?? null,
            summaryNote: parsed.data.summaryNote ?? null,
            submitted: parsed.data.submitted,
            updatedAt: new Date(),
          })
          .where(eq(asyncVideoScorecards.id, existing.id))
          .returning();
      } else {
        [card] = await tx
          .insert(asyncVideoScorecards)
          .values({
            orgId: ctx.orgId,
            submissionId: id,
            reviewerUserId: ctx.id,
            questionScores: parsed.data.questionScores,
            overallScore,
            recommendation: parsed.data.recommendation ?? null,
            summaryNote: parsed.data.summaryNote ?? null,
            submitted: parsed.data.submitted,
          })
          .returning();
      }

      // When finalized, reflect a coarse decision + score onto the submission so
      // the queue/legacy fields stay meaningful.
      if (parsed.data.submitted) {
        const decision =
          parsed.data.recommendation === "strong_yes" || parsed.data.recommendation === "yes"
            ? "forward"
            : parsed.data.recommendation === "maybe"
              ? "hold"
              : parsed.data.recommendation
                ? "reject"
                : null;
        await tx
          .update(asyncVideoSubmissions)
          .set({
            status: "reviewed",
            reviewerUserId: ctx.id,
            reviewerDecision: decision,
            reviewerScore: overallScore == null ? null : Math.round(overallScore),
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(asyncVideoSubmissions.id, id));
      }
      await recordAudit(tx, { orgId: ctx.orgId, action: parsed.data.submitted ? "scorecard.submit" : "scorecard.draft", targetType: "scorecard", targetId: card.id, actorUserId: ctx.id, payload: { submissionId: id, overallScore } });
      return card;
    });
    return { scorecard: row };
  });

  // ---------- AGREEMENT ----------
  app.get("/submissions/:id/agreement", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const cards = await db
      .select({
        reviewerUserId: asyncVideoScorecards.reviewerUserId,
        externalReviewerLabel: asyncVideoScorecards.externalReviewerLabel,
        overallScore: asyncVideoScorecards.overallScore,
        questionScores: asyncVideoScorecards.questionScores,
      })
      .from(asyncVideoScorecards)
      .where(and(eq(asyncVideoScorecards.submissionId, id), eq(asyncVideoScorecards.submitted, true)));
    const agreement = computeAgreement(
      cards.map((c) => ({
        reviewerLabel: c.reviewerUserId ?? c.externalReviewerLabel ?? "reviewer",
        overallScore: c.overallScore,
        questionScores: c.questionScores ?? [],
      })),
    );
    return agreement;
  });

  // ---------- COMMENTS ----------
  app.get("/submissions/:id/comments", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const rows = await db
      .select({
        id: asyncVideoComments.id,
        body: asyncVideoComments.body,
        questionId: asyncVideoComments.questionId,
        timestampSec: asyncVideoComments.timestampSec,
        authorUserId: asyncVideoComments.authorUserId,
        authorName: users.name,
        createdAt: asyncVideoComments.createdAt,
      })
      .from(asyncVideoComments)
      .leftJoin(users, eq(users.id, asyncVideoComments.authorUserId))
      .where(eq(asyncVideoComments.submissionId, id))
      .orderBy(asc(asyncVideoComments.createdAt));
    return { comments: rows };
  });

  app.post("/submissions/:id/comments", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(asyncVideoComments)
        .values({
          orgId: ctx.orgId,
          submissionId: id,
          authorUserId: ctx.id,
          questionId: parsed.data.questionId ?? null,
          timestampSec: parsed.data.timestampSec ?? null,
          body: parsed.data.body,
        })
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "comment.create", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { commentId: r.id } });
      return r;
    });
    return reply.code(201).send({ comment: row });
  });

  // ---------- SHARE LINKS ----------
  app.get("/submissions/:id/share-links", { preHandler: [canShare] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const rows = await db
      .select()
      .from(asyncVideoShareLinks)
      .where(eq(asyncVideoShareLinks.submissionId, id))
      .orderBy(desc(asyncVideoShareLinks.createdAt));
    return {
      shareLinks: rows.map((r) => ({
        ...r,
        url: `${env.APP_BASE_URL}/external-review/${r.token}`,
        active: !r.revokedAt && r.expiresAt.getTime() > Date.now(),
      })),
    };
  });

  app.post("/submissions/:id/share-links", { preHandler: [canShare] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = shareLinkSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "async_video.share", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const token = newToken();
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(asyncVideoShareLinks)
        .values({
          orgId: ctx.orgId,
          submissionId: id,
          token,
          label: parsed.data.label ?? null,
          canScore: parsed.data.canScore,
          createdByUserId: ctx.id,
          expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 3_600_000),
        })
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "share_link.create", targetType: "share_link", targetId: r.id, actorUserId: ctx.id, payload: { submissionId: id } });
      return r;
    });
    const body = { shareLink: row, url: `${env.APP_BASE_URL}/external-review/${token}` };
    if (idemKey) await recordIdempotent(ctx.orgId, "async_video.share", idemKey, body);
    return reply.code(201).send(body);
  });

  app.delete("/share-links/:id", { preHandler: [canShare] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(asyncVideoShareLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(asyncVideoShareLinks.id, id), eq(asyncVideoShareLinks.orgId, ctx.orgId)))
        .returning();
      if (!r) return null;
      await recordAudit(tx, { orgId: ctx.orgId, action: "share_link.revoke", targetType: "share_link", targetId: id, actorUserId: ctx.id, payload: null });
      return r;
    });
    if (!row) return reply.code(404).send({ error: "share_link_not_found" });
    return { shareLink: row };
  });

  // ---------- AI artifacts ----------
  app.get("/submissions/:id/ai", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const rows = await db
      .select()
      .from(asyncVideoAiArtifacts)
      .where(eq(asyncVideoAiArtifacts.submissionId, id))
      .orderBy(asc(asyncVideoAiArtifacts.kind));
    return { artifacts: rows, configured: isAiConfigured() };
  });

  app.post("/submissions/:id/ai/transcribe", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select()
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });

    const resolved = await resolveAiCreds(ctx.orgId);
    if (!resolved.configured) {
      // Land skipped rows so the UI shows the state, then 503 with a known code.
      await upsertSkippedAiRows(ctx.orgId, id);
      await recordAudit(db, { orgId: ctx.orgId, action: "ai.request", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { result: "skipped" } });
      return reply.code(503).send({ error: "openai_not_configured" });
    }

    try {
      await runAiForSubmission(ctx.orgId, id, sub.videos ?? [], sub.campaignId, resolved);
    } catch (err) {
      // Never surface a bare 500 from the AI path. Land failed rows so the UI
      // reflects the state, then answer with a known code.
      req.log.error({ err, submissionId: id }, "async-video ai/transcribe failed");
      const detail = err instanceof Error ? err.message : String(err);
      for (const kind of ["transcript", "summary", "skills"] as const) {
        await upsertAiArtifact({ orgId: ctx.orgId, submissionId: id, questionId: null, kind, status: "failed", provider: "openai", errorText: detail }).catch(() => {});
      }
      await recordAudit(db, { orgId: ctx.orgId, action: "ai.request", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { result: "failed" } });
      return reply.code(502).send({ error: "ai_failed", detail });
    }
    await recordAudit(db, { orgId: ctx.orgId, action: "ai.request", targetType: "submission", targetId: id, actorUserId: ctx.id, payload: { result: "ready" } });
    const rows = await db.select().from(asyncVideoAiArtifacts).where(eq(asyncVideoAiArtifacts.submissionId, id));
    return { artifacts: rows };
  });

  // ---------- AUDIT timeline ----------
  app.get("/submissions/:id/audit", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, ctx.orgId)))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "submission_not_found" });
    const rows = await db
      .select({
        id: asyncVideoAuditLog.id,
        action: asyncVideoAuditLog.action,
        actorUserId: asyncVideoAuditLog.actorUserId,
        actorName: users.name,
        actorLabel: asyncVideoAuditLog.actorLabel,
        payload: asyncVideoAuditLog.payload,
        createdAt: asyncVideoAuditLog.createdAt,
      })
      .from(asyncVideoAuditLog)
      .leftJoin(users, eq(users.id, asyncVideoAuditLog.actorUserId))
      .where(and(eq(asyncVideoAuditLog.orgId, ctx.orgId), eq(asyncVideoAuditLog.targetId, id)))
      .orderBy(desc(asyncVideoAuditLog.id))
      .limit(100);
    return { entries: rows };
  });
}

// ---------------------------------------------------------------------------
// Shared detail loader (reused by authed + external review)
// ---------------------------------------------------------------------------

async function loadSubmissionDetail(orgId: string, id: string, opts: { blind?: boolean } = {}) {
  const [sub] = await db
    .select()
    .from(asyncVideoSubmissions)
    .where(and(eq(asyncVideoSubmissions.id, id), eq(asyncVideoSubmissions.orgId, orgId)))
    .limit(1);
  if (!sub) return null;
  const [campaign] = await db
    .select()
    .from(asyncVideoCampaigns)
    .where(eq(asyncVideoCampaigns.id, sub.campaignId))
    .limit(1);
  const questions = await db
    .select()
    .from(asyncVideoQuestions)
    .where(eq(asyncVideoQuestions.campaignId, sub.campaignId))
    .orderBy(asc(asyncVideoQuestions.position));
  const blind = opts.blind ?? campaign?.blindReview ?? false;
  let candidate: { id: string; displayName: string | null } | null = null;
  if (sub.candidateId && !blind) {
    const [cand] = await db
      .select({ id: candidates.id, displayName: candidates.displayName })
      .from(candidates)
      .where(eq(candidates.id, sub.candidateId))
      .limit(1);
    candidate = cand ?? null;
  }
  const scorecards = await db
    .select({
      id: asyncVideoScorecards.id,
      reviewerUserId: asyncVideoScorecards.reviewerUserId,
      reviewerName: users.name,
      externalReviewerLabel: asyncVideoScorecards.externalReviewerLabel,
      questionScores: asyncVideoScorecards.questionScores,
      overallScore: asyncVideoScorecards.overallScore,
      recommendation: asyncVideoScorecards.recommendation,
      summaryNote: asyncVideoScorecards.summaryNote,
      submitted: asyncVideoScorecards.submitted,
      updatedAt: asyncVideoScorecards.updatedAt,
    })
    .from(asyncVideoScorecards)
    .leftJoin(users, eq(users.id, asyncVideoScorecards.reviewerUserId))
    .where(eq(asyncVideoScorecards.submissionId, id))
    .orderBy(asc(asyncVideoScorecards.createdAt));
  const ai = await db
    .select()
    .from(asyncVideoAiArtifacts)
    .where(eq(asyncVideoAiArtifacts.submissionId, id));
  const videos = (sub.videos ?? []).map((v) => ({
    promptIndex: v.promptIndex,
    durationSec: v.durationSec,
    recordedAt: v.recordedAt,
  }));
  return {
    submission: {
      id: sub.id,
      campaignId: sub.campaignId,
      status: sub.status,
      shortlisted: sub.shortlisted,
      reviewerDecision: sub.reviewerDecision,
      reviewerScore: sub.reviewerScore,
      dropOffPromptIndex: sub.dropOffPromptIndex,
      deviceCheck: sub.deviceCheck,
      reminderCount: sub.reminderCount,
      startedAt: sub.startedAt,
      submittedAt: sub.submittedAt,
      reviewedAt: sub.reviewedAt,
      createdAt: sub.createdAt,
    },
    campaign: campaign
      ? { id: campaign.id, title: campaign.title, blindReview: campaign.blindReview, requireDeviceCheck: campaign.requireDeviceCheck }
      : null,
    candidate,
    questions,
    videos,
    scorecards,
    ai,
  };
}

// Land queued→skipped AI rows so the UI shows the unconfigured state.
async function upsertSkippedAiRows(orgId: string, submissionId: string) {
  for (const kind of ["transcript", "summary", "skills"] as const) {
    await db
      .insert(asyncVideoAiArtifacts)
      .values({ orgId, submissionId, kind, status: "skipped", provider: "stub", errorText: "OPENAI_API_KEY not configured" })
      .onConflictDoNothing();
  }
}

// Upsert one AI artifact keyed by (submission, question-or-whole, kind),
// matching migration 0029's COALESCE()-expression unique index. Drizzle's
// onConflictDoUpdate only accepts column targets (not an expression index), so
// we do an explicit select-then-update/insert. `questionId` NULL means a
// whole-submission artifact (summary/skills).
async function upsertAiArtifact(args: {
  orgId: string;
  submissionId: string;
  questionId: string | null;
  kind: "transcript" | "summary" | "skills";
  status: "queued" | "running" | "ready" | "failed" | "skipped";
  provider: string | null;
  model?: string | null;
  content?: unknown;
  errorText?: string | null;
}): Promise<void> {
  const qCond =
    args.questionId === null
      ? sql`question_id IS NULL`
      : eq(asyncVideoAiArtifacts.questionId, args.questionId);
  const [existing] = await db
    .select({ id: asyncVideoAiArtifacts.id })
    .from(asyncVideoAiArtifacts)
    .where(and(eq(asyncVideoAiArtifacts.submissionId, args.submissionId), eq(asyncVideoAiArtifacts.kind, args.kind), qCond))
    .limit(1);
  if (existing) {
    await db
      .update(asyncVideoAiArtifacts)
      .set({
        status: args.status,
        provider: args.provider,
        model: args.model ?? null,
        content: args.content ?? null,
        errorText: args.errorText ?? null,
        updatedAt: new Date(),
      })
      .where(eq(asyncVideoAiArtifacts.id, existing.id));
  } else {
    await db.insert(asyncVideoAiArtifacts).values({
      orgId: args.orgId,
      submissionId: args.submissionId,
      questionId: args.questionId,
      kind: args.kind,
      status: args.status,
      provider: args.provider,
      model: args.model ?? null,
      content: args.content ?? null,
      errorText: args.errorText ?? null,
    });
  }
}

// Run the real (or stub) AI pipeline for one submission's clips.
async function runAiForSubmission(
  orgId: string,
  submissionId: string,
  videos: Array<{ promptIndex: number; blobKey: string; durationSec: number; recordedAt: string }>,
  campaignId: string,
  resolved: Awaited<ReturnType<typeof resolveAiCreds>>,
) {
  const questions = await db
    .select({ id: asyncVideoQuestions.id, position: asyncVideoQuestions.position, text: asyncVideoQuestions.text })
    .from(asyncVideoQuestions)
    .where(eq(asyncVideoQuestions.campaignId, campaignId))
    .orderBy(asc(asyncVideoQuestions.position));

  const perQuestion: Array<{ text: string; transcript: string }> = [];
  for (const q of questions) {
    const clip = videos.find((v) => v.promptIndex === q.position);
    let audio: Buffer | null = null;
    if (clip) {
      const absPath = resolveBlobPath(clip.blobKey);
      if (absPath) {
        try {
          const fs = await import("node:fs/promises");
          audio = await fs.readFile(absPath);
        } catch {
          audio = null;
        }
      }
    }
    const t = await transcribeClip(resolved, audio);
    perQuestion.push({ text: q.text, transcript: t.text });
    await upsertAiArtifact({
      orgId,
      submissionId,
      questionId: q.id,
      kind: "transcript",
      status: "ready",
      provider: t.provider,
      model: t.model,
      content: { text: t.text },
    });
  }

  const summary = await summarizeSubmission(resolved, perQuestion);
  for (const [kind, content] of [
    ["summary", { summary: summary.summary }],
    ["skills", { skills: summary.skills }],
  ] as const) {
    await upsertAiArtifact({
      orgId,
      submissionId,
      questionId: null,
      kind,
      status: "ready",
      provider: summary.provider,
      model: summary.model,
      content,
    });
  }
}

// ---------------------------------------------------------------------------
// Public token-gated routes (candidate-facing) + external-reviewer
// ---------------------------------------------------------------------------

export async function publicAsyncVideoRoutes(app: FastifyInstance) {
  // ---------- EXTERNAL REVIEW (share-link token) ----------
  app.get("/external-review/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const [link] = await db
      .select()
      .from(asyncVideoShareLinks)
      .where(eq(asyncVideoShareLinks.token, token))
      .limit(1);
    if (!link) return reply.code(404).send({ error: "invalid_token" });
    if (link.revokedAt) return reply.code(410).send({ error: "revoked" });
    if (link.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    await db
      .update(asyncVideoShareLinks)
      .set({ lastViewedAt: new Date(), viewCount: link.viewCount + 1 })
      .where(eq(asyncVideoShareLinks.id, link.id));
    // External reviewers always see the submission blind (no candidate PII).
    const detail = await loadSubmissionDetail(link.orgId, link.submissionId, { blind: true });
    if (!detail) return reply.code(404).send({ error: "submission_not_found" });
    return { ...detail, shareLink: { id: link.id, label: link.label, canScore: link.canScore, expiresAt: link.expiresAt } };
  });

  app.post("/external-review/:token/scorecard", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = scorecardSchema.extend({ reviewerLabel: z.string().min(1).max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [link] = await db
      .select()
      .from(asyncVideoShareLinks)
      .where(eq(asyncVideoShareLinks.token, token))
      .limit(1);
    if (!link) return reply.code(404).send({ error: "invalid_token" });
    if (link.revokedAt || link.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    if (!link.canScore) return reply.code(403).send({ error: "scoring_disabled" });
    const overallScore = computeOverallScore(parsed.data.questionScores);
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(asyncVideoScorecards)
        .values({
          orgId: link.orgId,
          submissionId: link.submissionId,
          externalReviewerLabel: parsed.data.reviewerLabel,
          shareLinkId: link.id,
          questionScores: parsed.data.questionScores,
          overallScore,
          recommendation: parsed.data.recommendation ?? null,
          summaryNote: parsed.data.summaryNote ?? null,
          submitted: parsed.data.submitted,
        })
        .returning();
      await recordAudit(tx, { orgId: link.orgId, action: "scorecard.external", targetType: "scorecard", targetId: r.id, actorUserId: null, actorLabel: parsed.data.reviewerLabel, payload: { submissionId: link.submissionId } });
      return r;
    });
    return reply.code(201).send({ scorecard: row });
  });

  // ---------- VIDEO playback for external reviewer ----------
  app.get("/external-review/:token/video/:promptIndex", async (req, reply) => {
    const { token, promptIndex } = req.params as { token: string; promptIndex: string };
    const idx = Number(promptIndex);
    if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: "bad_prompt_index" });
    const [link] = await db
      .select()
      .from(asyncVideoShareLinks)
      .where(eq(asyncVideoShareLinks.token, token))
      .limit(1);
    if (!link) return reply.code(404).send({ error: "invalid_token" });
    if (link.revokedAt || link.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    const [sub] = await db
      .select({ videos: asyncVideoSubmissions.videos })
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.id, link.submissionId))
      .limit(1);
    const clip = (sub?.videos ?? []).find((v) => v.promptIndex === idx);
    if (!clip) return reply.code(404).send({ error: "clip_not_found" });
    const absPath = resolveBlobPath(clip.blobKey);
    if (!absPath) return reply.code(403).send({ error: "path_outside_blob_root" });
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return reply.code(404).send({ error: "clip_file_missing" });
    }
    const total = stats.size;
    const range = req.headers.range;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "video/webm");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).send({ error: "bad_range" });
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (start > end || end >= total) {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.code(416).send({ error: "range_not_satisfiable" });
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(absPath, { start, end }));
    }
    reply.header("Content-Length", String(total));
    return reply.send(createReadStream(absPath));
  });

  // ---------- CANDIDATE FLOW ----------
  app.get("/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const [sub] = await db
      .select()
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.inviteToken, token))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "invalid_token" });
    if (sub.expiresAt && sub.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ error: "expired" });
    }
    if (sub.status === "submitted" || sub.status === "reviewed") {
      return reply.code(409).send({ error: "already_submitted" });
    }
    const [campaign] = await db
      .select()
      .from(asyncVideoCampaigns)
      .where(eq(asyncVideoCampaigns.id, sub.campaignId))
      .limit(1);
    if (!campaign) return reply.code(404).send({ error: "campaign_missing" });
    const questions = await db
      .select({
        id: asyncVideoQuestions.id,
        position: asyncVideoQuestions.position,
        kind: asyncVideoQuestions.kind,
        text: asyncVideoQuestions.text,
        stimulusText: asyncVideoQuestions.stimulusText,
        prepSeconds: asyncVideoQuestions.prepSeconds,
        maxSeconds: asyncVideoQuestions.maxSeconds,
        maxRetakes: asyncVideoQuestions.maxRetakes,
      })
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, sub.campaignId))
      .orderBy(asc(asyncVideoQuestions.position));

    if (sub.status === "invited") {
      await db
        .update(asyncVideoSubmissions)
        .set({ status: "started", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(asyncVideoSubmissions.id, sub.id));
      await recordAudit(db, { orgId: sub.orgId, action: "submission.start", targetType: "submission", targetId: sub.id, actorUserId: null, payload: null });
      try {
        await db.insert(proctorSessions).values({
          orgId: sub.orgId,
          assessmentAttemptId: null,
          asyncVideoSubmissionId: sub.id,
          candidateId: sub.candidateId ?? null,
          status: "live",
        });
      } catch {
        // best-effort
      }
    }
    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        introText: campaign.introText,
        outroText: campaign.outroText,
        requireDeviceCheck: campaign.requireDeviceCheck,
        // legacy fields for older clients
        prompts: campaign.prompts,
        maxSecondsPerPrompt: campaign.maxSecondsPerPrompt,
        maxRetakes: campaign.maxRetakes,
      },
      questions,
      submissionId: sub.id,
      deviceCheck: sub.deviceCheck,
      expiresAt: sub.expiresAt,
    };
  });

  app.post("/:token/device-check", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = deviceCheckSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id, orgId: asyncVideoSubmissions.orgId, status: asyncVideoSubmissions.status, expiresAt: asyncVideoSubmissions.expiresAt })
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.inviteToken, token))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "invalid_token" });
    if (sub.expiresAt && sub.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    const deviceCheck = {
      camera: parsed.data.camera,
      mic: parsed.data.mic,
      bandwidthKbps: parsed.data.bandwidthKbps ?? null,
      checkedAt: new Date().toISOString(),
    };
    await db
      .update(asyncVideoSubmissions)
      .set({ deviceCheck, updatedAt: new Date() })
      .where(eq(asyncVideoSubmissions.id, sub.id));
    return { deviceCheck };
  });

  app.post("/:token/heartbeat", async (req, reply) => {
    const { token } = req.params as { token: string };
    const body = z.object({ promptIndex: z.number().int().min(0).max(50) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload", issues: body.error.flatten() });
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id })
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.inviteToken, token))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "invalid_token" });
    await db
      .update(asyncVideoSubmissions)
      .set({ dropOffPromptIndex: body.data.promptIndex, updatedAt: new Date() })
      .where(eq(asyncVideoSubmissions.id, sub.id));
    return { ok: true };
  });

  app.post("/:token/submit", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [sub] = await db
      .select()
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.inviteToken, token))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "invalid_token" });
    if (sub.status === "submitted" || sub.status === "reviewed") {
      return reply.code(409).send({ error: "already_submitted" });
    }
    if (sub.expiresAt && sub.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ error: "expired" });
    }
    await db
      .update(asyncVideoSubmissions)
      .set({ status: "submitted", submittedAt: new Date(), videos: parsed.data.videos, dropOffPromptIndex: null, updatedAt: new Date() })
      .where(eq(asyncVideoSubmissions.id, sub.id));
    await recordAudit(db, { orgId: sub.orgId, action: "submission.submit", targetType: "submission", targetId: sub.id, actorUserId: null, payload: { clipCount: parsed.data.videos.length } });
    // Enqueue (inline) AI when configured; otherwise land skipped rows.
    try {
      const resolved = await resolveAiCreds(sub.orgId);
      if (resolved.configured) {
        await runAiForSubmission(sub.orgId, sub.id, parsed.data.videos, sub.campaignId, resolved);
      } else {
        await upsertSkippedAiRows(sub.orgId, sub.id);
      }
    } catch {
      // AI is best-effort; never fail the candidate submit on it.
    }
    return { status: "submitted" };
  });

  // Per-prompt blob upload. Multipart, one file. Returns the blobKey.
  app.post("/:token/upload", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "expected_multipart" });
    }
    const [sub] = await db
      .select({ id: asyncVideoSubmissions.id, status: asyncVideoSubmissions.status, expiresAt: asyncVideoSubmissions.expiresAt })
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.inviteToken, token))
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "invalid_token" });
    if (sub.expiresAt && sub.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ error: "expired" });
    }
    if (sub.status === "submitted" || sub.status === "reviewed") {
      return reply.code(409).send({ error: "already_submitted" });
    }
    const part = await req.file({ limits: { fileSize: 200 * 1024 * 1024 } });
    if (!part) return reply.code(400).send({ error: "no_file" });
    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch {
      return reply.code(413).send({ error: "file_too_large" });
    }
    const { blobStore } = await import("@j2w/ingest-shared");
    const { key } = await blobStore.put(buf);
    return { blobKey: key, bytes: buf.byteLength };
  });
}
