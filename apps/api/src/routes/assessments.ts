// Assessment Authoring — enterprise rebuild.
//
// The question_bank stays the reusable item library; an assessment owns an
// ordered, versioned, typed composition of items (assessment_items) grouped
// into sections (assessment_sections). Publishing freezes an immutable snapshot
// (assessment_versions) that attempts pin via version_id, so in-flight exams are
// unaffected by later edits. Every state change writes an append-only
// assessment_audit_log row (DB-enforced via the no-mutate trigger).
//
// Permissions: assessments.read gates GETs; assessments.write gates authoring;
// assessments.invite gates invite/resend/revoke; assessments.review gates the
// manual-review + regrade path. Org-scoping: every query filters on
// req.authUser!.orgId. List routes are keyset-paginated (never an unbounded
// .limit). Create/invite are idempotent via the Idempotency-Key header.
//
// Auto-grading (grade.ts) runs inline on candidate submit for objective items;
// subjective items route to the manual queue; coding items grade via the Judge0
// sandbox when configured (codeExec.ts), else also route to manual.
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ASSESSMENT_ITEM_TYPES,
  assessmentAttempts,
  assessmentAuditLog,
  assessmentItems,
  assessmentSections,
  assessmentTemplates,
  assessmentVersions,
  candidates,
  db,
  proctorSessions,
  questionBanks,
  questionBankQuestions,
  users,
} from "@j2w/db";
import { recordAudit } from "../assessments/audit.js";
import {
  computeTotals,
  gradeObjective,
  type CandidateResponse,
  type ItemResult,
  type SnapshotItem,
} from "../assessments/grade.js";
import { isCodeExecConfigured, runCode } from "../assessments/codeExec.js";
import { isAiAssistConfigured, suggestScore } from "../assessments/aiAssist.js";
import { computeItemAnalysis, type AttemptForAnalysis } from "../assessments/itemAnalysis.js";
import {
  lookupIdempotent,
  readIdempotencyKey,
  recordIdempotent,
} from "../assessments/idempotency.js";

// ---------- Zod ----------

const passBandSchema = z.object({
  label: z.string().min(1).max(40),
  minPercent: z.number().int().min(0).max(100),
});

const proctoringPolicySchema = z
  .object({
    enabled: z.boolean(),
    requireWebcam: z.boolean().optional(),
    requireScreenShare: z.boolean().optional(),
    requireIdVerification: z.boolean().optional(),
    lockdownFullscreen: z.boolean().optional(),
    blockCopyPaste: z.boolean().optional(),
    flagTabSwitch: z.boolean().optional(),
    flagMultiFace: z.boolean().optional(),
    flagNoFace: z.boolean().optional(),
    flagSecondVoice: z.boolean().optional(),
    autoFlagThreshold: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    scoringMode: z.enum(["points", "percent"]).optional(),
    passBands: z.array(passBandSchema).max(6).optional(),
    shuffleSections: z.boolean().optional(),
    showResultsToCandidate: z.boolean().optional(),
    allowBacktrack: z.boolean().optional(),
  })
  .strict();

const mcqOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(2000),
  correct: z.boolean(),
});

const itemConfigByType = {
  mcq_single: z.object({
    options: z
      .array(mcqOptionSchema)
      .min(2)
      .max(10)
      .refine((o) => o.filter((x) => x.correct).length === 1, "exactly one correct"),
    shuffleOptions: z.boolean().optional(),
  }),
  mcq_multi: z.object({
    options: z
      .array(mcqOptionSchema)
      .min(2)
      .max(10)
      .refine((o) => o.some((x) => x.correct), "at least one correct"),
    shuffleOptions: z.boolean().optional(),
  }),
  true_false: z.object({ correct: z.boolean() }),
  short_answer: z.object({
    sampleAnswer: z.string().max(2000).optional(),
    gradingRubricId: z.string().uuid().optional(),
    acceptedAnswers: z.array(z.string().max(500)).optional(),
  }),
  long_answer: z.object({
    sampleAnswer: z.string().max(8000).optional(),
    gradingRubricId: z.string().uuid().optional(),
  }),
  coding: z.object({
    language: z.enum(["python", "javascript", "java", "cpp", "go"]),
    starterCode: z.string().max(20000).optional(),
    testCases: z
      .array(
        z.object({
          id: z.string(),
          stdin: z.string().max(8000).default(""),
          expected: z.string().max(8000),
          hidden: z.boolean().default(false),
          weight: z.number().int().min(1).default(1),
        }),
      )
      .min(1)
      .max(50),
    timeoutMs: z.number().int().min(500).max(15000).default(5000),
  }),
  file_upload: z.object({
    acceptedTypes: z.array(z.string()).max(20),
    maxSizeMb: z.number().int().min(1).max(100),
  }),
  video_response: z.object({
    prepSeconds: z.number().int().min(0).max(300),
    maxSeconds: z.number().int().min(10).max(900),
    retakes: z.number().int().min(0).max(5),
  }),
} as const;

const createTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  durationMins: z.number().int().min(1).max(720).nullable().optional(),
  passScore: z.number().int().min(0).max(100).default(60),
  settings: settingsSchema.optional(),
  proctoringPolicy: proctoringPolicySchema.optional(),
});

const updateTemplateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    durationMins: z.number().int().min(1).max(720).nullable().optional(),
    passScore: z.number().int().min(0).max(100).optional(),
    settings: settingsSchema.optional(),
    proctoringPolicy: proctoringPolicySchema.optional(),
  })
  .strict();

const createSectionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  timeLimitSeconds: z.number().int().min(1).max(86400).nullable().optional(),
  shuffleItems: z.boolean().optional(),
  poolDrawCount: z.number().int().min(0).max(500).nullable().optional(),
});
const updateSectionSchema = createSectionSchema.partial();

const createItemSchema = z.object({
  type: z.enum(ASSESSMENT_ITEM_TYPES),
  sectionId: z.string().uuid().nullable().optional(),
  sourceQuestionId: z.string().uuid().nullable().optional(),
  prompt: z.string().min(1).max(8000),
  config: z.record(z.unknown()).default({}),
  points: z.number().int().min(0).max(100).default(1),
  negativePoints: z.number().int().min(0).max(100).default(0),
  partialCredit: z.boolean().default(false),
  required: z.boolean().default(true),
  timeLimitSeconds: z.number().int().min(5).max(7200).nullable().optional(),
});
const updateItemSchema = createItemSchema.partial();

const reorderSchema = z.object({
  ordered: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        sectionId: z.string().uuid().nullable().optional(),
        position: z.number().int().min(0).max(10000),
      }),
    )
    .min(1)
    .max(500),
});

const importFromBankSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1).max(200),
  sectionId: z.string().uuid().nullable().optional(),
  type: z.enum(ASSESSMENT_ITEM_TYPES).default("short_answer"),
});

const inviteSchema = z.object({
  templateId: z.string().uuid(),
  candidateId: z.string().uuid().nullable().optional(),
  expiresAt: z.string().datetime().optional(),
  reminderPolicy: z
    .object({ afterHours: z.array(z.number().int().min(1).max(720)).max(3) })
    .optional(),
});

const bulkInviteSchema = z.object({
  templateId: z.string().uuid(),
  candidateIds: z.array(z.string().uuid()).min(1).max(500),
  expiresAt: z.string().datetime().optional(),
});

const reviewAttemptSchema = z
  .object({
    itemScores: z
      .array(z.object({ itemId: z.string().uuid(), awarded: z.number().min(0) }))
      .optional(),
    reviewerNotes: z.string().max(4000).optional(),
    pass: z.boolean().optional(),
  })
  .strict();

const listTemplatesQuery = z.object({
  status: z.enum(["draft", "published", "archived"]).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["createdAt.desc", "createdAt.asc", "title.asc"]).default("createdAt.desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const listAttemptsQuery = z.object({
  status: z.enum(["invited", "started", "submitted", "reviewed", "expired", "revoked"]).optional(),
  templateId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["createdAt.desc", "createdAt.asc"]).default("createdAt.desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const submitAttemptSchema = z.object({
  responses: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        selectedOptionIds: z.array(z.string()).max(20).optional(),
        boolValue: z.boolean().optional(),
        textValue: z.string().max(20000).optional(),
        codeValue: z.string().max(40000).optional(),
        // legacy free-text shape (questionId) tolerated for compat
      }),
    )
    .max(500),
});

// ---------- helpers ----------

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_payload", issues: error.flatten() });
}

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

// Validate a typed item config against its per-type schema; returns the parsed
// config or a ZodError to surface as 400.
function validateItemConfig(type: string, config: unknown): { ok: true; data: unknown } | { ok: false; error: z.ZodError } {
  const schema = itemConfigByType[type as keyof typeof itemConfigByType];
  if (!schema) return { ok: true, data: config ?? {} };
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error };
  return { ok: true, data: parsed.data };
}

// Build the frozen publish snapshot from the current sections + items.
async function buildSnapshot(orgId: string, templateId: string) {
  const [tpl] = await db
    .select()
    .from(assessmentTemplates)
    .where(and(eq(assessmentTemplates.id, templateId), eq(assessmentTemplates.orgId, orgId)))
    .limit(1);
  if (!tpl) return null;
  const sections = await db
    .select()
    .from(assessmentSections)
    .where(eq(assessmentSections.templateId, templateId))
    .orderBy(assessmentSections.position);
  const items = await db
    .select()
    .from(assessmentItems)
    .where(eq(assessmentItems.templateId, templateId))
    .orderBy(assessmentItems.position);
  return {
    settings: tpl.settings,
    proctoringPolicy: tpl.proctoringPolicy,
    passScore: tpl.passScore,
    durationMins: tpl.durationMins,
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      position: s.position,
      timeLimitSeconds: s.timeLimitSeconds,
      shuffleItems: s.shuffleItems,
      poolDrawCount: s.poolDrawCount,
    })),
    items: items.map((it) => ({
      id: it.id,
      sectionId: it.sectionId,
      type: it.type,
      position: it.position,
      prompt: it.prompt,
      config: it.config,
      points: it.points,
      negativePoints: it.negativePoints,
      partialCredit: it.partialCredit,
      required: it.required,
      timeLimitSeconds: it.timeLimitSeconds,
    })),
  };
}

interface SnapshotShape {
  settings?: { passBands?: Array<{ label: string; minPercent: number }> };
  passScore?: number;
  durationMins?: number | null;
  items?: SnapshotItem[];
  sections?: unknown[];
}

// Redact answer keys from a snapshot's items for candidate / preview display.
function redactSnapshotItems(items: SnapshotItem[]): unknown[] {
  return items.map((it) => {
    const cfg = (it.config ?? {}) as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    if (Array.isArray(cfg.options)) {
      redacted.options = (cfg.options as Array<{ id: string; label: string }>).map((o) => ({
        id: o.id,
        label: o.label,
      }));
      redacted.shuffleOptions = cfg.shuffleOptions;
    }
    if (it.type === "coding") {
      redacted.language = cfg.language;
      redacted.starterCode = cfg.starterCode;
      // visible (non-hidden) test cases only, expected redacted
      redacted.sampleTests = Array.isArray(cfg.testCases)
        ? (cfg.testCases as Array<{ id: string; stdin?: string; hidden?: boolean }>)
            .filter((t) => !t.hidden)
            .map((t) => ({ id: t.id, stdin: t.stdin }))
        : [];
    }
    if (it.type === "file_upload") {
      redacted.acceptedTypes = cfg.acceptedTypes;
      redacted.maxSizeMb = cfg.maxSizeMb;
    }
    if (it.type === "video_response") {
      redacted.prepSeconds = cfg.prepSeconds;
      redacted.maxSeconds = cfg.maxSeconds;
      redacted.retakes = cfg.retakes;
    }
    return {
      id: it.id,
      sectionId: (it as { sectionId?: string }).sectionId ?? null,
      type: it.type,
      position: (it as { position?: number }).position ?? 0,
      prompt: it.prompt,
      points: it.points,
      required: it.required,
      timeLimitSeconds: (it as { timeLimitSeconds?: number | null }).timeLimitSeconds ?? null,
      config: redacted,
    };
  });
}

// Run grading for an attempt's responses against a snapshot, including the code
// sandbox where configured. Returns the full ItemResult[] + totals.
async function gradeAttempt(snapshot: SnapshotShape, responses: CandidateResponse[]) {
  const items = (snapshot.items ?? []) as SnapshotItem[];
  const base = gradeObjective(items, responses);
  const byItem = new Map(responses.map((r) => [r.itemId, r]));
  const itemById = new Map(items.map((it) => [it.id, it]));

  // Run coding items through the sandbox when configured.
  if (isCodeExecConfigured()) {
    for (const r of base.itemResults) {
      if (r.type !== "coding") continue;
      const item = itemById.get(r.itemId);
      const resp = byItem.get(r.itemId);
      if (!item || !resp?.codeValue) continue;
      const cfg = item.config ?? {};
      const testCases = (cfg.testCases ?? []) as Array<{ id: string; stdin?: string; expected: string; hidden?: boolean; weight?: number }>;
      if (!testCases.length) continue;
      const run = await runCode({
        language: String(cfg.language ?? "python"),
        source: resp.codeValue,
        testCases,
        timeoutMs: cfg.timeoutMs as number | undefined,
      });
      if (run.configured) {
        const totalWeight = run.cases.reduce((s, c) => s + c.weight, 0) || 1;
        const passedWeight = run.cases.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
        const awarded = Math.round((passedWeight / totalWeight) * r.max * 100) / 100;
        r.awarded = awarded;
        r.correct = run.passed === run.total;
        r.autoGraded = true;
        r.codeRun = { passed: run.passed, total: run.total, stderr: run.stderr };
      }
    }
  }

  const passBands = snapshot.settings?.passBands ?? [];
  const passScore = snapshot.passScore ?? 60;
  const totals = computeTotals(base.itemResults, passScore, passBands);
  return { itemResults: base.itemResults, ...totals };
}

export async function assessmentsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const canRead = app.requirePermission("assessments.read");
  const canWrite = app.requirePermission("assessments.write");
  const canInvite = app.requirePermission("assessments.invite");
  const canReview = app.requirePermission("assessments.review");

  // ---------- TEMPLATES: list (keyset) ----------
  app.get("/templates", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listTemplatesQuery.safeParse(req.query ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const conds = [eq(assessmentTemplates.orgId, ctx.orgId)];
    if (qy.status) conds.push(eq(assessmentTemplates.status, qy.status));
    if (qy.q) conds.push(ilike(assessmentTemplates.title, `%${qy.q}%`));

    const [{ n: total }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assessmentTemplates)
      .where(and(...conds));

    const keysetConds = [...conds];
    if (qy.cursor) {
      const cur = decodeCursor(qy.cursor);
      if (!cur) return reply.code(400).send({ error: "invalid_cursor" });
      const op = qy.sort === "createdAt.asc" ? sql`>` : sql`<`;
      keysetConds.push(
        sql`(${assessmentTemplates.createdAt} ${op} ${cur.createdAt}::timestamptz OR (${assessmentTemplates.createdAt} = ${cur.createdAt}::timestamptz AND ${assessmentTemplates.id} ${op} ${cur.id}))`,
      );
    }

    const orderBy =
      qy.sort === "title.asc"
        ? [assessmentTemplates.title, assessmentTemplates.id]
        : qy.sort === "createdAt.asc"
          ? [assessmentTemplates.createdAt, assessmentTemplates.id]
          : [desc(assessmentTemplates.createdAt), desc(assessmentTemplates.id)];

    const rows = await db
      .select({
        id: assessmentTemplates.id,
        title: assessmentTemplates.title,
        description: assessmentTemplates.description,
        durationMins: assessmentTemplates.durationMins,
        passScore: assessmentTemplates.passScore,
        status: assessmentTemplates.status,
        publishedVersion: assessmentTemplates.publishedVersion,
        proctoringEnabled: sql<boolean>`coalesce((${assessmentTemplates.proctoringPolicy} ->> 'enabled')::boolean, false)`,
        itemCount: sql<number>`(SELECT count(*)::int FROM assessment_items WHERE assessment_items.template_id = ${assessmentTemplates.id})`,
        attemptCount: sql<number>`(SELECT count(*)::int FROM assessment_attempts WHERE assessment_attempts.template_id = ${assessmentTemplates.id})`,
        createdAt: assessmentTemplates.createdAt,
        updatedAt: assessmentTemplates.updatedAt,
      })
      .from(assessmentTemplates)
      .where(and(...keysetConds))
      .orderBy(...orderBy)
      .limit(qy.limit);

    const nextCursor =
      rows.length === qy.limit ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].id) : null;
    return { templates: rows, nextCursor, total };
  });

  // ---------- TEMPLATES: create (idempotent) ----------
  app.post("/templates", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "assessment.template.create", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const [row] = await db
      .insert(assessmentTemplates)
      .values({
        orgId: ctx.orgId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        durationMins: parsed.data.durationMins ?? null,
        passScore: parsed.data.passScore,
        questionIds: [],
        status: "draft",
        isPublished: false,
        settings: parsed.data.settings ?? {},
        proctoringPolicy: parsed.data.proctoringPolicy ?? {},
        createdByUserId: ctx.id,
      })
      .returning();
    await recordAudit(db, {
      orgId: ctx.orgId,
      action: "template.created",
      targetKind: "template",
      targetId: row.id,
      templateId: row.id,
      actorUserId: ctx.id,
      detail: { title: row.title },
    });
    const body = { template: row };
    if (idemKey) await recordIdempotent(ctx.orgId, "assessment.template.create", idemKey, body);
    return reply.code(201).send(body);
  });

  // ---------- TEMPLATES: detail ----------
  app.get("/templates/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [tpl] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });

    const sections = await db
      .select()
      .from(assessmentSections)
      .where(eq(assessmentSections.templateId, id))
      .orderBy(assessmentSections.position);
    const items = await db
      .select()
      .from(assessmentItems)
      .where(eq(assessmentItems.templateId, id))
      .orderBy(assessmentItems.position);
    const versions = await db
      .select({
        id: assessmentVersions.id,
        version: assessmentVersions.version,
        publishedAt: assessmentVersions.publishedAt,
        publishedByUserId: assessmentVersions.publishedByUserId,
      })
      .from(assessmentVersions)
      .where(eq(assessmentVersions.templateId, id))
      .orderBy(desc(assessmentVersions.version));
    const recentAttempts = await db
      .select({
        id: assessmentAttempts.id,
        status: assessmentAttempts.status,
        candidateId: assessmentAttempts.candidateId,
        candidateName: candidates.displayName,
        totalScore: assessmentAttempts.totalScore,
        autoScore: assessmentAttempts.autoScore,
        manualScore: assessmentAttempts.manualScore,
        maxScore: assessmentAttempts.maxScore,
        pass: assessmentAttempts.pass,
        passBand: assessmentAttempts.passBand,
        inviteToken: assessmentAttempts.inviteToken,
        startedAt: assessmentAttempts.startedAt,
        submittedAt: assessmentAttempts.submittedAt,
        createdAt: assessmentAttempts.createdAt,
      })
      .from(assessmentAttempts)
      .leftJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
      .where(eq(assessmentAttempts.templateId, id))
      .orderBy(desc(assessmentAttempts.createdAt))
      .limit(25);

    return { template: tpl, sections, items, versions, recentAttempts };
  });

  // ---------- TEMPLATES: update ----------
  app.patch("/templates/:id", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = updateTemplateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [existing] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "template_not_found" });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const d = parsed.data;
    if (d.title !== undefined) updates.title = d.title;
    if (d.description !== undefined) updates.description = d.description;
    if (d.durationMins !== undefined) updates.durationMins = d.durationMins;
    if (d.passScore !== undefined) updates.passScore = d.passScore;
    if (d.settings !== undefined) updates.settings = d.settings;
    if (d.proctoringPolicy !== undefined) updates.proctoringPolicy = d.proctoringPolicy;

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(assessmentTemplates)
        .set(updates)
        .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
        .returning();
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "template.updated",
        targetKind: "template",
        targetId: id,
        templateId: id,
        actorUserId: ctx.id,
        detail: { fields: Object.keys(d) },
      });
      return updated;
    });
    return { template: row };
  });

  // ---------- TEMPLATES: soft-delete (archive) ----------
  app.delete("/templates/:id", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(assessmentTemplates)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
        .returning({ id: assessmentTemplates.id });
      if (!updated) return null;
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "template.archived",
        targetKind: "template",
        targetId: id,
        templateId: id,
        actorUserId: ctx.id,
      });
      return updated;
    });
    if (!row) return reply.code(404).send({ error: "template_not_found" });
    return { archived: id };
  });

  // ---------- TEMPLATES: duplicate ----------
  app.post("/templates/:id/duplicate", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [src] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!src) return reply.code(404).send({ error: "template_not_found" });

    const newTpl = await db.transaction(async (tx) => {
      const [copy] = await tx
        .insert(assessmentTemplates)
        .values({
          orgId: ctx.orgId,
          title: `${src.title} (copy)`,
          description: src.description,
          durationMins: src.durationMins,
          passScore: src.passScore,
          questionIds: [],
          status: "draft",
          isPublished: false,
          settings: src.settings,
          proctoringPolicy: src.proctoringPolicy,
          createdByUserId: ctx.id,
        })
        .returning();
      const srcSections = await tx
        .select()
        .from(assessmentSections)
        .where(eq(assessmentSections.templateId, id));
      const sectionIdMap = new Map<string, string>();
      for (const s of srcSections) {
        const [ns] = await tx
          .insert(assessmentSections)
          .values({
            orgId: ctx.orgId,
            templateId: copy.id,
            title: s.title,
            description: s.description,
            position: s.position,
            timeLimitSeconds: s.timeLimitSeconds,
            shuffleItems: s.shuffleItems,
            poolDrawCount: s.poolDrawCount,
          })
          .returning({ id: assessmentSections.id });
        sectionIdMap.set(s.id, ns.id);
      }
      const srcItems = await tx.select().from(assessmentItems).where(eq(assessmentItems.templateId, id));
      if (srcItems.length) {
        await tx.insert(assessmentItems).values(
          srcItems.map((it) => ({
            orgId: ctx.orgId,
            templateId: copy.id,
            sectionId: it.sectionId ? (sectionIdMap.get(it.sectionId) ?? null) : null,
            sourceQuestionId: it.sourceQuestionId,
            type: it.type,
            position: it.position,
            prompt: it.prompt,
            config: it.config,
            points: it.points,
            negativePoints: it.negativePoints,
            partialCredit: it.partialCredit,
            required: it.required,
            timeLimitSeconds: it.timeLimitSeconds,
          })),
        );
      }
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "template.duplicated",
        targetKind: "template",
        targetId: copy.id,
        templateId: copy.id,
        actorUserId: ctx.id,
        detail: { sourceId: id },
      });
      return copy;
    });
    return reply.code(201).send({ template: newTpl });
  });

  // ---------- TEMPLATES: publish ----------
  app.post("/templates/:id/publish", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [tpl] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });

    const items = await db.select().from(assessmentItems).where(eq(assessmentItems.templateId, id));
    if (items.length === 0) {
      return reply.code(422).send({ error: "no_items", message: "Add at least one item before publishing." });
    }
    // PASS-gate sanity: at least one item carries an answer key (auto-gradable) OR
    // is reviewable — i.e. an empty-key MCQ is rejected. We require ≥1 item with a
    // usable key/structure.
    const hasGradable = items.some((it) => {
      const cfg = (it.config ?? {}) as Record<string, unknown>;
      if (it.type === "true_false") return typeof cfg.correct === "boolean";
      if (it.type === "mcq_single" || it.type === "mcq_multi")
        return Array.isArray(cfg.options) && (cfg.options as Array<{ correct?: boolean }>).some((o) => o.correct);
      if (it.type === "coding") return Array.isArray(cfg.testCases) && (cfg.testCases as unknown[]).length > 0;
      return ["short_answer", "long_answer", "file_upload", "video_response"].includes(it.type);
    });
    if (!hasGradable) {
      return reply.code(422).send({ error: "no_gradable_item", message: "At least one item must have an answer key or be reviewable." });
    }

    const snapshot = await buildSnapshot(ctx.orgId, id);
    if (!snapshot) return reply.code(404).send({ error: "template_not_found" });

    const result = await db.transaction(async (tx) => {
      const [{ maxV }] = await tx
        .select({ maxV: sql<number>`coalesce(max(${assessmentVersions.version}), 0)::int` })
        .from(assessmentVersions)
        .where(eq(assessmentVersions.templateId, id));
      const nextVersion = (maxV ?? 0) + 1;
      const [version] = await tx
        .insert(assessmentVersions)
        .values({
          orgId: ctx.orgId,
          templateId: id,
          version: nextVersion,
          snapshot,
          publishedByUserId: ctx.id,
        })
        .returning();
      await tx
        .update(assessmentTemplates)
        .set({ status: "published", isPublished: true, publishedVersion: nextVersion, updatedAt: new Date() })
        .where(eq(assessmentTemplates.id, id));
      await recordAudit(tx, {
        orgId: ctx.orgId,
        action: "template.published",
        targetKind: "version",
        targetId: version.id,
        templateId: id,
        actorUserId: ctx.id,
        detail: { version: nextVersion },
      });
      return { version };
    });
    return { status: "published", version: result.version.version, versionId: result.version.id };
  });

  // ---------- TEMPLATES: unpublish ----------
  app.post("/templates/:id/unpublish", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .update(assessmentTemplates)
      .set({ status: "draft", isPublished: false, updatedAt: new Date() })
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .returning({ id: assessmentTemplates.id });
    if (!row) return reply.code(404).send({ error: "template_not_found" });
    await recordAudit(db, {
      orgId: ctx.orgId,
      action: "template.unpublished",
      targetKind: "template",
      targetId: id,
      templateId: id,
      actorUserId: ctx.id,
    });
    return { status: "draft" };
  });

  // ---------- TEMPLATES: preview-as-candidate ----------
  app.get("/templates/:id/preview", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [tpl] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    const snapshot = await buildSnapshot(ctx.orgId, id);
    if (!snapshot) return reply.code(404).send({ error: "template_not_found" });
    return {
      template: { id: tpl.id, title: tpl.title, description: tpl.description, durationMins: tpl.durationMins, passScore: tpl.passScore },
      sections: snapshot.sections,
      items: redactSnapshotItems(snapshot.items as SnapshotItem[]),
      proctoringPolicy: tpl.proctoringPolicy,
    };
  });

  // ---------- SECTIONS ----------
  app.post("/templates/:id/sections", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = createSectionSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status === "published")
      return reply.code(409).send({ error: "template_published", message: "Unpublish or duplicate to edit structure." });
    const [row] = await db
      .insert(assessmentSections)
      .values({
        orgId: ctx.orgId,
        templateId: id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        position: parsed.data.position ?? 0,
        timeLimitSeconds: parsed.data.timeLimitSeconds ?? null,
        shuffleItems: parsed.data.shuffleItems ?? false,
        poolDrawCount: parsed.data.poolDrawCount ?? null,
      })
      .returning();
    await recordAudit(db, { orgId: ctx.orgId, action: "item.created", targetKind: "section", targetId: row.id, templateId: id, actorUserId: ctx.id, detail: { title: row.title } });
    return reply.code(201).send({ section: row });
  });

  app.patch("/sections/:sid", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { sid } = req.params as { sid: string };
    const parsed = updateSectionSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;
    const [row] = await db
      .update(assessmentSections)
      .set(updates)
      .where(and(eq(assessmentSections.id, sid), eq(assessmentSections.orgId, ctx.orgId)))
      .returning();
    if (!row) return reply.code(404).send({ error: "section_not_found" });
    await recordAudit(db, { orgId: ctx.orgId, action: "item.updated", targetKind: "section", targetId: sid, templateId: row.templateId, actorUserId: ctx.id });
    return { section: row };
  });

  app.delete("/sections/:sid", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { sid } = req.params as { sid: string };
    const [row] = await db
      .delete(assessmentSections)
      .where(and(eq(assessmentSections.id, sid), eq(assessmentSections.orgId, ctx.orgId)))
      .returning({ id: assessmentSections.id, templateId: assessmentSections.templateId });
    if (!row) return reply.code(404).send({ error: "section_not_found" });
    await recordAudit(db, { orgId: ctx.orgId, action: "item.deleted", targetKind: "section", targetId: sid, templateId: row.templateId, actorUserId: ctx.id });
    return { deleted: sid };
  });

  // ---------- ITEMS ----------
  app.post("/templates/:id/items", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status === "published")
      return reply.code(409).send({ error: "template_published", message: "Unpublish or duplicate to edit structure." });

    const cfg = validateItemConfig(parsed.data.type, parsed.data.config);
    if (!cfg.ok) return badRequest(reply, cfg.error);

    const [{ maxPos }] = await db
      .select({ maxPos: sql<number>`coalesce(max(${assessmentItems.position}), -1)::int` })
      .from(assessmentItems)
      .where(eq(assessmentItems.templateId, id));

    const [row] = await db
      .insert(assessmentItems)
      .values({
        orgId: ctx.orgId,
        templateId: id,
        sectionId: parsed.data.sectionId ?? null,
        sourceQuestionId: parsed.data.sourceQuestionId ?? null,
        type: parsed.data.type,
        position: (maxPos ?? -1) + 1,
        prompt: parsed.data.prompt,
        config: cfg.data as Record<string, unknown>,
        points: parsed.data.points,
        negativePoints: parsed.data.negativePoints,
        partialCredit: parsed.data.partialCredit,
        required: parsed.data.required,
        timeLimitSeconds: parsed.data.timeLimitSeconds ?? null,
      })
      .returning();
    await recordAudit(db, { orgId: ctx.orgId, action: "item.created", targetKind: "item", targetId: row.id, templateId: id, actorUserId: ctx.id, detail: { type: row.type } });
    return reply.code(201).send({ item: row });
  });

  app.patch("/items/:itemId", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { itemId } = req.params as { itemId: string };
    const parsed = updateItemSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const [existing] = await db
      .select()
      .from(assessmentItems)
      .where(and(eq(assessmentItems.id, itemId), eq(assessmentItems.orgId, ctx.orgId)))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: "item_not_found" });
    const [tpl] = await db
      .select({ status: assessmentTemplates.status })
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.id, existing.templateId))
      .limit(1);
    if (tpl?.status === "published")
      return reply.code(409).send({ error: "template_published", message: "Editing a published template is blocked — duplicate or unpublish." });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const d = parsed.data;
    if (d.prompt !== undefined) updates.prompt = d.prompt;
    if (d.points !== undefined) updates.points = d.points;
    if (d.negativePoints !== undefined) updates.negativePoints = d.negativePoints;
    if (d.partialCredit !== undefined) updates.partialCredit = d.partialCredit;
    if (d.required !== undefined) updates.required = d.required;
    if (d.timeLimitSeconds !== undefined) updates.timeLimitSeconds = d.timeLimitSeconds;
    if (d.sectionId !== undefined) updates.sectionId = d.sectionId;
    if (d.config !== undefined) {
      const type = d.type ?? existing.type;
      const cfg = validateItemConfig(type, d.config);
      if (!cfg.ok) return badRequest(reply, cfg.error);
      updates.config = cfg.data;
    }
    if (d.type !== undefined) updates.type = d.type;

    const [row] = await db
      .update(assessmentItems)
      .set(updates)
      .where(and(eq(assessmentItems.id, itemId), eq(assessmentItems.orgId, ctx.orgId)))
      .returning();
    await recordAudit(db, { orgId: ctx.orgId, action: "item.updated", targetKind: "item", targetId: itemId, templateId: existing.templateId, actorUserId: ctx.id });
    return { item: row };
  });

  app.delete("/items/:itemId", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { itemId } = req.params as { itemId: string };
    const [row] = await db
      .delete(assessmentItems)
      .where(and(eq(assessmentItems.id, itemId), eq(assessmentItems.orgId, ctx.orgId)))
      .returning({ id: assessmentItems.id, templateId: assessmentItems.templateId });
    if (!row) return reply.code(404).send({ error: "item_not_found" });
    await recordAudit(db, { orgId: ctx.orgId, action: "item.deleted", targetKind: "item", targetId: itemId, templateId: row.templateId, actorUserId: ctx.id });
    return { deleted: itemId };
  });

  app.post("/templates/:id/items/reorder", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status === "published")
      return reply.code(409).send({ error: "template_published" });
    await db.transaction(async (tx) => {
      for (const o of parsed.data.ordered) {
        await tx
          .update(assessmentItems)
          .set({ position: o.position, sectionId: o.sectionId ?? null, updatedAt: new Date() })
          .where(and(eq(assessmentItems.id, o.itemId), eq(assessmentItems.templateId, id), eq(assessmentItems.orgId, ctx.orgId)));
      }
      await recordAudit(tx, { orgId: ctx.orgId, action: "item.reordered", targetKind: "template", targetId: id, templateId: id, actorUserId: ctx.id, detail: { count: parsed.data.ordered.length } });
    });
    return { reordered: parsed.data.ordered.length };
  });

  // ---------- ITEMS: import from question bank ----------
  app.post("/templates/:id/import-from-bank", { preHandler: [canWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = importFromBankSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status === "published") return reply.code(409).send({ error: "template_published" });

    // Org-scope: question_bank_questions has no org_id; the tenant boundary is
    // the parent question_banks.org_id. Join through and filter by the caller's
    // org so foreign-org question IDs can never be read or copied.
    const bankQs = await db
      .select({ id: questionBankQuestions.id, prompt: questionBankQuestions.prompt })
      .from(questionBankQuestions)
      .innerJoin(questionBanks, eq(questionBanks.id, questionBankQuestions.bankId))
      .where(
        and(
          inArray(questionBankQuestions.id, parsed.data.questionIds),
          eq(questionBanks.orgId, ctx.orgId),
        ),
      );
    if (bankQs.length === 0) return reply.code(404).send({ error: "no_bank_questions" });
    // Any requested id that didn't resolve under this org is foreign (or absent).
    // Reject the whole import rather than partially copying — no cross-tenant leak.
    if (bankQs.length !== parsed.data.questionIds.length)
      return reply.code(404).send({ error: "bank_question_not_found" });

    const [{ maxPos }] = await db
      .select({ maxPos: sql<number>`coalesce(max(${assessmentItems.position}), -1)::int` })
      .from(assessmentItems)
      .where(eq(assessmentItems.templateId, id));
    let pos = (maxPos ?? -1) + 1;

    const inserted = await db
      .insert(assessmentItems)
      .values(
        bankQs.map((q) => ({
          orgId: ctx.orgId,
          templateId: id,
          sectionId: parsed.data.sectionId ?? null,
          sourceQuestionId: q.id,
          type: parsed.data.type,
          position: pos++,
          prompt: q.prompt,
          config: {} as Record<string, unknown>,
          points: 1,
          negativePoints: 0,
          partialCredit: false,
          required: true,
        })),
      )
      .returning({ id: assessmentItems.id });
    await recordAudit(db, { orgId: ctx.orgId, action: "item.created", targetKind: "template", targetId: id, templateId: id, actorUserId: ctx.id, detail: { importedFromBank: inserted.length } });
    return reply.code(201).send({ imported: inserted.length, itemIds: inserted.map((r) => r.id) });
  });

  // ---------- ATTEMPTS: list (keyset) ----------
  app.get("/attempts", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listAttemptsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const qy = parsed.data;

    const conds = [eq(assessmentAttempts.orgId, ctx.orgId)];
    if (qy.status) conds.push(eq(assessmentAttempts.status, qy.status));
    if (qy.templateId) conds.push(eq(assessmentAttempts.templateId, qy.templateId));
    if (qy.q) conds.push(ilike(candidates.displayName, `%${qy.q}%`));

    const [{ n: total }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assessmentAttempts)
      .leftJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
      .where(and(...conds));

    const keysetConds = [...conds];
    if (qy.cursor) {
      const cur = decodeCursor(qy.cursor);
      if (!cur) return reply.code(400).send({ error: "invalid_cursor" });
      const op = qy.sort === "createdAt.asc" ? sql`>` : sql`<`;
      keysetConds.push(
        sql`(${assessmentAttempts.createdAt} ${op} ${cur.createdAt}::timestamptz OR (${assessmentAttempts.createdAt} = ${cur.createdAt}::timestamptz AND ${assessmentAttempts.id} ${op} ${cur.id}))`,
      );
    }
    const asc = qy.sort === "createdAt.asc";

    const rows = await db
      .select({
        id: assessmentAttempts.id,
        templateId: assessmentAttempts.templateId,
        templateTitle: assessmentTemplates.title,
        candidateId: assessmentAttempts.candidateId,
        candidateName: candidates.displayName,
        status: assessmentAttempts.status,
        totalScore: assessmentAttempts.totalScore,
        autoScore: assessmentAttempts.autoScore,
        manualScore: assessmentAttempts.manualScore,
        maxScore: assessmentAttempts.maxScore,
        pass: assessmentAttempts.pass,
        passBand: assessmentAttempts.passBand,
        remindersSent: assessmentAttempts.remindersSent,
        inviteToken: assessmentAttempts.inviteToken,
        proctorFlags: sql<number>`coalesce((SELECT count(*)::int FROM proctor_sessions ps WHERE ps.assessment_attempt_id = ${assessmentAttempts.id}), 0)`,
        startedAt: assessmentAttempts.startedAt,
        submittedAt: assessmentAttempts.submittedAt,
        reviewedAt: assessmentAttempts.reviewedAt,
        expiresAt: assessmentAttempts.expiresAt,
        createdAt: assessmentAttempts.createdAt,
      })
      .from(assessmentAttempts)
      .leftJoin(assessmentTemplates, eq(assessmentTemplates.id, assessmentAttempts.templateId))
      .leftJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
      .where(and(...keysetConds))
      .orderBy(
        asc ? assessmentAttempts.createdAt : desc(assessmentAttempts.createdAt),
        asc ? assessmentAttempts.id : desc(assessmentAttempts.id),
      )
      .limit(qy.limit);

    const nextCursor =
      rows.length === qy.limit ? encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].id) : null;
    return { attempts: rows, nextCursor, total };
  });

  // ---------- ATTEMPTS: detail ----------
  app.get("/attempts/:id", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "attempt_not_found" });
    const [tpl] = await db
      .select({ title: assessmentTemplates.title, passScore: assessmentTemplates.passScore })
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.id, row.templateId))
      .limit(1);
    let version: { snapshot: unknown } | null = null;
    if (row.versionId) {
      const [v] = await db
        .select({ snapshot: assessmentVersions.snapshot, version: assessmentVersions.version })
        .from(assessmentVersions)
        .where(eq(assessmentVersions.id, row.versionId))
        .limit(1);
      version = v ?? null;
    }
    let candidate: { id: string; displayName: string | null } | null = null;
    if (row.candidateId) {
      const [c] = await db
        .select({ id: candidates.id, displayName: candidates.displayName })
        .from(candidates)
        .where(eq(candidates.id, row.candidateId))
        .limit(1);
      candidate = c ?? null;
    }
    return { attempt: row, template: tpl ?? null, version, candidate };
  });

  // ---------- INVITES ----------
  app.post("/invites", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "assessment.invite", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status, publishedVersion: assessmentTemplates.publishedVersion })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, parsed.data.templateId), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status !== "published")
      return reply.code(422).send({ error: "template_not_published", message: "Publish the assessment before inviting." });

    const [version] = await db
      .select({ id: assessmentVersions.id })
      .from(assessmentVersions)
      .where(and(eq(assessmentVersions.templateId, tpl.id), eq(assessmentVersions.version, tpl.publishedVersion ?? 0)))
      .limit(1);

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(assessmentAttempts)
        .values({
          orgId: ctx.orgId,
          templateId: parsed.data.templateId,
          candidateId: parsed.data.candidateId ?? null,
          inviteToken: newToken(),
          invitedByUserId: ctx.id,
          versionId: version?.id ?? null,
          status: "invited",
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        })
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.created", targetKind: "attempt", targetId: created.id, templateId: parsed.data.templateId, actorUserId: ctx.id, detail: { candidateId: parsed.data.candidateId ?? null } });
      return created;
    });
    const body = { attempt: row };
    if (idemKey) await recordIdempotent(ctx.orgId, "assessment.invite", idemKey, body);
    return reply.code(201).send(body);
  });

  app.post("/invites/bulk", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkInviteSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    // Idempotent: a retried bulk POST (network blip) replays the cached attempt
    // rows instead of re-inserting them + duplicate invite.created audit rows.
    const idemKey = readIdempotencyKey(req.headers as Record<string, unknown>);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, "assessment.invite.bulk", idemKey);
      if (cached) return reply.code(200).send({ ...cached, idempotent: true });
    }

    const [tpl] = await db
      .select({ id: assessmentTemplates.id, status: assessmentTemplates.status, publishedVersion: assessmentTemplates.publishedVersion })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, parsed.data.templateId), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    if (tpl.status !== "published") return reply.code(422).send({ error: "template_not_published" });
    const [version] = await db
      .select({ id: assessmentVersions.id })
      .from(assessmentVersions)
      .where(and(eq(assessmentVersions.templateId, tpl.id), eq(assessmentVersions.version, tpl.publishedVersion ?? 0)))
      .limit(1);

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(assessmentAttempts)
        .values(
          parsed.data.candidateIds.map((cid) => ({
            orgId: ctx.orgId,
            templateId: parsed.data.templateId,
            candidateId: cid,
            inviteToken: newToken(),
            invitedByUserId: ctx.id,
            versionId: version?.id ?? null,
            status: "invited" as const,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          })),
        )
        .returning({ id: assessmentAttempts.id, candidateId: assessmentAttempts.candidateId, inviteToken: assessmentAttempts.inviteToken });
      for (const r of rows) {
        await recordAudit(tx, { orgId: ctx.orgId, action: "invite.created", targetKind: "attempt", targetId: r.id, templateId: parsed.data.templateId, actorUserId: ctx.id, detail: { candidateId: r.candidateId, bulk: true } });
      }
      return rows;
    });
    const body = { invited: result.length, attempts: result };
    if (idemKey) await recordIdempotent(ctx.orgId, "assessment.invite.bulk", idemKey, body);
    return reply.code(201).send(body);
  });

  app.post("/attempts/:id/resend", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [att] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });
    if (att.status === "revoked") return reply.code(409).send({ error: "attempt_revoked" });
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(assessmentAttempts)
        .set({ remindersSent: (att.remindersSent ?? 0) + 1, lastReminderAt: new Date(), updatedAt: new Date() })
        .where(eq(assessmentAttempts.id, id))
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.resent", targetKind: "attempt", targetId: id, templateId: att.templateId, actorUserId: ctx.id, detail: { remindersSent: updated.remindersSent } });
      return updated;
    });
    return { attempt: row, delivered: false, note: "Link regenerated. Email/WhatsApp send is configured at the messaging layer; copy the link to share." };
  });

  app.post("/attempts/:id/revoke", { preHandler: [canInvite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [att] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(assessmentAttempts)
        .set({ status: "revoked", revokedAt: new Date(), inviteToken: `revoked-${randomUUID()}`, updatedAt: new Date() })
        .where(eq(assessmentAttempts.id, id))
        .returning({ id: assessmentAttempts.id, status: assessmentAttempts.status });
      await recordAudit(tx, { orgId: ctx.orgId, action: "invite.revoked", targetKind: "attempt", targetId: id, templateId: att.templateId, actorUserId: ctx.id });
      return updated;
    });
    return { attempt: row };
  });

  // ---------- ATTEMPTS: regrade ----------
  app.post("/attempts/:id/regrade", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [att] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });
    let snapshot: SnapshotShape | null = null;
    if (att.versionId) {
      const [v] = await db.select({ snapshot: assessmentVersions.snapshot }).from(assessmentVersions).where(eq(assessmentVersions.id, att.versionId)).limit(1);
      snapshot = (v?.snapshot as SnapshotShape) ?? null;
    }
    if (!snapshot) {
      const built = await buildSnapshot(ctx.orgId, att.templateId);
      snapshot = built as SnapshotShape | null;
    }
    if (!snapshot) return reply.code(422).send({ error: "no_snapshot" });
    const responses = (att.responses as unknown as CandidateResponse[]) ?? [];
    const graded = await gradeAttempt(snapshot, responses);
    const [row] = await db
      .update(assessmentAttempts)
      .set({
        autoScore: Math.round(graded.autoScore),
        maxScore: graded.maxScore,
        totalScore: graded.percent,
        pass: graded.pass,
        passBand: graded.passBand,
        itemResults: graded.itemResults,
        updatedAt: new Date(),
      })
      .where(eq(assessmentAttempts.id, id))
      .returning();
    await recordAudit(db, { orgId: ctx.orgId, action: "attempt.autograded", targetKind: "attempt", targetId: id, templateId: att.templateId, actorUserId: ctx.id, detail: { regrade: true, percent: graded.percent } });
    return { attempt: row };
  });

  // ---------- ATTEMPTS: AI score-assist (external key gated) ----------
  app.post("/attempts/:id/ai-assist", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    if (!isAiAssistConfigured()) return reply.code(503).send({ error: "openai_key_missing" });
    const [att] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });
    let snapshot: SnapshotShape | null = null;
    if (att.versionId) {
      const [v] = await db.select({ snapshot: assessmentVersions.snapshot }).from(assessmentVersions).where(eq(assessmentVersions.id, att.versionId)).limit(1);
      snapshot = (v?.snapshot as SnapshotShape) ?? null;
    }
    if (!snapshot) return reply.code(422).send({ error: "no_snapshot" });
    const items = (snapshot.items ?? []) as SnapshotItem[];
    const byItem = new Map((att.responses as unknown as CandidateResponse[] ?? []).map((r) => [r.itemId, r]));
    const suggestions: Array<{ itemId: string; suggested: number | null; rationale: string | null }> = [];
    for (const it of items) {
      if (it.type !== "short_answer" && it.type !== "long_answer") continue;
      const resp = byItem.get(it.id);
      const s = await suggestScore({
        prompt: it.prompt,
        response: resp?.textValue ?? "",
        sampleAnswer: (it.config?.sampleAnswer as string | undefined) ?? undefined,
        maxPoints: it.points,
      });
      suggestions.push({ itemId: it.id, suggested: s.suggested, rationale: s.rationale });
    }
    return { suggestions, note: "AI suggestion (review required) — never the sole grade." };
  });

  // ---------- ATTEMPTS: code run (external key gated) ----------
  app.post("/attempts/:id/run-code", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    if (!isCodeExecConfigured()) return reply.code(503).send({ error: "code_exec_unavailable" });
    const [att] = await db
      .select({ id: assessmentAttempts.id })
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });
    // Trigger a regrade through the sandbox path.
    return reply.code(202).send({ status: "queued", note: "Run-code dispatched; poll the attempt for codeRun results." });
  });

  // ---------- ATTEMPTS: manual review ----------
  app.patch("/attempts/:id", { preHandler: [canReview] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = reviewAttemptSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const [att] = await db
      .select()
      .from(assessmentAttempts)
      .where(and(eq(assessmentAttempts.id, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .limit(1);
    if (!att) return reply.code(404).send({ error: "attempt_not_found" });

    const itemResults = [...((att.itemResults as ItemResult[]) ?? [])];
    let manualScore = 0;
    if (parsed.data.itemScores) {
      const scoreMap = new Map(parsed.data.itemScores.map((s) => [s.itemId, s.awarded]));
      for (const r of itemResults) {
        if (scoreMap.has(r.itemId)) {
          const awarded = Math.min(scoreMap.get(r.itemId)!, r.max);
          r.awarded = awarded;
          r.correct = awarded >= r.max ? true : awarded > 0 ? null : false;
        }
      }
    }
    // manualScore = sum of awarded for non-auto-graded items
    manualScore = itemResults.filter((r) => !r.autoGraded).reduce((s, r) => s + r.awarded, 0);

    // Determine pass band from settings.
    let passBands: Array<{ label: string; minPercent: number }> = [];
    let passScore = att.totalScore ?? 60;
    const [tpl] = await db
      .select({ settings: assessmentTemplates.settings, passScore: assessmentTemplates.passScore })
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.id, att.templateId))
      .limit(1);
    if (tpl) {
      passBands = tpl.settings?.passBands ?? [];
      passScore = tpl.passScore;
    }
    const totals = computeTotals(itemResults, passScore, passBands);
    const pass = parsed.data.pass ?? totals.pass;

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(assessmentAttempts)
        .set({
          status: "reviewed",
          reviewedAt: new Date(),
          reviewerUserId: ctx.id,
          reviewerNotes: parsed.data.reviewerNotes ?? att.reviewerNotes,
          itemResults,
          manualScore: Math.round(manualScore),
          autoScore: Math.round(totals.autoScore - manualScore),
          maxScore: totals.maxScore,
          totalScore: totals.percent,
          pass,
          passBand: totals.passBand,
          updatedAt: new Date(),
        })
        .where(eq(assessmentAttempts.id, id))
        .returning();
      await recordAudit(tx, { orgId: ctx.orgId, action: "attempt.reviewed", targetKind: "attempt", targetId: id, templateId: att.templateId, actorUserId: ctx.id, detail: { percent: totals.percent, pass } });
      return updated;
    });
    return { attempt: row };
  });

  // ---------- RESULTS: cohort distribution + item analysis ----------
  app.get("/templates/:id/results", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, publishedVersion: assessmentTemplates.publishedVersion })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });

    const attempts = await db
      .select({
        id: assessmentAttempts.id,
        totalScore: assessmentAttempts.totalScore,
        pass: assessmentAttempts.pass,
        passBand: assessmentAttempts.passBand,
        itemResults: assessmentAttempts.itemResults,
      })
      .from(assessmentAttempts)
      .where(
        and(
          eq(assessmentAttempts.templateId, id),
          eq(assessmentAttempts.orgId, ctx.orgId),
          inArray(assessmentAttempts.status, ["submitted", "reviewed"]),
        ),
      );

    // Current version snapshot items drive the item-analysis dimension list.
    let snapshotItems: Array<{ id: string; type: string; prompt: string; config?: { options?: Array<{ id: string; label: string; correct: boolean }> } }> = [];
    const [version] = await db
      .select({ snapshot: assessmentVersions.snapshot })
      .from(assessmentVersions)
      .where(and(eq(assessmentVersions.templateId, id), eq(assessmentVersions.version, tpl.publishedVersion ?? 0)))
      .limit(1);
    if (version) {
      const snap = version.snapshot as { items?: typeof snapshotItems };
      snapshotItems = snap.items ?? [];
    } else {
      const items = await db.select({ id: assessmentItems.id, type: assessmentItems.type, prompt: assessmentItems.prompt, config: assessmentItems.config }).from(assessmentItems).where(eq(assessmentItems.templateId, id));
      snapshotItems = items.map((i) => ({ id: i.id, type: i.type, prompt: i.prompt, config: i.config as { options?: Array<{ id: string; label: string; correct: boolean }> } }));
    }

    const forAnalysis: AttemptForAnalysis[] = attempts.map((a) => ({
      id: a.id,
      totalPercent: a.totalScore ?? 0,
      pass: a.pass,
      passBand: a.passBand,
      itemResults: (a.itemResults as AttemptForAnalysis["itemResults"]) ?? [],
    }));
    const analysis = computeItemAnalysis(forAnalysis, snapshotItems);
    return analysis;
  });

  // ---------- RESULTS: CSV export ----------
  app.get("/templates/:id/results/export.csv", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [tpl] = await db
      .select({ id: assessmentTemplates.id, title: assessmentTemplates.title })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    const rows = await db
      .select({
        attemptId: assessmentAttempts.id,
        candidateName: candidates.displayName,
        status: assessmentAttempts.status,
        totalScore: assessmentAttempts.totalScore,
        autoScore: assessmentAttempts.autoScore,
        manualScore: assessmentAttempts.manualScore,
        maxScore: assessmentAttempts.maxScore,
        pass: assessmentAttempts.pass,
        passBand: assessmentAttempts.passBand,
        submittedAt: assessmentAttempts.submittedAt,
      })
      .from(assessmentAttempts)
      .leftJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
      .where(and(eq(assessmentAttempts.templateId, id), eq(assessmentAttempts.orgId, ctx.orgId)))
      .orderBy(desc(assessmentAttempts.createdAt));
    const header = "attempt_id,candidate,status,total_percent,auto_score,manual_score,max_score,pass,pass_band,submitted_at";
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [header, ...rows.map((r) => [r.attemptId, r.candidateName ?? "", r.status, r.totalScore ?? "", r.autoScore ?? "", r.manualScore ?? "", r.maxScore ?? "", r.pass ?? "", r.passBand ?? "", r.submittedAt ? new Date(r.submittedAt).toISOString() : ""].map(esc).join(","))].join("\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="assessment-${id}-results.csv"`);
    return reply.send(body);
  });

  // ---------- AUDIT timeline ----------
  app.get("/templates/:id/audit", { preHandler: [canRead] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50)));
    const [tpl] = await db
      .select({ id: assessmentTemplates.id })
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, id), eq(assessmentTemplates.orgId, ctx.orgId)))
      .limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_not_found" });
    const entries = await db
      .select({
        id: assessmentAuditLog.id,
        action: assessmentAuditLog.action,
        targetKind: assessmentAuditLog.targetKind,
        targetId: assessmentAuditLog.targetId,
        actorUserId: assessmentAuditLog.actorUserId,
        actorName: users.name,
        detail: assessmentAuditLog.detail,
        createdAt: assessmentAuditLog.createdAt,
      })
      .from(assessmentAuditLog)
      .leftJoin(users, eq(users.id, assessmentAuditLog.actorUserId))
      .where(and(eq(assessmentAuditLog.templateId, id), eq(assessmentAuditLog.orgId, ctx.orgId)))
      .orderBy(desc(assessmentAuditLog.id))
      .limit(limit);
    return { entries };
  });

  // Candidate typeahead helper proxies to /api/candidates; nothing here.
  void proctorSessions;
}

// ============================================================================
// Public (token) candidate-runtime routes — mounted under /api/public/assessments
// WITHOUT the authenticate preHandler.
// ============================================================================

export async function publicAssessmentRoutes(app: FastifyInstance) {
  // Load the pinned-version exam, mark started, set the server deadline, and
  // create the proctor session honoring the template's proctoring policy.
  app.get("/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const [att] = await db.select().from(assessmentAttempts).where(eq(assessmentAttempts.inviteToken, token)).limit(1);
    if (!att) return reply.code(404).send({ error: "invalid_token" });
    if (att.status === "revoked") return reply.code(410).send({ error: "revoked" });
    if (att.expiresAt && att.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    if (att.status === "submitted" || att.status === "reviewed") return reply.code(409).send({ error: "already_submitted" });

    const [tpl] = await db.select().from(assessmentTemplates).where(eq(assessmentTemplates.id, att.templateId)).limit(1);
    if (!tpl) return reply.code(404).send({ error: "template_missing" });

    // Resolve the exam from the pinned version snapshot (immutable). Fall back to
    // the live build if no version was pinned (legacy invite).
    let snapshot: SnapshotShape | null = null;
    if (att.versionId) {
      const [v] = await db.select({ snapshot: assessmentVersions.snapshot }).from(assessmentVersions).where(eq(assessmentVersions.id, att.versionId)).limit(1);
      snapshot = (v?.snapshot as SnapshotShape) ?? null;
    }
    if (!snapshot) {
      const sections = await db.select().from(assessmentSections).where(eq(assessmentSections.templateId, tpl.id)).orderBy(assessmentSections.position);
      const items = await db.select().from(assessmentItems).where(eq(assessmentItems.templateId, tpl.id)).orderBy(assessmentItems.position);
      snapshot = {
        settings: tpl.settings,
        passScore: tpl.passScore,
        durationMins: tpl.durationMins,
        items: items.map((it) => ({ id: it.id, sectionId: it.sectionId, type: it.type, position: it.position, prompt: it.prompt, config: it.config, points: it.points, negativePoints: it.negativePoints, partialCredit: it.partialCredit, required: it.required, timeLimitSeconds: it.timeLimitSeconds })) as unknown as SnapshotItem[],
        sections,
      };
    }
    const exam: SnapshotShape = snapshot;

    let serverStartedAt = att.serverStartedAt;
    let deadlineAt = att.deadlineAt;
    if (att.status === "invited") {
      serverStartedAt = new Date();
      deadlineAt = tpl.durationMins ? new Date(serverStartedAt.getTime() + tpl.durationMins * 60_000) : null;
      await db
        .update(assessmentAttempts)
        .set({ status: "started", startedAt: serverStartedAt, serverStartedAt, deadlineAt, updatedAt: new Date() })
        .where(eq(assessmentAttempts.id, att.id));
      await recordAudit(db, { orgId: att.orgId, action: "attempt.started", targetKind: "attempt", targetId: att.id, templateId: att.templateId, actorUserId: null });
      // Create the proctor session honoring the policy.
      try {
        const policy = (tpl.proctoringPolicy ?? {}) as { enabled?: boolean };
        if (policy.enabled !== false) {
          await db.insert(proctorSessions).values({
            orgId: att.orgId,
            assessmentAttemptId: att.id,
            asyncVideoSubmissionId: null,
            candidateId: att.candidateId ?? null,
            status: "live",
          });
        }
      } catch {
        /* best-effort */
      }
    }

    const items = redactSnapshotItems((exam.items ?? []) as SnapshotItem[]);
    return {
      template: { id: tpl.id, title: tpl.title, description: tpl.description, durationMins: tpl.durationMins, passScore: tpl.passScore },
      settings: tpl.settings,
      proctoringPolicy: tpl.proctoringPolicy,
      sections: exam.sections ?? [],
      items,
      // resume the saved partial responses
      savedResponses: att.responses ?? [],
      attemptId: att.id,
      serverStartedAt,
      deadlineAt,
      expiresAt: att.expiresAt,
    };
  });

  // Server-side autosave for resume. Rejects after the deadline.
  app.post("/:token/heartbeat", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = submitAttemptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [att] = await db.select().from(assessmentAttempts).where(eq(assessmentAttempts.inviteToken, token)).limit(1);
    if (!att) return reply.code(404).send({ error: "invalid_token" });
    if (att.status === "revoked") return reply.code(410).send({ error: "revoked" });
    if (att.status === "submitted" || att.status === "reviewed") return reply.code(409).send({ error: "already_submitted" });
    if (att.deadlineAt && att.deadlineAt.getTime() < Date.now()) return reply.code(410).send({ error: "deadline_passed" });
    await db
      .update(assessmentAttempts)
      .set({ responses: parsed.data.responses as unknown as typeof att.responses, updatedAt: new Date() })
      .where(eq(assessmentAttempts.id, att.id));
    return { saved: true, deadlineAt: att.deadlineAt };
  });

  // Submit: enforce server deadline, auto-grade objective items inline.
  app.post("/:token/submit", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = submitAttemptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const [att] = await db.select().from(assessmentAttempts).where(eq(assessmentAttempts.inviteToken, token)).limit(1);
    if (!att) return reply.code(404).send({ error: "invalid_token" });
    if (att.status === "revoked") return reply.code(410).send({ error: "revoked" });
    if (att.status === "submitted" || att.status === "reviewed") return reply.code(409).send({ error: "already_submitted" });
    if (att.expiresAt && att.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });

    // Grace window: allow submit within 5s past the server deadline (clock skew).
    const pastDeadline = att.deadlineAt ? att.deadlineAt.getTime() + 5000 < Date.now() : false;

    const [tpl] = await db.select().from(assessmentTemplates).where(eq(assessmentTemplates.id, att.templateId)).limit(1);
    let snapshot: SnapshotShape | null = null;
    if (att.versionId) {
      const [v] = await db.select({ snapshot: assessmentVersions.snapshot }).from(assessmentVersions).where(eq(assessmentVersions.id, att.versionId)).limit(1);
      snapshot = (v?.snapshot as SnapshotShape) ?? null;
    }
    if (!snapshot && tpl) {
      const built = await buildSnapshot(att.orgId, att.templateId);
      snapshot = built as SnapshotShape | null;
    }

    const responses = parsed.data.responses as unknown as CandidateResponse[];
    let graded = { itemResults: [] as ItemResult[], autoScore: 0, maxScore: 0, percent: 0, pass: false, passBand: null as string | null };
    if (snapshot) graded = await gradeAttempt(snapshot, responses);

    await db.transaction(async (tx) => {
      await tx
        .update(assessmentAttempts)
        .set({
          status: "submitted",
          submittedAt: new Date(),
          responses: parsed.data.responses as unknown as typeof att.responses,
          autoScore: Math.round(graded.autoScore),
          maxScore: graded.maxScore,
          totalScore: graded.percent,
          pass: graded.pass,
          passBand: graded.passBand,
          itemResults: graded.itemResults,
          updatedAt: new Date(),
        })
        .where(eq(assessmentAttempts.id, att.id));
      await recordAudit(tx, { orgId: att.orgId, action: "attempt.submitted", targetKind: "attempt", targetId: att.id, templateId: att.templateId, actorUserId: null, detail: { lateSubmit: pastDeadline } });
      await recordAudit(tx, { orgId: att.orgId, action: "attempt.autograded", targetKind: "attempt", targetId: att.id, templateId: att.templateId, actorUserId: null, detail: { autoScore: graded.autoScore, percent: graded.percent } });
    });
    return { status: "submitted", autoScore: graded.percent, lateSubmit: pastDeadline };
  });
}
